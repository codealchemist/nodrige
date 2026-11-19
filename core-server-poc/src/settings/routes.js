// Integration settings for the web console (behind the bearer token).
//   GET  /integrations            every integration: fields (no secret values) + status
//   PUT  /integrations/:id        { values: { KEY: "value" | null } } -> applies at once
//   POST /integrations/:id/test   tries it for real -> { ok, message }
import express from "express";
import { describe, INTEGRATIONS, update } from "./integrations.js";
import { resetTuya, tuyaConfigured, tuyaSceneNames } from "../extensions/menu-tasks/tuya.js";
import { reloadWeather, weatherLocation } from "../extensions/weather/index.js";
import { disconnect, redirectUri, spotifyConfigured, spotifyConnected, spotifyUser } from "../extensions/spotify/auth.js";
import { me } from "../extensions/spotify/api.js";

function status(id) {
  switch (id) {
    case "tuya":
      return tuyaConfigured() ? { state: "configured", message: "Credentials set" } : { state: "missing", message: "Not set up" };
    case "spotify":
      if (!spotifyConfigured()) return { state: "missing", message: "Not set up" };
      return spotifyConnected()
        ? { state: "ok", message: `Connected${spotifyUser() ? ` as ${spotifyUser().name}` : ""}`, connected: true, user: spotifyUser(), redirectUri: redirectUri() }
        : { state: "configured", message: "Not connected", connected: false, redirectUri: redirectUri() };
    case "weather": {
      const loc = weatherLocation();
      return loc ? { state: "ok", message: `${loc.name} (${loc.source})` } : { state: "missing", message: "No location yet" };
    }
  }
  return { state: "missing", message: "" };
}

async function test(id) {
  switch (id) {
    case "tuya": {
      if (!tuyaConfigured()) return { ok: false, message: "Add the access ID and secret first" };
      const scenes = await tuyaSceneNames();
      return { ok: true, message: `Signed in: ${scenes.length} scene${scenes.length === 1 ? "" : "s"} in your homes` };
    }
    case "spotify": {
      if (!spotifyConfigured()) return { ok: false, message: "Add the client ID first" };
      if (!spotifyConnected()) return { ok: false, message: "Set up; connect your account to finish" };
      const u = await me();
      return { ok: true, message: `Connected as ${u.name}${u.product ? ` (${u.product})` : ""}` };
    }
    case "weather": {
      const loc = await reloadWeather();
      return loc ? { ok: true, message: `Location: ${loc.name} (${loc.source})` } : { ok: false, message: "Couldn't find a location" };
    }
  }
  return { ok: false, message: "Nothing to test" };
}

// What else must happen when settings change.
async function afterChange(id, changed, logger) {
  if (id === "tuya") {
    resetTuya();
    // The weather may come from the Tuya home's location.
    if (!process.env.WEATHER_ADDRESS) await reloadWeather().catch(() => {});
  }
  if (id === "spotify" && changed.includes("SPOTIFY_CLIENT_ID") && spotifyConnected()) {
    // The saved sign-in belongs to the old app.
    disconnect();
    logger.log("[integrations] Spotify client ID changed: sign in again");
  }
  if (id === "weather") await reloadWeather().catch(() => {});
}

export function buildIntegrationsRouter({ logger = console } = {}) {
  const r = express.Router();
  r.get("/integrations", (req, res) => {
    res.json(INTEGRATIONS.map((i) => ({ ...describe(i.id), status: status(i.id) })));
  });
  r.put("/integrations/:id", async (req, res) => {
    try {
      const changed = update(req.params.id, req.body?.values);
      // Log which settings changed, never their values.
      if (changed.length) logger.log(`[integrations] ${req.params.id}: updated ${changed.join(", ")}`);
      await afterChange(req.params.id, changed, logger);
      res.json({ ...describe(req.params.id), status: status(req.params.id), changed });
    } catch (err) {
      res.status(err.status ?? 500).json({ error: err.message });
    }
  });
  r.post("/integrations/:id/test", async (req, res) => {
    try {
      res.json(await test(req.params.id));
    } catch (err) {
      res.json({ ok: false, message: err.message });
    }
  });
  return r;
}
