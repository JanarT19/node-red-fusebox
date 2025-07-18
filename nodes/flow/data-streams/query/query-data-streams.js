const dgram = require("dgram");
const http = require("http");

// This custom Node-RED node will establish either a UDP or HTTP connection depending on the protocol selected by the user.
// The received data will be parsed, formatted, and saved into the global context.
// Once the data is received, the node will emit a message with the data.
// The node will also emit a status message to indicate the status of the connection.
module.exports = function (RED) {
    function QueryDataStreamsNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Retrieve configuration settings
        node.name = config.name;
        node.protocol = config.protocol;
        node.queryInterval = config.queryInterval;

        // Retrieve the config node's settings
        node.controller = RED.nodes.getNode(config.controller);

        // Validate the controller configuration
        if (!node.controller || !node.controller.host || (!node.controller.httpPort && !node.controller.udpPort)) {
            node.error("Controller configuration invalid");
            node.status({ fill: "red", shape: "dot", text: "Controller configuration invalid" });
            return;
        }

        if (!node.controller.filteredServices) {
            node.status({ fill: "grey", shape: "dot", text: "Loading controller configuration" });
            return;
        }

        // Initialize global context to get and set values
        const outputContextKey = `${node.controller.uniqueId}_output_states`;
        const globalContext = node.context().global;

        // UDP Connection
        if (node.protocol === "UDP") {
            const server = dgram.createSocket("udp4");

            server.bind(node.controller.udpPort, node.controller.host);
            node.status({ fill: "yellow", shape: "dot", text: "Listening on UDP" });

            server.on("message", (message) => {
                try {
                    const data = JSON.parse(message);

                    // Check message format
                    if (!data || typeof data !== "object") return;

                    const key = Object.keys(data)?.[0];

                    // Check object format
                    if (!key || !data[key] || !data[key]?.values) return;

                    const obj = {
                        values: data[key].values ?? data[key].v,
                        status: data[key].status ?? data[key].s,
                        timestamp: data[key].timestamp ?? data[key].t ?? Math.floor(Date.now() / 1000)
                    };

                    const payload = { [key]: obj };

                    // In case of output data streams, save them in the global context
                    const writableServices = node.controller.writableServices;

                    if (writableServices?.[key]) {
                        const outputContext = globalContext.get(outputContextKey) || {};
                        outputContext[key] = obj;

                        globalContext.set(outputContextKey, outputContext);
                    }

                    node.status({ fill: "green", shape: "dot", text: `UDP data received (${formatDate()})` });
                    node.send({
                        controller: { id: node.controller.id, uniqueId: node.controller.uniqueId, protocol: node.protocol, host: node.controller.host },
                        payload: payload
                    });
                } catch (error) {
                    node.error(`Failed to parse UDP message: ${error}`, { error });

                    node.status({ fill: "red", shape: "dot", text: "UDP error" });
                }
            });

            server.on("error", (error) => {
                node.error(`UDP error: ${error}`, { error });

                node.status({ fill: "red", shape: "dot", text: "UDP error" });
                server.close();
            });

            node.on("close", function (done) {
                server.close(done);
            });
        }

        // HTTP Connection
        if (node.protocol === "HTTP") {
            let firstQuery = true;

            function queryHTTP() {
                const path = firstQuery ? "/allstates" : "/states";
                firstQuery = false;

                const options = {
                    hostname: node.controller.host,
                    port: node.controller.httpPort,
                    path: path,
                    method: "GET"
                };

                // node.debug(`Querying HTTP: ${JSON.stringify(options)}`);

                const req = http.request(options, (res) => {
                    let data = "";

                    res.on("data", (chunk) => {
                        data += chunk;
                    });

                    res.on("end", () => {
                        try {
                            // node.debug(`Received HTTP message: ${data}`);
                            node.status({ fill: "green", shape: "dot", text: `HTTP data received (${formatDate()})` });

                            const parsedData = JSON.parse(data);
                            const localhost = Object.keys(parsedData)[0];

                            for (const key in parsedData[localhost]) {
                                if (parsedData[localhost].hasOwnProperty(key)) {
                                    const obj = {
                                        values: parsedData[localhost][key].v ?? parsedData[localhost][key].values,
                                        status: parsedData[localhost][key].s ?? parsedData[localhost][key].status,
                                        timestamp: parsedData[localhost][key].t ?? parsedData[localhost][key].timestamp
                                    };

                                    const payload = { [key]: obj };

                                    node.send({
                                        controller: { id: node.controller.id, uniqueId: node.controller.uniqueId, protocol: node.protocol, host: node.controller.host },
                                        payload: payload
                                    });
                                }
                            }
                        } catch (error) {
                            node.error("Failed to parse HTTP response", { error });
                            node.error(error);

                            node.status({ fill: "red", shape: "dot", text: "HTTP parse error" });
                        }
                    });
                });

                req.on("error", (error) => {
                    node.error(`HTTP request error: ${error}`, { error });

                    node.status({ fill: "red", shape: "dot", text: "HTTP request error" });
                    firstQuery = true;
                });

                req.end();
            }

            // Query immediately and then periodically
            queryHTTP();
            const interval = setInterval(queryHTTP, node.queryInterval * 1000);

            node.status({ fill: "yellow", shape: "dot", text: `Querying HTTP every ${node.queryInterval} seconds` });

            node.on("close", function (done) {
                clearInterval(interval);
                done();
            });
        }

        // Format the current date and time as DD/MM/YYYY HH:MM:SS
        function formatDate() {
            const now = new Date();

            const options = {
                day: "2-digit",
                month: "2-digit",
                year: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: false // Use 24-hour format
            };

            return now.toLocaleString("en-GB", options); // 'en-GB' locale for DD/MM/YYYY format
        }
    }

    RED.nodes.registerType("fusebox-query-data-streams", QueryDataStreamsNode);
};
