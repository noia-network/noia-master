import * as FSChunkStore from "fs-chunk-store";
import * as WebSocket from "ws";
import * as geoip from "geoip-lite";
import * as geolib from "geolib";
import * as http from "http";
import * as sha1 from "sha1";
import * as getDomain from "getdomain";
import {
    Seeding,
    Uploaded,
    Requested,
    MasterMetadata,
    MasterBlockchainMetadata,
    NodeMetadata,
    NodeBlockchainMetadata,
    ProtocolEvent,
    StorageData,
    BandwidthData,
    ClientRequest,
    Peer
} from "@noia-network/protocol";

import { Helpers } from "./helpers";
import { Node, NodeStatus, ExtendedWire, ExtendedWireTypes, LocationData, Candidate, ClientConnectionsTypes } from "./contracts";
import { api, ApiEventType } from "./api";
import { blockchain } from "./blockchain";
import { cache, ScoreWeights, MetricName } from "./cache";
import { cloudflare } from "./cloudflare";
import { config, ConfigOption } from "./config";
import { contentManager, ContentManager, ContentData } from "./content-manager";
import { dataCluster } from "./data-cluster";
import { db } from "./db";
import { encryption } from "./encryption";
import { internalNodesMetadata } from "./internal-nodes-metadata";
import { logger } from "./logger";
import { scheduler } from "./scheduler";

export interface NodeContentData {
    contentId: string;
    nodeId: string;
    status: "done" | "caching";
}

interface File {
    offset: number;
    path: string;
    length: number;
    open: (cb: (err: Error, file: unknown) => void) => void;
}

export interface Store {
    close: (cb: (err: Error) => void) => void;
    get: (piece: number, cb: (err: Error, dataBuffer: Buffer) => void) => void;
    chunkLength: number;
    files: File[];
    length: number;
    closed: boolean;
    lastChunkIndex: number;
    lastChunkLength: number;
}

export class Nodes {
    constructor() {
        this.stores = {};
        this._wires = {};
        this.contentManager = contentManager;
    }

    public maintenanceMode: boolean = false;
    public stores: { [key: string]: Store };
    public _wires: {
        [key: string]: ExtendedWireTypes;
    };
    public contentManager: ContentManager;

    public async connect(ws: WebSocket, req: http.IncomingMessage): Promise<void> {
        if (config.get(ConfigOption.BlockchainIsEnabled)) {
            try {
                this.wireSetup(ws, req);
            } catch (err) {
                logger.error("Error:", err);
            }
        } else {
            this.wireSetup(ws, req);
        }
    }

