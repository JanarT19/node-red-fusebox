const http = require("http");

// Custom node to route data streams from the global context.
// Outputs the value / status / timestamp of a data stream alongside a topic.
module.exports = function (RED) {
    function ReadDynamicDataStreamsNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Retrieve configuration settings
        node.name = config.name;
        node.outputMode = config.outputMode;
        node.msgType = config.msgType;
        node.mappings = config.mappings || [];

        // Caching and state
        const previousRows = {};
        const invalidValues = ["", null, undefined];
        const outputModeValid = ["all", "change"];
        const msgTypeValid = ["separate", "together", "split"];

        // Retrieve controller config node
        node.controller = RED.nodes.getNode(config.controller);

        if (!node.controller || !node.controller.host || (!node.controller.httpPort && !node.controller.udpPort)) {
            node.error("Controller configuration invalid");
            node.status({ fill: "red", shape: "dot", text: "Controller configuration invalid" });
            return;
        }

        // Listen for input messages

        node.on("input", (msg) => {
            // Example UDP node output:
            // payload: { TEST1S: { values: [0], status: 0, timestamp: 1750530361 } }
            const dataStreams = msg.payload;

            // Basic validation
            if (!dataStreams || typeof dataStreams !== "object") {
                node.error("Invalid payload received");
                node.status({ fill: "red", shape: "dot", text: "Invalid payload received" });
                return;
            }

            if (!outputModeValid.includes(node.outputMode)) {
                node.error(`Output mode must be one of: ${outputModeValid.join(", ")}`);
                node.status({ fill: "red", shape: "dot", text: `Invalid output mode: ${node.outputMode}` });
                return;
            }

            if (!msgTypeValid.includes(node.msgType)) {
                node.error(`Message type must be one of: ${msgTypeValid.join(", ")}`);
                node.status({ fill: "red", shape: "dot", text: `Invalid message type: ${node.msgType}` });
                return;
            }

            // Load fallback states from the controller
            const allStates = node.controller.allStates;

            // Reset temporary variables
            const outputContext = {
                changed: false,
                time: Math.floor(Date.now() / 1000),
                separate: [],
                split: [],
                combined: {}
            };

            // Iterate over each row in the mappings and process the data
            node.mappings.forEach((row, i) => {
                const svcKey = row.keyNameSelect || row.keyNameManual;
                const topic = row.topic;

                // Priority: 1) current value; 2) previous value; 3) value from /allstates
                const stream = dataStreams?.[svcKey];
                const cached = previousRows[i];
                const allState = allStates?.[svcKey];

                const status = stream?.status ?? cached?.status ?? allState?.status;
                const values = stream?.values ?? cached?.values ?? allState?.values;
                const timestamp = stream?.timestamp ?? cached?.timestamp ?? allState?.timestamp;

                // Input message or row-specific validation
                if ([status, values, timestamp].includes(undefined)) {
                    node.error(`Unknown data stream: ${svcKey}`);
                    node.status({ fill: "red", shape: "dot", text: `Unknown data stream: ${svcKey}` });
                    outputContext.split.push(null);
                    return;
                }

                if (invalidValues.includes(topic)) {
                    node.error(`Topic undefined for ${svcKey}`);
                    node.status({ fill: "red", shape: "dot", text: `Topic undefined for ${svcKey}` });
                    outputContext.split.push(null);
                    return;
                }

                if (outputContext.time - timestamp > 300) {
                    node.warn(`Data stream ${svcKey} outdated: ${outputContext.time - timestamp} seconds ago`);
                    node.status({ fill: "yellow", shape: "dot", text: `Data stream ${svcKey} outdated` });
                    outputContext.split.push(null);
                    return;
                }

                // Calculate the output based on the row configuration
                const output = getOutput(node, row, { status, values, timestamp });
                const changed = cached?.output !== output;

                // Update the previous state
                // PS. cached points to the object that was at previousRows[i] at the time of assignment, it's not updated
                previousRows[i] = { status, values, timestamp, output };

                // Validate the output depending on the output mode
                if (output === null && cached?.output === undefined) return;

                if (node.outputMode === "all" && node.msgType !== "together" && !stream) {
                    outputContext.split.push(null);
                    return;
                }

                if (node.outputMode === "change" && node.msgType !== "together" && !changed) {
                    outputContext.split.push(null);
                    return;
                }

                // Prepare the output msg
                const outMsg = {
                    ...msg,
                    topic: topic,
                    payload: output,
                    controller: { id: node.controller.id, uniqueId: node.controller.uniqueId, host: node.controller.host }
                };

                // Store the output message to different variables based on message type
                outputContext.split.push(outMsg);
                outputContext.separate.push(outMsg);
                outputContext.combined[topic] = output;
                outputContext.changed ||= changed;
            });

            handleOutput(node, msg, outputContext);
        });

        function handleOutput(node, msg, ctx) {
            const rows = node.mappings.length;
            const formatTime = formatDate();

            // Send each output message separately
            if (node.msgType === "separate") {
                const count = ctx.separate.length;
                const values = ctx.separate.map((m) => m.payload).join(", ");

                node.status({ fill: count === 0 ? "grey" : "green", shape: "dot", text: `Output ${count} of ${rows} values: ${values} (${formatTime})` });
                ctx.separate.forEach((m) => node.send(m));
                return;
            }

            // Send {topic: value} pairs
            if (node.msgType === "together") {
                const noSend = node.outputMode === "change" && !ctx.changed;

                const outMsg = { ...msg, payload: ctx.combined };
                delete outMsg.topic;

                const count = noSend ? 0 : Object.keys(ctx.combined).length;
                const values = noSend ? [] : Object.values(ctx.combined).join(", ");

                node.status({ fill: count === 0 ? "grey" : "green", shape: "dot", text: `Output ${count} of ${rows} values: ${values} (${formatTime})` });
                if (count > 0) node.send(outMsg);
                return;
            }

            // Send to different output ports as array
            if (node.msgType === "split") {
                const filtered = ctx.split.filter((m) => m !== null);
                const count = filtered.length;
                const values = filtered.map((m) => m.payload).join(", ");

                node.status({ fill: count === 0 ? "grey" : "green", shape: "dot", text: `Output ${count} of ${rows} values: ${values} (${formatTime})` });
                if (count > 0) node.send(ctx.split);
            }
        }

        // Function to retrieve the output value based on the row configuration
        function getOutput(node, row, obj = {}) {
            const { status, values, timestamp } = obj;
            const dataType = row.dataType;

            if (dataType === "value") {
                // Retrieve value at the specified index (adjust for 0-based index)
                const index = row.index - 1;
                const coefficient = formatCoefficient(node, row);
                const value = values?.[index];
                return value === undefined ? null : parseFloat((value / coefficient).toFixed(2));
            }

            if (dataType === "status") return status ?? null;
            if (dataType === "timestamp") return timestamp ?? null;

            return null;
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

    RED.nodes.registerType("fusebox-read-static-data-streams", ReadDynamicDataStreamsNode);
};
