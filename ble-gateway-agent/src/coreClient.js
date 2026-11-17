const CORE_URL = process.env.CORE_URL || "http://localhost:7000";
const CORE_TOKEN = process.env.CORE_BEARER_TOKEN;

// Fetches the full clientInstructions (deviceId, BLE UUIDs, mqttConfigPayload)
// the Core minted for this session — the "provision" command carries only the
// sessionId (a scalar, per ch.5 §5.4's CoreCommand.value), so the agent pulls
// the rest over the same HTTP API a human-driven companion app would use.
export async function fetchSessionInstructions(sessionId) {
  const res = await fetch(`${CORE_URL}/provisioning/sessions/${sessionId}`, {
    headers: { Authorization: `Bearer ${CORE_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`Core returned ${res.status} fetching session ${sessionId}`);
  }
  return res.json();
}
