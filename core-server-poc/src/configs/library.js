// The config library: named panel configs kept by the Core (data/configs/),
// edited in the web console and sent to a device on demand. Each entry is
// { id, name, description, version, updatedAt, config } where `config` is a
// panel config document without configVersion.
//
// Two different numbers, on purpose:
//   version        this library entry's edit counter: 1 when created, +1 each
//                  time its config changes. "Default v3" = the 3rd edit.
//   configVersion  what a device receives: assigned at send time as one more
//                  than the device's current one, because a device only
//                  accepts increasing numbers across *all* configs it is
//                  sent. The registry records which library version each
//                  delivery carried.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DIR = path.resolve("data/configs");

const slug = (s) =>
  String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "config";

export function createConfigLibrary() {
  fs.mkdirSync(DIR, { recursive: true });
  const file = (id) => path.join(DIR, `${id}.json`);
  const read = (id) => {
    try {
      const e = JSON.parse(fs.readFileSync(file(id), "utf8"));
      return { ...e, version: e.version ?? 1 };  // entries from before versions existed
    } catch {
      return null;
    }
  };
  const write = (entry) => fs.writeFileSync(file(entry.id), JSON.stringify(entry, null, 2));

  return {
    list() {
      return fs
        .readdirSync(DIR)
        .filter((f) => f.endsWith(".json"))
        .map((f) => read(f.slice(0, -5)))
        .filter(Boolean)
        .map(({ config, ...meta }) => ({ ...meta, version: meta.version ?? 1, items: countItems(config?.menu ?? []) }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    get: read,
    create({ name, description = "", config }) {
      let id = slug(name);
      if (read(id)) id = `${id}-${crypto.randomBytes(2).toString("hex")}`;
      const entry = { id, name: String(name), description: String(description), version: 1, updatedAt: new Date().toISOString(), config: strip(config) };
      write(entry);
      return entry;
    },
    update(id, patch) {
      const cur = read(id);
      if (!cur) return null;
      const config = patch.config !== undefined ? strip(patch.config) : cur.config;
      const changed = JSON.stringify(config) !== JSON.stringify(cur.config);
      const entry = {
        ...cur,
        ...(patch.name !== undefined ? { name: String(patch.name) } : {}),
        ...(patch.description !== undefined ? { description: String(patch.description) } : {}),
        config,
        // Only a config change is a new version; renaming isn't.
        version: changed ? cur.version + 1 : cur.version,
        updatedAt: new Date().toISOString(),
      };
      write(entry);
      return entry;
    },
    remove(id) {
      if (!read(id)) return false;
      fs.unlinkSync(file(id));
      return true;
    },
  };
}

// The library never stores a version or credentials.
function strip(config) {
  const { configVersion, ...rest } = config ?? {};
  if (rest.mqtt) delete rest.mqtt.password;
  return rest;
}

function countItems(menu) {
  return menu.reduce((n, item) => n + 1 + countItems(item.children ?? []), 0);
}
