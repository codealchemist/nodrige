# core-server-poc

Walking-skeleton implementation of the architecture described in [`docs/00-poc-implementation-guide.md`](../docs/00-poc-implementation-guide.md). See that document for the design rationale, scope cuts, and what each piece is a stand-in for — this file is just "how to run it."

## Prerequisites

- Node.js 20+
- An MQTT broker reachable at `MQTT_URL` (default `mqtt://localhost:1883`). `npm start`/`npm run dev` bring up a disposable one automatically (see below) — no Mosquitto/Docker install needed for local dev.

## Setup

```bash
npm install
cp .env.example .env   # then set DEV_BEARER_TOKEN to a long random value (openssl rand -hex 24)
export TOKEN=...       # the same value, for the curl examples below
npm start              # or: npm run dev  (auto-restarts src/ on file changes)
```

On success:

```
[broker] MQTT broker listening on :1883
[echo] enabled
[loader] extension "echo" loaded
[core] listening on :7000
[core]   also reachable at http://192.168.1.42:7000 from other devices on this network
[broker] client connected: mqttjs_...
[mqtt] connected to mqtt://localhost:1883
```

The Core binds to all interfaces, so that second line is real — useful when a device on the same network (e.g. a phone running [`web-provisioner`](../web-provisioner/)) needs to reach it. See that package's README for the additional one-time browser setup a phone needs for camera/Bluetooth access over a plain LAN URL.

