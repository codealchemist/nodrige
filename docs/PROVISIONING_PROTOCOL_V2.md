# Provisioning Protocol v2 — Token + AES-GCM

**Status: implemented in firmware and building.** Not yet exercised against a
real client — see §12.

**Replaces:** protocomm Security2 (SRP6a), described in
[BLE_PROVISIONING_PROTOCOL.md](BLE_PROVISIONING_PROTOCOL.md) and
[PROVISIONING_CLIENT_GUIDE.md](PROVISIONING_CLIENT_GUIDE.md). Both now
describe a version the firmware no longer runs; this document is the live
contract.

**Audience:** both the firmware and the provisioner app. This document is the
wire contract; neither side should need to read the other's source.

---

## 1. Why this exists, and what it costs

v1 used SRP6a, a password-authenticated key exchange. A PAKE's entire reason
for existing is to protect a **low-entropy** secret — a 6-digit PIN, a
human-chosen password — from offline dictionary attack. This device does not
have one: it shows a **256-bit random token** on its own screen, delivered
optically. Against a secret that strong, SRP6a's dictionary resistance buys
nothing, while costing both sides a protobuf stack, a 3072-bit modexp, and a
hard dependency on Espressif's client SDK.

v2 uses that token directly as key material for AES-256-GCM.

**What is genuinely lost, stated plainly:**

- **Forward secrecy.** v1 derived an ephemeral session key; recording traffic
  and later learning the password did not decrypt it. In v2 the session key
  is a deterministic function of the token, so an attacker who records a
  session *and* later recovers that session's token can decrypt it
  retroactively. Mitigated by the token being single-use, never stored, and
  destroyed when the session ends — but not eliminated. Adding ECDHE would
  fix this and is the obvious v3 if it ever matters.
- **A vetted implementation.** We now own nonce management and replay
  rejection. AES-GCM fails catastrophically — not gracefully — if a nonce is
  ever reused under the same key. §5 is built so that reuse is
  *structurally impossible* rather than merely forbidden: separate keys per
  direction, and a counter that is also the nonce. Do not "optimise" it.

**What is unchanged:** possession of the token is what authorises a peer, in
both v1 and v2. Anyone who can photograph the QR mid-session can provision
the device either way.

---

## 2. Roles and overview

| | |
| --- | --- |
| **Device** | ESP32-C6. Generates the token, shows the QR, runs the GATT server. |
| **App** | Scans the QR, connects as GATT client, drives the sequence. |

```
Device                                    App
  │  generate 32-byte token                │
  │  render QR ─────── optical ──────────▶ │  scan
  │                                        │  HKDF → k_c2d, k_d2c
  │ ◀────────── HELLO (enc) ───────────────│
  │ ─────────── HELLO_ACK (enc) ──────────▶│
  │ ◀────────── WIFI_CREDS (enc) ──────────│
  │ ─────────── WIFI_STATUS (enc) ────────▶│
  │ ◀────────── MQTT_CONFIG (enc) ─────────│
  │ ─────────── MQTT_STATUS (enc) ────────▶│
```

Every frame after the QR is encrypted. There is no plaintext mode and no
negotiation — a peer that cannot produce a valid GCM tag cannot talk at all.

---

## 3. BLE transport

Plain GATT. No protocomm, no Espressif SDK — any BLE library plus any AES-GCM
implementation is sufficient.

| Role | UUID | Properties |
| --- | --- | --- |
| Service | `8027151f-907e-49d2-bd90-234456b8a407` | primary |
| **RX** (app → device) | `9e1fb9a1-0f07-45cd-ae0a-1d340cbd4a42` | Write |
| **TX** (device → app) | `fbe43299-3649-4534-a091-b387f3b29aa1` | Notify |

- **Advertised name:** `PROV_<last 3 MAC bytes>`, e.g. `PROV_A1B2C3`. Match
  against the QR's `name` — several devices may be advertising.
- The app **must** subscribe to TX notifications before sending `HELLO`.
- **Negotiate the largest MTU you can.** Fragmentation (§6) handles small
  MTUs, but a 517-byte MTU makes most frames single-fragment.
- No BLE bonding or link-layer encryption is required. The link is treated as
  fully untrusted; all confidentiality comes from §4–§5.

