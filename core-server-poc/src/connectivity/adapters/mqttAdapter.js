import mqtt from "mqtt";

// Topic scheme per docs/BLE_PROVISIONING_PROTOCOL.md §5 — this is what
// provisioning (src/provisioning/strategies/bleWifi.js) actually hands the
// device, so the broker must speak the same topics or a provisioned device
// has nowhere for its messages to land. Wired up: `messages` (inbound
// telemetry), `cmd` (outbound commands), `config` (outbound, retained config
// pushes) and `cmd/result` (inbound results, e.g. config apply outcomes).
// `status` (retained presence: online / last-will offline) feeds the device
// registry for the web console, and `telemetry` (CPU, memory, uptime...)
// keeps each device's latest reading for it.
export function createMqttAdapter({ url, onInbound, onResult = () => {}, onStatus = () => {}, onTelemetry = () => {}, logger = console }) {
  // The broker requires a login: the Core's is "core" / CORE_MQTT_PASSWORD.
  const client = mqtt.connect(url, {
    reconnectPeriod: 2000,
    clientId: `core-${process.pid}`,
    username: "core",
    password: process.env.CORE_MQTT_PASSWORD,
  });

  client.on("connect", () => {
    logger.log(`[mqtt] connected to ${url}`);
    client.subscribe(["devices/+/messages", "devices/+/cmd/result", "devices/+/status", "devices/+/telemetry"], (err) => {
      if (err) logger.error("[mqtt] subscribe failed", err);
    });
  });

  client.on("reconnect", () => logger.warn("[mqtt] reconnecting..."));
  client.on("error", (err) => logger.error("[mqtt] error", err.message));

  client.on("message", (topic, payload) => {
    const [, clientId, kind, sub] = topic.split("/");
    const msg = { clientId, topic, payload, receivedAt: new Date().toISOString() };
    if (kind === "messages") onInbound(msg);
    else if (kind === "cmd" && sub === "result") onResult(msg);
    else if (kind === "status") onStatus(msg);
    else if (kind === "telemetry") onTelemetry(msg);
  });

  return {
    id: "mqtt",
    sendOutbound: ({ clientId, payload }) =>
      new Promise((resolve, reject) => {
        client.publish(`devices/${clientId}/cmd`, payload, (err) =>
          err ? reject(err) : resolve()
        );
      }),
    // Retained + QoS 1 per docs (esp32-c6-control ARCHITECTURE.md §5.3): a
    // device that is offline gets the latest config as soon as it subscribes.
    publishConfig: (clientId, payload) =>
      client.publishAsync(`devices/${clientId}/config`, payload, { qos: 1, retain: true }),
    stop: () => client.endAsync(),
  };
}
