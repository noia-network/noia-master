import WebSocket from "ws";
import chalk from "chalk";
import { config, ConfigOption } from "./config";
import { ContentResponse } from "@noia-network/protocol";
import { encryption } from "./encryption";

export namespace CliHelpers {
    export async function onWsOpenPromise(ws: WebSocket): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            ws.once("open", () => {
                resolve();
            });
            ws.once("unexpected-response", (_, incomingMessage) => {
                reject(`Response status-code=${incomingMessage.statusCode}, status-message=${incomingMessage.statusMessage}.`);
            });
        });
    }

    export async function onWsMessage(ws: WebSocket): Promise<string> {
        return new Promise<string>(resolve => {
            ws.once("message", msg => {
                resolve(msg as string);
            });
        });
    }

    // tslint:disable-next-line:no-any
    export function log(...args: any[]): void {
        console.info(chalk.red(...args));
    }

    // tslint:disable-next-line:no-any
    export function info(...args: any[]): void {
        console.info(chalk.green(...args));
    }

    export function logObject(obj: object): void {
        log(JSON.stringify(obj, null, 2));
    }

    export function getAddressByProtocol(protocol: "wss" | "ws"): string {
        if (protocol === "wss" || protocol === "ws") {
            const port = config.get(ConfigOption.ProtocolsWsClientPort);
            const domain = config.get(ConfigOption.MasterDomain);
            return `${protocol}://${domain}:${port}`;
        } else {
            throw new Error("Invalid protocol.");
        }
    }

    export function getPieceDataWs(secretKey: string | null, contentResponse: ContentResponse): Buffer {
        if (config.get(ConfigOption.ContentEncryptionIsEnabled)) {
            return encryption.decrypt(secretKey, contentResponse.data!.buffer);
        }
        return contentResponse.data!.buffer;
    }

    export function getPieceDataWebRtc(secretKey: string | null, contentResponse: ContentResponse): Buffer {
        if (config.get(ConfigOption.ContentEncryptionIsEnabled)) {
            return encryption.decrypt(secretKey, Buffer.from(contentResponse.data!.buffer));
        }
        return Buffer.from(contentResponse.data!.buffer);
    }
}