---

## 4. Key derivation

The QR carries `token`: **32 random bytes, base64url, unpadded** (43 chars).

Two keys are derived — one per direction — with **HKDF-SHA256**:

```
salt = device MAC, 6 raw bytes        (from the QR's "mac" field)
IKM  = the 32 decoded token bytes

k_c2d = HKDF-SHA256(IKM, salt, info = "esp32c6-prov-v2 c2d", L = 32)
k_d2c = HKDF-SHA256(IKM, salt, info = "esp32c6-prov-v2 d2c", L = 32)
```

`k_c2d` encrypts app → device. `k_d2c` encrypts device → app. **Never use one
key for both directions** — that is what keeps the two counter spaces from
colliding into a nonce reuse.

The `info` strings are exact, ASCII, no trailing NUL.

---

## 5. Frame format

Every frame, both directions:

```
 0        1        2                    10                        n      n+16
 ├────────┼────────┼─────────────────────┼─────────────────────────┼────────┤
 │  ver   │  type  │   counter (8, BE)   │       ciphertext        │  tag   │
 └────────┴────────┴─────────────────────┴─────────────────────────┴────────┘
 └──────────── header, 10 bytes ─────────┘
 └──────────────── AAD ──────────────────┘
```

- `ver` — protocol version. **`0x02`** for this document. Reject anything else.
- `type` — message type (§7).
- `counter` — 64-bit big-endian, see below.
- `tag` — 16-byte GCM authentication tag, appended to the ciphertext.

**Nonce (12 bytes):**

```
nonce = 0x00 0x00 0x00 0x00 || counter (8 bytes, big-endian)
```

The nonce *is* the counter. There is no random component and none should be
added.

**AAD:** the 10-byte header, exactly as transmitted. This binds the version,
type, and counter to the ciphertext, so none can be altered in flight.

### Counter rules — the load-bearing part

1. Each direction keeps its **own** counter, starting at **0**.
2. The sender increments by exactly 1 per frame sent. Never reuse, never
   reset within a session, never skip backwards.
3. The receiver **must** reject any frame whose counter is **≤ the highest it
   has already accepted** on that direction. This is what stops replay.
4. A frame that fails tag verification **must not** advance the counter and
   **must not** be processed. Log it and drop it.
5. On counter overflow (2⁶⁴ frames — unreachable) or any decryption failure,
   abort the session rather than continuing.

Because the two directions use different keys, and each counter is strictly
increasing within its direction, a (key, nonce) pair can never repeat.

---

## 6. Fragmentation

A frame may exceed the BLE MTU. Each GATT write/notify carries:

```
 0                1                          m
 ├────────────────┼──────────────────────────┤
 │  frag header   │      frame bytes         │
 └────────────────┴──────────────────────────┘
```

`frag header` is one byte:

| Bits | Meaning |
| --- | --- |
| 7 | **MORE** — 1 = more fragments follow, 0 = final fragment |
| 6..0 | fragment index, 0-based, increments per fragment |

The receiver concatenates payloads in index order until it sees a fragment
with MORE = 0, then processes the reassembled frame per §5.

- Fragment indices start at 0 for each frame and must arrive in order.
- Out-of-order, gapped, or restarted (index 0 mid-frame) sequences: discard
  the partial buffer and drop the frame.
- Cap reassembly at **4096 bytes**; anything larger is a protocol error.
- Small frames are a single fragment with header `0x00`.

---

## 7. Messages

Payloads are **UTF-8 JSON**, compact (no insignificant whitespace), encrypted
as the GCM plaintext. App → device types are `0x0X`; device → app are `0x8X`.

| Type | Name | Direction | Payload |
| --- | --- | --- | --- |
| `0x01` | `HELLO` | app → device | ASCII `PROVHELO` (8 bytes, **not** JSON) |
| `0x81` | `HELLO_ACK` | device → app | `{"ver":2,"name":"PROV_A1B2C3","fw":"poc-1"}` |
| `0x03` | `WIFI_CREDS` | app → device | `{"ssid":"...","password":"..."}` |
| `0x83` | `WIFI_STATUS` | device → app | `{"state":"connecting\|connected\|failed","ip":"...","reason":"..."}` |
| `0x05` | `MQTT_CONFIG` | app → device | see below |
| `0x85` | `MQTT_STATUS` | device → app | `{"state":"connecting\|connected\|failed","reason":"..."}` |
| `0x8F` | `ERROR` | device → app | `{"code":"...","message":"..."}` |

