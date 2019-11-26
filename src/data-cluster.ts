import { SocketClient, ReadyState } from "./abstractions/socket-client";
import { config, ConfigOption } from "./config";
import { logger } from "./logger";

// TODO: actually import this type.
export const enum NodeEvents {
    Connected = "node-connected",
    Disconnected = "node-disconnected",
    Alive = "node-alive",
    Metadata = "node-metadata",
    Storage = "node-storage",
    Bandwidth = "node-bandwidth",
    Request = "client-request",
    Response = "client-response",
    Uptime = "node-uptime",
    Upload = "node-bandwidth-upload",
    Download = "node-bandwidth-download",
    UploadTotal = "node-bandwidth-upload-total",
    DownloadTotal = "node-bandwidth-download-total",
    AddWhitelistedClient = "node-whitelist-client",
    RemoveWhitelistedClient = "node-remove-whitelisted-client",
    ListWhitelistedClients = "node-list-whitelisted-clients",
    IsAlive = "node-is-alive",
    System = "node-system",
    Ping = "node-ping"
}

export interface ConnectedDto {
    nodeId: string;
    timestamp: number;
}

export interface AliveDto {
    nodeId: string;
    timestamp: number;
    parentTimestamp: number;
}

export interface DisconnectedDto {
    nodeId: string;
    timestamp: number;
}

export interface PingDto {
    nodeId: string;
    toNodeId?: string;
    timestamp: number;
    host: string;
    time: number;
    min: number;
    max: number;
    avg: number;
    ipv4?: string;
    ipv6?: string;
}

export interface BandwidthDto {
    nodeId: string;
    timestamp: number;
    bandwidthUpload: number;
    bandwidthDownload: number;
    latency: number;
}

export interface StorageDto {
    nodeId: string;
    timestamp: number;
    storageTotal: number;
    storageAvailable: number;
    storageUsed: number;
}

export interface SystemDto {
    nodeId: string;
    timestamp: number;
    platform?: string;
    distro?: string;
    release?: string;
    arch?: string;
    deviceType?: string;
    settingsVersion?: string;
    iface?: string;
    ifaceName?: string;
    mac?: string;
    internal?: boolean;
    virtual?: boolean;
    operstate?: string;
    duplex?: string;
    type?: string;
    mtu?: number;
    speed?: number;
    ipv4?: string;
    ipv6?: string;
    pingIpv6?: boolean;
    interfacesLength: number;
}

export interface ExternalIpv4Dto {
    ipv4: string;
}

export interface ExternalIpv6Dto {
    ipv6: string;
}

export interface MetadataDto {
    nodeId: string;
    timestamp: number;
    bandwidthUpload: number;
    bandwidthDownload: number;
    latency: number;
    storageTotal: number;
    storageAvailable: number;
    storageUsed: number;
}

export interface UptimeRequestDto {
    nodeId: string;
    timestamp: number;
    from: number;
    to: number;
    alive?: {
        parentTimestamp: number;
        timestamp: number;
    };
}

export interface UptimeResponse {
    nodeId: string;
    total: number;
    seconds: number;
    minutes: number;
    hours: number;
    days: number;
    timestamp: number;
}

export interface UploadDto {
    nodeId: string;
    timestamp: number;
    contentId: string;
    contentDomain: string;
    bytesCount: number;
    ip: string;
}

export interface DownloadDto {
    nodeId: string;
    timestamp: number;
    contentId: string;
    bytesCount: number;
    ip: string;
}

export interface UploadTotalDto {
    nodeId: string;
    timestamp: number;
}

export interface DownloadTotalDto {
    nodeId: string;
    timestamp: number;
}

export interface UploadTotalResponse {
    nodeId: string;
    bytesCount: number;
    timestamp: number;
}

export interface DownloadTotalResponse {
    nodeId: string;
    bytesCount: number;
    timestamp: number;
}

export interface AddWhitelistedClientDto {
    nodeId: string;
    name: string;
}

export interface RemoveWhitelistedClientDto {
    name: string;
}

export interface ListWhitelistedClientsDto {
    nodeId: string;
    timestamp: number;
}

export interface ListWhitelistedClientsResponse {
    nodeId: string;
    whitelistedClients: Array<{
        id: string;
        name: string;
        nodeId: string;
    }>;
    timestamp: number;
}

export interface IsAliveDto {
    nodeId: string;
    minutesOffline: number;
    timestamp: number;
}

