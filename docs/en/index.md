<div class="erp-docs-lang-bar">
  <span>Language:</span>
  <strong>EN</strong>
  <span>·</span>
  <a href="../it/index.md">IT (Italiano)</a>
</div>

# PLCLake — Industrial Telemetry & ML Lakehouse

**On-Premise / Hybrid-Ready** industrial platform for PLC and industrial meter telemetry acquisition (Manufacturing, Gas Metering, Power Generation), incremental transformation into ML & Business Analytics Feature Marts, and real-time publishing to **Grafana** and **Power BI**.

---

## Architectural Pillars

| Pillar | Technical Choice | Value for IT, OT & Finance Controlling |
| :--- | :--- | :--- |
| **Zero Over-Engineering** | Python + DuckDB + Parquet + PostgreSQL 16 + Garage S3 | Modern industrial stack with minimal infrastructure footprint and zero Kafka/Spark clusters to maintain on the plant floor. |
| **Hot / Cold Tiering** | Date-partitioned PostgreSQL (`dt`) + compacted ZSTD Parquet on S3 | Instant Grafana & BI queries over the last 90 days; multi-year history compressed 8–12x ready for Databricks, Fabric, or Snowflake. |
| **Dynamic PLC Catalog** | Persistent `/api/v1/catalog/machines` registry with 8 factory presets + custom profiles | Parameterized output per PLC family (Siemens, Rockwell, CNC, Gas, Power) with extra channels and configurable BA formulas. |
| **Plug & Play Plant Networking** | Edge Collector with SQLite WAL Spool + HTTP Auto-Sync | Zero data loss during WAN/VPN outages; add new PLCs from the Web Console without restarting edge containers. |
| **API-First Governance & Security** | 50 OpenAPI 3.1 routes from Zod + Managed `X-API-Key` (`pat_live_...`) + Automated Audit Subscriber + 10 RBAC views | Typed contracts, AES-256-GCM encrypted key hashes, automated `SecretManagement` → `AuditLogSystem` event trail, separate Users & Roles sections, and bilingual Scalar interactive docs. |

---

## Navigating This Documentation

1. **[OT/IT Topology & Edge Gateway](architecture/ot-it-topology.md)** — Connecting plant PLCs via Direct LAN, Site-to-Site VPN, or Outbound Edge Push.
2. **[Hot/Cold Lakehouse & Big Data](architecture/hot-cold-lakehouse.md)** — Partitioning, DuckDB compaction, zero-lock pruning, and Enterprise Lakehouse interoperability.
3. **[PLC Catalog & Parameterized Output](guides/plc-catalog-and-output.md)** — Registering custom PLCs, extra telemetry channels, and output contract dry-runs.
4. **[Day 1: PLC to Grafana & Power BI](guides/grafana-powerbi.md)** — Step-by-step operational runbook for connecting Grafana dashboards and Power BI models.
5. **[i18n, CI & Maintenance Governance](guides/i18n-and-docs-governance.md)** — Automated Biome & Ruff checks, pre-commit hooks, GitLab CI, Renovate, EN/IT parity, and OpenAPI/Scalar drift gates.
6. **[Multi-Scope Auth, API Keys & Hardening](security/api-auth-and-hardening.md)** — Managed `X-API-Key` (`pat_live_...`), legacy scoped keys (`adm_live_`, `bi_live_`, `gw_live_`), AES-256-GCM / `scrypt` storage, automated audit events, and outbound network hardening.
7. **[API Reference & Scalar OpenAPI 3.1](api/reference.md)** — Interactive white-label bilingual OpenAPI 3.1 explorer with 1-hour audited sandbox keys.