    private async wireSetup(ws: WebSocket, req: http.IncomingMessage): Promise<void> {
        const ip = Helpers.getIp(req);
        if (ip == null) {
            logger.error("Could not determine remote address!");
            return;
        }
        const nodeExternalIp: string = ip === "127.0.0.1" ? config.get(ConfigOption.MasterIp) : ip;
        const masterMetadata: MasterMetadata = {
            externalIp: nodeExternalIp
        };

        let wire: ExtendedWireTypes;
        if (!config.get(ConfigOption.BlockchainIsEnabled)) {
            // Not using blockchain.
            wire = new ExtendedWire<MasterMetadata, NodeMetadata>(ws, masterMetadata, async remoteMetadata => {
                wire.isInternalNode = internalNodesMetadata.get(nodeExternalIp) != null;
                if (typeof remoteMetadata.nodeId !== "string" || remoteMetadata.nodeId.length < 1) {
                    logger.warn("Invalid node id.");
                    return false;
                }
                this._wires[remoteMetadata.nodeId] = wire;
                return true;
            });
        } else {
            // Using blockchain.
            const msg = Helpers.randomString(16);
            const signedMsg = await blockchain.signMessage(msg);
            const blockchainMasterMetadata: MasterBlockchainMetadata = Object.assign(masterMetadata, {
                msg: msg,
                msgSigned: signedMsg
            });
            wire = new ExtendedWire<MasterBlockchainMetadata, NodeBlockchainMetadata>(
                ws,
                blockchainMasterMetadata,
                async remoteMetadata => {
                    wire.isInternalNode = internalNodesMetadata.get(nodeExternalIp) != null;
                    if (typeof remoteMetadata.nodeId !== "string" || remoteMetadata.nodeId.length < 1) {
                        logger.warn("Invalid node id.");
                        return false;
                    }
                    this._wires[remoteMetadata.nodeId] = wire;
                    try {
                        const isCheckPassed =
                            remoteMetadata.walletAddress ===
                            blockchain.recoverAddressFromSignedMessage(remoteMetadata.msg, remoteMetadata.msgSigned);
                        if (!isCheckPassed) {
                            logger.error(`Node node-id=${remoteMetadata.nodeId} signature failed to pass.`);
                        }
                        return isCheckPassed;
                    } catch (err) {
                        logger.error(err);
                        return false;
                    }
                }
            );
        }

        try {
            await wire.handshake();
        } catch (err) {
            logger.error("Error has occured while performing handshake:", err);
            return;
        }

        logger.info(
            `Node node-id=${wire.getRemoteMetadata().nodeId} connected: node-ip=${wire.getLocalMetadata().externalIp} is-internal=${
                wire.isInternalNode
            }.`
        );

        // --------------------------------------------------------------------------------------
        if (this.maintenanceMode) {
            const msg = `Master is in maintenance mode - please wait...`;
            wire.close(1002, msg);
            logger.warn(msg);
            return;
        }

        if (wire.getRemoteMetadata().airdropAddress != null) {
            const nodeWithAirdropAddress = db
                .nodes()
                .findOne({ airdropAddress: wire.getRemoteMetadata().airdropAddress, status: NodeStatus.online });
            if (nodeWithAirdropAddress != null) {
                const msg = `Node failed to connect, since node with same airdrop-address=${
                    wire.getRemoteMetadata().airdropAddress
                } is already connected.`;
                wire.close(1002, msg);
                logger.warn(msg);
                return;
            }
        }

        if (db.nodes().findOne({ nodeId: wire.getRemoteMetadata().nodeId, status: NodeStatus.online }) != null) {
            const msg = `Node failed to connect, since node with same node-id=${wire.getRemoteMetadata().nodeId} is already connected.`;
            wire.close(1002, msg);
            logger.warn(msg);
            return;
        }

        if (!wire.getRemoteMetadata().version.startsWith(config.get(ConfigOption.NodeVersion))) {
            const msg = "Noia node failed to connect, since running and expected NOIA Node versions do not match, please update NOIA node.";
            wire.warning(msg);
            wire.close(1002, msg);
            logger.warn(msg);
            return;
        }

        if (config.get(ConfigOption.MasterIsPrivate) && !wire.isInternalNode) {
            const msg = "Noia node failed to connect, since master is private.";
            wire.close(1002, msg);
            logger.warn(msg);
            return;
        }

        async function checkLifetime(): Promise<void> {
            if (config.get(ConfigOption.DataClusterCheckNodeOnline)) {
                const isNodeAliveInCluster: boolean = await dataCluster.isAlive({
                    minutesOffline: 15,
                    timestamp: Date.now(),
                    nodeId: Helpers.getNodeUid(wire.getRemoteMetadata())
                });
                if (isNodeAliveInCluster) {
                    const msg = `Node failed to connect, since node with same node-id=${
                        wire.getRemoteMetadata().nodeId
                    } is already connected to cluster.`;
                    wire.close(1002, msg);
                    logger.warn(msg);
                    return;
                }
            }
            dataCluster.registerLifetime(Helpers.getNodeUid(wire.getRemoteMetadata()), (onDisconnect, uptime) => {
                wire.on("closed", onDisconnect);
                wire.on("error", onDisconnect);
                wire.uptime = uptime;
            });
        }
        checkLifetime();

        const node = this.onConnect(wire);

        if (node == null) {
            logger.error("Node object is invalid.");
            return;
        }

        if (config.get(ConfigOption.BlockchainIsEnabled)) {
            const blockchainMetadata = wire.getRemoteMetadata() as NodeBlockchainMetadata;
            try {
                // Check if job post belongs to this master.
                const jobPost = await blockchain.getJobPost(blockchainMetadata.jobPostAddress);
                const employerAddress = await jobPost.getEmployerAddress();
                const business = await blockchain.getBusinessClientAt(employerAddress);
                const businessClientAddress = await business.getOwnerAddress();
                const masterBusinessClientAddres = blockchain.getWalletAddress();
                if (businessClientAddress !== masterBusinessClientAddres) {
                    logger.error(
                        `Node node-if=${node.nodeId} job post belongs to other master: business-client-address=${businessClientAddress}` +
                            ` and master-business-client=${masterBusinessClientAddres} don't match.`
                    );
                    // TODO: Give instructiond to node what went wrong (and possibility to recover).
                    wire.close(1002, "Sent job post belongs to other master.");
                    return;
                }

                let doCreateWorkOrder = true;
                let proceedWithSendWorkOrder = true;
                const workOrderAddress = blockchainMetadata.workOrderAddress;
                logger.info(`Parameter last-work-order=${node.lastWorkOrder}.`);

                // Check if work order owner has changed.
                if (node.lastWorkOrder != null) {
                    const existingLastWorkOrder = await blockchain.getWorkOrderAt(blockchainMetadata.jobPostAddress, node.lastWorkOrder);
                    const lastWorkOrderOwner = await existingLastWorkOrder.getWorkerOwner();
                    const currentWorkOrderOwner = (wire.getRemoteMetadata() as NodeBlockchainMetadata).walletAddress;
                    if (lastWorkOrderOwner !== currentWorkOrderOwner) {
                        logger.info(
                            `Work order owner changed from=${lastWorkOrderOwner} to=${currentWorkOrderOwner}. Discarding saved work order.`
                        );
                        node.lastWorkOrder = null;
                    }
                }

                // Check if node is already working on particular work order (if master has some record).
                if (node.lastWorkOrder != null) {
                    logger.info(`Parameter last-work-order=${node.lastWorkOrder} and received work-order=${workOrderAddress}.`);
                    if (node.lastWorkOrder !== workOrderAddress) {
                        // TODO: Check if job post is for this work order.
                        const existingLastWorkOrder = await blockchain.getWorkOrderAt(
                            blockchainMetadata.jobPostAddress,
                            node.lastWorkOrder
                        );
                        const lastWorkOrderHasLockedTokens = await existingLastWorkOrder.hasTimelockedTokens();
                        logger.info(`Parameter last-work-order=${node.lastWorkOrder}, has-locked-tokens=${lastWorkOrderHasLockedTokens}`);
                        if (lastWorkOrderHasLockedTokens) {
                            wire.workOrder(existingLastWorkOrder.address);
                            doCreateWorkOrder = false;
                            proceedWithSendWorkOrder = false;
                        }
                    }
                }

                // Check if node is already working on particular work order (if master doesn't have record).
                if (workOrderAddress != null && proceedWithSendWorkOrder) {
                    const existingWorkOrder = await blockchain.getWorkOrderAt(blockchainMetadata.jobPostAddress, workOrderAddress);
                    const hasLockedTokens = await existingWorkOrder.hasTimelockedTokens();
                    if (hasLockedTokens) {
                        logger.blockchain(
                            `Node node-id=${wire.getRemoteMetadata().nodeId} received work order: work-order-address=${
                                existingWorkOrder.address
                            }.`
                        );
                        node.lastWorkOrder = existingWorkOrder.address;
                        wire.workOrder(existingWorkOrder.address);
                        doCreateWorkOrder = false;
                    }
                }
                if (doCreateWorkOrder) {
                    const newWorkOrder = await blockchain.createWorkOrder(
                        blockchainMetadata.jobPostAddress,
                        blockchainMetadata.walletAddress
                    );
                    await blockchain.lockTokens(
                        newWorkOrder,
                        parseInt(config.get(ConfigOption.BlockchainRewardAmount)),
                        config.get(ConfigOption.BlockchainRewardInterval)
                    );
                    logger.blockchain(
                        `Node node-id=${wire.getRemoteMetadata().nodeId} received (created) work order: work-order-address=${
                            newWorkOrder.address
                        }.`
                    );
                    node.lastWorkOrder = newWorkOrder.address;
                    wire.workOrder(newWorkOrder.address);
                }
                db.nodes().update(node);
            } catch (err) {
                logger.error("Failed to createWorkOrder", err);
            }
        }

        // TODO: Extract to separate method.
        async function sendStatistics(): Promise<void> {
            if (wire.uptime != null) {
                try {
                    const downloaded = await dataCluster.downloadTotal({
                        nodeId: Helpers.getNodeUid(wire.getRemoteMetadata()),
                        timestamp: new Date().getTime()
                    });
                    const uploaded = await dataCluster.uploadTotal({
                        nodeId: Helpers.getNodeUid(wire.getRemoteMetadata()),
                        timestamp: new Date().getTime()
                    });
                    const uptime = await wire.uptime({
                        nodeId: Helpers.getNodeUid(wire.getRemoteMetadata()),
                        timestamp: new Date().getTime(),
                        from: 0,
                        to: new Date().getTime()
                    });
                    const statsNode = db.nodes().findOne({ nodeId: wire.getRemoteMetadata().nodeId });
                    if (statsNode != null) {
                        statsNode.uptime = uptime.total;
                        statsNode.uploaded = uploaded.bytesCount;
                        statsNode.downloaded = downloaded.bytesCount;
                        db.nodes().update(statsNode);
                    }
                    wire.statistics({
                        time: {
                            total: uptime.total,
                            seconds: uptime.seconds,
                            minutes: uptime.minutes,
                            hours: uptime.hours
                        },
                        downloaded: downloaded.bytesCount,
                        uploaded: uploaded.bytesCount
                    });
                } catch (err) {
                    logger.warn(`Failed to send statistics to node node-id=${Helpers.getNodeUid(wire.getRemoteMetadata())}, error:`, err);
                }
            }
        }
        sendStatistics();
        const FIVE_TO_FIFTEEN_MINUTES = (Math.floor(Math.random() * 5) + 10) * 60 * 1000;
        let intervalId: NodeJS.Timer | null = setInterval(async () => {
            sendStatistics();
        }, FIVE_TO_FIFTEEN_MINUTES);
        wire.on("closed", () => {
            if (intervalId != null) {
                clearInterval(intervalId);
                intervalId = null;
            }
        });
        wire.on("error", () => {
            if (intervalId != null) {
                clearInterval(intervalId);
                intervalId = null;
            }
        });

        wire.on("downloaded", info => {
            logger.verbose(`Node node-id=${Helpers.getNodeUid(wire.getRemoteMetadata())} downloaded bytes-count=${info.data.downloaded}.`);
            dataCluster.download({
                bytesCount: info.data.downloaded,
                contentId: info.data.infoHash,
                ip: info.data.ip,
                nodeId: Helpers.getNodeUid(wire.getRemoteMetadata()),
                timestamp: info.timestamp
            });
        });
        wire.on("uploaded", info => {
            logger.verbose(`Node node-id=${Helpers.getNodeUid(wire.getRemoteMetadata())} uploaded bytes-count=${info.data.uploaded}.`);

            const getDomainOrigin = (contentId: string): string => {
                const file = db.files().findOne({ contentId });
                if (file == null) {
                    // There could be case that internal data was cleared...
                    return "";
                }
                return getDomain.origin(file.contentSrc);
            };

            dataCluster.upload({
                bytesCount: info.data.uploaded,
                contentId: info.data.infoHash,
                contentDomain: getDomainOrigin(info.data.infoHash),
                ip: info.data.ip,
                nodeId: Helpers.getNodeUid(wire.getRemoteMetadata()),
                timestamp: info.timestamp
            });
        });
        wire.on("seeding", info => {
            this.onSeeding(wire, info);
        });
        wire.on("uploaded", info => {
            this.onUploaded(wire, info);
        });
        wire.on("requested", info => {
            this.onRequested(wire, info);
        });
        wire.on("bandwidthData", info => {
            this.onBandwidthData(wire, info);
        });
        wire.on("storageData", info => {
            this.onStorageData(wire, info);
        });
        wire.on("signedRequest", async info => {
            logger.blockchain(`Node node-id=${wire.getRemoteMetadata().nodeId} send signed request: type=${info.data.type}.`);
            const nodeMetadata = wire.getRemoteMetadata() as NodeBlockchainMetadata;
            if (nodeMetadata == null) {
                logger.error("Node remote metadata is invalid.");
                return;
            }
            if (info.data.type === "accept") {
                try {
                    const signedRequest = info.data.signedRequest;
                    if (signedRequest == null) {
                        logger.error(`Node node-id=${wire.getRemoteMetadata().nodeId} sent signed request is invalid.`);
                        return;
                    }
                    const workOrder = await blockchain.getWorkOrderAt(nodeMetadata.jobPostAddress, info.data.workOrderAddress);
                    await workOrder.delegatedAccept(signedRequest.nonce, signedRequest.sig);
                    await workOrder.accept();
                    wire.signedRequest({
                        type: "accepted",
                        workOrderAddress: info.data.workOrderAddress
                    });
                } catch (err) {
                    logger.error(`Error has occured while handling node node-id=${wire.getRemoteMetadata().nodeId} signed request:`, err);
                }
            } else if (info.data.type === "release") {
                try {
                    const signedRequest = info.data.signedRequest;
                    const workOrder = await blockchain.getWorkOrderAt(nodeMetadata.jobPostAddress, info.data.workOrderAddress);

                    const workerOwner = await workOrder.getWorkerOwner();
                    if (workerOwner !== (wire.getRemoteMetadata() as NodeBlockchainMetadata).walletAddress) {
                        const msg = `Worker-owner=${workerOwner} and node node-id=${wire.getRemoteMetadata().nodeId} wallet-addresss=${
                            (wire.getRemoteMetadata() as NodeBlockchainMetadata).walletAddress
                        } do not match.`;
                        wire.signedRequest({
                            error: msg,
                            type: "released",
                            workOrderAddress: "-"
                        });
                        logger.warn(`Node node-id=${wire.getRemoteMetadata().nodeId} received error message='${msg}'.`);
                        return;
                    }

                    const beneficiary = info.data.beneficiary;
                    if (signedRequest == null || beneficiary == null) {
                        logger.error(`Node node-id=${wire.getRemoteMetadata().nodeId} sent signed request or beneficiary is invalid.`);
                        return;
                    }
                    await workOrder.delegatedRelease(beneficiary, signedRequest.nonce, signedRequest.sig);
                    if (info.data.extendWorkOrder) {
                        await blockchain.lockTokens(
                            workOrder,
                            parseInt(config.get(ConfigOption.BlockchainRewardAmount)),
                            config.get(ConfigOption.BlockchainRewardInterval)
                        );
                    }

                    // Sanity check.
                    if (wire.uptime != null) {
                        await wire.uptime({
                            nodeId: Helpers.getNodeUid(wire.getRemoteMetadata()),
                            timestamp: new Date().getTime(),
                            from: new Date().setMinutes(new Date().getMinutes() - 1),
                            to: new Date().getTime()
                        });
                    }

                    wire.signedRequest({
                        type: "released",
                        workOrderAddress: info.data.workOrderAddress
                    });
                } catch (err) {
                    wire.signedRequest({
                        error: err.message,
                        type: "released",
                        workOrderAddress: "-"
                    });
                    logger.error(`Error has occured while handling node node-id=${wire.getRemoteMetadata().nodeId} signed release:`, err);
                }
            }
        });

        wire.once("closed", () => this.onDisconnect(wire));
        wire.once("error", (err: Error) => this.onDisconnect(wire, err));
    }

