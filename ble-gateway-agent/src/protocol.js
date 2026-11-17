// Provisioning Protocol v2 — pure, isomorphic core (browser + Node 20+).
// Wire contract: docs/PROVISIONING_PROTOCOL_V2.md. Uses only Web Crypto API
// (crypto.subtle) + TextEncoder/TextDecoder — no third-party crypto library.
// Verified byte-for-bit against the doc's §10 test vectors — see
// test/protocol.test.mjs. Do not modify without re-running that test.

const VERSION = 0x02;
const MAX_REASSEMBLY_BYTES = 4096;
const FRAG_MORE_BIT = 0x80;

export const MessageType = {
  HELLO: 0x01,
  HELLO_ACK: 0x81,
  WIFI_CREDS: 0x03,
  WIFI_STATUS: 0x83,
  MQTT_CONFIG: 0x05,
  MQTT_STATUS: 0x85,
  ERROR: 0x8f,
};

// ---- byte helpers ----

export function utf8ToBytes(str) {
  return new TextEncoder().encode(str);
}
export function bytesToUtf8(bytes) {
  return new TextDecoder().decode(bytes);
}
export function encodeJson(obj) {
  return utf8ToBytes(JSON.stringify(obj));
}
export function decodeJson(bytes) {
  return JSON.parse(bytesToUtf8(bytes));
}

export function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}
export function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function base64urlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "===".slice((b64.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concatBytes(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrs) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

// ---- §8: QR payload ----

// Current firmware emits the compact "P2:<mac>:<token>" wire format rather
// than the JSON shape documented in §8 — this doc predates that firmware
// build. Support both: compact is tried first since it isn't valid JSON and
// would otherwise fail JSON.parse outright.
export function parseQrPayload(raw) {
  if (typeof raw === "string" && raw.startsWith("P2:")) {
    return parseCompactQrPayload(raw);
  }
  const data = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (data.ver !== "v2") {
    throw new Error(`unsupported QR version "${data.ver}" — this app only speaks Provisioning Protocol v2`);
  }
  if (!data.name || !data.mac || !data.token) {
    throw new Error("QR payload missing required field(s): name, mac, token");
  }
  return {
    name: data.name,
    macBytes: hexToBytes(data.mac),
    tokenBytes: base64urlToBytes(data.token),
  };
}

// The compact format has no `name` field, so it's derived from the mac per
// PROVISIONING_PROTOCOL_V2.md §8: "PROV_" + the LAST 3 mac bytes, uppercased
// (mac "a1b2c3d4e5f6" -> "PROV_D4E5F6"), matching the advertisement (§3).
// Verified against real firmware: mac acebe639f3f4 advertises PROV_39F3F4.
function parseCompactQrPayload(raw) {
  const parts = raw.split(":");
  if (parts.length !== 3 || parts[0] !== "P2") {
    throw new Error(`unrecognized compact QR payload "${raw}"`);
  }
  const [, mac, token] = parts;
  if (!/^[0-9a-f]{12}$/.test(mac)) {
    throw new Error(`QR payload has malformed mac "${mac}" — expected 12 lowercase hex chars`);
  }
  return {
    name: `PROV_${mac.slice(6, 12).toUpperCase()}`,
    macBytes: hexToBytes(mac),
    tokenBytes: base64urlToBytes(token),
  };
}

// ---- §4: key derivation ----

export async function deriveKeys(tokenBytes, macBytes) {
  const ikmKey = await crypto.subtle.importKey("raw", tokenBytes, "HKDF", false, ["deriveBits"]);
  const derive = async (infoStr) => {
    const bits = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: macBytes, info: utf8ToBytes(infoStr) },
      ikmKey,
      256
    );
    return new Uint8Array(bits);
  };
  const k_c2d = await derive("esp32c6-prov-v2 c2d");
  const k_d2c = await derive("esp32c6-prov-v2 d2c");
  return { k_c2d, k_d2c };
}

