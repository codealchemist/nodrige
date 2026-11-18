// Known devices, for the web console: every device the Core has seen on
// MQTT (presence on devices/<id>/status, any message or config result), with
// a display name and what it last reported. Saved in data/devices.json so the
// list survives Core restarts; live presence itself comes from the retained
// status topic, which the console also subscribes to directly.
import fs from "node:fs";
import path from "node:path";

const FILE = path.resolve("data/devices.json");

export function createDeviceRegistry(logger = console) {
  let devices = {};
  try {
    devices = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    devices = {};
  }
  let saveTimer = null;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(devices, null, 2));
    }, 500);
  };

  function touch(id) {
    const now = new Date().toISOString();
    const d = (devices[id] ??= { id, name: id, firstSeen: now });
    d.lastSeen = now;
    return d;
  }

  return {
    list: () => Object.values(devices).sort((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? "")),
    get: (id) => devices[id] ?? null,

    // devices/<id>/status: {"state":"online"|"offline", ip, fw, configVersion}
    onStatus(id, payload) {
      let s;
      try {
        s = JSON.parse(payload.toString());
      } catch {
        return;
      }
      const d = touch(id);
      const was = d.status?.state;
      d.status = { ...s, at: new Date().toISOString() };
      if (s.configVersion !== undefined) d.configVersion = s.configVersion;
      if (was !== s.state) logger.log(`[devices] ${id} is ${s.state}`);
      save();
    },

    onMessage(id) {
      touch(id);
      save();
    },

    // Config results: which version the device actually runs.
    onConfigResult(id, body) {
      const d = touch(id);
      if (body.status === "applied" || body.status === "unchanged") d.configVersion = body.configVersion;
      d.lastConfigResult = { status: body.status, configVersion: body.configVersion, errors: body.errors ?? [], at: new Date().toISOString() };
      save();
    },

    // The console's "send config X": remembered per device.
    onConfigSent(id, { libraryId, libraryVersion, configVersion }) {
      const d = touch(id);
      d.sentConfig = { libraryId, libraryVersion, configVersion, at: new Date().toISOString() };
      save();
    },

    rename(id, name) {
      if (!devices[id]) return null;
      devices[id].name = String(name).slice(0, 60) || id;
      save();
      return devices[id];
    },
  };
}
