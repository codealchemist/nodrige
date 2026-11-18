// MQTT for the browser: the web console connects to wss://<core>/mqtt, on
// the Core's own HTTPS port and certificate, and this pipes the WebSocket
// straight through to the broker's TCP port. MQTT over WebSocket is the same
// byte stream in binary frames, so no translation is needed; the broker
// enforces what the console may do (read-only `console` login, see
// scripts/dev-broker.js). Browsers can't set headers on a WebSocket, so the
// bearer token comes as ?token=.
import net from "node:net";
import { WebSocketServer, createWebSocketStream } from "ws";
import { verifyToken } from "../identity/verifyToken.js";

export function attachMqttBridge(httpsServer, { mqttUrl, logger = console }) {
  const { hostname, port } = new URL(mqttUrl || "mqtt://localhost:1883");
  const wss = new WebSocketServer({ noServer: true });

  httpsServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "https://x");
    if (url.pathname !== "/mqtt") return;  // not ours
    if (!verifyToken(`Bearer ${url.searchParams.get("token") ?? ""}`)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const browser = createWebSocketStream(ws);
      const broker = net.connect(Number(port) || 1883, hostname);
      browser.pipe(broker).pipe(browser);
      const close = () => {
        browser.destroy();
        broker.destroy();
      };
      browser.on("error", close);
      broker.on("error", (err) => {
        logger.warn(`[console] MQTT bridge: broker error ${err.message}`);
        close();
      });
      browser.on("close", close);
      broker.on("close", close);
    });
  });
}