// ---- §5: frame format ----

function buildHeader(type, counter) {
  const header = new Uint8Array(10);
  header[0] = VERSION;
  header[1] = type;
  new DataView(header.buffer).setBigUint64(2, BigInt(counter), false);
  return header;
}

function buildNonce(counter) {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, BigInt(counter), false);
  return nonce;
}

export async function encryptFrame(keyBytes, type, counter, plaintextBytes) {
  const header = buildHeader(type, counter);
  const nonce = buildNonce(counter);
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const ctWithTag = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: header, tagLength: 128 }, key, plaintextBytes)
  );
  return concatBytes(header, ctWithTag);
}

// Throws on: bad version, bad/replayed counter, or failed tag verification.
// Per §5 rule 4/5.4: caller must not advance any counter state or process
// the frame if this throws.
export async function decryptFrame(keyBytes, frameBytes, lastAcceptedCounter) {
  if (frameBytes.length < 10 + 16) throw new Error("frame too short");
  const header = frameBytes.slice(0, 10);
  if (header[0] !== VERSION) throw new Error(`bad_version: got ${header[0]}, expected ${VERSION}`);

  const type = header[1];
  const counter = new DataView(header.buffer, header.byteOffset + 2, 8).getBigUint64(0, false);
  const lastAccepted = lastAcceptedCounter === undefined || lastAcceptedCounter === null ? -1n : BigInt(lastAcceptedCounter);
  if (counter <= lastAccepted) {
    throw new Error(`bad_counter: received ${counter}, must be > ${lastAccepted}`);
  }

  const nonce = buildNonce(counter);
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  let plaintext;
  try {
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: header, tagLength: 128 }, key, frameBytes.slice(10))
    );
  } catch {
    throw new Error("decrypt_failed");
  }

  return { type, counter, plaintext };
}

// ---- §6: fragmentation ----

// mtuPayloadSize: bytes available per GATT write AFTER the 1-byte frag
// header. Web Bluetooth gives the page no way to query the negotiated ATT
// MTU, so the default here is deliberately conservative (works on any BLE
// stack) rather than tuned for a specific negotiated size — see README.
export function fragmentFrame(frameBytes, mtuPayloadSize = 19) {
  const chunks = [];
  let offset = 0;
  let index = 0;
  do {
    const size = Math.min(mtuPayloadSize, frameBytes.length - offset);
    const slice = frameBytes.slice(offset, offset + size);
    offset += size;
    const more = offset < frameBytes.length;
    if (index > 0x7f) throw new Error("fragment index overflow — increase mtuPayloadSize or shrink the frame");
    chunks.push(concatBytes(new Uint8Array([(more ? FRAG_MORE_BIT : 0) | index]), slice));
    index++;
  } while (offset < frameBytes.length);
  return chunks;
}

export function createReassembler() {
  let parts = [];
  let expectedIndex = 0;
  let total = 0;

  function reset() {
    parts = [];
    expectedIndex = 0;
    total = 0;
  }

  return {
    // Returns the reassembled frame once the final fragment arrives, else null.
    // Throws (and resets) on any out-of-order/gapped/oversized sequence.
    push(chunk) {
      const fragHeader = chunk[0];
      const more = (fragHeader & FRAG_MORE_BIT) !== 0;
      const index = fragHeader & 0x7f;

      if (index === 0) reset();
      if (index !== expectedIndex) {
        reset();
        throw new Error("fragment out of order — frame dropped");
      }

      const payload = chunk.slice(1);
      total += payload.length;
      if (total > MAX_REASSEMBLY_BYTES) {
        reset();
        throw new Error(`reassembly exceeds ${MAX_REASSEMBLY_BYTES} bytes — frame dropped`);
      }

      parts.push(payload);
      expectedIndex++;

      if (!more) {
        const frame = concatBytes(...parts);
        reset();
        return frame;
      }
      return null;
    },
  };
}
