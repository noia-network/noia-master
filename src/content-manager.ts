import EventEmitter from "events";
import geolib from "geolib";
import fs from "fs-extra";
import clustering from "density-clustering";
import parseTorrent from "parse-torrent";
import path from "path";
import FSChunkStore from "fs-chunk-store";
import sha1 from "sha1";
import StrictEventEmitter from "strict-event-emitter-types";

import { db } from "./db";
import { ipfs } from "./content-protocols/ipfs";
import { logger } from "./logger";
import { url } from "./content-protocols/url";
import { Helpers } from "./helpers";
import { CentroidLocationData, LocationData, TorrentData, NodeStatus } from "./contracts";
import { config, ConfigOption } from "./config";
import { nodes, Store } from "./nodes";
import { encryption } from "./encryption";
const protocols = {
    url,
    ipfs
};

interface Settings {
    maxDownloads: number;
    dir: {
        storage: string;
        content: string;
    };
}

interface Options {
    maxDownloads?: number;
    dir?: {
        storage?: string;
    };
}

export enum Protocol {
    url = "url",
    ipfs = "ipfs"
}

export enum ClusteringAlgorithm {
    dbscan = "dbscan",
    kmeans = "kmeans",
    optics = "optics"
}

export interface ContentData extends TorrentData {
    popularity: number;
    scaleTarget?: number | null;
    scaleActual?: number | null;
    scaleDiff: number;
    type: Protocol;
}

const STORAGE_DIR = path.resolve("./storage/");
const CONTENT_DIR = path.resolve(path.join("./storage/", "content"));
const MILISECONDS_IN_A_MONTH = 30 * 24 * 60 * 60 * 1000;
const CLUSTER_EPS = 10; // 10 degrees ~=1100 km
const CLUSTER_MIN_PTS = 2; // minimum 2 points can form a cluster, however, unassigned points are 'clusters' on their own

interface ContentManagerEvents {
    finished: (this: ContentManager) => this;
    cache: (this: ContentManager, contentData: ContentData, toNodeId: string | null, fromNodeId: string | null) => this;
}

const ContentManagerEmitter: { new (): StrictEventEmitter<EventEmitter, ContentManagerEvents> } = EventEmitter;

export class ContentManager extends ContentManagerEmitter {
    constructor(options: Options = {}) {
        super();
        this.settings = Object.assign(
            {
                maxDownloads: config.get(ConfigOption.CachingMaxDownloads),
                dir: {
                    storage: STORAGE_DIR,
                    content: CONTENT_DIR
                }
            },
            options
        );
    }

    private settings: Settings;
    public activeDownloads: number = 0;
    private downloadQueue: string[] = [];

    public async setup(): Promise<void> {
        await fs.ensureDir(this.settings.dir.storage);
        await fs.ensureDir(this.settings.dir.content);
    }

    public getProtocol(data: string): Protocol {
        if (data.includes("ipfs:")) {
            return Protocol.ipfs;
        }
        return Protocol.url;
    }

