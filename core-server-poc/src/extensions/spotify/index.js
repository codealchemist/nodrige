// Spotify Extension — panel buttons that act on whatever is playing on your
// Spotify account right now.
//
// Panel side (tasks on `messages`, task_result replies on `cmd`):
//   "spotify-liked"      -> { state: "on" | "off" }: is the current song in
//                           Liked Songs (a switch tile's state read)
//   "spotify-like"       -> like (state "on") or unlike (state "off") it
//   "spotify-skip-drop"  -> skip to the next song and, when it was playing
//                           from one of your own (or a collaborative)
//                           playlists, remove it from that playlist. The Web
//                           API can't remove songs from the play queue
//                           itself, so this is the nearest equivalent.
//
// HTTP (console):
//   GET  /spotify/callback     Spotify's redirect after sign-in (no token)
//   GET  /spotify/status       configured / connected / account
//   POST /spotify/connect      { returnTo } -> { url } to open
//   POST /spotify/disconnect
//
// Text sent to the panel is ASCII only: its fonts have no accented letters.
import express from "express";
import { authorizeUrl, completeAuth, disconnect, redirectUri, spotifyConfigured, spotifyConnected, spotifyUser } from "./auth.js";
import { isSaved, me, nowPlaying, playlistInfo, removeFromPlaylist, setSaved, skipNext, SpotifyError } from "./api.js";

const ascii = (s, max = 60) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

const songLabel = (np) => ascii(np.name, 40);

function failure(err) {
  if (!spotifyConfigured()) return { status: "error", message: "Spotify not set up" };
  if (!spotifyConnected()) return { status: "error", message: "Spotify not connected" };
  if (err instanceof SpotifyError && err.status === 403) {
    return { status: "error", message: /premium/i.test(err.message) ? "Needs Spotify Premium" : "Spotify refused it" };
  }
  return { status: "error", message: ascii(err.message, 60) || "Spotify error" };
}

// A song that can go in Liked Songs, or an error result.
async function likeable() {
  const np = await nowPlaying();
  if (!np) return { error: { status: "error", message: "Nothing playing" } };
  if (np.isLocal) return { error: { status: "error", message: "Local files can't be liked" } };
  return { np };
}

const handlers = {
  async "spotify-liked"() {
    const { np, error } = await likeable();
    if (error) return error;
    const on = await isSaved(np.uri);
    return { status: "ok", state: on ? "on" : "off", message: `${on ? "Liked" : "Not liked"}: ${songLabel(np)}`, song: songLabel(np) };
  },

  async "spotify-like"(p) {
    const { np, error } = await likeable();
    if (error) return error;
    const want = p.state !== "off";
    await setSaved(np.uri, want);
    return { status: "ok", state: want ? "on" : "off", message: `${want ? "Liked" : "Unliked"}: ${songLabel(np)}`, song: songLabel(np) };
  },

  async "spotify-skip-drop"(p, ctx) {
    const np = await nowPlaying();
    if (!np) return { status: "error", message: "Nothing playing" };
    // Skip first: that's the part you notice, so it should be quick.
    await skipNext();
    const id = np.context?.startsWith("spotify:playlist:") ? np.context.split(":")[2] : null;
    if (!id) return { status: "ok", message: `Skipped ${songLabel(np)}` };
    try {
      const [pl, user] = await Promise.all([playlistInfo(id), me()]);
      if (pl.owner?.id !== user.id && !pl.collaborative) {
        return { status: "ok", message: `Skipped (not your playlist)` };
      }
      await removeFromPlaylist(id, np.uri);
      ctx.logger.log(`[spotify] removed "${np.name}" from "${pl.name}"`);
      return { status: "ok", message: `Removed from ${ascii(pl.name, 30)}` };
    } catch (err) {
      ctx.logger.log(`[spotify] skipped, but removing from the playlist failed: ${err.message}`);
      return { status: "ok", message: "Skipped, not removed" };
    }
  },
};

export default {
  manifest: {
    id: "spotify",
    version: "0.1.0",
    displayName: "Spotify",
    permissions: { stateRead: true, commandDispatch: true },
    entryPoint: "src/extensions/spotify/index.js",
  },

  async onEnable(ctx) {
    ctx.logger.log(
      `[spotify] ${!spotifyConfigured() ? "not set up (SPOTIFY_CLIENT_ID)" : spotifyConnected() ? `connected${spotifyUser() ? ` as ${spotifyUser().name}` : ""}` : `set up, not connected — connect from the console (redirect URI ${redirectUri()})`}`
    );
  },

  async onStateChanged(event, ctx) {
    if (event.eventType !== "task") return;
    const { taskId, expectsResult, payload = {} } = event.metadata ?? {};
    const handler = handlers[taskId];
    if (!handler) return;

    let result;
    try {
      result = await handler(payload, ctx);
    } catch (err) {
      result = failure(err);
    }
    ctx.logger.log(`[spotify] ${event.clientId} "${taskId}": ${result.message}`);
    if (!expectsResult) return;
    await ctx.commands.dispatch({
      clientId: event.clientId,
      componentId: event.componentId,
      action: "task_result",
      value: result.status,
      correlationId: event.value,
      result,
    });
  },
};

export const SPOTIFY_TASKS = Object.keys(handlers);

// Where the browser may be sent back to after signing in: the console only,
// on this Core or a local dev server.
function safeReturn(returnTo) {
  const s = String(returnTo ?? "");
  if (s.startsWith("/console")) return s;
  try {
    const u = new URL(s);
    if (["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) && u.pathname.startsWith("/console")) return u.toString();
  } catch {}
  return "/console/settings";
}

const page = (title, text) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<body style="font-family:system-ui;background:#0a0d11;color:#e8edf3;display:grid;place-items:center;min-height:100vh;margin:0">` +
  `<div style="max-width:420px;padding:24px;text-align:center"><h2>${title}</h2><p style="color:#8592a3">${text}</p></div></body>`;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Before requireAuth: Spotify's redirect can't carry the console's token.
export function spotifyPublicRouter() {
  const r = express.Router();
  r.get("/spotify/callback", async (req, res) => {
    const { code, state, error } = req.query;
    if (error || !code) return res.status(400).send(page("Spotify not connected", esc(error || "No authorization code.")));
    try {
      const back = safeReturn(await completeAuth(String(code), String(state)));
      try {
        await me();
      } catch {}
      const sep = back.includes("?") ? "&" : "?";
      res.redirect(`${back}${sep}spotify=connected`);
    } catch (err) {
      res.status(400).send(page("Spotify not connected", esc(err.message)));
    }
  });
  return r;
}

export function spotifyRouter() {
  const r = express.Router();
  r.get("/spotify/status", (req, res) => {
    res.json({ configured: spotifyConfigured(), connected: spotifyConnected(), user: spotifyUser(), redirectUri: redirectUri() });
  });
  r.post("/spotify/connect", (req, res) => {
    try {
      res.json({ url: authorizeUrl(safeReturn(req.body?.returnTo)) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
  r.post("/spotify/disconnect", (req, res) => {
    disconnect();
    res.json({ connected: false });
  });
  return r;
}
