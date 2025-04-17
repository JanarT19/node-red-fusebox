const RuleManager = require("./RuleManager");

// Boolean logic node
// Refactored from node-red-contrib-bool-gate: https://flows.nodered.org/node/node-red-contrib-bool-gate
module.exports = function (RED) {
    function BooleanLogicNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Retrieve configuration settings
        node.rules = config.rules || [];
        node.topic = config.outputTopic ?? null;
        node.type = config.gateType || "and";
        node.mode = config.outputMode || "all";

        this.ruleManager = new RuleManager(RED, node, node.type);

        // Validation constants
        const invalidValues = ["", null, undefined];

        // Store all rules during the initialization
        this.ruleManager.storeRules(node.rules).then((obj) => {
            node.status({ fill: "grey", shape: "dot", text: "Node initialized" });
        });

        // Listen for input messages
        node.on("input", function (msg) {
            this.ruleManager.updateState(msg).then((obj) => {
                const { result, parameters, metadata } = obj;

                if (node.mode === "all" || (node.mode === "true" && result) || (node.mode === "false" && !result)) {
                    const outMsg = { ...msg, payload: result, parameters, trigger: {} };
                    delete outMsg.topic;

                    if (!invalidValues.includes(node.topic)) outMsg.topic = node.topic;
                    if (!invalidValues.includes(msg.payload)) outMsg.trigger.payload = msg.payload;
                    if (!invalidValues.includes(msg.topic)) outMsg.trigger.topic = msg.topic;

                    node.status({ fill: result ? "green" : "red", shape: "dot", text: `${metadata.validated} of ${metadata.total}, output: ${result} (${formatDate()})` });

                    node.send(outMsg);
                } else {
                    node.status({ fill: "grey", shape: "dot", text: `${metadata.validated} of ${metadata.total}, no output (${formatDate()})` });
                }
            });
        });

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

    RED.nodes.registerType("fusebox-boolean-logic", BooleanLogicNode);
};
