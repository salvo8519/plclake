<div class="erp-docs-lang-bar">
  <span>Lingua:</span>
  <strong>IT</strong>
  <span>·</span>
  <a href="../../en/api/reference.md">EN (English)</a>
</div>

# API Reference & Scalar OpenAPI 3.1

La specifica bilingue **OpenAPI 3.1.0** (**50 rotte tipizzate**) viene generata dagli schemi **Zod** (`src/apiSchemas.ts`) e dai cataloghi i18n condivisi (`src/i18n/locales/{en,it}/openapi.json`) tramite `npm run docs:openapi` e verificata automaticamente contro gli export statici in CI (`npm run check:i18n`).

- **Autenticazione Predefinita**: `X-API-Key: pat_live_...` (`ApiKeyHeaderAuth`, gestita in **Amministrazione → Token API** oppure emessa per 1 ora dal pulsante **Chiave API / Test** sullo Scalar live).
- **Documentazione Interattiva Live**: `http://<host>:3000/api/v1/docs?lang=it`
- **OpenAPI 3.1 JSON (IT)**: [Scarica `openapi.it.json`](../../api/openapi.it.json)
- **Viewer Scalar Editoriale Fullscreen (IT)**: [Apri Scalar a schermo intero](../../api/scalar.html?lang=it){ target="_blank" }

---

## Come Interrogare ed Estrarre i Dati Salvati tramite API REST

Sì — le API REST fungono sia da **gateway di ingestione** (i Gateway Edge inviano i batch dai PLC) sia da **interfaccia di query ed estrazione** (Power BI, ERP, script Python o sistemi esterni leggono KPI, finestre ML, buffer log e audit). Ogni chiamata protetta invia la chiave nell'header `X-API-Key` (oppure `Authorization: Bearer pat_live_...`).

### 1. Query KPI Business Analytics (JSON o CSV)

Interroga automaticamente la vista PostgreSQL `vw_ba_controllo_gestione_daily` quando `DATABASE_URL` è attivo (con fallback sullo snapshot live in sviluppo locale):

```bash
# Query JSON con filtri dominio, intervallo date e selezione colonne
curl -sS "http://localhost:3000/api/v1/ba/kpi?domain=manufacturing&fromDate=2026-01-01&toDate=2026-12-31&fields=dt,machine_id,availability_oee_pct,primary_metric_avg" \
  -H "X-API-Key: pat_live_LA_TUA_CHIAVE_READ"

# Export CSV pronto per Power BI ("Recupera dati -> Web") o Excel
curl -sS "http://localhost:3000/api/v1/ba/kpi?format=csv" \
  -H "X-API-Key: pat_live_LA_TUA_CHIAVE_READ" -o ba_kpi_export.csv
```

### 2. Lettura Snapshot Run, Finestre ML, Buffer Log Completo e Quarantena

```bash
# Ultima run attiva/completata (include features[], recentLogs[], quarantineRecords[], segments[])
curl -sS "http://localhost:3000/api/v1/pipeline/runs/latest" \
  -H "X-API-Key: pat_live_LA_TUA_CHIAVE_READ"

# Run specifica per ID oppure stream live Server-Sent Events (SSE)
curl -sS "http://localhost:3000/api/v1/pipeline/runs/<runId>" \
  -H "X-API-Key: pat_live_LA_TUA_CHIAVE_READ"
curl -N "http://localhost:3000/api/v1/pipeline/runs/<runId>/stream" \
  -H "X-API-Key: pat_live_LA_TUA_CHIAVE_READ"
```

### 3. Invio Batch Telemetrici Esterni da PLC / Edge Gateway (Scope: `edge`)

```bash
curl -X POST "http://localhost:3000/api/v1/ingest/batch" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: pat_live_LA_TUA_CHIAVE_EDGE" \
  -d '{
    "events": [
      {
        "event_id": "evt-line01-0001",
        "timestamp": "2026-06-15T10:15:00.000Z",
        "machine_id": "M-01",
        "line_id": "line-01",
        "machine_type": "siemens-s7-1500",
        "domain": "manufacturing",
        "state": "RUNNING",
        "level": "INFO",
        "metrics": { "temp_c": 64.2, "cycle_ms": 945, "vibration_mm_s": 1.42 }
      }
    ]
  }'
```

### 4. Esportazione Registro Audit Immutabile

```bash
curl -sS "http://localhost:3000/api/v1/audit?limit=100&format=csv" \
  -H "X-API-Key: pat_live_LA_TUA_CHIAVE_READ" -o audit_log.csv
```

> **Alternativa SQL / BI Diretta**: Per analisi storiche su milioni di righe, collega Grafana, Power BI o DuckDB direttamente a PostgreSQL (`ml_machine_features`, `vw_ba_controllo_gestione_daily`, `vw_ba_plant_cost_kpi`) oppure interroga le partizioni Parquet su Garage S3. Vedi [Hot/Cold Lakehouse & Storage](../architecture/hot-cold-lakehouse.md).

---

<div class="erp-scalar-frame">
  <iframe
    src="../../../api/scalar.html?lang=it"
    title="Industrial Telemetry OpenAPI 3.1 Scalar Reference (IT)"
    style="width: 100%; height: 100%; border: 0;"
    loading="lazy"
  ></iframe>
</div>
