# Core Server Architecture Manual

**System:** Modular, Hardware-Agnostic Device Orchestration Core
**Audience:** Backend engineers, firmware/client integrators, extension (plugin) authors, platform architects
**Status:** Living document — update alongside architectural decisions (see [11 — Glossary & ADRs](./11-glossary-and-adrs.md))

---

## Purpose

This manual describes the architecture of the **Node.js Core Server**: a central orchestration platform for authentication, device provisioning, real-time connectivity, and hardware-agnostic state tracking. The Core is deliberately ignorant of any specific hardware (e.g., ESP32-C6 firmware) or third-party cloud ecosystem (e.g., Google Home). All hardware- and platform-specific behavior lives in isolated repositories or hot-pluggable extensions.

The guiding rule for every design decision in this document:

> **If a component needs to know what a "light bulb," a "rotary knob," or "Google Home" is, it does not belong in the Core.**

## Want to Build Something Right Now?

Start with **[0 — POC Implementation Guide](./00-poc-implementation-guide.md)**: a short, standalone build guide for a walking-skeleton POC (BLE-provision an ESP32-C6, connect over MQTT, flow telemetry through the State Engine, and verify it with a working Echo Extension). Every shortcut it takes is built against the same interfaces this manual defines, so the full architecture below is where each POC stub gets hardened next — it isn't a rewrite path.

## How This Manual Is Organized

| # | Document | Covers |
|---|----------|--------|
| 0 | [POC Implementation Guide](./00-poc-implementation-guide.md) | Minimal walking skeleton to build first — BLE + MQTT + Echo Extension |
| 1 | [Architecture Overview & Principles](./01-overview.md) | Goals, non-goals, design principles, the five pillars at a glance |
| 2 | [System Topology](./02-system-topology.md) | Repository boundaries, deployment topology, diagrams |
| 3 | [Authentication & Identity Layer](./03-authentication-identity.md) | OAuth2 provider engine, sessions, account linking |
| 4 | [Device Setup & Provisioning Orchestrator](./04-device-provisioning.md) | BLE provisioning, onboarding strategy hooks. Wire-level firmware⇄app contract: [`PROVISIONING_PROTOCOL_V2.md`](./PROVISIONING_PROTOCOL_V2.md) (token + AES-GCM). Reference clients: [`web-provisioner/`](../web-provisioner/), [`ble-gateway-agent/`](../ble-gateway-agent/) |
| 5 | [Unified Connectivity & Command Broker](./05-connectivity-broker.md) | MQTT/WebSocket transport abstraction, routing |
| 6 | [Hardware-Agnostic Contextual State Engine](./06-state-engine.md) | State matrix, abstraction packets, subscription model |
| 7 | [Dynamic Extension Engine (Plugin Framework)](./07-extension-engine.md) | Plugin lifecycle, API schema, sandboxing |
| 8 | [Google Home Integration Extension — Deep Dive](./08-google-home-extension.md) | Worked example of a real extension |
| 9 | [Event-Driven Data Flow — Worked Trace](./09-event-driven-data-flow.md) | End-to-end trace of a physical event to Home Graph |
| 10 | [Concurrency & Zero-Lag Strategy](./10-concurrency-strategy.md) | Event loop discipline, isolation, backpressure |
| 11 | [Glossary & Architecture Decision Records](./11-glossary-and-adrs.md) | Terminology, key decisions and their rationale |
| 12 | [Panel Modules & Config Builder](./12-panel-modules.md) | Proposed: reusable panel modules, configs that place them, compile to the panel format |

## Reading Paths

- **Building the first working slice:** 0 (POC guide), then harden each stub against 3 → 7/10 → 6 → 5 as needed
- **New backend engineer onboarding to the Core:** 1 → 2 → 3 → 4 → 5 → 6
- **Writing a new extension:** 1 → 7 → 8 (as a reference implementation) → 10
- **Firmware/client engineer integrating a new device type:** 2 → 4 → 5 → 6
- **Architect reviewing the system for a design review:** 1 → 2 → 9 → 10 → 11

## Diagrams

Raw diagram sources (Mermaid) live in [`diagrams/`](./diagrams/) and are also inlined in the relevant chapters so they render directly on GitHub/GitLab/most doc viewers.
