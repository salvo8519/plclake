<div class="erp-docs-lang-bar">
  <span>Language:</span>
  <strong>EN</strong>
  <span>·</span>
  <a href="../../it/security/api-auth-and-hardening.md">IT (Italiano)</a>
</div>

# API Security, Multi-Scope Auth, Managed API Keys & Hardening

All Control Plane APIs (`/api/v1/*`) enforce least-privilege **Multi-Scope** authentication (`admin`, `read`, `edge`) across **Managed API Keys (`X-API-Key`)**, revocable operator sessions, and legacy service tokens.

---

## 1. Managed API Keys (`pat_live_...`) — Recommended for Integrations

Integrators and plant administrators issue, rotate, and revoke per-integration API keys directly from **Administration → API Tokens** (`POST /api/v1/tokens`, `POST /api/v1/tokens/:tokenId/rotate`, `DELETE /api/v1/tokens/:tokenId`).

- **Header**: `X-API-Key: pat_live_<random>` (also accepted via `Authorization: Bearer pat_live_...` for clients that standardize on Bearer headers).
- **One-Time Plaintext Disclosure**: The raw secret is shown **once** at creation or rotation and never persisted in plaintext.
- **Cryptographic Storage at Rest**: Keys are hashed with **SHA-256** and wrapped with **AES-256-GCM** (`enc:v1:<iv>:<tag>:<ciphertext>`) using `SECRETS_ENCRYPTION_KEY` (or an owner-only `0600` master key in `.state/.master.key`). Verification uses constant-time `crypto.timingSafeEqual`.
- **Automated Audit Trail (`SecretManagement` → `AuditLogSystem`)**: Every token lifecycle transition (`token.created`, `token.rotated`, `token.revoked`, plus automatic cascade revocation when an owning user account is disabled) is emitted over the internal event bus and persisted straight into the Immutable Audit Log and structured JSON logs without ever logging raw secrets.
- **Interactive Scalar Testing**: Open `/api/v1/docs` and click **API Key / Test Auth** to mint an audited 1-hour sandbox `pat_live_...` key (or authenticate with plant credentials in strict mode) and paste it into `ApiKeyHeaderAuth`.

---

## 2. Credential Types & Scope Matrix

| Credential Prefix | Header / Source | Scope(s) | Authorized Endpoints |
| :--- | :--- | :--- | :--- |
| `pat_live_...` | `X-API-Key` (Managed in **API Tokens**) | Configurable (`read`, `edge`, `admin`) | Least-privilege endpoints matching assigned scopes, including `/metrics` (`read`/`admin`) |
| `sess_...` | `Authorization: Bearer` / `X-API-Key` (Login) | Derived from RBAC role (`admin`, `operator`, `viewer`) | Console session held strictly in JS memory (never `localStorage` / `sessionStorage`) |
| `adm_live_...` | `API_ADMIN_TOKEN` (Service key) | **`admin`** | Full access (writes, key rotation, probes, RBAC, token governance) |
| `bi_live_...` | `API_READ_TOKEN` (Service key) | **`read`** | Read-only analytics, catalog, runs, `/metrics` & audit inspection |
| `gw_live_...` | `EDGE_GATEWAY_TOKEN` (Service key) | **`edge`** | `POST /ingest/batch`, `GET /edge/config` |

---

## 3. Defense-in-Depth Hardening Controls

