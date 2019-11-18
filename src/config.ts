import fs from "fs-extra";
import path from "path";

import { logger } from "./logger";

const CONFIG_DEFAULT_PATH: string = path.resolve("config.json");

export enum ConfigOption {
    ApiAuthToken = "api.authToken",
    ApiPort = "api.port",
    ProxyControlAddres = "proxyControlAddress",
    MasterDomain = "master.domain",
    MasterHost = "master.host",
    MasterId = "master.id",
    MasterIp = "master.ip",
    MasterIsPrivate = "master.isPrivate",
    MasterLocationCountryCode = "master.location.countryCode",
    MasterVersion = "master.version",
    NodeVersion = "node.version",
    ContentEncryptionIsEnabled = "content.encryption.isEnabled",
    ContentEncryptionSecretSalt = "content.encryption.secretSalt",
    ContentMaxDownloadSize = "content.maxDownloadSize",
    SystemUsageInterval = "system.usage.interval",
    SystemUsageIsEnabled = "system.usage.isEnabled",
    DataClusterHost = "dataCluster.host",
    DataClusterQueueIntervalMs = "dataCluster.queueIntervalMs",
    DataClusterBandwidthQueueIntervalMs = "dataCluster.bandwidthQueueIntervalMs",
    DataClusterCheckNodeOnline = "dataCluster.checkNodeOnline",
    ProtocolsWsApiIsSecure = "protocols.ws.api.isSecure",
    ProtocolsWsApiPort = "protocols.ws.api.port",
    ProtocolsWsClientIsSecure = "protocols.ws.client.isSecure",
    ProtocolsWsClientPort = "protocols.ws.client.port",
    ProtocolsWsNodeIsSecure = "protocols.ws.node.isSecure",
    ProtocolsWsNodePort = "protocols.ws.node.port",
    CloudflareDomain = "cloudflare.domain",
    CloudflareEmail = "cloudflare.email",
    CloudflareKey = "cloudflare.key",
    CloudflareIsEnabled = "cloudflare.isEnabled",
    DatabaseDir = "database.dir",
    Ssl = "ssl",
    SslBundle = "ssl.bundle",
    SslCert = "ssl.cert",
    SslPrivateKey = "ssl.privateKey",
    StorageDir = "storage.dir",
    BlockchainIsEnabled = "blockchain.isEnabled",
    BlockchainJobPostInterval = "blockchain.jobPostInterval",
    BlockchainMnemonic = "blockchain.mnemonic",
    BlockchainProviderUrl = "blockchain.providerUrl",
    BlockchainRewardAmount = "blockchain.rewardAmount",
    BlockchainRewardInterval = "blockchain.rewardInterval",
    CachingRestartInterval = "caching.restartInterval",
    CachingInterval = "caching.interval",
    CachingRemoveDelay = "caching.removeDelay",
    CachingReturnedNodesCount = "caching.returnedNodesCount",
    CachingWhitelist = "caching.whitelist",
    CachingAuto = "caching.auto",
    CachingInitialCopies = "caching.initialCopies",
    CachingMaxDownloads = "caching.maxDownloads",
    CachingScaleEpsilon = "caching.scaleEpsilon",
    CachingLoadBound = "caching.loadBound",
    CachingOnlyToSucceededWebRTC = "caching.onlyToSucceededWebRtc",
    WebRtcCheckSchedulerInterval = "webrtc.checkSchedulerInterval"
}

/* tslint:disable */
export interface ConfigSettings {
    [ConfigOption.ApiAuthToken]: string;
    [ConfigOption.ApiPort]: number;
    [ConfigOption.ProxyControlAddres]: string;
    [ConfigOption.MasterDomain]: string;
    [ConfigOption.MasterHost]: string;
    [ConfigOption.MasterId]: string;
    [ConfigOption.MasterIp]: string;
    [ConfigOption.MasterIsPrivate]: boolean;
    [ConfigOption.MasterLocationCountryCode]: string;
    [ConfigOption.MasterVersion]: string;
    [ConfigOption.NodeVersion]: string;
    [ConfigOption.ContentEncryptionIsEnabled]: boolean;
    [ConfigOption.ContentEncryptionSecretSalt]: string;
    [ConfigOption.ContentMaxDownloadSize]: number;
    [ConfigOption.SystemUsageInterval]: number;
    [ConfigOption.SystemUsageIsEnabled]: boolean;
    [ConfigOption.DataClusterHost]: string;
    [ConfigOption.DataClusterQueueIntervalMs]: number;
    [ConfigOption.DataClusterBandwidthQueueIntervalMs]: number;
    [ConfigOption.DataClusterCheckNodeOnline]: boolean;
    [ConfigOption.ProtocolsWsApiIsSecure]: boolean;
    [ConfigOption.ProtocolsWsApiPort]: number;
    [ConfigOption.ProtocolsWsClientIsSecure]: boolean;
    [ConfigOption.ProtocolsWsClientPort]: number;
    [ConfigOption.ProtocolsWsNodeIsSecure]: boolean;
    [ConfigOption.ProtocolsWsNodePort]: number;
    [ConfigOption.CloudflareDomain]: string;
    [ConfigOption.CloudflareEmail]: string;
    [ConfigOption.CloudflareKey]: string;
    [ConfigOption.CloudflareIsEnabled]: boolean;
    [ConfigOption.DatabaseDir]: string;
    [ConfigOption.Ssl]: boolean;
    [ConfigOption.SslBundle]: string;
    [ConfigOption.SslCert]: string;
    [ConfigOption.SslPrivateKey]: string;
    [ConfigOption.StorageDir]: string;
    [ConfigOption.BlockchainIsEnabled]: boolean;
    [ConfigOption.BlockchainJobPostInterval]: number;
    [ConfigOption.BlockchainMnemonic]: string;
    [ConfigOption.BlockchainProviderUrl]: string;
    [ConfigOption.BlockchainRewardAmount]: string;
    [ConfigOption.BlockchainRewardInterval]: number;
    [ConfigOption.CachingRestartInterval]: number;
    [ConfigOption.CachingInterval]: number;
    [ConfigOption.CachingRemoveDelay]: number;
    [ConfigOption.CachingReturnedNodesCount]: number;
    [ConfigOption.CachingWhitelist]: string[];
    [ConfigOption.CachingAuto]: boolean;
    [ConfigOption.CachingInitialCopies]: number;
    [ConfigOption.CachingMaxDownloads]: number;
    [ConfigOption.CachingScaleEpsilon]: number;
    [ConfigOption.CachingLoadBound]: number;
    [ConfigOption.CachingOnlyToSucceededWebRTC]: boolean;
    [ConfigOption.WebRtcCheckSchedulerInterval]: number;
}
/* tslint:enable */

