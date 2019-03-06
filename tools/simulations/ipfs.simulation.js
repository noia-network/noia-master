const ipfs = require("../content-protocols/ipfs");
const logger = require("../logger");
const contentManager = require("../content-manager");
const DB = require("../db");

Promise.all([DB.setup(), ipfs.setup()]).then(data => {
    ipfs.download("QmYQcaMVJxBDzRkabRFYJrGoAiUv4p3xgUR4ZqjLLhjciH");
    ipfs.on("error", err => {
        logger.error("Err: ", err);
    });
    ipfs.on("download", file_path => {
        logger.info("File Downloaded: ", file_path);

        contentManager.setupLocalFile(file_path);
    });

    // Then file downloaded / prepared
    contentManager.on("downloaded", function(info) {
        logger.debug("File downloaded: ", info);
    });
});