    private onConnect(wire: ExtendedWireTypes): Node | undefined {
        if (!wire.getRemoteMetadata().nodeId) {
            logger.error(wire.getRemoteMetadata().nodeId + " : connect : error : wire.getRemoteMetadata().nodeId");
            return undefined;
        }

        if (wire.getRemoteMetadata().interface == null) {
            logger.error(wire.getRemoteMetadata().nodeId + " : connect : error : wire.nodeClient.info.interface");
            return undefined;
        }

        let node: Node | null = db.nodes().findOne({ nodeId: wire.getRemoteMetadata().nodeId });
        const internalNodeMetadata = internalNodesMetadata.get(wire.getLocalMetadata().externalIp);
        const geo = geoip.lookup(wire.getLocalMetadata().externalIp);
        let isExistingNode = true;
        if (node == null) {
            isExistingNode = false;
            node = {
                connectedAt: Helpers.datetime.time(),
                ip: wire.getLocalMetadata().externalIp,
                nodeId: wire.getRemoteMetadata().nodeId,
                uptime: 0,
                storage: {
                    available: 0,
                    used: 0,
                    total: 0
                },
                connections: {
                    webrtc: {
                        checkStatus: "not-checked",
                        port: null
                    },
                    ws: {
                        checkStatus: "not-checked",
                        port: null
                    },
                    wss: {
                        checkStatus: "not-checked",
                        port: null
                    }
                },
                location: {
                    latitude:
                        internalNodeMetadata != null
                            ? internalNodeMetadata.latitude
                            : geo != null && geo.ll != null && geo.ll[0] != null
                            ? geo.ll[0]
                            : 0.0,
                    longitude:
                        internalNodeMetadata != null
                            ? internalNodeMetadata.longitude
                            : geo != null && geo.ll != null && geo.ll[1] != null
                            ? geo.ll[1]
                            : 0.0,
                    countryCode:
                        internalNodeMetadata != null
                            ? internalNodeMetadata.countryCode
                            : geo != null && geo.country != null
                            ? geo.country
                            : "",
                    city: internalNodeMetadata != null ? internalNodeMetadata.city : geo != null && geo.country != null ? geo.city : ""
                },
                airdropAddress: null,
                lastWorkOrder: null,
                loadDownload: 0,
                loadUpload: 0,
                healthScore: 0
            };
        }

        node.interface = wire.getRemoteMetadata().interface;
        node.airdropAddress = wire.getRemoteMetadata().airdropAddress;
        node.status = NodeStatus.online;
        node.isInternalNode = wire.isInternalNode;

        if (wire.isInternalNode) {
            node.domain = cloudflare.createSubdomain(wire.getLocalMetadata().externalIp);
        } else {
            node.domain = wire.getRemoteMetadata().domain;
        }

        if (node.ip !== wire.getLocalMetadata().externalIp) {
            node.ip = wire.getLocalMetadata().externalIp;
        }

        node.connections.webrtc.checkStatus = "not-checked";
        node.connections.webrtc.port = wire.getRemoteMetadata().connections.webrtc;
        node.connections.ws.checkStatus = "not-checked";
        node.connections.ws.port = wire.getRemoteMetadata().connections.ws;
        node.connections.wss.checkStatus = "not-checked";
        node.connections.wss.port = wire.getRemoteMetadata().connections.wss;

        api.register(ApiEventType.Connection, {
            from: {
                countryCode: node.location.countryCode
            },
            to: {
                countryCode: config.get(ConfigOption.MasterLocationCountryCode)
            }
        });

        if (isExistingNode) {
            node.connectedAt = Helpers.datetime.time();
            db.nodes().update(node);
        } else {
            node.uploaded = 0;
            node.tokens = 0;
            node.storage = {
                used: 0,
                available: 0,
                total: 0
            };
            node.latency = 0;
            node.bandwidthUpload = 0;
            node.bandwidthDownload = 0;

            db.nodes().insert(node);
        }

        const connections = wire.getRemoteMetadata().connections;
        setTimeout(() => {
            if (connections != null && connections.webrtc != null) {
                this.checkWebrtc(wire, wire.getLocalMetadata().externalIp, connections.webrtc);
            }
            if (connections != null && connections.ws != null) {
                this.checkWs(wire, wire.getLocalMetadata().externalIp, connections.ws);
            }
            if (connections != null && connections.wss != null && node != null) {
                this.checkWss(wire, node.domain, connections.wss);
            }
        }, 5000);

        return node;
    }

