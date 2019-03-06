import * as fs from "fs-extra";
import * as lokijs from "lokijs";
import * as path from "path";
import { Collection } from "lokijs";

import { ContentData } from "./content-manager";
import { Helpers } from "./helpers";
import { NodeContentData } from "./nodes";
import { NodeStatus, Node } from "./contracts";
import { config, ConfigOption } from "./config";
import { logger } from "./logger";

type SettingsDataType = string | number;
type SettingsData = { key: string; value: SettingsDataType };
type SettingsCollection = Collection<SettingsData>;
interface ExtendedSettingsCollection extends SettingsCollection {
    upsert: (query: Partial<SettingsData>, data: SettingsData) => void;
    set: (query: Partial<SettingsData>, data: SettingsData) => void;
    view: (query: Partial<SettingsData>) => SettingsDataType | undefined;
}

type FilesCollection = Collection<ContentData>;
interface ExtendedFilesCollection extends FilesCollection {
    upsert: (query: Partial<ContentData>, data: ContentData) => void;
}

type NodesCollection = Collection<Node>;
interface ExtendedNodesCollection extends NodesCollection {
    upsert: (query: Partial<Node>, data: Node) => void;
}

type NodesContentCollection = Collection<NodeContentData>;
interface ExtendedNodesContentCollection extends NodesContentCollection {
    upsert: (query: Partial<NodeContentData>, data: NodeContentData) => void;
}

type ContentPopularityData = { contentId: string; data: number[] };
type ContentPopularityCollection = Collection<ContentPopularityData>;
interface ExtendedContentPopularityCollection extends ContentPopularityCollection {
    contentScore: (contentId: string) => void;
    upsert: (query: Partial<ContentPopularityData>, data: ContentPopularityData) => void;
    shift: (query: Partial<ContentPopularityData>, timestamp: number, timeInterval: number) => void;
    sum: (contentId: string) => number;
}

type HealthScoreData = { contentId: string; data: number };
type HealthScoreCollection = Collection<HealthScoreData>;
interface ExtendedHealthScoreCollection extends HealthScoreCollection {
    upsert: (query: Partial<HealthScoreData>, data: HealthScoreData) => void;
}

const AUTOSAVE = true;
const AUTOSAVE_INTERVAL = 1000;
const AUTOLOAD = true;

class DatabaseInitError extends Error {
    constructor(msg: string) {
        super(msg);
    }
}

export class DB {
    public contentPopularityCollection?: ExtendedContentPopularityCollection;
    public filesCollection?: ExtendedFilesCollection;
    public healthScoreCollection?: ExtendedHealthScoreCollection;
    public nodesCollection?: ExtendedNodesCollection;
    public nodesContentCollection?: ExtendedNodesContentCollection;
    public settingsCollection?: ExtendedSettingsCollection;

    public async setup(): Promise<void> {
        const dir = path.resolve(config.get(ConfigOption.DatabaseDir));
        if (!dir) {
            throw new Error("config.json DIR is empty");
        }
        await fs.ensureDir(dir);

        this.initSettingsDatabase(dir);
        await Promise.all([
            this.initContentPopularityDatabase(dir),
            this.initFilesDatabase(dir),
            this.initHealthScoreDatabase(dir),
            this.initNodesContentDatabase(dir),
            this.initNodesDatabase(dir),
            this.initSettingsDatabase(dir)
        ]);
        logger.config(`Using database tables in dir=${dir}.`);
        this.updateNodesStatuses();
    }

    private async initSettingsDatabase(dir: string): Promise<void> {
        return new Promise<void>(resolve => {
            const database = new lokijs(path.join(dir, "settings"), {
                autosave: AUTOSAVE,
                autosaveInterval: AUTOSAVE_INTERVAL,
                autoload: AUTOLOAD,
                autoloadCallback: () => {
                    const settingsCollection: SettingsCollection = database.addCollection("settings", { unique: ["key"] });
                    this.settingsCollection = Object.assign(settingsCollection, {
                        view: (query: Partial<SettingsData>) => {
                            const row = settingsCollection.findOne(query);
                            if (row) {
                                return row.value;
                            } else {
                                return undefined;
                            }
                        },
                        set: (query: Partial<SettingsData>, data: SettingsData) => {
                            const row = settingsCollection.findOne(query);
                            if (row) {
                                Object.assign(row, data);
                                settingsCollection.update(row);
                            } else {
                                settingsCollection.insert(data);
                            }
                        },
                        upsert: (query: Partial<SettingsData>, data: SettingsData) => {
                            const row = settingsCollection.findOne(query);
                            if (row) {
                                Object.assign(row, data);
                                settingsCollection.update(row);
                            } else {
                                settingsCollection.insert(data);
                            }
                        }
                    });
                    resolve();
                }
            });
        });
    }

