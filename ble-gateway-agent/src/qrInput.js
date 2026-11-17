import http from "node:http";

// The v2 protocol's entire security model rests on physical possession of
// the device's on-screen QR (docs/PROVISIONING_PROTOCOL_V2.md §1, §11) —
// this agent has no camera, so it cannot scan that QR itself, and must not
// pretend to. Automating the BLE handshake does not remove the requirement
// that *someone* with physical access to the device scans the QR; it only
// removes the need for that person to run a full companion-app UI.
//
// This exposes one local-only endpoint an operator posts the scanned QR
// JSON to, once per provisioning attempt, after scanning it with any QR
// reader (a phone's camera app is enough — no companion app required for
// this step).
export function createQrInputServer({ port = 4001 } = {}) {
  const pending = new Map(); // sessionId -> {resolve, reject}

  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/qr") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400).end(JSON.stringify({ error: "invalid JSON body" }));
        return;
      }
      const { sessionId, qrJson } = parsed;
      const waiter = pending.get(sessionId);
      if (!waiter) {
        res.writeHead(404).end(JSON.stringify({ error: `no pending provisioning request for session ${sessionId}` }));
        return;
      }
      pending.delete(sessionId);
      waiter.resolve(qrJson);
      res.writeHead(200).end(JSON.stringify({ status: "accepted" }));
    });
  });

  server.listen(port, () => console.log(`[gateway] QR input endpoint listening on http://localhost:${port}/qr`));

  return {
    // Resolves with the raw QR JSON string once an operator POSTs it for
    // this sessionId, or rejects on timeout.
    waitForQr(sessionId, timeoutMs = 120_000) {
      console.log(
        `[gateway] waiting for QR for session ${sessionId} — scan the device's on-screen QR with any reader, then:\n` +
          `  curl -X POST http://localhost:${port}/qr -H "Content-Type: application/json" -d '{"sessionId":"${sessionId}","qrJson":"<paste QR text here, JSON-escaped>"}'`
      );
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(sessionId);
          reject(new Error("timed out waiting for QR input"));
        }, timeoutMs);
        pending.set(sessionId, {
          resolve: (qrJson) => {
            clearTimeout(timer);
            resolve(qrJson);
          },
          reject,
        });
      });
    },
    close() {
      server.close();
    },
  };
}