    private onStorageData(wire: ExtendedWireTypes, storageDataEvent: ProtocolEvent<StorageData>): void {
        if (!wire.getRemoteMetadata().nodeId) {
            logger.error(`Node node-id=${wire.getRemoteMetadata().nodeId} is invalid.`);
            return;
        }

        const node = db.nodes().findOne({ nodeId: wire.getRemoteMetadata().nodeId });
        if (!node) {
            logger.error(`Node node-id=${wire.getRemoteMetadata().nodeId} is not found in database.`);
            return;
        }

        if (storageDataEvent.data == null) {
            logger.error(wire.getRemoteMetadata().nodeId + " : metadata : no storage metadata");
            return;
        }
        if (storageDataEvent.data.total == null || storageDataEvent.data.used == null || storageDataEvent.data.available == null) {
            logger.error(`Node node-id=${wire.getRemoteMetadata().nodeId} storage data is invalid.`);
            return;
        }

        node.storage = {
            total: parseInt(storageDataEvent.data.total.toString()) ? parseInt(storageDataEvent.data.total.toString()) : -1,
            used: parseInt(storageDataEvent.data.used.toString()) ? parseInt(storageDataEvent.data.used.toString()) : -1,
            available: parseInt(storageDataEvent.data.available.toString()) ? parseInt(storageDataEvent.data.available.toString()) : -1
        };

        const healthScoreData: Partial<ScoreWeights> = {};
        if (node.nodeId && node.storage.total !== -1) {
            healthScoreData.storage = cache.normalizeMetric(MetricName.Storage, node.storage.total, true);
        }

        healthScoreData.uptime = cache.normalizeMetric(MetricName.Uptime, Helpers.datetime.time(node.connectedAt), true);
        cache.updateScore(node.nodeId, healthScoreData);

        dataCluster.storage({
            nodeId: Helpers.getNodeUid(node),
            timestamp: Date.now(),
            storageTotal: node.storage.total,
            storageAvailable: node.storage.available,
            storageUsed: node.storage.used
        });

        db.nodes().update(node);
    }

