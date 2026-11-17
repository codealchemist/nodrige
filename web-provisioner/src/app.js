// DOM-independent orchestration of the full provisioning sequence
// (docs/PROVISIONING_PROTOCOL_V2.md §9). Kept separate from main.js's DOM
// wiring so this logic can be exercised without a browser if needed.
import {
  parseQrPayload,
  deriveKeys,
  encryptFrame,
  decryptFrame,
  encodeJson,
  decodeJson,
  utf8ToBytes,
  MessageType,
} from "./protocol.js";
import { connectToDevice } from "./ble.js";

const WIFI_TIMEOUT_MS = 30_000;
const MQTT_TIMEOUT_MS = 30_000;
const HELLO_TIMEOUT_MS = 15_000;

// log: (message: string, kind?: string) => void — called for each step, for
// UI/console display. kind is one of "ok"|"warn"|"error"|"core"|"ble"|"wifi"|
// "debug", used to pick a status icon/style; omitted means an unstyled line.
export async function runProvisioningFlow({ qrJson, wifiSsid, wifiPassword, coreClient, log }) {
  log("Fetching device identity + MQTT config from Core...", "core");
  const session = await coreClient.beginSession();
  const { deviceId, mqttConfigPayload } = session.clientInstructions;
  log(`Core session ${session.sessionId} — deviceId ${deviceId}`, "core");

  const qr = parseQrPayload(qrJson);
  log(`QR parsed — device "${qr.name}"`, "ok");

  const { k_c2d, k_d2c } = await deriveKeys(qr.tokenBytes, qr.macBytes);
  log("Session keys derived (HKDF-SHA256)");

  log(`Connecting to ${qr.name} over BLE...`, "ble");
  const conn = await connectToDevice(qr.name);
  log("BLE connected — RX/TX characteristics ready, subscribed to TX", "ok");

  let sendCounter = 0;
  let recvCounter = -1;
  let currentWaiter = null; // { type, isTerminal, resolve, reject, timer }

  conn.onFrame(async (frameBytes) => {
    let decoded;
    try {
      decoded = await decryptFrame(k_d2c, frameBytes, recvCounter);
    } catch (err) {
      // §5 rule 4: a frame that fails verification must not advance the
      // counter or be processed — just drop it and keep waiting.
      log(`dropped an unverifiable frame (${err.message})`, "warn");
      return;
    }
    recvCounter = decoded.counter;

    if (decoded.type === MessageType.ERROR) {
      const err = decodeJson(decoded.plaintext);
      log(`Device ERROR: ${err.code} — ${err.message}`, "error");
      if (currentWaiter) {
        clearTimeout(currentWaiter.timer);
        currentWaiter.reject(new Error(`device ERROR ${err.code}: ${err.message}`));
        currentWaiter = null;
      }
      return;
    }

    if (currentWaiter && decoded.type === currentWaiter.type) {
      const payload = decodeJson(decoded.plaintext);
      log(`Received 0x${decoded.type.toString(16).padStart(2, "0")}: ${JSON.stringify(payload)}`, "debug");
      if (!currentWaiter.isTerminal || currentWaiter.isTerminal(payload)) {
        clearTimeout(currentWaiter.timer);
        currentWaiter.resolve(payload);
        currentWaiter = null;
      }
      // else: a non-terminal update (e.g. {"state":"connecting"}) — keep waiting
    }
  });

  async function send(type, plaintextBytes) {
    const frame = await encryptFrame(k_c2d, type, sendCounter, plaintextBytes);
    await conn.sendFrame(frame);
    sendCounter++;
  }

  function waitFor(type, { isTerminal, timeoutMs = 20_000 } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        currentWaiter = null;
        reject(new Error(`timed out waiting for message type 0x${type.toString(16).padStart(2, "0")}`));
      }, timeoutMs);
      currentWaiter = { type, isTerminal, resolve, reject, timer };
    });
  }

  try {
    log("Sending HELLO...", "ble");
    await send(MessageType.HELLO, utf8ToBytes("PROVHELO"));
    const helloAck = await waitFor(MessageType.HELLO_ACK, { timeoutMs: HELLO_TIMEOUT_MS });
    log(`Device acknowledged (fw=${helloAck.fw ?? "?"})`, "ok");

    log(`Sending Wi-Fi credentials for "${wifiSsid}"...`, "wifi");
    await send(MessageType.WIFI_CREDS, encodeJson({ ssid: wifiSsid, password: wifiPassword }));
    const wifiStatus = await waitFor(MessageType.WIFI_STATUS, {
      isTerminal: (s) => s.state === "connected" || s.state === "failed",
      timeoutMs: WIFI_TIMEOUT_MS,
    });
    if (wifiStatus.state !== "connected") {
      throw new Error(`Wi-Fi connection failed: ${wifiStatus.reason ?? "unknown"}`);
    }
    log(`Wi-Fi connected${wifiStatus.ip ? ` (ip=${wifiStatus.ip})` : ""}`, "ok");

    log("Sending MQTT_CONFIG...", "core");
    await send(MessageType.MQTT_CONFIG, encodeJson(mqttConfigPayload));
    const mqttStatus = await waitFor(MessageType.MQTT_STATUS, {
      isTerminal: (s) => s.state === "connected" || s.state === "failed",
      timeoutMs: MQTT_TIMEOUT_MS,
    });
    if (mqttStatus.state !== "connected") {
      throw new Error(`MQTT connection failed: ${mqttStatus.reason ?? "unknown"}`);
    }
    log("MQTT connected — device is provisioned", "ok");

    const result = await coreClient.confirmSession(session.sessionId, { status: "connected" });
    log(`Core session confirmed: ${result.status}`, "core");

    return { ...result, sessionId: session.sessionId };
  } catch (err) {
    await coreClient.confirmSession(session.sessionId, { status: "failed", reason: err.message }).catch(() => {});
    throw err;
  } finally {
    conn.disconnect();
  }
}
