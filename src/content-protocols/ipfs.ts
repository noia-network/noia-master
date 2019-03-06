// tslint:disable
import * as EventEmitter from "events";
import * as fs from "fs";
import * as path from "path";

import { config, ConfigOption } from "../config";
import { logger } from "../logger";

const ipfsApi = require("ipfs");

class IPFS extends EventEmitter {
    constructor() {
        super();
    }

    public storage: any;
    public dir_content: any;
    public node: any;

    public async setup(): Promise<void> {
        logger.info("Starting IPFS.");

        this.storage = path.join(config.get(ConfigOption.StorageDir), "ipfs");
        this.dir_content = path.join(config.get(ConfigOption.StorageDir), "ipfs", "content");

        if (!fs.existsSync(path.join(config.get(ConfigOption.StorageDir)))) {
            fs.mkdirSync(config.get(ConfigOption.StorageDir));
        }

        if (!fs.existsSync(this.storage)) {
            fs.mkdirSync(this.storage);
        }

        if (!fs.existsSync(this.dir_content)) {
            fs.mkdirSync(this.dir_content);
        }

        return new Promise<void>((resolve, reject) => {
            this.node = new ipfsApi({
                host: "ipfs.infura.io",
                port: 5001,
                /*
                protocol: 'https',
                headers: {
                    authorization: 'Bearer ' + TOKEN
                },
                */
                repo: this.storage,
                EXPERIMENTAL: {
                    dht: true,
                    relay: {
                        enabled: true,
                        hop: {
                            enabled: true
                        }
                    }
                },
                start: true
            });
            this.node.on("ready", () => {
                logger.info("IPFS Running...");
                this.emit("setup", this.node);
                resolve(this.node);
            });
            this.node.on("error", (errorObject: Error) => {
                logger.error("Error message: ", errorObject);
                this.emit("error", errorObject);
                reject(errorObject);
            });
        });
    }

    private list(hash: string): any {
        logger.info("IPFS Listing: " + hash);
        return new Promise((resolve, reject) => {
            this.node.ls(hash, (err: any, files: any) => {
                if (err) {
                    logger.error("IPFS.download.ls : hash[" + hash + "] ERROR: ", err);
                    reject();
                }
                logger.debug("IPFS[" + hash + "] LIST[" + files.length + "]");
                this.emit("list", files);
                resolve(files);
            });
        });
    }

    public async download(hash: string): Promise<string> {
        logger.info("IPFS Searching[" + hash + "] to download...");

        return new Promise<string>((resolve, reject) => {
            // Its already downloading

            this.list(hash).then((files: any) => {
                if (files.length > 0) {
                    logger.error("IPFS.download : hash[" + hash + "] error: found more files [" + files.length + "]", files);
                    return reject();
                }

                logger.info("Downloading.");
                this.node.files.get(hash, (err: any, files: any) => {
                    if (err) {
                        logger.error("IPFS.download.files : hash[" + hash + "] error: ", err);
                        this.emit("error", err);
                        return reject();
                    }
                    if (files.length < 1 || files.length > 1) {
                        logger.error("IPFS.download.files : hash[" + hash + "] " + files.length + " files: ", files);
                        this.emit("error", err);
                        return reject();
                    }
                    files.forEach((file: any) => {
                        logger.debug("Name: ", file.name);
                        logger.debug("Path: ", file.path);
                        logger.debug("Size: ", file.size);

                        this.emit("download", file.content);
                        return resolve(file.content);
                    });
                });
            });
        });
    }
}

export let ipfs = new IPFS();
// tslint:enable
