# 7. Dynamic Extension Engine (Plugin Framework)

[← 6. Contextual State Engine](./06-state-engine.md) | [Back to index](./README.md) | Next: [8. Google Home Integration Extension →](./08-google-home-extension.md)

---

## 7.1 Responsibility Statement

The Extension Engine is what makes the other four pillars sufficient. Rather than the Core growing a special case for every third-party platform it might integrate with, it grows exactly one thing — a plugin runtime — and every integration (Google Home, Alexa, IFTTT, analytics pipelines, custom automations) is built against that single, stable contract.

## 7.2 Extension Lifecycle

```
   discovered ──► validated ──► installed ──► enabled ◄──► disabled ──► uninstalled
                     │                            │
                     ▼                            ▼
                  rejected                    (hooks active,
              (manifest/permission            routes mounted,
               check failed)                  event listeners live)
```

| State | Meaning |
|---|---|
| `discovered` | Package present (npm-installed or dropped into `extensions/`) but not yet loaded |
| `validated` | Manifest schema-checked, requested permissions reviewed against operator policy |
| `installed` | Dependencies resolved, extension's own migrations (if any, in its isolated schema) applied |
| `enabled` | Event listeners registered, routes mounted, extension actively participates in the system |
| `disabled` | Code remains installed but is unloaded from the event bus/router — zero runtime footprint |
| `uninstalled` | Extension code and (optionally) its isolated data are removed |

Transitions are driven by an admin API (`POST /admin/extensions/:id/enable`, etc.) — never by an extension enabling itself, and never requiring a full Core restart for `enable`/`disable`/`install`/`uninstall` (hot-pluggability is a hard requirement, not an aspiration).

## 7.3 Registration & Manifest

Every extension ships a manifest declaring what it needs, up front:

```ts
interface ExtensionManifest {
  id: string;                          // "google-home", unique
  version: string;                     // semver
  displayName: string;
  permissions: {
    stateRead?: boolean;               // may call StateQuery.get/getAllForClient/subscribe
    commandDispatch?: boolean;         // may issue CoreCommand via the broker
    httpRoutes?: boolean;              // may mount its own Express/Fastify sub-router
    accountLinking?: string[];         // provider ids it registers as (ch. 3, §3.2.4)
    isolatedStorage?: boolean;         // may use its own namespaced schema (§7.6)
  };
  entryPoint: string;                  // module path exporting the CoreExtension implementation
}
```

The Core's loader refuses to enable an extension whose requested permissions exceed what the operator has approved (configurable allow-list), and every permission is enforced at the API boundary — an extension without `commandDispatch: true` literally cannot call the command-issuing method, regardless of what its code attempts.

## 7.4 The `CoreExtension` Interface

This is the single contract every extension implements — the "sample JavaScript interface/class pattern" referenced throughout this manual:

```ts
// core-extension-sdk/types.ts
interface CoreExtensionContext {
  state: StateQuery;                              // read-only state access (ch. 6, §6.5)
  commands: {
    dispatch(cmd: CoreCommand): Promise<void>;     // ch. 5, §5.4
  };
  identity: {
    verifyToken(token: string): Promise<TokenClaims | null>;
    registerAccountLinkingProvider(p: AccountLinkingProvider): void; // ch. 3, §3.2.4
  };
  http: {
    mount(path: string, router: HttpRouter): void; // e.g. mount("/extensions/google-home", router)
  };
  storage: {
    namespace(key: string): IsolatedStore;         // ch. §7.6
  };
  logger: Logger;
}

abstract class CoreExtension {
  abstract readonly manifest: ExtensionManifest;

  // Lifecycle hooks
  abstract onInstall(ctx: CoreExtensionContext): Promise<void>;
  abstract onEnable(ctx: CoreExtensionContext): Promise<void>;
  abstract onDisable(ctx: CoreExtensionContext): Promise<void>;
  onUninstall?(ctx: CoreExtensionContext): Promise<void>;

  // Event hooks — called by the engine when subscribed topics fire
  onStateChanged?(event: StateChangeEvent, ctx: CoreExtensionContext): Promise<void>;
  onConnectivityChanged?(event: ConnectivityEvent, ctx: CoreExtensionContext): Promise<void>;
  onIdentityEvent?(event: IdentityEvent, ctx: CoreExtensionContext): Promise<void>;
}
```

