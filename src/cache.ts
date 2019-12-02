import * as geolib from "geolib";
import * as fs from "fs";

import { ContentData, contentManager } from "./content-manager";
import { Helpers } from "./helpers";
import { LocationData, Node, NodeStatus } from "./contracts";
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

interface RankWeights {
    distance: number;
    healthScore: number;
    load: number;
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

interface NodeStatistics {
    nodeId: string;
    latitude: number;
    longitude: number;
    healthScore: number;
    loadDownload: number;
    loadUpload: number;
    storageUsable: number;
    distance: number;
    rank: number;
}

interface Operations {
    plusOne(a: number): number;
    minusOne(a: number): number;
}

interface MapObject {
    index: number;
    value: number;
}

interface CentroidObject {
    latitude: number;
    longitude: number;
}

interface StatisticsMapFunction {
    (e: NodeStatistics, i: number): MapObject;
}

interface MapObjectSortFunction {
    (a: MapObject, b: MapObject): number;
}

interface StatisticSortFunction {
    (a: NodeStatistics, b: NodeStatistics): number;
}

interface ContentSortFunction {
    (a: ContentData & LokiObj, b: ContentData & LokiObj): number;
}

interface LoadCounter {
    [s: string]: number;
}

enum LoadType {
    down = "loadDownload",
    up = "loadUpload"
}
enum OperationType {
    plus = "plusOne",
    minus = "minusOne"
}

export enum ReplacementFactor {
    popularity = "popularity",
    scale = "scaleDiff"
}

enum SortOrder {
    asc = "ascending",
    desc = "descending"
}

enum StatisticType {
    healthScore = "healthScore",
    loadDonwload = "loadDownload",
    loadUpload = "loadUpload",
    storageUsable = "storageUsable",
    distance = "distance",
    rank = "rank"
}

export class Cache {
    constructor() {
        setInterval(async () => {
            await this.smartCachingDecisions(ReplacementFactor.scale);
        }, config.get(ConfigOption.CachingRestartInterval) * 1000);
        setInterval(async () => {
            const item = this.queueItems.pop();
            if (item != null) {
                await this.toOnlineNodesRoundRobin(item.contentData, item.nodeId, item.fromNodeId, ReplacementFactor.scale);
                this.changeLoad(item.nodeId, item.fromNodeId, OperationType.minus);
            }
        }, config.get(ConfigOption.CachingInterval) * 1000);
    }

    private queueItems: CachingQueueItem[] = [];

    private operations: Operations = {
        plusOne: a => a++,
        minusOne: a => (a < 0 ? 0 : a--)
    };

    private changeLoadCounter(node: Node, attribute: LoadType, thisOperation: OperationType): void {
        if (node != null) {
            const attributeValue = node[attribute];
            if (attributeValue != null) {
                node[attribute] = this.operations[thisOperation](attributeValue);
                db.nodes().update(node);
            }
        }
    }

    public changeLoad(toNodeId: string | null, fromNodeId: string | null, thisOperation: OperationType): void {
        if (toNodeId) {
            const nodeTo = db.nodes().findOne({ nodeId: toNodeId });
            if (nodeTo != null) {
                this.changeLoadCounter(nodeTo, LoadType.down, thisOperation);
            }
        } else {
            db.nodes().data.forEach(node => {
                this.changeLoadCounter(node, LoadType.down, thisOperation);
            });
        }
        if (fromNodeId) {
            const nodeFrom = db.nodes().findOne({ nodeId: fromNodeId });
            if (nodeFrom != null) {
                this.changeLoadCounter(nodeFrom, LoadType.up, thisOperation);
            }
        }
    }

