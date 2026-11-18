import { Router } from "express";

// Device config push — the server side of the device config lifecycle in
// esp32-c6-control docs/ARCHITECTURE.md §5.3 point 3. The Core treats the
// document as opaque apart from a shape check (ch.1 P1: it knows nothing of
// menus); the device does the full validation and reports the outcome on its
// cmd/result topic, which is recorded here.
//
//   POST /devices/:id/config   body: the config document
//                              -> 202, published retained to devices/:id/config
//   GET  /devices/:id/config   -> last pushed document + the device's recent
//                                 reported outcomes, newest first ("applied" |
//                                 "unchanged" | "rejected", with errors). Kept
//                                 as a short history: after an apply, the
//                                 device reboots and the retained redelivery
//                                 reports "unchanged", which would otherwise
//                                 hide the "applied" that matters.
export function buildDeviceConfigRouter(adapter, logger = console) {
  const router = Router();
  const pushes = new Map(); // deviceId -> { config, pushedAt, results: [] }
  const MAX_RESULTS = 10;

  router.post("/:id/config", async (req, res) => {
    const config = req.body;
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      return res.status(400).json({ error: "body must be a JSON object" });
    }
    if (!Number.isInteger(config.configVersion) || config.configVersion < 1) {
      return res.status(400).json({ error: "configVersion must be an integer >= 1" });
    }
    if (!Array.isArray(config.menu)) {
      return res.status(400).json({ error: "menu must be an array" });
    }
    if (config.mqtt?.password !== undefined) {
      return res.status(400).json({ error: "mqtt.password must never be sent in a config" });
    }

    const payload = JSON.stringify(config);
    try {
      await adapter.publishConfig(req.params.id, payload);
    } catch (err) {
      logger.error(`[config] publish to ${req.params.id} failed`, err.message);
      return res.status(502).json({ error: "publish failed" });
    }
    pushes.set(req.params.id, {
      config,
      pushedAt: new Date().toISOString(),
      results: pushes.get(req.params.id)?.results ?? [],
    });
    logger.log(`[config] pushed configVersion ${config.configVersion} to ${req.params.id} (${payload.length} bytes, retained)`);
    res.status(202).json({ deviceId: req.params.id, configVersion: config.configVersion, status: "published" });
  });

  router.get("/:id/config", (req, res) => {
    const entry = pushes.get(req.params.id);
    if (!entry) return res.status(404).json({ error: "no config pushed to this device since Core start" });
    res.json({ deviceId: req.params.id, ...entry });
  });

  // Called for every devices/+/cmd/result message.
  function onResult(msg) {
    let body;
    try {
      body = JSON.parse(msg.payload.toString());
    } catch {
      logger.warn(`[config] non-JSON result on ${msg.topic}`);
      return;
    }
    if (body.type !== "config") return; // other result kinds: not ours
    const entry = pushes.get(msg.clientId) ?? { config: null, pushedAt: null, results: [] };
    const results = [{ ...body, receivedAt: msg.receivedAt }, ...entry.results].slice(0, MAX_RESULTS);
    pushes.set(msg.clientId, { ...entry, results });
    const errors = body.errors?.length ? ` — ${body.errors.join("; ")}` : "";
    logger.log(`[config] ${msg.clientId} reports configVersion ${body.configVersion}: ${body.status}${errors}`);
  }

  return { router, onResult };
}
