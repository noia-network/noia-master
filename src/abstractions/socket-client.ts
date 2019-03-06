import * as EventEmitter from "events";
import * as WebSocket from "ws";
import StrictEventEmitter from "strict-event-emitter-types";

import { Helpers } from "../helpers";
import { logger } from "../logger";

export enum ReadyState {
    /**
     * The connection is not yet open.
     */
    Connecting = 0,
    /**
     * The connection is open and ready to communicate.
     */
    Open = 1,
    /**
     * The connection is in the process of closing.
     */
    Closing = 2,
    /**
     * The connection is closed or couldn't be opened.
     */
    Closed = 3
}

interface SocketClientEvents {
    message: (this: SocketClient, msg: unknown) => this;
}

const SocketClientEmitter: { new (): StrictEventEmitter<EventEmitter, SocketClientEvents> } = EventEmitter;

export class SocketClient extends SocketClientEmitter {
    constructor(protected address: string) {
        super();
    }

    protected socket?: WebSocket;
    private socketPromise?: Promise<WebSocket>;
    private isFulfilled: boolean = false;

    protected async connect(): Promise<WebSocket> {
        // Is connect promise fulfilled.
        if (this.socketPromise != null) {
            return this.socketPromise;
        }

        const socketPromise = new Promise<WebSocket>((resolve, reject) => {
            this.resetSocket();
            this.socket = new WebSocket(this.address);
            this.socket.once("error", () => {
                logger.error(`Connection to '${this.address}' has failed.`);
                this.resetSocket();
                if (!this.isFulfilled) {
                    reject(`Connection to '${this.address}' has failed.`);
                }
            });

            // Should never close.
            this.socket.once("close", () => {
                logger.error(`Connection to '${this.address}' has been closed.`);
                this.resetSocket();
                if (!this.isFulfilled) {
                    reject(`Connection to '${this.address}' has been closed.`);
                }
            });

            // Messages.
            this.socket.on("message", msg => {
                this.emit("message", msg);
            });

            // If socket is defined and open.
            if (this.socket.readyState === WebSocket.OPEN) {
                logger.verbose(`Connected to Web Socket address=${this.address}.`);
                this.heartbeat();
                this.isFulfilled = true;
                resolve(this.socket);
                return;
            }

            this.socket.on("open", () => {
                logger.verbose(`Connected to Web Socket address=${this.address}.`);
                this.heartbeat();
                this.isFulfilled = true;
                resolve(this.socket);
            });
        });

        this.socketPromise = socketPromise;

        return socketPromise;
    }

    private resetSocket(): void {
        this.socketPromise = undefined;
        if (this.socket != null) {
            this.socket.removeAllListeners();
        }
        this.isFulfilled = false;
        this.socket = undefined;
    }

    /**
     * Communication session heartbeat.
     */
    private heartbeat(): void {
        if (this.socket == null) {
            return;
        }

        let isAlive: boolean = true;
        this.socket.on("pong", () => {
            isAlive = true;
        });
        let interval: NodeJS.Timer;
        interval = setInterval(() => {
            if (this.socket == null) {
                return;
            }

            if (isAlive === false) {
                logger.error(`Connection with data cluster is not alive: ready-state=${this.socket.readyState}.`);
                if (this.socket.readyState !== ReadyState.Open && this.socket.readyState !== ReadyState.Connecting) {
                    this.socket.terminate();
                }
                clearInterval(interval);
                return;
            }
            isAlive = false;
            this.socket.ping(Helpers.noop);
        }, 10000);
    }
}
