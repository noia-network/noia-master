const WebSocket = require("ws");
const config = require("../config");
const Wire = require("noia-protocol");

describe("node tests", () => {
    const wss = config.get("protocols").ws.node.secure ? "wss" : "ws";
    const port = config.get("protocols").ws.node.port;
    const host = config.get("host");

    it("handshake test", done => {
        let ws = new WebSocket(wss + "://" + host + ":" + port + "/");
        let wire = new Wire(ws);
        wire.handshake("test-123", "host", "port", "wallet");
        wire.on("handshake", () => {
            wire.on("error", () => {
                done();
            });
            wire.on("closed", () => {
                done();
            });
            wire.close();
        });
    });

    it("seeding test", done => {
        let ws = new WebSocket(wss + "://" + host + ":" + port + "/");
        let wire = new Wire(ws);
        wire.handshake("test-1", "host", "port", "wallet");
        wire.on("handshake", () => {
            wire.seeding(["edaf4897920779db74102cc57accce77a003069f", "b69f4c1822da38e7c6c3c1b5cd57bb5191e9f3b6"]);

            setTimeout(() => {
                wire.on("error", () => {
                    done();
                });
                wire.on("closed", () => {
                    done();
                });
                wire.close();
            }, 1500);
        });
    });

    it("uploaded test", done => {
        let ws = new WebSocket(wss + "://" + host + ":" + port + "/");
        let wire = new Wire(ws);
        wire.handshake("test-123", "host", "port", "wallet");
        wire.on("handshake", () => {
            wire.uploaded((infoHash = "123123213123"), (size = 100), (ip = "0.0.0.0"));

            setTimeout(() => {
                wire.on("error", () => {
                    done();
                });
                wire.on("closed", () => {
                    done();
                });
                wire.close();
            }, 1000);
        });
    });

    it("requested test", done => {
        let ws = new WebSocket(wss + "://" + host + ":" + port + "/");
        let wire = new Wire(ws);
        wire.handshake("test-123", "host", "port", "wallet");
        wire.on("handshake", () => {
            wire.requested((piece = 1), (infiHash = "123123123"));

            setTimeout(() => {
                wire.on("error", () => {
                    done();
                });
                wire.on("closed", () => {
                    done();
                });
                wire.close();
            }, 1000);
        });
    });

    it.only(
        "many nodes connection test",
        done => {
            const total_nodes = 100;
            const nodesShutdownTime = 5 * 1000;
            const check_time = 500 + nodesShutdownTime;
            let total_shutDowns = 0;
            const wire = [];
            for (let i = 1; i <= total_nodes; i++) {
                (function(ws) {
                    const wire = new Wire(
                        ws,
                        "bebenciukas-node",
                        {
                            info: {
                                interface: "terminal",
                                node_ip: "0.0.0.0",
                                node_ws_port: Math.random(3000),
                                storage: 1024 * 1024 * 100 // Megabytes
                            }
                        },
                        (msgFrom, msgSignedFrom) => {
                            return new Promise((resolve, reject) => {
                                resolve(true);
                            });
                        },
                        i,
                        "0.1.0"
                    );

                    wire.on("handshake", () => {
                        setTimeout(() => {
                            wire.once("closed", info => {
                                total_shutDowns++;
                                console.log("Shutdown node[" + total_shutDowns + "]", info);
                            });
                            wire.close();
                        }, nodesShutdownTime);

                        setTimeout(() => {
                            if (total_shutDowns == total_nodes) done();
                            else console.log("KAZKAS NEVEIK: ", total_shutDowns);
                        }, check_time);
                    });
                })(new WebSocket(wss + "://" + host + ":" + port + "/"));
            }
        },
        10 * 1000
    );
});
