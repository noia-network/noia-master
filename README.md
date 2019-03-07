# How to run

## Setup

Install dependencies:

    npm install

Create `config.json` from `config.example.json`:

    cp config.example.json config.json

Start master:

    npm run start

## Updating geoip data

After `npm install`

    node ./node_modules/geoip-lite/scripts/updatedb.js

## Config `config.json` options

| key                              | value          | Description                                                               |
| -------------------------------- | -------------- | ------------------------------------------------------------------------- |
| api.port                         | number         | API port address.                                                         |
| api.authToken                    | string         | API secret auth token. API endpoint: /nodes?authToken=<api.authToken>.    |
| proxyControlAddress              | string         | See: https://github.com/noia-network/webrtc-direct/tree/master/api-proxy. |
| master.domain                    | string         | Master domain name (ex: "master-domain.com").                             |
| master.host                      | string         | Master host address (ex: "0.0.0.0").                                      |
| master.id                        | string         | Master id.                                                                |
| master.ip                        | string         | Master public IP.                                                         |
| master.isPrivate                 | boolean        | Private masters accept only internal nodes connetions.                    |
| master.location.countryCode      | string         | Master location country code (ex: "GB").                                  |
| master.version                   | string         | Master version.                                                           |
| node.version                     | string         | Pattern to determine if connecting node version is acceptable (ex: "1.")  |
| content.encryption.isEnabled     | boolean        | Indicates if encryption is enabled.                                       |
| content.encryption.secretSalt    | boolean        | Secret encryption salt.                                                   |
| content.maxDownloadSize          | string         | Maximum cachable content size in bytes.                                   |
| system.usage.interval            | number         | System usage refresh interval                                             |
| system.usage.isEnabled           | boolean        | Indicates if system usage is displayed.                                   |
| dataCluster.host                 | string         | Data cluster address (ex: "ws://data-cluster.master.com:port")            |
| dataCluster.queueIntervalMs      | number         | 100                                                                       |
| dataCluster.checkNodeOnline      | boolean        | Additional check against multiple nodes connecting with same nodeId.      |
| protocols.ws.api.isSecure        | boolean        | Indicates if SSL should be used.                                          |
| protocols.ws.api.port            | number         | API port number.                                                          |
| protocols.ws.client.isSecure     | boolean        | Indicates if SSL should be used.                                          |
| protocols.ws.client.port         | number         | Client port number.                                                       |
| protocols.ws.controller.isSecure | boolean        | Indicates if SSL should be used.                                          |
| protocols.ws.controller.port     | number         | Controller port number.                                                   |
| protocols.ws.node.isSecure       | boolean        | Indicates if SSL should be used.                                          |
| protocols.ws.node.port           | number         | Node port number.                                                         |
| cloudflare.domain                | string         | Cloudflare domain.                                                        |
| cloudflare.email                 | string         | Cloudflare email.                                                         |
| cloudflare.key                   | string         | Cloudflare key.                                                           |
| cloudflare.isEnabled             | boolean        | Is cloudflare enabled.                                                    |
| database.dir                     | string         | Master database directory (ex: "./data").                                 |
| database.name                    | string         | Master database name (ex: "master.db").                                   |
| ssl                              | boolean        | Indicates if SSL should be used.                                          |
| ssl.bundle                       | string         | SSL bundle path.                                                          |
| ssl.cert                         | string         | SSL cert path.                                                            |
| ssl.privateKey                   | string         | SSL private key path.                                                     |
| blockchain.mnemonic              | string         | Blockchain mnemonic.                                                      |
| blockchain.providerUrl           | string         | Blockchain provider url.                                                  |
| blockchain.jobPostInterval       | number         | Blockchain job posting interval.                                          |
| blockchain.rewardInterval        | number         | Blockchain reward interval.                                               |
| blockchain.rewardAmount          | string         | Blockchain reward amount.                                                 |
| blockchain.isEnabled             | boolean        | Is blockchain enabled.                                                    |
| caching.interval                 | number         | Caching interval .                                                        |
| caching.removeDelay              | number         | Caching removing delay.                                                   |
| caching.returnedNodesCount       | number         | Nodes returned to SDK count.                                              |
| caching.whitelist                | array\<string> | Whitelisted domains. To whitelist all domains use ["*"].                  |
| caching.auto                     | boolean        | Is auto caching enabled.                                                  |
| caching.maxDownloads             | number         | Maximum concurrent downloads.                                             |
| caching.onlyToSucceededWebRtc    | boolean        | Indicates if WebRTC check should be performed.                            |
| webrtc.checkSchedulerInterval    | number         | WebRTC check internal scheduling interval.                                |