    private onBandwidthData(wire: ExtendedWireTypes, bandwidthDataEvent: ProtocolEvent<BandwidthData>): void {
        if (!wire.getRemoteMetadata().nodeId) {
            logger.error(`Node node-id=${wire.getRemoteMetadata().nodeId} is invalid.`);
            return;
        }

        const node = db.nodes().findOne({ nodeId: wire.getRemoteMetadata().nodeId });
        if (!node) {
            logger.error(`Node node-id=${wire.getRemoteMetadata().nodeId} is not found in database.`);
            return;
        }

        const healthScoreData: Partial<ScoreWeights> = {};
        if (bandwidthDataEvent.data.speeds && bandwidthDataEvent.data.speeds.originalUpload) {
            node.bandwidthUpload = bandwidthDataEvent.data.speeds.originalUpload;
            healthScoreData.bandwidthUploaded = cache.normalizeMetric(MetricName.BandwidthUploaded, node.bandwidthUpload, true);
        } else {
            node.bandwidthUpload = -1;
        }
        if (bandwidthDataEvent.data.speeds && bandwidthDataEvent.data.speeds.originalUpload) {
            node.bandwidthDownload = bandwidthDataEvent.data.speeds.originalDownload;
            healthScoreData.bandwidthDownloaded = cache.normalizeMetric(MetricName.BandwithDownloaded, node.bandwidthDownload, true);
        } else {
            node.bandwidthDownload = -1;
        }
        if (bandwidthDataEvent.data.server.ping != null) {
            node.latency = bandwidthDataEvent.data.server.ping;
            healthScoreData.latency = cache.normalizeMetric(MetricName.Latency, node.latency, true);
        }

        healthScoreData.uptime = cache.normalizeMetric(MetricName.Uptime, Helpers.datetime.time(node.connectedAt), true);
        if (node.latency == null) {
            logger.warn("Node latency is invalid.");
            return;
        }
        cache.updateScore(node.nodeId, healthScoreData);

        dataCluster.bandwidth({
            nodeId: Helpers.getNodeUid(node),
            timestamp: Date.now(),
            bandwidthUpload: node.bandwidthUpload != null ? node.bandwidthUpload : 0,
            bandwidthDownload: node.bandwidthDownload != null ? node.bandwidthDownload : 0,
            latency: node.latency
        });

        db.nodes().update(node);
    }

