# BLE Provisioning Protocol — Firmware ⇄ Companion App Contract

> **Superseded.** Replaced by [`PROVISIONING_PROTOCOL_V2.md`](PROVISIONING_PROTOCOL_V2.md) —
> token + AES-GCM instead of protocomm Security2 (SRP6a). Kept for history;
> do not build new clients against this document. See also
> [`PROVISIONING_CLIENT_GUIDE.md`](PROVISIONING_CLIENT_GUIDE.md), which
> describes what firmware actually ran under this v1 contract.

## 1. Purpose & audience

This is the interface contract between the ESP32-C6 firmware's BLE
provisioning service and the companion app being built in parallel, as
separate codebases. Both sides implement against **this document**, not
against each other's source — that's the point of writing it down. If
either side needs to change something here, both sides update in lockstep,
gated by the version field in §8.

This document is narrower in scope than the firmware repo's own internal
design docs, which cover the _firmware-side_ provisioning flow (state
machine, NVS, teardown, etc.). This document covers only the wire-level
contract a second, independent implementation needs.

"Companion app" throughout this document means whatever implements the
app-side GATT operations — this protocol doesn't care whether that's a
human operating a phone/browser UI, or an automated local agent commanded
remotely (e.g. a BLE Gateway Agent taking instructions from the Core server
instead of a person). The bytes on the wire are identical either way; only
where the session credentials (§3) come from differs — a human reads them
off the device's QR code, an automated agent needs them supplied to it by
whoever has physical access to the device.

## 2. Transport & identity

- ESP-IDF's `protocomm` component in BLE mode (`protocomm_ble`) — standard
  GATT, one primary service, one characteristic per registered endpoint.
- Advertised device name: `PROV_<suffix>`, where `<suffix>` is the last 3
  bytes of the device's MAC in hex (e.g. `PROV_A1B2C3`) — lets multiple
  in-range devices be told apart.
- **Service UUID**: `38db8dff-2b5f-44ff-91ed-ec43645bbd81` — frozen here
  rather than left as a placeholder, since an ambiguous "TBD, derive it
  somehow" is worse than a concrete value either side can start coding
  against today. Change it only with a version bump (§8) if it ever turns
  out to collide with something.
- **Endpoint name → characteristic UUID table** — `protocomm_ble` requires
  an explicit `{name, uuid}` lookup table; nothing here is auto-derived
  from the endpoint name string, so this table _is_ the contract for
  "which characteristic is which":

  | Endpoint name  | Characteristic UUID                    | Defined by                                               |
  | -------------- | -------------------------------------- | -------------------------------------------------------- |
  | `prov-session` | `cfd659e2-1713-48bf-9763-0bf27151526d` | protocomm standard (security handshake)                  |
  | `prov-config`  | `1477956c-70b9-418d-af78-af806601eb21` | `wifi_provisioning` standard (Wi-Fi credentials)         |
  | `prov-scan`    | `5d2d2af2-5daf-4bd7-b815-26661f1323a1` | `wifi_provisioning` standard (optional AP scan — see §4) |
  | `mqtt-config`  | `92b9008d-6843-462c-a328-c95b9eceec1d` | custom, §5                                               |
  | `mqtt-status`  | `6dbb6263-fb2d-48b2-a9b9-8f40093e95c5` | custom, §6                                               |

## 3. Security

- **protocomm Security2 (SRP6a)**, ESP-IDF's `protocomm_security2`, used
  unmodified — no protocol customization on top of it.
- Session negotiated over the `prov-session` endpoint per protocomm's
  standard sec2 handshake (`session.proto`/`sec2.proto` from the ESP-IDF
  source — both sides implement against those directly, not a
  reinterpretation of them here).
- Credentials for a given session: a random username+password pair,
  generated fresh by the device every time provisioning mode is entered,
  shown as a QR code on the device screen.
- **QR code payload** (device renders it, app scans/parses it):
  ```json
  {
    "ver": "v1",
    "name": "PROV_A1B2C3",
    "username": "<session-username>",
    "password": "<session-password>",
    "transport": "ble"
  }
  ```
  Flagging this explicitly: Espressif's own tooling documents a QR shape
  for Security1 (a single `pop` field); Security2 needs username+password
  instead, and there isn't a single fixed Espressif standard for that
  shape. The JSON above is what this project defines — **confirm this
  exact field set with whoever's building the app before relying on it**,
  since it's the one part of this contract that isn't just "point at
  ESP-IDF's docs."

## 4. Standard Wi-Fi provisioning endpoints (unmodified)

