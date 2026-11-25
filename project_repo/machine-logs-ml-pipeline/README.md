# machine-logs-ml-pipeline

Production-ready, Docker-reproducible industrial telemetry & ML feature store pipeline:

- **High-Throughput Simulator (`src/simulator/main.py`)**: emits structured JSON logs (`IDLE`, `RUNNING`, `DEGRADED`, `FAULT`, `MAINTENANCE`) with thermal/vibration drift, spikes, out-of-order timestamps, malformed records, log segment rotation (`segments/telemetry.*.jsonl`), and `telemetry_contract.json`.
- **Observability (`Alloy -> Loki -> Grafana`)**: watches active + rotated segments with strict low-cardinality stream labels (`env`, `service`, `line_id`, `machine_type`, `level`) and zero-click Grafana provisioning.
- **Incremental Dataset Builder (`src/dataset_builder/build_dataset.py`)**: tracks byte offsets and rotated segments via `builder_checkpoint.json`, uses DuckDB staging + event-time watermark lookback for late arrivals, writes idempotent Parquet partitions on **RustFS**, and upserts **PostgreSQL** with both `is_anomalous_window` and anti-leakage `will_fail_next_window` lead labels.

## Quickstart

```bash
# Optional: customize secrets & throughput for staging/production
cp .env.example .env

# 1. Run automated unit & integration tests inside Docker
make test

# 2. Start all 7 services (RustFS, PostgreSQL, Loki, Alloy, Grafana, Simulator, Dataset Builder Worker)
make up

# 3. Trigger an immediate one-shot incremental dataset build
make build-dataset
```

## Endpoints

- **Grafana**: `http://localhost:3000` (`admin` / `admin`)
- **RustFS Console**: `http://localhost:9001` (`rustfsadmin` / `rustfsadmin`)
- **Loki API**: `http://localhost:3100/ready`
- **Alloy UI**: `http://localhost:12345`
- **PostgreSQL**: `postgresql://mlops:mlops@localhost:5432/machine_logs`