    /**
     * Queue caching requests.
     */
    public queue(contentData: ContentData, toNodeId: string | null, fromNodeId: string | null): void {
        this.queueItems.push({
            contentData: contentData,
            nodeId: toNodeId,
            fromNodeId: fromNodeId
        });
        this.changeLoad(toNodeId, fromNodeId, OperationType.plus);
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
        try {
            const nodeData = db.nodes().findOne({ nodeId: nodeId });
            if (nodeData == null) {
                logger.error("Called 'updateScore' on invalid node.");
                return;
            }
            const defaultWeights = this.getScoreWeights();
            const scoreWeights: ScoreWeights = {
                bandwidthUploaded:
                    data.bandwidthUploaded != null
                        ? data.bandwidthUploaded
                        : nodeData.bandwidthUpload !== -1
                        ? this.normalizeMetric(MetricName.BandwidthUploaded, nodeData.bandwidthUpload)
                        : 0,
                bandwidthDownloaded:
                    data.bandwidthDownloaded != null
                        ? data.bandwidthDownloaded
                        : nodeData.bandwidthDownload !== -1
                        ? this.normalizeMetric(MetricName.BandwithDownloaded, nodeData.bandwidthDownload)
                        : 0,
                // tslint:disable-next-line:max-line-length
                uptime: data.uptime != null ? data.uptime : 0, // nodeData.uptime  // This field is updated from DataHog and corrupts the data
                latency:
                    data.latency != null
                        ? data.latency
                        : nodeData.latency != null
                        ? this.normalizeMetric(MetricName.Latency, nodeData.latency)
                        : 0,
                storage: data.storage != null ? data.storage : this.normalizeMetric(MetricName.Storage, nodeData.storage.total)
            };
            const updatedScore =
                scoreWeights.bandwidthUploaded * defaultWeights.bandwidthUploaded +
                scoreWeights.bandwidthDownloaded * defaultWeights.bandwidthDownloaded +
                scoreWeights.uptime * defaultWeights.uptime +
                scoreWeights.latency * defaultWeights.storage +
                scoreWeights.storage * defaultWeights.storage;
            nodeData.healthScore = updatedScore;
            db.nodes().upsert({ nodeId: nodeId }, nodeData);
        } catch (err) {
            logger.error("Error in function updateScore:", err);
        }
    }

    /**
     * This function updates mean and variance for a specific parameter in db.settings and returns updated mean and standard deviation.
     * We are using online algorithms to update mean and variance.
     * Very clear derivation can be found at http://datagenetics.com/blog/november22017/index.html.
     */
    private updateMeanVar(metricName: MetricName, metricValue: number, update?: boolean): MeanStDev {
        // Extract parameters from database.
        // mean (mu_n - 1)
        let lastMean = db.settings().view({ key: `${metricName}-mean` }) as number | undefined;
        if (lastMean == null || lastMean === Infinity || lastMean === -Infinity) {
            lastMean = 0;
        }
        // cummulative variance (S_n - 1)
        let lastVar = db.settings().view({ key: `${metricName}-var` }) as number | undefined;
        if (lastVar == null || lastMean === Infinity || lastMean === -Infinity) {
            lastVar = 1;
        }

        const numberOfNodes = db.settings().view({ key: "number-of-nodes" }) as number | undefined;
        if (numberOfNodes == null) {
            throw new Error("Value 'numberOfNodes' is invalid.");
        }

        if (typeof update !== "undefined" && update === true) {
            // Update mean.
            const newMean = lastMean + (metricValue - lastMean) / numberOfNodes;
            // Update variance.
            const newVar = lastVar + (metricValue - lastMean) * (metricValue - newMean);

            // Write parameters into database.
            // mean (mu_n)
            db.settings().set({ key: `${metricName}-mean` }, { key: `${metricName}-mean`, value: newMean });
            // cummulative variance (S_n)
            db.settings().set({ key: `${metricName}-var` }, { key: `${metricName}-var`, value: newVar });

            return { mean: newMean, stdev: Math.sqrt(newVar / numberOfNodes) };
        } else {
            return { mean: lastMean, stdev: Math.sqrt(lastVar / numberOfNodes) };
        }
    }

    public normalizeMetric(metricName: MetricName, metricValue: number, update?: boolean): number {
        const params = this.updateMeanVar(metricName, metricValue, update);
        // With 99% probability the normalized value will be positive.
        const stdNormalAdj = 2.575;
        let sign = 1;
        if (metricName === "latency") {
            sign = -1;
        }
        return (sign * (metricValue - params.mean)) / params.stdev + stdNormalAdj;
    }

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

    private mapFunctionGeneratorStatistics(attribute: StatisticType): StatisticsMapFunction {
        return (e, i) => ({ index: i, value: e[attribute] });
    }

    private sortFunctionGeneratorMapObject(order: SortOrder): MapObjectSortFunction {
        const sOrder = order === "ascending" ? 1 : order === "descending" ? -1 : 0;
        return (a, b) => sOrder * (a.value - b.value);
    }

