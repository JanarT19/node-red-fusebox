const http = require("http");

// This configuration node specifies the controller's network parameters, e.g. IP address and port number.
// The configuration is used by other nodes in the flow to query or select the controller.
// The node queries additional data about the controller and save it to its properties.
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

        // All variables below will be populated dynamically

        // Queried from the controller via HTTP
        node.services = {};
        node.allStates = {};
        node.channels = {};
        node.status = {};

        // Derived from the queried data
        node.filteredServices = {};
        node.writableServices = {};

        // Read and write nodes that are associated with this controller
        node.relatedNodes = {};
        node.formattedTopics = [];

        // Other miscellaneous variables below

        // Store the last startup timestamp
        let lastStartupTs = 0;

        // Store draft configurations here (e.g. oneditsave)
        const draftNodes = {};

        node.debug(`Controller configuration node started with uniqueId: ${node.uniqueId}`);

        // Endpoint to update draft configurations (i.e. not yet deployed)
        // PS. Draft configuration(s) will be cleared on controller configuration node re-deploy
        RED.httpAdmin.post("/fusebox/controllerNodeConfig", RED.auth.needsPermission("controller.write"), function (req, res) {
            const configData = req.body;

            node.debug(`Updating draft configuration for controller (${configData.uniqueId})...`);

            // Save draft configuration
            const controllerId = configData.id;
            draftNodes[controllerId] = configData;

            // Query, parse, and save the rest of the controller's variables
            queryAllControllerData(draftNodes[controllerId]);

            res.status(200).send();
        });

        // Define HTTP endpoint to serve the controller node's configuration
        RED.httpAdmin.get("/fusebox/controllerNodeConfig", RED.auth.needsPermission("controller.read"), function (req, res) {
            const controllerId = req.query.id; // Get the node ID from the query parameters

            // Get specific controller node or list all available controller nodes
            if (controllerId) {
                const configNode = draftNodes[controllerId] || RED.nodes.getNode(controllerId);

                // Edge case: always keep related nodes up to date
                filterRelatedNodes(configNode);
                formatRelatedNodeTopics(configNode);

                if (configNode) {
                    const {
                        id,
                        name,
                        uniqueId,
                        host,
                        udpPort,
                        httpPort,

                        services,
                        allStates,
                        channels,
                        status,

                        filteredServices,
                        writableServices,

                        relatedNodes,
                        formattedTopics
                    } = configNode;
                    res.json({
                        id,
                        name,
                        uniqueId,
                        host,
                        udpPort,
                        httpPort,

                        services,
                        allStates,
                        channels,
                        status,

                        filteredServices,
                        writableServices,

                        relatedNodes,
                        formattedTopics
                    });
                } else {
                    res.status(404).json({ error: "Controller not found" });
                }
            } else {
                let configNodes = [];

                RED.nodes.eachNode(function (n) {
                    if (n.type === "fusebox-controller") {
                        // If the node is a draft, use the draft configuration
                        const configNode = draftNodes[n.id] || RED.nodes.getNode(n.id);

                        // Edge case: always keep related nodes up to date
                        filterRelatedNodes(configNode);
                        formatRelatedNodeTopics(configNode);

                        configNodes.push(configNode);
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
                    allStates: node.allStates,
                    channels: node.channels,
                    status: node.status,

                    filteredServices: node.filteredServices,
                    writableServices: node.writableServices,
                    relatedNodes: node.relatedNodes,
                    formattedTopics: node.formattedTopics
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

            node.debug(`Clearing controller draft configuration for id ${node.id}`);
            delete draftNodes[node.id];
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
                            querySqlChannels("dochannels", draftNode)
                        ])
                            .then(() => {
                                node.debug("All queries completed successfully!");

                                formatChannels(draftNode);
                                filterUsedServices(draftNode);
                                filterOutputServices(draftNode);
                                filterRelatedNodes(draftNode);
                                formatRelatedNodeTopics(draftNode);
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

            function addOutput(output, inputs, type) {
                for (const input of inputs) {
                    if (input.mbi == output.mbi && input.mba == output.mba && input.regadd == output.regadd && (type === "discrete" ? input.bit == output.bit : true)) {
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
                addOutput(obj, configuredNode.aicochannels, "analogue");
            }

            for (const obj of configuredNode.dochannels) {
                addOutput(obj, configuredNode.dichannels, "discrete");
            }

            if (draftNode) {
                draftNode.channels = result;
            } else {
                node.channels = result;
            }
        }

        // Filter services to include only those keys which are mentioned in /allstates
        // Same format as that of services
        function filterUsedServices(draftNode = null) {
            const configuredNode = draftNode || node;

            // Format: { key: {values: [], status: int, timestamp: int} }
            const allStates = configuredNode.allStates;

            // Format: { key: { servicename: "", desc: [], ... } }
            const services = configuredNode.services;

            const allStateseKeys = Object.keys(allStates);
            const servicesKeys = Object.keys(services);
            const filteredKeys = allStateseKeys.filter((key) => servicesKeys.includes(key));

            // Filter the services based on the keys
            const result = filteredKeys.reduce((acc, key) => {
                acc[key] = services[key];
                return acc;
            }, {});

            if (draftNode) {
                draftNode.filteredServices = result;
            } else {
                node.filteredServices = result;
            }
        }

        // Only certain services and members are allowed to be written to.
        // Retrieve the members and descriptions of the allowed services.
        // Requirements:
        // 1. all regtype "s" and "s!" members
        // 2. all chantype "mb" members and (regtype "h" or "c") and (mbi,mba,regadd existing in output table)
        // Structure: { key: [1, 2, ...] }
        function filterOutputServices(draftNode = null) {
            const configuredNode = draftNode || node;

            // Format: { key: { 1: { regtype: "h", chantype: "mb", ... }, 2: {...} } }
            const channels = configuredNode.channels;

            const result = {};

            // 1
            for (const key in channels) {
                const channel = channels[key];

                for (index in channel) {
                    const member = channel[index];
                    const indexInt = parseInt(index);

                    if (["s", "s!"].includes(member.regtype)) {
                        result[key] = result[key] || [];

                        if (!result[key].includes(indexInt)) {
                            result[key].push(indexInt);
                        }
                    }
                }
            }

            // 2
            for (const key in channels) {
                const channel = channels[key];

                for (index in channel) {
                    const member = channel[index];
                    const indexInt = parseInt(index);

                    if (member.chantype === "mb" && ["h", "c"].includes(member.regtype) && member._output) {
                        result[key] = result[key] || [];

                        if (!result[key].includes(indexInt)) {
                            result[key].push(indexInt);
                        }
                    }
                }
            }

            if (draftNode) {
                draftNode.writableServices = result;
            } else {
                node.writableServices = result;
            }
        }

        // Retrieve the configurations of related nodes (e.g. read and write nodes) that are associated with this controller.
        // Structure: { id: { type: "fusebox-static-read", mappings: [{ keyNameSelect, keyNameManual, index, topic }] } }
        function filterRelatedNodes(draftNode = null) {
            const configuredNode = draftNode || node;
            const result = {};

            // Iterate over all nodes and find those that are related to this controller
            RED.nodes.eachNode(function (n) {
                if (n.type === "fusebox-read-static-data-streams" || n.type === "fusebox-write-static-data-streams") {
                    // Check if the node is related to this controller
                    if (n.controller === configuredNode.id) {
                        // Create a mapping for the node
                        const mappings = n.mappings.map((row) => {
                            const key = row.keyNameSelect || row.keyNameManual;
                            const member = row.index;
                            const topic = row.topic;

                            return { key, member, topic };
                        });

                        result[n.id] = {
                            type: n.type,
                            mappings: mappings
                        };
                    }
                }
            });

            if (draftNode) {
                draftNode.relatedNodes = result;
            } else {
                node.relatedNodes = result;
            }
        }

        // Format the related nodes' topics for the controller node
        // Structure: [ { key: "ABC", member: 1, topic: test/1, label: ... } ]
        function formatRelatedNodeTopics(draftNode = null) {
            const configuredNode = draftNode || node;
            const result = [];

            const filteredServices = configuredNode.filteredServices;
            const channels = configuredNode.channels;

            // Iterate over all related nodes
            for (const nodeId in configuredNode.relatedNodes) {
                const relatedNodeMappings = configuredNode?.relatedNodes?.[nodeId]?.mappings || [];

                // Iterate over all mappings
                for (const mapping of relatedNodeMappings) {
                    const key = mapping.key;
                    const member = mapping.member;
                    const topic = mapping.topic;

                    const keyDesc = filteredServices?.[key]?.servicename || null;
                    const memberDesc = channels?.[key]?.[member]?.desc || null;

                    let label = topic;
                    if (keyDesc && memberDesc) label += `: ${keyDesc} (${memberDesc})`;

                    // Check unique label
                    if (!result.some((obj) => obj.label === label)) {
                        result.push({ key, member, topic, label });
                    }
                }
            }

            if (draftNode) {
                draftNode.formattedTopics = result;
            } else {
                node.formattedTopics = result;
            }
        }

        // Method to query additional data via HTTP
        function httpQuery(options = {}, retries = 4) {
            const retryTimes = [1000, 5000, 30000, 60000]; // Retry intervals in milliseconds
            const retryTime = retryTimes[4 - retries];

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

                            if (parsedData?.success === true || parsedData) {
                                // Successful response
                                resolve(parsedData);
                            } else {
                                // Unsuccessful response
                                if (retries > 0) {
                                    node.warn(`Retrying... (${retries} attempts left)`);

                                    setTimeout(() => {
                                        resolve(httpQuery(options, retries - 1));
                                    }, retryTime);
                                } else {
                                    node.error(`Failed to query data: ${parsedData?.message}`);

                                    resolve(false);
                                }
                            }
                        } catch (error) {
                            node.error(`Failed to parse HTTP response: ${error}`, { error });

                            // Retry if necessary
                            if (retries > 0) {
                                node.warn(`Retrying... (${retries} attempts left)`);

                                setTimeout(() => {
                                    resolve(httpQuery(options, retries - 1));
                                }, retryTime);
                            } else {
                                node.error(`Failed to parse HTTP response: ${error}`, { error });
                                reject(error);
                            }
                        }
                    });
                });

                req.on("error", (error) => {
                    node.error(`HTTP request error: ${error}`, { error });

                    // Retry if necessary
                    if (retries > 0) {
                        node.warn(`Retrying... (${retries} attempts left)`);

                        setTimeout(() => {
                            resolve(httpQuery(options, retries - 1));
                        }, retryTime);
                    } else {
                        node.error(`HTTP request error: ${error}`, { error });
                        reject(error);
                    }
                });

                req.end();
            });
        }

        async function queryStatus(draftNode = null) {
            const options = {
                hostname: draftNode?.host || node.host,
                port: draftNode?.httpPort || node.httpPort,
                path: "/program-status?minimal=true",
                method: "GET"
            };

            try {
                const parsedData = await httpQuery(options);

                if (draftNode) {
                    draftNode.status = parsedData;
                } else {
                    node.status = parsedData;
                }

                return parsedData;
            } catch (error) {
                console.error("queryStatus failed:", error);
                throw error; // Propagate the error to be handled by the caller
            }
        }

        async function queryServices(draftNode = null) {
            const options = {
                hostname: draftNode?.host || node.host,
                port: draftNode?.httpPort || node.httpPort,
                path: "/services.json",
                method: "GET"
            };

            try {
                const parsedData = await httpQuery(options);
                const services = parsedData[0].services;

                // Update node property
                if (draftNode) {
                    draftNode.services = services;
                } else {
                    node.services = services;
                }

                return services;
            } catch (error) {
                console.error("queryServices failed:", error);
            }
        }

        async function queryAllStates(draftNode = null) {
            const options = {
                hostname: draftNode?.host || node.host,
                port: draftNode?.httpPort || node.httpPort,
                path: "/allstates",
                method: "GET"
            };

            try {
                const parsedData = await httpQuery(options);

                const localhost = Object.keys(parsedData)[0];
                const allStates = {};

                // Parse the data
                for (const key in parsedData[localhost]) {
                    if (parsedData[localhost].hasOwnProperty(key)) {
                        const obj = {
                            values: parsedData[localhost][key].v ?? parsedData[localhost][key].values,
                            status: parsedData[localhost][key].s ?? parsedData[localhost][key].status,
                            timestamp: parsedData[localhost][key].t ?? parsedData[localhost][key].timestamp
                        };

                        // timestamp 5min check

                        allStates[key] = obj;
                    }
                }

                // Update node property
                if (draftNode) {
                    draftNode.allStates = allStates;
                } else {
                    node.allStates = allStates;
                }

                return allStates;
            } catch (error) {
                console.error("queryAllStates failed:", error);
            }
        }

        async function querySqlChannels(tableName, draftNode = null) {
            const options = {
                hostname: draftNode?.host || node.host,
                port: draftNode?.httpPort || node.httpPort,
                path: `/sql2json?table=${tableName}`,
                method: "GET"
            };

            try {
                const parsedData = await httpQuery(options);

                // Update node property
                if (draftNode) {
                    draftNode[tableName] = parsedData;
                } else {
                    node[tableName] = parsedData;
                }

                return parsedData;
            } catch (error) {
                console.error(`querySqlChannels (${tableName}) failed:`, error);
            }
        }
    }

    RED.nodes.registerType("fusebox-controller", ControllerNode);
};
