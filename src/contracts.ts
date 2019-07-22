import { Wire } from "@noia-network/protocol";
import {
    NodeMetadata,
    MasterMetadata,
    ClientMetadata,
    MasterBlockchainMetadata,
    NodeBlockchainMetadata,
    ExternalIpv4,
    ExternalIpv6,
    NetworkInterfaces
} from "@noia-network/protocol/dist/contracts";
import * as WebSocket from "ws";
import { UptimeRequestDto, UptimeResponse } from "./data-cluster";
import { Systeminformation } from "systeminformation";

export interface LocationData {
    latitude: number;
    longitude: number;
    countryCode: string;
    city: string;
}

export interface CentroidLocationData extends LocationData {
    count: number;
}

export interface TorrentData {
    contentId: string;
    contentSrc: string;
    contentSize: number;
    /**
     * Flag if torrent was sent to nodes expected to be encrypted.
     * In future this flag could be used to actually decide if encryption should be done.
     */
    encrypt: boolean;
    file: string;
    infoHash: string;
    length: number;
    pieceLength: number;
    pieces: string[];
    piecesIntegrity: string[];
    files: Array<{
        path: string;
        name: string;
        length: number;
        offset: number;
    }>;
    name: string;
    urlList: string[];
}

export interface TrackableWebSocket extends WebSocket {
    id: string;
}

export enum NodeStatus {
    offline = "offline",
    online = "online"
}

export interface NodeConnectionType {
    checkStatus: "failed" | "succeeded" | "not-checked";
    port: number;
}

export type ClientConnectionsTypes = "ws" | "wss" | "webrtc";

export interface Node extends Systeminformation.OsData, NetworkInterfaces, ExternalIpv4, ExternalIpv6 {
    nodeId: string;
    location: LocationData;
    connectedAt: number;
    /**
     * Client to node connections.
     */
    connections: {
        [TKey in ClientConnectionsTypes]: {
            checkStatus: "failed" | "succeeded" | "not-checked";
            port: number | null;
        }
    };
    disconnectedAt?: number;
    domain?: string;
    interface?: "cli" | "gui" | "unspecified";
    ip: string;
    isInternalNode?: boolean;
    status?: NodeStatus;
    storage: {
        used: number;
        available: number;
        total: number;
        deviceType: string;
        settingsVersion: string;
        arch: string;
        platform: string;
        release: string;
        pingIpv6: boolean;
    };
    tokens?: number;
    uploaded?: number;
    downloaded?: number;
    /**
     * Current session uptime.
     */
    uptime: number;
    airdropAddress: string | null;
    bandwidthDownload: number;
    bandwidthUpload: number;
    loadDownload: number;
    loadUpload: number;
    healthScore: number;
    distance?: number;
    latency?: number;
    lastWorkOrder: string | null;
}

export interface Candidate {
    distance: number;
    host: string;
    ip: string;
    location: LocationData;
    nodeId: string;
    ports: { [TKey in ClientConnectionsTypes]?: number };
}

export type ExtendedWireTypes = ExtendedWire<MasterMetadata, NodeMetadata> | ExtendedWire<MasterBlockchainMetadata, NodeBlockchainMetadata>;
export type WireTypes = Wire<MasterMetadata, NodeMetadata> | Wire<MasterBlockchainMetadata, NodeBlockchainMetadata>;

export class ExtendedWire<TLocalMetadata extends ClientMetadata, TRemoteMetadata extends ClientMetadata> extends Wire<
    TLocalMetadata,
    TRemoteMetadata
> {
    public isInternalNode?: boolean;
    public pingPong?: NodeJS.Timer;
    public pingTimestamp?: number;
    public latency?: number | string;
    public uptime?: (uptimeRequest: UptimeRequestDto) => Promise<UptimeResponse>;
}
