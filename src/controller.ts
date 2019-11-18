// import bodyParser from "body-parser";
import express from "express";

import { NodeStatus, Node } from "./contracts";
import { config, ConfigOption } from "./config";
import { db } from "./db";
import { logger } from "./logger";

const router = express.Router();
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use("/api", router);

export class Controller {
    constructor() {
        router.route("/nodes").get((req, res, next) => {
            const query: Partial<Node> = {};

            const authToken = req.query.authToken;
            if (authToken !== config.get(ConfigOption.ApiAuthToken)) {
                res.json({
                    status: 401
                });
                return;
            }

            // Status.
            if (req.query.status != null) {
                Object.assign(query, { status: req.query.status });
            } else {
                Object.assign(query, { status: NodeStatus.online });
            }

            // Airdrop address.
            if (req.query.airdropAddress != null) {
                Object.assign(query, { airdropAddress: req.query.airdropAddress });
            }

            // Node id.
            if (req.query.nodeId != null) {
                Object.assign(query, { nodeId: req.query.nodeId });
            }

            const result = db.nodes().find(query);
            if (result != null) {
                res.json({
                    data: result,
                    status: 200
                });
                return;
            } else {
                res.json({
                    data: [],
                    status: 404
                });
                return;
            }
        });
    }

    public async setup(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            app.listen(config.get(ConfigOption.ApiPort), config.get(ConfigOption.MasterHost), (err: Error) => {
                if (err != null) {
                    reject(err);
                }
                logger.info(
                    `Listening for API requests, endpoint-address=http://${config.get(ConfigOption.MasterHost)}:${config.get(
                        ConfigOption.ApiPort
                    )}.`
                );
                resolve();
            });
        });
    }
}

export let controller = new Controller();
