# web-provisioner

Reference provisioning client for [`docs/PROVISIONING_PROTOCOL_V2.md`](../docs/PROVISIONING_PROTOCOL_V2.md): scans the device's on-screen QR code with the camera, derives session keys, and drives the AES-GCM-encrypted BLE handshake over Web Bluetooth — no vendor SDK, no protobuf, zero runtime npm dependencies.

## What's verified vs. not

- **Verified**: the crypto/framing core (`src/protocol.js`) — HKDF-SHA256 key derivation, AES-256-GCM frame encrypt/decrypt, replay rejection, tamper detection, and fragmentation/reassembly — is checked byte-for-bit against the protocol doc's own §10 test vectors, plus replay/tamper/fragmentation cases the doc doesn't give vectors for. Run `npm test`.
- **Not yet verified against real hardware**: the BLE transport (`src/ble.js`) and the full end-to-end flow (`src/app.js`). Per the protocol doc's own status line, **firmware doesn't implement v2 yet** — see its §12. There is nothing to connect to yet. This app is built directly against the wire contract, not against a working device.

This mirrors the same "verified core, honestly-flagged unverified edges" split used elsewhere in this project (see `ble-gateway-agent/README.md`) — don't read "builds and passes its unit tests" as "works against a device."

## Running it

Web Bluetooth and camera access both require a secure context (HTTPS, or `http://localhost`).

```bash
npm run serve   # zero-dependency static server, bound to all interfaces
```

This prints both a `localhost` URL and any LAN URLs the machine has:
```
[web-provisioner]   http://localhost:8080  (this machine)
[web-provisioner]   http://192.168.1.42:8080  (same network, e.g. a phone)
```

Open the `localhost` URL in **Chrome** on this machine, or see "Running on a phone" below to use a LAN URL from another device. Fill in:
1. **Core connection** — the running `core-server-poc`'s URL and `DEV_BEARER_TOKEN` (defaults match the POC's `.env.example`; auto-fills to the page's own host when opened via a LAN URL, since the Core is almost certainly running on the same machine).
2. **Wi-Fi credentials** — what the device should join.
3. **QR scan** — camera scan (needs `BarcodeDetector`, Chrome desktop/Android only) or manual paste of the QR's JSON payload as a fallback.
4. **Start provisioning** — runs the full sequence from `docs/PROVISIONING_PROTOCOL_V2.md` §9.

## Running on a phone

Camera scanning and Web Bluetooth are most useful on a phone, right next to the actual device — but a phone almost never has a physical Bluetooth radio it can hand to a *desktop* browser, and a LAN IP (`http://192.168.x.x:8080`) is **not** automatically a secure context the way `localhost` is, so Chrome will silently refuse camera/Bluetooth access there by default.

Fix, once per phone:
1. Start both `core-server-poc` and this app on your dev machine as usual — both now print their LAN-reachable URLs on startup.
2. On the phone, open **`chrome://flags/#unsafely-treat-insecure-origin-as-secure`**.
3. Add the exact web-provisioner LAN URL your terminal printed (e.g. `http://192.168.1.42:8080`) to the origin list, and restart Chrome when prompted.
4. Open that same URL on the phone. The page will warn you at the top if it isn't running in a secure context — if you still see that warning, double-check the origin you added matches exactly (scheme + host + port).

This is Chrome's own supported mechanism for exercising these APIs against a local dev server without setting up TLS — it only weakens the security-context check for the specific origin(s) you list, not globally.

## How it maps to the Core

This app plays the human-driven companion-app role for the `ble-wifi` provisioning strategy ([`core-server-poc`](../core-server-poc/), [Ch. 4, §4.3.1](../docs/04-device-provisioning.md#431-flow-ble-wifi-app-driven)): it calls `POST /provisioning/sessions` to get a `deviceId` + `mqttConfigPayload` *before* touching BLE, sends that payload to the device once Wi-Fi is confirmed, and calls `POST /provisioning/sessions/:id/payload` to confirm the outcome once MQTT reports connected (or failed).

## Project layout

```
src/
├── protocol.js   # pure crypto/framing core — isomorphic (Web Crypto API + TextEncoder only)
├── ble.js        # Web Bluetooth transport (connect, fragment/send, reassemble/receive)
├── qrScan.js     # camera QR scan via BarcodeDetector, with manual-paste as the fallback path
├── coreClient.js # HTTP client for the Core's provisioning API
├── app.js        # orchestrates the full sequence — DOM-independent, so it's testable in isolation
└── main.js       # DOM wiring for index.html only; no protocol logic lives here
test/
└── protocol.test.mjs   # run with `npm test` — checks against the protocol doc's §10 vectors
scripts/
└── serve.mjs     # zero-dependency static file server for local dev
```

## Known limitations

- **MTU is not queryable.** Web Bluetooth gives the page no way to read the negotiated ATT MTU (unlike the native Android/iOS SDKs), so `fragmentFrame` defaults to a conservative 19-byte payload per fragment. This works everywhere but is chattier than necessary on stacks that negotiate a larger MTU — safe to tune up once the actual negotiated size is known for a target platform.
- **No BLE bonding.** Per protocol §3, this is deliberate — all confidentiality comes from the application-layer AES-GCM, not the link layer.
- **Firmware not ready** — see "What's verified vs. not" above.