    private onSeeding(wire: ExtendedWireTypes, info: ProtocolEvent<Seeding>): void {
        if (!wire.getRemoteMetadata().nodeId) {
            logger.error(wire.getRemoteMetadata().nodeId + " : seeding : error : wire.getRemoteMetadata().nodeId");
            return;
        }

        const node = db.nodes().findOne({ nodeId: wire.getRemoteMetadata().nodeId });

        if (!node) {
            logger.error(wire.getRemoteMetadata().nodeId + " : seeding : error : node was not found in DB");
            return;
        }
        if (!Array.isArray(info.data.infoHashes)) {
            logger.error(wire.getRemoteMetadata().nodeId + " : seeding : error : infoHashes is not array");
            return;
        }

        // Remove old node contents entries.
        db.nodesContent().removeWhere({ nodeId: wire.getRemoteMetadata().nodeId, status: "done" });

        for (const infoHash of info.data.infoHashes) {
            const contentId = infoHash;
            const data: NodeContentData = {
                contentId: contentId,
                nodeId: wire.getRemoteMetadata().nodeId,
                status: "done"
            };
            db.nodesContent().upsert(
                {
                    contentId: contentId,
                    nodeId: wire.getRemoteMetadata().nodeId
                },
                data
            );
        }
        logger.info(
            `Node node-id=${wire.getRemoteMetadata().nodeId} reported its seeding list: content-ids[${info.data.infoHashes.length}]=${
                info.data.infoHashes
            }, master-registered-contents=${db.nodesContent().count()}.`
        );
    }

    private onUploaded(wire: ExtendedWireTypes, info: ProtocolEvent<Uploaded>): void {
        if (!wire.getRemoteMetadata().nodeId) {
            logger.error(wire.getRemoteMetadata().nodeId + " : uploaded : error : wire.getRemoteMetadata().nodeId");
            return;
        }

        const node = db.nodes().findOne({ nodeId: wire.getRemoteMetadata().nodeId });

        if (!node) {
            logger.error(wire.getRemoteMetadata().nodeId + " : uploaded : error : node was not found in DB");
            return;
        }

        if (node.uploaded == null) {
            node.uploaded = 0;
        }
        node.uploaded = info.data.uploaded + node.uploaded;
        db.nodes().update(node);

        const ip = info.data.ip;
        const geo = geoip.lookup(ip);
        const country = geo != null && geo.country != null ? geo.country : "";

        if (country != null) {
            api.register(ApiEventType.Response, {
                from: {
                    countryCode: node.location.countryCode
                },
                to: {
                    countryCode: country.toUpperCase()
                }
            });
        } else {
            logger.warn(`Event 'onUploaded' is missing geo data: country=${country}, ip=${ip}, geo-object=${geo}`);
        }

        logger.info(`Node node-id=${wire.getRemoteMetadata().nodeId} uploaded bytes=${info.data.uploaded}.`);
    }

    private onRequested(wire: ExtendedWireTypes, info: ProtocolEvent<Requested>): void {
        if (!wire.getRemoteMetadata().nodeId) {
            logger.error(wire.getRemoteMetadata().nodeId + " : requested : error : wire.getRemoteMetadata().nodeId", info);
            return;
        }
        if (!info.data.infoHash) {
            logger.error(wire.getRemoteMetadata().nodeId + " : requested : error : infoHash");
            return;
        }
        if (!info.data.piece && info.data.piece !== 0) {
            logger.error(wire.getRemoteMetadata().nodeId + " : requested : error : piece", info.data.piece);
            return;
        }

        const node = db.nodes().findOne({ nodeId: wire.getRemoteMetadata().nodeId });
        const file = db.files().findOne({ contentId: info.data.infoHash });

        if (!node) {
            logger.error(`Node node-id=${wire.getRemoteMetadata().nodeId} 'requested' error: node was not found in DB.`);
            return;
        }
        if (!file) {
            logger.error(
                `Node node-id=${wire.getRemoteMetadata().nodeId} 'requested' error: info-hash=${info.data.infoHash} piece=${
                    info.data.piece
                } not found.`
            );
            return;
        }

        api.register(ApiEventType.Request, {
            from: {
                countryCode: node.location.countryCode
            },
            to: {
                countryCode: config.get(ConfigOption.MasterLocationCountryCode)
            }
        });
        api.register(ApiEventType.Response, {
            from: {
                countryCode: config.get(ConfigOption.MasterLocationCountryCode)
            },
            to: {
                countryCode: node.location.countryCode
            }
        });

        if (!this.stores[file.file]) {
            this.stores[file.file] = this.getStore(file);

            setTimeout(() => {
                this.stores[file.file].close((err: Error) => {
                    logger.debug("FSChunkStore - closed ", err);
                    delete this.stores[file.file];
                });
            }, 60 * 60 * 1000);
        }

        if (0 > this.stores[file.file].lastChunkIndex || this.stores[file.file].lastChunkIndex < info.data.piece) {
            // TODO: Forward error to node so node can fix its metadata.
            return logger.warn(
                `Node node-id=${wire.getRemoteMetadata().nodeId} file=${file.file} requested out of range piece-index=${info.data.piece}.`
            );
        }

        this.stores[file.file].get(info.data.piece, (err: Error, dataBuf: Buffer) => {
            if (err) {
                const restarTime = 30 * 1000;
                // Very rare case where file is not opened
                setTimeout(() => {
                    logger.info(`FSChunkStore - restarting in ${restarTime}ms.`);
                    this.onRequested(wire, info);
                }, restarTime);

                return logger.error("FSChunkStore - not working: ", err);
            }

            const content = db.files().findOne({ contentId: info.data.infoHash });
            if (content == null) {
                logger.warn("Content does not exist.");
                // TODO: add debug info.
                return;
            }
            const reponseBuffer = this.createResponseBuffer(content.contentId, content.encrypt, info.data.piece, dataBuf);
            wire.response(reponseBuffer);
            logger.verbose(
                `Node node-id=${wire.getRemoteMetadata().nodeId} received content-id=${info.data.infoHash} piece=${
                    info.data.piece
                } length=${reponseBuffer.length}, piece-sha1=${sha1(reponseBuffer)}.`
            );
            if (file.pieces.length - 1 === info.data.piece) {
                logger.info(`Node node-id=${wire.getRemoteMetadata().nodeId} received content-id=${info.data.infoHash} all pieces.`);
            }
        });
    }

