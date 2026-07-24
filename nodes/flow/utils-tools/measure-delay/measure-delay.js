/**
 * This node measures the delay between a "trigger" message and a matching response ("partner") message.
 *  ▸ waits until partner == trigger  → ok  (lag > 0 ms, trig = part = val)
 *  ▸ during wait: mismatch updates badge, keeps waiting
 *  ▸ after ok   : mismatch badge + message if values diverge again
 *  ▸ timeout    : red badge + message with both values
 *  ▸ null / undefined never match anything
 */
module.exports = function (RED) {
    function DelayedCompareNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Configuration
        const trigTopic = (config.trigger || "").trim();
        const partTopic = (config.partner || "").trim(); // blank ⇒ any topic
        const timeoutMs = Number(config.timeout) || 1000;
        const responseType = config.responseType || "exact"; // 'exact' or 'tolerance'
        const tolerance = Number(config.tolerance) || 0;

        // Initialize node state variables
        let armed = false; // in waiting phase?
        let timedOut = false; // timeout occurred but still waiting for response
        let refVal = undefined; // trigger value for current wait
        let timer = null;
        let lastPartner = undefined; // last partner value
        let tStart = 0; // ms epoch when armed

        // Helper functions
        function isNumeric(v) {
            return (typeof v === "number" && !isNaN(v)) || (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)));
        }

        function compareValues(a, b) {
            // undefined/null never match
            if (a === undefined || b === undefined) return false;
            if (a === null || b === null) return false;

            // If tolerance mode and both numeric-ish, compare numerically
            if (responseType === "tolerance" && isNumeric(a) && isNumeric(b)) {
                const na = Number(a);
                const nb = Number(b);
                return Math.abs(na - nb) <= tolerance;
            }

            // If both objects, deep-compare via JSON
            if (typeof a === "object" && typeof b === "object") {
                try {
                    return JSON.stringify(a) === JSON.stringify(b);
                } catch (e) {
                    return false;
                }
            }

            // Fallback to strict equality for scalars
            return a === b;
        }

        const badge = {
            armed: () =>
                node.status({
                    fill: "blue",
                    shape: "dot",
                    text: `Triggered: ${trigTopic} → ${partTopic || "any"} (${formatDate()})`
                }),
            ok: (ms, v) =>
                node.status({
                    fill: "green",
                    shape: "dot",
                    text: `Ok: ${trigTopic}=${partTopic || "any"}=${JSON.stringify(v)} in ${ms}ms (${formatDate()})`
                }),
            okLate: (ms, v) =>
                node.status({
                    fill: "yellow",
                    shape: "dot",
                    text: `Late: ${trigTopic}=${partTopic || "any"}=${JSON.stringify(v)} in ${ms}ms (${formatDate()})`
                }),
            mismatch: (tv, pv) =>
                node.status({
                    fill: "red",
                    shape: "ring",
                    text: `Topic mismatch: ${trigTopic}=${JSON.stringify(tv)}, ${partTopic || "any"}=${JSON.stringify(pv)} (${formatDate()})`
                }),
            tout: (tv, pv) =>
                node.status({
                    fill: "red",
                    shape: "ring",
                    text: `Timeout: ${trigTopic}=${JSON.stringify(tv)}, ${partTopic || "any"}=${JSON.stringify(pv)} in ${timeoutMs}ms (${formatDate()})`
                })
        };

        function reset() {
            armed = false;
            timedOut = false;
            refVal = undefined;

            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        }

        /**
         * Format the current date and time as DD/MM/YYYY HH:MM:SS
         */
        function formatDate() {
            const now = new Date();

            return now.toLocaleString("en-GB", {
                day: "2-digit",
                month: "2-digit",
                year: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: false // Use 24-hour format
            }); // 'en-GB' locale for DD/MM/YYYY format
        }

        // Main message handler
        node.on("input", (msg) => {
            if (!("payload" in msg)) return; // ignore empty msgs

            const topic = msg.topic || "";
            const val = msg.payload;

            // Recognise partner messages and remember value
            const partnerHit = (!partTopic && topic !== trigTopic) || (partTopic && topic === partTopic);
            if (partnerHit) lastPartner = val;

            // Trigger message
            if (topic === trigTopic) {
                reset();

                // Start waiting
                armed = true;
                refVal = val;
                tStart = Date.now();

                timer = setTimeout(() => {
                    timedOut = true; // mark as timed out but keep waiting
                    badge.tout(refVal, lastPartner);
                    node.send({
                        error: "timeout",
                        ms: timeoutMs,
                        trigger: refVal,
                        partner: lastPartner
                    });

                    // Don't reset here - keep waiting for late response
                }, timeoutMs);

                badge.armed();
                return;
            }

            // Partner message while armed (or after timeout)
            if (partnerHit && armed) {
                if (compareValues(val, refVal)) {
                    const ms = Date.now() - tStart;

                    if (ms > 0) {
                        if (timedOut) {
                            // Response received after timeout - show yellow OK
                            badge.okLate(ms, val);
                            node.send({ ok: true, late: true, ms, value: val });
                        } else {
                            // Response received within timeout - show green OK
                            badge.ok(ms, val);
                            node.send({ ok: true, late: false, ms, value: val });
                        }
                    }

                    reset();
                } else {
                    badge.mismatch(refVal, val); // keep waiting
                }

                return;
            }
        });

        node.on("close", () => {
            reset();
            node.status({});
        });
    }

    RED.nodes.registerType("fusebox-measure-delay", DelayedCompareNode);
};