export class DataCluster extends SocketClient {
    constructor(public readonly databaseAddress: string) {
        super(databaseAddress);
        this.initialize();
    }

    public responsesQueue: Map<
        string,
        (result: UploadTotalResponse | DownloadTotalResponse | UptimeResponse | ListWhitelistedClientsResponse) => void
    > = new Map();
    public requestsQueue: string[] = [];

    private async initialize(): Promise<void> {
        await this.connect();
        try {
            this.on("message", msg => {
                const response: UploadTotalResponse | DownloadTotalResponse | UptimeResponse = JSON.parse(msg as string);
                const id = this.getQueueIdentifier(response.nodeId, response.timestamp);
                if (this.responsesQueue.has(id)) {
                    const callback = this.responsesQueue.get(id)!;
                    callback(response);
                    this.responsesQueue.delete(id);
                }
            });
        } catch (err) {
            logger.error("Failed to send msg:", err);
        }
        setInterval(async () => {
            if (this.socket == null || this.socket.readyState !== ReadyState.Open) {
                try {
                    await this.connect();
                } catch (err) {
                    logger.warn("Socket is invalid or in not open state:", err);
                }
                return;
            }
            const item = this.requestsQueue.shift();
            if (item != null) {
                this.socket.send(item);
            }
        }, config.get(ConfigOption.DataClusterQueueIntervalMs));
    }

    private async send<TEvent, TDto>(event: TEvent, data: TDto): Promise<void> {
        try {
            await this.connect();
            if (this.socket == null) {
                logger.error("Socket is invalid.");
                return;
            }
            this.socket.send(
                JSON.stringify({
                    type: event,
                    payload: data
                })
            );
        } catch (err) {
            logger.error("Failed to send event to data cluster:", err);
        }
    }

    private async sendWithResponse<TEvent, TDto extends { nodeId: string; timestamp: number }>(
        event: TEvent,
        data: TDto,
        result: (result: UploadTotalResponse | DownloadTotalResponse | UptimeResponse | ListWhitelistedClientsResponse) => void
    ): Promise<void> {
        try {
            this.responsesQueue.set(this.getQueueIdentifier(data.nodeId, data.timestamp), result);
            this.requestsQueue.push(
                JSON.stringify({
                    type: event,
                    payload: data
                })
            );
        } catch (err) {
            logger.error("Failed to send event to data cluster:", err);
        }
    }

    private getQueueIdentifier(nodeId: string, timestamp: number): string {
        return `${nodeId}-${timestamp}`;
    }

    /**
     * Retrieve information how much node has uploaded bytes.
     */
    public async uploadTotal(uploadTotalRequest: UploadTotalDto): Promise<UploadTotalResponse> {
        return new Promise<UploadTotalResponse>(async resolve => {
            try {
                this.sendWithResponse<NodeEvents, UploadTotalDto>(NodeEvents.UploadTotal, uploadTotalRequest, result => {
                    logger.verbose(`Received node-id=${uploadTotalRequest.nodeId} uptime (upload) event:`, result);
                    resolve(result as UploadTotalResponse);
                });
                logger.verbose(`Requested node-id=${uploadTotalRequest.nodeId} upload total.`);
            } catch (err) {
                logger.error("Failed to send UploadTotal:", err);
            }
        });
    }

    /**
     * Retrieve information how much node has downloaded bytes.
     */
    public async downloadTotal(downloadTotalRequest: DownloadTotalDto): Promise<DownloadTotalResponse> {
        return new Promise<DownloadTotalResponse>(async (resolve, reject) => {
            try {
                this.sendWithResponse<NodeEvents, DownloadTotalDto>(NodeEvents.DownloadTotal, downloadTotalRequest, result => {
                    logger.verbose(`Received node-id=${downloadTotalRequest.nodeId} uptime (download) event:`, result);
                    resolve(result as DownloadTotalResponse);
                });
                logger.verbose(`Requested node-id=${downloadTotalRequest.nodeId} download total.`);
            } catch (err) {
                logger.error("Failed to send downloadTotal:", err);
            }
        });
    }

