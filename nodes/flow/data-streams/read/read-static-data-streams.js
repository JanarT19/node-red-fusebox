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

        var previousValues = {};
        var currentValues = [];

        // Retrieve the config node's settings
        node.controller = RED.nodes.getNode(config.controller);

        // Validate the controller configuration
        if (!node.controller || !node.controller.host || (!node.controller.httpPort && !node.controller.udpPort)) {
            node.error("Controller configuration invalid");
            node.status({ fill: "red", shape: "dot", text: "Controller configuration invalid" });
            return;
        }

        // Initialize the global context for accessing data streams
        const globalStatesKey = `${node.controller.uniqueId}_states`;
        const globalAllStatesKey = `${node.controller.uniqueId}_allstates`; // Fallback
        const globalContext = node.context().global;

        // Validation constants
        const invalidValues = ["", null, undefined];
        const outputModeValid = ["all", "change"];
        const msgTypeValid = ["separate", "together", "split"];

        // Listen for input messages
        node.on("input", function (msg) {
            const dataStreams = globalContext.get(globalStatesKey);
            const fallbackDataStreams = globalContext.get(globalAllStatesKey);
            const rows = node.mappings.length || 0;
            const outputMode = node.outputMode;
            const msgType = node.msgType;

            const combinedMsg = {};
            currentValues = [];

            // Basic validation
            if (!dataStreams && !fallbackDataStreams) {
                node.error("No data streams queried");
                node.status({ fill: "red", shape: "dot", text: `No data streams queried from: ${node.controller.uniqueId}` });
                return;
            }

            if (!outputModeValid.includes(outputMode)) {
                node.error(`Output mode must be one of: ${outputModeValid.join(", ")}`);
                node.status({ fill: "red", shape: "dot", text: `Invalid output mode: ${outputMode}` });
                return;
            }

            if (!msgTypeValid.includes(msgType)) {
                node.error(`Message type must be one of: ${msgTypeValid.join(", ")}`);
                node.status({ fill: "red", shape: "dot", text: `Invalid message type: ${msgType}` });
                return;
            }

            // Iterate over each row in the mappings and process the data
            node.mappings.forEach((row, i) => {
                const svcKey = row.keyNameSelect || row.keyNameManual;
                const topic = row.topic;

                if (!dataStreams?.[svcKey] && !fallbackDataStreams?.[svcKey]) {
                    node.error(`Unknown data stream: ${svcKey}`);
                    node.status({ fill: "red", shape: "dot", text: `Unknown data stream: ${svcKey}` });
                    return; // Skip to the next row
                }

                const status = dataStreams?.[svcKey]?.status ?? fallbackDataStreams?.[svcKey]?.status;
                const values = dataStreams?.[svcKey]?.values ?? fallbackDataStreams?.[svcKey]?.values;
                const timestamp = dataStreams?.[svcKey]?.timestamp ?? fallbackDataStreams?.[svcKey].timestamp;

                if (status === undefined || values === undefined || timestamp === undefined) {
                    node.error("Data stream object incomplete");
                    node.status({ fill: "red", shape: "dot", text: "Data stream object incomplete" });
                    return;
                }

                if (invalidValues.includes(topic)) {
                    node.error(`Topic undefined for ${svcKey}`);
                    node.status({ fill: "red", shape: "dot", text: `Topic undefined for ${svcKey}` });
                    return;
                }

                const output = getOutput(node, row, { status, values, timestamp });

                // Prepare the output msg
                const outMsg = {
                    ...msg,
                    topic: topic,
                    payload: output,
                    controller: { id: node.controller.id, uniqueId: node.controller.uniqueId, host: node.controller.host },
                };

                // Store the current value for the row, including null values
                currentValues.push(outMsg);

                // Validate the output depending on the output mode
                if (output === null && previousValues[i] === undefined) return;
                if (outputMode === "change" && previousValues[i] === output) return;

                // Store the current value for output mode "change"
                previousValues[i] = output;

                // Store the output message for the combined message object
                combinedMsg[topic] = output;

                // Send the output message
                if (msgType === "separate") {
                    node.send(outMsg);
                }
            });

            // All rows have been processed and are ready to be sent
            const combinedLength = Object.keys(combinedMsg).length;
            const combinedKeys = Object.values(combinedMsg).join(", ");
            const nullMsg = currentValues.filter((msg) => msg.payload === null);
            const nullTopics = nullMsg.map((msg) => msg.topic).join(", ");

            if (combinedLength === rows || outputMode === "change") {
                node.status({
                    fill: combinedLength === 0 ? "grey" : "green",
                    shape: "dot",
                    text: `Output ${combinedLength} of ${rows} values${combinedLength > 0 ? ":" : ""} ${combinedKeys} (${formatDate()})`,
                });
            }

            if (nullMsg.length > 0) {
                node.status({ fill: "red", shape: "dot", text: `Unknown values found: ${nullTopics} (${formatDate()})` });
            }

            // Send {topic: value} pairs
            if (msgType === "together") {
                const outMsg = { ...msg, payload: combinedMsg };
                delete outMsg.topic;

                node.send(outMsg);
            }

            // Send to different output ports as array
            if (msgType === "split") {
                node.send(currentValues);
            }
        });

        function getOutput(node, row, obj = {}) {
            const dataType = row.dataType;

            if (dataType === "value") {
                // Retrieve value at the specified index (adjust for 0-based index)
                const index = row.index - 1;
                const coefficient = formatCoefficient(node, row);
                let value = obj.values?.[index] ?? null;

                if (value === null) return null;

                return parseFloat((value / coefficient).toFixed(2));
            }

            if (dataType === "status") {
                return obj.status ?? null;
            }

            if (dataType === "timestamp") {
                return obj.timestamp ?? null;
            }

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
                hour12: false, // Use 24-hour format
            };

            return now.toLocaleString("en-GB", options); // 'en-GB' locale for DD/MM/YYYY format
        }
    }

    RED.nodes.registerType("fusebox-read-static-data-streams", ReadDynamicDataStreamsNode);
};
