// Integration settings (ids, secrets, options) entered from the web console.
//
// Stored in data/integrations.json (git-ignored, mode 600) and applied over
// process.env, so every integration keeps reading the same variable names
// and .env still works as the default: a value saved from the console wins,
// clearing it falls back to .env. Secrets are write-only through the API:
// it says whether one is set and where from, never what it is.
import fs from "node:fs";
import path from "node:path";

const FILE = path.resolve("data/integrations.json");

// What the console shows. `type`: text | secret | select | url.
export const INTEGRATIONS = [
  {
    id: "tuya",
    label: "Tuya / Smart Life",
    description: "Runs your Smart Life scenes and reads light states (Lights switch, scene tiles).",
    docsUrl: "https://iot.tuya.com/cloud/",
    fields: [
      { key: "TUYA_ACCESS_ID", label: "Access ID", type: "text", required: true, help: "Cloud project → Overview → Authorization Key" },
      { key: "TUYA_ACCESS_SECRET", label: "Access secret", type: "secret", required: true },
      {
        key: "TUYA_BASE_URL",
        label: "Data center",
        type: "select",
        options: [
          { value: "https://openapi.tuyaus.com", label: "Western America" },
          { value: "https://openapi-ueaz.tuyaus.com", label: "Eastern America" },
          { value: "https://openapi.tuyaeu.com", label: "Central Europe" },
          { value: "https://openapi-weaz.tuyaeu.com", label: "Western Europe" },
          { value: "https://openapi.tuyacn.com", label: "China" },
          { value: "https://openapi.tuyain.com", label: "India" },
        ],
        default: "https://openapi.tuyaus.com",
        help: "The project's data center, where your Smart Life account lives",
      },
      { key: "TUYA_HOME_ID", label: "Home ID", type: "text", help: "Optional: only this home's scenes" },
      { key: "TUYA_UID", label: "User ID", type: "text", help: "Optional: found from your linked devices if empty" },
    ],
  },
  {
    id: "spotify",
    label: "Spotify",
    description: "Liked and Skip & drop buttons, acting on what's playing on your account.",
    docsUrl: "https://developer.spotify.com/dashboard",
    fields: [
      { key: "SPOTIFY_CLIENT_ID", label: "Client ID", type: "text", required: true, help: "From your app in the Spotify developer dashboard" },
      { key: "SPOTIFY_REDIRECT_URI", label: "Redirect URI", type: "url", help: "Leave empty for the default shown below" },
    ],
  },
  {
    id: "weather",
    label: "Weather",
    description: "The panel's Weather page and alerts (Open-Meteo, SMN). No account needed.",
    fields: [
      {
        key: "WEATHER_ADDRESS",
        label: "Address",
        type: "text",
        help: "Leave empty to use your Tuya home's location. Looked up once with OpenStreetMap.",
      },
    ],
  },
];

const fieldsByKey = new Map(INTEGRATIONS.flatMap((i) => i.fields.map((f) => [f.key, { ...f, integration: i.id }])));
const fromEnv = {};  // what .env had, for falling back when a console value is cleared
let stored = {};

function read() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}
function write() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(stored, null, 2), { mode: 0o600 });
  fs.chmodSync(FILE, 0o600);
}
function apply(key) {
  if (stored[key] !== undefined) process.env[key] = stored[key];
  else if (fromEnv[key] !== undefined) process.env[key] = fromEnv[key];
  else delete process.env[key];
}

// Call before the extensions load, so they see the console's values.
export function loadIntegrationSettings() {
  for (const key of fieldsByKey.keys()) if (process.env[key] !== undefined && process.env[key] !== "") fromEnv[key] = process.env[key];
  stored = Object.fromEntries(Object.entries(read()).filter(([k, v]) => fieldsByKey.has(k) && typeof v === "string"));
  for (const key of fieldsByKey.keys()) apply(key);
  return Object.keys(stored).length;
}

// The console's view: values for plain fields, only set/unset for secrets.
export function describe(id) {
  const i = INTEGRATIONS.find((x) => x.id === id);
  if (!i) return null;
  return {
    id: i.id,
    label: i.label,
    description: i.description,
    docsUrl: i.docsUrl,
    fields: i.fields.map((f) => {
      const source = stored[f.key] !== undefined ? "console" : fromEnv[f.key] !== undefined ? "env" : null;
      const value = process.env[f.key] ?? "";
      return {
        ...f,
        source,
        set: Boolean(value),
        ...(f.type === "secret" ? { hint: value ? `••••${value.slice(-4)}` : "" } : { value }),
      };
    }),
  };
}

// values: { KEY: "new value" | null }. null or "" clears the console's
// value (back to .env, if it has one); a key left out is unchanged.
// Returns the keys that actually changed.
export function update(id, values) {
  const i = INTEGRATIONS.find((x) => x.id === id);
  if (!i) throw Object.assign(new Error(`unknown integration "${id}"`), { status: 404 });
  const changed = [];
  for (const [key, raw] of Object.entries(values ?? {})) {
    const f = i.fields.find((x) => x.key === key);
    if (!f) throw Object.assign(new Error(`${key} is not a ${i.label} setting`), { status: 400 });
    const before = process.env[key];
    if (raw === null || raw === "") delete stored[key];
    else {
      const v = String(raw).trim();
      if (v.length > 500 || /[\r\n]/.test(v)) throw Object.assign(new Error(`${f.label} doesn't look right`), { status: 400 });
      if (f.type === "select" && !f.options.some((o) => o.value === v)) throw Object.assign(new Error(`${f.label}: pick one of the options`), { status: 400 });
      if (f.type === "url" && !/^https?:\/\/\S+$/.test(v)) throw Object.assign(new Error(`${f.label} must be an http(s) URL`), { status: 400 });
      stored[key] = v;
    }
    apply(key);
    if (process.env[key] !== before) changed.push(key);
  }
  write();
  return changed;
}
