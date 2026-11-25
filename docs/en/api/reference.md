<div class="erp-docs-lang-bar">
  <span>Language:</span>
  <strong>EN</strong>
  <span>·</span>
  <a href="../../it/api/reference.md">IT (Italiano)</a>
</div>

# API Reference & Scalar OpenAPI 3.1

The bilingual **OpenAPI 3.1.0** specification (**50 typed routes**) is generated from **Zod** schemas (`src/apiSchemas.ts`) and shared i18n catalogs (`src/i18n/locales/{en,it}/openapi.json`) via `npm run docs:openapi`, and automatically verified against static exports in CI (`npm run check:i18n`).

- **Preferred Authentication**: `X-API-Key: pat_live_...` (`ApiKeyHeaderAuth`, managed via **Administration → API Tokens** or minted for 1 hour via the live Scalar **API Key / Test Auth** button).
- **Live Interactive Reference**: `http://<host>:3000/api/v1/docs?lang=en`
- **OpenAPI 3.1 JSON (EN)**: [Download `openapi.en.json`](../../api/openapi.en.json)
- **Fullscreen Editorial Scalar Viewer (EN)**: [Open Scalar Fullscreen](../../api/scalar.html?lang=en){ target="_blank" }

---

## How to Query & Extract Saved Data via REST API

Yes — the REST API is both the **ingestion gateway** (Edge Gateways pushing PLC batches in) and the **query/extraction interface** (Power BI, ERP, Python notebooks, or scripts pulling KPIs, ML windows, raw log buffers, and audit records out). Every protected call sends your key in the `X-API-Key` header (or `Authorization: Bearer pat_live_...`).

### 1. Query Business Analytics KPIs (JSON or CSV)

Queries PostgreSQL view `vw_ba_controllo_gestione_daily` automatically when `DATABASE_URL` is configured (falling back to the active live snapshot in local dev):

```bash
# JSON query with domain, date range, and field projection
curl -sS "http://localhost:3000/api/v1/ba/kpi?domain=manufacturing&fromDate=2026-01-01&toDate=2026-12-31&fields=dt,machine_id,availability_oee_pct,primary_metric_avg" \
  -H "X-API-Key: pat_live_YOUR_READ_KEY"

# CSV export ready for Power BI ("Get Data -> Web") or Excel
curl -sS "http://localhost:3000/api/v1/ba/kpi?format=csv" \
  -H "X-API-Key: pat_live_YOUR_READ_KEY" -o ba_kpi_export.csv
```

### 2. Fetch Live Run Snapshots, ML Feature Windows, Full Log Buffer & Quarantine

```bash
# Latest run snapshot (includes features[], recentLogs[], quarantineRecords[], segments[])
curl -sS "http://localhost:3000/api/v1/pipeline/runs/latest" \
  -H "X-API-Key: pat_live_YOUR_READ_KEY"

# Specific run by ID or real-time Server-Sent Events (SSE) stream
curl -sS "http://localhost:3000/api/v1/pipeline/runs/<runId>" \
  -H "X-API-Key: pat_live_YOUR_READ_KEY"
curl -N "http://localhost:3000/api/v1/pipeline/runs/<runId>/stream" \
  -H "X-API-Key: pat_live_YOUR_READ_KEY"
```

### 3. Push External PLC / Edge Telemetry Batches (Scope: `edge`)

```bash
curl -X POST "http://localhost:3000/api/v1/ingest/batch" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: pat_live_YOUR_EDGE_KEY" \
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

### 4. Export Immutable Security & Operations Audit Logs

```bash
curl -sS "http://localhost:3000/api/v1/audit?limit=100&format=csv" \
  -H "X-API-Key: pat_live_YOUR_READ_KEY" -o audit_log.csv
```

> **Direct BI / SQL Alternative**: For heavy historical analytics across millions of rows, connect Grafana, Power BI, or DuckDB directly to PostgreSQL (`ml_machine_features`, `vw_ba_controllo_gestione_daily`, `vw_ba_plant_cost_kpi`) or query compacted Parquet partitions on Garage S3. See [Hot/Cold Lakehouse Storage](../architecture/hot-cold-lakehouse.md).

---

<div class="erp-scalar-frame">
  <iframe
    src="../../../api/scalar.html?lang=en"
    title="Industrial Telemetry OpenAPI 3.1 Scalar Reference (EN)"
    style="width: 100%; height: 100%; border: 0;"
    loading="lazy"
  ></iframe>
</div>
