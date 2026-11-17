# Provisioning Client — Implementation Guide

> **Superseded.** Replaced by [`PROVISIONING_PROTOCOL_V2.md`](PROVISIONING_PROTOCOL_V2.md) —
> token + AES-GCM, no Espressif SDK dependency. Kept for history; do not
> build new clients against this document. `web-provisioner/` and
> `ble-gateway-agent/` are both built against v2, not this guide.

**Audience:** whoever builds the client that scans the device's QR code and
walks it through provisioning.

**Scope:** what the firmware _currently implements_, as of the POC. Where
this disagrees with
[BLE_PROVISIONING_PROTOCOL.md](BLE_PROVISIONING_PROTOCOL.md), that document
is the intended long-term contract and **this one is what's on the device
today** — see §7.

---

## 1. Don't hand-roll the transport

The device runs ESP-IDF's stock `network_provisioning` + `protocomm` over
BLE. The handshake is SRP6a over a 3072-bit group with SHA-512, wrapped in
protobuf framing, with AES-GCM session encryption afterwards.

**Use Espressif's client SDK.** Reimplementing that by hand is a large lift
for zero benefit:

| Platform             | Library                                |
| -------------------- | -------------------------------------- |
| Android              | `esp-idf-provisioning-android`         |
| iOS                  | `esp-idf-provisioning-ios`             |
| Python / server-side | `esp_prov` (ESP-IDF `tools/esp_prov/`) |

Everything project-specific is in §4–§5. Everything else is stock and the
SDK already does it.

---

## 2. The QR payload

Rendered on the device screen. Raw JSON, one line:

```json
{
  "ver": "v1",
  "name": "PROV_A1B2C3",
  "username": "K7M2QRXW9P",
  "password": "R4TDNVK8ZLQ3HXBC7MFW",
  "transport": "ble"
}
```

| Field       | Use                                                                 |
| ----------- | ------------------------------------------------------------------- |
| `ver`       | Payload schema version. Reject anything you don't know.             |
| `name`      | BLE advertised device name. Match on this to pick the right device. |
| `username`  | SRP6a identity for the handshake.                                   |
| `password`  | SRP6a password for the handshake.                                   |
| `transport` | Always `"ble"` today.                                               |

**These credentials are single-use.** The device generates a fresh
username/password pair every time it enters provisioning mode, so a QR
captured from a photo or an old screenshot is useless. Never cache them,
and never try to reconnect with a previous session's pair.

---

## 3. Connecting

- **Advertised name:** `PROV_<last 3 MAC bytes>`, e.g. `PROV_A1B2C3` —
  matches the QR's `name`.
- **Service UUID:** ESP-IDF default,
  `0000ffff-0000-1000-8000-00805f9b34fb`. The firmware does **not** call
  `network_prov_scheme_ble_set_service_uuid()`. See §7.
- **Characteristic UUIDs:** assigned automatically by the BLE scheme. Do
  **not** hardcode them — address endpoints by _name_ through the SDK,
  which handles the mapping.
- **Security:** protocomm Security2. Feed the SDK the QR's `username` and
  `password`; it runs the handshake on `prov-session`.

The device stays in provisioning mode for **3 minutes**, then gives up and
tears down BLE. Budget the whole flow inside that window.

---

## 4. Sequence

Order is enforced by the firmware, not merely recommended.

1. Scan the QR → `name`, `username`, `password`.
2. BLE connect, discover the service, complete the Security2 handshake.
3. Send Wi-Fi credentials to **`prov-config`** (stock endpoint). Poll its
   `GetStatus` until `Connected` or `Failed`.
4. **Only after Wi-Fi reports `Connected`**, send `mqtt-config` (§5).
   Sending it earlier returns `wifi not connected yet` and is discarded.
5. Poll `mqtt-status` (§6) until `connected` or `failed`.

`prov-scan` (stock AP scan) is available if you want to offer a network
picker; it's optional.

---

## 5. `mqtt-config` — custom endpoint

Request. All fields required except `password`:

```json
{
  "provisioningProtocolVersion": 1,
  "brokerHost": "mqtt.example.com",
  "brokerPort": 8883,
  "useTls": true,
  "clientId": "device-a1b2c3",
  "username": "mqtt-user",
  "password": "mqtt-pass",
  "topics": {
    "commands": "dev/a1b2c3/cmd",
    "commandResults": "dev/a1b2c3/cmd/result",
    "messages": "dev/a1b2c3/msg",
    "config": "dev/a1b2c3/config",
    "status": "dev/a1b2c3/status"
  }
}
```

Synchronous response — one of:

```json
{"status": "received"}
{"status": "error", "message": "malformed payload"}
{"status": "error", "message": "wifi not connected yet"}
{"status": "error", "message": "protocol version mismatch", "deviceVersion": 1}
```

`received` means accepted and the MQTT connection attempt has started — it
is **not** a success signal. Poll `mqtt-status` for the outcome.

On `protocol version mismatch`, `deviceVersion` tells you what the firmware
speaks. Bump `provisioningProtocolVersion` only for wire-breaking changes;
added fields the other side can ignore don't need one.

---

## 6. `mqtt-status` — custom endpoint, polled

Send any payload (contents ignored). Response:

```json
{"state": "connecting"}
{"state": "connected"}
{"state": "failed", "reason": "unreachable"}
```

Poll until `connected` or `failed` — **both are terminal**. Make sure your
loop exits on `failed`, not just on the happy path. `reason` is a
human-readable string for display; don't branch on its exact text.

---

## 7. Known deltas vs. BLE_PROVISIONING_PROTOCOL.md

The contract doc was written before the firmware existed. Two things in it
do not match the device today — build against **this** file:

1. **Service UUID.** The contract freezes
   `38db8dff-2b5f-44ff-91ed-ec43645bbd81`. The firmware never sets it, so
   the device actually advertises the ESP-IDF default
   `0000ffff-0000-1000-8000-00805f9b34fb`. A client built against the
   contract's value will not find the device.
2. **Characteristic UUID table.** The contract lists fixed per-endpoint
   UUIDs. The firmware doesn't install that lookup table; the BLE scheme
   assigns UUIDs itself. Address endpoints by name.

Both are firmware-side omissions rather than deliberate changes. If the
firmware later sets the frozen UUIDs, that's a breaking change for any
client already shipped against the defaults — **agree the direction before
either side ships**.

The firmware also uses ESP-IDF's newer `network_provisioning` component
rather than the deprecated `wifi_provisioning`. The wire protocol is
unchanged, but pick client SDK versions that are current enough to match.

---

## 8. Security notes for the client author

- **The password is out-of-band by design** — it travels screen → camera,
  never over the radio. Don't log it, don't transmit it, don't persist it.
- **The SRP6a handshake authenticates both directions.** If it fails,
  abort — do not fall back to an unsecured mode. There isn't one, and a
  failure means either a stale QR or the wrong device.
- **MQTT credentials you send are stored in plaintext on the device** (no
  NVS encryption) and are used against a TLS endpoint whose **certificate
  is not currently verified**. Until that's fixed, treat any broker
  credentials handed to a device as compromised-on-physical-access, and
  prefer per-device credentials you can revoke individually over a shared
  account.
