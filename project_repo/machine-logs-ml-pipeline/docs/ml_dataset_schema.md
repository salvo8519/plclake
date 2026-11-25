# Schema Dati: Raw Events, Contract, Quarantena e Feature ML

## 1. Telemetry Contract (`telemetry_contract.json`)
Emesso dal producer all'avvio per allineare il calcolo di `valid_sample_ratio` e `missing_heartbeat_count`:
- `machine_count`: numero di asset attivi.
- `rate_hz`: frequenza aggregata di emissione.
- `expected_sample_sec`: intervallo atteso per singola macchina (`(1 / rate_hz) * machine_count`).

## 2. Schema Evento Raw (`telemetry.jsonl` & `segments/telemetry.*.jsonl`)
| Campo | Tipo | Vincoli / Valori | Note |
| :--- | :--- | :--- | :--- |
| `event_id` | `string` | Non vuoto, univoco | Chiave di deduplicazione |
| `timestamp` | `string (ISO-8601 UTC)` | Parseabile in UTC | Puo arrivare out-of-order |
| `machine_id` | `string` | Non vuoto (es. `M-01`) | Solo nel body JSON, mai label Loki |
| `line_id` | `string` | Es. `line-01`, `line-02` | Label Loki a bassa cardinalita |
| `machine_type` | `string` | Es. `plc-controller`, `cnc-mill` | Label Loki a bassa cardinalita |
| `state` | `string` | `IDLE`, `RUNNING`, `DEGRADED`, `FAULT`, `MAINTENANCE` | Stato operativo macchina |
| `error_code` | `string \| null` | Es. `ERR-104` o `null` | Valorizzato in `FAULT` |
| `temp_c` | `float` | `[-50.0, 250.0]` | Temperatura operativa (C) |
| `vibration_mm_s` | `float` | `[0.0, 100.0]` | Vibrazione RMS (mm/s) |
| `cycle_ms` | `integer` | `> 0` | Durata ciclo macchina (ms) |
| `payload_valid` | `boolean` | `true` | Flag di conformita sorgente |
| `level` | `string` | `INFO`, `WARN`, `ERROR` | Derivato dallo stato; label Loki |

## 3. Schema Dataset ML-Ready (`ml_machine_features` / Parquet)
Partizionamento su filesystem e RustFS (`s3://machine-ml/features/<dataset_version>/`):
`dt=YYYY-MM-DD/machine_id=<machine_id>/part-00000.parquet` (merge incrementale su `(window_start, window_minutes)`).

Chiave primaria su PostgreSQL: `(machine_id, window_start, window_minutes)`.

| Colonna | Tipo | Descrizione |
| :--- | :--- | :--- |
| `machine_id` | `string` | Identificativo macchina |
| `window_start` | `timestamp[tz=UTC]` | Inizio finestra temporale troncata a `window_minutes` |
| `window_minutes` | `int32` | Ampiezza finestra di aggregazione |
| `dt` | `string (YYYY-MM-DD)` | Data partizione |
| `line_id` / `machine_type` | `string` | Dimensioni operative prevalenti |
| `sample_count` | `int32` | Eventi validi deduplicati nella finestra |
| `valid_sample_ratio` | `float64` | Rapporto campioni ricevuti / attesi da `telemetry_contract.json` |
| `temp_mean` / `temp_max` | `float64` | Temperatura media e massima (C) |
| `vibration_mean` / `p95` / `max` | `float64` | Statistiche vibrazione (mm/s) |
| `cycle_ms_mean` / `std` | `float64` | Durata media e deviazione standard ciclo (ms) |
| `error_count` / `fault_count` / `degraded_count` | `int32` | Conteggi anomalie nella finestra corrente |
| `state_transitions_count` | `int32` | Transizioni cronologiche di stato |
| `time_in_fault_sec` | `float64` | Durata stimata in stato `FAULT` (s) |
| `missing_heartbeat_count` | `int32` | Campioni mancanti rispetto al contract |
| `is_anomalous_window` | `int32` | Anomaly detection sulla finestra corrente (`0/1`) |
| `will_fail_next_window` | `int32 \| null` | **Target anti-leakage**: indica se la finestra futura `t + horizon` sara anomala (`0/1`, `NULL` sull'ultima finestra aperta) |
| `dataset_version` | `string` | Versione schema/pipeline |
