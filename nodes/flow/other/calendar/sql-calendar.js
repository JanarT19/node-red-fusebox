const http = require("http");

// Custom node to perform CRUD operations via the /calendar endpoint.
module.exports = function (RED) {
    function SqlCalendarNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        var previousValues = {};

        // Retrieve configuration settings
        node.name = config.name;
        node.topic = config.topic;
        node.operationMode = config.operationMode;

        node.eventId = config.eventId;
        node.eventIdType = config.eventIdType;

        node.title = config.title;
        node.titleType = config.titleType;

        node.description = config.description;
        node.descriptionType = config.descriptionType;

        node.value = config.value;
        node.valueType = config.valueType;

        node.timestamp = config.timestamp;
        node.timestampType = config.timestampType;

        node.start = config.start;
        node.startType = config.startType;

        node.end = config.end;
        node.endType = config.endType;

        node.source = config.source;
        node.sourceType = config.sourceType;

        // Retrieve the config node's settings
        node.controller = RED.nodes.getNode(config.controller);

        // Validate the controller configuration
        if (!node.controller || !node.controller.host || (!node.controller.httpPort && !node.controller.udpPort)) {
            node.error("Controller configuration invalid");
            node.status({ fill: "red", shape: "dot", text: "Controller configuration invalid" });
            return;
        }

        // Check for unnecessary form values
        const invalidValues = ["", null, undefined];
        const operationModeValid = ["check", "create", "read", "update", "delete"];

        // Listen for input messages
        node.on("input", function (msg) {
            const operationMode = node.operationMode;
            const topic = node.topic;

            const id = parseInt(evaluate(node.eventId, node.eventIdType, node, msg));
            const title = evaluate(node.title, node.titleType, node, msg);
            const description = evaluate(node.description, node.descriptionType, node, msg);
            const value = evaluate(node.value, node.valueType, node, msg);
            let timestamp = evaluate(node.timestamp, node.timestampType, node, msg);
            let ts_min = evaluate(node.start, node.startType, node, msg);
            let ts_max = evaluate(node.end, node.endType, node, msg);
            const source = evaluate(node.source, node.sourceType, node, msg);

            // Convert date objects and ISO strings to unix timestamps (integers)
            if (timestamp instanceof Date) timestamp = timestamp.getTime();
            if (typeof timestamp === "string") timestamp = new Date(timestamp).getTime();

            if (ts_min instanceof Date) ts_min = ts_min.getTime();
            if (typeof ts_min === "string") ts_min = new Date(ts_min).getTime();

            if (ts_max instanceof Date) ts_max = ts_max.getTime();
            if (typeof ts_max === "string") ts_max = new Date(ts_max).getTime();

            // Basic validation
            if (!operationModeValid.includes(operationMode)) {
                node.error(`Operation mode must be one of: ${operationModeValid.join(", ")}`);
                node.status({ fill: "red", shape: "dot", text: `Invalid operation mode: ${operationMode}` });
                return;
            }

            // Required: title, timestamp, source
            // Optional: description, value
            if (operationMode === "create") {
                if (invalidValues.includes(title)) {
                    node.error("Event title required");
                    node.status({ fill: "red", shape: "dot", text: "Event title required" });
                    return;
                }

                if (invalidValues.includes(timestamp)) {
                    node.error("Timestamp required");
                    node.status({ fill: "red", shape: "dot", text: "Event timestamp required" });
                    return;
                }

                if (invalidValues.includes(source)) {
                    node.error("Event source required");
                    node.status({ fill: "red", shape: "dot", text: "Event source required" });
                    return;
                }
            }

            // Required: eventId, title, timestamp
            // Optional: description, value, source
            if (operationMode === "update") {
                if (invalidValues.includes(id) || isNaN(id)) {
                    node.error("Valid eventId required");
                    node.status({ fill: "red", shape: "dot", text: "Valid eventId required" });
                    return;
                }

                if (invalidValues.includes(title)) {
                    node.error("Event title required");
                    node.status({ fill: "red", shape: "dot", text: "Event title required" });
                    return;
                }

                if (invalidValues.includes(timestamp)) {
                    node.error("Timestamp required");
                    node.status({ fill: "red", shape: "dot", text: "Event timestamp required" });
                    return;
                }
            }

            // Required: eventId OR mix of title, description, value, start, end, source
            if (operationMode === "delete") {
                if (
                    (invalidValues.includes(id) || isNaN(id)) &&
                    invalidValues.includes(title) &&
                    invalidValues.includes(description) &&
                    invalidValues.includes(value) &&
                    invalidValues.includes(ts_min) &&
                    invalidValues.includes(ts_max) &&
                    invalidValues.includes(source)
                ) {
                    node.error("At least one parameter required");
                    node.status({ fill: "red", shape: "dot", text: "At least one parameter required" });
                    return;
                }
            }

            const parameters = { id, title, description, value, timestamp, ts_min, ts_max, source, operationMode };

            // Initialize the previous values object
            const previousRequest = getPreviousValue(parameters, "request");

            // Skip if a request is already in progress for this row
            if (previousRequest) {
                node.status({ fill: "yellow", shape: "dot", text: `Request in progress for ${title || "event"} (${formatDate()})` });
                return;
            }

            // Build the POST request
            const postData = {
                configuration: { id, title, description, value, timestamp, ts_min, ts_max, source, check: operationMode === "check" },
            };

            // Remove empty values
            for (const key in postData.configuration) {
                const val = postData.configuration[key];

                if (invalidValues.includes(val) || (["id", "timestamp", "ts_min", "ts_max"].includes(key) && isNaN(val))) {
                    delete postData.configuration[key];
                }
            }

            setPreviousRequest(parameters, true);

            // Send the POST request to the controller
            sendCalendarOperation(node, postData, parameters)
                .then((result) => {
                    setPreviousRequest(parameters, false);

                    const outMsg = {
                        ...msg,
                        ...(!invalidValues.includes(topic) && { topic }),
                    };

                    node.send({ ...outMsg, payload: result, parameters, controller: { id: node.controller.id, uniqueId: node.controller.uniqueId, host: node.controller.host } });
                })
                .catch((error) => {
                    node.error(`Error sending calendar value: ${error}`, { error });

                    setPreviousRequest(parameters, false);

                    const outMsg = {
                        ...msg,
                        ...(!invalidValues.includes(topic) && { topic }),
                    };

                    node.send({ ...outMsg, payload: false, parameters, controller: { id: node.controller.id, uniqueId: node.controller.uniqueId, host: node.controller.host } });
                });
        });

        // Method to query additional data via HTTP with retry mechanism
        function sendCalendarOperation(node, postData = {}, parameters = {}, retries = 3) {
            const { operationMode } = parameters;

            let path = "/calendar";
            let method = "GET";

            if (operationMode === "create") method = "POST";
            if (operationMode === "update") method = "PUT";
            if (operationMode === "delete") method = "DELETE";

            // Build query parameters for GET requests
            if (method === "GET" || method === "DELETE") {
                let parameters = "";

                for (const key in postData.configuration) {
                    parameters += `&${key}=${encodeURIComponent(postData.configuration[key])}`;
                }

                parameters = parameters.slice(1);
                if (parameters) path = `/calendar?${parameters}`;
            }

            const options = {
                hostname: node.controller.host,
                port: node.controller.httpPort,
                path: path,
                method: method,
                headers: {
                    "Content-Type": "application/json",
                },
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

                            if (parsedData?.success === true || parsedData) {
                                node.status({
                                    fill: "green",
                                    shape: "dot",
                                    text: `Calendar entry ${operationMode}${["read", "check"].includes(operationMode) ? "" : "d"} (${formatDate()})`,
                                });

                                resolve(parsedData);
                            } else {
                                if (retries > 0) {
                                    node.warn(`Retrying... (${retries} attempts left)`);
                                    node.status({ fill: "yellow", shape: "dot", text: `Retrying sending data (${formatDate()})` });

                                    setTimeout(() => {
                                        resolve(sendCalendarOperation(node, postData, parameters, retries - 1));
                                    }, 500);
                                } else {
                                    node.error(`Failed to send data`, parameters);
                                    node.status({ fill: "red", shape: "dot", text: `Failed to send data (${formatDate()})` });

                                    resolve(false);
                                }
                            }
                        } catch (error) {
                            node.status({ fill: "red", shape: "dot", text: `Failed to parse HTTP response (${formatDate()})` });

                            // Retry if necessary
                            if (retries > 0) {
                                node.warn(`Retrying... (${retries} attempts left)`);

                                setTimeout(() => {
                                    resolve(sendCalendarOperation(node, postData, parameters, retries - 1));
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
                            resolve(sendCalendarOperation(node, postData, parameters, retries - 1));
                        }, 500);
                    } else {
                        node.error(`HTTP request error: ${error}`, { error });
                        reject(error);
                    }
                });

                // Write data to request body
                if (method !== "GET" && method !== "DELETE") {
                    req.write(JSON.stringify(postData));
                }

                req.end();
            });
        }

        // Evaluate the value of a property, catching any errors (e.g. read properties of undefined : msg.payload.success)
        function evaluate(value, type, node, msg) {
            try {
                return RED.util.evaluateNodeProperty(value, type, node, msg);
            } catch (err) {
                return undefined;
            }
        }

        function getPreviousValue(parameters = {}, key = "title") {
            const { title = "_default" } = parameters;

            if (!previousValues[title]) previousValues[title] = { title: null, value: null, start: null, request: null };

            return previousValues[title][key] ?? null;
        }

        function setPreviousRequest(parameters = {}, status = null) {
            const { title = "_default" } = parameters;

            previousValues[title].request = status;
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
                hour12: false, // Use 24-hour format
            };

            return now.toLocaleString("en-GB", options); // 'en-GB' locale for DD/MM/YYYY format
        }
    }

    RED.nodes.registerType("fusebox-sql-calendar", SqlCalendarNode);
};
