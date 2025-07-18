const http = require("http");

// Custom node to write data streams via the /setup endpoint.
module.exports = function (RED) {
    function WriteStaticDataStreamsNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Retrieve configuration settings
        node.name = config.name;
        node.outputMode = config.outputMode;
        node.payloadType = config.payloadType;
        node.mappings = config.mappings || [];

        // Stores latest output of each row to compare against
        const previousValues = {};

        // Temporary variables
        let currentValues = [];
        const requestInProgress = {};

        // Measure latency of HTTP requests
        const measureDelay = true;
        let lastSendTs = null;

        // Retrieve the config node's settings
        node.controller = RED.nodes.getNode(config.controller);

        // Validate the controller configuration
        if (!node.controller || !node.controller.host || (!node.controller.httpPort && !node.controller.udpPort)) {
            node.error("Controller configuration invalid");
            node.status({ fill: "red", shape: "dot", text: "Controller configuration invalid" });
            return;
        }

        // Validation constants
        const invalidValues = ["", null, undefined];
        const outputModeValid = ["all", "change"];
        const payloadTypeValid = ["static", "dynamic"];
        const channelTypeValid = ["ai", "ao", "di", "do"];
        const discretePayloadValid = [0, 1];

        const rows = node.mappings.length || 0;
        const outputMode = node.outputMode;
        const payloadType = node.payloadType;

        // Listen for input messages
        node.on("input", function (msg) {
            // Basic validation
            if (!outputModeValid.includes(outputMode)) {
                node.error(`Output mode must be one of: ${outputModeValid.join(", ")}`);
                node.status({ fill: "red", shape: "dot", text: `Invalid output mode: ${outputMode}` });
                return;
            }

            if (!payloadTypeValid.includes(payloadType)) {
                node.error(`Payload type must be one of: ${payloadTypeValid.join(", ")}`);
                node.status({ fill: "red", shape: "dot", text: `Invalid payload type: ${payloadType}` });
                return;
            }

            // Reset temporary variables
            currentValues = [];

            // Initialize global context to get and set values
            const outputContextKey = `${node.controller.uniqueId}_output_states`;
            const globalContext = node.context().global;

            // Due to Promises, set default status before processing the data
            node.status({
                fill: "grey",
                shape: "dot",
                text: `Send 0 of ${rows} values (${formatDate()})`
            });

            // Iterate over each row in the mappings and process the data
            node.mappings.forEach((row, i) => {
                const svcKey = row.keyNameSelect || row.keyNameManual;
                const channelType = row.channelType;
                const topic = row.topic;
                const index = parseInt(row.index);
                let coefficient = parseFloat(row.coefficient) || 1;
                let payload;

                // Input message or row-specific validation
                if (!svcKey) {
                    node.error("Data stream name required");
                    node.status({ fill: "red", shape: "dot", text: "Data stream name required" });
                    return; // Skip to the next row
                }

                if (invalidValues.includes(topic)) {
                    node.error(`Topic undefined for ${svcKey}`);
                    node.status({ fill: "red", shape: "dot", text: `Topic undefined for ${svcKey}` });
                    return;
                }

                if (!channelTypeValid.includes(channelType)) {
                    node.error(`Channel type must be one of: ${channelTypeValid.join(", ")}`);
                    node.status({ fill: "red", shape: "dot", text: `Invalid channel type: ${channelType}` });
                    return;
                }

                if (invalidValues.includes(index) || isNaN(index) || index < 1) {
                    node.error("Valid member index required");
                    node.status({ fill: "red", shape: "dot", text: "Valid member index required" });
                    return;
                }

                if (channelType.startsWith("a") && (invalidValues.includes(coefficient) || isNaN(coefficient))) {
                    node.error("Valid coefficient required");
                    node.status({ fill: "red", shape: "dot", text: "Valid coefficient required" });
                    return;
                }

                // Execute write operation only on topics specified in the msg object
                // Incoming message format: {"topic": topic, "payload": value} or {"topic1": value1, "topic2": value2, ...}
                if (payloadType === "dynamic") {
                    if (msg.hasOwnProperty("topic") && msg.topic !== topic) {
                        return;
                    }

                    if (!msg.hasOwnProperty("topic") && !msg.hasOwnProperty(topic)) {
                        return;
                    }

                    payload = msg.hasOwnProperty("payload") ? parseFloat(msg.payload) : parseFloat(msg[topic]);
                }

                // Incoming message format: {"topic": topic} or {"topic1": true, "topic2": false, ...} or none, in which case every topic will be written.
                if (payloadType === "static") {
                    if (msg.hasOwnProperty("topic") && msg.topic !== topic) {
                        return;
                    }

                    if (msg.hasOwnProperty(topic) && msg[topic] !== true) {
                        return;
                    }

                    payload = parseFloat(row.payload);
                }

                if (invalidValues.includes(payload) || isNaN(payload)) {
                    node.error("Valid payload required");
                    node.status({ fill: "red", shape: "dot", text: "Valid payload required" });
                    return;
                }

                if (channelType.startsWith("d") && !discretePayloadValid.includes(payload)) {
                    node.error(`Payload must be one of: ${discretePayloadValid.join(", ")}`);
                    node.status({ fill: "red", shape: "dot", text: `Invalid payload for discrete type: ${payload}` });
                    return;
                }

                // Apply coefficient for input type if necessary
                if (channelType.startsWith("a")) {
                    coefficient = formatCoefficient(node, row);
                    payload = parseInt(payload * coefficient); // Due to UniSCADA limitations, we need to send the integer value
                }

                // Do not send output if the value hasn't changed
                // PS. In addition to checking the node's previous value, we also check the latest value saved to global context
                if (outputMode === "change" && previousValues[i] !== undefined && previousValues[i].payload === payload) {
                    const outputContext = globalContext.get(outputContextKey);
                    const outputContextValues = outputContext?.[svcKey]?.values || [];
                    const outputContextValue = outputContextValues?.[index - 1] ?? null;

                    if (outputContextValue === null) return;

                    if (outputContextValue !== null && outputContextValue === payload) {
                        node.debug(`Skipping sending unchanged value for ${svcKey}.${index}`);
                        return;
                    }
                }

                // Skip if a request is already in progress for this row
                if (requestInProgress[i]) {
                    node.status({ fill: "yellow", shape: "dot", text: `Request in progress for row ${i + 1} (${formatDate()})` });
                    return;
                }

                // Build the POST request payload
                const postData = {
                    localhost: {
                        [`${svcKey}.${index}`]: {
                            v: payload,
                            type: channelType
                        }
                    }
                };

                const parameters = {
                    topic,
                    name: svcKey,
                    index,
                    type: channelType,
                    payload
                };

                requestInProgress[i] = true;
                if (measureDelay) lastSendTs = Date.now();

                // Send the POST request to the controller
                sendSetupValue(node, postData, parameters)
                    .then((result) => {
                        if (result) {
                            previousValues[i] = { payload, timestamp: Date.now() };
                            currentValues.push(payload);

                            const sentValues = currentValues.length;

                            node.status({
                                fill: sentValues === 0 ? "grey" : "green",
                                shape: "dot",
                                text: `Send ${sentValues} of ${rows} values${sentValues > 0 ? ":" : ""} ${currentValues.join(", ")} (${formatDate()})`
                            });
                        }

                        requestInProgress[i] = false;
                        if (measureDelay) node.debug(`HTTP latency: ${(Date.now() - lastSendTs) / 1000} s`);

                        node.send({ payload: result, parameters, controller: { id: node.controller.id, uniqueId: node.controller.uniqueId, host: node.controller.host } });
                    })
                    .catch((error) => {
                        node.error(`Error sending setup value: ${error}`, { error });

                        requestInProgress[i] = false;
                        node.send({ payload: false, parameters, controller: { id: node.controller.id, uniqueId: node.controller.uniqueId, host: node.controller.host } });
                    });
            });
        });

        // Method to query additional data via HTTP with retry mechanism
        function sendSetupValue(node, postData = {}, parameters = {}, retries = 3) {
            const { name: svcKey, index, payload } = parameters;

            const options = {
                hostname: node.controller.host,
                port: node.controller.httpPort,
                path: "/setup",
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                }
            };

            node.debug(`Querying HTTP: ${JSON.stringify(options)} with body ${JSON.stringify(postData)}`);

            return new Promise((resolve, reject) => {
                const req = http.request(options, (res) => {
                    let data = "";

                    res.on("data", (chunk) => {
                        data += chunk;
                    });

                    res.on("end", () => {
                        try {
                            node.debug(`Received HTTP message: ${data}`);
                            const parsedData = JSON.parse(data);

                            if (parsedData?.result === true) {
                                node.status({ fill: "green", shape: "dot", text: `Sent to ${svcKey}.${index}: ${payload} (${formatDate()})` });
                                resolve(true);
                            } else {
                                if (retries > 0) {
                                    node.warn(`Retrying... (${retries} attempts left)`);
                                    node.status({ fill: "yellow", shape: "dot", text: `Retrying sending data ${svcKey}.${index}: ${payload} (${formatDate()})` });

                                    setTimeout(() => {
                                        resolve(sendSetupValue(node, postData, parameters, retries - 1));
                                    }, 500);
                                } else {
                                    node.error(`Failed to send data ${svcKey}.${index}: ${payload}`, parameters);
                                    node.status({ fill: "red", shape: "dot", text: `Failed to send data ${svcKey}.${index}: ${payload} (${formatDate()})` });

                                    resolve(false);
                                }
                            }
                        } catch (error) {
                            node.status({ fill: "red", shape: "dot", text: `Failed to parse HTTP response (${formatDate()})` });

                            // Retry if necessary
                            if (retries > 0) {
                                node.warn(`Retrying... (${retries} attempts left)`);

                                setTimeout(() => {
                                    resolve(sendSetupValue(node, postData, parameters, retries - 1));
                                }, 500);
                            } else {
                                node.error(`Failed to parse HTTP response: ${error}`, { error });
                                reject(error);
                            }
                        }
                    });
                });

                req.on("error", (error) => {
                    node.status({ fill: "red", shape: "dot", text: `HTTP request error (${formatDate()})` });

                    // Retry if necessary
                    if (retries > 0) {
                        node.warn(`Retrying... (${retries} attempts left)`);

                        setTimeout(() => {
                            resolve(sendSetupValue(node, postData, parameters, retries - 1));
                        }, 500);
                    } else {
                        node.error(`HTTP request error: ${error}`, { error });
                        reject(error);
                    }
                });

                // Write data to request body
                req.write(JSON.stringify(postData));
                req.end();
            });
        }

        // Return the coefficient for the specified row, or default to 1 if not found
        function formatCoefficient(node, row) {
            const services = node.controller?.services || {};
            const keyName = row.keyNameSelect || row.keyNameManual;

            let coef = row.coefficient;

            if (keyName && services[keyName]) {
                coef = services[keyName]?.conv_coef || coef;
            }

            if (invalidValues.includes(coef)) {
                coef = 1;
            }

            return parseFloat(coef);
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

    RED.nodes.registerType("fusebox-write-static-data-streams", WriteStaticDataStreamsNode);
};
