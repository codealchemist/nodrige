# ble-gateway-agent

Reference implementation of the **BLE Gateway Agent** referenced by `core-server-poc`'s `ble-gateway` provisioning strategy — drives [`docs/PROVISIONING_PROTOCOL_V2.md`](../docs/PROVISIONING_PROTOCOL_V2.md) against a real device on the Core's behalf.

## What this is

The Core Server never speaks BLE — it's cloud-deployable and has no physical radio. This agent is the thing that does: a small, always-on local process with a real Bluetooth adapter, running near the devices it provisions. It connects to the same MQTT broker the Core uses, as an ordinary client (`devices/<GATEWAY_CLIENT_ID>/cmd` / `/messages`). The Core commands it the same way it commands anything else on the Connectivity Broker; no Core-side code needed to know this agent is "special."

Flow: Core sends `{action: "provision", value: sessionId}` → this agent fetches the full session details over HTTPS → **waits for an operator to relay the device's scanned QR code** (see below) → connects and drives the v2 handshake → reports `{eventType: "provisioning_result", value: sessionId, metadata: {outcome, deviceId|reason}}` back over MQTT.

## Why an operator is still involved

Provisioning Protocol v2's entire security model is physical possession of the device's on-screen QR code (protocol doc §1, §11) — whoever can see that screen is authorized. This agent has no camera and cannot see the device's screen, so it cannot obtain the QR itself. Automating the BLE handshake does not remove that requirement; it only removes the need for the operator to run a full companion-app UI.

In practice: an operator scans the QR with *any* reader (a phone's camera app is enough), then relays the decoded JSON to this agent's local-only input endpoint:

```bash
curl -X POST http://localhost:4001/qr \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"<the session id printed in this agent'\''s log>","qrJson":"{\"ver\":\"v2\",\"name\":\"PROV_A1B2C3\",\"mac\":\"...\",\"token\":\"...\"}"}'
```

The agent logs the exact `sessionId` and a ready-to-fill curl command as soon as it receives a `provision` command, so this isn't guesswork in practice.

## What's real vs. verified vs. unverified

- **Real and verified**: the crypto/framing core (`src/protocol.js`, identical to `web-provisioner`'s) — HKDF-SHA256, AES-256-GCM frame encrypt/decrypt, replay rejection, tamper detection, fragmentation — checked against the protocol doc's own test vectors. Run `npm test`.
- **Real, structurally complete, unverified against hardware**: the noble-based BLE transport and full handshake driver (`src/bleClient.js`) — scanning, connect, RX/TX characteristic writes/notifications, the HELLO → WIFI_CREDS → MQTT_CONFIG sequence. Per the protocol doc's own status line, **firmware doesn't implement v2 yet** (see its §12) — there's nothing to connect to yet, so this hasn't been run against a real device.

## Requirements

- A real Bluetooth adapter on the host (Linux + BlueZ is `noble`'s best-supported target).
- `@abandonware/noble` needs native build tooling to install (`build-essential`, `libbluetooth-dev` on Debian/Ubuntu) — expect `npm install` to fail on a machine without those, or without a BLE adapter attached. That's expected; this package isn't meant to run in a typical CI/cloud sandbox.
- The Core server (`core-server-poc`) and an MQTT broker reachable from this agent.

## Setup

```bash
npm install
cp .env.example .env   # set CORE_BEARER_TOKEN to match the Core's DEV_BEARER_TOKEN,
                        # and TEST_WIFI_SSID/PASSWORD for your bench network
npm start
```

On success:
```
[gateway] QR input endpoint listening on http://localhost:4001/qr
[gateway] connected to mqtt://localhost:1883 as ble-gateway-01
```

It then sits idle until the Core dispatches a `provision` command — which happens automatically whenever a `POST /provisioning/sessions {"strategyId":"ble-gateway"}` request is made against the Core. At that point it logs a `curl` command; scan the device's QR and run it.

## Project layout

```
src/
├── index.js       # MQTT command handling, orchestrates the whole flow
├── qrInput.js      # local HTTP endpoint an operator relays the scanned QR through
├── bleClient.js    # noble-based BLE transport + protocol driver
├── coreClient.js   # fetches session details from the Core over HTTP
└── protocol.js     # crypto/framing core — copy of web-provisioner's, verified independently
test/
└── protocol.test.mjs   # run with `npm test`
```
