// Tuya cloud scenes for the panel's scene tasks (Night, Day, ...).
//
// A menu task whose payload has `tuyaScene: "<name>"` runs the Tap-to-Run
// scene of that name in the user's Tuya / Smart Life home, through Tuya's
// cloud OpenAPI (@tuya/tuya-connector-nodejs). Names match case-insensitively,
// so the panel config can say "night mode" for a scene called "Night Mode".
//
// Setup (once, at iot.tuya.com):
//   1. Create a Cloud project (Smart Home), in the data center of your
//      Smart Life account, and subscribe it to the Smart Home Scene Linkage
//      and IoT Core APIs.
//   2. Link your Smart Life app account to the project (Devices > Link App
//      Account, scan the QR code with the app).
//   3. Put the project's Access ID / Secret in core-server-poc/.env:
//        TUYA_ACCESS_ID=...
//        TUYA_ACCESS_SECRET=...
//        TUYA_BASE_URL=https://openapi.tuyaus.com   (or tuyaeu / tuyacn / tuyain)
//      Optional: TUYA_UID (the linked app user's uid; otherwise found from the
//      linked devices) or TUYA_HOME_ID (skips home discovery entirely).
//
// Endpoints are the ones Tuya's own Python SDK uses for home scenes
// (tuya-iot-python-sdk home.py): list /v1.0/homes/{home}/scenes, trigger
// POST /v1.0/homes/{home}/scenes/{scene}/trigger.
import fs from "node:fs";
import path from "node:path";
import { TuyaContext } from "@tuya/tuya-connector-nodejs";

const SCENE_CACHE_MS = 60_000;

let ctx = null;
let sceneCache = { at: 0, scenes: [] }; // [{ homeId, sceneId, name }]

// Settings changed from the console: drop the client and cached scenes so
// the next call uses the new id, secret or data center.
export function resetTuya() {
  ctx = null;
  sceneCache = { at: 0, scenes: [] };
}

export function tuyaConfigured() {
  return Boolean(process.env.TUYA_ACCESS_ID && process.env.TUYA_ACCESS_SECRET);
}

function tuya() {
  if (!ctx) {
    ctx = new TuyaContext({
      baseUrl: process.env.TUYA_BASE_URL || "https://openapi.tuyaus.com",
      accessKey: process.env.TUYA_ACCESS_ID,
      secretKey: process.env.TUYA_ACCESS_SECRET,
    });
  }
  return ctx;
}

async function call(method, path, query) {
  const res = await tuya().request({ method, path, query });
  if (!res.success) {
    throw new Error(`Tuya ${method} ${path}: ${res.msg ?? "failed"} (${res.code ?? "?"})`);
  }
  return res.result;
}

async function findUid() {
  if (process.env.TUYA_UID) return process.env.TUYA_UID;
  // The project's linked app account owns the linked devices; any of them
  // carries its uid.
  const r = await call("GET", "/v1.0/iot-01/associated-users/devices", { size: 1 });
  const uid = r?.devices?.[0]?.uid;
  if (!uid) throw new Error("no linked Tuya devices — link your Smart Life account to the project");
  return uid;
}

// Scene names in the linked home(s), for the console's config builder.
export async function tuyaSceneNames() {
  if (!tuyaConfigured()) return [];
  return [...new Set((await listScenes()).map((s) => s.name))].sort();
}

// The first home's location and name, as set in the Smart Life app
// ({ lat, lon, name }), for features that need "where is home" (weather).
export async function tuyaHomeLocation() {
  if (!tuyaConfigured()) return null;
  const homes = (await call("GET", `/v1.0/users/${await findUid()}/homes`)) ?? [];
  const h = homes.find((x) => Number.isFinite(Number(x.lat)) && Number.isFinite(Number(x.lon)));
  return h ? { lat: Number(h.lat), lon: Number(h.lon), name: h.name } : null;
}

async function homeIds() {
  if (process.env.TUYA_HOME_ID) return [process.env.TUYA_HOME_ID];
  const homes = await call("GET", `/v1.0/users/${await findUid()}/homes`);
  return (homes ?? []).map((h) => String(h.home_id));
}

async function listScenes() {
  if (Date.now() - sceneCache.at < SCENE_CACHE_MS) return sceneCache.scenes;
  const scenes = [];
  for (const homeId of await homeIds()) {
    for (const s of (await call("GET", `/v1.0/homes/${homeId}/scenes`)) ?? []) {
      const actions = s.actions ?? [];
      // Room-wide light actions ("lightBase") name a room, not a device.
      const roomIds = [...new Set(actions.filter((a) => a.action_executor === "lightBase").map((a) => a.entity_id))];
      const deviceIds = [
        ...new Set(actions.filter((a) => a.action_executor !== "lightBase").map((a) => a.entity_id).filter(Boolean)),
      ];
      scenes.push({ homeId, sceneId: s.scene_id, name: s.name, deviceIds, roomIds });
    }
  }
  sceneCache = { at: Date.now(), scenes };
  return scenes;
}

