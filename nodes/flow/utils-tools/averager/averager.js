module.exports = function (RED) {
    function AveragerNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Configuration
        node.inputTopics = config.inputTopics || [];
        node.outputTopic = config.outputTopic;
        node.outputMode = config.outputMode || "trigger";
        node.triggerTopic = config.triggerTopic;
        node.intervalSec = parseInt(config.intervalSec) || 60;
        node.minIntervalSec = parseInt(config.minIntervalSec) || 5;
        node.timeoutSec = parseInt(config.timeoutSec) || 300;
        node.minValues = parseInt(config.minValues) || 1;
        node.precision = parseInt(config.precision) || 2;

        // State: cache values from input topics
        const cache = {}; // { topic: { value: number, timestamp: Date } }
        let intervalTimer = null;
        let lastPublishTime = 0;

        // Parse input topics from config
        const topicPatterns = node.inputTopics
            .map((t) => {
                const topic = t.manual ? t.topicManual : t.topicSelect;
                return topic ? topic.trim() : null;
            })
            .filter((t) => t);

        if (topicPatterns.length === 0) {
            node.error("No input topics configured");
            node.status({ fill: "red", shape: "dot", text: `No input topics (${formatDate()})` });
            return;
        }

        // Helper: Check if topic matches any pattern (supports wildcards)
        function matchesPattern(topic, pattern) {
            // Convert MQTT wildcards to regex
            // + matches single level, # matches multiple levels
            if (pattern.includes("+") || pattern.includes("#")) {
                const regexPattern = pattern.replace(/\+/g, "[^/]+").replace(/#/g, ".*").replace(/\//g, "\\/");
                const regex = new RegExp(`^${regexPattern}$`);
                return regex.test(topic);
            }
            // Also support ? wildcard for single character
            if (pattern.includes("?")) {
                const regexPattern = pattern.replace(/\?/g, ".").replace(/\//g, "\\/");
                const regex = new RegExp(`^${regexPattern}$`);
                return regex.test(topic);
            }
            return topic === pattern;
        }

        // Helper: Calculate average from cache
        function calculateAverage() {
            const now = Date.now();
            const validEntries = [];

            for (const [topic, entry] of Object.entries(cache)) {
                const age = (now - entry.timestamp) / 1000; // seconds
                if (age <= node.timeoutSec) {
                    validEntries.push(entry.value);
                }
            }

            if (validEntries.length < node.minValues) {
                return null;
            }

            const sum = validEntries.reduce((acc, val) => acc + val, 0);
            const avg = sum / validEntries.length;
            return parseFloat(avg.toFixed(node.precision));
        }

        // Helper: Publish average to output topic
        function publishAverage() {
            const avg = calculateAverage();

            if (avg === null) {
                node.status({
                    fill: "yellow",
                    shape: "dot",
                    text: `Insufficient data: ${Object.keys(cache).length}/${node.minValues} (${formatDate()})`
                });
                return;
            }

            const msg = {
                topic: node.outputTopic,
                payload: avg
            };

            node.send(msg);
            node.status({
                fill: "green",
                shape: "dot",
                text: `${Object.keys(cache).length} topics → ${avg} (${formatDate()})`
            });
        }

        // Handle incoming messages
        node.on("input", function (msg) {
            const topic = msg.topic;

            // Check if this is a trigger message
            if (node.outputMode === "trigger" && topic === node.triggerTopic) {
                publishAverage();
                return;
            }

            // Check if topic matches any input pattern
            let matched = false;
            for (const pattern of topicPatterns) {
                if (matchesPattern(topic, pattern)) {
                    matched = true;
                    break;
                }
            }

            if (!matched) {
                return; // Ignore messages from non-matching topics
            }

            // Update cache
            const value = parseFloat(msg.payload);
            if (isNaN(value)) {
                node.warn(`Invalid numeric value from ${topic}: ${msg.payload}`);
                return;
            }

            cache[topic] = {
                value: value,
                timestamp: Date.now()
            };

            // Handle output based on mode
            if (node.outputMode === "ratelimit") {
                const now = Date.now();
                const timeSinceLastPublish = (now - lastPublishTime) / 1000;

                if (timeSinceLastPublish >= node.minIntervalSec) {
                    publishAverage();
                    lastPublishTime = now;
                }
            }
            // For 'trigger' mode, do nothing here (wait for trigger)
            // For 'interval' mode, do nothing here (timer handles it)
        });

        // Set up interval timer if needed
        if (node.outputMode === "interval") {
            intervalTimer = setInterval(() => {
                publishAverage();
            }, node.intervalSec * 1000);
        }

        // Cleanup on node close
        node.on("close", function () {
            if (intervalTimer) {
                clearInterval(intervalTimer);
                intervalTimer = null;
            }
        });

        // Initial status
        node.status({
            fill: "grey",
            shape: "dot",
            text: `Waiting: ${topicPatterns.length} patterns, mode: ${node.outputMode} (${formatDate()})`
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
                hour12: false // Use 24-hour format
            };

            return now.toLocaleString("en-GB", options); // 'en-GB' locale for DD/MM/YYYY format
        }
    }

    RED.nodes.registerType("fusebox-averager", AveragerNode);
};
