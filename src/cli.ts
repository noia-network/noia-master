import * as WebRtcDirect from "@noia-network/webrtc-direct-client";
import * as WebSocket from "ws";
import * as protobuf from "protobufjs";
import * as wrtc from "wrtc";
import * as sha1 from "sha1";
import * as fs from "fs-extra";
import { Wire, ClientRequest, ContentResponse, ClientResponse } from "@noia-network/protocol";

import { CliHelpers } from "./cli-helpers";
import { Helpers } from "./helpers";
import { NodeContentData } from "./nodes";
import { config, ConfigOption } from "./config";
import { contentManager, ClusteringAlgorithm } from "./content-manager";
import { dataCluster } from "./data-cluster";
import { db } from "./db";
import { logger, LogLevel } from "./logger";
import { NodeStatus, CentroidLocationData } from "./contracts";
import { nodes } from "./nodes";
import { Master } from "./master";
import { whitelist } from "./whitelist";
import { cache, ReplacementFactor } from "./cache";

const DEFAULT_IMAGE_SOURCE = "https://noia.network/samples/image.jpg";
const DEFAULT_VIDEO_SOURCE = "https://noia.network/samples/video.mp4";
const DEFAULT_MODEL_SOURCE = "https://noia.network/samples/model.bin";

const vorpal = logger.vorpal;

let ContentResponseProtobuf: protobuf.Type;
protobuf.load(Wire.getProtoFilePath(), (err, root) => {
    if (err) {
        throw err;
    }
    if (root == null) {
        console.info("Root is null.");
        return;
    }
    ContentResponseProtobuf = root.lookupType("ContentResponse");
});

function recursiveCentroidPrinting(centroids: CentroidLocationData[], c: number): void {
    if (c < centroids.length) {
        const centroid = centroids[c];
        logger.debug(`Cluster with hit-count ${centroid.count} and centroid [${centroid.latitude}, ${centroid.longitude}].`);
        c++;
        setTimeout(() => {
            recursiveCentroidPrinting(centroids, c);
        }, 100);
    }
}