// Lights in a room, for scenes that switch a whole room ("lightBase").
// Cached: rooms rarely change.
const ROOM_CACHE_MS = 10 * 60_000;
const LIGHT_CATEGORIES = new Set(["dj", "dd", "fwd", "xdd", "dc", "fsd", "tyndj"]);
const roomCache = new Map(); // `${homeId}/${roomId}` -> { at, ids }

async function roomLights(homeId, roomId) {
  const key = `${homeId}/${roomId}`;
  const hit = roomCache.get(key);
  if (hit && Date.now() - hit.at < ROOM_CACHE_MS) return hit.ids;
  const devices = (await call("GET", `/v1.0/homes/${homeId}/rooms/${roomId}/devices`)) ?? [];
  const ids = devices.filter((d) => LIGHT_CATEGORIES.has(d.category)).map((d) => d.id);
  roomCache.set(key, { at: Date.now(), ids });
  return ids;
}

// Every light a scene acts on: its device actions plus the lights of any
// room it switches as a whole.
async function sceneLights(scene) {
  const ids = new Set(scene.deviceIds);
  for (const room of scene.roomIds ?? []) for (const id of await roomLights(scene.homeId, room)) ids.add(id);
  return [...ids];
}

async function findScene(name) {
  const wanted = String(name).trim().toLowerCase();
  let scene = (await listScenes()).find((s) => s.name.trim().toLowerCase() === wanted);
  if (!scene) {
    sceneCache.at = 0;  // maybe just created in the app
    scene = (await listScenes()).find((s) => s.name.trim().toLowerCase() === wanted);
  }
  return scene;
}

// For a two-state panel switch whose "on" runs `onScene`: is it on right
// now? On when any light that scene acts on is on. Task result shape, with
// `state: "on" | "off"`; never throws.
export async function switchStateFromScene(onScene, logger = console) {
  if (!tuyaConfigured()) return { status: "error", message: "Tuya not set up (see .env)" };
  try {
    const scene = await findScene(onScene);
    if (!scene) return { status: "error", message: `No Tuya scene "${onScene}"` };
    const ids = await sceneLights(scene);
    const states = await readStates(ids, logger);
    const read = Object.values(states);
    const on = read.filter((st) => isOn(st) && ("switch_led" in st || "switch_1" in st || "switch" in st)).length;
    logger.log(`[tuya] "${scene.name}" lights: ${on} of ${read.length} on`);
    return { status: "ok", state: on > 0 ? "on" : "off", message: `${on} of ${read.length} lights on` };
  } catch (err) {
    logger.log(`[tuya] switch state for "${onScene}" failed: ${err.message}`);
    return { status: "error", message: "Tuya error, see Core log" };
  }
}

// Runs the named scene. Resolves to a task result ({status, message}) —
// never throws, so the panel always gets a readable answer.
export async function runTuyaScene(name, logger = console) {
  if (!tuyaConfigured()) {
    return { status: "error", message: "Tuya not set up (see .env)" };
  }
  try {
    const wanted = String(name).trim().toLowerCase();
    let scenes = await listScenes();
    let scene = scenes.find((s) => s.name.trim().toLowerCase() === wanted);
    if (!scene && sceneCache.at) {
      // Maybe just created in the app: refresh once before giving up.
      sceneCache.at = 0;
      scenes = await listScenes();
      scene = scenes.find((s) => s.name.trim().toLowerCase() === wanted);
    }
    if (!scene) {
      logger.log(`[tuya] no scene "${name}" — have: ${scenes.map((s) => s.name).join(", ") || "none"}`);
      return { status: "error", message: `No Tuya scene "${name}"` };
    }
    await call("POST", `/v1.0/homes/${scene.homeId}/scenes/${scene.sceneId}/trigger`);
    logger.log(`[tuya] ran scene "${scene.name}" (${scene.sceneId})`);
    lastRun = { name: scene.name.trim().toLowerCase(), at: Date.now() };
    scheduleLearn(scene, logger);
    return { status: "ok", message: `Ran "${scene.name}"` };
  } catch (err) {
    logger.log(`[tuya] scene "${name}" failed: ${err.message}`);
    return { status: "error", message: "Tuya error, see Core log" };
  }
}

// --- Active scene detection ---------------------------------------------------
//
// Tap-to-Run scenes are one-shot commands: Tuya has no "current scene", and
// its API lists which devices a scene touches but not the values it sets
// (executor_property comes back empty). So scenes are LEARNED: a while after a
// scene runs from the panel, the states of its devices are saved as that
// scene's fingerprint. A scene counts as active while its devices still match
// (small brightness/colour differences tolerated).
//
// Checked only when a panel asks (it does when a page with scene tiles
// opens) — no polling, no pushes. Right after a successful run the answer is
// simply that scene: the lights are still settling and the cloud reports
// them late, and the panel has already lit that tile.

