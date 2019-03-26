import * as EventEmitter from "events";
import * as fs from "fs-extra";
import * as parseTorrent from "parse-torrent";
import * as path from "path";
import * as FSChunkStore from "fs-chunk-store";
import * as sha1 from "sha1";
import StrictEventEmitter from "strict-event-emitter-types";

import { db } from "./db";
import { ipfs } from "./content-protocols/ipfs";
import { logger } from "./logger";
import { url } from "./content-protocols/url";
import { Helpers } from "./helpers";
import { TorrentData } from "./contracts";
import { config, ConfigOption } from "./config";
import { Store } from "./nodes";
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

export interface ContentData extends TorrentData {
    type: Protocol;
}

const STORAGE_DIR = path.resolve("./storage/");
const CONTENT_DIR = path.resolve(path.join("./storage/", "content"));
const MILISECONDS_IN_A_WEEK = 7 * 24 * 60 * 60 * 1000;

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
    private activeDownloads: number = 0;
    private downloadQueue: string[] = [];

    public async setup(): Promise<void> {
        await fs.ensureDir(this.settings.dir.storage);
        await fs.ensureDir(this.settings.dir.content);
    }

    private getProtocol(data: string): Protocol {
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

    public updatePopularity(srcHash: string, timestamp: number): void {
        const timeWindow = Math.ceil(
            MILISECONDS_IN_A_WEEK / Math.log10((db.settings().view({ key: "dynamic-request-count" }) as number) + 10)
        );
        db.contentPopularity().shift({ contentId: srcHash }, timestamp, timeWindow);
        logger.debug(`Content popularity for ${srcHash}=${db.contentPopularity().contentScore(srcHash)}.`);
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

        for (const piece of torrentData.pieces) {
            const pieceIndex = torrentData.pieces.indexOf(piece);
            const dataBuf = await getPieceDataBuff(fsChunkStore, pieceIndex);
            const encryptedDataBuf = encryption.encrypt(encryption.getSecretKey(torrentData.contentId), dataBuf, torrentData.contentId);
            const encryptedPieceDigest = sha1(encryptedDataBuf);

            torrentData.piecesIntegrity.push(encryptedPieceDigest);
        }

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
            logger.info(`Processing first download queue item of ${this.downloadQueue.length} total items.`);

            const source = this.downloadQueue.shift();
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
                logger.caching(`Skipped downloading of content-src=${filteredSource} content-id=${contentId}.`);
                skipDownload = true;
            }

            try {
                if (!skipDownload) {
                    const dataBuffer = await protocols[protocol].download(filteredSource);
                    await this.writeFileToDisk(dataBuffer, filteredSource);
                    const torrentData = await this.createTorrent(filteredSource);
                    contentData = Object.assign(torrentData, { type: protocol });
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
                    const msg = `Failed to download content-src=${filteredSource}, reason='${err.message}'.`;
                    logger.warn(msg);
                    reject(msg);
                } else {
                    logger.error("Error has occured while handling active downloads:", err);
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
