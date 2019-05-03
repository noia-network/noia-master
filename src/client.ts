import * as WebSocket from "ws";
import * as geoip from "geoip-lite";
import * as getDomain from "getdomain";

import { ClientRequest, ClientResponse } from "@noia-network/protocol";
import { ConfigOption, config } from "./config";
import { Helpers } from "./helpers";
import { LocationData } from "./contracts";
import { Master } from "./master";
import { api, ApiEventType } from "./api";
import { contentManager } from "./content-manager";
import { db } from "./db";
import { logger } from "./logger";
import { whitelist } from "./whitelist";
import { cache } from "./cache";

export interface RequestSettingsData {
    proxyControlAddress?: string;
}

export class Client {
    constructor(private readonly master: Master, private readonly socket: WebSocket, public readonly ip: string) {
        this.socket.on("message", msg => {
            logger.info(`Client client-id=${this.id}, client-ip=${ip} connected.`);
            try {
                this.onMessage(JSON.parse(msg as string));
            } catch (err) {
                logger.info(`Failed to parse client client-id=${this.id}, client-ip=${ip} message.`);
                this.response({
                    // @ts-ignore
                    data: { src: "" },
                    error: "Failed to parse request data.",
                    status: 400
                });
                return;
            }
        });
        this.socket.on("error", () => {
            logger.info(`Client client-id=${this.id}, client-ip=${ip} disconnected.`);
        });
        this.socket.on("close", () => {
            logger.info(`Client client-id=${this.id}, client-ip=${ip} disconnected.`);
        });
    }

    public readonly id: string = Helpers.randomString(10);
    private readonly geo: geoip.Lookup = geoip.lookup(this.ip);
    public readonly location: LocationData = {
        latitude: this.geo != null && this.geo.ll[0] != null ? this.geo.ll[0] : 0.0,
        longitude: this.geo != null && this.geo.ll[1] != null ? this.geo.ll[1] : 0.0,
        countryCode: this.geo != null ? this.geo.country : "",
        city: this.geo != null ? this.geo.city : ""
    };

    private onMessage(msg: Partial<ClientRequest>): void {
        if (msg.src == null || typeof msg.src !== "string") {
            logger.error(`Received bad data from client id=${this.id}, ip=${this.ip}, src=${msg.src}.`);
            this.response({
                // @ts-ignore
                data: {
                    src: ""
                },
                error: "Property 'src' is invalid.",
                status: 400
            });
            return;
        }
        if (msg.connectionTypes == null || !Array.isArray(msg.connectionTypes)) {
            logger.error(`Received bad data from client id=${this.id}, ip=${this.ip}, src=${msg.src}.`);
            this.response({
                // @ts-ignore
                data: {
                    src: msg.src
                },
                error: "Property 'connectionTypes' is invalid. Array is expected.",
                status: 400
            });
            return;
        }
        const clientRequestData: ClientRequest = msg as ClientRequest;
        logger.debug(`Request from client id=${this.id}, ip=${this.ip} for src=${clientRequestData.src}.`);

        api.register(ApiEventType.Connection, {
            from: this.location,
            to: {
                countryCode: config.get(ConfigOption.MasterLocationCountryCode)
            }
        });

        if (clientRequestData.src.includes("ipfs:")) {
            clientRequestData.src = "https://ipfs.infura.io/ipfs/" + clientRequestData.src.substr(5);
        }

        const contentId = Helpers.getContentIdentifier(clientRequestData.src);
        if (!whitelist.isWhitelisted(clientRequestData.src)) {
            const responseMsg = `Content content-id=${contentId}, src=${clientRequestData.src}, domain=${getDomain.origin(
                clientRequestData.src
            )} not found.`;
            this.response({
                // @ts-ignore
                data: {
                    src: clientRequestData.src
                },
                error: responseMsg,
                status: 404
            });
            logger.warn(`Unauthorized content access with src='${clientRequestData.src}'.`);
            return;
        }

        const contentData = db.files().findOne({ contentId: contentId });
        contentManager.updatePopularity(contentId, Date.now(), this.location);
        if (contentData == null) {
            const responseMsg = `Content content-id=${contentId}, src=${clientRequestData.src} not found.`;
            logger.debug(responseMsg);
            this.response({
                // @ts-ignore
                data: { src: clientRequestData.src },
                error: responseMsg,
                status: 404
            });
            if (config.get(ConfigOption.CachingAuto)) {
                cache.autocachingDecisions(clientRequestData.src, this.location);
            }
            return;
        }

        // Find nodes by source and calculate distance between node and client.
        const candidates = this.master.nodes.getCandidates(clientRequestData, this.location);
        const peers = this.master.nodes.updateCandidatesWithInternalData(
            candidates.slice(0, config.get(ConfigOption.CachingReturnedNodesCount)),
            clientRequestData.src
        );

        logger.info(
            `Filtered ${Object.keys(peers).length} from ${candidates.length} potential peer(s) for client-id=${this.id} client-ip=${
                this.ip
            }, client-connection-types=${clientRequestData.connectionTypes}.`
        );

        // TODO: refactor.
        if (Object.keys(peers).length === 0 && config.get(ConfigOption.CachingAuto)) {
            cache.autocachingDecisions(clientRequestData.src, this.location);
        }

        api.register(ApiEventType.ClientRequest, {
            from: this.location,
            to: {
                countryCode: config.get(ConfigOption.MasterLocationCountryCode)
            }
        });

        if (config.get(ConfigOption.MasterLocationCountryCode) != null) {
            api.register(ApiEventType.Response, {
                from: {
                    countryCode: config.get(ConfigOption.MasterLocationCountryCode)
                },
                to: this.location
            });
        }

        function getSettings(): RequestSettingsData {
            return {
                proxyControlAddress: config.get(ConfigOption.ProxyControlAddres)
            };
        }

        this.response({
            data: {
                src: clientRequestData.src,
                peers: peers,
                metadata: {
                    bufferLength: contentData.length,
                    contentId: contentData.contentId,
                    pieceBufferLength: contentData.pieceLength,
                    // @ts-ignore
                    piecesIntegrity: contentData.pieces
                },
                settings: getSettings()
            },
            status: 200
        });
    }

    public response(clientResponseData: ClientResponse): void {
        this.socket.send(JSON.stringify(clientResponseData));
    }
}