export class ConfigNotSetError extends Error {
    constructor(optionName: string) {
        super(`Configuration option '${optionName}' is not set.`);
    }
}

export class Config {
    constructor(private filePath: string = CONFIG_DEFAULT_PATH) {
        if (!fs.existsSync(this.filePath)) {
            const msg = `Failed to load configuration file=${this.filePath}.`;
            logger.error(msg);
            throw new Error(msg);
        }
        logger.config(`Loaded configuration file=${this.filePath}.`);
        this.settings = fs.readJsonSync(this.filePath);

        this.checkMandatory(ConfigOption.ApiAuthToken);
        this.checkMandatory(ConfigOption.ApiPort);
        this.checkMandatory(ConfigOption.MasterLocationCountryCode);
        this.checkMandatory(ConfigOption.MasterIp);
        this.checkMandatory(ConfigOption.CachingRestartInterval);
        this.checkMandatory(ConfigOption.CachingInterval);
        this.checkMandatory(ConfigOption.CachingRemoveDelay);
        this.checkMandatory(ConfigOption.ContentMaxDownloadSize);
        this.checkMandatory(ConfigOption.WebRtcCheckSchedulerInterval);
        this.checkMandatory(ConfigOption.CachingReturnedNodesCount);
        this.checkMandatory(ConfigOption.CachingWhitelist);
        this.checkMandatory(ConfigOption.CachingAuto);
        this.checkMandatory(ConfigOption.CachingInitialCopies);
        this.checkMandatory(ConfigOption.CachingMaxDownloads);
        this.checkMandatory(ConfigOption.CachingScaleEpsilon);
        this.checkMandatory(ConfigOption.CachingLoadBound);
        this.checkMandatory(ConfigOption.CachingOnlyToSucceededWebRTC);
        this.checkMandatory(ConfigOption.DataClusterHost);
        this.checkMandatory(ConfigOption.DataClusterQueueIntervalMs);
        this.checkMandatory(ConfigOption.DataClusterBandwidthQueueIntervalMs);
        this.checkMandatory(ConfigOption.DataClusterCheckNodeOnline);
        if (this.get(ConfigOption.BlockchainIsEnabled)) {
            this.checkMandatory(ConfigOption.BlockchainJobPostInterval);
            this.checkMandatory(ConfigOption.BlockchainMnemonic);
            this.checkMandatory(ConfigOption.BlockchainProviderUrl);
            this.checkMandatory(ConfigOption.BlockchainRewardAmount);
            this.checkMandatory(ConfigOption.BlockchainRewardInterval);
        }
        if (this.get(ConfigOption.ContentEncryptionIsEnabled)) {
            this.checkMandatory(ConfigOption.ContentEncryptionSecretSalt);
        }

        this.log(ConfigOption.BlockchainIsEnabled);
        this.log(ConfigOption.BlockchainJobPostInterval);
        this.log(ConfigOption.BlockchainRewardAmount);
        this.log(ConfigOption.BlockchainRewardInterval);
        this.log(ConfigOption.CloudflareIsEnabled);
        this.log(ConfigOption.MasterLocationCountryCode);
        this.log(ConfigOption.SystemUsageIsEnabled);
        this.log(ConfigOption.ContentEncryptionIsEnabled);
        this.log(ConfigOption.ContentMaxDownloadSize);
        this.log(ConfigOption.WebRtcCheckSchedulerInterval);
        this.log(ConfigOption.CachingReturnedNodesCount);
        this.log(ConfigOption.CachingWhitelist);
        this.log(ConfigOption.CachingAuto);
        this.log(ConfigOption.CachingMaxDownloads);
        this.log(ConfigOption.CachingOnlyToSucceededWebRTC);
        this.log(ConfigOption.DataClusterHost);
        this.log(ConfigOption.DataClusterQueueIntervalMs);
    }

    private settings: ConfigSettings;

    public get<TConfigOption extends ConfigOption>(option: TConfigOption): ConfigSettings[TConfigOption] {
        return this.settings[option];
    }

    private log<TConfigOption extends ConfigOption>(option: TConfigOption): void {
        logger.config(`Configuration option ${option}: ${this.get(option)}.`);
    }

    private checkMandatory<TConfigOption extends ConfigOption>(option: TConfigOption): void {
        if (this.get(option) == null) {
            throw new ConfigNotSetError(option);
        }
    }
}

export let config = new Config();
