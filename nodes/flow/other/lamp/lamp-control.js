// Implements a lamp control node that can handle multiple input channels
// Each input channel can have its own behavior, controlling the same output
// The output state is determined by combining the effects of all active inputs
// Optional delay measurement tracks time from input change to confirmed output change
module.exports = function (RED) {
    function LampControlNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.name = config.name;

        // Basic configuration
        node.timeout = parseInt(config.timeout) || 0;
        node.outputTopic = config.outputTopic;
        node.mappings = config.mappings || [];

        // State variables
        node.actout = false; // Current output state
        node.lastInputs = {}; // Track last state of each input

        node.tsOn = 0; // When turned on
        node.tsProcess = null; // When output change was requested (for delay measurement)

        node.measureDelay = true; // Enable/disable delay measurement
        node.pendingChange = null; // Track pending output change for delay measurement

        // Constants for mtype bits
        // These bits control the behavior of each input channel
        const BITS = {
            UP: 1, // bit 0: Respond to high level or rising edge
            DOWN: 2, // bit 1: Respond to low level or falling edge
            ON: 4, // bit 2: Output action bit 0
            OFF: 8, // bit 3: Output action bit 1 (ON+OFF = invert)
            EDGE: 16, // bit 4: Is this an edge trigger (change) rather than level
            EXTEND: 32 // bit 5: Extend timeout when input triggers
        };

        // Listen for input messages
        node.on("input", function (msg) {
            // Find which input channel this message is for
            const inputs = node.mappings.filter((mapping) => mapping.topic === msg.topic);

            // In case of multiple topics with the same name, keep old value same for all
            let oldValue = null;

            if (inputs.length > 0) {
                oldValue = node.lastInputs[msg.topic];
            }

            for (const input of inputs) {
                // Verify payload is valid
                if (!["string", "number", "boolean"].includes(typeof msg?.payload)) {
                    node.warn(`Invalid payload type for topic ${input.topic}`);
                    node.status({ fill: "yellow", shape: "dot", text: `Invalid payload type for ${input.topic}` });
                    return;
                }

                // Convert boolean payloads to 1/0
                if (typeof msg.payload === "boolean") {
                    msg.payload = msg.payload ? 1 : 0;
                }

                // Extract value from input topic
                const newValue = parseInt(msg.payload) === 1;

                // Update cache with the new value
                node.lastInputs[input.topic] = newValue;

                node.debug(`Incoming input ${input.topic} value: ${oldValue} -> ${newValue}`);

                // If no initialized level-trigger rows exist, skip processing
                const overwriteExist = overwriteRowsExist();
                const initializedOverwriteRows = findInitializedOverwriteRows();

                if (overwriteExist && initializedOverwriteRows.length === 0) {
                    node.debug(`Discarded input ${input.topic} due to no initialized level-trigger rows`);
                    node.status({ fill: "grey", shape: "dot", text: `No initialized level-trigger rows (${formatDate()})` });
                    return;
                }

                // If a level-trigger input is active, and incoming msg topic is not related to that row, discard
                const activeOverwrite = findActiveOverwriteRow();

                if (activeOverwrite && activeOverwrite.topic !== input.topic) {
                    node.debug(`Discarded input ${input.topic} due to active level-trigger input`);
                    node.status({ fill: "grey", shape: "dot", text: `Discarded input due to active level-trigger (${formatDate()})` });
                    return;
                }

                // Calculate new output state based on the input
                const oldOut = node.actout;
                let newOut = calculateOutput(input, oldValue, newValue);

                if (newOut !== null) {
                    if (newOut !== oldOut) {
                        node.actout = newOut;

                        // Reset timeout if output is turned ON
                        if (newOut) {
                            node.tsOn = Date.now();
                            node.debug(`Output turned ON, timeout set to ${node.timeout}s`);
                        }

                        // Record timestamp for delay measurement if enabled
                        if (node.measureDelay) {
                            node.tsProcess = Date.now();
                            node.pendingChange = newOut;
                        }
                    }

                    node.debug(`Output state changed: ${oldOut} -> ${newOut} (triggered by ${input.topic})`);
                    node.status({ fill: "green", shape: "dot", text: `Output ${newOut ? "ON" : "OFF"} (${formatDate()})` });

                    // Send output message
                    node.send({
                        topic: node.outputTopic,
                        payload: newOut ? 1 : 0
                    });
                }
            }

            if (msg.topic === node.outputTopic && node.measureDelay && node.pendingChange !== null) {
                // This is a response to our output change - measure the delay
                const value = parseInt(msg.payload) === 1;

                if (value === node.pendingChange) {
                    let delay = (Date.now() - node.tsProcess) / 1000;
                    node.debug(`Output change confirmed, delay: ${delay.toFixed(3)}s`);
                    node.pendingChange = null;
                }
            } else if (msg.topic !== node.outputTopic) {
                // node.warn(`Unknown topic: ${msg.topic}`);
                // node.status({ fill: "yellow", shape: "dot", text: `Unknown topic: ${msg.topic}` });
            }
        });

        // Return whether at least one level-trigger (overwrite) row exists
        function overwriteRowsExist() {
            for (const mapping of node.mappings) {
                const mtype = mapping.mtype;
                const isEdgeTrigger = Boolean(mtype & BITS.EDGE);

                // This is a level-based input that can overwrite other inputs
                if (!isEdgeTrigger) {
                    return true;
                }
            }

            return false;
        }

        // Find level-trigger rows that have received input values
        function findInitializedOverwriteRows() {
            const rows = [];

            for (const mapping of node.mappings) {
                const mtype = mapping.mtype;
                const topic = mapping.topic;
                const value = node.lastInputs[topic];
                const isEdgeTrigger = Boolean(mtype & BITS.EDGE);

                // This is a level-based input
                if (!isEdgeTrigger) {
                    if (value !== undefined) {
                        rows.push(mapping);
                    }
                }
            }

            return rows;
        }

        // Find the first active rows which overwrites other signals
        function findActiveOverwriteRow() {
            const rows = [];

            for (const mapping of node.mappings) {
                const topic = mapping.topic;
                const mtype = mapping.mtype;
                const value = node.lastInputs[topic];

                // Check if this is a level (not edge) trigger
                const isEdgeTrigger = Boolean(mtype & BITS.EDGE);

                // It's a level-based input
                if (!isEdgeTrigger) {
                    if (mtype & BITS.UP && value) {
                        rows.push(mapping);
                    } else if (mtype & BITS.DOWN && !value) {
                        rows.push(mapping);
                    }
                }
            }

            if (rows.length === 0) {
                return null; // No active level-trigger rows
            }

            // If multiple rows are active, return the first one
            return rows[0];
        }

        // Calculate output based on all active inputs
        // Each input can affect the output based on its configuration
        function calculateOutput(input, oldValue, newValue) {
            const mtype = input.mtype;
            const oldOut = node.actout;
            let newOut = null;

            const hasChanged = oldValue !== newValue;

            node.debug(`Processing ${input.topic}: value=${newValue}, mtype=${mtype}`);

            // Check if this is an edge or level trigger
            const isEdgeTrigger = Boolean(mtype & BITS.EDGE);

            // Extract output action (ON, OFF, or INVERT)
            const outputAction = (mtype >> 2) & 3; // Extract bits 2-3

            // Check if we should respond to this input state
            let shouldRespond = false;

            // Edge trigger - respond on changes
            if (isEdgeTrigger) {
                // If both UP and DOWN bits are set (on-any-change), respond to any change in value
                if (mtype & BITS.UP && mtype & BITS.DOWN && hasChanged) {
                    shouldRespond = true;
                    node.debug(`Any edge change detected on ${input.topic}`);
                } else if (mtype & BITS.UP && !oldValue && newValue) {
                    // Rising edge: previous=false, current=true
                    shouldRespond = true;
                    node.debug(`Rising edge detected on ${input.topic}`);
                } else if (mtype & BITS.DOWN && oldValue && !newValue) {
                    // Falling edge: previous=true, current=false
                    shouldRespond = true;
                    node.debug(`Falling edge detected on ${input.topic}`);
                } else {
                    // No change detected, do not respond
                    node.debug(`No edge change detected on ${input.topic}`);
                }
            } else {
                // Level trigger - respond to current state
                if (mtype & BITS.UP && newValue) {
                    shouldRespond = true;
                    node.debug(`High level detected on ${input.topic}`);
                } else if (mtype & BITS.DOWN && !newValue) {
                    shouldRespond = true;
                    node.debug(`Low level detected on ${input.topic}`);
                } else {
                    // No level change detected, do not respond
                    node.debug(`No level change detected on ${input.topic}`);
                }
            }

            // If we should respond, apply the output action
            if (shouldRespond) {
                switch (outputAction) {
                    case 1: // ON (bit 2 set, bit 3 clear)
                        // Extend bit is only applicable for edge triggers
                        if (isEdgeTrigger && mtype & BITS.EXTEND && oldOut) {
                            // Don't change output state, just extend the timeout
                            node.tsOn = Date.now(); // Extend timeout
                            node.debug(`Timeout extended by ${input.topic}`);
                            node.status({ fill: "green", shape: "ring", text: `Timeout extended (${formatDate()})` });
                        } else if (isEdgeTrigger && mtype & BITS.EXTEND && !oldOut) {
                            node.status({ fill: "grey", shape: "ring", text: `Timeout not extened (${formatDate()})` });
                        } else if (!(mtype & BITS.EXTEND)) {
                            // Otherwise, turn output ON
                            newOut = true;
                        }
                        break;

                    case 2: // OFF (bit 2 clear, bit 3 set)
                        newOut = false;
                        break;

                    case 3: // INVERT (bit 2 set, bit 3 set)
                        newOut = !oldOut;
                        break;
                }
            }

            return newOut;
        }

        // Check timeout periodically
        if (node.timeout > 0) {
            setInterval(() => {
                if (node.actout && Date.now() - node.tsOn > node.timeout * 1000) {
                    const activeOverwrite = findActiveOverwriteRow();

                    // Edge case: if a level-trigger input is active, never turn off
                    if (activeOverwrite) {
                        node.status({ fill: "green", shape: "ring", text: `Level-trigger active, timeout disabled (${formatDate()})` });
                        return;
                    }

                    node.actout = false;

                    node.status({ fill: "grey", shape: "dot", text: `Output OFF after timeout (${formatDate()})` });
                    node.debug(`Timeout reached (${node.timeout}s), turning output OFF`);

                    node.send({
                        topic: node.outputTopic,
                        payload: 0
                    });
                }
            }, 1000);
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

    // Node definition
    RED.nodes.registerType("fusebox-lamp-control", LampControlNode);
};
