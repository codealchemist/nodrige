// Spotify sign-in for the Core: Authorization Code with PKCE (no client
// secret). The console starts it (POST /spotify/connect returns Spotify's
// consent URL), Spotify redirects the browser to GET /spotify/callback, and
// the Core keeps the refresh token in data/spotify-token.json (git-ignored).
// Access tokens are refreshed on demand.
//
// Setup: an app at developer.spotify.com/dashboard with the redirect URI
// below (Spotify only accepts https or a loopback IP, not "localhost"), and
// SPOTIFY_CLIENT_ID in .env.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TOKEN_FILE = path.resolve("data/spotify-token.json");
const ACCOUNTS = "https://accounts.spotify.com";
export const SCOPES = [
  "user-read-currently-playing",
  "user-read-playback-state",
  "user-modify-playback-state",   // skip to next
  "user-library-read",            // is it liked?
  "user-library-modify",          // like / unlike
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-public",       // drop the song from your playlist
  "playlist-modify-private",
];

const clientId = () => process.env.SPOTIFY_CLIENT_ID ?? "";
export const redirectUri = () =>
  process.env.SPOTIFY_REDIRECT_URI || `https://127.0.0.1:${process.env.PORT || 7000}/spotify/callback`;
export const spotifyConfigured = () => Boolean(clientId());

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let token = load();                 // { refresh_token, access_token, expires_at, user }
const pending = new Map();          // state -> { verifier, returnTo, at }

function load() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  } catch {
    return null;
  }
}
function save() {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2), { mode: 0o600 });
}

export function spotifyConnected() {
  return Boolean(token?.refresh_token);
}
export function spotifyUser() {
  return token?.user ?? null;
}
export function setSpotifyUser(user) {
  if (!token) return;
  token.user = user;
  save();
}

export function authorizeUrl(returnTo) {
  if (!spotifyConfigured()) throw new Error("SPOTIFY_CLIENT_ID is not set in the Core's .env");
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  // Forget abandoned attempts after 10 minutes.
  for (const [k, v] of pending) if (Date.now() - v.at > 600_000) pending.delete(k);
  pending.set(state, { verifier, returnTo, at: Date.now() });
  const q = new URLSearchParams({
    client_id: clientId(),
    response_type: "code",
    redirect_uri: redirectUri(),
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
    scope: SCOPES.join(" "),
  });
  return `${ACCOUNTS}/authorize?${q}`;
}

async function tokenRequest(params) {
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId(), ...params }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error_description || body.error || `token request failed (${res.status})`);
  return body;
}

function keep(body) {
  token = {
    ...token,
    access_token: body.access_token,
    expires_at: Date.now() + (body.expires_in ?? 3600) * 1000,
    // Spotify may rotate the refresh token; keep the newest.
    refresh_token: body.refresh_token ?? token?.refresh_token,
  };
  save();
}

// Finish the sign-in. Returns where to send the browser back to.
export async function completeAuth(code, state) {
  const p = pending.get(state);
  if (!p) throw new Error("This sign-in link expired or was already used. Start again from the console.");
  pending.delete(state);
  const body = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    code_verifier: p.verifier,
  });
  token = null;
  keep(body);
  return p.returnTo;
}

export async function accessToken({ force = false } = {}) {
  if (!spotifyConnected()) throw new Error("Spotify not connected");
  if (!force && token.access_token && Date.now() < token.expires_at - 60_000) return token.access_token;
  try {
    keep(await tokenRequest({ grant_type: "refresh_token", refresh_token: token.refresh_token }));
  } catch (err) {
    // A revoked or expired grant won't come back: make the console ask again.
    if (/invalid_grant|revoked/i.test(err.message)) disconnect();
    throw err;
  }
  return token.access_token;
}

export function disconnect() {
  token = null;
  try {
    fs.unlinkSync(TOKEN_FILE);
  } catch {}
}
