const contentManager = require("../content-manager");

it("conentManager: download test", done => {
    const cm = contentManager;
    cm.download("https://pre00.deviantart.net/68d1/th/pre/f/2015/098/e/9/woof_woof_wats_for_lunch_lol_by_luxrayys-d8ozs40.png");
    cm.on("downloaded", function(data) {
        done();
    });
});

it(
    "conentManager: download queue test",
    done => {
        let queueNr = 0;
        const cm = contentManager;
        cm.download("https://pre00.deviantart.net/68d1/th/pre/f/2015/098/e/9/woof_woof_wats_for_lunch_lol_by_luxrayys-d8ozs40.png");
        cm.download("https://pre00.deviantart.net/68d1/th/pre/f/2015/098/e/9/woof_woof_wats_for_lunch_lol_by_luxrayys-d8ozs40.png");
        cm.on("downloaded", function(data) {
            queueNr++;
            console.log("queue " + queueNr);
            if (queueNr == 2) {
                done();
            }
        });
    },
    10 * 1000
);

it(
    "conentManager: download queue test 2 (long queue)",
    done => {
        let queueNr = 0;
        const cm = contentManager;
        cm.download("https://pre00.deviantart.net/68d1/th/pre/f/2015/098/e/9/woof_woof_wats_for_lunch_lol_by_luxrayys-d8ozs40.png");
        cm.download("https://pre00.deviantart.net/189c/th/pre/f/2015/139/c/8/dog_adop_ota_closed___by_luxrayys-d8ta6r1.png");
        cm.download("https://orig00.deviantart.net/d319/f/2016/144/8/d/ych_auction_closed_by_luxrayys-da39t2v.png");
        cm.download("https://orig00.deviantart.net/440d/f/2016/179/f/f/serbia_by_luxrayys-da80scm.png");
        cm.download("https://orig00.deviantart.net/cfee/f/2012/358/9/1/space_by_aloneinspace-d5oznhy.png");
        cm.on("downloaded", function(data) {
            queueNr++;
            console.log("Downloaded: " + queueNr);
        });
        cm.on("finished", function() {
            console.log("Total downlods: " + queueNr);
            done();
        });
    },
    10 * 1000
);
