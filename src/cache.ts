import { ContentData } from "./content-manager";
import { Helpers } from "./helpers";
import { NodeStatus } from "./contracts";
import { db } from "./db";
import { logger } from "./logger";
import { nodes } from "./nodes";
import { config, ConfigOption } from "./config";

export interface ScoreWeights {
    bandwidthUploaded: number;
    bandwidthDownloaded: number;
    uptime: number;
    latency: number;
    storage: number;
}

interface MeanStDev {
    mean: number;
    stdev: number;
}

export enum MetricName {
    BandwidthUploaded = "bandwidth_up",
    BandwithDownloaded = "bandwith_dw",
    Latency = "latency",
    Storage = "storage",
    Uptime = "uptime"
}

interface CachingQueueItem {
    contentData: ContentData;
    nodeId: string | null;
    fromNodeId: string | null;
}

export class Cache {
    constructor() {
        setInterval(async () => {
            const item = this.queueItems.pop();
            if (item != null) {
                await this.toOnlineNodesRoundRobin(item.contentData, item.nodeId, item.fromNodeId);
            }
        }, config.get(ConfigOption.CachingInterval) * 1000);
    }

    private queueItems: CachingQueueItem[] = [];

    /**
     * Queue caching requests.
     */
    public queue(contentData: ContentData, toNodeId: string | null, fromNodeId: string | null): void {
        this.queueItems.push({
            contentData: contentData,
            nodeId: toNodeId,
            fromNodeId: fromNodeId
        });
    }

    /**
     * This function supplies weights for node health-score.
     * For now weights are hard-coded.
     * Later the weights will be dynamically solved from the latest metrics
     */
    private getScoreWeights(): ScoreWeights {
        /** Weights should always sum to 1! */
        return {
            bandwidthUploaded: 0.22,
            bandwidthDownloaded: 0.11,
            uptime: 0.35,
            latency: 0.27,
            storage: 0.05
        };
    }

    /**
     * This function calculates the node health score, which is a weighted avarage of normalized metrics.
     * If metric is passed in data object, it is used for an update, otherwise we take the last known metric from db.
     */
    public updateScore(nodeId: string, data: Partial<ScoreWeights>): void {
        const nodeData = db.nodes().findOne({ nodeId: nodeId });
        if (nodeData == null) {
            throw new Error("Called 'updateScore' on invalid node.");
        }
        const defaultWeights = this.getScoreWeights();
        const scoreWeights: ScoreWeights = {
            bandwidthUploaded:
                data.bandwidthUploaded != null ? data.bandwidthUploaded : nodeData.bandwidthUpload != null ? nodeData.bandwidthUpload : 0,
            bandwidthDownloaded:
                data.bandwidthDownloaded != null
                    ? data.bandwidthDownloaded
                    : nodeData.bandwidthDownload != null
                    ? nodeData.bandwidthDownload
                    : 0,
            uptime: data.uptime != null ? data.uptime : nodeData.uptime,
            latency: data.latency != null ? data.latency : nodeData.latency == null ? 0 : nodeData.latency,
            storage: data.storage != null ? data.storage : nodeData.storage.total
        };
        const updatedScore =
            scoreWeights.bandwidthUploaded * defaultWeights.bandwidthUploaded +
            scoreWeights.bandwidthDownloaded * defaultWeights.bandwidthDownloaded +
            scoreWeights.uptime * defaultWeights.uptime +
            scoreWeights.latency * defaultWeights.storage +
            scoreWeights.storage * defaultWeights.storage;
        db.healthScore().upsert({ contentId: nodeId }, { contentId: nodeId, data: updatedScore });
        logger.debug(`Update healthscore of ${nodeId}: ${updatedScore}`);
    }

    /**
     * This function updates mean and variance for a specific parameter in db.settings and returns updated mean and standard deviation.
     * We are using online algorithms to update mean and variance.
     * Very clear derivation can be found at http://datagenetics.com/blog/november22017/index.html.
     */
    private updateMeanVar(metricName: MetricName, metricValue: number): MeanStDev {
        // Extract parameters from database.
        // mean (mu_n - 1)
        let lastMean = db.settings().view({ key: `${metricName}-mean` }) as number | undefined;
        if (lastMean == null || lastMean == Infinity || lastMean == -Infinity) {
            lastMean = 0;
        }
        // cummulative variance (S_n - 1)
        let lastVar = db.settings().view({ key: `${metricName}-var` }) as number | undefined;
        if (lastVar == null || lastMean == Infinity || lastMean == -Infinity) {
            lastVar = 1;
        }

        // Update mean.
        const numberOfNodes = db.settings().view({ key: "number-of-nodes" }) as number | undefined;
        if (numberOfNodes == null) {
            throw new Error("Value 'numberOfNodes' is invalid.");
        }
        const newMean = lastMean + (metricValue - lastMean) / numberOfNodes;
        // Update variance.
        const newVar = lastVar + (metricValue - lastMean) * (metricValue - newMean);

        // Write parameters into database.
        // mean (mu_n)
        db.settings().set({ key: `${metricName}-mean` }, { key: `${metricName}-mean`, value: newMean });
        // cummulative variance (S_n)
        db.settings().set({ key: `${metricName}-var` }, { key: `${metricName}-var`, value: newVar });

        return { mean: newMean, stdev: Math.sqrt(newVar / numberOfNodes) };
    }

