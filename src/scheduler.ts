import * as child_process from "child_process";
import * as path from "path";
import * as util from "util";
const exec = util.promisify(child_process.exec);

import { WebRtcCheckResult } from "./scripts/webrtc-checker";
import { config, ConfigOption } from "./config";
import { logger } from "./logger";

interface Item {
    nodeId: string;
    ip: string;
    port: number;
    candidateIp: string;
    status: "not-processed" | "in-progress" | "failure" | "success" | "error";
    callbacks: Array<(result: WebRtcCheckResult) => void>;
    errors: Array<(err: Error) => void>;
}

class Scheduler {
    constructor() {
        setInterval(async () => {
            const item = this.getNotProcessedItem();
            if (item != null) {
                // console.info(`Processing node-id=${item[1].nodeId}...`);
                logger.info(`WebRTC checking item-id=${item[1].nodeId} item-ip=${item[1].ip}.`);
                item[1].status = "in-progress";
                try {
                    const execOutput = await exec(
                        `ts-node ${path.resolve(__dirname, "scripts/webrtc-checker.ts")} ${this.constructArgs(
                            item[1].nodeId,
                            item[1].ip,
                            item[1].port,
                            item[1].candidateIp
                        )}`
                    );
                    item[1].status = "failure";
                    const result: WebRtcCheckResult = JSON.parse(execOutput.stdout);
                    item[1].callbacks.forEach(callback => {
                        callback(result);
                    });
                    this.queue.delete(item[0]);
                } catch (err) {
                    item[1].status = "error";
                    item[1].callbacks.forEach(error => {
                        error(err);
                    });
                    this.queue.delete(item[0]);
                }
            }
        }, config.get(ConfigOption.WebRtcCheckSchedulerInterval) * 1000);
    }

    public queue: Map<string, Item> = new Map();

    public getNotProcessedItem(): [string, Item] | null {
        const whitelist = config.get(ConfigOption.CachingWhitelist);
        if (Array.isArray(whitelist) && whitelist.length > 0 && whitelist[0] !== "*") {
            for (const item of this.queue.entries()) {
                if (item[1].status === "not-processed" && whitelist.includes(item[1].ip)) {
                    return item;
                }
            }
        }
        for (const item of this.queue.entries()) {
            if (item[1].status === "not-processed") {
                return item;
            }
        }
        return null;
    }

    public async process(nodeId: string, ip: string, port: number, candidateIp: string): Promise<WebRtcCheckResult> {
        return new Promise<WebRtcCheckResult>((resolve, reject) => {
            if (this.queue.has(nodeId)) {
                const item = this.queue.get(nodeId)!;
                item.callbacks.push((result: WebRtcCheckResult) => {
                    resolve(result);
                });
                item.errors.push(err => {
                    reject(err);
                });
            } else {
                this.queue.set(nodeId, {
                    nodeId: nodeId,
                    ip: ip,
                    port: port,
                    candidateIp: candidateIp,
                    status: "not-processed",
                    callbacks: [
                        (result: WebRtcCheckResult) => {
                            resolve(result);
                        }
                    ],
                    errors: [
                        err => {
                            reject(err);
                        }
                    ]
                });
            }
        });
    }

    private constructArgs(nodeId: string, ip: string, port: number, candidateIp: string): string {
        return `${nodeId} ${ip} ${port} ${candidateIp}`;
    }
}

export let scheduler = new Scheduler();
