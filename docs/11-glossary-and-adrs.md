# 11. Glossary & Architecture Decision Records

[← 10. Concurrency & Zero-Lag Strategy](./10-concurrency-strategy.md) | [Back to index](./README.md)

---

## 11.1 Glossary

| Term | Definition |
|---|---|
| **Core / Core Server** | The Node.js application implementing the five pillars (Ch. 1–7). Never refers to extensions or client repos. |
| **Pillar** | One of the five foundational, non-optional Core responsibilities (Auth, Provisioning, Connectivity, State, Extension Engine). |
| **Extension / Plugin** | Optional, hot-pluggable module implementing `CoreExtension` ([Ch. 7](./07-extension-engine.md)). Google Home ([Ch. 8](./08-google-home-extension.md)) is the reference example. |
| **Abstraction Packet / `CoreEvent`** | The canonical, hardware-agnostic event shape (`clientId`, `componentId`, `eventType`, `value`) all telemetry is normalized into ([Ch. 5, §5.3](./05-connectivity-broker.md#53-normalization-wire-payload--internal-event)). |
| **`StateEntry`** | The persisted, last-value-wins record for a `(clientId, componentId)` pair in the State Engine ([Ch. 6, §6.1](./06-state-engine.md#61-the-canonical-abstraction-packet)). |
| **Transport Adapter** | A pluggable module normalizing one wire protocol (MQTT, WebSocket, ...) into `CoreEvent`/`OutboundMessage` ([Ch. 5, §5.2](./05-connectivity-broker.md#52-transport-adapter-abstraction)). |
| **Provisioning Strategy** | A pluggable module implementing device onboarding for one mechanism (BLE, soft-AP, QR-claim) ([Ch. 4, §4.2](./04-device-provisioning.md#42-provisioning-strategy-abstraction)). |
| **Client / Client Repository** | Any external system that connects to the Core over its documented protocols — hardware firmware (e.g., ESP32-C6), a web provisioning app, or a future device type. Lives in its own repository, never shares code with the Core. |
| **Home Graph** | Google's device-state synchronization service; the target of the Google Home extension's `reportStateAndNotification` calls ([Ch. 8, §8.4](./08-google-home-extension.md#84-realtime-state-reporting--home-graph)). |
| **Fulfillment** | Google Smart Home's term for the webhook that handles `SYNC`/`QUERY`/`EXECUTE` intents; implemented entirely inside the Google Home extension ([Ch. 8, §8.2](./08-google-home-extension.md#82-fulfillment-intent-mapping)). |
| **`IsolatedStore`** | The namespaced persistence surface offered to extensions requesting `isolatedStorage`, preventing cross-extension or extension-to-Core-table data access ([Ch. 7, §7.6](./07-extension-engine.md#76-data-isolation)). |

## 11.2 Architecture Decision Records (ADRs)

Each ADR captures a decision, its context, and its consequence — future changes to these decisions should add a new ADR (status `Superseded`) rather than editing history.

### ADR-001: The Core Has No Vendor-Specific Integrations Built In
- **Status:** Accepted
- **Context:** Early designs considered shipping Google Home support directly in the Core for faster time-to-market.
- **Decision:** All third-party platform integrations, including Google Home, ship exclusively as extensions ([Ch. 7](./07-extension-engine.md), [Ch. 8](./08-google-home-extension.md)).
- **Consequence:** Slightly more upfront engineering (building the plugin framework before the first integration) in exchange for the Core never needing a breaking change to support, remove, or update any given platform integration.

### ADR-002: Firmware and Core Live in Separate Repositories With No Shared Code
- **Status:** Accepted
- **Context:** A monorepo would simplify some cross-cutting changes (e.g., updating a shared payload type) but couples firmware release cadence to server release cadence and blurs the trust boundary between untrusted network input and server logic.
- **Decision:** Hardware/firmware repos and the Core communicate exclusively over the documented wire protocol ([Ch. 4](./04-device-provisioning.md), [Ch. 5](./05-connectivity-broker.md)); no shared build artifacts.
- **Consequence:** Protocol changes must be versioned and backward-compatible (or explicitly coordinated), since the Core cannot assume all deployed firmware has updated in lockstep.

### ADR-003: State Engine Is Last-Value-Wins, Not Event-Sourced
- **Status:** Accepted
- **Context:** An event-sourced log would give "free" history/audit trails but adds storage growth and query complexity to a pillar meant to stay minimal.
- **Decision:** The State Engine ([Ch. 6](./06-state-engine.md)) stores only current value per `(clientId, componentId)`. Extensions needing history subscribe to the raw event stream and own their own storage.
- **Consequence:** History/analytics features are opt-in extension responsibilities, not a Core cost paid by every deployment.

### ADR-004: Extensions Run In-Process by Default, Worker-Isolated by Declaration
- **Status:** Accepted
- **Context:** Full process isolation for every extension is the safest option but adds latency/complexity that most lightweight extensions don't need.
- **Decision:** In-process is the default; extensions opt into `runtime: "worker"` isolation via their manifest when their workload profile warrants it ([Ch. 7, §7.7](./07-extension-engine.md#77-process-isolation-mode), [Ch. 10, §10.5](./10-concurrency-strategy.md#105-layer-3--process-isolation-for-heavy-extensions)).
- **Consequence:** Extension authors must accurately declare their workload profile; the engine's timeout/circuit-breaker layer ([Ch. 10, §10.3](./10-concurrency-strategy.md#103-layer-2--per-hook-timeouts--circuit-breaking)) is the safety net for extensions that under-declare.

### ADR-005: Command Dispatch Is Awaited; External Notification Is Fire-and-Forget
- **Status:** Accepted
- **Context:** Treating all extension-initiated I/O identically would either make physical device control unreliable (if fire-and-forget) or make every extension's external API calls a potential bottleneck (if awaited).
- **Decision:** `ctx.commands.dispatch` (affects a physical device) is awaited and acknowledgeable; outbound calls to external platforms (e.g., Home Graph) are fire-and-forget with extension-owned retry ([Ch. 10, §10.6](./10-concurrency-strategy.md#106-why-fire-and-forget-is-safe-here-and-where-it-isnt)).
- **Consequence:** Extension authors must not rely on `reportStateAndNotification`-style calls for correctness — only for downstream UI freshness in the external platform.

## 11.3 Change Log

| Date | Change |
|---|---|
| 2026-08-11 | Initial architecture manual authored (Ch. 1–11) |

---

[← 10. Concurrency & Zero-Lag Strategy](./10-concurrency-strategy.md) | [Back to index](./README.md)