`prov-config` (and optionally `prov-scan`, if the app wants to offer a
network picker instead of manual SSID entry) are `wifi_provisioning`'s own
endpoints, using its published `wifi_config.proto`/`wifi_scan.proto`
schemas exactly as-is. Nothing about them is redefined here — that's
deliberate: implement directly against the ESP-IDF component's own
documentation/source for this part, so there's only one place (this
document) covering the parts that are actually ours to get wrong.

The app polls `prov-config`'s standard `GetStatus` message after applying
credentials until it reports `Connected` or `Failed` — §6 mirrors this
exact pattern for MQTT so the app only has to implement one polling shape
for both legs, not two different ones.

## 5. Custom endpoint: `mqtt-config`

The one endpoint that's genuinely ours to define.

- **Wire format: plain JSON, not protobuf.** Deliberate choice — protobuf
  would require both codebases to generate matching code from a shared
  `.proto` file, an extra toolchain-coordination step neither side needs
  for one small payload. `protocomm` doesn't require protobuf for custom
  endpoints (Espressif's own endpoints use it by convention, not by
  requirement); JSON is simpler here, and ArduinoJson is already a
  firmware dependency.
- **Request (app → device):**
  ```json
  {
    "provisioningProtocolVersion": 1,
    "brokerHost": "192.168.1.50",
    "brokerPort": 8883,
    "useTls": true,
    "clientId": "esp32-panel-01",
    "username": "esp32-panel-01",
    "password": "s3cret",
    "topics": {
      "commands": "devices/esp32-panel-01/cmd",
      "commandResults": "devices/esp32-panel-01/cmd/result",
      "messages": "devices/esp32-panel-01/messages",
      "config": "devices/esp32-panel-01/config",
      "status": "devices/esp32-panel-01/status"
    }
  }
  ```
  Field types: `brokerPort` is an integer; `useTls` is a boolean; every
  other field (including all of `topics`) is a non-empty string.
  `password` is optional (omit or `null` for mutual-TLS setups using a
  client cert instead — client-cert delivery is a later addition to this
  schema, not covered by v1).
- **Response (device → app, synchronous)** — schema validation only, _not_
  a claim that MQTT is connected yet, since that takes longer than a
  single BLE write/response should block for:
  ```json
  { "status": "received" }
  ```
  or
  ```json
  { "status": "error", "message": "malformed payload" }
  ```
  or (see §8):
  ```json
  {
    "status": "error",
    "message": "protocol version mismatch",
    "deviceVersion": 1
  }
  ```

## 6. Custom endpoint: `mqtt-status` (polled)

- Request: empty body (`{}`).
- Response, one of:
  ```json
  { "state": "connecting" }
  { "state": "connected" }
  { "state": "failed", "reason": "auth_failed" }
  { "state": "failed", "reason": "unreachable" }
  { "state": "failed", "reason": "tls_error" }
  { "state": "failed", "reason": "timeout" }
  ```
- The app polls this every 500ms–1s after a `received` response from
  `mqtt-config`, until it sees `connected` or `failed`. `reason` values are
  a fixed enum (this list) — treat an unrecognized value as `unreachable`
  for forward compatibility rather than failing to parse.

## 7. Full sequence (both sides implement this order)

1. App scans the on-device QR (§3) → device name + session credentials.
2. App connects over BLE, discovers the service UUID (§2).
3. Security2 handshake on `prov-session`.
4. App sends Wi-Fi credentials to `prov-config`, polls its `GetStatus`
   until `Connected`/`Failed`.
5. Only once Wi-Fi is `Connected`: app sends `mqtt-config`, gets the
   synchronous `received`/`error` response (§5).
6. App polls `mqtt-status` (§6) until `connected` or `failed`.
7. App shows the user the result. The device, independently, shows its own
   on-screen status for both legs and reboots into normal operation once
   both are known-good.

## 8. Versioning & compatibility

`provisioningProtocolVersion` (§5) is the field that keeps two
independently-built, independently-released binaries from silently
misinterpreting each other. Firmware checks it on every `mqtt-config`
request; on a mismatch it responds with the `protocol version mismatch`
error shown in §5 (including its own `deviceVersion`) rather than
attempting to interpret a payload shape it doesn't recognize. Bump this
number on either side only for changes that actually break wire
compatibility — field additions the other side can safely ignore don't
need a bump; field removals, renames, or type changes do.

## 9. What's intentionally not customized here

The Wi-Fi endpoints (§4) and the raw sec2 handshake bytes (§3) are exactly
what ESP-IDF's `wifi_provisioning`/`protocomm` components already
implement — not reinvented or extended here. That's deliberate: it keeps
this document, and the coordination burden between the two teams, scoped
to only the two endpoints (§5, §6) that are actually project-specific.
