// to provide the module access to the Node-RED runtime API
module.exports = function (RED) {
    // weather-data node
    function WeatherNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Retrieve configuration settings
        node.name = config.name;
        node.location = config.location;

        const weatherstack_key = this.credentials.weatherstack_key;

        node.on("input", function (msg) {
            let locationName = node.location ?? msg.payload;
            node.debug("locationName: " + locationName);

            if (!locationName || !weatherstack_key) {
                node.error("Input data not provided.", msg);
            } else {
                forecast(node, locationName, weatherstack_key, (error, data) => {
                    if (error) {
                        node.error(error, msg);
                    } else {
                        msg.payload = {
                            location: data.location,
                            current: data.current,
                            description: data.current.weather_descriptions.join(", "),
                            temperature: data.current.temperature,
                            temperature: data.current.wind_speed,
                        };

                        node.send(msg);
                    }
                });
            }
        });

        // Get the weather information from the coordinates of the location provided
        async function forecast(node, locationName, access_key, callback) {
            const fetch = (await import("node-fetch")).default;

            const url = "http://api.weatherstack.com/current?access_key=" + access_key + "&query=" + locationName;
            node.debug(url);

            fetch(url)
                .then((response) => response.json())
                .then((body) => {
                    if (body.error) {
                        callback("Unable to find location.", undefined);
                        node.error(body.error);
                    } else {
                        callback(undefined, body);
                    }
                })
                .catch((error) => {
                    callback("Unable to connect to weather service.", undefined);
                    node.error(error);
                });
        }
    }

    // Register the WeatherNode function as a node
    RED.nodes.registerType("fusebox-weather-data", WeatherNode, {
        credentials: {
            weatherstack_key: { type: "password" },
        },
    });
};