    private sortStatistics(nodeStatistics: NodeStatistics[], attribute: StatisticType, order: SortOrder): MapObject[] {
        const attributeMap = nodeStatistics.map(this.mapFunctionGeneratorStatistics(attribute));
        attributeMap.sort(this.sortFunctionGeneratorMapObject(order));
        const ranks = attributeMap.map((e, i) => ({ index: e.index, value: i })); // attributeMap.map(mapObject => mapObject.index);
        return ranks;
    }

    private getDownloaderRankWeights(): RankWeights {
        return { distance: 0.4, healthScore: 0.2, load: 0.2, storage: 0.2 };
    }

    private getUploaderRankWeights(): RankWeights {
        return { distance: 0.5, healthScore: 0.2, load: 0.3, storage: 0.0 };
    }

    /**
     * Returns sort function.
     */

    private sortFunctionGeneratorStatistics(attribute: StatisticType, order: SortOrder): StatisticSortFunction {
        const sOrder = order === "ascending" ? 1 : order === "descending" ? -1 : 0;
        return (a, b) => {
            const aAttribute = a[attribute] != null ? a[attribute] : 0;
            const bAttribute = b[attribute] != null ? b[attribute] : 0;
            return sOrder * (aAttribute - bAttribute);
        };
    }

    private sortFunctionGeneratorContents(attribute: ReplacementFactor, order: SortOrder): ContentSortFunction {
        const sOrder = order === "ascending" ? 1 : order === "descending" ? -1 : 0;
        return (a, b) => {
            const aAttribute = a[attribute] != null ? a[attribute] : 0;
            const bAttribute = b[attribute] != null ? b[attribute] : 0;
            return sOrder * (aAttribute - bAttribute);
        };
    }

    private async calculateDistances(nodeStatistics: NodeStatistics[], centroid: CentroidObject): Promise<void> {
        try {
            nodeStatistics.forEach((nodeStat, i, nodeStatArray) => {
                nodeStatArray[i].distance = geolib.getDistance(
                    { latitude: centroid.latitude, longitude: centroid.longitude },
                    { latitude: nodeStat.latitude, longitude: nodeStat.longitude }
                );
            });
        } catch (err) {
            logger.error("CalculateDistances err:", err);
        }
    }

    private async updateLoad(
        nodeId: string,
        nodeStatistics: NodeStatistics[],
        onlineNodes: Node[],
        onlineNodesLoad: LoadCounter,
        loadType: LoadType
    ): Promise<void> {
        try {
            const nodeToStatIdx = nodeStatistics.findIndex(nodeStat => nodeStat.nodeId === nodeId);
            const nodeToData = onlineNodes[onlineNodes.findIndex(onlineNode => onlineNode.nodeId === nodeId)];
            const bandwidthType = loadType === LoadType.down ? "bandwidthDownload" : "bandwidthUpload";
            nodeStatistics[nodeToStatIdx][loadType] = nodeToData[bandwidthType] / (nodeToData[loadType] + onlineNodesLoad[nodeId] + 1);
        } catch (err) {
            logger.error("UpdateLoad err:", err);
        }
    }

    private async autocachingPushToQueue(fileUrl: string, nodeStatistics: NodeStatistics[], copies: number): Promise<void> {
        try {
            if (copies > 0) {
                copies--;
                const nodeTo = nodeStatistics.shift();
                if (nodeTo != null) {
                    contentManager.queueCaching(fileUrl, nodeTo.nodeId, null);
                    logger.caching(`Autocaching ${fileUrl} to node ${nodeTo.nodeId}.`);
                }
                setTimeout(async () => {
                    this.autocachingPushToQueue(fileUrl, nodeStatistics, copies);
                }, config.get(ConfigOption.CachingRestartInterval) * 200);
            } else {
                logger.caching(`Autocaching of ${fileUrl} complete.`);
            }
        } catch (err) {
            logger.error("AutocachingPushToQueue err:", err);
        }
    }

