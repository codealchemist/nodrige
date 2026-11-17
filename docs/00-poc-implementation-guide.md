# 0. POC Implementation Guide — Walking Skeleton

[Back to index](./README.md) | Full architecture starts at: [1. Overview →](./01-overview.md)

---

## 0.1 Purpose

This is a **build guide**, not an architecture reference. It specifies the smallest slice of the full manual ([Ch. 1–11](./README.md)) that stands up end-to-end and proves the core loop works:

> **BLE-provision an ESP32-C6 → device connects over MQTT → telemetry flows through the State Engine → an installed extension reacts and dispatches a command back.**

Every shortcut taken here is taken **against the same interfaces** the full manual defines, so hardening a piece later (swap the stub auth for the real OAuth2 engine, swap in-memory state for Redis, add a WebSocket adapter) means replacing an implementation behind an interface — never rewriting a caller. Where a POC piece cuts a corner, this doc says so explicitly and names the chapter that defines the eventual replacement.

## 0.2 Scope Cuts (and Where They're Reversed Later)

| Full manual | POC substitute | Reversed in |
|---|---|---|
| OAuth2 provider engine ([Ch. 3](./03-authentication-identity.md)) | Single static bearer token from env var, exposed behind the same `verifyToken()` shape | Post-POC: real `/oauth2/*` routes, same interface |
| Other provisioning strategies ([Ch. 4](./04-device-provisioning.md)) | Two: `ble-wifi` (app-driven) and `ble-gateway` (server-driven, §0.4 Step 6b), both implementing the real `ProvisioningStrategy` interface against the actual firmware wire contract ([`PROVISIONING_PROTOCOL_V2.md`](./PROVISIONING_PROTOCOL_V2.md), not a placeholder) | Add `soft-ap`, `qr-cloud-claim`, etc. as new strategy modules |
| Multiple transport adapters ([Ch. 5](./05-connectivity-broker.md)) | MQTT adapter only, implementing the real `TransportAdapter` interface | Add WebSocket adapter later without touching MQTT code |
| Redis/Postgres-backed state, multi-instance ([Ch. 6](./06-state-engine.md)) | In-process `Map`, same `StateQuery` interface | Swap store implementation behind `StateQuery` |
| Full extension lifecycle, permissions, circuit breakers, worker isolation ([Ch. 7](./07-extension-engine.md), [Ch. 10](./10-concurrency-strategy.md)) | In-process loader that calls `onEnable` / `onStateChanged` on startup; no permission enforcement, no timeouts | Add manifest permission checks, circuit breaker, worker-thread mode |

Nothing in this table changes the wire protocol or the extension contract — it only changes what's *behind* them.

Note: the **Echo Extension** (§0.5) is not a scope cut and has no "reversed in" entry — it's a minimal, permanent diagnostic extension proving the hook surface works. It stays installed after the POC, including in production, as a lightweight system-test tool. The Google Home extension ([Ch. 8](./08-google-home-extension.md)) is a separate, additional extension built later — it is installed *alongside* Echo, not in place of it.

## 0.3 Project Scaffold

```
core-server-poc/
├── package.json
├── .env                          # DEV_BEARER_TOKEN, MQTT_URL
├── src/
│   ├── index.js                  # bootstrap: wires all pillars together
│   ├── identity/
│   │   └── verifyToken.js        # stub: checks Authorization header against DEV_BEARER_TOKEN
│   ├── provisioning/
│   │   ├── types.js              # ProvisioningStrategy / ProvisioningSession shapes
│   │   ├── orchestrator.js       # generic session store + HTTP routes
│   │   └── strategies/bleWifi.js # the one strategy the POC ships
│   ├── connectivity/
│   │   ├── types.js              # TransportAdapter / CoreEvent / CoreCommand shapes
│   │   ├── broker.js             # normalizer + command router
│   │   └── adapters/mqttAdapter.js
│   ├── state/
│   │   └── stateEngine.js        # in-memory StateQuery implementation + event emitter
│   └── extensions/
│       ├── loader.js             # minimal CoreExtension loader
│       └── echo/index.js         # the Echo Extension (§0.5)
└── test/
    └── e2e-manual-checklist.md   # §0.7, copy this into the repo as-is
```

Dependencies: `express` (HTTP), `mqtt` (npm client), `dotenv`. No database required for the POC.