    public createResponseBuffer(contentId: string, encrypt: boolean, pieceIndex: number, dataBuf: Buffer): Buffer {
        const data = encrypt ? encryption.encrypt(encryption.getSecretKey(contentId), dataBuf, contentId) : dataBuf;

        const pieceBuf = Buffer.allocUnsafe(4);
        pieceBuf.writeUInt32BE(pieceIndex, 0);
        const infoHashBuf = Buffer.from(contentId, "hex");
        const buf = Buffer.concat([pieceBuf, infoHashBuf, data]);

        return buf;
    }

    private onDisconnect(wire: ExtendedWireTypes, err?: Error): void {
        if (wire.getRemoteMetadata().nodeId == null) {
            logger.error(`Node node-id=${wire.getRemoteMetadata().nodeId} node id is invalid.`);
            return;
        }
        if (err) {
            logger.error(`Node node-id=${wire.getRemoteMetadata().nodeId} error:`, err);
            return;
        }

        const node = db.nodes().findOne({ nodeId: wire.getRemoteMetadata().nodeId });
        const rows = db.nodesContent().find({ nodeId: wire.getRemoteMetadata().nodeId });

        let uptime = 0;

        // Setting up nodes status offline
        if (node) {
            node.status = NodeStatus.offline;
            node.loadDownload = null;
            node.loadUpload = null;
            node.disconnectedAt = Helpers.datetime.time();

            uptime = Helpers.datetime.timeDiff(node.disconnectedAt, node.connectedAt);

            node.uptime = node.uptime + uptime;

            db.nodes().update(node);

            logger.info(
                `Node node-id=${wire.getRemoteMetadata().nodeId} disconnected: node-ip=${
                    wire.getLocalMetadata().externalIp
                }, node-uptime=${uptime}s, node-total-uptime=${Helpers.datetime.secondsToString(node.uptime)}.`
            );
        } else {
            logger.warn(`Node node-id=${wire.getRemoteMetadata().nodeId} disconnect (unexpected error).`);
        }

        const timer = this._wires[wire.getRemoteMetadata().nodeId].pingPong;
        if (timer != null) {
            clearInterval(timer);
        }

        if (rows) {
            db.nodesContent().remove(rows);
        }

        delete this._wires[wire.getRemoteMetadata().nodeId];
    }

    public getStore(file: ContentData): Store {
        this.stores[file.file] = FSChunkStore(file.pieceLength, {
            path: file.file,
            length: file.length
        });

        return this.stores[file.file];
    }

    /**
     * Returns sorted by distance (ASC) client candidate peers.
     */
    public getCandidates(clientRequestData: ClientRequest, clientLocation: LocationData): Candidate[] {
        const candidates: Candidate[] = [];
        const nodesContentData = db.nodesContent().find({ contentId: Helpers.getContentIdentifier(clientRequestData.src) });
        for (const nodeContentData of nodesContentData) {
            const node = db.nodes().findOne({
                nodeId: nodeContentData.nodeId,
                status: NodeStatus.online
            });

            // Skip offline nodes.
            if (node == null) {
                continue;
            }

            // Skip wrong nodes and nodes having not performant node-client connections while maintaining priority webrtc > wss > ws.
            if (
                clientRequestData.connectionTypes.includes("webrtc") &&
                (node.connections.webrtc.port == null || node.connections.webrtc.checkStatus !== "succeeded")
            ) {
                continue;
            } else if (
                clientRequestData.connectionTypes.includes("wss") &&
                (node.connections.wss.port == null || node.connections.wss.checkStatus !== "succeeded")
            ) {
                continue;
            } else if (
                clientRequestData.connectionTypes.includes("ws") &&
                (node.connections.ws.port == null || node.connections.ws.checkStatus !== "succeeded")
            ) {
                continue;
            }

            // Cherry pick only client requested ports.
            const ports: { [TKey in ClientConnectionsTypes]?: number } = {};
            const clientConnectionsTypes: ClientConnectionsTypes[] = ["webrtc", "ws", "wss"];
            clientConnectionsTypes.forEach(connectionType => {
                if (clientRequestData.connectionTypes.includes(connectionType)) {
                    ports[connectionType] = node.connections[connectionType].port!;
                }
            });

            // Skip node if it contains 0 performant node-client connection channels.
            if (Object.keys(ports).length === 0) {
                logger.verbose(`Skipping node node-id=${node.nodeId}, client-connections-types=0.`);
                continue;
            }

            if (node.location.latitude == null || node.location.longitude == null) {
                logger.error(`Node node-id=${node} 'latidude' or 'longitude' is invalid.`);
                continue;
            }

            // Calculate distace in meters.
            node.distance = geolib.getDistance(
                { latitude: clientLocation.latitude, longitude: clientLocation.longitude },
                { latitude: node.location.latitude, longitude: node.location.longitude }
            );

            if (node.distance == null) {
                logger.warn(`Failed to calculate node-id=${node} distance to client.`);
                continue;
            }

            const whitelist = config.get(ConfigOption.CachingWhitelist);
            if (Array.isArray(whitelist) && whitelist.length > 0 && whitelist[0] !== "*" && !whitelist.includes(node.ip)) {
                continue;
            }

            candidates.push({
                distance: node.distance,
                host: node.domain != null ? node.domain : node.ip,
                ip: node.ip,
                location: node.location,
                nodeId: node.nodeId,
                ports: ports
            });
        }

        return candidates.sort((a, b) => a.distance - b.distance);
    }

