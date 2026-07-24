const http = require("http");

module.exports = function (RED) {
    function WriteDataStreamsNode(config) {
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

        // Flag to track if we've logged controller config info (log once when data becomes available)
        let hasLoggedControllerConfig = true;

        // Function to log controller config information (called when data becomes available)
        function logControllerConfig() {
            if (hasLoggedControllerConfig || !node.controller) return;

            const channels = node.controller.channels || {};
            const channelKeys = Object.keys(channels).sort();

            // Only log if we have actual data (not just empty objects)
            if (channelKeys.length > 0) {
                node.log(`[Write Data Streams] Controller config loaded`);
                node.log(`[Write Data Streams] Total datastreams in channels (unfiltered): ${channelKeys.length}`);

                // Log full controller data for debugging - split into chunks if too large
                const channelsJson = JSON.stringify(channels, null, 2);
                const maxLogLength = 5000; // Split into chunks if larger
                if (channelsJson.length > maxLogLength) {
                    node.log(`[Write Data Streams] Full controller channels data (split into chunks due to size):`);
                    for (let i = 0; i < channelsJson.length; i += maxLogLength) {
                        const chunk = channelsJson.substring(i, i + maxLogLength);
                        node.log(`[Write Data Streams] Channels chunk ${Math.floor(i / maxLogLength) + 1}: ${chunk}`);
                    }
                } else {
                    node.log(`[Write Data Streams] Full controller channels data: ${channelsJson}`);
                }

                // Specifically log DO1W datastream details if present
                if (channels.DO1W) {
                    node.log(`[Write Data Streams] DO1W datastream details:`);
                    node.log(`[Write Data Streams]   Raw DO1W channels: ${JSON.stringify(channels.DO1W, null, 2)}`);
                    const do1wMembers = Object.values(channels.DO1W);
                    node.log(`[Write Data Streams]   DO1W has ${do1wMembers.length} members:`);
                    do1wMembers.forEach((member) => {
                        node.log(
                            `[Write Data Streams]     Member ${member.member}: regtype='${member.regtype}', _output=${member._output}, _type='${member._type || "N/A"}', desc='${
                                member.desc || "N/A"
                            }'`
                        );
                    });
                } else {
                    node.log(`[Write Data Streams]   DO1W datastream NOT found in channels`);
                }

                // Apply our own writability rules to count what's available
                // Rules: s/s!/r always writable; h/c/h!/c! writable if _output is true
                let writableCount = 0;
                const writableKeys = [];

                channelKeys.forEach((key) => {
                    const keyChannels = channels[key] || {};
                    const members = Object.values(keyChannels);

                    // Check if this datastream has at least one writable member
                    const hasWritableMember = members.some((member) => {
                        const regtype = member.regtype;
                        const hasOutput = member._output === true;

                        if (["s", "s!", "r", "h", "c"].includes(regtype)) {
                            return true;
                        }
                        if (["h!", "c!"].includes(regtype)) {
                            return hasOutput;
                        }
                        return false;
                    });

                    if (hasWritableMember) {
                        writableCount++;
                        writableKeys.push(key);
                    }
                });

                node.log(`[Write Data Streams] Datastreams passing our writability rules: ${writableCount} of ${channelKeys.length}`);

                // Show excluded datastreams and why they were excluded
                const excludedKeys = channelKeys.filter((k) => !writableKeys.includes(k));
                if (excludedKeys.length > 0) {
                    node.log(`[Write Data Streams] ⚠ Excluded datastreams (${excludedKeys.length}): ${excludedKeys.join(", ")}`);
                    // Show detailed exclusion reasons
                    excludedKeys.forEach((key) => {
                        const keyChannels = channels[key] || {};
                        const members = Object.values(keyChannels);
                        if (members.length > 0) {
                            const memberReasons = members
                                .map((m) => {
                                    const regtype = m.regtype;
                                    const memberIdx = m.member;
                                    const hasOutput = m._output === true;

                                    if (["s", "s!", "r"].includes(regtype)) {
                                        return `m${memberIdx}:${regtype}(should be writable - unexpected exclusion)`;
                                    } else if (["h", "c", "h!", "c!"].includes(regtype)) {
                                        if (!hasOutput) {
                                            return `m${memberIdx}:${regtype}(_output=${hasOutput}, needs _output=true per rules)`;
                                        } else {
                                            return `m${memberIdx}:${regtype}(_output=true but excluded - unexpected)`;
                                        }
                                    } else {
                                        return `m${memberIdx}:${regtype}(unknown regtype)`;
                                    }
                                })
                                .join(", ");
                            node.log(`[Write Data Streams]   - ${key}: ${memberReasons}`);
                        } else {
                            node.log(`[Write Data Streams]   - ${key}: no members found`);
                        }
                    });
                }

                // Show final list - all datastreams that pass our filters
                if (writableKeys.length > 0) {
                    const sortedWritableKeys = writableKeys.sort();
                    node.log(`[Write Data Streams] Final list of datastreams available for write selection: ${sortedWritableKeys.length} total`);
                    node.log(`[Write Data Streams] Datastream keys: ${sortedWritableKeys.join(", ")}`);
                }

                hasLoggedControllerConfig = true;
            }
        }

        // Try to log immediately, but also set up periodic check for when data becomes available
        logControllerConfig();

        // Also check on first input message (when controller data should definitely be loaded)
        let hasCheckedOnInput = false;

        // Validation constants
        const invalidValues = ["", null, undefined];
        const outputModeValid = ["all", "change"];
        const payloadTypeValid = ["static", "dynamic"];
        const channelTypeValid = ["ai", "ao", "di", "do"];
        const discretePayloadValid = [0, 1];

        const rows = node.mappings.length || 0;
        const outputMode = node.outputMode;
        const payloadType = node.payloadType;

        // Loop detection: track conflicting keys and set flow context for gating
        const loopConflicts = new Set();

        function detectFeedbackLoops() {
            node.log(`[Loop Detection] Starting check for write node "${node.name || node.id}"`);

            loopConflicts.clear();
            const writeKeys = new Set();
            node.mappings.forEach((mapping) => {
                const key = mapping.keyNameSelect || mapping.keyNameManual;
                if (key) writeKeys.add(key);
            });

            node.log(`[Loop Detection] This write node sends to: [${Array.from(writeKeys).join(", ")}]`);

            // Find read nodes in ANY flow (cross-tab detection via link nodes)
            let readNodeCount = 0;
            const allReadKeys = new Set();

            RED.nodes.eachNode((otherNode) => {
                if (otherNode.type === "fusebox-read-data-streams") {
                    readNodeCount++;
                    const readMappings = otherNode.mappings || [];

                    readMappings.forEach((mapping) => {
                        const key = mapping.keyNameSelect || mapping.keyNameManual;
                        if (key) {
                            allReadKeys.add(key);
                            if (writeKeys.has(key)) {
                                loopConflicts.add(key);
                            }
                        }
                    });
                }
            });

            node.log(`[Loop Detection] Found ${readNodeCount} read node(s) reading: [${Array.from(allReadKeys).join(", ")}]`);

            if (loopConflicts.size > 0) {
                const msg = `[Loop Detection] ⚠️ POTENTIAL FEEDBACK LOOP for keys: [${Array.from(loopConflicts).join(
                    ", "
                )}]. This compares topics only, not wiring. If nodes are connected, enable "Gate loop" checkbox to prevent rapid updates.`;
                node.warn(msg);
            } else {
                node.log(`[Loop Detection] ✓ No potential feedback loops detected (comparing topics only).`);
            }
        }

        // Run loop detection on startup
        detectFeedbackLoops();

        // Listen for input messages
        node.on("input", function (msg) {
            // Log controller config on first input message (when data should be available)
            if (!hasCheckedOnInput) {
                hasCheckedOnInput = true;
                logControllerConfig();
            }

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

            // Check if message has an array payload - send directly to /setup
            if (msg.hasOwnProperty("topic") && Array.isArray(msg.payload)) {
                handleArrayPayload(msg);
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

                            // Set flow context for loop gating if enabled
                            if (row.gateLoop && loopConflicts.has(svcKey)) {
                                const flowContext = node.context().flow;
                                const gating = flowContext.get("writeGating") || {};
                                gating[svcKey] = Date.now();
                                flowContext.set("writeGating", gating);
                            }

                            const sentValues = currentValues.length;

                            node.status({
                                fill: sentValues === 0 ? "grey" : "green",
                                shape: "dot",
                                text: `Send ${sentValues} of ${rows} values${sentValues > 0 ? ":" : ""} ${currentValues.join(", ")} (${formatDate()})`
                            });
                        }

                        requestInProgress[i] = false;
                        if (measureDelay) node.log(`HTTP latency: ${(Date.now() - lastSendTs) / 1000} s`);

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

            node.log(`Querying HTTP: ${JSON.stringify(options)} with body ${JSON.stringify(postData)}`);

            return new Promise((resolve, reject) => {
                const req = http.request(options, (res) => {
                    let data = "";

                    res.on("data", (chunk) => {
                        data += chunk;
                    });

                    res.on("end", () => {
                        try {
                            node.log(`Received HTTP message: ${data}`);
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

        // Handle array payload - send directly to /setup endpoint
        function handleArrayPayload(msg) {
            const topic = msg.topic;
            const arrayPayload = msg.payload;

            // Determine channel type from configured mappings
            // Look for any row that matches this datastream name
            let channelType = null;
            for (const row of node.mappings) {
                const svcKey = row.keyNameSelect || row.keyNameManual;
                if (svcKey === topic) {
                    channelType = row.channelType;
                    break;
                }
            }

            if (!channelType) {
                node.error(`No configuration found for array topic: ${topic}`);
                node.status({ fill: "red", shape: "dot", text: `No config for ${topic}` });
                return;
            }

            if (!channelTypeValid.includes(channelType)) {
                node.error(`Invalid channel type: ${channelType}`);
                node.status({ fill: "red", shape: "dot", text: `Invalid channel type: ${channelType}` });
                return;
            }

            // Build the POST request payload for array format
            const postData = {
                localhost: {
                    [topic]: {
                        v: arrayPayload,
                        type: channelType
                    }
                }
            };

            const parameters = {
                topic,
                name: topic,
                type: channelType,
                payload: arrayPayload
            };

            if (measureDelay) lastSendTs = Date.now();

            // Send the POST request to the controller
            sendSetupValue(node, postData, parameters)
                .then((result) => {
                    if (result) {
                        // Set flow context for loop gating if topic is in conflicts
                        // For array payloads, gate if any mapping for this key has gateLoop enabled
                        const hasGating = node.mappings.some((m) => {
                            const key = m.keyNameSelect || m.keyNameManual;
                            return key === topic && m.gateLoop;
                        });

                        if (hasGating && loopConflicts.has(topic)) {
                            const flowContext = node.context().flow;
                            const gating = flowContext.get("writeGating") || {};
                            gating[topic] = Date.now();
                            flowContext.set("writeGating", gating);
                        }

                        node.status({
                            fill: "green",
                            shape: "dot",
                            text: `Sent array to ${topic}: [${arrayPayload.join(", ")}] (${formatDate()})`
                        });
                    }

                    if (measureDelay) node.log(`HTTP latency: ${(Date.now() - lastSendTs) / 1000} s`);

                    node.send({ payload: result, parameters, controller: { id: node.controller.id, uniqueId: node.controller.uniqueId, host: node.controller.host } });
                })
                .catch((error) => {
                    node.error(`Error sending array value: ${error}`, { error });
                    node.send({ payload: false, parameters, controller: { id: node.controller.id, uniqueId: node.controller.uniqueId, host: node.controller.host } });
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

    RED.nodes.registerType("fusebox-write-data-streams", WriteDataStreamsNode);
};
