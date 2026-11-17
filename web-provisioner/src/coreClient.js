// Talks to the Core's provisioning HTTP API. This app plays the
// human-driven companion-app role for the `ble-wifi` strategy
// (docs/04-device-provisioning.md §4.3.1) — begins a session before BLE
// starts, confirms it after the device reports MQTT connected.
export function createCoreClient({ baseUrl, bearerToken }) {
  async function request(path, options = {}) {
    let res;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearerToken}`,
          ...options.headers,
        },
      });
    } catch (err) {
      // A bare "Failed to fetch" here gives no clue why — it covers Core not
      // running, a wrong scheme/port (mixed content is blocked silently),
      // and an untrusted self-signed cert alike. Point at the fix for each.
      throw new Error(
        `Could not reach Core at ${baseUrl} (${err.message}). Check it's running and the URL/scheme ` +
          `match. If Core serves HTTPS with a self-signed cert, open ${baseUrl}/health directly in this ` +
          `browser once and accept the certificate warning — this doesn't happen automatically for ` +
          `background fetch() calls.`
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Core ${options.method || "GET"} ${path} -> ${res.status}: ${body}`);
    }
    return res.json();
  }

  return {
    beginSession: () =>
      request("/provisioning/sessions", {
        method: "POST",
        body: JSON.stringify({ strategyId: "ble-wifi" }),
      }),
    confirmSession: (sessionId, payload) =>
      request(`/provisioning/sessions/${sessionId}/payload`, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    getSession: (sessionId) => request(`/provisioning/sessions/${sessionId}`),
  };
}
