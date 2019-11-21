import * as EventEmitter from "events";
import * as WebSocket from "ws";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";

import { Api, api } from "./api";
import { config, ConfigOption } from "./config";
import { logger } from "./logger";
import { nodes, Nodes } from "./nodes";
import { Helpers } from "./helpers";
import { Client } from "./client";

interface SystemUsage {
    tick: () => void;
}

export class Master {
    constructor() {
        if (config.get(ConfigOption.MasterId) == null) {
            logger.error("config.json - masterId is missing");
            process.exit();
        }

        this.nodes = nodes;
        this.api = api;
        // [START] Websockets
        this.portNodes = config.get(ConfigOption.ProtocolsWsNodePort);
        this.portClients = config.get(ConfigOption.ProtocolsWsClientPort);
        this.portApi = config.get(ConfigOption.ProtocolsWsApiPort);
        this.host = config.get(ConfigOption.MasterHost);

        let secureConfig = {};
        if (config.get(ConfigOption.Ssl)) {
            secureConfig = {
                key: fs.readFileSync(config.get(ConfigOption.SslPrivateKey)),
                cert: fs.readFileSync(config.get(ConfigOption.SslCert)),
                ca: fs.readFileSync(config.get(ConfigOption.SslBundle))
            };
        }
        this.masterServerNodes = config.get(ConfigOption.ProtocolsWsNodeIsSecure) ? https.createServer(secureConfig) : http.createServer();
        this.masterServerClients = config.get(ConfigOption.ProtocolsWsClientIsSecure)
            ? https.createServer(secureConfig)
            : http.createServer();
        this.masterServerApi = config.get(ConfigOption.ProtocolsWsApiIsSecure) ? https.createServer(secureConfig) : http.createServer();
        this.wssNodes = new WebSocket.Server({ server: this.masterServerNodes });
        this.wssClients = new WebSocket.Server({
            server: this.masterServerClients
            // TODO: discusss.
            // verifyClient: (info, done) => {
            //     const whitelist: string[] = ["www.example.com", "http://google.com"];
            //     for (const url of whitelist) {
            //         if (url.includes(info.origin)) {
            //             done(true);
            //             return;
            //         }
            //     }
            //     logger.warn(`Unauthorized origin='${info.origin}'.`);
            //     done(false, 401, "Unauthorized");
            // }
        });
        this.wssApi = new WebSocket.Server({ server: this.masterServerApi });
    }

    public api: Api;
    // public clients: Clients;
    public nodes: Nodes;
    public portNodes: number;
    public portClients: number;
    public portApi: number;
    public host: string;
    public masterServerNodes: http.Server | https.Server;
    public masterServerClients: http.Server | https.Server;
    public masterServerApi: http.Server | https.Server;
    public wssNodes: WebSocket.Server;
    public wssClients: WebSocket.Server;
    public wssApi: WebSocket.Server;
    public ready: boolean = false;
    public lastCpuUsage?: NodeJS.CpuUsage;
    public lastRamUsage?: NodeJS.MemoryUsage;
    public external?: number;
    public node: EventEmitter = new EventEmitter();

    public async start(): Promise<void> {
        await Promise.all([this.listenClients(), this.listenNodes(), this.listenApi()]);
        // Websocket for nodes
        this.wssNodes.on("connection", (ws, req) => {
            this.nodes.connect(ws, req);
        });

        // Websocket for clients
        this.wssClients.on("connection", (ws, req) => {
            const ip = Helpers.getIp(req);
            if (ip == null) {
                logger.error("Could not determine client ip address.");
                return;
            }
            // const client = new Client(this, ws, ip);
            // TODO: Add client so Client[]?
        });

        // Websocket for master api
        this.wssApi.on("connection", (ws, req) => {
            logger.debug("wssApi :: connection");
            this.api.connect(ws);
        });
        this.ready = true;
        this.system.tick();
    }

    private async listenNodes(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const protocol = config.get(ConfigOption.ProtocolsWsNodeIsSecure) ? "wss" : "ws";
            logger.info(`Listening for NOIA nodes, endpoint-address=${protocol}://${this.host}:${this.portNodes}.`);
            if (this.host) {
                this.masterServerNodes.listen(this.portNodes, this.host, () => {
                    resolve();
                });
            } else {
                reject();
            }
        }).catch(err => {
            logger.error("Error in listenNodes:", err);
        });
    }

    private async listenClients(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const protocol = config.get(ConfigOption.ProtocolsWsClientIsSecure) ? "wss" : "ws";
            logger.info(`Listening for clients, endpoint-address=${protocol}://${this.host}:${this.portClients}.`);
            if (this.host) {
                this.masterServerClients.listen(this.portClients, this.host, () => {
                    resolve();
                });
            } else {
                reject();
            }
        }).catch(err => {
            logger.error("Error in listenClients:", err);
        });
    }

    private async listenApi(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            // const protocol = config.get(ConfigOption.ProtocolsWsApiIsSecure) ? "wss" : "ws";
            // logger.info(`Listening for API requests, endpoint=${protocol}://${this.host}:${this.portApi}.`);
            if (this.host) {
                this.masterServerApi.listen(this.portApi, this.host, () => {
                    resolve();
                });
            } else {
                reject();
            }
        }).catch(err => {
            logger.error("Error in listenApi:", err);
        });
    }

    public system: SystemUsage = {
        tick: () => {
            if (!config.get(ConfigOption.SystemUsageIsEnabled)) {
                return;
            }

            setInterval(() => {
                const ram = process.memoryUsage();
                const cpu = process.cpuUsage();
                let lCpu = null;
                let lRam = null;
                if (this.lastCpuUsage) {
                    lCpu = process.cpuUsage(this.lastCpuUsage);
                }

                if (this.lastRamUsage) {
                    lRam = {
                        rss: ram.rss - this.lastRamUsage.rss,
                        heapUsed: ram.heapUsed - this.lastRamUsage.heapUsed,
                        heapTotal: ram.heapTotal - this.lastRamUsage.heapTotal,
                        external: ram.external - this.lastRamUsage.external
                    };
                }

                this.lastCpuUsage = cpu;
                this.lastRamUsage = ram;

                logger.table("System data", {
                    "RAM rss": `${toRoundedMegabytes(ram.rss)}MB`,
                    "RAM heapUsed": `${toRoundedMegabytes(ram.heapUsed)}MB`,
                    "RAM heapTotal": `${toRoundedMegabytes(ram.heapTotal)}MB`,
                    "RAM external": `${toRoundedMegabytes(ram.external)}MB`,
                    " ": "-----------------------",
                    "DIFF RAM rss": lRam ? `${toRoundedMegabytes(lRam.rss)}MB` : "",
                    "DIFF RAM heapUsed": lRam ? `${toRoundedMegabytes(lRam.heapUsed)}MB` : "",
                    "DIFF RAM heapTotal": lRam ? `${toRoundedMegabytes(lRam.heapTotal)}MB` : "",
                    "DIFF RAM external": lRam ? `${toRoundedMegabytes(lRam.external)}MB` : "",
                    "  ": "-----------------------",
                    "CPU user": cpu.user,
                    "CPU system": cpu.system,
                    "   ": "-----------------------",
                    "DIFF CPU user": lCpu ? lCpu.user : "",
                    "DIFF CPU system": lCpu ? lCpu.system : ""
                });
            }, config.get(ConfigOption.SystemUsageInterval));
        }
    };
}

function toRoundedMegabytes(value: number): number {
    return Math.round((value / 1024 / 1024) * 100) / 100;
}
