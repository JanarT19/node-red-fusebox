// Custom node to read data streams from the global context.
// Outputs the value / status / timestamp of a data stream.
module.exports = function (RED) {
    function ReadDynamicDataStreamNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        var previousValues = {};

        // Retrieve configuration settings
        node.name = config.name;
        node.outputMode = config.outputMode;

        node.keyName = config.keyName;
        node.keyNameType = config.keyNameType;

        node.index = config.index;
        node.indexType = config.indexType;

        node.dataType = config.dataType;
        node.dataTypeType = config.dataTypeType;

        node.coefficient = config.coefficient;
        node.coefficientType = config.coefficientType;

        node.topic = config.topic;
        node.topicType = config.topicType;

        // Retrieve the config node's settings
        node.controller = RED.nodes.getNode(config.controller);

        // Validate the controller configuration
        if (!node.controller || !node.controller.host || (!node.controller.httpPort && !node.controller.udpPort)) {
            node.error("Controller configuration invalid");
            node.status({ fill: "red", shape: "dot", text: "Controller configuration invalid" });
            return;
        }

        // Initialize global context to get and set values
        const globalStatesKey = `${node.controller.uniqueId}_states`;
        const globalAllStatesKey = `${node.controller.uniqueId}_allstates`; // Fallback
        const globalContext = node.context().global;

        // Validation constants
        const invalidValues = ["", null, undefined];
        const outputModeValid = ["change", "all"];
        const dataTypeValid = ["value", "status", "timestamp"];

        // Listen for input messages
        node.on("input", function (msg) {
            const dataStreams = globalContext.get(globalStatesKey);
            const fallbackDataStreams = globalContext.get(globalAllStatesKey);

            const outputMode = node.outputMode;

            const keyName = evaluate(node.keyName, node.keyNameType, node, msg);
            const dataType = evaluate(node.dataType, node.dataTypeType, node, msg);
            const index = parseInt(evaluate(node.index, node.indexType, node, msg));
            const coefficient = parseFloat(evaluate(node.coefficient, node.coefficientType, node, msg));
            const topic = evaluate(node.topic, node.topicType, node, msg);

            // Basic validation
            if (!keyName) {
                node.error("Data stream name required");
                node.status({ fill: "red", shape: "dot", text: "Data stream name required" });
                return;
            }

            if (!dataStreams && !fallbackDataStreams) {
                node.error("No data streams queried");
                node.status({ fill: "red", shape: "dot", text: `No data streams queried from: ${node.controller.uniqueId}` });
                return;
            }

            if (!dataStreams?.[keyName] && !fallbackDataStreams?.[keyName]) {
                node.error(`Unknown data stream: ${keyName}`);
                node.status({ fill: "red", shape: "dot", text: `Unknown data stream: ${keyName}` });
                return;
            }

            if (!dataTypeValid.includes(dataType)) {
                node.error(`Data type must be one of: ${dataTypeValid.join(", ")}`);
                node.status({ fill: "red", shape: "dot", text: `Invalid data type: ${dataType}` });
                return;
            }

            if (!outputModeValid.includes(outputMode)) {
                node.error(`Output mode must be one of: ${outputModeValid.join(", ")}`);
                node.status({ fill: "red", shape: "dot", text: `Invalid output mode: ${outputMode}` });
                return;
            }

            if (dataType === "value" && (invalidValues.includes(index) || isNaN(index) || index < 1)) {
                node.error("Valid member index required");
                node.status({ fill: "red", shape: "dot", text: "Valid member index required" });
                return;
            }

            if (dataType === "value" && (invalidValues.includes(coefficient) || isNaN(coefficient))) {
                node.error("Valid coefficient required");
                node.status({ fill: "red", shape: "dot", text: "Valid coefficient required" });
                return;
            }

            const status = dataStreams?.[keyName]?.status ?? fallbackDataStreams?.[keyName]?.status;
            const values = dataStreams?.[keyName]?.values ?? fallbackDataStreams?.[keyName]?.values;
            const timestamp = dataStreams?.[keyName]?.timestamp ?? fallbackDataStreams?.[keyName].timestamp;

            if (status === undefined || values === undefined || timestamp === undefined) {
                node.error("Data stream object incomplete");
                node.status({ fill: "red", shape: "dot", text: "Data stream object incomplete" });
                return;
            }

            const parameters = {
                name: keyName,
                type: dataType,
            };

            if (dataType === "value") {
                parameters.index = index;
                parameters.coefficient = coefficient;
            }

            const output = getOutput(node, parameters, { status, values, timestamp });
            const color = getColor(status, output);
            const text = getText(parameters, output);

            node.status({ fill: color, shape: "dot", text: text });

            // Initialize the previous values object
            const previousValue = getPreviousValue(previousValues, parameters);

            // Check output mode and compare with previous value
            // Do not send output if the value/status hasn't changed
            if (outputMode === "change" && previousValue !== null && previousValue === output) {
                node.status({ fill: "grey", shape: "dot", text: text });
                return;
            }

            // Do not send output during startup
            if (output === null && previousValue === null) return;

            setPreviousValue(previousValues, { ...parameters, output });

            // Prepare the output msg
            const outMsg = {
                ...msg,
                parameters,
                payload: output,
                controller: { id: node.controller.id, uniqueId: node.controller.uniqueId, host: node.controller.host },
            };

            // Remove unnecessary values from the output message
            delete outMsg.name;
            delete outMsg.index;
            delete outMsg.type;
            delete outMsg.coefficient;

            // Optionally set the output topic, or leave it unchanged
            if (!invalidValues.includes(topic)) {
                outMsg.topic = topic;
            }

            // Send the output message
            node.send(outMsg);
        });

        // Evaluate the value of a property, catching any errors (e.g. read properties of undefined : msg.payload.success)
        function evaluate(value, type, node, msg) {
            try {
                return RED.util.evaluateNodeProperty(value, type, node, msg);
            } catch (err) {
                return undefined;
            }
        }

        function getPreviousValue(previousValues, parameters = {}) {
            const { name, type, index } = parameters;

            if (!previousValues[name]) {
                previousValues[name] = { value: {}, status: null, timestamp: null };
            }

            if (type === "value") {
                return previousValues[name][type][index] ?? null;
            } else {
                return previousValues[name][type] ?? null;
            }
        }

        function setPreviousValue(previousValues, parameters = {}) {
            const { name, type, index, output } = parameters;

            if (type === "value") {
                previousValues[name][type][index] = output;
            } else {
                previousValues[name][type] = output;
            }
        }

        function getColor(status, output) {
            const val = parseInt(status);

            if (output === null) return "red";

            if (val === 0) {
                return "green";
            } else if (val === 1) {
                return "yellow";
            } else if (val === 2) {
                return "red";
            } else {
                return "grey";
            }
        }

        function getText(parameters = {}, output) {
            const { name, index, type } = parameters;

            if (type === "value") {
                return output != null ? `Value of ${name}.${index}: ${output} (${formatDate()})` : "Value not found";
            }

            if (type === "status") {
                return output != null ? `Status of ${name}: ${output} (${formatDate()})` : "Status not found";
            }

            if (type === "timestamp") {
                return output != null ? `Timestamp of ${name}: ${output} (${formatDate()})` : "Timestamp not found";
            }

            return "Unknown data type selected";
        }

        function getOutput(node, parameters = {}, obj = {}) {
            const { index, type } = parameters;

            if (type === "value") {
                // Retrieve value at the specified index (adjust for 0-based index)
                const idx = index - 1;
                const coefficient = formatCoefficient(node, parameters);

                // Update the coefficient in the parameters object
                parameters.coefficient = coefficient;

                let value = obj.values?.[idx] ?? null;

                if (value === null) return null;

                return parseFloat((value / coefficient).toFixed(2));
            }

            if (type === "status") {
                return obj.status ?? null;
            }

            if (type === "timestamp") {
                return obj.timestamp ?? null;
            }

            return null;
        }

        // Return the coefficient for the specified row, or default to 1 if not found
        function formatCoefficient(node, parameters = {}) {
            const services = node.controller?.services || {};
            const { name, coefficient } = parameters;

            let coef = coefficient;

            if (name && services[name]) {
                coef = services[name]?.conv_coef || coef;
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

    RED.nodes.registerType("fusebox-read-dynamic-data-stream", ReadDynamicDataStreamNode);
};
