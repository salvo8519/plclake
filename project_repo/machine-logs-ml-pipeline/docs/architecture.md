# Architettura di Produzione: Machine Logs & ML Feature Pipeline

## 1. Panoramica
Il sistema implementa una pipeline modulare e riutilizzabile in produzione per acquisizione, osservabilita real-time e costruzione incrementale di feature ML da log industriali/PLC.

```
+--------------------+     rotating segments    +---------------+      HTTP Push      +------+
|  Machine Simulator | -----------------------> | Grafana Alloy | ------------------> | Loki |
+--------------------+  telemetry*.jsonl        +---------------+                     +------+
         |                                                                               |
         | telemetry_contract.json + quarantine.jsonl                                    | LogQL
         v                                                                               v
+--------------------+     incremental Parquet  +--------+     SQL / Provisioning   +---------+
|  Dataset Builder   | -----------------------> | RustFS | <----------------------- | Grafana |
| (DuckDB+Watermark) |                          +--------+                          +---------+
+--------------------+
         |
         | Upsert idempotente (runs, watermarks & horizon labels)
         v
+--------------------+
|     PostgreSQL     |
+--------------------+
```

## 2. Componenti Principali

### 2.1 Machine Log Simulator (`src/simulator/main.py`)
- Modella piu linee (`line-01`, `line-02`, ...) e profili macchina con cadenza ad alto volume (`--rate-hz`, `--duration-minutes`, es. 15–30 minuti continui).
- Scrive `telemetry_contract.json` per dichiarare numero macchine e cadenza attesa (`expected_sample_sec`), evitando disallineamenti a valle.
- Gestisce rotazione automatica dei file (`--rotate-max-lines`) in `segments/telemetry.<ts>.<seq>.jsonl` con upload incrementale su RustFS (`machine-raw`) e quarantena deduplicata tramite hash SHA-256.

### 2.2 Osservabilita: Grafana Alloy, Loki e Grafana
- **Grafana Alloy** (`deploy/alloy/config.alloy`): osserva sia `telemetry*.jsonl` che i segmenti ruotati `segments/telemetry.*.jsonl`, promuovendo solo label a cardinalita controllata (`env`, `service`, `line_id`, `machine_type`, `level`).
- **Politica Anti-High Cardinality**: `machine_id`, `event_id`, `timestamp` e le metriche numeriche restano nel payload JSON e vengono estratti a query time (`| json`).
- **Grafana**: provisioning dichiarativo senza interventi manuali.

### 2.3 Incremental Dataset Builder & Feature Store (`src/dataset_builder/build_dataset.py`)
- **Checkpointing & Event-Time Watermark**: legge esclusivamente segmenti nuovi e il byte-offset corrente del log attivo; mantiene uno staging store Parquet interrogato via **DuckDB** e ricalcola le finestre entro `[high_watermark_ts - lookback]` per assorbire eventi tardivi/out-of-order.
- **Anti-Leakage Target (`will_fail_next_window`)**: oltre a `is_anomalous_window` (stato della finestra corrente), calcola la label predittiva shiftata a $t + \text{horizon\_windows}$ per modelli di predictive maintenance senza target leakage.
- **Worker Continuo & Secrets Esternalizzati**: configurabile via `.env` (`docker-compose.yml` con fallback sicuri per sviluppo locale) ed eseguibile sia in modalita micro-batch continua (`--watch-interval-sec`) che one-shot (`--once`).
