// The Core's own log for the console's Logs page: console.log/warn/error
// keep printing as before and are also kept here (last 1000 lines), read
// with GET /logs/core?after=<seq>.
import { format } from "node:util";

const MAX = 1000;
const lines = [];
let seq = 0;
let installed = false;

export function installCoreLog() {
  if (installed) return;
  installed = true;
  for (const level of ["log", "info", "warn", "error"]) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      const text = format(...args);
      for (const line of text.split("\n")) {
        lines.push({ seq: ++seq, at: Date.now(), level: level === "info" ? "log" : level, text: line });
      }
      if (lines.length > MAX) lines.splice(0, lines.length - MAX);
    };
  }
}

export function coreLogSince(after = 0, limit = 500) {
  const out = lines.filter((l) => l.seq > after).slice(-limit);
  return { lines: out, last: seq };
}