export function cli(master: Master): void {
    vorpal.command("create-uptimes-csv").action(async args => {
        await fs.ensureFile("nodes.csv");
        await fs.appendFile("nodes.csv", `nodeId,from,to,uptime\n`);
        for (const nodeId of getNodesIds()) {
            const uptime = await dataCluster.uptime({
                nodeId: nodeId,
                timestamp: new Date().getTime(),
                from: 0,
                to: new Date().getTime()
            });
            // @ts-ignore
            await fs.appendFile("nodes.csv", `${uptime.nodeId},${uptime.from},${uptime.to},${uptime.total}\n`);
        }
    });

    vorpal.command("disconnect-node <nodeId>").action(async args => {
        if (nodes._wires.hasOwnProperty(args.nodeId)) {
            const wire = nodes._wires[args.nodeId];
            CliHelpers.log(`Disconnecting node node-id=${wire.getRemoteMetadata().nodeId}...`);
            wire.close(1002, "Master is in maintenance mode - please wait...");
            dataCluster.disconnected({
                nodeId: Helpers.getNodeUid(wire.getRemoteMetadata()),
                timestamp: Date.now()
            });
        }
    });

    vorpal.command("shutdown-master").action(async args => {
        CliHelpers.log("Master is entering maintenance mode...");
        nodes.maintenanceMode = true;

        for (const client of master.wssNodes.clients) {
            client.close(1002, "Master is in maintenance mode - please wait...");
        }

        master.masterServerNodes.close(() => {
            for (const key in nodes._wires) {
                if (nodes._wires.hasOwnProperty(key)) {
                    const wire = nodes._wires[key];
                    dataCluster.disconnected({
                        nodeId: Helpers.getNodeUid(wire.getRemoteMetadata()),
                        timestamp: Date.now()
                    });
                }
            }

            CliHelpers.log("Master is shutting down in 6 seconds...");
            setTimeout(() => {
                process.exit();
            }, 6 * 1000);
        });
    });

    vorpal.command("add-whitelisted-client <name> <domain>", "Add whitelisted client.").action(async args => {
        dataCluster.addWhitelistedClient({
            name: args.name,
            nodeId: args.domain
        });

        whitelist.refreshWhitelist();
    });

    vorpal.command("remove-whitelisted-client <name>", "Remove whitelisted client by name.").action(async args => {
        dataCluster.removeWhitelistedClient({
            name: args.name
        });

        await whitelist.refreshWhitelist();

        const files = db
            .files()
            .chain()
            .data();
        for (const file of files) {
            if (!whitelist.isWhitelisted(file.contentSrc)) {
                db.nodesContent().findAndRemove({ contentId: file.contentId });
                db.files().findAndRemove({ contentId: file.contentId });
            }
        }
    });

    vorpal.command("list-whitelisted-client", "List whitelisted client.").action(async args => {
        const list = await dataCluster.listWhitelisted({
            nodeId: "wh1telistedCl1ents",
            timestamp: Date.now()
        });
        let index = 0;
        if (list != null && Array.isArray(list.whitelistedClients)) {
            for (const item of list.whitelistedClients) {
                index += 1;
                CliHelpers.log(`${index}/${list.whitelistedClients.length} name=${item.name} domain=${item.nodeId}.`);
            }
        }
        if (index === 0) {
            CliHelpers.log(`No whitelisted clients found.`);
        }
    });

    vorpal
        .command("is-node-registered-online <nodeId> [minutesOffline]", "Check if node is registered as online in past t minutes")
        .action(async args => {
            const minutesOffline: number = parseInt(args.minutesOffline) || 15;
            const isOnline = await dataCluster.isAlive({
                nodeId: args.nodeId,
                minutesOffline: minutesOffline,
                timestamp: Date.now()
            });
            CliHelpers.log(`Node-id=${args.nodeId} is-online=${isOnline}.`);
        });

    vorpal
        .command("log-level [logLevels]", "Set comma separatard log levels. Set to 'Default' log level if argument is not supplied.")
        .action(async args => {
            if (typeof args.logLevels === "string") {
                const logLevels = args.logLevels.split(",");
                let accumulator = LogLevel.None;
                for (const logLevel of logLevels) {
                    const indexOf = Object.keys(LogLevel).indexOf(logLevel);
                    if (indexOf !== -1) {
                        accumulator |= parseInt(Object.keys(LogLevel)[indexOf - Object.keys(LogLevel).length / 2]);
                    }
                }
                logger.setLogLevel(accumulator);
            } else {
                logger.setLogLevel(LogLevel.Default);
            }
        });

    vorpal.command("remove-content <nodeId> [contentsIds]", "Remove content from node.").action(async args => {
        const contents: string[] = typeof args.contentsIds === "string" ? args.contentsIds.split(",") : [];
        if (nodes.getWire(args.nodeId)) {
            nodes.getWire(args.nodeId).clear(contents);
            CliHelpers.log(`Removed content-ids=${contents} from node node-id=${args.nodeId}.`);
        } else {
            CliHelpers.log("Bad nodeId!");
        }
    });

    vorpal.command("remove-contents [contentsIds]", "Remove content from all online nodes.").action(async args => {
        const contents: string[] = typeof args.contentsIds === "string" ? args.contentsIds.split(",") : [];

        const foundNodes = db.nodes().find({ status: NodeStatus.online });
        CliHelpers.log(`Removing contents from ${foundNodes.length} nodes.`);
        if (foundNodes != null) {
            for (const node of foundNodes) {
                nodes.getWire(node.nodeId).clear(contents);
                CliHelpers.log(`Removed content-ids=${contents} from node node-id=${node.nodeId}.`);
            }
        }
    });

    vorpal
        .command("contents", "Show ready to deliver contents from online nodes.")
        .option("-n, --nodeId <nodeId>", "Node id.")
        .option("-c, --contentId <contentId>", "Content id.")
        .action(async args => {
            const query: Partial<NodeContentData> = {};
            if (args.options.nodeId != null) {
                query.nodeId = args.options.nodeId;
            }
            if (args.options.contentId != null) {
                query.contentId = args.options.contentId;
            }
            const results = db
                .nodesContent()
                .chain()
                .find(query)
                .simplesort("nodeId")
                .data();
            const count = results.length;
            let index = 0;
            CliHelpers.log(`Found ${count} registered nodes contents, query: node-id=${query.nodeId}, content-id=${query.contentId}.`);
            for (const item of results) {
                index += 1;
                const file = db.files().findOne({ contentId: item.contentId });
                CliHelpers.log(
                    `[${index}/${count}] node-id=${item.nodeId}, content-id=${item.contentId}, status=${item.status}, ${
                        file != null ? JSON.stringify(file.meta) : null
                    }.`
                );
            }
        });

    vorpal
        .command("nodes", "Show nodes information.")
        .option("-n, --nodeId <nodeId>", "Node to view by node id amongst online and offline nodes.")
        .option("-a, --airdropAddress <airdropAddress>", "Node airdrop address.")
        .option("-d, --dump", "Show node database dump.")
        .option("-o, --offline", "Show offline nodes. Default: online.")
        .option("-v, --verbose", "Display with more information.")
        .action(async args => {
            const query = {};

            // Status.
            if (args.options.offline != null) {
                Object.assign(query, { status: NodeStatus.offline });
            } else {
                Object.assign(query, { status: NodeStatus.online });
            }

            // Airdrop address.
            if (args.options.airdropAddress != null) {
                Object.assign(query, { airdropAddress: args.options.airdropAddress });
            }

            // Node id.
            if (args.options.nodeId != null) {
                Object.assign(query, { nodeId: args.options.nodeId });
            }

            const foundNodes = db.nodes().find(query);
            const count = foundNodes.length;
            CliHelpers.log(`Total ${count} nodes found for query: ${JSON.stringify(query, null, 2)}.`);
            if (args.options.verbose == null) {
                return;
            }
            let nodeIndex = 0;
            if (foundNodes != null) {
                for (const node of foundNodes) {
                    nodeIndex += 1;
                    const uptime = await dataCluster.uptime({
                        nodeId: Helpers.getNodeUid(node),
                        from: 0,
                        to: Date.now(),
                        timestamp: new Date().getTime()
                    });
                    CliHelpers.log(
                        `Node ${nodeIndex}/${count} node-id=${node.nodeId}, airdrop-address=${node.airdropAddress}, status=${
                            node.status
                        }, online-time=${uptime.hours}:${uptime.minutes}:${uptime.seconds}.`
                    );
                    if (args.options.dump) {
                        CliHelpers.log("Database dump:");
                        CliHelpers.logObject(node);
                    }
                }
            }
        });

    vorpal.command("estimate-scale", "Run scale estimator for smart caching").action(async () => {
        await contentManager.estimateScale();
        db.files().data.forEach(file => {
            CliHelpers.log(`Content ${file.contentSrc} target scale and diff: [${file.scaleTarget}; ${file.scaleDiff}]`);
        });
    });

    vorpal
        .command("estimate-locality", "Run KMeans clustering algorithm from node-kmeans library")
        .option("-a, --algorithm <algorithm>", "algorithm name")
        .option("-c, --contentId <contentId>", "Content id.")
        .option("-s, --sourceUrl <sourceUrl>", "Source URL (default image source if not supplied).")
        .action(async args => {
            let content = null;
            let algorithm: ClusteringAlgorithm | undefined = undefined;
            if (args.options.contentId != null) {
                content = db.files().findOne({ contentId: args.options.contentId });
            } else if (args.options.sourceUrl != null) {
                content = db.files().findOne({ contentSrc: args.options.sourceUrl });
            } else {
                CliHelpers.log(`Unknown content ID or source URL supplied.`);
            }

            if (content == null) {
                CliHelpers.log(`Content not found.`);
                return;
            }

            if (args.options.algorithm) {
                if (args.options.algorithm.include(ClusteringAlgorithm.dbscan, ClusteringAlgorithm.kmeans, ClusteringAlgorithm.optics)) {
                    algorithm = args.options.algorithm;
                } else {
                    CliHelpers.log(`Unknown algorithm name supplied.`);
                }
            }

            let centroids: CentroidLocationData[] = [];
            centroids = await contentManager.estimateLocality(content.contentId, algorithm);
            logger.debug(`Content with id=${content.contentId} popular in ${centroids.length} location(s)`);
            const c = 0;
            recursiveCentroidPrinting(centroids, c);
        });

    vorpal.command("smart-caching", "Run smart caching algorithm based on scale and locality").action(async () => {
        cache.smartCachingDecisions(ReplacementFactor.scale);
    });

    vorpal
        .command("cache-m2n", "Cache source to all or single online node.")
        .option("-s, --sourceUrl <sourceUrl>", "Source URL (default image source if not supplied).")
        .option("-n, --nodeId <nodeId>", "Node id to cache content to (all if not supplied).")
        .action(async args => {
            const sourceUrl = args.options.sourceUrl != null ? args.options.sourceUrl : DEFAULT_IMAGE_SOURCE;
            const nodeId = args.options.nodeId != null ? args.options.nodeId : null;
            await contentManager.queueCaching(sourceUrl, nodeId, null);
        });

    vorpal
        .command("cache-n2n", "Cache source to all or single online node.")
        .option("-s, --sourceUrl <sourceUrl>", "Source URL (default image source if not supplied).")
        .option("-t, --toNodeId <toNodeId>", "Node id to cache content to (all if not supplied).")
        .option("-f, --fromNodeId <fromNodeId>", "Node id to cache content from (all if not supplied).")
        .action(async args => {
            const sourceUrl = args.options.sourceUrl != null ? args.options.sourceUrl : DEFAULT_IMAGE_SOURCE;
            const toNodeId = args.options.toNodeId != null ? args.options.toNodeId : null;
            const fromNodeId = args.options.fromNodeId != null ? args.options.fromNodeId : null;
            await contentManager.queueCaching(sourceUrl, toNodeId, fromNodeId);
        });

    vorpal
        .command("request")
        .option("-s, --sourceUrl <sourceUrl>", "Source URL (default image source if not supplied).")
        .option("--webrtc", "WebRTC connection type.")
        .option("--wss", "WebSocket (secure) connection type.")
        .option("--ws", "WebSocket connection type.")
        .action(async args => {
            const connectionTypes: string[] = [];
            ["webrtc", "wss", "ws"].forEach(connectionType => {
                if (args.options[connectionType]) {
                    connectionTypes.push(connectionType);
                }
            });
            const sourceUrl = args.options.sourceUrl != null ? args.options.sourceUrl : DEFAULT_IMAGE_SOURCE;
            const address = CliHelpers.getAddressByProtocol(config.get(ConfigOption.ProtocolsWsClientIsSecure) ? "wss" : "ws");
            const clientRequestData: ClientRequest = {
                src: sourceUrl,
                connectionTypes: connectionTypes
            };
            const clientWs = new WebSocket(address);
            await CliHelpers.onWsOpenPromise(clientWs);
            clientWs.send(JSON.stringify(clientRequestData));
            const response = JSON.parse(await CliHelpers.onWsMessage(clientWs));
            CliHelpers.logObject(response);
            clientWs.close();
        });

    vorpal
        .command("caching-simulation-m2n")
        .option("-n, --nodeId <nodeId>", "Node id to cache content to (all if not supplied).")
        .action(async args => {
            const nodeId = args.options.nodeId != null ? args.options.nodeId : null;
            await contentManager.queueCaching(DEFAULT_IMAGE_SOURCE, nodeId, null);
            await contentManager.queueCaching(DEFAULT_VIDEO_SOURCE, nodeId, null);
            await contentManager.queueCaching(DEFAULT_MODEL_SOURCE, nodeId, null);
            CliHelpers.log("Caching simulation finished.");
        });

    vorpal
        .command("client-simulation [type]")
        .alias("sc")
        .action(async args => {
            if (args.type == null || args.type === "ws" || args.type === "wss") {
                const clientProtocol = config.get(ConfigOption.ProtocolsWsClientIsSecure) ? "wss" : "ws";
                const domain = config.get(ConfigOption.MasterDomain);
                const port = config.get(ConfigOption.ProtocolsWsClientPort);
                const address = `${clientProtocol}://${domain}:${port}`;
                const clientRequestData: ClientRequest = {
                    src: args.source != null ? args.source : DEFAULT_IMAGE_SOURCE,
                    connectionTypes: [args.type === "wss" ? "wss" : "ws"]
                };
                const ws = new WebSocket(address);
                ws.onerror = err => {
                    CliHelpers.log("Connection with master closed (error):", err);
                };
                ws.onclose = () => {
                    CliHelpers.log("Connection with master closed (normal).");
                };
                await CliHelpers.onWsOpenPromise(ws);
                ws.send(JSON.stringify(clientRequestData));
                const response: ClientResponse = JSON.parse(await CliHelpers.onWsMessage(ws));
                if (response.data != null) {
                    for (const peer of response.data.peers) {
                        connectToNode(
                            `${peer.host}:${peer.ports[args.type === "wss" ? "wss" : "ws"]}`,
                            args.type === "wss" ? "wss" : "ws",
                            peer.secretKey
                        );
                    }
                } else {
                    logger.error(response.status, response.error);
                }
                function connectToNode(peerAddress: string, peerProtocol: string, secretKey: string | null): void {
                    console.info("Connecting to...", `${peerProtocol}://${peerAddress}`);
                    const nodeWs = new WebSocket(`${peerProtocol}://${peerAddress}`);
                    nodeWs.on("open", () => {
                        CliHelpers.log(`Connected to node node-address=${peerAddress}.`);
                        const responseData = response.data;
                        if (responseData == null) {
                            logger.error(response.status, response.error);
                            return;
                        }
                        responseData.metadata.piecesIntegrity.forEach((pieceIntegrity: string, pieceIndex: number) => {
                            setTimeout(() => {
                                nodeWs.send(
                                    JSON.stringify({
                                        contentId: responseData.metadata.contentId,
                                        index: pieceIndex,
                                        offset: 0
                                    })
                                );
                            }, pieceIndex * 500);
                        });
                        nodeWs.on("message", (buffer: Buffer) => {
                            // @ts-ignore
                            const content: ContentResponse = ContentResponseProtobuf.decode(buffer);

                            if (content.status === 200 && content.data != null) {
                                CliHelpers.log(
                                    `Node responded with status=${content.status}, data was-encrypted=${config.get(
                                        ConfigOption.ContentEncryptionIsEnabled
                                    )}: content-id=${content.data.contentId}, index=${content.data.index} offset=${
                                        content.data.offset
                                    } buffer-length=${content.data.buffer.length}, is-integrity-valid=${responseData.metadata
                                        .piecesIntegrity[content.data.index] ===
                                        sha1(CliHelpers.getPieceDataWs(secretKey, content))}, sha1-before-decryption=${sha1(
                                        content.data.buffer
                                    )}, secret-key=${secretKey}.`
                                );
                            } else {
                                CliHelpers.log(`Node responded with an error status=${content.status} error='${content.error}'.`);
                            }
                        });
                    });
                    nodeWs.on("error", err => {
                        CliHelpers.log("Node error:", err);
                    });
                }
            } else if (args.type === "webrtc") {
                const clientProtocol = config.get(ConfigOption.ProtocolsWsClientIsSecure) ? "wss" : "ws";
                const domain = config.get(ConfigOption.MasterDomain);
                const port = config.get(ConfigOption.ProtocolsWsClientPort);
                const address = `${clientProtocol}://${domain}:${port}`;
                const clientRequestData: ClientRequest = {
                    src: args.source != null ? args.source : DEFAULT_IMAGE_SOURCE,
                    connectionTypes: ["webrtc"]
                };
                const ws = new WebSocket(address);
                ws.onerror = err => {
                    CliHelpers.log("Connection with master closed (error):", err);
                };
                ws.onclose = () => {
                    CliHelpers.log("Connection with master closed (normal).");
                };
                await CliHelpers.onWsOpenPromise(ws);
                ws.send(JSON.stringify(clientRequestData));
                const response: ClientResponse = JSON.parse(await CliHelpers.onWsMessage(ws));
                if (response.data != null) {
                    for (const peer of response.data.peers) {
                        connectToNode(peer.host, peer.ports.webrtc as number, peer.secretKey);
                    }
                } else {
                    logger.error(response.status, response.error);
                }
                // tslint:disable-next-line
                async function connectToNode(host: string, port: number, secretKey: string | null): Promise<void> {
                    // Uncomment and modify for testing purposes.
                    // host = "192.168.0.104";
                    const peerAddress = `http://${host}:${port}`;
                    console.info(`Connecting (WebRTC) to address ${peerAddress}.`);
                    const client = new WebRtcDirect.Client(peerAddress, {
                        wrtc: wrtc,
                        candidateIp: config.get(ConfigOption.MasterIp)
                    });
                    await client.connect();
                    // await client.stop();
                    CliHelpers.log(`Connected to node node-address=${peerAddress}.`);
                    const responseData = response.data;
                    if (responseData == null) {
                        logger.error(response.status, response.error);
                        return;
                    }
                    responseData.metadata.piecesIntegrity.forEach((pieceIntegrity: string, pieceIndex: number) => {
                        setTimeout(() => {
                            client.send(
                                JSON.stringify({
                                    contentId: responseData.metadata.contentId,
                                    index: pieceIndex,
                                    offset: 0
                                })
                            );
                        }, pieceIndex * 500);
                    });
                    // @ts-ignore
                    client.on("data", (buffer: ArrayBuffer) => {
                        // @ts-ignore
                        const content: ContentResponse = ContentResponseProtobuf.decode(new Uint8Array(buffer));

                        if (content.status === 200 && content.data != null) {
                            CliHelpers.log(
                                `Node responded with status=${content.status}, data was-encrypted=${config.get(
                                    ConfigOption.ContentEncryptionIsEnabled
                                )}: content-id=${content.data.contentId}, index=${content.data.index} offset=${
                                    content.data.offset
                                } buffer-length=${content.data.buffer.length}, is-integrity-valid=${responseData.metadata.piecesIntegrity[
                                    content.data.index
                                ] === sha1(CliHelpers.getPieceDataWebRtc(secretKey, content))}, sha1-before-decryption=${sha1(
                                    Buffer.from(content.data.buffer)
                                )} secret-key=${secretKey}.`
                            );
                        } else {
                            CliHelpers.log(`Node responded with an error status=${content.status} error='${content.error}'.`);
                        }
                    });
                    setTimeout(async () => {
                        await client.stop();
                    }, responseData.metadata.piecesIntegrity.length * 500);
                }
            }
        });
    vorpal.delimiter("master-cli>").show();
}

function getNodesIds(): string[] {
    return [];
}