`npm start`/`npm run dev` run `scripts/dev-all.js`, which spawns **both** a local MQTT broker (`scripts/dev-broker.js`, a pure-JS broker built on [`aedes`](https://github.com/moscajs/aedes) — a dev convenience, not part of the Core's own code) and the Core server as one command, and shuts both down together on Ctrl-C. This is dev-only: the Core never owns or assumes this broker in production — point `MQTT_URL` at a real broker (Mosquitto, EMQX, AWS IoT Core, ...) and run `npm run server` (or `npm run server:watch`) instead to skip the dev broker entirely. `npm run broker` starts just the dev broker on its own, e.g. to keep it running across multiple `npm run server:watch` restarts.

The Core still boots and serves HTTP if no broker is reachable — the MQTT adapter retries in the background (`[mqtt] reconnecting...`) rather than crashing the process.

## Exercising the Full Loop

All routes except `/health` require `Authorization: Bearer <DEV_BEARER_TOKEN>`.

### 1. Health check (no auth)

```bash
curl http://localhost:7000/health
```

### 2. Provision a test device

The wire-level BLE contract this step hands off to a companion app is defined in [`docs/PROVISIONING_PROTOCOL_V2.md`](../docs/PROVISIONING_PROTOCOL_V2.md) — treat that document as authoritative for UUIDs and payload shapes, not this README. The reference companion app is [`../web-provisioner/`](../web-provisioner/) (camera QR scan + Web Bluetooth).

```bash
curl -X POST http://localhost:7000/provisioning/sessions \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"strategyId":"ble-wifi"}'
```

```json
{
  "sessionId": "...",
  "clientInstructions": {
    "deviceId": "esp32-panel-XXXXXXXX",
    "bleServiceUuid": "8027151f-907e-49d2-bd90-234456b8a407",
    "rxCharacteristicUuid": "9e1fb9a1-0f07-45cd-ae0a-1d340cbd4a42",
    "txCharacteristicUuid": "fbe43299-3649-4534-a091-b387f3b29aa1",
    "mqttConfigPayload": {
      "provisioningProtocolVersion": 2,
      "brokerHost": "localhost",
      "brokerPort": 1883,
      "useTls": false,
      "clientId": "esp32-panel-XXXXXXXX",
      "username": "esp32-panel-XXXXXXXX",
      "password": "...",
      "topics": {
        "commands": "devices/.../cmd",
        "commandResults": "devices/.../cmd/result",
        "messages": "devices/.../messages",
        "config": "devices/.../config",
        "status": "devices/.../status"
      }
    }
  }
}
```

The Core mints the device identity and MQTT broker credentials **up front** — it never touches BLE itself, and never sees the device's BLE session token (that travels only via the on-screen QR code, protocol §4/§8). A real companion app takes it from here per the protocol doc's §9 sequence: scan the QR, derive session keys (HKDF-SHA256), connect and exchange `HELLO`/`HELLO_ACK`, send `WIFI_CREDS` and poll `WIFI_STATUS` until connected, then send `mqttConfigPayload` as `MQTT_CONFIG` and poll `MQTT_STATUS` until connected/failed — all AES-GCM encrypted. `web-provisioner/` implements exactly this; its crypto core is verified against the protocol doc's own test vectors (`npm test` there).

Once the app's on-device polling reports `connected`, it confirms back to the Core so the session record reflects completion:

```bash
SESSION_ID=<sessionId from above>
curl -X POST http://localhost:7000/provisioning/sessions/$SESSION_ID/payload \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"status":"connected"}'
# -> { "status": "success", "deviceId": "esp32-panel-XXXXXXXX", "deviceCredential": "..." }
```

### 2b. Or: let the Core discover the device automatically (`ble-gateway`)

`ble-wifi` above needs a human running an app for every device. Pass `strategyId: "ble-gateway"` instead and the Core dispatches a command to a connected **BLE Gateway Agent** ([`../ble-gateway-agent/`](../ble-gateway-agent/), a sibling package/repo) automatically — no `POST .../payload` call needed on the happy path:

```bash
curl -X POST http://localhost:7000/provisioning/sessions \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"strategyId":"ble-gateway"}'
```

Behind this one call: the Core mints the identity/credentials exactly as above, then sends `{action: "provision", value: sessionId}` to whatever's connected as `GATEWAY_CLIENT_ID` (default `ble-gateway-01`). That agent fetches the session over HTTP, then waits for an operator to scan the device's QR and relay it (its own security model requires physical possession — nothing eliminates that step, see [`ble-gateway-agent/README.md`](../ble-gateway-agent/README.md)), drives the BLE handshake, and reports back over MQTT — which resolves the session automatically. Poll `GET /provisioning/sessions/:id` to watch it go `pending` → `success`/`failed`.

Running the real agent requires actual BLE hardware. Without hardware, you can still verify this entire control plane — dispatch, HTTP fetch-back, MQTT report, session resolution — with a stand-in script that speaks the same MQTT contract without touching real BLE or a QR; see the POC guide's [§0.4 Step 6b](../docs/00-poc-implementation-guide.md#step-6b--server-driven-alternative-ble-gateway-strategy).

### 3. Simulate device telemetry (no hardware required)

Publish to `devices/<deviceId>/messages` on the same broker — the `messages` topic from `mqttConfigPayload.topics` above — using any MQTT client, e.g. `mosquitto_pub`, or a short script with the [`mqtt`](https://www.npmjs.com/package/mqtt) npm package. The broker refuses anonymous clients, so log in as the device, with the `clientId`, `username` and `password` from `mqttConfigPayload`:

```js
import mqtt from 'mqtt'
const client = mqtt.connect('mqtt://localhost:1883', {
  clientId: 'esp32-panel-XXXXXXXX',
  username: 'esp32-panel-XXXXXXXX',
  password: '<mqttConfigPayload.password>'
})
client.on('connect', () => {
  client.publish(
    'devices/esp32-panel-XXXXXXXX/messages',
    JSON.stringify({
      componentId: 'test-knob',
      eventType: 'adjustment',
      value: 42
    })
  )
})
```

### 4. Confirm the loop closed

```bash
curl http://localhost:7000/debug/state/esp32-panel-XXXXXXXX -H "Authorization: Bearer $TOKEN"
```

should show the stored `StateEntry`, and the server log should show:

```
[echo] esp32-panel-XXXXXXXX/test-knob = 42 -> echoed
```

Subscribing to `devices/esp32-panel-XXXXXXXX/cmd` on the broker (`mosquitto_sub`, or the equivalent of the device's own subscribe-and-log behavior — see the guide's [§0.6](../docs/00-poc-implementation-guide.md#06-esp32-c6-test-device--minimum-firmware-behavior)) shows the Echo Extension's command arriving:

```json
{
  "clientId": "esp32-panel-XXXXXXXX",
  "componentId": "test-knob",
  "action": "echo",
  "value": 42,
  "correlationId": "echo-..."
}
```

This is the full trace from the guide's [§0.7 acceptance checklist](../docs/00-poc-implementation-guide.md#07-end-to-end-acceptance-checklist): **BLE provisioning → MQTT connectivity → state engine → extension hook → command dispatch**, verified. Note: `cmd/result`, `config`, and `status` are part of the wire contract (protocol doc §5) but not yet consumed by this POC's broker — see `src/connectivity/adapters/mqttAdapter.js`.

## MQTT Logins

The dev broker (`scripts/dev-broker.js`) accepts no anonymous clients. Every client logs in and is limited to its own topics (`src/mqttAuth/credentials.js`):

| Client | Username | Password | May use |
|---|---|---|---|
| Core | `core` | `CORE_MQTT_PASSWORD` (.env) | everything |
| Web console (via `/mqtt`) | `console` | `CONSOLE_MQTT_PASSWORD` (.env) | read-only: status, telemetry, log, cmd/result |
| BLE gateway | `GATEWAY_CLIENT_ID` | `GATEWAY_MQTT_PASSWORD` (.env, both sides) | its own `devices/<id>/…` |
| Panels | device id (= client id) | minted at provisioning | their own `devices/<id>/…` |

Device passwords are kept only as salted hashes in `data/mqtt-credentials.json` (git-ignored). A device registered before logins were checked is adopted on its first login: that password is stored and required from then on. To revoke a device, delete its entry there and reprovision it.

## Project Layout

```
scripts/
├── dev-all.js                 # spawns dev-broker.js + src/index.js together, coordinated shutdown
└── dev-broker.js              # disposable pure-JS MQTT broker for local dev (not part of the Core)
src/
├── index.js                  # bootstrap: wires all pillars together
├── identity/verifyToken.js   # stub bearer-token auth (ch.3 stand-in)
├── provisioning/
│   ├── orchestrator.js        # strategy-agnostic session store (ch.4) — also injects
│   │                           #   ctx (state/commands) so self-driving strategies can work
│   ├── strategies/
│   │   ├── bleProtocol.js      # shared UUIDs/payload-minting (PROVISIONING_PROTOCOL_V2.md)
│   │   ├── bleWifi.js          # ble-wifi: app-driven (§2 above)
│   │   └── bleGateway.js       # ble-gateway: server-driven (§2b above)
│   └── routes.js
├── connectivity/              # MQTT adapter + broker (ch.5)
├── state/stateEngine.js      # in-memory state matrix + event bus + subscribe (ch.6)
└── extensions/
    ├── loader.js              # minimal in-process extension loader (ch.7)
    └── echo/                  # permanent diagnostic extension — not POC-only, see below
```

The BLE Gateway Agent itself (`ble-gateway-agent/`) is a sibling package, not part of this one — see [its README](../ble-gateway-agent/README.md). It's a separate client from the Core's perspective, per the repo-separation principle ([Ch. 2](../docs/02-system-topology.md)).

## The Echo Extension Is Permanent

`extensions/echo` is not a placeholder for a future integration — it stays installed indefinitely, including in production, as the fastest way to confirm the core loop (provisioning → connectivity → state → extension hooks) is healthy, independent of any platform-specific extension's own bugs. Future extensions (e.g. Google Home, [Ch. 8](../docs/08-google-home-extension.md)) install _alongside_ it, not in place of it.

## What's Next

See [§0.8 "What to Build Next"](../docs/00-poc-implementation-guide.md#08-what-to-build-next) in the guide for the ordered list of hardening steps (real OAuth2, extension permission enforcement, Redis-backed state, WebSocket adapter, Google Home extension).
