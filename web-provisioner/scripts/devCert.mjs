// Self-signed dev certificate, generated on demand via the system `openssl`
// binary — not a runtime dependency, just dev tooling (same philosophy as
// dev-broker.js in core-server-poc). Web Bluetooth and getUserMedia require
// a secure context; a real cert lets a LAN IP qualify, not just localhost.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const certDir = path.join(root, "certs");
const keyPath = path.join(certDir, "dev-key.pem");
const certPath = path.join(certDir, "dev-cert.pem");

export function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((addr) => addr && addr.family === "IPv4" && !addr.internal)
    .map((addr) => addr.address);
}

// Returns { keyPath, certPath }, generating the pair first if missing.
// If your LAN IP changes (different network), delete certs/ and rerun —
// the old cert's SAN list won't cover the new address.
export function ensureDevCert() {
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { keyPath, certPath };
  }

  fs.mkdirSync(certDir, { recursive: true });

  const ips = ["127.0.0.1", ...lanAddresses()];
  const san = ["DNS:localhost", ...ips.map((ip) => `IP:${ip}`)].join(",");

  console.log(`[dev-cert] generating self-signed certificate — SAN: localhost, ${ips.join(", ")}`);
  try {
    // openssl writes RSA-generation progress dots to stderr even on success —
    // capture rather than inherit, and only surface it if generation fails.
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048",
        "-keyout", keyPath,
        "-out", certPath,
        "-days", "365",
        "-nodes",
        "-subj", "/CN=localhost",
        "-addext", `subjectAltName=${san}`,
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
  } catch (err) {
    throw new Error(
      `Could not generate a dev certificate (is 'openssl' installed and on PATH?): ${err.stderr?.toString() || err.message}`
    );
  }

  console.log(`[dev-cert] wrote ${certPath}`);
  return { keyPath, certPath };
}
