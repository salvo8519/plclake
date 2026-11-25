<div class="erp-docs-lang-bar">
  <span>Lingua:</span>
  <strong>IT</strong>
  <span>·</span>
  <a href="../../en/architecture/hot-cold-lakehouse.md">EN (English)</a>
</div>

# Hot/Cold Lakehouse & Gestione Volumi Big Data

L'architettura adotta un modello **Hot / Cold Tiering** basato su formati aperti standard (**Apache Parquet ZSTD** + **PostgreSQL 16 partizionato**), compatibile con Power BI, Databricks, Snowflake, Microsoft Fabric e SAP Datasphere.

---

## Perché DuckDB + Parquet + PostgreSQL Partizionato?

1. **Risoluzione dello "Small Files Problem"**: compattazione periodica via DuckDB (`part-compacted-00000.parquet` con compressione **ZSTD**) per mantenere letture colonnari rapidissime.
2. **Svecchiamento Hot Tier a costo zero**: `ml_machine_features` usa `PARTITION BY RANGE (dt)`. `prune_hot_feature_partitions(retention_days)` elimina le partizioni scadute tramite `DROP TABLE` istantaneo senza lock in produzione.
3. **Anti-Leakage per Machine Learning**: `will_fail_next_window` è calcolato con lead temporale stretto (`t + horizonWindows`) e aggiornato solo al consolidamento della finestra successiva.

---

## Dove Finiscono Effettivamente i Dati Salvati (Sviluppo vs. Produzione)

| Tipologia Dato | Produzione (`DATABASE_URL` + Garage S3) | Fallback Sviluppo Locale (Senza Postgres) | Come Leggerli / Estrarli |
| :--- | :--- | :--- | :--- |
| **Finestre ML Feature** | Tabella PostgreSQL 16 `ml_machine_features` (Hot Tier) + Parquet ZSTD su Garage S3 (Cold Tier) | Snapshot in memoria della run attiva (`LiveRunManager`) | `GET /api/v1/pipeline/runs/latest`, query SQL su `ml_machine_features` oppure export CSV da Workbench |
| **KPI BA / OEE / Energia** | Viste PostgreSQL `vw_ba_controllo_gestione_daily` e `vw_ba_plant_cost_kpi` | Aggregati al volo dallo snapshot della run attiva | `GET /api/v1/ba/kpi?format=json\|csv` oppure Grafana / Power BI diretto su PostgreSQL |
| **Log Grezzi e Quarantena** | Spool SQLite WAL su Edge Gateway → segmenti JSONL ruotati → archivio Garage S3 | Buffer circolare della run attiva (`recentLogs[]`, `quarantineRecords[]`) | Click su una riga in **Simulazione Live → Buffer Log Completo** oppure `GET /api/v1/pipeline/runs/:id` |
| **Configurazione, Utenti, Chiavi API, Connessioni, Alert** | Tabella PostgreSQL `control_plane_state` (JSONB; segreti cifrati AES-256-GCM) | File JSON locali in `.state/` (`job-config.json`, `connections.json`, `auth-users.json`, `alerts-config.json`, `plc-catalog.json`) | Endpoint REST dedicati (`/api/v1/job/config`, `/api/v1/connections`, `/api/v1/tokens`, ecc.) |
| **Registro Audit Immutabile** | Tabella PostgreSQL `audit_log` | `.state/audit-log.json` | `GET /api/v1/audit?format=json\|csv` |

---

## Stima Orientativa dei Volumi

| Flotta Impianto | Frequenza | Eventi / Giorno | Raw JSON / Mese | Parquet ZSTD (Cold / Anno) |
| :--- | :--- | :--- | :--- | :--- |
| **10 PLC / Contatori** | 1 camp / 5s | ~172.800 | ~1,3 GB | ~1,4 GB |
| **50 PLC / Contatori** | 1 camp / 2s | ~2.160.000 | ~16 GB | ~16 GB |
| **200 PLC / Contatori** | 1 camp / 1s | ~17.280.000 | ~128 GB | ~125 GB |