    public normalizeMetric(metricName: MetricName, metricValue: number): number {
        const params = this.updateMeanVar(metricName, metricValue);
        // With 99% probability the normalized value will be positive.
        const stdNormalAdj = 2.575;
        let sign = 1;
        if (metricName === "latency") {
            sign = -1;
        }
        return (sign * (metricValue - params.mean)) / params.stdev + stdNormalAdj;
    }

    // TODO: remove deprecated.
    // /**
    //  * Send cache request to all or one online nodes.
    //  */
    // private toOnlineNodes(
    //     contentData: ContentData,
    //     /**
    //      * Cache to all nodes if nodeId is null.
    //      */
    //     nodeId: string | null
    // ): void {
    //     const onlineStatusQuery = { status: NodeStatus.online };
    //     const onlineNodes = db.nodes().find(nodeId != null ? { nodeId: nodeId, ...onlineStatusQuery } : onlineStatusQuery);
    //     const onlineNodesCount = onlineNodes.length;
    //     const logMsg = `Sending seeding command to ${onlineNodesCount} NOIA node(s).`;
    //     if (onlineNodesCount === 0) {
    //         logger.warn(logMsg);
    //     } else {
    //         logger.info(logMsg);
    //     }
    //     for (const onlineNode of onlineNodes) {
    //         const wire = nodes.getWire(onlineNode.nodeId);

    //         wire.seed({
    //             metadata: {
    //                 infoHash: contentData.contentId,
    //                 pieces: contentData.pieces.length
    //             }
    //         });
    //         logger.caching(
    //             `Node node-id=${onlineNode.nodeId} received seeding command: content-id=${contentData.contentId}, pieces=${
    //                 contentData.pieces.length
    //             }.`
    //         );
    //     }
    // }

    private async pruneContents(nodeId: string): Promise<boolean> {
        const nodeContents = db.nodesContent().find({ nodeId: nodeId });
        const contentsToRemove: string[] = [];
        for (const nodeContent of nodeContents) {
            const file = db.files().findOne({ contentId: nodeContent.contentId });
            if (file == null) {
                contentsToRemove.push(nodeContent.contentId);
            }
        }

        if (contentsToRemove.length > 0) {
            const wire = nodes.getWire(nodeId);
            if (wire != null) {
                logger.caching(
                    `Node node-id=${nodeId} contains ${contentsToRemove.length} unknown contents - asked node to remove contents.`
                );
                wire.clear(contentsToRemove);
            }
            await Helpers.sleep(config.get(ConfigOption.CachingRemoveDelay));
            return true;
        }

        return false;
    }

