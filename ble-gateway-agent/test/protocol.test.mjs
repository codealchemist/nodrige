import {
  deriveKeys,
  encryptFrame,
  decryptFrame,
  fragmentFrame,
  createReassembler,
  hexToBytes,
  bytesToHex,
  encodeJson,
  parseQrPayload,
  MessageType,
} from "../src/protocol.js";

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) {
    console.log(`  actual:   ${actual}`);
    console.log(`  expected: ${expected}`);
    failures++;
  }
}

const tokenBytes = hexToBytes("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
const macBytes = hexToBytes("a1b2c3d4e5f6");

const { k_c2d, k_d2c } = await deriveKeys(tokenBytes, macBytes);
check("k_c2d", bytesToHex(k_c2d), "e81929a65dc96fb77853751ecfcd741565022efd87007c225a069af8a677b43c");
check("k_d2c", bytesToHex(k_d2c), "b11aad3d74d519382fba59ec4e809d5ca9073923f594f03887e76bdf7c2aa9a1");

const helloFrame = await encryptFrame(k_c2d, MessageType.HELLO, 0, new TextEncoder().encode("PROVHELO"));
check(
  "HELLO frame",
  bytesToHex(helloFrame),
  "020100000000000000005a818352d90cebc73c20e49dbffe4cd7d290b17fcd2fc7b9"
);

const wifiFrame = await encryptFrame(k_c2d, MessageType.WIFI_CREDS, 1, encodeJson({ ssid: "MyNetwork", password: "hunter2" }));
check(
  "WIFI_CREDS frame",
  bytesToHex(wifiFrame),
  "0203000000000000000190ca5fb7efdb40d0e63f587f1ec47bef1a367b7cbd85015929591986156535d86c2cbee2845057ba63c6a896aaa8c2bb7755c821e0387f2b3b"
);

// Round-trip: decrypt what we just encrypted, confirm counter/type/plaintext survive.
const decodedHello = await decryptFrame(k_c2d, helloFrame, -1);
check("HELLO round-trip type", decodedHello.type, MessageType.HELLO);
check("HELLO round-trip counter", decodedHello.counter, 0n);
check("HELLO round-trip plaintext", new TextDecoder().decode(decodedHello.plaintext), "PROVHELO");

// Replay rejection: same counter again must throw (§5 rule 3).
try {
  await decryptFrame(k_c2d, helloFrame, 0);
  console.log("FAIL replay rejection — did not throw");
  failures++;
} catch (err) {
  console.log(`PASS replay rejection (threw: ${err.message})`);
}

// Tampered ciphertext must fail tag verification, not silently decrypt.
const tampered = new Uint8Array(helloFrame);
tampered[tampered.length - 1] ^= 0xff;
try {
  await decryptFrame(k_c2d, tampered, -1);
  console.log("FAIL tamper detection — did not throw");
  failures++;
} catch (err) {
  console.log(`PASS tamper detection (threw: ${err.message})`);
}

// Fragmentation round-trip over a frame bigger than the default MTU chunk size.
const bigPayload = encodeJson({
  provisioningProtocolVersion: 2,
  brokerHost: "mqtt.example.com",
  brokerPort: 8883,
  useTls: true,
  clientId: "device-a1b2c3",
  username: "mqtt-user",
  password: "mqtt-pass",
  topics: {
    commands: "dev/a1b2c3/cmd",
    commandResults: "dev/a1b2c3/cmd/result",
    messages: "dev/a1b2c3/msg",
    config: "dev/a1b2c3/config",
    status: "dev/a1b2c3/status",
  },
});
const bigFrame = await encryptFrame(k_c2d, MessageType.MQTT_CONFIG, 2, bigPayload);
const chunks = fragmentFrame(bigFrame, 19);
check("fragmentation produced >1 chunk", chunks.length > 1, true);
const reassembler = createReassembler();
let reassembled = null;
for (const chunk of chunks) {
  reassembled = reassembler.push(chunk);
}
check("reassembled frame matches original", bytesToHex(reassembled), bytesToHex(bigFrame));
const decodedBig = await decryptFrame(k_c2d, reassembled, 0);
check("reassembled frame decrypts", JSON.stringify(JSON.parse(new TextDecoder().decode(decodedBig.plaintext))).includes("device-a1b2c3"), true);

// QR parsing + version rejection.
const qr = parseQrPayload(
  JSON.stringify({
    ver: "v2",
    name: "PROV_A1B2C3",
    mac: "a1b2c3d4e5f6",
    token: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  })
);
check("QR parse: name", qr.name, "PROV_A1B2C3");
check("QR parse: mac bytes", bytesToHex(qr.macBytes), "a1b2c3d4e5f6");
check("QR parse: token bytes", bytesToHex(qr.tokenBytes), "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");

try {
  parseQrPayload(JSON.stringify({ ver: "v1", name: "x", mac: "aa", token: "aa" }));
  console.log("FAIL v1 QR should be rejected");
  failures++;
} catch (err) {
  console.log(`PASS v1 QR rejected (${err.message})`);
}

// Compact "P2:mac:token" wire format, as emitted by current firmware.
const compactQr = parseQrPayload("P2:a1b2c3d4e5f6:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
check("compact QR parse: derived name", compactQr.name, "PROV_A1B2C3");
check("compact QR parse: mac bytes", bytesToHex(compactQr.macBytes), "a1b2c3d4e5f6");
check(
  "compact QR parse: token bytes",
  bytesToHex(compactQr.tokenBytes),
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
);

try {
  parseQrPayload("P2:not-enough-parts");
  console.log("FAIL malformed compact QR should be rejected");
  failures++;
} catch (err) {
  console.log(`PASS malformed compact QR rejected (${err.message})`);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
