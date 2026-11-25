# PLCLake — Industrial Telemetry & ML Lakehouse

<p align="center">
  <strong>English</strong> · <a href="README.it.md">Italiano</a>
</p>

<!-- BADGES:START -->
<p align="center">
  ![Release](https://img.shields.io/badge/Release-v1.0.0-C9A45C?style=flat-square&labelColor=0B1622)
  ![OpenAPI](https://img.shields.io/badge/OpenAPI-3.1.0%20%C2%B7%2051%20endpoints-16324F?style=flat-square&labelColor=0B1622&logo=openapiinitiative&logoColor=FFFFFF)
  ![i18n](https://img.shields.io/badge/i18n-EN%20%7C%20IT%20%C2%B7%201194%20keys-C9A45C?style=flat-square&labelColor=0B1622&logo=i18next&logoColor=FFFFFF)
  ![Docs](https://img.shields.io/badge/Zensical%20Docs-8%C3%972%20EN%2FIT%20pages-16324F?style=flat-square&labelColor=0B1622)
  ![CI Gate](https://img.shields.io/badge/CI%20Gate-Biome%20%C2%B7%20Ruff%20%C2%B7%20Vitest%20%C2%B7%20i18n-0F6B54?style=flat-square&labelColor=0B1622&logo=gitlab&logoColor=FFFFFF)
  <br />
  ![React](https://img.shields.io/badge/React-19.0.1-16324F?style=flat-square&labelColor=0B1622&logo=react&logoColor=FFFFFF)
  ![TypeScript](https://img.shields.io/badge/TypeScript-6.0.3-16324F?style=flat-square&labelColor=0B1622&logo=typescript&logoColor=FFFFFF)
  ![Express](https://img.shields.io/badge/Express-4.21.2-16324F?style=flat-square&labelColor=0B1622&logo=express&logoColor=FFFFFF)
  ![i18next](https://img.shields.io/badge/i18next-27.2.6-C9A45C?style=flat-square&labelColor=0B1622)
  ![Security](https://img.shields.io/badge/Security-RBAC%20%C2%B7%20AES--256--GCM%20%C2%B7%20scrypt-0F6B54?style=flat-square&labelColor=0B1622)
</p>
<!-- BADGES:END -->

---

## Executive Overview

**PLCLake** is an on-premise and hybrid-ready industrial telemetry platform engineered for **OT/IT Plant Operations**, **Predictive Maintenance ML**, and **Finance & Management Controlling**. It ingests real-time telemetry from heterogeneous shop-floor assets (Siemens S7-1500, Rockwell ControlLogix, CNC mills, gas flow meters, compressors, and power meters), transforms streams into incremental **Hot/Cold Lakehouse Feature Marts** (PostgreSQL 16 + ZSTD Apache Parquet on Garage S3), and serves governed, bilingual (**EN / IT**) APIs and dashboards for **Grafana** and **Power BI**.

### Institutional Industrial Architecture

- **Full Bilingual Platform (`EN | IT`)**: Powered by `i18next` & `react-i18next`, with synchronized language switching across the authenticated Web Console, **Scalar OpenAPI 3.1 Reference** (`/api/v1/docs?lang=en|it`), and **Zensical Documentation** (`docs/en/` & `docs/it/`).
- **Industrial Midnight Steel & Brushed Brass Visual System**: Midnight Steel chrome (`#0B1622`), Prussian Steel Blue primary actions (`#16324F`), Brushed Brass accents (`#C9A45C`), crisp squared `2px` geometry, and borderless horizontal-hairline editorial tables across the console and documentation site.
- **API-First Secret & RBAC Governance**: Managed `X-API-Key` (`pat_live_...`) lifecycle stored as AES-256-GCM encrypted SHA-256 hashes, automated `SecretManagement` → `AuditLogSystem` event subscriber, interactive 1-hour Scalar sandbox key modal, and separated **Users** and **Roles & Permissions** administration views (10 RBAC views).
- **Zero-Drift Solo-Maintainer Automation**: **ESLint (Airbnb style guide)** & Rust-powered **Biome** (frontend + backend TS/React), **Ruff** (Python Edge Gateway), **Husky** (`.husky/pre-commit`) + **`lint-staged`**, `.gitlab-ci.yml`, `renovate.json`, and automated CI verification of EN/IT parity and static OpenAPI/Scalar drift (`npm run check:i18n`).

---

## Quick Start

```bash
cp .env.example .env
npm install
npm run hooks:install
npm run dev
```

Or launch the full production stack (PLCLake + PostgreSQL 16 + Mailpit + Prometheus + Grafana) with Docker:

```bash
docker compose up -d --build
```

| Service | URL |
| :--- | :--- |
| **Web Console (EN / IT)** | `http://localhost:3000` |
| **Centralized Version API** | `http://localhost:3000/api/v1/version` |
| **Scalar OpenAPI 3.1 (EN)** | `http://localhost:3000/api/v1/docs?lang=en` |
| **Scalar OpenAPI 3.1 (IT)** | `http://localhost:3000/api/v1/docs?lang=it` |
| **OpenAPI 3.1 JSON Spec** | `http://localhost:3000/api/v1/openapi.json?lang=en` |
| **Prometheus Metrics** | `http://localhost:3000/api/v1/metrics` |

---

## Autonomous Documentation & Governance

All platform documentation is mirrored 1:1 in English and Italian under `docs/en/` and `docs/it/` and published via **Zensical**:

- **[Documentation Hub (EN / IT)](docs/index.md)**
- **[Architecture: OT/IT Topology & Edge Gateway](docs/en/architecture/ot-it-topology.md)**
- **[Architecture: Hot/Cold Lakehouse & Big Data](docs/en/architecture/hot-cold-lakehouse.md)**
- **[Guide: Dynamic PLC Catalog & Parameterized Output](docs/en/guides/plc-catalog-and-output.md)**
- **[Guide: Day 1 — PLC to Grafana & Power BI](docs/en/guides/grafana-powerbi.md)**
- **[Guide: i18n, CI & Solo-Maintainer Automation](docs/en/guides/i18n-and-docs-governance.md)**
- **[Security: Multi-Scope Auth, Managed API Keys & Hardening](docs/en/security/api-auth-and-hardening.md)**
- **[API Reference: Bilingual Scalar OpenAPI 3.1](docs/en/api/reference.md)**

---

## Automated Quality Gates & Maintenance

```bash
npm run lint           # TypeScript strict check (tsc --noEmit)
npm run lint:eslint    # ESLint Airbnb style guide (frontend + backend)
npm run lint:code      # Biome Rust linter & formatter check (frontend + backend)
npm run lint:fix       # Auto-fix formatting & lint issues via Biome + ESLint
npm test               # Vitest API, RBAC, Token Lifecycle, Security & i18n suite
npm run build:server   # Compile standalone ESM backend bundle (dist-server/server.mjs)
npm run docs:openapi   # Export static EN/IT OpenAPI 3.1 specs to docs/api/
npm run sync:badges    # Sync config/app.json version, package.json & README badges
npm run check:i18n     # Enforce config/app.json, EN/IT parity, OpenAPI/Scalar drift & links
npm run verify         # Full pre-push gate (TypeCheck + ESLint + Biome + i18n + Tests + Builds)
```