    /**
     * Send cache request to all or one online nodes with replacement strategy.
     */
    private async toOnlineNodesRoundRobin(
        contentData: ContentData,
        /**
         * Cache to all nodes if nodeId is null.
         */
        toNodeId: string | null,
        /**
         * If not null, caches from particula node id. If null, caches from master.
         */
        fromNodeId: string | null
    ): Promise<void> {
        const query = { status: NodeStatus.online };
        if (toNodeId != null) {
            Object.assign(query, { nodeId: toNodeId });
        }
        const onlineNodes = db.nodes().find(query);
        const onlineNodesCount = onlineNodes.length;
        const logMsg = `Sending seeding command to ${onlineNodesCount} NOIA node(s).`;
        if (onlineNodesCount === 0) {
            logger.warn(logMsg);
        } else {
            logger.caching(logMsg);
        }
        const contentSize = await Helpers.getContentSize(contentData);
        for (let onlineNode of onlineNodes) {
            if (config.get(ConfigOption.CachingOnlyToSucceededWebRTC) && onlineNode.connections.webrtc.checkStatus !== "succeeded") {
                continue;
            }

            // Ignore not whitelisted nodes, if whitelisting.
            const whitelist = config.get(ConfigOption.CachingWhitelist);
            if (Array.isArray(whitelist) && whitelist.length > 0 && whitelist[0] !== "*" && !whitelist.includes(onlineNode.ip)) {
                continue;
            }

            // Before actually processing queued item, check and delete unknown contents.
            const wasContentRemoved = await this.pruneContents(onlineNode.nodeId);
            if (wasContentRemoved) {
                const node = db.nodes().findOne({ nodeId: onlineNode.nodeId });
                if (node == null) {
                    logger.caching(`Node node-id=${onlineNode.nodeId} unexpectedly went offline while removing contents...`);
                    continue;
                }
                onlineNode = node;
            }

            // If node is already cached or in progress to cache this content, then skip.
            const thisContent = db.nodesContent().findOne({ nodeId: onlineNode.nodeId, contentId: contentData.contentId });
            if (thisContent != null) {
                logger.caching(`Node node-id=${onlineNode.nodeId} already has content with content-id=${contentData.contentId}.`);
                continue;
            }

            const contentsToRemove: string[] = [];
            const contentsCaching = db.nodesContent().find({ nodeId: onlineNode.nodeId, status: "caching" });
            const contentsCachingSize = await Helpers.getContentsSize(contentsCaching);
            // Available content size + size of contents which can be deleted.
            let usableSize = onlineNode.storage.available - contentsCachingSize;

            if (onlineNode.storage.total < contentSize) {
                logger.caching(
                    `Node node-id=${onlineNode.nodeId} total-storage=${
                        onlineNode.storage.total
                    } < content-size=${contentSize}, content-id=${contentData.contentId}.`
                );
                continue;
            } else if (onlineNode.storage.available < contentSize) {
                const contentsDone = db.nodesContent().find({ nodeId: onlineNode.nodeId, status: "done" });
                const contentsDoneSize = await Helpers.getContentsSize(contentsDone);
                if (contentsDoneSize + usableSize >= contentSize) {
                    const contents: Array<ContentData & LokiObj> = [];
                    for (const nodesContent of contentsDone) {
                        const content = db.files().findOne({ contentId: nodesContent.contentId });
                        if (content != null) {
                            contents.push(content);
                        } else {
                            // TODO: Ask node to delete this unknown content.
                            logger.caching(
                                `Node node-id=${onlineNode.nodeId} is caching unknow content, content-id=${nodesContent.contentId}.`
                            );
                        }
                    }
                    // Sort ASC by content created timestamp.
                    contents.sort((a, b) => {
                        const timestampA = a.meta.updated != null ? a.meta.updated : a.meta.created;
                        const timestampB = b.meta.updated != null ? b.meta.updated : b.meta.created;
                        return timestampA - timestampB;
                    });

                    for (let content = contents.shift(); content != null && contentSize > usableSize; content = contents.shift()) {
                        contentsToRemove.push(content.contentId);
                        logger.caching(`Node node-id=${onlineNode.nodeId} marked content-id=${content.contentId} to be removed.`);
                        usableSize += content.length;
                    }
                } else {
                    logger.caching(
                        `Node node-id=${onlineNode.nodeId} doesn't have space for content with content-id=${contentData.contentId}.`
                    );
                    continue;
                }
            }

            const wire = nodes.getWire(onlineNode.nodeId);
            if (wire == null) {
                logger.error(`Online node node-id=${onlineNode.nodeId} wire went away (1)!`);
                return;
            }

            if (contentsToRemove.length > 0) {
                nodes.getWire(onlineNode.nodeId).clear(contentsToRemove);
                // At this point it is known ahead that these contents should be deleted.
                for (const contentIdToRemove of contentsToRemove) {
                    db.nodesContent().removeWhere({
                        contentId: contentIdToRemove,
                        nodeId: onlineNode.nodeId
                    });
                }
                await Helpers.sleep(config.get(ConfigOption.CachingRemoveDelay));
            }

            if (wire == null) {
                logger.error(`Online node node-id=${onlineNode.nodeId} wire went away (2)!`);
                return;
            }

            // Predict consumed storage.
            onlineNode.storage.available -= contentSize;
            db.nodes().update(onlineNode);

            // Predict that this content will be cached.
            db.nodesContent().upsert(
                {
                    contentId: contentData.contentId,
                    nodeId: onlineNode.nodeId
                },
                {
                    contentId: contentData.contentId,
                    nodeId: onlineNode.nodeId,
                    status: "caching"
                }
            );

            let source: string | null = null;
            if (fromNodeId != null) {
                const node = db.nodes().findOne({ nodeId: fromNodeId });
                if (node == null) {
                    logger.warn(`Source node node-id=${fromNodeId} not found.`);
                    return;
                }
                if (node.connections.webrtc.checkStatus !== "succeeded") {
                    logger.warn(`Source node node-id=${fromNodeId} WebRTC check in progress or failed.`);
                    return;
                }
                source = `http://${node.ip}:${node.connections.webrtc.port}`;
            }

            wire.seed({
                metadata: {
                    source: source,
                    infoHash: contentData.contentId,
                    pieces: contentData.pieces.length
                }
            });

            logger.caching(
                `node-id=${onlineNode.nodeId} received seeding command: content-id=${contentData.contentId}, pieces=${
                    contentData.pieces.length
                }.`
            );
        }
    }
}

export let cache = new Cache();
