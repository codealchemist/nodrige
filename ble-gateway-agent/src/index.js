import "dotenv/config";
import mqtt from "mqtt";
import { fetchSessionInstructions } from "./coreClient.js";
import { provisionDevice } from "./bleClient.js";
import { createQrInputServer } from "./qrInput.js";

const GATEWAY_CLIENT_ID = process.env.GATEWAY_CLIENT_ID || "ble-gateway-01";
const MQTT_URL = process.env.MQTT_URL || "mqtt://localhost:1883";
const QR_INPUT_PORT = Number(process.env.QR_INPUT_PORT) || 4001;

const qrInput = createQrInputServer({ port: QR_INPUT_PORT });

// This agent is just another client on the Core's Connectivity Broker
// (docs/05-connectivity-broker.md) — same topic scheme as any device
// (docs/PROVISIONING_PROTOCOL_V2.md §7's naming). No Core-side broker code
// needed to support it; it's addressed and commanded exactly like a device.
// The broker requires a login: GATEWAY_CLIENT_ID / GATEWAY_MQTT_PASSWORD
// (the same password as in the Core's .env).
const client = mqtt.connect(MQTT_URL, {
  clientId: GATEWAY_CLIENT_ID,
  username: GATEWAY_CLIENT_ID,
  password: process.env.GATEWAY_MQTT_PASSWORD,
  reconnectPeriod: 2000,
});

client.on("connect", () => {
  console.log(`[gateway] connected to ${MQTT_URL} as ${GATEWAY_CLIENT_ID}`);
  client.subscribe(`devices/${GATEWAY_CLIENT_ID}/cmd`, (err) => {
    if (err) console.error("[gateway] subscribe failed", err);
  });
});

client.on("reconnect", () => console.warn("[gateway] reconnecting to broker..."));
client.on("error", (err) => console.error("[gateway] mqtt error", err.message));

client.on("message", (topic, payload) => {
  let cmd;
  try {
    cmd = JSON.parse(payload.toString());
  } catch {
    console.error(`[gateway] malformed command on ${topic}`);
    return;
  }

  if (cmd.action !== "provision") {
    console.warn(`[gateway] ignoring unsupported action "${cmd.action}"`);
    return;
  }

  handleProvision(cmd.value).catch((err) => {
    // handleProvision reports its own failures over MQTT; this is a last
    // resort so a bug in the reporting path itself isn't silent.
    console.error(`[gateway] unhandled error provisioning session ${cmd.value}`, err);
  });
});

async function handleProvision(sessionId) {
  console.log(`[gateway] provision command received for session ${sessionId}`);

  let session;
  try {
    session = await fetchSessionInstructions(sessionId);
  } catch (err) {
    console.error(`[gateway] failed to fetch session ${sessionId}`, err.message);
    return report(sessionId, { outcome: "failed", reason: "session_fetch_failed" });
  }

  let qrJson;
  try {
    // The protocol's entire security model is physical possession of the
    // device's QR (PROVISIONING_PROTOCOL_V2.md §1) — this agent has no
    // camera, so an operator must scan it and relay it here. See qrInput.js.
    qrJson = await qrInput.waitForQr(sessionId);
  } catch (err) {
    console.error(`[gateway] no QR provided for session ${sessionId}`, err.message);
    return report(sessionId, { outcome: "failed", reason: "qr_not_provided" });
  }

  try {
    const { deviceId } = await provisionDevice(session.clientInstructions, qrJson, {
      wifiSsid: process.env.TEST_WIFI_SSID,
      wifiPassword: process.env.TEST_WIFI_PASSWORD,
    });
    console.log(`[gateway] session ${sessionId} provisioned device ${deviceId}`);
    report(sessionId, { outcome: "success", deviceId });
  } catch (err) {
    console.error(`[gateway] provisioning failed for session ${sessionId}`, err.message);
    report(sessionId, { outcome: "failed", reason: err.code ?? "ble_error" });
  }
}

// Shape matches CoreEvent (ch.5 §5.3): value carries the sessionId itself
// (a string identifier, ch.1 §1.2 P1) rather than the outcome, so two
// consecutive reports for different sessions always differ and both surface
// as state.changed — the outcome and details live in metadata, the
// documented opaque pass-through bag (ch.6 §6.1), not in value.
function report(sessionId, metadata) {
  client.publish(
    `devices/${GATEWAY_CLIENT_ID}/messages`,
    JSON.stringify({
      componentId: "ble-gateway",
      eventType: "provisioning_result",
      value: sessionId,
      metadata,
    })
  );
}

process.on("SIGINT", () => {
  qrInput.close();
  client.end();
  process.exit(0);
});
