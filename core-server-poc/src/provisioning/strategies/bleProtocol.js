import { randomUUID, randomBytes } from "node:crypto";
import { lanAddresses } from "../../devCert.js";

// Shared wire-contract constants + identity/config minting for any BLE
// provisioning strategy variant (app-driven ble-wifi.js, gateway-driven
// bleGateway.js). Source of truth: docs/PROVISIONING_PROTOCOL_V2.md §3, §7.
// Keeping this in one place means the two strategies can't drift apart on
// UUIDs or payload shape.
//
// v2, not v1: the device's session token (§4) and its MAC (used as the HKDF
// salt) are generated on-device and travel only via the on-screen QR code —
// the Core never sees them and has nothing to mint for that part. The only
// thing the Core mints up front is the device identity and MQTT broker
// config, same as v1.

export const SERVICE_UUID = "8027151f-907e-49d2-bd90-234456b8a407";
export const RX_CHARACTERISTIC_UUID = "9e1fb9a1-0f07-45cd-ae0a-1d340cbd4a42"; // app -> device (write)
export const TX_CHARACTERISTIC_UUID = "fbe43299-3649-4534-a091-b387f3b29aa1"; // device -> app (notify)
export const PROVISIONING_PROTOCOL_VERSION = 2;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

// "localhost" in MQTT_URL is correct for Core's own MQTT client (same
// machine) but meaningless once handed to a device over BLE: the device
// resolves it to itself, not Core, and gets a connection reset. Substitute
// Core's LAN IP so the device can actually reach the broker.
function resolveDeviceReachableHost(hostname) {
  if (!LOOPBACK_HOSTS.has(hostname)) return hostname;
  const [lanIp] = lanAddresses();
  if (!lanIp) {
    console.warn(
      `[provisioning] MQTT_URL host is "${hostname}" and no LAN IPv4 address was found to substitute — ` +
        `devices will try to reach themselves and fail. Set MQTT_URL to a LAN-reachable host.`
    );
    return hostname;
  }
  console.warn(`[provisioning] MQTT_URL host "${hostname}" isn't device-reachable — using LAN IP ${lanIp} instead.`);
  return lanIp;
}

export function parseBrokerUrl(url) {
  const parsed = new URL(url);
  return {
    brokerHost: resolveDeviceReachableHost(parsed.hostname),
    brokerPort: Number(parsed.port) || (parsed.protocol === "mqtts:" ? 8883 : 1883),
    useTls: parsed.protocol === "mqtts:",
  };
}

// Topic naming per docs/PROVISIONING_PROTOCOL_V2.md §7's MQTT_CONFIG example.
// NOTE: the Connectivity Broker (ch.5) currently only wires up `messages`
// (inbound, treated as telemetry) and `cmd` (outbound commands) — `cmd/result`,
// `config`, and `status` are part of the wire contract but not yet consumed
// by the POC's broker. See src/connectivity/adapters/mqttAdapter.js.
export function buildTopics(deviceId) {
  return {
    commands: `devices/${deviceId}/cmd`,
    commandResults: `devices/${deviceId}/cmd/result`,
    messages: `devices/${deviceId}/messages`,
    config: `devices/${deviceId}/config`,
    status: `devices/${deviceId}/status`,
  };
}

// Mints a fresh device identity + the exact payload that gets sent as the
// device's MQTT_CONFIG message (protocol v2 §7), regardless of who ends up
// driving the BLE handshake (a companion app or a gateway agent).
export function mintDeviceIdentity() {
  const deviceId = `esp32-panel-${randomUUID().slice(0, 8)}`;
  const mqttPassword = randomBytes(16).toString("hex");
  const { brokerHost, brokerPort, useTls } = parseBrokerUrl(process.env.MQTT_URL);

  return {
    deviceId,
    bleServiceUuid: SERVICE_UUID,
    rxCharacteristicUuid: RX_CHARACTERISTIC_UUID,
    txCharacteristicUuid: TX_CHARACTERISTIC_UUID,
    mqttConfigPayload: {
      provisioningProtocolVersion: PROVISIONING_PROTOCOL_VERSION,
      brokerHost,
      brokerPort,
      useTls,
      clientId: deviceId,
      username: deviceId,
      password: mqttPassword,
      topics: buildTopics(deviceId),
    },
  };
}