`HELLO` is deliberately a fixed 8-byte string: its only job is to prove the
app derived the right key. A valid tag on `HELLO` **is** the authentication
step — there is nothing else to verify.

`MQTT_CONFIG` payload, unchanged from v1 except that it is no longer wrapped
in protocomm:

```json
{
  "provisioningProtocolVersion": 2,
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

`ERROR` codes: `bad_version`, `bad_counter`, `decrypt_failed`, `bad_json`,
`wifi_not_connected`, `internal`. An `ERROR` frame is still encrypted and
counted like any other.

---

## 8. QR payload (v2)

**Not JSON.** A single colon-delimited ASCII string:

```
P2:<mac-hex>:<token-b64url>
```

Concretely:

```
P2:a1b2c3d4e5f6:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8
```

| Field | Notes |
| --- | --- |
| `P2` | Literal prefix and version marker. Reject anything not starting `P2:`. |
| `<mac-hex>` | 6 bytes, **lowercase** hex, no separators, always 12 chars. **HKDF salt** — decode to raw bytes. |
| `<token-b64url>` | 32 bytes, base64url, unpadded, always 43 chars. |

Total: **59 bytes**, fixed length.

`:` is an unambiguous delimiter — base64url's alphabet is `[A-Za-z0-9-_]` and
hex is `[0-9a-f]`, so neither field can contain one. Split on the first two
colons.

### Why not JSON

This format exists for exactly one reason: **QR module size**. Payload length
sets the QR version, which sets the module count, which decides whether a
camera can resolve the code at all on a 172px-tall panel.

| Payload | Bytes | QR version | Modules | Pixels per module @164px |
| --- | --- | --- | --- | --- |
| JSON (previous) | 108 | 7 | 45×45 | **2** — unscannable |
| `P2:…` (this) | 59 | 4 | 33×33 | **4** |

Two pixels per module is below what any scanner reliably reads, and a web app
using `getUserMedia` — typically a 640×480 stream — has less to work with than
a native camera app. 4px/module is the ceiling on this panel; 5 would require
a 205px canvas.

### Deriving the device name

The BLE advertised name is **not** in the payload, because it is derivable and
cost ~22 bytes of a budget measured in module size:

```
name = "PROV_" + uppercase(mac-hex[6:12])
```

So `a1b2c3d4e5f6` → `PROV_D4E5F6`. That is the last three MAC bytes, matching
the advertisement (§3).

The token is **single-use**: regenerated every time the device enters
provisioning mode, never persisted, and invalid once the session ends. Never
cache it; never retry with a previous session's token.

---

## 9. Sequence

1. App scans the QR. Reject unless it starts `P2:`. Split into `mac` and
   `token`.
2. App derives `k_c2d` / `k_d2c` (§4).
3. App connects to the device advertising the name derived from `mac` (§8),
   negotiates MTU, subscribes to TX.
4. App sends `HELLO`, counter 0. Device verifies the tag.
   - Tag invalid → device drops the frame silently and keeps waiting. It does
     **not** reply, because a reply would confirm the device name to an
     attacker who cannot decrypt.
5. Device replies `HELLO_ACK`, counter 0 (its own direction's counter).
6. App sends `WIFI_CREDS`. Device applies them and attempts to connect.
7. Device emits `WIFI_STATUS` on change: `connecting` → `connected` /
   `failed`. Both `connected` and `failed` are terminal.
8. **Only after `connected`**, app sends `MQTT_CONFIG`. Sent earlier, the
   device replies `ERROR` / `wifi_not_connected` and discards it.
9. Device emits `MQTT_STATUS`: `connecting` → `connected` / `failed`. Both
   terminal.
10. On `connected`, the device persists the config and leaves provisioning
    mode. The app may disconnect.

**Session window: 3 minutes** from QR display. On expiry the device tears down
BLE and discards the token; the app must rescan a freshly generated QR.

---

## 10. Test vectors

Verified against a real AES-GCM/HKDF implementation. Use these to check an
implementation before touching hardware.

**Inputs** (fixed for the vector — not a real session):

```
QR payload   = P2:a1b2c3d4e5f6:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8

  parsed ->
