# Changelog

All notable changes to this project are documented in this file following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Semantic Versioning.

## [1.0.0] - 2026-11-22

### Added
- **Versioned OpenAPI 3.1 API (`/api/v1/*`) & Scalar Reference**:
  - Two-Tier Zod validation (`permissive` default with SHA-256 quarantine vs `X-Validation-Mode: strict`).
  - RFC 9745 / 8594 deprecation headers on legacy `/api/*` alias.
  - Multi-scope M2M authentication (`admin`, `read`, `edge`) verifiable via `/api/v1/auth/whoami`.
- **Parameterizable PLC Catalog & Edge Drivers**:
  - 8 built-in industrial profiles (Siemens S7-1500, Rockwell ControlLogix, CNC, Gas Metering, Power Generation) + custom PLC CRUD and output preview API.
  - Real Python OT Edge Collectors for Modbus TCP (pymodbus + zero-dep binary MBAP), OPC-UA, MQTT Sparkplug B, and HTTP REST meters with auto-sync config polling.
- **PostgreSQL Live Persistence & BI Connectors**:
  - Auto-bootstrapped `control_plane_state`, `ml_machine_features` (with forward-compatible `site_id`), `audit_log`, and `vw_ba_controllo_gestione_daily` SQL view.
  - Transparent atomic `.state/*.json` fallback for zero-dependency local execution.
  - Formula-safe RFC 4180 CSV & JSON endpoints for Power BI and Grafana.
- **Notifications, Alerting & SMTP Diagnostics (Mailpit + Webhook)**:
  - Dedicated **Notifications & Alerts** workspace supporting Email (SMTP / Mailpit via `nodemailer`) and HMAC-SHA256 signed HTTP Webhooks with SSRF protection.
  - Dedicated **SMTP Diagnostics** sub-section with embedded Mailpit Queue Depth & Connection Status card, SMTP handshake verification, custom diagnostic test email sender, and live Mailpit REST API inbox/message inspector.
- **RBAC Users & Immutable Audit Log**:
  - Dedicated **Users & Audit** workspace with `scrypt` password hashing, revocable `sess_...` sessions, optional OIDC proxy headers, and searchable/CSV-exportable Audit Log.
- **Platform Observability & Open-Source Packaging**:
  - Structured NDJSON logging (`src/logger.ts`) with deep recursive secret & token redaction.
  - Prometheus `/metrics` (and `/api/v1/metrics`), Kubernetes `/healthz` & `/readyz` probes, and `SIGTERM`/`SIGINT` graceful shutdown.
  - Two pre-provisioned Grafana dashboards (**Platform & System Observability** and **Plant & PLC Operations Monitoring**) and one-command root `docker-compose.yml`.
  - Zensical static documentation site with Mermaid architecture diagrams and automated GitHub Pages & CI workflows.
