# 3. Authentication & Identity Layer

[← 2. System Topology](./02-system-topology.md) | [Back to index](./README.md) | Next: [4. Device Provisioning →](./04-device-provisioning.md)

---

## 3.1 Responsibility Statement

The Authentication & Identity Layer is the single source of truth for **"who is this request/connection acting on behalf of, and what are they allowed to do."** It is intentionally minimal: a lightweight, self-hosted OAuth2 provider plus supporting session/account infrastructure — not a full identity-as-a-service platform. Anything beyond "issue tokens, validate tokens, link accounts" belongs in an extension.

## 3.2 Components

```
┌─────────────────────────────────────────────────────────────┐
│                 Authentication & Identity Layer                │
│                                                                 │
│  ┌────────────────┐  ┌───────────────────┐  ┌───────────────┐ │
│  │ Local Account   │  │ OAuth2 Provider    │  │ Session &      │ │
│  │ Service         │  │ Engine             │  │ Token Registry │ │
│  │ (register/login)│  │ (authorize/token/  │  │ (validate/     │ │
│  │                 │  │  introspect)       │  │  revoke)       │ │
│  └────────────────┘  └───────────────────┘  └───────────────┘ │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │        Third-Party Account Linking Interface (Ports)        │ │
│  │  (implemented by extensions, e.g. "Login with Google")      │ │
│  └───────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 3.2.1 Local Account Service
- User registration (email/password or passwordless magic-link), credential hashing (Argon2id), rate-limited login.
- Emits domain events (`user.registered`, `user.login`, `user.password_reset`) onto the internal event bus so extensions can react (e.g., a welcome-email extension) without the account service knowing they exist.

### 3.2.2 OAuth2 Provider Engine
The Core runs its **own** OAuth2 authorization server (RFC 6749 + PKCE per RFC 7636), for two purposes:
1. **First-party clients** (the Web Bluetooth provisioning app, a future mobile app) authenticate against it to obtain scoped access tokens for Core APIs.
2. **Extensions that expose their own HTTP endpoints** (e.g., the Google Home fulfillment webhook, [Ch. 8](./08-google-home-extension.md)) validate the bearer tokens presented to them using the same introspection endpoint, so there is one canonical notion of "valid session" across Core and every extension.

Supported grant types: `authorization_code` (with PKCE, for interactive clients), `client_credentials` (for machine-to-machine/service accounts, e.g. an extension's background job), and `refresh_token`.

The Core intentionally does **not** implement OAuth2 grants specific to any third-party platform's login flow (e.g., "Sign in with Google" as a *consumer-facing* feature). That is a distinct concern from "the Core issues its own tokens" — see 3.2.4.

### 3.2.3 Session & Token Registry
- Access tokens: short-lived JWTs (5–15 min), signed with a rotating key (JWKS endpoint exposed for extension/service verification).
- Refresh tokens: opaque, stored server-side (hashed) to allow immediate revocation — critical for device-adjacent sessions where a lost phone or compromised provisioning app must be revocable instantly.
- Device-bound sessions (for hardware clients that authenticate, e.g. to publish telemetry) use a separate, longer-lived credential class (mutual TLS client cert or a per-device secret issued during provisioning — see [Ch. 4](./04-device-provisioning.md#43-credential-issuance)), never the same token type as a human user session.

### 3.2.4 Third-Party Account Linking Interface
This is a **port**, not an implementation. The Core defines the interface:

```ts
interface AccountLinkingProvider {
  id: string;                       // e.g. "google", "spotify"
  initiateLink(userId: string): Promise<{ redirectUrl: string }>;
  handleCallback(userId: string, query: Record<string, string>): Promise<LinkedAccount>;
  revoke(userId: string, linkedAccountId: string): Promise<void>;
}
```

The Core's Identity Layer maintains the `linked_accounts` table (userId, providerId, externalId, encrypted tokens, scopes) and exposes generic `POST /identity/links/:providerId/start` and `GET /identity/links/:providerId/callback` routes that dispatch to whichever extension registered as that `providerId`. **The Google Home extension is the reference consumer of this interface** ([Ch. 8, §8.3](./08-google-home-extension.md#83-account-linking-oauth-handshake)) — it registers itself as provider `"google-home"` at install time; the Core never hardcodes Google-specific OAuth endpoints, scopes, or token formats.

## 3.3 Data Model (Core-Owned)

| Table | Key Fields | Notes |
|---|---|---|
| `users` | id, email, password_hash, created_at | Core-owned, minimal |
| `sessions` | id, user_id, refresh_token_hash, device_fingerprint, expires_at | Revocable server-side |
| `oauth_clients` | client_id, client_secret_hash, redirect_uris, grant_types | Registered first-party/extension clients |
| `linked_accounts` | id, user_id, provider_id, external_id, encrypted_tokens, scopes | Encrypted at rest; provider-specific token *shape* is opaque `jsonb`, owned by the extension |
| `device_credentials` | device_id, credential_type, credential_hash, issued_at, revoked_at | Ties a physical device identity to provisioning ([Ch. 4](./04-device-provisioning.md)) |

## 3.4 API Surface (Representative)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/identity/register` | Local account creation |
| `POST` | `/identity/login` | Local login → issues tokens |
| `POST` | `/oauth2/authorize` | Standard OAuth2 authorize endpoint |
| `POST` | `/oauth2/token` | Standard OAuth2 token endpoint |
| `POST` | `/oauth2/introspect` | Token validation for internal services/extensions |
| `GET`  | `/.well-known/jwks.json` | Public key set for JWT verification |
| `POST` | `/identity/links/:providerId/start` | Begin third-party account link (dispatches to extension) |
| `GET`  | `/identity/links/:providerId/callback` | Complete third-party account link |
| `DELETE` | `/identity/links/:linkedAccountId` | Revoke a linked account |

## 3.5 Extension Interaction Contract

Extensions never touch the `users`, `sessions`, or `oauth_clients` tables directly. They interact with identity exclusively through:
1. **Token introspection** (`/oauth2/introspect` or an in-process `identity.verifyToken()` call) to authenticate inbound requests to their own fulfillment endpoints.
2. **The `AccountLinkingProvider` port** (3.2.4) if they need a "connect my account to platform X" flow.
3. **Read-only identity events** (`identity.userLinked`, `identity.userUnlinked`) delivered over the extension event bus ([Ch. 7](./07-extension-engine.md)).

This keeps identity data — the most sensitive data in the system — inside a single, auditable boundary regardless of how many extensions are installed.

## 3.6 Why an OAuth2 Provider *Engine* (Not a Hardcoded Flow)

Building this as a general OAuth2 engine rather than a bespoke login system means:
- The **same** infrastructure secures first-party web/mobile clients, second-party extension fulfillment endpoints, and third-party integrator applications (if the platform is later opened to external developers), with zero duplicated auth logic.
- Google Home's fulfillment webhook ([Ch. 8](./08-google-home-extension.md)) authenticates callers using the *exact same* token validation path as the core REST API — there is no parallel, extension-specific auth stack to maintain or audit.

---

[← 2. System Topology](./02-system-topology.md) | [Back to index](./README.md) | Next: [4. Device Provisioning →](./04-device-provisioning.md)
