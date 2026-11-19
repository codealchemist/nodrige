// MQTT logins, shared by the broker (scripts/dev-broker.js) and the Core.
//
// Every client must log in; there is no anonymous access:
//   core      CORE_MQTT_PASSWORD (.env)          everything
//   console   CONSOLE_MQTT_PASSWORD (.env)       read-only, console topics
//   gateway   GATEWAY_CLIENT_ID +                its own devices/<id>/... only
//             GATEWAY_MQTT_PASSWORD (.env)
//   devices   username = client id = device id,  their own devices/<id>/...
//             password minted at provisioning    (and <id>/poc-echo) only
//
// Device passwords are stored only as salted scrypt hashes, in
// data/mqtt-credentials.json (git-ignored, mode 600). A device the Core
// already knows (data/devices.json) but that has no stored password yet,
// i.e. one provisioned before logins were checked, is adopted on its first
// login: that password is stored and required from then on.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data");
const FILE = path.join(DATA, "mqtt-credentials.json");
const DEVICES = path.join(DATA, "devices.json");
const MIN_PASSWORD = 16;

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return { devices: {} };
  }
}

function save(store) {
  fs.mkdirSync(DATA, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

function hash(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 32).toString("hex") };
}

function matches(password, rec) {
  const got = Buffer.from(hash(password, rec.salt).hash, "hex");
  const want = Buffer.from(rec.hash, "hex");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// A password from .env, or why it can't be used.
function envSecret(env, key) {
  const v = env[key];
  if (!v) return { problem: `${key} is not set` };
  if (v === "change-me" || v.length < MIN_PASSWORD) return { problem: `${key} is a placeholder or shorter than ${MIN_PASSWORD} characters` };
  return { value: v };
}

function sameSecret(a, b) {
  const x = Buffer.from(String(a ?? "")), y = Buffer.from(String(b ?? ""));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

function knownDevice(id) {
  try {
    return Object.hasOwn(JSON.parse(fs.readFileSync(DEVICES, "utf8")), id);
  } catch {
    return false;
  }
}

// Called by provisioning when it mints a device identity (the device tests
// its login before provisioning finishes, so this happens up front).
export function setDevicePassword(deviceId, password) {
  const store = load();
  store.devices[deviceId] = { ...hash(password), via: "provisioning", at: new Date().toISOString() };
  save(store);
}

export function removeDevice(deviceId) {
  const store = load();
  if (store.devices[deviceId]) {
    delete store.devices[deviceId];
    save(store);
  }
}

// -> { role, id, note? } or { refused: reason }. Never logs or returns passwords.
export function checkLogin(clientId, username, password, env = process.env) {
  if (!username) return { refused: "no username (anonymous logins are refused)" };
  const pw = password == null ? "" : String(password);

  const gatewayId = env.GATEWAY_CLIENT_ID || "ble-gateway-01";
  const fixed = { core: ["CORE_MQTT_PASSWORD", "core"], console: ["CONSOLE_MQTT_PASSWORD", "console"], [gatewayId]: ["GATEWAY_MQTT_PASSWORD", "device"] };
  if (fixed[username]) {
    const [key, role] = fixed[username];
    const secret = envSecret(env, key);
    if (secret.problem) return { refused: secret.problem };
    if (role === "device" && clientId !== username) return { refused: "client id must match the username" };
    return sameSecret(pw, secret.value) ? { role, id: username } : { refused: "wrong password" };
  }

  // A device: its username, client id and topics are its device id.
  if (/[/#+\s]/.test(username)) return { refused: "invalid username" };
  if (clientId !== username) return { refused: "client id must match the username" };
  const store = load();
  const rec = store.devices[username];
  if (rec) return matches(pw, rec) ? { role: "device", id: username } : { refused: "wrong password" };
  if (knownDevice(username) && pw.length >= MIN_PASSWORD) {
    store.devices[username] = { ...hash(pw), via: "first-login", at: new Date().toISOString() };
    save(store);
    return { role: "device", id: username, note: "adopted: its password is now required" };
  }
  return { refused: "unknown device" };
}

// What a logged-in client may touch.
const CONSOLE_TOPICS = [
  /^devices\/[^/#+]+\/(status|telemetry|log|cmd\/result)$/,
  /^devices\/\+\/(status|telemetry|log|cmd\/result)$/,
  /^core\/.*/,
];

export function mayPublish(who, topic) {
  if (who?.role === "core") return true;
  if (who?.role === "device") return ownTopic(who.id, topic);
  return false;  // console: read-only
}

export function maySubscribe(who, topic) {
  if (who?.role === "core") return true;
  if (who?.role === "console") return CONSOLE_TOPICS.some((re) => re.test(topic));
  if (who?.role === "device") return ownTopic(who.id, topic);
  return false;
}

// Its own subtree (wildcards allowed inside it), plus the echo topic the
// panel tests its connection with during provisioning.
function ownTopic(id, topic) {
  return topic.startsWith(`devices/${id}/`) || topic === `${id}/poc-echo`;
}