const LEARN_DELAY_MS = 10_000;  // Tuya's cloud reports new light states a few seconds late
const JUST_RAN_MS = 30_000;     // answer "the scene that just ran" without reading lights
const STORE = path.resolve("data/tuya-scenes.json");
const LIGHT_CODES = /^(switch_led|switch_1|switch|work_mode|bright_value(_v2)?|temp_value(_v2)?|colour_data(_v2)?)$/;

let fingerprints = loadStore(); // name(lowercase) -> { name, learnedAt, devices: { id: { code: value } } }
let lastRun = null;             // { name(lowercase), at }
let pendingLearn = null;        // timer for the most recent run's learn

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE, "utf8"));
  } catch {
    return {};
  }
}

function saveStore() {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(fingerprints, null, 2));
}

// Devices Tuya won't give us status for (e.g. a light group, or a device
// shared from another account): skipped, and scenes are matched on the rest.
const unreadable = new Set();

function lightState(list) {
  return Object.fromEntries((list ?? []).filter((d) => LIGHT_CODES.test(d.code)).map((d) => [d.code, d.value]));
}

async function readStates(deviceIds, logger = console) {
  const states = {};
  const ids = deviceIds.filter((id) => !unreadable.has(id));
  for (let i = 0; i < ids.length; i += 20) {
    const batch = ids.slice(i, i + 20);
    try {
      const r = await call("GET", "/v1.0/devices/status", { device_ids: batch.join(",") });
      for (const [id, list] of Object.entries(r ?? {})) states[id] = lightState(list);
    } catch {
      // One unreadable device fails the whole batch: go one by one, once,
      // and remember which ones to leave out from now on.
      for (const id of batch) {
        try {
          states[id] = lightState(await call("GET", `/v1.0/devices/${id}/status`));
        } catch (err) {
          unreadable.add(id);
          logger.log(`[tuya] can't read device ${id} (${err.message}) — leaving it out of scene matching`);
        }
      }
    }
  }
  return states;
}

const isOn = (st) => st.switch_led ?? st.switch_1 ?? st.switch ?? true;

function close(code, a, b) {
  const v2 = code.endsWith("_v2");
  const tol = v2 ? 60 : 15; // ~6% of 0-1000 / 0-255
  if (code.startsWith("colour_data")) {
    try {
      const x = typeof a === "string" ? JSON.parse(a) : a;
      const y = typeof b === "string" ? JSON.parse(b) : b;
      const dh = Math.abs(x.h - y.h) % 360;
      return Math.min(dh, 360 - dh) <= 10 && Math.abs(x.s - y.s) <= tol && Math.abs(x.v - y.v) <= tol;
    } catch {
      return a === b;
    }
  }
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= tol;
  return a === b;
}

function deviceMatches(want, have) {
  if (!have) return false;
  if (!isOn(want)) return !isOn(have);
  if (!isOn(have)) return false;
  if (want.work_mode && want.work_mode !== have.work_mode) return false;
  const mode = want.work_mode;
  for (const [code, value] of Object.entries(want)) {
    if (/^(switch|work_mode)/.test(code)) continue;
    // Only the values that matter in the current mode.
    if (mode === "colour" && !code.startsWith("colour_data")) continue;
    if (mode === "white" && code.startsWith("colour_data")) continue;
    if (mode && mode !== "colour" && mode !== "white") continue;
    if (!close(code, value, have[code])) return false;
  }
  return true;
}

// Learns only the latest run: a newer scene run before the delay is up
// cancels the older learn, which would otherwise save the newer scene's
// light states under the older scene's name.
function scheduleLearn(scene, logger) {
  if (pendingLearn) clearTimeout(pendingLearn);
  pendingLearn = null;
  if (!scene.deviceIds.length && !scene.roomIds?.length) return;
  pendingLearn = setTimeout(async () => {
    pendingLearn = null;
    try {
      const states = await readStates(await sceneLights(scene), logger);
      fingerprints[scene.name.trim().toLowerCase()] = {
        name: scene.name,
        learnedAt: new Date().toISOString(),
        devices: states,
      };
      saveStore();
      logger.log(`[tuya] learned scene "${scene.name}" (${Object.keys(states).length} device(s))`);
    } catch (err) {
      logger.log(`[tuya] learning "${scene.name}" failed: ${err.message}`);
    }
  }, LEARN_DELAY_MS);
}

// Scenes (lowercase names) active right now, for a panel that asks.
export async function activeScenes(logger = console) {
  if (lastRun && Date.now() - lastRun.at < JUST_RAN_MS) return [lastRun.name];
  const names = Object.keys(fingerprints);
  if (!tuyaConfigured() || !names.length) return [];
  try {
    const ids = [...new Set(names.flatMap((n) => Object.keys(fingerprints[n].devices)))];
    const states = await readStates(ids, logger);
    const active = names
      .filter((n) => Object.entries(fingerprints[n].devices).every(([id, want]) => deviceMatches(want, states[id])))
      .sort();
    logger.log(`[tuya] active scenes: ${active.join(", ") || "none"}`);
    return active;
  } catch (err) {
    logger.log(`[tuya] scene check failed: ${err.message}`);
    return [];
  }
}