## 0.4 Build Order

Build and manually verify each step before moving to the next — each step is independently testable.

### Step 1 — Bootstrap + stub identity
`GET /health` returns 200. Every other route requires `Authorization: Bearer <DEV_BEARER_TOKEN>`, checked by `identity/verifyToken.js`:

```js
// src/identity/verifyToken.js
export function verifyToken(authHeader) {
  const token = authHeader?.replace(/^Bearer\s+/i, "");
  if (token && token === process.env.DEV_BEARER_TOKEN) {
    return { sub: "poc-user", scope: ["*"] };   // same TokenClaims shape ch.7's ctx.identity uses
  }
  return null;
}
```

### Step 2 — State Engine
```js
// src/state/stateEngine.js
import { EventEmitter } from "node:events";

const store = new Map();               // key: `${clientId}::${componentId}`
export const stateBus = new EventEmitter();

export const stateEngine = {
  upsert(event) {
    const key = `${event.clientId}::${event.componentId}`;
    const previous = store.get(key);
    const entry = { ...event, updatedAt: new Date().toISOString() };
    store.set(key, entry);
    const changed = !previous || previous.value !== event.value;
    stateBus.emit(changed ? "state.changed" : "state.heartbeat", {
      ...entry, previousValue: previous?.value ?? null,
    });
  },
  get(clientId, componentId) {
    return store.get(`${clientId}::${componentId}`) ?? null;
  },
  getAllForClient(clientId) {
    return [...store.values()].filter(e => e.clientId === clientId);
  },
};
```
This is a direct, minimal implementation of the `StateQuery` + update-model pair from [Ch. 6](./06-state-engine.md#65-query-api) — same method names, same event topic names, so extension code written against it does not change when the store gets swapped for Redis.

### Step 3 — MQTT adapter + broker
```js
// src/connectivity/adapters/mqttAdapter.js
import mqtt from "mqtt";

export function createMqttAdapter({ url, onInbound }) {
  const client = mqtt.connect(url);
  // Topic names come from docs/PROVISIONING_PROTOCOL_V2.md §7 — the same
  // topics provisioning (ble-wifi strategy) hands the device via mqtt-config.
  client.on("connect", () => client.subscribe("devices/+/messages"));
  client.on("message", (topic, payload) => {
    const clientId = topic.split("/")[1];
    onInbound({ clientId, topic, payload, receivedAt: new Date().toISOString() });
  });
  return {
    id: "mqtt",
    sendOutbound: ({ clientId, payload }) =>
      new Promise((resolve, reject) =>
        client.publish(`devices/${clientId}/cmd`, payload, err => err ? reject(err) : resolve())
      ),
  };
}
```

```js
// src/connectivity/broker.js
import { stateEngine } from "../state/stateEngine.js";

export function normalizeInbound(msg) {
  const body = JSON.parse(msg.payload.toString());   // { componentId, eventType, value }
  return { clientId: msg.clientId, ...body, timestamp: msg.receivedAt };
}

export function wireBroker(adapter) {
  return {
    onDeviceMessage: (msg) => stateEngine.upsert(normalizeInbound(msg)),
    dispatchCommand: (cmd) =>
      adapter.sendOutbound({ clientId: cmd.clientId, payload: Buffer.from(JSON.stringify(cmd)) }),
  };
}
```
This mirrors [Ch. 5, §5.3–5.4](./05-connectivity-broker.md#53-normalization-wire-payload--internal-event) exactly (`CoreEvent` in, `CoreCommand` out) with one adapter instead of the adapter registry the full manual describes.

### Step 4 — Extension loader
```js
// src/extensions/loader.js
import { stateBus } from "../state/stateEngine.js";

export function loadExtension(extension, ctx) {
  extension.onEnable?.(ctx);
  stateBus.on("state.changed", (event) => {
    Promise.resolve(extension.onStateChanged?.(event, ctx)).catch(err =>
      console.error(`[${extension.manifest.id}] onStateChanged error`, err)
    );
  });
}
```
No permission checks, no timeouts, no circuit breaker — this is the piece [Ch. 10](./10-concurrency-strategy.md) hardens later. It is enough to prove the hook contract from [Ch. 7, §7.4](./07-extension-engine.md#74-the-coreextension-interface) works.

### Step 5 — Wire it together
```js
// src/index.js
import { createMqttAdapter } from "./connectivity/adapters/mqttAdapter.js";
import { wireBroker } from "./connectivity/broker.js";
import { loadExtension } from "./extensions/loader.js";
import { stateEngine } from "./state/stateEngine.js";
import echoExtension from "./extensions/echo/index.js";

const adapter = createMqttAdapter({
  url: process.env.MQTT_URL,
  onInbound: (msg) => broker.onDeviceMessage(msg),
});
const broker = wireBroker(adapter);

loadExtension(echoExtension, {
  state: stateEngine,
  commands: { dispatch: broker.dispatchCommand },
  logger: console,
});
```

### Step 6 — BLE provisioning orchestrator (`ble-wifi` strategy)
Implement only the four routes from [Ch. 4, §4.2](./04-device-provisioning.md#42-provisioning-strategy-abstraction) (`POST /provisioning/sessions`, `POST /provisioning/sessions/:id/payload`, `GET /provisioning/sessions/:id`, `DELETE /provisioning/sessions/:id`), backed by an in-memory session map. The wire-level contract this strategy hands off to the companion app is **not** improvised — it's specified in [`PROVISIONING_PROTOCOL_V2.md`](./PROVISIONING_PROTOCOL_V2.md), the frozen firmware⇄app contract (token + AES-GCM, not Espressif's protocomm — see that doc's §1 for why). Two things follow from that document that don't match a naive "device submits attestation" design:

1. **The Core mints the device identity and MQTT broker credentials up front**, in `beginSession` — not after the fact in `submitPayload`. The app needs `clientId`/`username`/`password`/`brokerHost`/`brokerPort`/`topics` (protocol §7) *before* it can encrypt and send them as `MQTT_CONFIG`, so the Core has to hand all of that back as part of `clientInstructions`. The BLE session token itself is **not** something the Core mints or sees — it's generated on-device and travels only via the on-screen QR code (protocol §4, §8).
2. **`submitPayload` becomes a completion confirmation, not an attestation submission.** The app does the entire BLE handshake (HKDF key derivation, HELLO, Wi-Fi credentials, MQTT config, `MQTT_STATUS` polling — protocol §9) directly against the firmware with no Core involvement in between; it only calls the Core again afterward to report `{"status": "connected"}` or `{"status": "failed", "reason": "..."}` so the session record reflects the outcome. The Connectivity Broker's own presence tracking ([Ch. 5, §5.5](./05-connectivity-broker.md#55-connection-lifecycle--presence)) remains the authoritative source for whether the device is actually online — this confirmation is bookkeeping, not proof.

Service/RX/TX UUIDs, the `MQTT_CONFIG` JSON shape, and the topic names (`devices/<id>/cmd`, `/cmd/result`, `/messages`, `/config`, `/status`) all come directly from the protocol doc — copy them verbatim rather than inventing placeholders, and update both this strategy and the Connectivity Broker's topic subscriptions ([Ch. 5, §5.2](./05-connectivity-broker.md#52-transport-adapter-abstraction)) together, since a device provisioned with one topic scheme and a broker listening on another is a silent dead end.

**Don't hand-roll the crypto without checking it first.** The protocol doc ships §10 test vectors specifically so an implementation can be proven byte-correct against HKDF-SHA256 + AES-256-GCM before it ever touches a radio — `web-provisioner/test/protocol.test.mjs` does exactly this. Verify against those vectors before writing a single line of BLE code; getting the framing right first makes every BLE bug unambiguously a BLE bug, not a crypto bug wearing a BLE costume.

The reference companion app is `web-provisioner/` (camera QR scan + Web Bluetooth, zero runtime dependencies — Web Crypto API covers HKDF and AES-GCM natively, so no crypto library is needed either). `curl` can still stand in for the HTTP leg alone (`beginSession` / the completion confirmation) if you're testing just that part — it has no Bluetooth stack and can't touch the BLE leg.

#### Step 6b — Server-driven alternative (`ble-gateway` strategy)

`ble-wifi` above needs a human operating an app for every device. `ble-gateway` ([Ch. 4, §4.3.4](./04-device-provisioning.md#434-flow-ble-gateway-server-driven)) instead has the Core command a **BLE Gateway Agent** (reference implementation: `ble-gateway-agent/`, a sibling package to `core-server-poc/`) that connects to the Core over ordinary MQTT like any device, receives a `{action: "provision", value: sessionId}` command, fetches the session's `clientInstructions` over HTTP, drives the same protocol itself, and reports the result back over MQTT. No `submitPayload` call is needed on the happy path — the session resolves itself once the agent's report arrives.

Two POC-scoped pieces make this work without changing the broker or the State Engine's documented shapes:
- The command carries only the `sessionId` (a scalar — `CoreCommand.value` doesn't carry structured data); the agent fetches the rest via `GET /provisioning/sessions/:id`, so that route needs to return `clientInstructions`, not just status.
- The report's `value` is the `sessionId` itself, with the actual outcome in `metadata` — putting the outcome in `value` would make two consecutive same-outcome reports collide under the State Engine's change-detection and get silently dropped to a heartbeat.

**The agent still needs a human for one step, and this is by design, not a gap:** the protocol's entire security model is physical possession of the device's QR code (protocol §1, §11). A headless gateway agent has no camera, so it can't scan the QR itself — `ble-gateway-agent/src/qrInput.js` exposes a tiny local endpoint an operator posts the scanned QR JSON to, once per device, after scanning it with any reader. "Server-driven" means the BLE handshake is automated, not that proof-of-possession is skipped.

Since standing up real BLE hardware isn't always possible while iterating, verify the Core↔agent control plane with a stand-in for the agent's BLE work: a small script that connects to the broker as the gateway's `clientId`, subscribes to its `cmd` topic, and on receiving `provision`, fetches the session and immediately publishes a `provisioning_result` report — proving the Core-side dispatch/listen/resolve wiring end-to-end without needing a real device, radio, or QR. Swap in the real `ble-gateway-agent` once hardware is available; nothing on the Core side changes.

## 0.5 The Echo Extension

Purpose: prove the full hook contract (`onEnable`, `onStateChanged`, `commands.dispatch`) with zero external dependencies. Behavior: whenever any device's state changes, immediately dispatch a command back to that same device echoing the value, tagged so it's visually distinguishable from the original telemetry.

```js
// src/extensions/echo/index.js
export default {
  manifest: {
    id: "echo",
    version: "0.1.0",
    displayName: "Echo Extension",
    permissions: { stateRead: true, commandDispatch: true },
    entryPoint: "src/extensions/echo/index.js",
  },

  async onEnable(ctx) {
    ctx.logger.log("[echo] enabled");
  },

  async onStateChanged(event, ctx) {
    await ctx.commands.dispatch({
      clientId: event.clientId,
      componentId: event.componentId,
      action: "echo",
      value: event.value,
      correlationId: `echo-${Date.now()}`,
    });
    ctx.logger.log(`[echo] ${event.clientId}/${event.componentId} = ${event.value} -> echoed`);
  },
};
```

This is the exact `CoreExtension` shape used by the [example logger](./07-extension-engine.md#741-minimal-example) and the [Google Home extension](./08-google-home-extension.md#86-manifest) — installing Google Home later is a matter of adding a second package to the loader, not modifying or removing Echo. Both run side by side under the same extension engine, exactly as [Ch. 7](./07-extension-engine.md) intends for any number of installed extensions.

## 0.6 ESP32-C6 Test Device — Minimum Firmware Behavior

Firmware lives in its own repository ([Ch. 2](./02-system-topology.md)) and implements [`PROVISIONING_PROTOCOL_V2.md`](./PROVISIONING_PROTOCOL_V2.md) as its side of the BLE contract; **that document's own §12 lists this as not yet implemented** — the checklist below is what the firmware needs to do once it is, not a claim that a real device currently behaves this way.

1. On entering provisioning mode: generate a fresh 32-byte token (protocol §4), render the QR (protocol §8, includes the token + device MAC + advertised name), and advertise as `PROV_<MAC suffix>` with the fixed service/RX/TX UUIDs (protocol §3).
2. Accept the encrypted `HELLO` frame on RX, verify its AES-GCM tag using keys derived the same way the app derives them (HKDF-SHA256, protocol §4) — a valid tag *is* the authentication step (protocol §7). Reply `HELLO_ACK` on TX.
3. Accept `WIFI_CREDS`, apply directly via the platform Wi-Fi API (not a stock provisioning component — protocol §12 item 5), and emit `WIFI_STATUS` (`connecting` → `connected`/`failed`) as it progresses.
4. **Only after** Wi-Fi reports `connected`, accept `MQTT_CONFIG` (`brokerHost`/`brokerPort`/`useTls`/`clientId`/`username`/`password`/`topics`) and store it. Sent earlier, reply `ERROR`/`wifi_not_connected` and discard it (protocol §9 step 8).
5. Connect to the MQTT broker using the stored credentials; emit `MQTT_STATUS` (`connecting` → `connected`/`failed`) as the app polls.
6. Once connected, publish one test telemetry message every few seconds to the `messages` topic from the config it was given (`devices/{deviceId}/messages`):
   ```json
   { "componentId": "test-knob", "eventType": "adjustment", "value": 42 }
   ```
7. Subscribe to the `commands` topic (`devices/{deviceId}/cmd`) and log whatever arrives — this is where the Echo Extension's response should appear.

If flashing real firmware isn't ready yet, simulate the device with `mosquitto_pub`/`mosquitto_sub` from a dev machine, using a `deviceId` and MQTT credentials taken from a real `beginSession` response — the Core cannot tell the difference, which is itself a validation of hardware-agnosticism ([Ch. 1, §1.2, P1](./01-overview.md#12-design-principles)). This sidesteps only the BLE leg, not the topic/payload contract — telemetry still has to land on the exact `messages` topic the provisioning step handed out.

## 0.7 End-to-End Acceptance Checklist

Copy this into `test/e2e-manual-checklist.md` and check off against a running POC:

- [ ] `GET /health` → 200 without auth
- [ ] Any other route without a valid bearer token → 401
- [ ] `POST /provisioning/sessions {strategyId: "ble-wifi"}` → returns a session with `clientInstructions` containing the protocol's BLE UUIDs and a full `mqttConfigPayload` (broker host/port, credentials, topics)
- [ ] Submitting a completion confirmation (`{"status":"connected"}`) → returns `status: "success"`, the same `deviceId`, and a `deviceCredential`
- [ ] Test device (real or simulated via `mosquitto_pub`) publishes to `devices/{deviceId}/messages` → process logs show the MQTT adapter received it
- [ ] State Engine reflects the new value: add a temporary `GET /debug/state/:clientId` route for the POC only, and confirm the value appears
- [ ] Echo Extension log line appears (`[echo] ... -> echoed`) within one event-loop tick of the telemetry arriving
- [ ] `mosquitto_sub -t devices/{deviceId}/cmd` (or the real device's serial log) shows the echoed command with `action: "echo"` and the same value
- [ ] Restarting the Core process does not crash on a device reconnecting with a previously issued `deviceCredential`

If all boxes check, the walking skeleton is proven: **BLE provisioning → MQTT connectivity → state engine → extension hook → command dispatch**, the identical path the full manual's [Ch. 9 worked trace](./09-event-driven-data-flow.md) describes for the Google Home extension.

## 0.8 What to Build Next

Once the POC checklist passes, the natural next increments — each swaps one POC substitute from the table in [§0.2](#02-scope-cuts-and-where-theyre-reversed-later) for its real counterpart, one at a time, without touching the others:

1. Replace stub identity with the real OAuth2 provider engine ([Ch. 3](./03-authentication-identity.md)).
2. Add extension manifest permission enforcement + circuit breaker ([Ch. 7](./07-extension-engine.md), [Ch. 10](./10-concurrency-strategy.md)).
3. Move state store to Redis for multi-instance readiness ([Ch. 6, §6.3](./06-state-engine.md#63-persistence--scaling)).
4. Add the WebSocket transport adapter ([Ch. 5, §5.2](./05-connectivity-broker.md#52-transport-adapter-abstraction)).
5. Install the Google Home extension ([Ch. 8](./08-google-home-extension.md)) alongside Echo — a second, independent extension, not a replacement for it. Keep Echo installed: it remains the fastest way to confirm the core loop (provisioning → connectivity → state → extension hooks) is healthy, independent of any platform-specific extension's own bugs or outages.

---

[Back to index](./README.md) | Full architecture starts at: [1. Overview →](./01-overview.md)
