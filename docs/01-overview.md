# 1. Architecture Overview & Principles

[← Back to index](./README.md) | Next: [2. System Topology →](./02-system-topology.md)

---

## 1.1 Executive Summary

The Core Server is a Node.js application that provides four foundational services — **identity, provisioning, connectivity, and state** — plus a **plugin runtime** that lets everything else (smart-home platform bridges, analytics, automations, third-party integrations) be added, updated, and removed without touching Core code or requiring a Core redeploy for unrelated changes.

The Core does not know:

- What an ESP32-C6 is, or how to flash/configure one.
- What a "rotary knob" or "light bulb" means semantically.
- That Google Home, Alexa, or any other voice/cloud platform exists.

The Core only knows:

- Who is authenticated and what they're authorized to do.
- How to get a device from "unconfigured" to "connected" via pluggable onboarding strategies.
- How to move bytes/JSON between a persistent connection and internal event topics.
- How to store and broadcast opaque state changes keyed by client/component identifiers.
- How to load, sandbox, and route events to installed extensions.

## 1.2 Design Principles

### P1 — Hardware Agnosticism Is Structural, Not Aspirational
The Core's data model uses generic primitives (`clientId`, `componentId`, `value: number | string | boolean`, `eventType`) rather than domain vocabulary (`lightState`, `thermostatSetpoint`). Domain meaning is applied only by clients (rendering) or extensions (semantic translation for a specific downstream platform). This is enforced at the schema layer — the Core's ingestion validators reject payloads that attempt to smuggle in rendering hints or platform-specific fields.

### P2 — Extensions Are Guests, Not Tenants
Every capability beyond the five pillars is implemented as an extension running under a defined lifecycle and permission surface. The Core ships with zero pre-installed vendor integrations. Google Home support, if present at runtime, is present because an operator installed and enabled it — identical in principle to a third-party installing it.

### P3 — Transport Is an Implementation Detail
"Device sends MQTT" and "device sends WebSocket JSON" are both normalized to the same internal event shape before anything else in the system sees them. New transports (CoAP, raw TCP, LoRaWAN gateway bridge) are added by writing a new **Transport Adapter**, not by branching core logic.

### P4 — The Event Loop Is a Shared Resource
Nothing in an extension is allowed to synchronously block the process that is also responsible for real-time device connectivity. This is a first-class constraint enforced through architecture (isolation, async contracts, timeouts) — see [10. Concurrency & Zero-Lag Strategy](./10-concurrency-strategy.md).

### P5 — Repository Boundaries Mirror Trust Boundaries
Firmware/client code lives in its own repository (or repositories) and communicates with the Core only across a versioned, documented wire protocol. There is no shared build step, no shared source tree, and no compile-time coupling between the Core and any client implementation.

### P6 — Additive by Default
Adding a new device type, onboarding strategy, transport, or third-party platform integration should never require modifying pillar code. If it does, that is treated as an architectural defect and logged as an ADR candidate (see [11. Glossary & ADRs](./11-glossary-and-adrs.md)).

## 1.3 The Five Core Pillars (At a Glance)

```
┌──────────────────────────────────────────────────────────────────────┐
│                         NODE.JS CORE SERVER                           │
│                                                                        │
│  ┌────────────────┐  ┌────────────────┐  ┌──────────────────────┐  │
│  │ 1. Auth &       │  │ 2. Device Setup │  │ 3. Connectivity &     │  │
│  │    Identity     │  │    & Provision  │  │    Command Broker     │  │
│  │    Layer        │  │    Orchestrator │  │    (MQTT / WS)        │  │
│  └────────────────┘  └────────────────┘  └──────────────────────┘  │
│           │                    │                     │               │
│           └────────────────────┼─────────────────────┘               │
│                                 ▼                                     │
│                  ┌──────────────────────────────┐                    │
│                  │ 4. Contextual State Engine     │                    │
│                  │    (hardware-agnostic matrix)  │                    │
│                  └──────────────────────────────┘                    │
│                                 │                                     │
│                                 ▼                                     │
│                  ┌──────────────────────────────┐                    │
│                  │ 5. Dynamic Extension Engine    │                    │
│                  │    (plugin framework)          │                    │
│                  └──────────────────────────────┘                    │
└──────────────────────────────────────────────────────────────────────┘
```

| Pillar | Responsibility | Detailed doc |
|---|---|---|
| 1. Authentication & Identity | Local accounts, OAuth2 provider, session validation, third-party account linking | [Ch. 3](./03-authentication-identity.md) |
| 2. Device Setup & Provisioning | BLE-based and network-based onboarding workflows | [Ch. 4](./04-device-provisioning.md) |
| 3. Connectivity & Command Broker | MQTT/WebSocket abstraction, telemetry ingress, command egress | [Ch. 5](./05-connectivity-broker.md) |
| 4. Contextual State Engine | Generic state matrix, abstraction packets, subscriptions | [Ch. 6](./06-state-engine.md) |
| 5. Dynamic Extension Engine | Plugin lifecycle, hooks, sandboxing, API surface | [Ch. 7](./07-extension-engine.md) |

## 1.4 Non-Goals

Explicitly **out of scope** for the Core, by design:

- Rendering or interpreting UI semantics of any kind.
- Owning firmware update/OTA logic (a provisioning **extension** or a dedicated adjacent service may own this).
- Hardcoding support for any specific cloud voice assistant, hub, or vendor ecosystem.
- Persisting device-type-specific configuration schemas in Core tables (extensions own their own schemas in isolated storage namespaces — see [7.6](./07-extension-engine.md#76-data-isolation)).

## 1.5 Relationship to Client Repositories

```
core-server/            (this manual)              — Node.js, transport/auth/state/extensions
firmware-esp32c6/       (separate repo)             — C/C++ firmware, BLE + MQTT client
client-web-provisioner/ (separate repo, optional)   — Web Bluetooth provisioning UI
extensions/*/           (separate repos or          — Google Home, Alexa, analytics, etc.
                          monorepo packages)
```

No client repository imports Core source code. No Core code imports a client repository. The only contract between them is the wire protocol documented in [Ch. 4](./04-device-provisioning.md) and [Ch. 5](./05-connectivity-broker.md).

---

[← Back to index](./README.md) | Next: [2. System Topology →](./02-system-topology.md)
