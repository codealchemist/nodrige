import noble from "@abandonware/noble";
import {
  parseQrPayload,
  deriveKeys,
  encryptFrame,
  decryptFrame,
  encodeJson,
  decodeJson,
  utf8ToBytes,
  fragmentFrame,
  createReassembler,
  MessageType,
} from "./protocol.js";

// Drives docs/PROVISIONING_PROTOCOL_V2.md end to end against a real device,
// using noble for the BLE transport and the same verified protocol.js core
// web-provisioner uses. NOTE: this has not been exercised against real
// firmware or a real BLE adapter — firmware doesn't implement v2 yet (see
// the protocol doc's §12). Treat this as a structural implementation built
// directly against the wire contract, not a verified one — see the crypto
// core's own test suite (test/protocol.test.mjs) for what *is* verified.

const SERVICE_UUID = "8027151f-907e-49d2-bd90-234456b8a407";
const RX_UUID = "9e1fb9a1-0f07-45cd-ae0a-1d340cbd4a42";
const TX_UUID = "fbe43299-3649-4534-a091-b387f3b29aa1";

const SCAN_TIMEOUT_MS = 20_000;
const HELLO_TIMEOUT_MS = 15_000;
const WIFI_TIMEOUT_MS = 30_000;
const MQTT_TIMEOUT_MS = 30_000;

function uuidNoDashes(uuid) {
  return uuid.replace(/-/g, "");
}

async function waitForPoweredOn() {
  if (noble.state === "poweredOn") return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("BLE adapter did not power on")), 10_000);
    noble.on("stateChange", (state) => {
      if (state === "poweredOn") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

function scanForDevice(exactName) {
  return new Promise((resolve, reject) => {
    const onDiscover = (peripheral) => {
      if (peripheral.advertisement.localName !== exactName) return;
      cleanup();
      resolve(peripheral);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(Object.assign(new Error(`device "${exactName}" not found in range`), { code: "scan_timeout" }));
    }, SCAN_TIMEOUT_MS);
    function cleanup() {
      clearTimeout(timer);
      noble.removeListener("discover", onDiscover);
      noble.stopScanningAsync().catch(() => {});
    }
    noble.on("discover", onDiscover);
    noble.startScanningAsync([uuidNoDashes(SERVICE_UUID)], false).catch((err) => {
      cleanup();
      reject(err);
    });
  });
}

async function connectAndGetCharacteristics(peripheral) {
  await peripheral.connectAsync();
  const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
    [uuidNoDashes(SERVICE_UUID)],
    [uuidNoDashes(RX_UUID), uuidNoDashes(TX_UUID)]
  );
  const rx = characteristics.find((c) => c.uuid === uuidNoDashes(RX_UUID));
  const tx = characteristics.find((c) => c.uuid === uuidNoDashes(TX_UUID));
  if (!rx || !tx) throw new Error("device is missing the expected RX/TX characteristics");
  return { rx, tx };
}

// clientInstructions: from GET /provisioning/sessions/:id (bleProtocol.js's
// mintDeviceIdentity()). qrJson: raw QR text, scanned and relayed by an
// operator via qrInput.js (this agent has no camera — see that file).
// Returns { deviceId } on success; throws (with a .code) on failure.
export async function provisionDevice(clientInstructions, qrJson, { wifiSsid, wifiPassword }) {
  const qr = parseQrPayload(qrJson);
  const { k_c2d, k_d2c } = await deriveKeys(qr.tokenBytes, qr.macBytes);

  await waitForPoweredOn();
  const peripheral = await scanForDevice(qr.name);
  const { rx, tx } = await connectAndGetCharacteristics(peripheral);

  const reassembler = createReassembler();
  let sendCounter = 0;
  let recvCounter = -1;
  let currentWaiter = null;

  await tx.subscribeAsync();
  tx.on("data", async (data) => {
    let frame;
    try {
      frame = reassembler.push(new Uint8Array(data));
    } catch (err) {
      console.warn("[ble] fragment reassembly error", err.message);
      return;
    }
    if (!frame) return;

    let decoded;
    try {
      decoded = await decryptFrame(k_d2c, frame, recvCounter);
    } catch (err) {
      // §5 rule 4: a frame that fails verification must not advance the
      // counter or be processed.
      console.warn("[ble] dropped unverifiable frame:", err.message);
      return;
    }
    recvCounter = decoded.counter;

    if (decoded.type === MessageType.ERROR) {
      const err = decodeJson(decoded.plaintext);
      if (currentWaiter) currentWaiter.reject(new Error(`device ERROR ${err.code}: ${err.message}`));
      currentWaiter = null;
      return;
    }

    if (currentWaiter && decoded.type === currentWaiter.type) {
      const payload = decodeJson(decoded.plaintext);
      if (!currentWaiter.isTerminal || currentWaiter.isTerminal(payload)) {
        currentWaiter.resolve(payload);
        currentWaiter = null;
      }
    }
  });

  async function send(type, plaintextBytes) {
    const frame = await encryptFrame(k_c2d, type, sendCounter, plaintextBytes);
    for (const chunk of fragmentFrame(frame)) {
      await rx.writeAsync(Buffer.from(chunk), false); // false = write with response, per protocol §3's "Write" property
    }
    sendCounter++;
  }

  function waitFor(type, { isTerminal, timeoutMs = 20_000 } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        currentWaiter = null;
        reject(Object.assign(new Error(`timed out waiting for 0x${type.toString(16).padStart(2, "0")}`), { code: "timeout" }));
      }, timeoutMs);
      currentWaiter = {
        type,
        isTerminal,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
    });
  }

  try {
    await send(MessageType.HELLO, utf8ToBytes("PROVHELO"));
    await waitFor(MessageType.HELLO_ACK, { timeoutMs: HELLO_TIMEOUT_MS });

    await send(MessageType.WIFI_CREDS, encodeJson({ ssid: wifiSsid, password: wifiPassword }));
    const wifiStatus = await waitFor(MessageType.WIFI_STATUS, {
      isTerminal: (s) => s.state === "connected" || s.state === "failed",
      timeoutMs: WIFI_TIMEOUT_MS,
    });
    if (wifiStatus.state !== "connected") {
      throw Object.assign(new Error(`Wi-Fi connection failed: ${wifiStatus.reason}`), { code: wifiStatus.reason ?? "wifi_failed" });
    }

    await send(MessageType.MQTT_CONFIG, encodeJson(clientInstructions.mqttConfigPayload));
    const mqttStatus = await waitFor(MessageType.MQTT_STATUS, {
      isTerminal: (s) => s.state === "connected" || s.state === "failed",
      timeoutMs: MQTT_TIMEOUT_MS,
    });
    if (mqttStatus.state !== "connected") {
      throw Object.assign(new Error(`MQTT connection failed: ${mqttStatus.reason}`), { code: mqttStatus.reason ?? "mqtt_failed" });
    }

    return { deviceId: clientInstructions.mqttConfigPayload.clientId };
  } finally {
    await peripheral.disconnectAsync().catch(() => {});
  }
}
