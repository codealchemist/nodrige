import fs from "node:fs";
import https from "node:https";

const CORE_URL = process.env.CORE_URL || "https://localhost:7000";
const CORE_TOKEN = process.env.CORE_BEARER_TOKEN;

// The Core serves HTTPS only, with a self-signed dev certificate
// (core-server-poc/src/devCert.js). Global fetch() has no per-request CA
// option and NODE_EXTRA_CA_CERTS is read before dotenv runs, so trust that
// one certificate explicitly through node:https instead of disabling
// verification.
const CORE_CA_CERT = process.env.CORE_CA_CERT;
const ca = CORE_CA_CERT ? fs.readFileSync(CORE_CA_CERT) : undefined;

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Authorization: `Bearer ${CORE_TOKEN}` }, ca }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Core returned ${res.statusCode} fetching ${url}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`Core returned invalid JSON from ${url}: ${err.message}`));
        }
      });
    });
    req.on("error", reject);
  });
}

// Fetches the full clientInstructions (deviceId, BLE UUIDs, mqttConfigPayload)
// the Core minted for this session — the "provision" command carries only the
// sessionId (a scalar, per ch.5 §5.4's CoreCommand.value), so the agent pulls
// the rest over the same HTTP API a human-driven companion app would use.
export async function fetchSessionInstructions(sessionId) {
  return getJson(`${CORE_URL}/provisioning/sessions/${sessionId}`);
}
