import * as getDomain from "getdomain";
import { dataCluster } from "./data-cluster";
import { logger } from "./logger";

class Whitelist {
    constructor() {
        this.refreshWhitelist();
    }

    private urls: string[] = [];

    public isWhitelisted(url: string): boolean {
        return this.urls.includes(getDomain.origin(url));
    }

    public async refreshWhitelist(): Promise<void> {
        const list = await dataCluster.listWhitelisted({
            // Any nodeId, no impact.
            nodeId: "wh1telistedCl1ents",
            timestamp: Date.now()
        });
        this.urls = [];
        if (list != null && Array.isArray(list.whitelistedClients)) {
            for (const item of list.whitelistedClients) {
                const domain = getDomain.origin(item.nodeId);
                if (domain != null) {
                    this.urls.push(domain);
                }
            }
        }
        logger.info(`Refreshed whitelisted domains list. List contains ${this.urls.length} items.`);
    }
}

export let whitelist = new Whitelist();