    private async initFilesDatabase(dir: string): Promise<void> {
        return new Promise<void>(resolve => {
            const database = new lokijs(path.join(dir, "files"), {
                autosave: AUTOSAVE,
                autosaveInterval: AUTOSAVE_INTERVAL,
                autoload: AUTOLOAD,
                autoloadCallback: () => {
                    const filesCollection: FilesCollection = database.addCollection("files", { unique: ["contentId"] });
                    this.filesCollection = Object.assign(filesCollection, {
                        upsert: (query: Partial<ContentData>, data: ContentData) => {
                            const row = filesCollection.findOne(query);
                            if (row) {
                                Object.assign(row, data);
                                filesCollection.update(row);
                            } else {
                                filesCollection.insert(data);
                            }
                        }
                    });
                    resolve();
                }
            });
        });
    }

    private async initNodesDatabase(dir: string): Promise<void> {
        return new Promise<void>(resolve => {
            const database = new lokijs(path.join(dir, "nodes"), {
                autosave: AUTOSAVE,
                autosaveInterval: AUTOSAVE_INTERVAL,
                autoload: AUTOLOAD,
                autoloadCallback: () => {
                    const nodesCollection: NodesCollection = database.addCollection("nodes", { unique: ["nodeId"] });
                    this.nodesCollection = Object.assign(nodesCollection, {
                        upsert: (query: Partial<Node>, data: Node) => {
                            const row = nodesCollection.findOne(query);
                            if (row) {
                                Object.assign(row, data);
                                nodesCollection.update(row);
                            } else {
                                nodesCollection.insert(data);
                            }
                        }
                    });
                    resolve();
                }
            });
        });
    }

    /**
     * Initialize node contents database.
     * If database already exists, clear its content, since nodes should report their content.
     */
    private async initNodesContentDatabase(dir: string): Promise<void> {
        return new Promise<void>(resolve => {
            const database = new lokijs(path.join(dir, "nodesContent"), {
                autosave: AUTOSAVE,
                autosaveInterval: AUTOSAVE_INTERVAL,
                autoload: AUTOLOAD,
                autoloadCallback: () => {
                    const nodesContentCollection: NodesContentCollection = database.addCollection("nodesContent", {
                        indices: ["contentId", "nodeId", "status"]
                    });
                    this.nodesContentCollection = Object.assign(nodesContentCollection, {
                        upsert: (query: Partial<NodeContentData>, data: NodeContentData) => {
                            const row = nodesContentCollection.findOne(query);
                            if (row) {
                                Object.assign(row, data);
                                nodesContentCollection.update(row);
                            } else {
                                nodesContentCollection.insert(data);
                            }
                        }
                    });
                    // Clear database content.
                    nodesContentCollection.chain().remove();
                    resolve();
                }
            });
        });
    }

