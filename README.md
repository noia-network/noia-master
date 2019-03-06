# How to run

## Setup

1. npm install
2. create config.json from config.example.json

## Update geoip data

After `npm install`

    node ./node_modules/geoip-lite/scripts/updatedb.js

## Run

Run `without debug`

> node index.js

Run `with debug`

> DEBUG_LEVEL=5 node index.js

### Debug levels

1. Error
2. Error, Warn
3. Error, Warn, Info
4. Error, Warn, Info, Debug, Table
5. Error, Warn, Info, Debug, Table, Verbose

## config.json

```
{
    "masterId": "master-**",
    "is_private": false,
    "master_version": "0.0.1",
    "node_version": "0.1",
    "host": "xx.xx.xx.xx",
    "domain": "domain.sss",
    "transfer": {
        "encryption": true
    },
    "system": {
        "usage": {
            "status": true,
            "interval": 60000
        }
    },
    "protocols": {
        "ws": {
            "status": true,
            "node": {
                "port": 6565,
                "secure": false
            },
            "client": {
                "port": 6566,
                "secure": true
            },
            "api": {
                "port": 6568,
                "secure": false
            }
        },
        "udp": {
            "status": false
        },
        "tcp": {
            "status": false
        }
    },
    "cloudflare": {
        "status": false,
        "domain": "",
        "email": "",
        "key": ""
    },
    "database": {
        "dir": "./",
        "name": "masterData.db"
    },
    "ssl": {
        "cert": "/full/path.crt",
        "private_key": "/full/path.key",
        "bundle": "/full/path.ca"
    },
    "blockchain": {
        "status": true,
        "mnemonic": "xxxxxxxxxxxxxxx",
        "provider_url": ""
    }
}
```