    /**
     * This function is called when content does not exist on the swarm and should be initially cached into a single node.
     */
    public async autocachingDecisions(fileUrl: string, location: LocationData): Promise<void> {
        try {
            const copies = config.get(ConfigOption.CachingInitialCopies);
            const onlineNodes = db
                .nodes()
                .find({ status: NodeStatus.online })
                .filter(node => node.connections.webrtc.checkStatus === "succeeded");
            const nodeStatistics: NodeStatistics[] = [];
            onlineNodes.forEach(async onlineNode => {
                nodeStatistics.push({
                    nodeId: onlineNode.nodeId,
                    latitude: onlineNode.location.latitude,
                    longitude: onlineNode.location.longitude,
                    healthScore: onlineNode.healthScore,
                    loadDownload: onlineNode.loadDownload,
                    loadUpload: 0,
                    storageUsable: onlineNode.storage.total, // NOTE: we want successful cache with the highest probability
                    distance: Infinity,
                    rank: 0
                });
            });
            this.calculateDistances(nodeStatistics, location);
            const nonownersRankHealth = this.sortStatistics(nodeStatistics, StatisticType.healthScore, SortOrder.desc);
            const nonownersRankLoadDw = this.sortStatistics(nodeStatistics, StatisticType.loadDonwload, SortOrder.asc);
            const nonownersRankStorage = this.sortStatistics(nodeStatistics, StatisticType.storageUsable, SortOrder.desc);
            const nonownersRankDistance = this.sortStatistics(nodeStatistics, StatisticType.distance, SortOrder.asc);
            const downloaderRankWeights = this.getDownloaderRankWeights();
            nodeStatistics.forEach(async (noItem, k, noArray) => {
                const rankDistance = nonownersRankDistance.filter(mapObject => mapObject.index === k);
                const rankHealth = nonownersRankHealth.filter(mapObject => mapObject.index === k);
                const rankLoadDw = nonownersRankLoadDw.filter(mapObject => mapObject.index === k);
                const rankStorage = nonownersRankStorage.filter(mapObject => mapObject.index === k);
                noArray[k].rank =
                    downloaderRankWeights.distance * rankDistance[0].value +
                    downloaderRankWeights.healthScore * rankHealth[0].value +
                    downloaderRankWeights.load * rankLoadDw[0].value +
                    downloaderRankWeights.storage * rankStorage[0].value;
            });
            nodeStatistics.sort(this.sortFunctionGeneratorStatistics(StatisticType.rank, SortOrder.asc));
            this.autocachingPushToQueue(fileUrl, nodeStatistics, copies);
        } catch (err) {
            logger.error(err);
        }
    }

