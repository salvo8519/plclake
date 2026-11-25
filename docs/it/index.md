<div class="erp-docs-lang-bar">
  <span>Lingua:</span>
  <strong>IT</strong>
  <span>·</span>
  <a href="../en/index.md">EN (English)</a>
</div>

# PLCLake — Industrial Telemetry & ML Lakehouse

Piattaforma industriale **On-Premise / Hybrid Ready** per l'acquisizione telemetrica da PLC e contatori industriali (Manufacturing, Gas Metering, Power Generation), la trasformazione incrementale in Feature Mart per Machine Learning & Business Analytics e la pubblicazione verso **Grafana** e **Power BI**.

---

## Pilastri Progettuali

| Pilastro | Scelta Tecnica | Beneficio per IT, OT e Controllo di Gestione |
| :--- | :--- | :--- |
| **Zero Over-Engineering** | Python + DuckDB + Parquet + PostgreSQL 16 + Garage S3 | Stack moderno, standard industriale, costi infrastrutturali minimi, zero cluster Kafka/Spark da mantenere in impianto. |
| **Separazione Hot / Cold** | PostgreSQL partizionato per data (`dt`) + S3 Parquet ZSTD compattato | Query BI e Grafana istantanee sugli ultimi 90 giorni; storico pluriennale compresso 8–12x pronto per Big Data / Databricks / Fabric. |
| **Catalogo PLC Dinamico** | Registro persistente `/api/v1/catalog/machines` con 8 preset + profili custom | Output parametrizzabile per famiglia di PLC (Siemens, Rockwell, CNC, Gas, Power) con canali extra e formule BA configurabili. |
| **Plug & Play in Rete Aziendale** | Edge Collector con SQLite WAL Spool + Auto-Sync via HTTP | Zero perdita dati in caso di caduta VPN/WAN; aggiunta di nuovi PLC dalla Console Web senza riavviare container. |
| **Governance API-First & Sicurezza** | 50 rotte OpenAPI 3.1 da Zod + `X-API-Key` gestite (`pat_live_...`) + Audit Subscriber + 10 viste RBAC | Contratti tipizzati, hash cifrati AES-256-GCM, tracciamento automatico `SecretManagement` → `AuditLogSystem`, viste Utenti e Ruoli separate e Scalar bilingue interattivo. |

---

## Come Navigare Questa Documentazione

1. **[Topologia OT/IT & Edge Gateway](architecture/ot-it-topology.md)** — Come connettersi ai PLC aziendali via LAN diretta, VPN Site-to-Site o Edge Push.
2. **[Hot/Cold Lakehouse & Big Data](architecture/hot-cold-lakehouse.md)** — Partizionamento, compattazione DuckDB, svecchiamento partizioni e compatibilità con ecosistemi Enterprise.
3. **[Catalogo PLC & Output Parametrizzabile](guides/plc-catalog-and-output.md)** — Come registrare nuovi PLC, definire canali extra e selezionare i campi di output.
4. **[Giorno 1: PLC -> Grafana & Power BI](guides/grafana-powerbi.md)** — Checklist operativa pronta all'uso per collegare dashboard Grafana e modelli Power BI.
5. **[Governance i18n, CI & Manutenzione](guides/i18n-and-docs-governance.md)** — Controlli automatici Biome & Ruff, hook pre-commit, pipeline GitLab CI, Renovate, parità EN/IT e drift check OpenAPI/Scalar.
6. **[Auth Multi-Scope, API Key & Hardening](security/api-auth-and-hardening.md)** — Chiavi `X-API-Key` gestite (`pat_live_...`), chiavi di servizio (`adm_live_`, `bi_live_`, `gw_live_`), crittografia AES-256-GCM / `scrypt`, eventi audit automatici e hardening di rete.
7. **[API Reference & Scalar OpenAPI 3.1](api/reference.md)** — Specifica interattiva bilingue con rilascio chiavi sandbox 1h tracciate in audit.
