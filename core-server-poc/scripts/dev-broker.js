import { Aedes } from "aedes";
import net from "node:net";

// Pure-JS MQTT broker for local dev only — no system install (Mosquitto,
// Docker, etc.) required. Point MQTT_URL at a real broker for anything
// beyond local dev; the Core never assumes this one is in use (ch.5).
const port = Number(process.env.MQTT_BROKER_PORT) || 1883;

const broker = await Aedes.createBroker();
const server = net.createServer(broker.handle);

broker.on("client", (client) => console.log(`[broker] client connected: ${client.id}`));
broker.on("clientDisconnect", (client) => console.log(`[broker] client disconnected: ${client.id}`));
broker.on("clientError", (client, err) => console.error(`[broker] client error (${client?.id}):`, err.message));

server.listen(port, () => console.log(`[broker] MQTT broker listening on :${port}`));

function shutdown() {
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
