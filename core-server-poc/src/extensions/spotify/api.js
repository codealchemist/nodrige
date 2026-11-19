// The few Spotify Web API calls the panel buttons need. Endpoints as of the
// February 2026 API changes: the library is /me/library (Spotify URIs), and
// playlist contents are /playlists/{id}/items.
import { accessToken, setSpotifyUser, spotifyUser } from "./auth.js";

const API = "https://api.spotify.com/v1";

export class SpotifyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function call(method, path, { query, body } = {}, retried = false) {
  const url = `${API}${path}${query ? `?${new URLSearchParams(query)}` : ""}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken({ force: retried })}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !retried) return call(method, path, { query, body }, true);
  if (res.status === 204) return null;
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) {
    const msg = data?.error?.message || data?.error_description || `HTTP ${res.status}`;
    if (res.status === 429) throw new SpotifyError(429, `Spotify rate limit, retry in ${res.headers.get("retry-after") ?? "a few"} s`);
    throw new SpotifyError(res.status, msg);
  }
  return data;
}

export async function me() {
  const cached = spotifyUser();
  if (cached?.id) return cached;
  const u = await call("GET", "/me");
  const user = { id: u.id, name: u.display_name || u.id, product: u.product };
  setSpotifyUser(user);
  return user;
}

// What's playing now, or null (nothing, an ad, or a private session).
export async function nowPlaying() {
  const np = await call("GET", "/me/player/currently-playing", { query: { additional_types: "episode" } });
  if (!np?.item) return null;
  const it = np.item;
  return {
    uri: it.uri,
    type: it.type,                      // "track" | "episode"
    isLocal: Boolean(it.is_local),
    name: it.name,
    by: it.type === "episode" ? it.show?.name ?? "" : (it.artists ?? []).map((a) => a.name).join(", "),
    context: np.context?.uri ?? null,  // e.g. "spotify:playlist:<id>"
    playing: Boolean(np.is_playing),
  };
}

export async function isSaved(uri) {
  const r = await call("GET", "/me/library/contains", { query: { uris: uri } });
  return Boolean(Array.isArray(r) ? r[0] : r);
}

export async function setSaved(uri, saved) {
  await call(saved ? "PUT" : "DELETE", "/me/library", { query: { uris: uri } });
}

export async function skipNext() {
  await call("POST", "/me/player/next");
}

export async function playlistInfo(id) {
  return call("GET", `/playlists/${id}`, { query: { fields: "name,owner(id),collaborative" } });
}

export async function removeFromPlaylist(id, uri) {
  await call("DELETE", `/playlists/${id}/items`, { body: { items: [{ uri }] } });
}

// --- Player (needs Premium for the controls; reading works on any account) ---

// The whole playback state, or null when no device is active.
export async function playerState() {
  const s = await call("GET", "/me/player", { query: { additional_types: "episode" } });
  if (!s?.device) return null;
  const it = s.item;
  return {
    playing: Boolean(s.is_playing),
    progressMs: s.progress_ms ?? 0,
    durationMs: it?.duration_ms ?? 0,
    name: it?.name ?? "",
    by: !it ? "" : it.type === "episode" ? it.show?.name ?? "" : (it.artists ?? []).map((a) => a.name).join(", "),
    device: s.device.name ?? "",
    volume: s.device.supports_volume === false ? null : s.device.volume_percent ?? null,
    shuffle: Boolean(s.shuffle_state),
  };
}

export const play = () => call("PUT", "/me/player/play");
export const pause = () => call("PUT", "/me/player/pause");
export const skipPrevious = () => call("POST", "/me/player/previous");
export const setVolume = (pct) => call("PUT", "/me/player/volume", { query: { volume_percent: String(pct) } });
