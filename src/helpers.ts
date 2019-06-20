import * as createTorrent from "create-torrent";
import * as http from "http";
import * as sha1 from "sha1";

import { NodeContentData } from "./nodes";
import { config, ConfigOption } from "./config";
import { db } from "./db";
import { logger } from "./logger";

interface TorrentOptions {
    name: string;
    announceList: string[][];
}

export namespace Helpers {
    /**
     * Get contents size in bytes
     */
    export async function getContentsSize(nodesContentData: Array<NodeContentData & LokiObj>): Promise<number> {
        let accSize = 0;
        if (nodesContentData != null) {
            for (const nodeContentData of nodesContentData) {
                const contentData = db.files().findOne({ contentId: nodeContentData.contentId });
                if (contentData != null && contentData.contentSize) {
                    accSize += contentData.contentSize;
                }
            }
        }
        return accSize;
    }

    export async function getRemovableContentsSize(contentsDone: NodeContentData[]): Promise<number> {
        // const contentsInCache: Array<ContentData & LokiObj> = [];
        let accSize = 0;
        for (const contentDone of contentsDone) {
            const contentData = db.files().findOne({ contentId: contentDone.contentId });
            if (contentData != null && contentData.scaleDiff < 0 && contentData.contentSize != null) {
                accSize += contentData.contentSize;
            }
        }
        return accSize;
    }

    /**
     * Generates different hash for encrypted and plain text sources.
     */
    export function getContentIdentifier(src: string): string {
        return config.get(ConfigOption.ContentEncryptionIsEnabled)
            ? sha1(
                  (src + config.get(ConfigOption.ContentEncryptionSecretSalt))
                      .split("")
                      .reverse()
                      .join("")
              )
            : sha1(src);
    }

    /**
     * Sleep simulation.
     */
    export async function sleep(seconds: number): Promise<void> {
        return new Promise<void>(resolve => setTimeout(resolve, seconds * 1000));
    }

    /**
     * Since it is not required for node to have airdrop address, node id should be used as fallback.
     */
    export function getNodeUid(metadata: { airdropAddress: string | null; nodeId: string }): string {
        if (metadata.airdropAddress != null) {
            return metadata.airdropAddress;
        } else {
            return metadata.nodeId;
        }
    }

    export function noop(): void {
        // No operation.
    }

    // On some machines using buffer instead of file path unexpectedly crashed without any ouput.
    export async function createTorrentPromise(filePath: string, options: TorrentOptions): Promise<Buffer> {
        return new Promise<Buffer>((resolve, reject) => {
            createTorrent(filePath, options, async (err: Error, torrentBuffer: Buffer) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(torrentBuffer);
            });
        });
    }

    export function randomString(len: number = 5): string {
        let text = "";
        const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        for (let i = 0; i < len; i += 1) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    export function getIp(req: http.IncomingMessage): string | undefined {
        if (req.connection.remoteAddress == null) {
            logger.error("Could not determine remote address!");
            return undefined;
        }
        return req.connection.remoteAddress.replace(/^::ffff:/, "");
    }

    export function binaryToHex(str: string): string {
        if (typeof str !== "string") {
            str = String(str);
        }
        return Buffer.from(str, "binary").toString("hex");
    }

    export function hexToBinary(str: string): string {
        if (typeof str !== "string") {
            str = String(str);
        }
        return Buffer.from(str, "hex").toString("binary");
    }

    export let datetime = {
        time: (time?: number): number => {
            const now = Math.floor((Date.now() / 1000) | 0);
            if (time != null && time > 0) {
                return now - time;
            }
            return now;
        },

        timeDiff: (timestampTo: number, timestampFrom: number): number => Math.floor(timestampTo - timestampFrom) || 0,
        secondsToString: (miliseconds: number): string => {
            const numdays = Math.floor(miliseconds / (24 * 60 * 60 * 1000));
            const numhours = Math.floor((miliseconds / (1000 * 60 * 60)) % 24);
            const numminutes = Math.floor((miliseconds / (1000 * 60)) % 60);
            const numseconds = Math.floor((miliseconds / 1000) % 60);

            let text = "";
            if (numdays > 0) {
                text = `${numdays}days `;
            }
            if (numhours > 0) {
                text = `${text + numhours}hours `;
            }
            if (numminutes) {
                text = `${text + numminutes}mins `;
            }
            if (numseconds) {
                text = `${text + numseconds}secs`;
            }

            return text;
        }
    };
}
