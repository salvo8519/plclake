<div class="erp-docs-lang-bar">
  <span>Lingua:</span>
  <strong>IT</strong>
  <span>·</span>
  <a href="../../en/guides/grafana-powerbi.md">EN (English)</a>
</div>

# Guida Operativa Giorno 1: PLC → Grafana & Power BI

1. Apri la Console Web → **Amministrazione → Token API** per generare chiavi `X-API-Key` dedicate (`pat_live_...` con scope `read` per BI/Grafana ed `edge` per i collector), oppure configura le chiavi di servizio (`adm_live_`, `bi_live_`, `gw_live_`) in **Connessioni Impianto**.
2. Aggiungi i PLC dal **Catalogo PLC** e premi **Probe Endpoint** per verificare la raggiungibilità TCP/HTTP.
3. Apri **Grafana** (`:3001`) per visualizzare le dashboard pre-provisionate su `PostgreSQL-ML` (`vw_ba_controllo_gestione_daily`, `ml_machine_features`).
4. Collega **Power BI** via PostgreSQL DirectQuery (`vw_ba_controllo_gestione_daily`, `vw_ba_plant_cost_kpi`) oppure tramite endpoint CSV RFC 4180 `/api/v1/ba/kpi?format=csv` con header `X-API-Key: pat_live_...` (o `bi_live_...`).
