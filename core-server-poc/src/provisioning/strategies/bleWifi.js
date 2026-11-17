import { mintDeviceIdentity } from "./bleProtocol.js";

// Human-driven variant: a companion app (mobile or Web Bluetooth) does the
// BLE handshake itself. For the Core to discover and drive the device
// automatically instead, see bleGateway.js.
//
// Implements the ProvisioningStrategy shape from docs/04-device-provisioning.md §4.2.
export const bleWifiStrategy = {
  id: "ble-wifi",

  buildClientInstructions() {
    return mintDeviceIdentity();
  },

  // `payload` is the app's post-BLE-flow confirmation (PROVISIONING_PROTOCOL_V2.md
  // §9, step 10) — the result of the device's MQTT_STATUS message reaching
  // "connected". It is bookkeeping for this session's HTTP status only; the
  // Connectivity Broker's own presence tracking (ch.5, §5.5) is the
  // authoritative source for whether the device is actually online.
  async handlePayload(payload, session) {
    const { status, reason } = payload ?? {};
    const { deviceId, mqttConfigPayload } = session.clientInstructions;

    if (status !== "connected") {
      return {
        status: "failed",
        error: {
          code: reason ?? "unknown",
          message: `device reported mqtt-status: ${status ?? "unknown"}`,
        },
      };
    }

    return { status: "success", deviceId, deviceCredential: mqttConfigPayload.password };
  },
};
