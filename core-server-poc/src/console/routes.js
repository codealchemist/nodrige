// HTTP API for the web console (nodrige/web-console). All routes need the
// bearer token, except the icon images (an <img> can't send headers; they're
// public Icons8 artwork anyway).
//
//   GET    /console/session          MQTT bridge login for the browser
//   GET    /devices                  known devices (registry)
//   PATCH  /devices/:id              { name }
//   GET    /configs                  library list
//   POST   /configs                  { name, description?, config }  (or { from: <id> } to duplicate)
//   GET    /configs/:id              one entry
//   PUT    /configs/:id              { name?, description?, config? }
//   DELETE /configs/:id
//   POST   /configs/:id/send         { deviceId }  -> validates, versions, pushes
//   POST   /configs/validate         { config } -> { errors }
//   GET    /configs/schema           the JSON Schema
//   GET    /catalog                  icons, actions, scenes and tasks for the builder
//   GET    /catalog/icons/:id.png    icon artwork (no auth)
import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { coreLogSince } from "./coreLog.js";
import { schema, validateConfig } from "../configs/validate.js";

// The firmware repo holds the icon artwork and the default menu.
const FIRMWARE_DIR = path.resolve(process.env.FIRMWARE_DIR || "../../esp32-c6-control/poc");
const ACTIONS = [
  { id: "volume", label: "Volume (phone / computer)" },
  { id: "weather", label: "Weather" },
  { id: "screenDim", label: "Screen dimming" },
  { id: "screenOff", label: "Screen off" },
  { id: "switchSync", label: "Switch sync" },
  { id: "shortcut", label: "Shortcut button" },
  { id: "showAbout", label: "About" },
  { id: "reprovision", label: "Reset Wi-Fi/MQTT" },
  { id: "restoreDefaultConfig", label: "Restore default config" },
];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function iconRouter() {
  const router = Router();
  router.get("/catalog/icons/:file", (req, res) => {
    const id = req.params.file.replace(/\.png$/, "");
    if (!/^[a-z0-9_]+$/.test(id)) return res.sendStatus(400);
    const manifest = readJson(path.join(FIRMWARE_DIR, "data/icons_manifest.json"));
    const icon = manifest?.icons?.find((i) => i.id === id);
    if (!icon) return res.sendStatus(404);
    res.sendFile(path.join(FIRMWARE_DIR, icon.file || `data/icons_src/icons8/${id}.png`));
  });
  return router;
}

