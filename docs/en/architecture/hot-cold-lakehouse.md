<div class="erp-docs-lang-bar">
  <span>Language:</span>
  <strong>EN</strong>
  <span>·</span>
  <a href="../../it/architecture/hot-cold-lakehouse.md">IT (Italiano)</a>
</div>

# Hot/Cold Lakehouse & Big Data Volume Management

The architecture implements a **Hot / Cold Tiering** model built on open industry formats (**Apache Parquet ZSTD** + **partitioned PostgreSQL 16**), ensuring frictionless interoperability with Power BI, Databricks, Snowflake, Microsoft Fabric, and SAP Datasphere.

---

## Why DuckDB + Parquet + Partitioned PostgreSQL?

1. **Solving the "Small Files Problem"**: periodic DuckDB compaction (`part-compacted-00000.parquet` with **ZSTD** compression) keeps columnar scans fast and inexpensive.
2. **Zero-Cost Hot Tier Pruning**: `ml_machine_features` uses declarative `PARTITION BY RANGE (dt)`. `prune_hot_feature_partitions(retention_days)` drops expired partitions via instant `DROP TABLE` with zero production locks.
3. **Anti-Leakage ML Labeling**: `will_fail_next_window` is computed with strict temporal lead (`t + horizonWindows`) and materialized only after the subsequent window closes.

---

## Where Saved Data Actually Lands (Dev vs. Production)

| Data Asset | Production (`DATABASE_URL` + Garage S3) | Local Dev Fallback (No Postgres) | How to Read / Extract |
| :--- | :--- | :--- | :--- |
| **ML Feature Windows** | PostgreSQL 16 table `ml_machine_features` (Hot Tier) + ZSTD Parquet on Garage S3 (Cold Tier) | Active run memory snapshot (`LiveRunManager`) | `GET /api/v1/pipeline/runs/latest`, SQL query on `ml_machine_features`, or Workbench CSV export |
| **BA / OEE / Energy KPIs** | PostgreSQL views `vw_ba_controllo_gestione_daily` & `vw_ba_plant_cost_kpi` | Aggregated on-the-fly from active run snapshot | `GET /api/v1/ba/kpi?format=json\|csv` or direct Grafana / Power BI SQL |
| **Raw Telemetry & Quarantine** | Edge Gateway SQLite WAL spool → rotated JSONL segments → Garage S3 archive | Active run ring buffer (`recentLogs[]`, `quarantineRecords[]`) | Click any row in **Live Simulation → Full Log Buffer** or `GET /api/v1/pipeline/runs/:id` |
| **Control-Plane Config, Users, API Keys, Connections, Alerts** | PostgreSQL table `control_plane_state` (JSONB; secrets AES-256-GCM encrypted) | Local disk JSON files in `.state/` (`job-config.json`, `connections.json`, `auth-users.json`, `alerts-config.json`, `plc-catalog.json`) | Dedicated REST endpoints (`/api/v1/job/config`, `/api/v1/connections`, `/api/v1/tokens`, etc.) |
| **Immutable Audit Trail** | PostgreSQL table `audit_log` | `.state/audit-log.json` | `GET /api/v1/audit?format=json\|csv` |

---

## Indicative Volume Sizing

| Plant Fleet | Sampling Rate | Events / Day | Raw JSON / Month | Parquet ZSTD (Cold / Year) |
| :--- | :--- | :--- | :--- | :--- |
| **10 PLCs / Meters** | 1 sample / 5s | ~172,800 | ~1.3 GB | ~1.4 GB |
| **50 PLCs / Meters** | 1 sample / 2s | ~2,160,000 | ~16 GB | ~16 GB |
| **200 PLCs / Meters** | 1 sample / 1s | ~17,280,000 | ~128 GB | ~125 GB |