    /**
     * Retrieves calculated node uptime.
     */
    public async uptime(uptimeRequest: UptimeRequestDto, parentTimestamp?: number): Promise<UptimeResponse> {
        return new Promise<UptimeResponse>(async (resolve, reject) => {
            // If parent timestamp is known, expect that this node is alive.
            try {
                if (parentTimestamp != null) {
                    Object.assign(uptimeRequest, {
                        alive: {
                            parentTimestamp: parentTimestamp,
                            timestamp: Date.now()
                        }
                    });
                }

                this.sendWithResponse<NodeEvents, UptimeRequestDto>(NodeEvents.Uptime, uptimeRequest, result => {
                    logger.verbose(`Received node-id=${uptimeRequest.nodeId} uptime event:`, result);
                    resolve(result as UptimeResponse);
                });
                logger.verbose(
                    `Requested node-id=${uptimeRequest.nodeId} uptime from=${uptimeRequest.from}, to=${
                        uptimeRequest.to
                    }, diff=${uptimeRequest.to - uptimeRequest.from}.`
                );
            } catch (err) {
                logger.error("Failed to send uptime:", err);
            }
        });
    }

    /**
     * List whitelisted clients.
     */
    public async listWhitelisted(listWhitelistedRequest: ListWhitelistedClientsDto): Promise<ListWhitelistedClientsResponse> {
        return new Promise<ListWhitelistedClientsResponse>(async (resolve, reject) => {
            this.sendWithResponse<NodeEvents, ListWhitelistedClientsDto>(
                NodeEvents.ListWhitelistedClients,
                listWhitelistedRequest,
                result => {
                    try {
                        logger.verbose(`Received list whitelisted clients request:`, result);
                        resolve(result as ListWhitelistedClientsResponse);
                    } catch (err) {
                        logger.error("Failed in listWhitelisted:", err);
                    }
                }
            );
            // logger.verbose(
            //     `Requested node-id=${listWhitelistedRequest.nodeId} uptime from=${listWhitelistedRequest.from}, to=${
            //         listWhitelistedRequest.to
            //     }, diff=${listWhitelistedRequest.to - listWhitelistedRequest.from}.`
            // );
        });
    }

    /**
     * Checks if node alive.
     */
    public async isAlive(isAliveRequest: IsAliveDto): Promise<boolean> {
        return new Promise<boolean>(async (resolve, reject) => {
            this.sendWithResponse<NodeEvents, IsAliveDto>(NodeEvents.IsAlive, isAliveRequest, result => {
                try {
                    // @ts-ignore
                    logger.verbose(`Received is alive request response: nodeId=${isAliveRequest.nodeId} is-alive=${result.isAlive}`);
                    // @ts-ignore
                    resolve(result.isAlive as boolean);
                } catch (err) {
                    logger.error("Failed to send isAlive:", err);
                }
            });
            // logger.verbose(
            //     `Requested node-id=${listWhitelistedRequest.nodeId} uptime from=${listWhitelistedRequest.from}, to=${
            //         listWhitelistedRequest.to
            //     }, diff=${listWhitelistedRequest.to - listWhitelistedRequest.from}.`
            // );
        });
    }

    /**
     * Add whitelisted client.
     */
    public async addWhitelistedClient(data: AddWhitelistedClientDto): Promise<void> {
        // logger.info(`Node node`)
        this.send<NodeEvents, AddWhitelistedClientDto>(NodeEvents.AddWhitelistedClient, data).catch(err => {
            logger.error(err);
        });
    }

    /**
     * Remove whitelisted client.
     */
    public async removeWhitelistedClient(data: RemoveWhitelistedClientDto): Promise<void> {
        // logger.info(`Node node`)
        this.send<NodeEvents, RemoveWhitelistedClientDto>(NodeEvents.RemoveWhitelistedClient, data).catch(err => {
            logger.error(err);
        });
    }

    /**
     * Node is connected to master.
     */
    public async connected(data: ConnectedDto): Promise<void> {
        // logger.info(`Node node`)
        this.send<NodeEvents, ConnectedDto>(NodeEvents.Connected, data).catch(err => {
            logger.error("Node is connected to master:", err);
        });
    }

    /**
     * Node downloaded data.
     */
    public downloads: { [key: string]: DownloadDto } = {};
    public async download(data: DownloadDto): Promise<void> {
        const id = `${data.nodeId}-${data.contentId}-${data.ip}`;
        if (this.downloads[id] == null) {
            this.downloads[id] = data;
            setTimeout(() => {
                this.send<NodeEvents, DownloadDto>(NodeEvents.Download, this.downloads[id]).catch(err => {
                    logger.error(err);
                });
                delete this.downloads[id];
            }, config.get(ConfigOption.DataClusterBandwidthQueueIntervalMs));
        } else {
            this.downloads[id].bytesCount += data.bytesCount;
        }
    }

