import mqtt from "mqtt";

// Topic scheme per docs/BLE_PROVISIONING_PROTOCOL.md §5 — this is what
// provisioning (src/provisioning/strategies/bleWifi.js) actually hands the
// device, so the broker must speak the same topics or a provisioned device
// has nowhere for its messages to land. Only `messages` (inbound) and `cmd`
// (outbound) are wired up here; `cmd/result`, `config`, and `status` are
// part of the wire contract but not yet consumed by this POC.
export function createMqttAdapter({ url, onInbound, logger = console }) {
  const client = mqtt.connect(url, { reconnectPeriod: 2000 });

  client.on("connect", () => {
    logger.log(`[mqtt] connected to ${url}`);
    client.subscribe("devices/+/messages", (err) => {
      if (err) logger.error("[mqtt] subscribe failed", err);
    });
  });

  client.on("reconnect", () => logger.warn("[mqtt] reconnecting..."));
  client.on("error", (err) => logger.error("[mqtt] error", err.message));

  client.on("message", (topic, payload) => {
    const clientId = topic.split("/")[1];
    onInbound({ clientId, topic, payload, receivedAt: new Date().toISOString() });
  });

  return {
    id: "mqtt",
    sendOutbound: ({ clientId, payload }) =>
      new Promise((resolve, reject) => {
        client.publish(`devices/${clientId}/cmd`, payload, (err) =>
          err ? reject(err) : resolve()
        );
      }),
    stop: () => client.endAsync(),
  };
}