token (b64url) = AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8
token bytes    = 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
mac (salt)     = a1b2c3d4e5f6
derived name   = PROV_D4E5F6
```

**Derived keys:**

```
k_c2d = e81929a65dc96fb77853751ecfcd741565022efd87007c225a069af8a677b43c
k_d2c = b11aad3d74d519382fba59ec4e809d5ca9073923f594f03887e76bdf7c2aa9a1
```

**HELLO** — app → device, type `0x01`, counter 0, plaintext `PROVHELO`:

```
header (= AAD) : 02010000000000000000
nonce          : 000000000000000000000000
ciphertext+tag : 5a818352d90cebc73c20e49dbffe4cd7d290b17fcd2fc7b9
frame on wire  : 020100000000000000005a818352d90cebc73c20e49dbffe4cd7d290b17fcd2fc7b9
```

**WIFI_CREDS** — app → device, type `0x03`, counter 1, plaintext
`{"ssid":"MyNetwork","password":"hunter2"}`:

```
header (= AAD) : 02030000000000000001
frame on wire  : 0203000000000000000190ca5fb7efdb40d0e63f587f1ec47bef1a367b7cbd85015
                 929591986156535d86c2cbee2845057ba63c6a896aaa8c2bb7755c821e0387f2b3b
```

(The second frame is shown wrapped; it is one contiguous byte string.)

---

## 11. Security properties and non-goals

**Provides:** confidentiality and integrity of everything after the QR;
mutual authentication by token possession; replay rejection within a session;
protection against an attacker who never saw the QR.

**Does not provide:**

- **Forward secrecy** — see §1.
- **Protection against anyone who photographs the QR while the session is
  live.** That is the accepted trust model in v1 and v2 alike: physical sight
  of the screen is authorisation.
- **Protection of what happens afterwards.** MQTT credentials delivered here
  are stored in plaintext NVS and used against a TLS endpoint whose
  certificate is not currently verified. Unchanged by this document, and
  still the largest real-world weakness in the chain — prefer per-device
  revocable broker credentials.

---

## 12. Implementation status

**Done** — `poc/src/provisioning.cpp` + `poc/src/prov_crypto.cpp`. Builds
clean; flash usage went *down* (64.2% → 63.5%), since protobuf and protocomm
outweigh the replacement.

| Item | Where |
| --- | --- |
| GATT server, §3 service | `provisioning.cpp`, Arduino BLE over NimBLE |
| Token + base64url + v2 QR | `provisioningRun()`, `prov_crypto::base64UrlEncode` |
| HKDF-SHA256, AES-256-GCM | `prov_crypto.cpp` via mbedTLS — no new dependency |
| Framing, counters, fragments | `sendFrame` / `handleFrame` / `handleFragment` |
| Wi-Fi applied by us | `provisioningRun()` loop via `netConnectWifi()` |
| `strip_dup_provisioning.py` | deleted — the symbol clash went with protocomm |

### On-device self-test

`provisioningSelfTest()` runs at boot and checks this firmware's crypto
against §10's vectors, printing one line per check:

```
[SelfTest] base64url      PASS
[SelfTest] hkdf k_c2d     PASS
[SelfTest] hkdf k_d2c     PASS
[SelfTest] gcm seal       PASS
[SelfTest] gcm open       PASS
[SelfTest] gcm reject     PASS
[SelfTest] === crypto OK ===
```

This makes "the app can't talk to the device" an answerable question: if
these pass, the firmware agrees with this spec byte for byte and the problem
is on the client side or in the transport. `gcm reject` deliberately
tamper-checks a tag — if *that* one ever passes as accepted, authentication
isn't running and every other line is meaningless.

### Not yet verified

- Any real client session. The whole flow past `HELLO` is untested.
- Concurrent BLE + Wi-Fi + MQTT on the C6.
- Fragment reassembly against a peer that negotiates a small MTU.
