import ipInt from "ip-to-int";
import request from "request";

import { config, ConfigOption } from "./config";
import { logger } from "./logger";

const CF_URL = "https://api.cloudflare.com/client/v4/";
const ZONE_ID = "zone_id";

interface DnsOptions {
    content: string;
    name: string;
    type: "A";
    proxied?: boolean;
}

interface Dns {
    add: (zoneId: string, options: DnsOptions) => void;
}

export class Cloudflare {
    private dns: Dns = {
        add: (zoneId: string, options: DnsOptions) => {
            if (!config.get(ConfigOption.CloudflareIsEnabled)) {
                return;
            }

            logger.info(
                `DNS 'add' request: zone-id=${zoneId}, is-cloudflare-enabled=${config.get(
                    ConfigOption.CloudflareIsEnabled
                )} with options: content=${options.content}, name=${options.name}, type=${options.type}, proxied=${options.proxied}.`
            );

            const content = options.content || null;
            const name = options.name || null;
            if (content != null && name != null && name !== "noia.network" && name !== "0") {
                this.request("POST", `zones/${zoneId}/dns_records`, {
                    type: options.type || "A",
                    name: name,
                    content: content,
                    proxied: false
                });
            }
        }
    };

    private request(method: "POST" | "GET", urlPart: string, options: DnsOptions): void {
        if (!config.get(ConfigOption.CloudflareIsEnabled)) {
            return;
        }
        if (config.get(ConfigOption.CloudflareEmail) == null) {
            throw new Error("Cloudflare e-mail is invalid.");
        }
        if (config.get(ConfigOption.CloudflareKey) == null) {
            throw new Error("Cloudflare API key is invalid.");
        }

        const settings = {
            url: `${CF_URL}${urlPart}`,
            method: method,
            headers: {
                "X-Auth-Email": config.get(ConfigOption.CloudflareEmail),
                "X-Auth-Key": config.get(ConfigOption.CloudflareKey),
                "Content-Type": "application/json"
            },
            body: options || null,
            json: method === "POST"
        };

        request(settings, (err: Error) => {
            if (err) {
                throw err;
            }
        });
    }

    public createSubdomain(ip: string): string | undefined {
        if (!config.get(ConfigOption.CloudflareIsEnabled)) {
            logger.warn(`Requested subdomain creation for ip=${ip}, while cloudflare is disabled!`);
            return undefined;
        }

        if (config.get(ConfigOption.CloudflareDomain) == null) {
            throw new Error("Cloudflare domain is invalid.");
        }

        const ipIntegerString: string = String(ipInt(ip).toInt());
        this.dns.add(ZONE_ID, {
            type: "A",
            name: ipIntegerString,
            content: ip
        });

        const domain = `${ipIntegerString}.${config.get(ConfigOption.CloudflareDomain)}`;
        return domain;
    }
}

export let cloudflare = new Cloudflare();
