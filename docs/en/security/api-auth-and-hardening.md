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
- **Outbound Network & Redirect Protection**: All PLC endpoint probes, SMTP relays, Mailpit diagnostics, and outbound webhooks validate target hosts through a canonical validator blocking cloud metadata (`169.254.0.0/16`, `metadata.google.internal`, `fd00:ec2::/32`), link-local/unspecified ranges, IPv4-mapped IPv6 (`::ffff:...`), expanded/bracketed IPv6 loopback, and integer/octal/hex IPv4 encodings. All outbound HTTP `fetch()` calls enforce `redirect: 'error'`.
- **Transport & CORS Hardening**: Implicit TLS SMTP relays (`secure: true`) enforce TLS certificate validation by default (`SMTP_TLS_REJECT_UNAUTHORIZED !== 'false'`). Authenticated `/api/*` routes never emit wildcard `Access-Control-Allow-Origin: *` and require explicit origins in `CORS_ORIGIN`.
- **Rate Limiting & CSV Sanitization**: Sliding-window rate limiters protect login, token/key rotation, probes, run creation, and batch ingestion. All CSV exports neutralize spreadsheet formula prefixes (`=`, `+`, `-`, `@`).
