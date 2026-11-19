import "dotenv/config";
import { Aedes } from "aedes";
import net from "node:net";

// Pure-JS MQTT broker for local dev only — no system install (Mosquitto,
// Docker, etc.) required. Point MQTT_URL at a real broker for anything
// beyond local dev; the Core never assumes this one is in use (ch.5).
//
// Every client logs in (src/mqttAuth/credentials.js): the Core, the web
// console (read-only, through the Core's /mqtt bridge), the BLE gateway and
// each provisioned device, which may only use its own devices/<id>/ topics.
// Anonymous clients and wrong passwords are refused.
import { checkLogin, mayPublish, maySubscribe } from "../src/mqttAuth/credentials.js";

const port = Number(process.env.MQTT_BROKER_PORT) || 1883;

const broker = await Aedes.createBroker({
  authenticate(client, username, password, done) {
    const r = checkLogin(client?.id, username, password);
    if (r.refused) {
      console.warn(`[broker] refused ${client?.id ?? "?"}${username ? ` (user ${username})` : ""}: ${r.refused}`);
      const err = new Error(r.refused);
      err.returnCode = username ? 4 : 5;  // 4: bad user name or password, 5: not authorized
      return done(err, false);
    }
    client.who = r;
    if (r.note) console.log(`[broker] ${r.id}: ${r.note}`);
    done(null, true);
  },
  authorizePublish(client, packet, done) {
    // The last will is published on the client's behalf (client is then null
    // in some aedes paths): it was checked when the client connected.
    if (!client) return done(null);
    if (mayPublish(client.who, packet.topic)) return done(null);
    console.warn(`[broker] ${client.id} may not publish to ${packet.topic}`);
    done(new Error("not authorized"));
  },
  authorizeSubscribe(client, sub, done) {
    if (maySubscribe(client.who, sub.topic)) return done(null, sub);
    // Refuse just this subscription (SUBACK failure code); an error here
    // would make aedes drop the whole connection.
    console.warn(`[broker] ${client.id} may not subscribe to ${sub.topic}`);
    done(null, null);
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
