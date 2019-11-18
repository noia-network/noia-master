import WebSocket from "ws";

import { logger } from "./logger";
import { Helpers } from "./helpers";
import { TrackableWebSocket, LocationData } from "./contracts";

enum ApiMessage {
    Success = "success"
}

interface ApiEventData {
    from: Partial<LocationData>;
    to: Partial<LocationData>;
}

export enum ApiEventType {
    ClientRequest = "client-request",
    Connection = "connection",
    Request = "request",
    Response = "response"
}

export class Api {
    private webSockets: TrackableWebSocket[] = [];

    public connect(ws: WebSocket): void {
        const apiWs = ws as TrackableWebSocket;
        apiWs.id = Helpers.randomString();

        this.webSockets.push(apiWs);
        logger.debug(`API socket-id=${apiWs.id} added.`);

        apiWs.on("message", (message: string) => {
            try {
                const data = JSON.parse(message);
                if (!data.action) {
                    logger.error(`API socket-id=${apiWs.id} received invalid action, closing socket.`);
                    this.close(apiWs);
                    return;
                }
                apiWs.send(
                    JSON.stringify({
                        msg: ApiMessage.Success
                    })
                );
            } catch (err) {
                logger.error(err);
            }
        });

        apiWs.on("close", () => {
            logger.info(`API socket-id=${apiWs.id} closed.`);
        });

        apiWs.on("error", err => {
            logger.error(`API socket-id=${apiWs.id} encountered an error:`, err);
        });
    }

    public close(ws: WebSocket): void {
        ws.close();
    }

    public register(event: ApiEventType, data: Partial<ApiEventData>): void {
        for (let i = this.webSockets.length - 1; i >= 0; i--) {
            if (this.webSockets[i].readyState) {
                try {
                    this.webSockets[i].send(
                        JSON.stringify({
                            type: event,
                            payload: data
                        })
                    );
                } catch (err) {
                    logger.error(`API removed socket-id=${this.webSockets[i].id} connection, reason:`, err);
                    this.webSockets.splice(i, 1);
                }
            }
        }
    }
}

export let api = new Api();