- **RBAC & Account Lifecycle**: Passwords hashed with salted `scrypt`. Separate **Users** and **Roles & Permissions** administration views govern 10 menu views and 4 operational capabilities. Disabling a user immediately revokes both active browser sessions and owned `pat_live_...` tokens.
- **Outbound Network & Redirect Protection**: All PLC endpoint probes, SMTP relays, Mailpit diagnostics, and outbound webhooks validate target hosts through a canonical validator blocking cloud metadata (`169.254.0.0/16`, `metadata.google.internal`, `fd00:ec2::/32`), link-local/unspecified ranges, IPv4-mapped IPv6 (`::ffff:...`), expanded/bracketed IPv6 loopback, and integer/octal/hex IPv4 encodings. Host names are **resolved and every returned address is checked**; the connection is then **pinned to the validated address** (no second DNS lookup, closing DNS rebinding), while TLS still verifies the certificate against the configured host name. All outbound HTTP calls enforce `redirect: 'error'`.
- **Transport & CORS Hardening**: Implicit TLS SMTP relays (`secure: true`) enforce TLS certificate validation by default (`SMTP_TLS_REJECT_UNAUTHORIZED !== 'false'`). Authenticated `/api/*` routes never emit wildcard `Access-Control-Allow-Origin: *` and require explicit origins in `CORS_ORIGIN`.
- **Rate Limiting & CSV Sanitization**: Sliding-window rate limiters protect login, token/key rotation, probes, run creation, and batch ingestion. All CSV exports neutralize spreadsheet formula prefixes (`=`, `+`, `-`, `@`).
- **Security Headers**: In production every API response carries `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`; the console uses a `'self'`-based policy (Google Fonts allowed, frames allowed for the configured Mailpit inbox). `Strict-Transport-Security` is sent only over TLS (`TRUST_PROXY` honours `X-Forwarded-Proto` behind an ingress). The Scalar API reference is excluded because it loads from a CDN.
- **Error Handling**: Unexpected failures never reach the client with internal details: handlers answer a generic message with a `requestId`, the full error is logged server-side, and rejected async handlers are forwarded to a central JSON error handler instead of terminating the process.
- **Edge Gateway Credentials**: HTTP REST meters declare TLS explicitly (`useTls`, any port). The gateway never sends the meter bearer token over plain HTTP unless `EDGE_HTTP_METER_ALLOW_PLAINTEXT_TOKEN=true`, and its environment file carries no database credentials. Batches permanently rejected by the API (HTTP 400/422) move to a dead-letter table instead of blocking the spool.
- **Authorization Map in CI**: `tests/route_table.test.ts` snapshots every route with its middleware chain (`requireScope(admin)`, `rateLimit(login)`, ...). A route that loses or changes its protection fails CI until the change is reviewed.

---

## 4. Production Fail-Closed Baseline

When `NODE_ENV=production` the server refuses insecure configurations instead of falling back to convenient defaults:

| Rule | Behaviour |
| :--- | :--- |
| API authentication | Always enforced. `API_ENFORCE_AUTH=false` and the console "Trusted LAN" option have no effect (the option is shown locked). |
| `AUTH_ADMIN_PASSWORD` | Required, at least 12 characters; the server does not start without it. |
| `SECRETS_ENCRYPTION_KEY` | Required (64 hex chars, `openssl rand -hex 32`). A per-container key would make encrypted tokens unreadable after a restart or across replicas. |
| Demo accounts | Never created. Outside production they are opt-in (`AUTH_SEED_DEMO_USERS=true`). |
| PostgreSQL | If `DATABASE_URL` is set but unreachable, the server retries with backoff and then stops, instead of silently running on local files. `/readyz` returns `503` while the database is unavailable. |
| Compose stacks | `POSTGRES_PASSWORD` (and `GRAFANA_ADMIN_PASSWORD` where Grafana runs) are required. Internal services bind to `127.0.0.1` unless `PLCLAKE_BIND_ADDR` opens them on purpose. |

Outside production, no password is hard-coded: missing built-in account passwords are generated at first boot and written once to `.state/initial-credentials.txt` (permissions `0600`).

Behind a reverse proxy or ingress, set `TRUST_PROXY` (hop count or trusted subnets) so rate limits and audit entries see real client IPs; it is off by default so direct clients cannot spoof `X-Forwarded-For`.

> **Scaling note**: sessions and rate-limit counters are kept in process memory, so the Helm chart runs a single replica. A shared store for multi-replica deployments is tracked in [issue #4](https://github.com/salvo8519/plclake/issues/4).
