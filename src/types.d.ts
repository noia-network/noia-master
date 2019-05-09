declare module "bignumber.js" {
    export class BigNumber {
        constructor(amount: string);
    }
}
declare module "@noia-network/governance" {
    interface InitOptions {
        account: { mnemonic: string };
        web3: { provider_url: string };
    }
    interface BusinessClientData {
        host: string;
        port: number;
    }
    interface JobPostOptions {}
    interface NodeClientData {}

    export class NoiaSdk {
        init(initOptions: InitOptions): Promise<void>;
        getOwnerAddress(): string;
        isBusinessRegistered(businessClient: string): Promise<boolean>;
        getBusinessClient(businessClientAddress: string): Promise<BusinessClient>;
        createBusinessClient(businessClientData: BusinessClientData): Promise<BusinessClient>;
        getEtherBalance(ownerAddress: string): Promise<number>;
        getNoiaBalance(ownerAddress: string): Promise<number>;
        transfer(from: string, to: string, amount: number): Promise<void>;
        transferNoiaToken(workOrderAddress: string, amountWeis: number): Promise<void>;
        isNodeRegistered(nodeClientAddress: string): Promise<boolean>;
        getNodeClient(nodeClientAddress: string): Promise<NodeClient>;
        recoverAddressFromRpcSignedMessage(msg: string, msgSigned: string): string;
        getBaseClient(): Promise<BaseClient>;
        getJobPost(jobPostAddress: string): Promise<JobPost>;
        noiaTokensToWeis(amountNoia: number): number;
        createNodeClient(nodeClientData: NodeClientData): Promise<NodeClient>;
    }

    class BigNumber {
        constructor(amount: string);
    }
    export class WorkOrder {
        accept(): Promise<void>;
        address: string;
        workerOwner: string;
        getWorkerOwner(): Promise<string>;
        delegatedAccept(nonce: number, sig: string): Promise<void>;
        delegatedRelease(beneficiary: string, nonce: number, sig: string): Promise<void>;
        generateSignedAcceptRequest(): Promise<any>;
        generateSignedReleaseRequest(walletAddress: string): Promise<any>;
        getTimelockedEarliest(): Promise<any>;
        hasTimelockedTokens(): Promise<boolean>;
        isAccepted(): Promise<boolean>;
        timelock(amount: BigNumber, time: number): Promise<any>;
        totalFunds(): Promise<{ toNumber: () => number }>;
        totalVested(): Promise<{ toNumber: () => number }>;
        getJobPost(): JobPost;
    }
    export class BaseClient {
        rpcSignMessage(msg: string): Promise<string>;
        getWorkOrderAt(workOrderAddress: string): Promise<WorkOrder>;
    }
    export class NodeClient {
        address: string;
        getOwnerAddress(): Promise<string>;
    }
    export class BusinessClient {
        address: string;
        info: BusinessClientData;
        createJobPost(jobPostOptions: JobPostOptions): Promise<JobPost>;
        getOwnerAddress(): Promise<string>;
    }
    class JobPost {
        address: string;
        getEmployerAddress(): Promise<string>;
        getWorkOrderAt(workOrderAddress: string): Promise<WorkOrder>;
        createWorkOrder(workOrderAddress: string): Promise<WorkOrder>;
    }
}
declare module "wrtc";
declare module "create-torrent";
declare module "fs-chunk-store";
declare module "ip-to-int";
declare module "sha1";
declare module "create-torrent";
declare module "fs-chunk-store";
declare module "ip-to-int";
declare module "density-clustering";
declare module "parse-torrent" {
    namespace ParseTorrentTypes {
        interface FileData {
            path: string;
            name: string;
            length: number;
            offset: number;
        }
        interface ParseTorrentData {
            info: {
                length: number;
                name: Buffer;
                "piece length": number;
                pieces: Buffer;
            };
            infoBuffer: Buffer;
            infoHash: string;
            name: string;
            private: boolean;
            created: string;
            comment: string;
            announce: string[];
            urlList: string[];
            files: {
                path: string;
                name: string;
                length: number;
                offset: number;
            }[];
            length: number;
            pieceLength: number;
            lastPieceLength: number;
            pieces: string[];
        }
    }

    const ParseTorrent: ParseTorrent.ParseTorrent;
    namespace ParseTorrent {
        interface ParseTorrent {
            (torrent: string): ParseTorrentTypes.ParseTorrentData;
            (torrent: Buffer): ParseTorrentTypes.ParseTorrentData;
        }
    }

    export = ParseTorrent;
}

declare module "getdomain" {
    namespace getDomain {
        function origin(url: string): string;
    }

    export = getDomain;
}
