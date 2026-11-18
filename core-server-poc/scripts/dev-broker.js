import { Aedes } from "aedes";
import net from "node:net";

// Pure-JS MQTT broker for local dev only — no system install (Mosquitto,
// Docker, etc.) required. Point MQTT_URL at a real broker for anything
// beyond local dev; the Core never assumes this one is in use (ch.5).
//
// One login is special: `console` (password CONSOLE_MQTT_PASSWORD), used by
// the web console through the Core's /mqtt WebSocket bridge. It may only
// SUBSCRIBE, and only to what the console shows: device presence, telemetry,
// logs and command results, plus the Core's own core/# topics. Everything
// else (devices, the Core) is unrestricted, as before, in this dev broker.
const port = Number(process.env.MQTT_BROKER_PORT) || 1883;
const CONSOLE_USER = "console";
const CONSOLE_PASSWORD = process.env.CONSOLE_MQTT_PASSWORD || "console-dev";
const CONSOLE_TOPICS = [
  /^devices\/[^/#+]+\/(status|telemetry|log|cmd\/result)$/,
  /^devices\/\+\/(status|telemetry|log|cmd\/result)$/,
  /^core\/.*/,
];

const broker = await Aedes.createBroker({
  authenticate(client, username, password, done) {
    if (username === CONSOLE_USER) {
      const ok = String(password ?? "") === CONSOLE_PASSWORD;
      if (ok) client.isConsole = true;
      return done(null, ok);
    }
    done(null, true);
  },
  authorizePublish(client, packet, done) {
    if (client?.isConsole) return done(new Error("console is read-only"));
    done(null);
  },
  authorizeSubscribe(client, sub, done) {
    if (client?.isConsole && !CONSOLE_TOPICS.some((re) => re.test(sub.topic))) {
      // Refuse just this subscription (SUBACK failure code); an error here
      // would make aedes drop the whole connection.
      console.warn(`[broker] console may not subscribe to ${sub.topic}`);
      return done(null, null);
    }
    done(null, sub);
  },
});
const server = net.createServer(broker.handle);

broker.on("client", (client) => console.log(`[broker] client connected: ${client.id}`));
broker.on("clientDisconnect", (client) => console.log(`[broker] client disconnected: ${client.id}`));
broker.on("clientError", (client, err) => console.error(`[broker] client error (${client?.id}):`, err.message));

server.listen(port, () => console.log(`[broker] MQTT broker listening on :${port}`));

// server.close() waits for every client to disconnect, and devices never
// do — so close the broker (dropping clients) and don't wait forever.
function shutdown() {
  broker.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