    /**
     * This function is called when content should be shared from one node to another.
     */
    public async smartCachingDecisions(factor: ReplacementFactor): Promise<void> {
        const scaleEpsilon = config.get(ConfigOption.CachingScaleEpsilon);
        const loadBound = config.get(ConfigOption.CachingLoadBound);
        const cachingStartTimestamp = Helpers.datetime.time();
        logger.caching(`Smart caching procedure started at ${cachingStartTimestamp}.`);

        try {
            // 1. Get estimated scale differences and sort in descending order
            await contentManager.estimateScale();
            const contents = db.files().find({ popularity: { $gt: 0 } });
            contents.sort(this.sortFunctionGeneratorContents(factor, SortOrder.desc));

            // 2. Construct object array of NodeStatistics
            const nodeStatistics: NodeStatistics[] = [];
            const onlineNodes = db
                .nodes()
                .find({ status: NodeStatus.online })
                .filter(node => node.connections.webrtc.checkStatus === "succeeded");
            for (const onlineNode of onlineNodes) {
                const loadDownload =
                    onlineNode.loadDownload != null && onlineNode.bandwidthDownload != null
                        ? onlineNode.bandwidthDownload / (onlineNode.loadDownload + 1)
                        : 0;
                const loadUpload =
                    onlineNode.loadUpload != null && onlineNode.bandwidthUpload != null
                        ? onlineNode.bandwidthUpload / (onlineNode.loadUpload + 1)
                        : 0;
                const contentsCaching = db.nodesContent().find({ nodeId: onlineNode.nodeId, status: "caching" });
                const contentsCachingSize = await Helpers.getContentsSize(contentsCaching);
                const contentsDone = db.nodesContent().find({ nodeId: onlineNode.nodeId, status: "done" });
                const contentsToRemoveSize = await Helpers.getRemovableContentsSize(contentsDone);
                const usableSize = onlineNode.storage.available - contentsCachingSize;
                nodeStatistics.push({
                    nodeId: onlineNode.nodeId,
                    latitude: onlineNode.location.latitude,
                    longitude: onlineNode.location.longitude,
                    healthScore: onlineNode.healthScore,
                    loadDownload: loadDownload,
                    loadUpload: loadUpload,
                    storageUsable: usableSize + contentsToRemoveSize,
                    distance: Infinity,
                    rank: 0
                });
            }

            // 3. Initialize internal load and storage counters
            const onlineNodesLoadUp: LoadCounter = {};
            for (let j = 0; j < onlineNodes.length; j++) {
                onlineNodesLoadUp[onlineNodes[j].nodeId] = 0;
            }
            const onlineNodesLoadDw: LoadCounter = {};
            for (let j = 0; j < onlineNodes.length; j++) {
                onlineNodesLoadDw[onlineNodes[j].nodeId] = 0;
            }

            // 4. For every content that needs to be scaled up, run smart caching procedure
            for (const content of contents) {
                if (content.scaleDiff != null && content.scaleDiff > scaleEpsilon) {
                    logger.debug(`Processing content ${content.contentSrc} with number of scale difference ${content.scaleDiff}`);
                    // 5. Get centroids of clustered demand locations, sorted in descending order by cluster size. Note: Optics clustering
                    //    algorithm is used, since: 1) it is density based, 2) supports geodedic distance function, 3) returns outliers
                    const locationCentroids = await contentManager.estimateLocality(content.contentId);

                    // 6. Preprocess centroids to match scale differentials
                    let useLocality = true;
                    let centroids = new Array<CentroidObject>();
                    logger.debug(`Processing content ${content.contentSrc} with number of centroids ${locationCentroids.length}`);
                    if (locationCentroids.length === 0) {
                        logger.error(`There's no locality data for ${content.contentSrc}. Smart caching will continue without locality.`);
                        useLocality = false;
                        centroids.push({ latitude: 0, longitude: 0 }); // NOTE: this centroid will not be used, it is only a placeholder
                    } else {
                        const locationCount = locationCentroids.map(c => c.count).reduce((p, c) => p + c);
                        const m = Math.ceil(content.scaleDiff / locationCount);
                        centroids = new Array<CentroidObject>(locationCount * m);
                        let i = 0;
                        for (let j = 0; j < locationCentroids.length; j++) {
                            const step = locationCentroids[j].count * m;
                            centroids.fill(
                                { latitude: locationCentroids[j].latitude, longitude: locationCentroids[j].longitude },
                                i,
                                i + step
                            );
                            i += step;
                        }
                    }

                    // 7. Separate content owners (potential uploaders) and potential downloaders
                    const contentOwnersIds = db
                        .nodesContent()
                        .find({ contentId: content.contentId, status: "done" })
                        .map(nodeContent => nodeContent.nodeId);
                    const contentOwnersCachingIds = db
                        .nodesContent()
                        .find({ contentId: content.contentId, status: "caching" })
                        .map(nodeContent => nodeContent.nodeId);
                    const owners: NodeStatistics[] = [];
                    const nonowners: NodeStatistics[] = [];
                    nodeStatistics.forEach(nodeStat => {
                        if (contentOwnersCachingIds.indexOf(nodeStat.nodeId) === -1) {
                            if (contentOwnersIds.indexOf(nodeStat.nodeId) === -1) {
                                nonowners.push(nodeStat);
                            } else {
                                owners.push(nodeStat);
                            }
                        }
                    });

                    // 8. Sort by multiple statistics
                    const nonownersRankHealth = this.sortStatistics(nonowners, StatisticType.healthScore, SortOrder.desc);
                    const nonownersRankLoadDw = this.sortStatistics(nonowners, StatisticType.loadDonwload, SortOrder.asc);
                    const nonownersRankStorage = this.sortStatistics(nonowners, StatisticType.storageUsable, SortOrder.desc);
                    let nonownersRankDistance = new Array<MapObject>(nonowners.length);
                    const ownersRankHealth = this.sortStatistics(owners, StatisticType.healthScore, SortOrder.desc);
                    const ownersRankLoadUp = this.sortStatistics(owners, StatisticType.loadUpload, SortOrder.asc);
                    let ownersRankDistance = new Array<MapObject>(owners.length);

                    // 9. Run downloader and uploader selection procedure
                    let additionalScaling = content.scaleDiff;
                    let centroidPrevious = null;
                    while (additionalScaling > scaleEpsilon && nonowners.length > 0) {
                        const contentSize = content.contentSize;
                        // 10. If necessary, recalculate distances from centroid
                        const centroid = centroids.shift(); // for no-locality case, only the first time we get centroid, later null
                        if (centroid === centroidPrevious) {
                            // do nothing
                        } else if (centroid != null) {
                            if (useLocality === true && centroid != null) {
                                this.calculateDistances(nonowners, centroid);
                                nonownersRankDistance = this.sortStatistics(nonowners, StatisticType.distance, SortOrder.asc);
                                ownersRankDistance = this.sortStatistics(owners, StatisticType.distance, SortOrder.asc);
                                centroidPrevious = centroid;
                            }

                            // 11. Calculate aggregate score (rank) of nonowner and owner nodes, sort them in ascending order by this rank
                            const downloaderRankWeights = this.getDownloaderRankWeights();
                            nonowners.forEach(async (noItem, k, noArray) => {
                                let rankDistance: MapObject[] = [{ index: 0, value: 0 }];
                                if (useLocality === true) {
                                    rankDistance = nonownersRankDistance.filter(mapObject => mapObject.index === k);
                                }
                                const rankHealth = nonownersRankHealth.filter(mapObject => mapObject.index === k);
                                const rankLoadDw = nonownersRankLoadDw.filter(mapObject => mapObject.index === k);
                                const rankStorage = nonownersRankStorage.filter(mapObject => mapObject.index === k);
                                noArray[k].rank =
                                    downloaderRankWeights.distance * rankDistance[0].value +
                                    downloaderRankWeights.healthScore * rankHealth[0].value +
                                    downloaderRankWeights.load * rankLoadDw[0].value +
                                    downloaderRankWeights.storage * rankStorage[0].value;
                            });
                            nonowners.sort(this.sortFunctionGeneratorStatistics(StatisticType.rank, SortOrder.asc));

                            const uploaderRankWeights = this.getUploaderRankWeights();
                            owners.forEach(async (oItem, k, oArray) => {
                                let rankDistance: MapObject[] = [{ index: 0, value: 0 }];
                                if (useLocality === true) {
                                    rankDistance = ownersRankDistance.filter(mapObject => mapObject.index === k);
                                }
                                const rankHealth = ownersRankHealth.filter(mapObject => mapObject.index === k);
                                const rankLoadUp = ownersRankLoadUp.filter(mapObject => mapObject.index === k);
                                oArray[k].rank =
                                    uploaderRankWeights.distance * rankDistance[0].value +
                                    uploaderRankWeights.healthScore * rankHealth[0].value +
                                    uploaderRankWeights.load * rankLoadUp[0].value;
                            });
                            owners.sort(this.sortFunctionGeneratorStatistics(StatisticType.rank, SortOrder.asc));
                        }

                        // 12. Select the downloader node
                        let nodeTo = null;
                        while (nodeTo == null && nonowners.length > 0) {
                            nodeTo = nonowners.shift();
                            if (nodeTo != null) {
                                const nodeToLoad = nodeTo.loadDownload;
                                if (nodeToLoad < loadBound) {
                                    logger.warn(`${nodeTo.nodeId} has too low bandwidth at ${nodeToLoad} per download`);
                                    nodeTo = null;
                                    continue;
                                } else if (nodeTo.storageUsable < contentSize) {
                                    logger.warn(
                                        // tslint:disable-next-line:max-line-length
                                        `${nodeTo.nodeId} does not have enough usable storage ${nodeTo.storageUsable} for file of ${contentSize}`
                                    );
                                    nodeTo = null;
                                    continue;
                                }
                            }
                        }

                        // 13. Select the uploader node
                        let nodeFrom = null;
                        while (nodeFrom == null && owners.length > 0) {
                            nodeFrom = owners.shift();
                            if (nodeFrom != null) {
                                const nodeToLoad = nodeFrom.loadUpload;
                                if (nodeToLoad < loadBound) {
                                    logger.warn(`${nodeFrom.nodeId} has too low bandwidth at ${nodeToLoad} per upload`);
                                    nodeFrom = null;
                                    continue;
                                } else {
                                    owners.push(nodeFrom); // with enough upload bandwidth it can upload content more times
                                }
                            }
                        }

                        // 14. Push new caching job into the job queue
                        if (nodeTo != null && nodeFrom != null) {
                            contentManager.queueCaching(content.contentSrc, nodeTo.nodeId, nodeFrom.nodeId);
                            logger.caching(
                                // tslint:disable-next-line:max-line-length
                                `Content ${content.contentSrc} pushed into caching queue from node ${nodeFrom.nodeId} to node ${nodeTo.nodeId}.`
                            );
                            additionalScaling--;

                            // 15. Update load and storage statistics of selected nodes
                            const nodeToId = nodeTo.nodeId;
                            onlineNodesLoadDw[nodeToId]++;
                            this.updateLoad(nodeToId, nodeStatistics, onlineNodes, onlineNodesLoadDw, LoadType.down);
                            nodeStatistics[nodeStatistics.findIndex(stat => stat.nodeId === nodeToId)].storageUsable -= content.contentSize;

                            const nodeFromId = nodeFrom.nodeId;
                            onlineNodesLoadUp[nodeFromId]++;
                            this.updateLoad(nodeFromId, nodeStatistics, onlineNodes, onlineNodesLoadUp, LoadType.up);
                        } else if (nodeTo != null && nodeFrom == null) {
                            contentManager.queueCaching(content.contentSrc, nodeTo.nodeId, null);
                            logger.caching(
                                `Content ${content.contentSrc} pushed into caching queue from Master node to node ${nodeTo.nodeId}.`
                            );
                            additionalScaling--;

                            // 15. Update load and storage statistics of selected nodes
                            const nodeToId = nodeTo.nodeId;
                            onlineNodesLoadDw[nodeToId]++;
                            this.updateLoad(nodeToId, nodeStatistics, onlineNodes, onlineNodesLoadDw, LoadType.down);
                            nodeStatistics[nodeStatistics.findIndex(stat => stat.nodeId === nodeToId)].storageUsable -= content.contentSize;
                        }
                    }
                } else if (content.scaleDiff != null && content.scaleTarget != null && content.scaleTarget >= 1 && content.scaleDiff <= 0) {
                    // Check if file is still master storage. If yes, delete it from master storage
                    fs.access(content.file, fs.constants.F_OK, existanceError => {
                        if (existanceError) {
                            // do nothing
                        } else {
                            // delete content
                            fs.unlink(content.file, deletionError => {
                                if (deletionError) {
                                    logger.error(`Unable to delete file ${content.file}!`);
                                } else {
                                    logger.caching(`File ${content.contentSrc} deleted from local master storage.`);
                                }
                            });
                        }
                    });
                }
            }
        } catch (err) {
            logger.error(err);
        }

        logger.caching(`Caching procedure finished in ${Helpers.datetime.time(cachingStartTimestamp)} seconds.`);

        return;
    }

