# How to run

## Setup

1. Install dependencies:

    npm install

2. Create `config.json` from `config.example.json`
3. Start master:

    npm run start

## Updating geoip data

After `npm install`

    node ./node_modules/geoip-lite/scripts/updatedb.js