export function buildConsoleRouter({ registry, library, publishConfig, dispatch, sceneNames, consoleMqtt, logger = console }) {
  const router = Router();

  router.get("/console/session", (req, res) => res.json({ mqtt: consoleMqtt }));

  // --- Devices ---
  router.get("/devices", (req, res) => res.json(registry.list()));
  router.patch("/devices/:id", (req, res) => {
    const d = registry.rename(req.params.id, req.body?.name ?? "");
    return d ? res.json(d) : res.sendStatus(404);
  });

  // Diagnostics, sent on to the device as a command:
  //   { action: "telemetry", seconds }   fast telemetry for a while
  //   { action: "log_stream", seconds, backlog }  stream the log (0 stops)
  //   { action: "shell", line }          run a shell line (output in the log)
  //   { action: "reboot" }               restart the device
  router.post("/devices/:id/diag", async (req, res) => {
    const id = req.params.id;
    if (!registry.get(id)) return res.sendStatus(404);
    const { action, seconds, backlog, line } = req.body ?? {};
    const cmd = { clientId: id, componentId: "diag", action };
    if (action === "telemetry" || action === "log_stream") {
      cmd.seconds = Math.max(0, Math.min(600, Number(seconds ?? 120) | 0));
      if (backlog) cmd.backlog = true;
    } else if (action === "shell") {
      const l = String(line ?? "").replace(/[\r\n]/g, " ").trim();
      if (!l || l.length > 200) return res.status(400).json({ error: "line must be 1-200 characters" });
      cmd.line = l;
      logger.log(`[console] ${id} $ ${l}`);
    } else if (action === "reboot") {
      // Not queued for later: a restart that lands hours after the click would surprise.
      if (registry.get(id)?.status?.state !== "online") return res.status(409).json({ error: "the device is offline" });
      logger.log(`[console] ${id}: restart requested`);
    } else {
      return res.status(400).json({ error: "action must be telemetry, log_stream, shell or reboot" });
    }
    try {
      await dispatch(cmd);
      res.status(202).json({ sent: true });
    } catch (err) {
      res.status(502).json({ error: `not sent: ${err.message}` });
    }
  });

  // The Core's own log, for the Logs page.
  router.get("/logs/core", (req, res) => res.json(coreLogSince(Number(req.query.after) || 0)));

  // --- Config library ---
  router.get("/configs", (req, res) => res.json(library.list()));
  router.get("/configs/schema", (req, res) => res.json(schema));
  router.post("/configs/validate", (req, res) => res.json({ errors: validateConfig(req.body?.config) }));
  router.post("/configs", (req, res) => {
    const { name, description, config, from } = req.body ?? {};
    let source = config;
    if (from) {
      const orig = library.get(from);
      if (!orig) return res.status(404).json({ error: "no such config to duplicate" });
      source = orig.config;
    }
    if (!name) return res.status(400).json({ error: "name is required" });
    if (!source) return res.status(400).json({ error: "config is required" });
    const errors = validateConfig(source);
    res.status(201).json({ ...library.create({ name, description, config: source }), errors });
  });
  router.get("/configs/:id", (req, res) => {
    const c = library.get(req.params.id);
    return c ? res.json({ ...c, errors: validateConfig(c.config) }) : res.sendStatus(404);
  });
  router.put("/configs/:id", (req, res) => {
    const c = library.update(req.params.id, req.body ?? {});
    return c ? res.json({ ...c, errors: validateConfig(c.config) }) : res.sendStatus(404);
  });
  router.delete("/configs/:id", (req, res) => (library.remove(req.params.id) ? res.sendStatus(204) : res.sendStatus(404)));

  router.post("/configs/:id/send", async (req, res) => {
    const entry = library.get(req.params.id);
    const deviceId = req.body?.deviceId;
    if (!entry) return res.sendStatus(404);
    if (!deviceId) return res.status(400).json({ error: "deviceId is required" });
    const errors = validateConfig(entry.config);
    if (errors.length) return res.status(422).json({ error: "config has errors", errors });
    // One more than anything the device has run or been sent.
    const d = registry.get(deviceId) ?? {};
    const configVersion = Math.max(d.configVersion ?? 0, d.sentConfig?.configVersion ?? 0) + 1;
    const doc = { configVersion, ...entry.config };
    try {
      await publishConfig(deviceId, doc);
    } catch (err) {
      return res.status(502).json({ error: `publish failed: ${err.message}` });
    }
    registry.onConfigSent(deviceId, { libraryId: entry.id, libraryVersion: entry.version, configVersion });
    logger.log(`[console] sent "${entry.name}" v${entry.version} to ${deviceId} as configVersion ${configVersion}`);
    res.status(202).json({ deviceId, configVersion, libraryVersion: entry.version, status: "published" });
  });

  // --- Catalog for the builder ---
  router.get("/catalog", async (req, res) => {
    const manifest = readJson(path.join(FIRMWARE_DIR, "data/icons_manifest.json"));
    let scenes = [];
    try {
      scenes = await sceneNames();
    } catch {
      scenes = [];
    }
    res.json({
      icons: (manifest?.icons ?? []).map((i) => ({ id: i.id, size: i.size ?? manifest.sourceExportSize, url: `/catalog/icons/${i.id}.png` })),
      actions: ACTIONS,
      scenes,
      tasks: ["player-volume", "core-info", "switch-state", "spotify-liked", "spotify-like", "spotify-skip-drop", "spotify-player"],
      defaultConfig: readJson(path.join(FIRMWARE_DIR, "data/config/default_config.json")),
    });
  });

  return router;
}