    private getExtension(str: string): string {
        const regex = /[#\\?]/g;
        let extname = path.extname(str);
        const endOfExt = extname.search(regex);
        if (endOfExt > -1) {
            extname = extname.substring(0, endOfExt);
        }
        return extname;
    }

    private arrayMax(array: number[]): number {
        // Math.max() cannot handle big arrays and produces RangeError
        let len = array.length;
        let max = -Infinity;
        while (len--) {
            if (array[len] > max) {
                max = array[len];
            }
        }
        return max;
    }

    public getTimeWindow(): number {
        return Math.ceil(MILISECONDS_IN_A_MONTH / Math.log10((db.settings().view({ key: "dynamic-request-count" }) as number) + 10));
    }

    public updatePopularity(srcHash: string, timestamp: number, location: LocationData): void {
        db.contentPopularity().shift({ contentId: srcHash }, timestamp, this.getTimeWindow(), location);
    }

    public async estimateScale(): Promise<void> {
        db.contentPopularity().prune(this.getTimeWindow());
        const initialCopies = config.get(ConfigOption.CachingInitialCopies);
        const nContent = db.files().data.length;
        const onlineNodes = db.nodes().find({ status: { $eq: NodeStatus.online } });
        let maxScale = onlineNodes.filter(node => node.connections.webrtc.checkStatus === "succeeded").length;
        let totalNetworkStorage = 0;
        db.nodes().data.forEach(node => {
            totalNetworkStorage += node.storage.total;
        });
        // pre-allocate variables
        const contentSizeArray = new Array<number>(nContent);
        const popularityArray = new Array<number>(nContent);
        const scaleActualArray = new Array<number>(nContent);
        const scaleTargetArray = new Array<number>(nContent);
        const scaleDiffArray = new Array<number>(nContent);
        // retrieve content copularity and actual scale (including pending m2n/n2n downloads)
        let fileIndex = 0;
        db.files().data.forEach(file => {
            contentSizeArray[fileIndex] = file.contentSize;
            popularityArray[fileIndex] = db.contentPopularity().contentScore(file.contentId);
            scaleActualArray[fileIndex] = db.nodesContent().count({ contentId: file.contentId });
            fileIndex++;
        });
        // estimate target scale
        const maxPopularity = this.arrayMax(popularityArray);
        let maxStorageUsed = Infinity;
        while (maxStorageUsed > totalNetworkStorage) {
            const popToScaleFactor = maxScale / maxPopularity;
            maxStorageUsed = 0;
            for (let i = 0; i < nContent; i++) {
                if (contentSizeArray[i] && popularityArray[i] != null && popularityArray[i] > 0) {
                    scaleTargetArray[i] = Math.max(Math.round(popToScaleFactor * popularityArray[i]), initialCopies);
                    maxStorageUsed += scaleTargetArray[i] * contentSizeArray[i];
                } else {
                    scaleTargetArray[i] = 0;
                }
            }
            maxScale--;
            if (maxScale < 0) {
                break;
            }
        }
        // find scale difference and write data to files db
        fileIndex = 0;
        db.files().data.forEach(file => {
            if (scaleTargetArray[fileIndex] != null) {
                scaleDiffArray[fileIndex] = scaleTargetArray[fileIndex] - scaleActualArray[fileIndex];
            } else {
                scaleDiffArray[fileIndex] = 0;
            }
            file.popularity = popularityArray[fileIndex];
            file.scaleActual = scaleActualArray[fileIndex];
            file.scaleTarget = scaleTargetArray[fileIndex];
            file.scaleDiff = scaleDiffArray[fileIndex];
            db.files().update(file);
            fileIndex++;
        });
    }

    public geoDistanceWrap(coordinateA: number[], coordinateB: number[]): number {
        return geolib.getDistance(
            { latitude: coordinateA[0], longitude: coordinateA[1] },
            { latitude: coordinateB[0], longitude: coordinateB[1] }
        );
    }

    public async estimateLocality(
        contentId: string,
        algorithm: ClusteringAlgorithm = ClusteringAlgorithm.optics
    ): Promise<CentroidLocationData[]> {
        const centroids: CentroidLocationData[] = [];
        const data: number[][] = [];
        const popularityData = db.contentPopularity().findOne({ contentId: contentId });
        if (popularityData != null) {
            if (popularityData.dataLocality == null) {
                db.contentPopularity().remove(popularityData);
            } else {
                const uniqueCountryCodes = new Set<string>();
                let res: number[][] = [];
                popularityData.dataLocality.forEach(location => {
                    if (location.countryCode !== "") {
                        uniqueCountryCodes.add(location.countryCode);
                        data.push([location.latitude, location.longitude]);
                    }
                });
                switch (algorithm) {
                    case "optics":
                        const optics = new clustering.OPTICS();
                        res = optics.run(data, CLUSTER_EPS, CLUSTER_MIN_PTS, this.geoDistanceWrap);
                        break;
                    case "dbscan":
                        const dbscan = new clustering.DBSCAN();
                        res = dbscan.run(data, CLUSTER_EPS, CLUSTER_MIN_PTS, this.geoDistanceWrap);
                        break;
                    case "kmeans":
                        const nClusters = uniqueCountryCodes.size;
                        const kmeans = new clustering.KMEANS();
                        res = kmeans.run(data, nClusters);
                        break;
                }
                for (const clusterDataIds of res) {
                    const clusterData: geolib.PositionAsDecimal[] = [];
                    for (const dataId of clusterDataIds) {
                        clusterData.push({ latitude: data[dataId][0], longitude: data[dataId][1] });
                    }
                    const centroid = geolib.getCenter(clusterData);
                    const centroidLocation: CentroidLocationData = {
                        latitude: centroid.latitude,
                        longitude: centroid.longitude,
                        count: clusterDataIds.length,
                        countryCode: "",
                        city: ""
                    };
                    centroids.push(centroidLocation);
                }
                centroids.sort((a, b) => (b.count != null && a.count != null ? (b.count < a.count ? -1 : 1) : 0));
            }
        }
        return centroids;
    }

    public async createTorrent(fileUrlOrInfoHash: string): Promise<TorrentData> {
        const filePath = path.resolve(
            path.join(
                this.settings.dir.content,
                `${Helpers.getContentIdentifier(fileUrlOrInfoHash)}${this.getExtension(fileUrlOrInfoHash)}`
            )
        );
        const torrentBuffer = await Helpers.createTorrentPromise(filePath, {
            name: path.basename(fileUrlOrInfoHash),
            announceList: [[]]
        });
        const parsedTorrentData = parseTorrent(torrentBuffer);

        const torrentData: TorrentData = {
            contentId: Helpers.getContentIdentifier(fileUrlOrInfoHash),
            contentSrc: fileUrlOrInfoHash,
            contentSize: 0,
            encrypt: config.get(ConfigOption.ContentEncryptionIsEnabled),
            file: filePath,
            files: parsedTorrentData.files,
            infoHash: parsedTorrentData.infoHash,
            length: parsedTorrentData.length,
            name: parsedTorrentData.name,
            pieceLength: parsedTorrentData.pieceLength,
            pieces: parsedTorrentData.pieces,
            piecesIntegrity: [],
            urlList: parsedTorrentData.urlList
        };

        const fsChunkStore: Store = FSChunkStore(torrentData.pieceLength, {
            path: torrentData.file,
            length: torrentData.length
        });

        let contentSize = 0;
        for (const piece of torrentData.pieces) {
            const pieceIndex = torrentData.pieces.indexOf(piece);
            const dataBuf = await getPieceDataBuff(fsChunkStore, pieceIndex);
            const encryptedDataBuf = encryption.encrypt(encryption.getSecretKey(torrentData.contentId), dataBuf, torrentData.contentId);
            const encryptedPieceDigest = sha1(encryptedDataBuf);
            const pieceSize = await storeContentGetPieceLength(fsChunkStore, torrentData, pieceIndex);
            contentSize += pieceSize;
            torrentData.piecesIntegrity.push(encryptedPieceDigest);
        }
        torrentData.contentSize = contentSize;

        async function getPieceDataBuff(store: Store, piece: number): Promise<Buffer> {
            return new Promise<Buffer>((resolve, reject) => {
                store.get(piece, (err: Error, dataBuf: Buffer) => {
                    if (err != null) {
                        reject(err);
                    }
                    resolve(dataBuf);
                });
            });
        }

        async function storeContentGetPieceLength(store: Store, content: TorrentData, pieceIndex: number): Promise<number> {
            return new Promise<number>((resolve, reject) => {
                store.get(pieceIndex, (err: Error, dataBuf: Buffer) => {
                    if (err != null) {
                        reject(err);
                        return;
                    }
                    const pieceLength = 4;
                    const contentIdLength = 20;
                    resolve(
                        nodes.createResponseBuffer(content.contentId, content.encrypt, pieceIndex, dataBuf).length -
                            (pieceLength + contentIdLength)
                    );
                });
            });
        }

        return torrentData;
    }

    public async writeFileToDisk(urlOrContent: string | Buffer, fileUrlOrInfoHash: string): Promise<void> {
        const fileDir = path.resolve(this.settings.dir.content);
        const filePath = path.join(fileDir, `${Helpers.getContentIdentifier(fileUrlOrInfoHash)}${this.getExtension(fileUrlOrInfoHash)}`);
        await fs.ensureDir(fileDir);
        await fs.writeFile(filePath, urlOrContent);
        logger.info(`Saved downloaded content to disk: filtered-source=${fileUrlOrInfoHash}, file-path=${filePath}.`);
    }

    public filterSource(source: string): string {
        source = source.replace("ipfs:", "");
        return source;
    }

    /**
     * Save content on master hard disk and send caching request to node(s).
     */
    private async internalDownload(
        /**
         * If nodeId is supplied, then send caching request to single online node.
         */
        nodeId: string | null,
        fromNodeId: string | null
    ): Promise<void> {
        return new Promise<void>(async (resolve, reject) => {
            if (this.downloadQueue.length === 0) {
                logger.info("Download queue finished processing queued items.");
                resolve();
                return;
            }
            if (this.activeDownloads >= this.settings.maxDownloads) {
                const msg = `Download queue items limit of max ${this.settings.maxDownloads} total items has been exceeded.`;
                logger.warn(msg);
                reject(new Error(msg));
                return;
            }

            const source = this.downloadQueue.shift();

            logger.info(`Processing first download queue item of ${this.downloadQueue.length} total itemsm src=${source}.`);

            if (source == null) {
                logger.error("Internal download race condition.");
                return;
            }
            const protocol = this.getProtocol(source);
            this.activeDownloads++;

            const filteredSource = this.filterSource(source);

            let skipDownload = false;
            const contentId = Helpers.getContentIdentifier(filteredSource);
            let contentData: ContentData = db.files().findOne({ contentId: contentId }) as ContentData;
            if (contentData != null) {
                try {
                    fs.accessSync(contentData.file, fs.constants.F_OK);
                    logger.caching(`Skipped downloading of content-src=${filteredSource} content-id=${contentId}.`);
                    skipDownload = true;
                } catch (existanceError) {
                    logger.verbose(existanceError);
                }
            }

            try {
                if (!skipDownload) {
                    const dataBuffer = await protocols[protocol].download(filteredSource);
                    if (dataBuffer) {
                        await this.writeFileToDisk(dataBuffer, filteredSource);
                    }
                    const torrentData = await this.createTorrent(filteredSource);
                    contentData = Object.assign(torrentData, { type: protocol, popularity: 0, scaleDiff: 0 });
                }

                this.emit("cache", contentData, nodeId, fromNodeId);
                if (this.downloadQueue.length === 0) {
                    this.emit("finished");
                }
                if (fromNodeId == null) {
                    await this.internalDownload(nodeId, null);
                }
                resolve();
            } catch (err) {
                if (err.type === "max-size") {
                    const msg = `Failed to download content-src=${filteredSource}, skip-download=${skipDownload}, reason='${err.message}'.`;
                    logger.warn(msg);
                    reject(msg);
                } else {
                    logger.error(`Error has occured while handling active downloads, skip-download=${skipDownload}:`, err);
                    logger.error(err);
                    console.error(err);
                    if (fromNodeId == null) {
                        await this.internalDownload(nodeId, null);
                    }
                    resolve();
                }
            } finally {
                this.activeDownloads--;
            }
        });
    }

    /**
     * Queue and initiate caching process.
     */
    public async queueCaching(fileUrl: string, nodeId: string | null, fromNodeId: string | null): Promise<void> {
        if (this.downloadQueue.indexOf(fileUrl) !== -1) {
            return logger.warn("Downloading is already in progress...");
        }
        this.downloadQueue.push(fileUrl);
        await this.internalDownload(nodeId, fromNodeId);
    }
}

export let contentManager = new ContentManager();
