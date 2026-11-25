# PLCLake — ndustrial Telemetry connector

<p align="center">
  <a href="README.md">English</a> · <strong>Italiano</strong>
</p>

<!-- BADGES:START -->
<p align="center">
  <img src="https://img.shields.io/badge/Versione-v1.0.0-C9A45C?style=flat-square&labelColor=0B1622" alt="Release" />
  <img src="https://img.shields.io/badge/OpenAPI-3.1.0%20%C2%B7%2051%20endpoints-16324F?style=flat-square&labelColor=0B1622&logo=openapiinitiative&logoColor=FFFFFF" alt="OpenAPI" />
  <img src="https://img.shields.io/badge/i18n-EN%20%7C%20IT%20%C2%B7%201194%20chiavi-C9A45C?style=flat-square&labelColor=0B1622&logo=i18next&logoColor=FFFFFF" alt="i18n" />
  <img src="https://img.shields.io/badge/Docs%20Zensical-8%C3%972%20pagine%20EN%2FIT-16324F?style=flat-square&labelColor=0B1622" alt="Docs" />
  <img src="https://img.shields.io/badge/Gate%20CI-ESLint%20%C2%B7%20Biome%20%C2%B7%20Ruff%20%C2%B7%20Vitest-0F6B54?style=flat-square&labelColor=0B1622&logo=githubactions&logoColor=FFFFFF" alt="CI Gate" />
  <br />
  <img src="https://img.shields.io/badge/React-19.0.1-16324F?style=flat-square&labelColor=0B1622&logo=react&logoColor=FFFFFF" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-6.0.3-16324F?style=flat-square&labelColor=0B1622&logo=typescript&logoColor=FFFFFF" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Express-4.21.2-16324F?style=flat-square&labelColor=0B1622&logo=express&logoColor=FFFFFF" alt="Express" />
  <img src="https://img.shields.io/badge/i18next-27.2.6-C9A45C?style=flat-square&labelColor=0B1622" alt="i18next" />
  <img src="https://img.shields.io/badge/Sicurezza-RBAC%20%C2%B7%20AES--256--GCM%20%C2%B7%20scrypt-0F6B54?style=flat-square&labelColor=0B1622" alt="Security" />
</p>
<!-- BADGES:END -->

---

## Panoramica Esecutiva

**PLCLake** è una piattaforma industriale on-premise e hybrid-ready progettata per **Operazioni OT/IT di Stabilimento**, **Machine Learning Predittivo** e **Controllo di Gestione & Finance**. Acquisisce telemetria in tempo reale da asset eterogenei di impianto (Siemens S7-1500, Rockwell ControlLogix, frese CNC, flussimetri gas, compressori e analizzatori di rete), la trasforma in **Feature Mart Lakehouse Hot/Cold** (PostgreSQL 16 + Apache Parquet ZSTD su Garage S3) e fornisce API e dashboard governate, bilingue (**EN / IT**), pronte per **Grafana** e **Power BI**.

### Architettura Industriale Editoriale

- **Piattaforma Integralmente Multilingue (`EN | IT`)**: Basata su `i18next` e `react-i18next`, con commutazione istantanea sincronizzata tra Console Web autenticata, **Documentazione Scalar OpenAPI 3.1** (`/api/v1/docs?lang=it|en`) e **Documentazione Zensical** (`docs/it/` & `docs/en/`).
- **Sistema Visivo Industrial Midnight Steel & Brushed Brass**: Chrome Midnight Steel (`#0B1622`), Blu Acciaio Prussiano (`#16324F`), accenti Ottone Spazzolato (`#C9A45C`), geometria squadrata da `2px` e tabelle editoriali senza bordi esterni con soli divisori orizzontali hairline.
- **Governance API-First, Token & RBAC**: Ciclo di vita completo delle chiavi `X-API-Key` (`pat_live_...`) salvate come hash SHA-256 cifrati AES-256-GCM, event subscriber automatico `SecretManagement` → `AuditLogSystem`, pulsante interattivo 1h sullo Scalar e viste amministrative **Utenti** e **Ruoli e Permessi** separate (10 viste RBAC).
- **Automazione Snella per Singolo Maintainer**: **ESLint (Airbnb style guide)** e **Biome** in Rust (frontend + backend TS/React), **Ruff** (Python Edge Gateway), **Husky** (`.husky/pre-commit`) + **`lint-staged`**, `.gitlab-ci.yml`, `renovate.json` e gate CI automatico su parità EN/IT e drift OpenAPI/Scalar (`npm run check:i18n`).

---

## Avvio Rapido

```bash
cp .env.example .env
npm install
npm run hooks:install
npm run dev
```

Oppure avvia lo stack completo di produzione (PLCLake + PostgreSQL 16 + Mailpit + Prometheus + Grafana) con Docker:

```bash
docker compose up -d --build
```

| Servizio | URL |
| :--- | :--- |
| **Console Web (IT / EN)** | `http://localhost:3000` |
| **API Versione Centralizzata** | `http://localhost:3000/api/v1/version` |
| **Scalar OpenAPI 3.1 (IT)** | `http://localhost:3000/api/v1/docs?lang=it` |
| **Scalar OpenAPI 3.1 (EN)** | `http://localhost:3000/api/v1/docs?lang=en` |
| **Specifica OpenAPI 3.1 JSON** | `http://localhost:3000/api/v1/openapi.json?lang=it` |
| **Metriche Prometheus** | `http://localhost:3000/api/v1/metrics` |

---

## Documentazione & Governance Autonoma

Tutta la documentazione tecnica è rispecchiata 1:1 in Italiano e Inglese sotto `docs/it/` e `docs/en/` e pubblicata con **Zensical**:

- **[Hub Documentazione (EN / IT)](docs/index.md)**
- **[Architettura: Topologia OT/IT & Edge Gateway](docs/it/architecture/ot-it-topology.md)**
- **[Architettura: Hot/Cold Lakehouse & Big Data](docs/it/architecture/hot-cold-lakehouse.md)**
- **[Guida: Catalogo PLC Dinamico & Output Parametrizzabile](docs/it/guides/plc-catalog-and-output.md)**
- **[Guida: Giorno 1 — PLC verso Grafana & Power BI](docs/it/guides/grafana-powerbi.md)**
- **[Guida: Governance i18n, CI & Automazione Maintainer](docs/it/guides/i18n-and-docs-governance.md)**
- **[Sicurezza: Auth Multi-Scope, API Key Gestite & Hardening](docs/it/security/api-auth-and-hardening.md)**
- **[API Reference: Scalar OpenAPI 3.1 Bilingue](docs/it/api/reference.md)**

---

## Controlli Automatici di Qualità & CI

```bash
npm run lint           # Typecheck TypeScript rigoroso (tsc --noEmit)
npm run lint:eslint    # ESLint Airbnb style guide (frontend + backend)
npm run lint:code      # Biome linter & formatter in Rust (frontend + backend)
npm run lint:fix       # Correzione automatica stile e lint con Biome + ESLint
npm test               # Suite Vitest (API, RBAC, Token Lifecycle, Sicurezza & i18n)
npm run build:server   # Compila il bundle backend ESM standalone (dist-server/server.mjs)
npm run docs:openapi   # Esporta specifiche OpenAPI 3.1 statiche EN/IT in docs/api/
npm run sync:badges    # Allinea versione config/app.json, package.json e badge README
npm run check:i18n     # Verifica config/app.json, parità EN/IT, drift OpenAPI/Scalar e link
npm run verify         # Gate completo pre-push (TypeCheck + ESLint + Biome + i18n + Test + Build)
```
