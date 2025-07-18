const http = require("http");

// Custom node to write data streams via the /setup endpoint.
module.exports = function (RED) {
    function WriteDynamicDataStreamNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Retrieve configuration settings
        node.name = config.name;
        node.outputMode = config.outputMode;

        node.keyName = config.keyName;
        node.keyNameType = config.keyNameType;

        node.index = config.index;
        node.indexType = config.indexType;

        node.channelType = config.channelType;
        node.channelTypeType = config.channelTypeType;

        node.payload = config.payload;
        node.payloadType = config.payloadType;

        node.coefficient = config.coefficient;
        node.coefficientType = config.coefficientType;

        // Stores latest output of each row to compare against
        const previousValues = {};

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
        const channelTypeValid = ["ai", "ao", "di", "do"];
        const discretePayloadValid = [0, 1];

        const outputMode = node.outputMode;

        // Listen for input messages
        node.on("input", function (msg) {
            const keyName = evaluate(node.keyName, node.keyNameType, node, msg);
            const channelType = evaluate(node.channelType, node.channelTypeType, node, msg);
            const index = parseInt(evaluate(node.index, node.indexType, node, msg));
            let payload = parseFloat(evaluate(node.payload, node.payloadType, node, msg));
            let coefficient = parseFloat(evaluate(node.coefficient, node.coefficientType, node, msg));

            // Basic validation
            if (!keyName) {
                node.error("Data stream name required");
                node.status({ fill: "red", shape: "dot", text: "Data stream name required" });
                return;
            }

            if (!channelTypeValid.includes(channelType)) {
                node.error(`Channel type must be one of: ${channelTypeValid.join(", ")}`);
                node.status({ fill: "red", shape: "dot", text: `Invalid channel type: ${channelType}` });
                return;
            }

            if (!outputModeValid.includes(outputMode)) {
                node.error(`Output mode must be one of: ${outputModeValid.join(", ")}`);
                node.status({ fill: "red", shape: "dot", text: `Invalid output mode: ${outputMode}` });
                return;
            }

            if (invalidValues.includes(index) || isNaN(index) || index < 1) {
                node.error("Valid member index required");
                node.status({ fill: "red", shape: "dot", text: "Valid member index required" });
                return;
            }

            if (invalidValues.includes(payload) || isNaN(payload)) {
                node.error("Valid payload required");
                node.status({ fill: "red", shape: "dot", text: "Valid payload required" });
                return;
            }

            if (channelType.startsWith("a") && (invalidValues.includes(coefficient) || isNaN(coefficient))) {
                node.error("Valid coefficient required");
                node.status({ fill: "red", shape: "dot", text: "Valid coefficient required" });
                return;
            }

            if (channelType.startsWith("d") && !discretePayloadValid.includes(payload)) {
                node.error(`Payload must be one of: ${discretePayloadValid.join(", ")}`);
                node.status({ fill: "red", shape: "dot", text: `Invalid payload for discrete type: ${payload}` });
                return;
            }

            // Apply coefficient for input type if necessary
            if (channelType.startsWith("a")) {
                coefficient = formatCoefficient(node, keyName, coefficient);
                payload = parseInt(payload * coefficient); // Due to UniSCADA limitations, we need to send the integer value
            }

            const parameters = {
                name: keyName,
                index,
                type: channelType,
                payload
            };

            if (channelType.startsWith("a")) {
                parameters.coefficient = coefficient;
            }

            // Initialize the previous values object
            const previousValue = getPreviousValue(parameters, "value");
            const previousRequest = getPreviousValue(parameters, "request");

            // Initialize global context to get and set values
            const outputContextKey = `${node.controller.uniqueId}_output_states`;
            const globalContext = node.context().global;

            // Do not send output if the value hasn't changed
            // PS. In addition to checking the node's previous value, we also check the latest value saved to global context
            if (outputMode === "change" && previousValue !== null && previousValue === payload) {
                const outputContext = globalContext.get(outputContextKey);
                const outputContextValues = outputContext?.[keyName]?.values || [];
                const outputContextValue = outputContextValues?.[index - 1] ?? null;

                if (outputContextValue === null) return;

                if (outputContextValue !== null && outputContextValue === payload) {
                    node.debug(`Skipping sending unchanged value for ${keyName}.${index}`);
                    return;
                }
            }

            // Skip if a request is already in progress for this row
            if (previousRequest) {
                node.status({ fill: "yellow", shape: "dot", text: `Request in progress for ${keyName}.${index} (${formatDate()})` });
                return;
            }

            // Build the POST request payload
            const postData = {
                localhost: {
                    [`${keyName}.${index}`]: {
                        v: payload,
                        type: channelType
                    }
                }
            };

            setPreviousRequest(parameters, true);

            // Send the POST request to the controller
            sendSetupValue(node, postData, parameters)
                .then((result) => {
                    if (result) {
                        setPreviousValue(parameters);
                        setPreviousTimestamp(parameters);
                    }

                    setPreviousRequest(parameters, false);
                    node.send({ payload: result, parameters, controller: { id: node.controller.id, uniqueId: node.controller.uniqueId, host: node.controller.host } });
                })
                .catch((error) => {
                    node.error(`Error sending setup value: ${error}`, { error });

                    setPreviousRequest(parameters, false);
                    node.send({ payload: false, parameters, controller: { id: node.controller.id, uniqueId: node.controller.uniqueId, host: node.controller.host } });
                });
        });

        // Method to query additional data via HTTP with retry mechanism
        function sendSetupValue(node, postData = {}, parameters = {}, retries = 3) {
            const { name: keyName, index, payload } = parameters;

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
                                node.status({ fill: "green", shape: "dot", text: `Sent to ${keyName}.${index}: ${payload} (${formatDate()})` });
                                resolve(true);
                            } else {
                                if (retries > 0) {
                                    node.warn(`Retrying... (${retries} attempts left)`);
                                    node.status({ fill: "yellow", shape: "dot", text: `Retrying sending data ${keyName}.${index}: ${payload} (${formatDate()})` });

                                    setTimeout(() => {
                                        resolve(sendSetupValue(node, postData, parameters, retries - 1));
                                    }, 500);
                                } else {
                                    node.error(`Failed to send data ${keyName}.${index}: ${payload}`, parameters);
                                    node.status({ fill: "red", shape: "dot", text: `Failed to send data ${keyName}.${index}: ${payload} (${formatDate()})` });

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

        // Evaluate the value of a property, catching any errors (e.g. read properties of undefined : msg.payload.result)
        function evaluate(value, type, node, msg) {
            try {
                return RED.util.evaluateNodeProperty(value, type, node, msg);
            } catch (err) {
                return undefined;
            }
        }

        function getPreviousValue(parameters = {}, key = "value") {
            const { name, index } = parameters;

            if (!previousValues[name]) previousValues[name] = {};
            if (!previousValues[name][index]) previousValues[name][index] = { value: null, request: null, timestamp: null };

            return previousValues[name][index][key] ?? null;
        }

        function setPreviousValue(parameters = {}) {
            const { name, index, payload } = parameters;

            previousValues[name][index].value = payload;
        }

        function setPreviousRequest(parameters = {}, status = null) {
            const { name, index } = parameters;

            previousValues[name][index].request = status;
        }

        function setPreviousTimestamp(parameters = {}, timestamp = Date.now()) {
            const { name, index } = parameters;

            previousValues[name][index].timestamp = timestamp;
        }

        // Return the coefficient for the specified row, or default to 1 if not found
        function formatCoefficient(node, keyName, coefficient) {
            const services = node.controller?.services || {};

            let coef = coefficient;

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

    RED.nodes.registerType("fusebox-write-dynamic-data-stream", WriteDynamicDataStreamNode);
};