    /**
     * Send cache request to all or one online nodes with content popularity or age based replacement strategy.
     */
    private async toOnlineNodesRoundRobin(
        contentData: ContentData,
        /**
         * Cache to all nodes if nodeId is null.
         */
        toNodeId: string | null,
        /**
         * If not null, caches from particular node id. If null, caches from master.
         */
        fromNodeId: string | null,
        factor: ReplacementFactor
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
        const contentSize = contentData.contentSize;
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
                    // tslint:disable-next-line:max-line-length
                    `Node node-id=${onlineNode.nodeId} total-storage=${onlineNode.storage.total} < content-size=${contentSize}, content-id=${contentData.contentId}.`
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
                            contentsToRemove.push(nodesContent.contentId);
                            logger.caching(
                                `Node node-id=${onlineNode.nodeId} is caching unknow content, content-id=${nodesContent.contentId}.`
                            );
                        }
                    }
                    // Sort ASC by factor: popularity or scaleDiff.
                    contents.sort(this.sortFunctionGeneratorContents(factor, SortOrder.asc));

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

            // Allow 5 times lower avg download speed than foreseen while calculating avg load (bytes/s) per each download job
            setTimeout(() => {
                const downloadStatus = db.nodesContent().findOne({ contentId: contentData.contentId, nodeId: onlineNode.nodeId });
                if (downloadStatus != null && downloadStatus.status === "caching") {
                    db.nodesContent().remove(downloadStatus);
                    logger.caching(`Upload of ${contentData.contentId} to node id=${onlineNode.nodeId} treated as failed`);
                }
            }, 1000 * config.get(ConfigOption.CachingLoadBound) * 5);

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
                    pieces: contentData.pieces.length,
                    piecesIntegrity: contentData.piecesIntegrity
                }
            });

            logger.caching(
                // tslint:disable-next-line:max-line-length
                `node-id=${onlineNode.nodeId} received seeding command: content-id=${contentData.contentId}, pieces=${contentData.pieces.length}.`
            );
        }
    }
}

export let cache = new Cache();