    public updateCandidatesWithInternalData(candidates: Candidate[], src: string): Peer[] {
        const peers: Peer[] = [];

        if (candidates.length === 0) {
            logger.warn(`Found 0 total peers for source=${src}.`);
            return peers;
        }

        for (const candidate of candidates) {
            const contentId = Helpers.getContentIdentifier(src);

            if (db.nodesContent().findOne({ contentId: contentId }) == null) {
                logger.error(`Returning 0 peers since content content-id=${contentId} was not found.`);
                continue;
            }

            const internalNode = internalNodesMetadata.get(candidate.ip);
            peers.push({
                host: candidate.host,
                location: {
                    latitude: internalNode == null ? candidate.location.latitude : internalNode.latitude,
                    longitude: internalNode == null ? candidate.location.longitude : internalNode.longitude,
                    countryCode: internalNode == null ? candidate.location.countryCode : internalNode.countryCode,
                    city: internalNode == null ? candidate.location.city : internalNode.city
                },
                ports: candidate.ports,
                secretKey: config.get(ConfigOption.ContentEncryptionIsEnabled) ? `${encryption.getSecretKey(contentId)}:${contentId}` : null
            });
        }

        return peers;
    }

    public getWire(nodeId: string): ExtendedWireTypes {
        return this._wires[nodeId];
    }

    public async checkWebrtc(wire: ExtendedWireTypes, ip: string, port: number): Promise<void> {
        try {
            const result = await scheduler.process(wire.getRemoteMetadata().nodeId, ip, port, config.get(ConfigOption.MasterIp));
            if (!wire.isReady()) {
                // Ignore result since node is disconnected.
                return;
            }
            if (result.status === "success") {
                updateNodeStatus(wire.getRemoteMetadata().nodeId, "succeeded");
            } else {
                updateNodeStatus(wire.getRemoteMetadata().nodeId, "failed");
                const msg = `WebRTC connection failed. Port ${port} or IP ${ip} might be unreachable.`;
                wire.warning(msg);
                logger.info(
                    `Node node-id=${wire.getRemoteMetadata().nodeId} received warning: node-ip=${
                        wire.getLocalMetadata().externalIp
                    } msg='${msg}'`
                );
            }
        } catch (err) {
            logger.error(`Unexpected error occured while checking node-id=${wire.getRemoteMetadata().nodeId} WebRTC connection:`, err);
        }

        function updateNodeStatus(nodeId: string, status: "failed" | "succeeded" | "not-checked"): void {
            const node = db.nodes().findOne({ nodeId: nodeId });
            if (node != null) {
                node.connections.webrtc.checkStatus = status;
                db.nodes().update(node);
            }
        }
    }

    public checkWs(wire: ExtendedWireTypes, ip: string, port: number): void {
        const ws: WebSocket = new WebSocket(`ws://${ip}:${port}`);
        ws.onopen = () => {
            ws.close();
            updateNodeStatus(wire.getRemoteMetadata().nodeId, "succeeded");
        };
        ws.onerror = () => {
            updateNodeStatus(wire.getRemoteMetadata().nodeId, "failed");
            const msg = `WS connection failed. Port ${port} or IP ${ip} might be unreachable.`;
            wire.warning(msg);
            logger.info(
                `Node node-id=${wire.getRemoteMetadata().nodeId} received warning: node-ip=${
                    wire.getLocalMetadata().externalIp
                } msg='${msg}'`
            );
        };

        function updateNodeStatus(nodeId: string, status: "failed" | "succeeded" | "not-checked"): void {
            const node = db.nodes().findOne({ nodeId: nodeId });
            if (node != null) {
                node.connections.ws.checkStatus = status;
                db.nodes().update(node);
            }
        }
    }

    public checkWss(wire: ExtendedWireTypes, domain: string | undefined, port: number): void {
        const msg = `WSS connection failed. Port ${port} or domain ${domain} might be unreachable.`;
        if (domain == null) {
            failed();
            return;
        }
        const ws: WebSocket = new WebSocket(`wss://${domain}:${port}`);
        ws.onopen = () => {
            ws.close();
            updateNodeStatus(wire.getRemoteMetadata().nodeId, "succeeded");
        };
        ws.onerror = () => {
            failed();
        };
        function failed(): void {
            updateNodeStatus(wire.getRemoteMetadata().nodeId, "failed");
            wire.warning(msg);
            logger.info(
                `Sent warning to node-id=${wire.getRemoteMetadata().nodeId} node-ip=${wire.getLocalMetadata().externalIp} msg='${msg}'`
            );
        }

        function updateNodeStatus(nodeId: string, status: "failed" | "succeeded" | "not-checked"): void {
            const node = db.nodes().findOne({ nodeId: nodeId });
            if (node != null) {
                node.connections.wss.checkStatus = status;
                db.nodes().update(node);
            }
        }
    }
}

export let nodes = new Nodes();
