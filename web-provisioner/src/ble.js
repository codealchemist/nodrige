// Web Bluetooth transport for Provisioning Protocol v2 (docs/PROVISIONING_PROTOCOL_V2.md §3).
// Plain GATT — no protocomm, no vendor SDK.
import { fragmentFrame, createReassembler } from "./protocol.js";

export const SERVICE_UUID = "8027151f-907e-49d2-bd90-234456b8a407";
export const RX_CHARACTERISTIC_UUID = "9e1fb9a1-0f07-45cd-ae0a-1d340cbd4a42"; // app -> device (write)
export const TX_CHARACTERISTIC_UUID = "fbe43299-3649-4534-a091-b387f3b29aa1"; // device -> app (notify)

// Web Bluetooth gives the page no way to query the negotiated ATT MTU
// (unlike the native Android/iOS SDKs), so fragmentFrame's conservative
// default (works on any BLE stack) is used unless overridden.
export async function connectToDevice(exactDeviceName) {
  if (!navigator.bluetooth) {
    throw new Error("Web Bluetooth is not available in this browser — use Chrome on desktop or Android.");
  }

  // Filtered on the "PROV_" prefix rather than requiring an exact match on
  // exactDeviceName: Web Bluetooth never exposes a device's real MAC to JS,
  // so the QR-derived name can't be cross-checked before the picker opens,
  // and firmware's exact naming convention isn't confirmed. This shows every
  // advertising provisioning device (usually just one) and lets the human
  // pick — safe because identity is actually authenticated afterward, by the
  // QR's token/mac deriving session keys the wrong device can't produce
  // valid frames under (§4-§5): picking the wrong device fails decryption
  // rather than silently succeeding.
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [SERVICE_UUID], namePrefix: "PROV_" }],
    optionalServices: [SERVICE_UUID],
  });
  if (device.name !== exactDeviceName) {
    console.warn(
      `[ble] connected device name "${device.name}" doesn't match the QR-derived name "${exactDeviceName}" ` +
        `— if you picked the wrong device, the handshake below will fail rather than silently succeeding.`
    );
  }

  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(SERVICE_UUID);
  const rxChar = await service.getCharacteristic(RX_CHARACTERISTIC_UUID);
  const txChar = await service.getCharacteristic(TX_CHARACTERISTIC_UUID);

  const reassembler = createReassembler();
  let onFrameCallback = null;

  await txChar.startNotifications();
  txChar.addEventListener("characteristicvaluechanged", (event) => {
    const chunk = new Uint8Array(event.target.value.buffer);
    let frame;
    try {
      frame = reassembler.push(chunk);
    } catch (err) {
      console.error("[ble] fragment reassembly error", err);
      return;
    }
    if (frame && onFrameCallback) onFrameCallback(frame);
  });

  return {
    device,
    // §2: "The app must subscribe to TX notifications before sending HELLO"
    // — satisfied above, before this object is returned to the caller.
    async sendFrame(frameBytes, mtuPayloadSize) {
      const chunks = fragmentFrame(frameBytes, mtuPayloadSize);
      for (const chunk of chunks) {
        await rxChar.writeValueWithResponse(chunk);
      }
    },
    onFrame(cb) {
      onFrameCallback = cb;
    },
    disconnect() {
      device.gatt?.disconnect();
    },
  };
}