    private async initContentPopularityDatabase(dir: string): Promise<void> {
        return new Promise<void>(resolve => {
            const database = new lokijs(path.join(dir, "contentPopularity"), {
                autosave: AUTOSAVE,
                autosaveInterval: AUTOSAVE_INTERVAL,
                autoload: AUTOLOAD,
                autoloadCallback: () => {
                    const contentPopularityCollection: ContentPopularityCollection = database.addCollection("contentPopularity", {
                        unique: ["contentId"]
                    });
                    this.contentPopularityCollection = Object.assign(contentPopularityCollection, {
                        upsert: (query: Partial<ContentPopularityData>, data: ContentPopularityData) => {
                            const row = contentPopularityCollection.findOne(query);
                            if (row) {
                                Object.assign(row, data);
                                contentPopularityCollection.update(row);
                            } else {
                                contentPopularityCollection.insert(data);
                            }
                        },
                        shift: (query: Partial<ContentPopularityData>, timestamp: number, timeInterval: number) => {
                            const row = contentPopularityCollection.findOne(query);
                            let rowGlobalRequestCount = this.settings().view({ key: "dynamic-request-count" }) as number;
                            if (row != null && Array.isArray(row.data) === true) {
                                // Remove old timestamps from the array.
                                row.data.forEach((element: number) => {
                                    if (element <= timestamp - timeInterval) {
                                        row.data.splice(row.data.indexOf(element), 1);
                                        rowGlobalRequestCount -= 1;
                                    }
                                });
                                row.data.push(timestamp);
                                rowGlobalRequestCount += 1;
                                contentPopularityCollection.update(row);
                            } else if (row == null) {
                                if (query.contentId == null) {
                                    throw new Error("Invalid 'contentId'.");
                                }
                                contentPopularityCollection.insert({ contentId: query.contentId, data: [timestamp] });
                                rowGlobalRequestCount += 1;
                            }
                            this.settings().set(
                                { key: "dynamic-request-count" },
                                { key: "dynamic-request-count", value: rowGlobalRequestCount }
                            );
                        },
                        sum: (contentId: string) => {
                            const row = contentPopularityCollection.findOne({ contentId: contentId });
                            if (row != null && Array.isArray(row.data) === true) {
                                return row.data.length;
                            }
                            return 0;
                        },
                        contentScore: (contentId: string) => {
                            const row = contentPopularityCollection.findOne({ contentId: contentId });
                            const countPerId = row && Array.isArray(row.data) === true ? row.data.length : 0;
                            const rowGlobalRequestCount = this.settings().view({ key: "dynamic-request-count" }) as number;
                            if (countPerId != null && countPerId !== 0 && rowGlobalRequestCount != null && rowGlobalRequestCount !== 0) {
                                return (countPerId / rowGlobalRequestCount) * 1e6;
                            } else {
                                return 0;
                            }
                        }
                    });
                    resolve();
                }
            });
        });
    }

    private async initHealthScoreDatabase(dir: string): Promise<void> {
        return new Promise<void>(resolve => {
            const database = new lokijs(path.join(dir, "healthScore"), {
                autosave: AUTOSAVE,
                autosaveInterval: AUTOSAVE_INTERVAL,
                autoload: AUTOLOAD,
                autoloadCallback: () => {
                    const healthScoreCollection: HealthScoreCollection = database.addCollection("healthScore", {
                        unique: ["contentId"]
                    });
                    this.healthScoreCollection = Object.assign(healthScoreCollection, {
                        upsert: (query: Partial<HealthScoreData>, data: HealthScoreData) => {
                            const row = healthScoreCollection.findOne(query);
                            if (row) {
                                Object.assign(row, data);
                                healthScoreCollection.update(row);
                            } else {
                                healthScoreCollection.insert(data);
                            }
                        }
                    });
                    resolve();
                }
            });
        });
    }

    public updateNodesStatuses(): void {
        const nodes = this.nodes().find({ status: NodeStatus.online });
        for (const node of nodes) {
            node.status = NodeStatus.offline;
            if (node.connectedAt != null && node.connectedAt > 0) {
                node.disconnectedAt = Helpers.datetime.time();
                const uptime = Helpers.datetime.timeDiff(node.disconnectedAt, node.connectedAt);
                node.uptime = node.uptime ? node.uptime + uptime : uptime;
            }
            this.nodes().update(node);
        }

        if (this.settings == null) {
            throw new DatabaseInitError("settings");
        }
        this.settings().set({ key: "number-of-nodes" }, { key: "number-of-nodes", value: 0 });
    }

    public contentPopularity(): ExtendedContentPopularityCollection {
        if (this.contentPopularityCollection == null) {
            throw new DatabaseInitError("contentPopularityCollection");
        }
        return this.contentPopularityCollection;
    }

    public files(): ExtendedFilesCollection {
        if (this.filesCollection == null) {
            throw new DatabaseInitError("filesCollection");
        }
        return this.filesCollection;
    }

    public healthScore(): ExtendedHealthScoreCollection {
        if (this.healthScoreCollection == null) {
            throw new DatabaseInitError("healthScoreCollection");
        }
        return this.healthScoreCollection;
    }

    public nodes(): ExtendedNodesCollection {
        if (this.nodesCollection == null) {
            throw new DatabaseInitError("nodesCollection");
        }
        return this.nodesCollection;
    }

    public nodesContent(): ExtendedNodesContentCollection {
        if (this.nodesContentCollection == null) {
            throw new DatabaseInitError("nodesContentCollection");
        }
        return this.nodesContentCollection;
    }

    public settings(): ExtendedSettingsCollection {
        if (this.settingsCollection == null) {
            throw new DatabaseInitError("settingsCollection");
        }
        return this.settingsCollection;
    }
}

export let db = new DB();
