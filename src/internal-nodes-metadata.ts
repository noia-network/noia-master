interface InternalNodeMetadata {
    city: string;
    continent: string;
    countryCode: string;
    cpuCores?: string;
    internetBandwidth?: string;
    ip: string;
    latitude: number;
    longitude: number;
    memorySize?: string;
    provider: string;
    state?: string;
}

export class InternalNodesMetadata {
    constructor() {
        const nodesMetadata = getInternalNodesMetadata();
        for (const nodeMetadata of nodesMetadata) {
            this.list[nodeMetadata.ip] = nodeMetadata;
        }
    }

    public list: { [key: string]: InternalNodeMetadata } = {};

    public get(ip: string): InternalNodeMetadata | undefined {
        if (typeof this.list[ip] != null) {
            return this.list[ip];
        }
        return undefined;
    }
}
export let internalNodesMetadata = new InternalNodesMetadata();

function getInternalNodesMetadata(): InternalNodeMetadata[] {
    return [];
}
