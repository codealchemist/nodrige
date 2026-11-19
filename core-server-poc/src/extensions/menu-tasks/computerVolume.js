// The output volume of the computer the Core runs on, for the panel's Volume
// page (its "Computer" target). macOS only for now, through AppleScript's
// standard volume settings (0-100, absolute — unlike the phone remote, the
// real level can be read back).
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

function supported() {
  return process.platform === "darwin";
}

async function osascript(script) {
  const { stdout } = await run("osascript", ["-e", script], { timeout: 3000 });
  return stdout.trim();
}

// { level: 0-100, muted: bool }
export async function getComputerVolume() {
  if (!supported()) throw new Error(`computer volume not supported on ${process.platform}`);
  const out = await osascript("get {output volume, output muted} of (get volume settings)");
  const [level, muted] = out.split(",").map((s) => s.trim());
  return { level: Number(level), muted: muted === "true" };
}

// Sets the level (clamped to 0-100, integer); returns what the system reports after.
export async function setComputerVolume(level) {
  if (!supported()) throw new Error(`computer volume not supported on ${process.platform}`);
  const v = Math.max(0, Math.min(100, Math.round(Number(level))));
  if (!Number.isFinite(v)) throw new Error("level must be a number");
  await osascript(`set volume output volume ${v}`);
  return getComputerVolume();
}
