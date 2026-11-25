<div class="erp-docs-lang-bar">
  <span>Language:</span>
  <strong>EN</strong>
  <span>·</span>
  <a href="../../it/guides/grafana-powerbi.md">IT (Italiano)</a>
</div>

# Day 1 Operations Runbook: PLC → Grafana & Power BI

1. Open the Web Console → **Administration → API Tokens** to issue scoped `X-API-Key` credentials (`pat_live_...` with `read` scope for BI/Grafana and `edge` scope for collectors), or configure service keys (`adm_live_`, `bi_live_`, `gw_live_`) in **Plant Connections**.
2. Add your PLCs from the **PLC Catalog** and click **Probe Endpoint** to verify TCP/HTTP reachability.
3. Open **Grafana** (`:3001`) to inspect the pre-provisioned `PostgreSQL-ML` dashboards (`vw_ba_controllo_gestione_daily`, `ml_machine_features`).
4. Connect **Power BI** via PostgreSQL DirectQuery (`vw_ba_controllo_gestione_daily`, `vw_ba_plant_cost_kpi`) or the RFC 4180 CSV endpoint `/api/v1/ba/kpi?format=csv` using `X-API-Key: pat_live_...` (or `bi_live_...`).