    /**
     * Node uploaded data.
     */
    public uploads: { [key: string]: UploadDto } = {};
    public async upload(data: UploadDto): Promise<void> {
        const id = `${data.nodeId}-${data.contentId}-${data.ip}`;
        if (this.uploads[id] == null) {
            this.uploads[id] = data;
            setTimeout(() => {
                this.send<NodeEvents, UploadDto>(NodeEvents.Upload, this.uploads[id]).catch(err => {
                    logger.error(err);
                });
                delete this.uploads[id];
            }, config.get(ConfigOption.DataClusterBandwidthQueueIntervalMs));
        } else {
            this.uploads[id].bytesCount += data.bytesCount;
        }
    }

    /**
     * Node is still online at current timestamp.
     */
    public async alive(data: AliveDto): Promise<void> {
        this.send<NodeEvents, AliveDto>(NodeEvents.Alive, data).catch(err => {
            logger.error("Alive err:", err);
        });
    }

    /**
     * Node is disconnected.
     */
    public async disconnected(data: DisconnectedDto): Promise<void> {
        this.send<NodeEvents, DisconnectedDto>(NodeEvents.Disconnected, data).catch(err => {
            logger.error(err);
        });
    }

    public async bandwidth(data: BandwidthDto): Promise<void> {
        this.send<NodeEvents, BandwidthDto>(NodeEvents.Bandwidth, data).catch(err => {
            logger.error(err);
        });
    }

    public async storage(data: StorageDto): Promise<void> {
        this.send<NodeEvents, StorageDto>(NodeEvents.Storage, data).catch(err => {
            logger.error(err);
        });
    }

    public async system(data: SystemDto): Promise<void> {
        this.send<NodeEvents, SystemDto>(NodeEvents.System, data).catch(err => {
            logger.error(err);
        });
    }

    public async ping(data: PingDto): Promise<void> {
        this.send<NodeEvents, PingDto>(NodeEvents.Ping, data).catch(err => {
            logger.error(err);
        });
    }

    public async metadata(data: MetadataDto): Promise<void> {
        this.send<NodeEvents, MetadataDto>(NodeEvents.Metadata, data).catch(err => {
            logger.error(err);
        });
    }

    public registerLifetime(
        nodeId: string,
        registerEvents: (onDisconnect: () => void, uptime: (uptimeRequest: UptimeRequestDto) => Promise<UptimeResponse>) => void
    ): void {
        try {
            const FIVE_TO_FIFTEEN_MINUTES = (Math.floor(Math.random() * 5) + 10) * 60 * 1000;
            const parentTimestamp = Date.now();
            logger.verbose(`Data cluster received node-id=${nodeId} timestamp=${parentTimestamp} connect event.`);
            dataCluster.connected({
                nodeId: nodeId,
                timestamp: parentTimestamp
            });

            const intervalId = setInterval(() => {
                dataClusterAlive(nodeId);
            }, FIVE_TO_FIFTEEN_MINUTES);

            registerEvents(
                () => {
                    clearInterval(intervalId);
                    dataClusterAlive(nodeId);
                    dataClusterDisconnected(nodeId);
                },
                async (uptimeRequest: UptimeRequestDto) => {
                    // Alive should be sent since doesn't seem that data cluster updates alive record by only sending uptime.
                    this.alive({
                        nodeId: uptimeRequest.nodeId,
                        parentTimestamp: parentTimestamp,
                        timestamp: new Date().getTime()
                    });
                    return this.uptime(uptimeRequest, parentTimestamp);
                }
            );

            function dataClusterAlive(id: string): void {
                const dateNow = Date.now();
                logger.verbose(
                    `Data cluster received node-id=${id}, timestamp=${dateNow}, parent-timestamp=${parentTimestamp} alive event.`
                );
                dataCluster.alive({
                    nodeId: id,
                    timestamp: dateNow,
                    parentTimestamp: parentTimestamp
                });
            }

            function dataClusterDisconnected(id: string): void {
                const dateNow = Date.now();
                logger.verbose(`Data cluster received node-id=${id}, timestamp=${dateNow} disconnect event.`);
                dataCluster.disconnected({
                    nodeId: id,
                    timestamp: dateNow
                });
            }
        } catch (err) {
            logger.error("registerLifetime err:", err);
        }
    }
}

export let dataCluster = new DataCluster(config.get(ConfigOption.DataClusterHost));
