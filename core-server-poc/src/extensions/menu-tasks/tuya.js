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
import { TuyaContext } from "@tuya/tuya-connector-nodejs";

const SCENE_CACHE_MS = 60_000;

let ctx = null;
let sceneCache = { at: 0, scenes: [] }; // [{ homeId, sceneId, name }]

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
      scenes.push({ homeId, sceneId: s.scene_id, name: s.name });
    }
  }
  sceneCache = { at: Date.now(), scenes };
  return scenes;
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
    return { status: "ok", message: `${scene.name} on` };
  } catch (err) {
    logger.log(`[tuya] scene "${name}" failed: ${err.message}`);
    return { status: "error", message: "Tuya error, see Core log" };
  }
}
