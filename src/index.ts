import { Master } from "./master";
import { blockchain } from "./blockchain";
import { cache } from "./cache";
import { cli } from "./cli";
import { contentManager } from "./content-manager";
import { controller } from "./controller";
import { db } from "./db";
import { ipfs } from "./content-protocols/ipfs";
import { logger } from "./logger";

(async () => {
    await Promise.all([db.setup(), contentManager.setup(), blockchain.setup(), controller.setup()]);
    contentManager.on("cache", async (contentData, toNodeId, fromNodeId) => {
        db.files().upsert({ contentId: contentData.contentId }, contentData);
        logger.caching(`Updated content entry content-src=${contentData.contentSrc}, content-id=${contentData.contentId}.`);
        cache.queue(contentData, toNodeId, fromNodeId);
    });

    ipfs.on("error", err => {
        logger.error("IPFS has encountered an error: ", err);
    });

    const master = new Master();
    await master.start();
    cli(master);
})();
