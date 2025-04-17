const http = require("http");

// This configuration node specifies the controller's network parameters, e.g. IP address and port number.
// The configuration is used by other nodes in the flow to query or select the controller.
// The node can also query additional data from the controller and save it to the global context.
module.exports = function (RED) {
    function ControllerNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Retrieve configuration settings
        node.name = config.name;
        node.uniqueId = config.uniqueId;
        node.host = config.host;
        node.udpPort = config.udpPort;
        node.httpPort = config.httpPort;
        node.services = {}; // Will be populated dynamically
        node.channels = {}; // Will be populated dynamically
        node.status = {}; // Will be populated dynamically

        let lastStartupTs = 0; // Store the last startup timestamp
        const draftNodes = {}; // Store draft configurations here

        // Initialize global context to get and set values
        const globalAllStatesKey = `${node.uniqueId}_allstates`;
        const globalContext = node.context().global;

        // Endpoint to update draft configurations (i.e. not yet deployed)
        RED.httpAdmin.post("/fusebox/controllerNodeConfig", RED.auth.needsPermission("controller.write"), function (req, res) {
            const configData = req.body;

            node.debug(`Updating draft configuration for controller (${configData.uniqueId})...`);

            // Save configuration fields
            const id = configData.id;
            draftNodes[id] = configData;

            // Also try to query and save the controller data
            queryAllControllerData(draftNodes[id]);

            res.status(200).send();
        });

        // Define HTTP endpoint to serve the controller node's configuration
        RED.httpAdmin.get("/fusebox/controllerNodeConfig", RED.auth.needsPermission(["controller.read"]), function (req, res) {
            const nodeId = req.query.id; // Get the node ID from the query parameters

            // Get specific controller node or list all available controller nodes
            if (nodeId) {
                const configNode = draftNodes[nodeId] || RED.nodes.getNode(nodeId);

                if (configNode) {
                    const { id, name, uniqueId, host, udpPort, httpPort, services, channels, status } = configNode;
                    res.json({ id, name, uniqueId, host, udpPort, httpPort, services, channels, status });
                } else {
                    res.status(404).json({ error: "Controller not found" });
                }
            } else {
                let configNodes = [];

                RED.nodes.eachNode(function (n) {
                    if (n.type === "fusebox-controller") {
                        configNodes.push(n);
                    }
                });

                const controllers = configNodes.map((node) => ({
                    id: node.id,
                    name: node.name,
                    uniqueId: node.uniqueId,
                    host: node.host,
                    udpPort: node.udpPort,
                    httpPort: node.httpPort,
                    services: node.services,
                    channels: node.channels,
                    status: node.status,
                }));

                res.json({ controllers });
            }
        });

        // Set an interval to check the controller status every 1 minute (60000 milliseconds)
        const intervalId = setInterval(queryAllControllerData, 60000);

        // Fetch additional data on initialization
        queryAllControllerData();

        // Clear the interval on node close or re-deploy
        node.on("close", function () {
            node.debug("Clearing controller data query interval...");
            clearInterval(intervalId);
        });

        // Function to re-execute the code
        function queryAllControllerData(draftNode = null) {
            queryStatus(draftNode)
                .then((status) => {
                    const newStartupTs = status.startup_ts;

                    // Check if the program has restarted, in which case we need to re-query the data
                    if (newStartupTs > lastStartupTs || draftNode) {
                        lastStartupTs = newStartupTs;

                        const uniqueId = draftNode?.uniqueId || node.uniqueId;

                        node.debug(`Querying data for controller (${uniqueId})...`);

                        // Query all data by chaining promises
                        Promise.all([
                            queryServices(draftNode),
                            queryAllStates(draftNode),
                            querySqlChannels("aicochannels", draftNode),
                            querySqlChannels("aochannels", draftNode),
                            querySqlChannels("dichannels", draftNode),
                            querySqlChannels("dochannels", draftNode),
                        ])
                            .then(() => {
                                node.debug("All queries completed successfully!");

                                formatChannels(draftNode);
                            })
                            .catch((error) => {
                                node.error(`Error fetching one or more controller (${uniqueId}) endpoints: ${error}`, error);
                            });
                    }
                })
                .catch((error) => {
                    node.error(`Error fetching controller status: ${error}`, error);
                });
        }

        // Create a comprehensive object of all channels
        // Structure: { ABCW: { 1: {regtype: "h", ....} , 2: {...} } }
        function formatChannels(draftNode = null) {
            const result = {};
            const configuredNode = draftNode || node;

            function addInput(input, type) {
                const key = input.val_reg;
                const index = parseInt(input.member);

                result[key] = result[key] || {};
                result[key][index] = input;

                // Additional properties
                result[key][index]._type = type;
                result[key][index]._output = false;
            }

            function addOutput(output, inputs) {
                for (const input of inputs) {
                    if (input.mbi == output.mbi && input.mba == output.mba && input.regadd == output.regadd) {
                        const key = input.val_reg;
                        const index = parseInt(input.member);

                        result[key][index]._output = true;
                        break;
                    }
                }
            }

            // Add AI and DI channels to the object
            for (const obj of configuredNode.aicochannels) {
                addInput(obj, "analogue");
            }

            for (const obj of configuredNode.dichannels) {
                addInput(obj, "discrete");
            }

            // Modify the existing channels to include output properties
            for (const obj of configuredNode.aochannels) {
                addOutput(obj, configuredNode.aicochannels);
            }

            for (const obj of configuredNode.dochannels) {
                addOutput(obj, configuredNode.dichannels);
            }

            if (draftNode) {
                draftNode.channels = result;
            } else {
                node.channels = result;
            }
        }

        // Method to query additional data via HTTP
        function httpQuery(options = {}) {
            return new Promise((resolve, reject) => {
                node.debug(`Querying HTTP: ${JSON.stringify(options)}`);

                const req = http.request(options, (res) => {
                    let data = "";

                    res.on("data", (chunk) => {
                        data += chunk;
                    });

                    res.on("end", () => {
                        try {
                            const parsedData = JSON.parse(data);

                            if (parsedData?.success === false) {
                                node.error(`Failed to query data: ${parsedData?.message}`);
                                reject(parsedData?.message);
                                return;
                            }

                            resolve(parsedData);
                        } catch (error) {
                            node.error(`Failed to parse HTTP response: ${error}`, { error });
                            reject(error);
                        }
                    });
                });

                req.on("error", (error) => {
                    node.error(`HTTP request error: ${error}`, { error });
                    reject(error);
                });

                req.end();
            });
        }

        async function queryStatus(draftNode = null) {
            const options = {
                hostname: draftNode?.host || node.host,
                port: draftNode?.httpPort || node.httpPort,
                path: "/program-status?minimal=true",
                method: "GET",
            };

            const parsedData = await httpQuery(options);

            // Update node property
            if (draftNode) {
                draftNode.status = parsedData;
            } else {
                node.status = parsedData;
            }

            return parsedData;
        }

        async function queryServices(draftNode = null) {
            const options = {
                hostname: draftNode?.host || node.host,
                port: draftNode?.httpPort || node.httpPort,
                path: "/services.json",
                method: "GET",
            };

            const parsedData = await httpQuery(options);
            const services = parsedData[0].services;

            // Update node property
            if (draftNode) {
                draftNode.services = services;
            } else {
                node.services = services;
            }

            return services;
        }

        async function queryAllStates(draftNode = null) {
            const options = {
                hostname: draftNode?.host || node.host,
                port: draftNode?.httpPort || node.httpPort,
                path: "/allstates",
                method: "GET",
            };

            const parsedData = await httpQuery(options);

            const localhost = Object.keys(parsedData)[0];
            const allStates = {};

            // Parse the data
            for (const key in parsedData[localhost]) {
                if (parsedData[localhost].hasOwnProperty(key)) {
                    const obj = {
                        values: parsedData[localhost][key].v ?? parsedData[localhost][key].values,
                        status: parsedData[localhost][key].s ?? parsedData[localhost][key].status,
                        timestamp: parsedData[localhost][key].t ?? parsedData[localhost][key].timestamp,
                    };

                    allStates[key] = obj;
                }
            }

            // Update global context and node property
            if (draftNode) {
                draftNode.allStates = allStates;
            } else {
                globalContext.set(globalAllStatesKey, allStates);
                node.allStates = allStates;
            }

            return allStates;
        }

        async function querySqlChannels(tableName, draftNode = null) {
            const options = {
                hostname: draftNode?.host || node.host,
                port: draftNode?.httpPort || node.httpPort,
                path: `/sql2json?table=${tableName}`,
                method: "GET",
            };

            const parsedData = await httpQuery(options);

            // Update node property
            if (draftNode) {
                draftNode[tableName] = parsedData;
            } else {
                node[tableName] = parsedData;
            }

            return parsedData;
        }
    }

    RED.nodes.registerType("fusebox-controller", ControllerNode);
};
