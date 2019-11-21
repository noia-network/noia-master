import fetch from "node-fetch";

import { logger } from "../logger";
import { config, ConfigOption } from "../config";

class Url {
    public downloads: [] = [];

    public async download(src: string): Promise<Buffer | undefined> {
        try {
            const response = await fetch(src, { method: "GET", size: config.get(ConfigOption.ContentMaxDownloadSize) });
            const dataBuffer = await response.buffer();
            logger.caching(`Master downloaded data to cache: source=${src}, bytes=${dataBuffer.length}.`);
            return dataBuffer;
        } catch (err) {
            logger.error(err);
        }
    }
}

export let url = new Url();