### 7.4.1 Minimal Example

```ts
// extensions/example-logger/index.ts
import { CoreExtension, CoreExtensionContext, StateChangeEvent } from "core-extension-sdk";

export default class ExampleLoggerExtension extends CoreExtension {
  readonly manifest = {
    id: "example-logger",
    version: "1.0.0",
    displayName: "Example State Logger",
    permissions: { stateRead: true },
    entryPoint: "extensions/example-logger/index.js",
  };

  async onInstall() {}

  async onEnable(ctx: CoreExtensionContext) {
    ctx.logger.info("example-logger enabled");
  }

  async onDisable() {}

  async onStateChanged(event: StateChangeEvent, ctx: CoreExtensionContext) {
    ctx.logger.info(`state changed: ${event.clientId}/${event.componentId} = ${event.value}`);
  }
}
```

This ~20-line extension is fully functional and installable with zero Core code changes — it is the same shape the Google Home extension uses, just with far fewer hooks exercised (see [Ch. 8](./08-google-home-extension.md) for the full-featured version).

## 7.5 Event Bus Topics Available to Extensions

| Topic | Payload | Emitted by |
|---|---|---|
| `state.changed` | `StateChangeEvent` | State Engine ([Ch. 6, §6.4](./06-state-engine.md#64-update--subscription-model)) |
| `state.heartbeat` | `StateChangeEvent` (unchanged value) | State Engine |
| `connectivity.online` / `connectivity.offline` | `ConnectivityEvent` | Connectivity Broker ([Ch. 5, §5.5](./05-connectivity-broker.md#55-connection-lifecycle--presence)) |
| `identity.userLinked` / `identity.userUnlinked` | `IdentityEvent` | Identity Layer ([Ch. 3, §3.5](./03-authentication-identity.md#35-extension-interaction-contract)) |
| `provisioning.deviceProvisioned` | `{ deviceId, strategyId }` | Provisioning Orchestrator ([Ch. 4](./04-device-provisioning.md)) |

Extensions subscribe declaratively by implementing the corresponding `on*` method — the engine only invokes hooks that are actually defined, so an extension pays no cost (and receives no traffic) for topics it doesn't care about.

## 7.6 Data Isolation

Every extension that requests `isolatedStorage` gets a namespaced key-value/collection store (`storage.namespace(extensionId)`), backed by a dedicated Postgres schema or a prefixed Redis/Mongo namespace depending on deployment. Extensions **cannot** open arbitrary connections to the Core's primary database — the `IsolatedStore` interface is the only persistence surface offered, which guarantees:
- One extension cannot read or corrupt another extension's data.
- No extension can query `users`, `sessions`, or other Core-pillar tables directly, even accidentally.
- Uninstalling an extension has a well-defined data-cleanup boundary (drop its namespace).

## 7.7 Process Isolation Mode

By default, extensions run **in-process** for the lowest possible hook latency (critical for real-time paths like command injection). For extensions with heavier or less-trusted workloads (e.g., calling a slow third-party API on every state change), the manifest can declare `runtime: "worker"`, causing the engine to load that extension inside a Node.js `worker_thread` (CPU-bound isolation) or a separate child process/container (fault isolation), communicating with the main process over the same `CoreExtensionContext` shape via an RPC shim. This is transparent to extension authors — the interface in §7.4 does not change based on runtime mode. See [Ch. 10](./10-concurrency-strategy.md) for the full concurrency rationale.

## 7.8 Versioning & Compatibility

- `ExtensionManifest.version` follows semver; the engine records the `core-extension-sdk` version an extension was built against and refuses to enable an extension declaring an incompatible major SDK version.
- Hot updates (install version N+1 while N is enabled) follow: disable N → install N+1 → run N+1 migrations in its isolated schema → enable N+1, with automatic rollback to N if `onEnable` throws.

---

[← 6. Contextual State Engine](./06-state-engine.md) | [Back to index](./README.md) | Next: [8. Google Home Integration Extension →](./08-google-home-extension.md)
