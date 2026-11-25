from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

from dataset_builder.build_dataset import (
    BuilderCheckpoint,
    build_ml_features,
    compact_parquet_partitions,
    ingest_incremental_sources,
    load_checkpoint,
    resolve_expected_sample_sec,
    save_checkpoint,
    validate_and_load_events,
    write_partitioned_parquet,
    write_quarantine_idempotent,
)
from simulator.main import parse_topology, run_loop


def test_simulator_generates_valid_rotated_and_contract(tmp_path: Path) -> None:
    out_dir = tmp_path / "logs"
    quarantine_file = tmp_path / "quarantine.jsonl"
    profiles = parse_topology("M-01:line-01:plc-controller,M-02:line-02:cnc-mill")

    run_loop(
        interval_sec=0.0,
        out_dir=out_dir,
        quarantine_file=quarantine_file,
        profiles=profiles,
        max_events=60,
        rotate_max_lines=20,
        upload_s3=False,
        seed=42,
    )

    log_file = out_dir / "telemetry.jsonl"
    contract_file = out_dir / "telemetry_contract.json"
    segments_dir = out_dir / "segments"
    assert log_file.exists()
    assert contract_file.exists()
    assert len(list(segments_dir.glob("telemetry.*.jsonl"))) >= 1

    ckpt = BuilderCheckpoint(processed_segments=[], active_offset=0, active_inode=None, high_watermark_ts=None)
    ingestion, next_ckpt = ingest_incremental_sources(log_file, segments_dir, ckpt)
    assert not ingestion.valid_df.empty
    assert set(ingestion.valid_df["line_id"].unique()).issubset({"line-01", "line-02"})

    # Second incremental read with no new writes returns 0 new lines
    ingestion_empty, _ = ingest_incremental_sources(log_file, segments_dir, next_ckpt)
    assert ingestion_empty.total_raw_lines == 0


def test_builder_quarantines_malformed_lines_without_crashing(tmp_path: Path) -> None:
    log_file = tmp_path / "telemetry.jsonl"
    quarantine_file = tmp_path / "quarantine.jsonl"

    base_ts = datetime(2026, 1, 15, 10, 0, 0, tzinfo=timezone.utc)
    lines = [
        json.dumps(
            {
                "event_id": "evt-1",
                "timestamp": base_ts.isoformat(),
                "machine_id": "M-01",
                "line_id": "line-01",
                "machine_type": "plc-controller",
                "state": "RUNNING",
                "error_code": None,
                "temp_c": 55.0,
                "vibration_mm_s": 1.2,
                "cycle_ms": 900,
            }
        ),
        "{broken json line",
        json.dumps(
            {
                "event_id": "evt-bad-type",
                "timestamp": (base_ts + timedelta(seconds=4)).isoformat(),
                "machine_id": "M-01",
                "state": "RUNNING",
                "temp_c": "NAN_STR",
                "vibration_mm_s": 1.1,
                "cycle_ms": 910,
            }
        ),
        json.dumps(
            {
                "event_id": "evt-out-of-range",
                "timestamp": (base_ts + timedelta(seconds=8)).isoformat(),
                "machine_id": "M-01",
                "state": "FAULT",
                "temp_c": 9999.0,
                "vibration_mm_s": -2.0,
                "cycle_ms": 950,
            }
        ),
    ]
    log_file.write_text("\n".join(lines) + "\n", encoding="utf-8")

    ingestion = validate_and_load_events(log_file)
    assert len(ingestion.valid_df) == 1
    assert len(ingestion.quarantine_records) == 3
    reasons = {r["error_reason"] for r in ingestion.quarantine_records}
    assert reasons == {"json_decode_error", "invalid_numeric_or_timestamp", "out_of_range_value"}

    added_first = write_quarantine_idempotent(quarantine_file, ingestion.quarantine_records)
    added_second = write_quarantine_idempotent(quarantine_file, ingestion.quarantine_records)
    assert added_first == 3
    assert added_second == 0


def test_ml_features_horizon_target_and_idempotent_parquet_export(tmp_path: Path) -> None:
    log_file = tmp_path / "telemetry.jsonl"
    out_dir = tmp_path / "ml_dataset"
    base_ts = datetime(2026, 1, 15, 10, 0, 0, tzinfo=timezone.utc)

    # Window 1 (10:00): nominal RUNNING; Window 2 (10:05): FAULT
    events = [
        {
            "event_id": "evt-w1-a",
            "timestamp": base_ts.isoformat(),
            "machine_id": "M-01",
            "line_id": "line-01",
            "machine_type": "plc-controller",
            "state": "RUNNING",
            "error_code": None,
            "temp_c": 54.0,
            "vibration_mm_s": 1.1,
            "cycle_ms": 940,
        },
        {
            "event_id": "evt-w2-b",
            "timestamp": (base_ts + timedelta(minutes=5, seconds=10)).isoformat(),
            "machine_id": "M-01",
            "line_id": "line-01",
            "machine_type": "plc-controller",
            "state": "FAULT",
            "error_code": "ERR-101",
            "temp_c": 81.5,
            "vibration_mm_s": 5.2,
            "cycle_ms": 1500,
        },
        {
            "event_id": "evt-w2-a",
            "timestamp": (base_ts + timedelta(minutes=5)).isoformat(),
            "machine_id": "M-01",
            "line_id": "line-01",
            "machine_type": "plc-controller",
            "state": "RUNNING",
            "error_code": None,
            "temp_c": 56.0,
            "vibration_mm_s": 1.3,
            "cycle_ms": 950,
        },
    ]
    log_file.write_text("\n".join(json.dumps(e) for e in events) + "\n", encoding="utf-8")

    ingestion = validate_and_load_events(log_file)
    assert len(ingestion.valid_df) == 3

    features = build_ml_features(
        ingestion.valid_df,
        window_minutes=5,
        expected_sample_sec=4.0,
        horizon_windows=1,
    )
    assert len(features) == 2

    w1 = features.iloc[0]
    w2 = features.iloc[1]
    assert int(w1["is_anomalous_window"]) == 0
    assert int(w1["will_fail_next_window"]) == 1  # Anti-leakage lead target points to w2!
    assert int(w2["is_anomalous_window"]) == 1
    assert pd.isna(w2["will_fail_next_window"])

    files_run1 = write_partitioned_parquet(features, out_dir)
    files_run2 = write_partitioned_parquet(features, out_dir)
    assert len(files_run1) == 1
    assert files_run1 == files_run2

    expected_path = out_dir / "dt=2026-01-15" / "machine_id=M-01" / "part-00000.parquet"
    assert expected_path.exists()
    persisted = pd.read_parquet(expected_path)
    assert len(persisted) == 2


def test_checkpoint_and_contract_persistence(tmp_path: Path) -> None:
    ckpt_file = tmp_path / "state" / "ckpt.json"
    ckpt = BuilderCheckpoint(["telemetry.20260115.0001.jsonl"], 1024, 99, "2026-01-15T10:05:00+00:00")
    save_checkpoint(ckpt_file, ckpt)
    loaded = load_checkpoint(ckpt_file)
    assert loaded.active_offset == 1024
    assert loaded.processed_segments == ["telemetry.20260115.0001.jsonl"]

    contract = tmp_path / "telemetry_contract.json"
    contract.write_text(json.dumps({"expected_sample_sec": 2.0}), encoding="utf-8")
    assert resolve_expected_sample_sec(contract) == 2.0


def test_multi_domain_envelope_and_duckdb_compaction(tmp_path: Path) -> None:
    log_file = tmp_path / "telemetry.jsonl"
    out_dir = tmp_path / "lakehouse"
    base_ts = datetime(2026, 2, 10, 8, 0, 0, tzinfo=timezone.utc)

    batch1 = [
        {
            "event_id": "evt-gas-1",
            "timestamp": base_ts.isoformat(),
            "machine_id": "M-10",
            "line_id": "line-gas-01",
            "machine_type": "gas-flow-meter",
            "domain": "gas-metering",
            "state": "RUNNING",
            "error_code": None,
            "metrics": {"temp_c": 24.5, "flow_nm3_h": 420.0, "pressure_bar": 12.1},
        },
        {
            "event_id": "evt-pwr-1",
            "timestamp": base_ts.isoformat(),
            "machine_id": "M-20",
            "line_id": "line-pwr-01",
            "machine_type": "power-meter",
            "domain": "power-generation",
            "state": "RUNNING",
            "error_code": None,
            "metrics": {"temp_c": 48.0, "power_kw": 350.0, "frequency_hz": 50.01},
        },
    ]
    log_file.write_text("\n".join(json.dumps(e) for e in batch1) + "\n", encoding="utf-8")
    ing1 = validate_and_load_events(log_file)
    f1 = build_ml_features(ing1.valid_df, window_minutes=5, dataset_version="v1.1.0")
    write_partitioned_parquet(f1, out_dir, partition_layout="domain/dt", compression="zstd")

    # Second batch appends separate small parquet file into same domain/dt partition
    batch2 = [
        {
            "event_id": "evt-gas-2",
            "timestamp": (base_ts + timedelta(minutes=5)).isoformat(),
            "machine_id": "M-10",
            "line_id": "line-gas-01",
            "machine_type": "gas-flow-meter",
            "domain": "gas-metering",
            "state": "RUNNING",
            "error_code": None,
            "metrics": {"temp_c": 25.0, "flow_nm3_h": 450.0, "pressure_bar": 12.4},
        }
    ]
    log_file.write_text("\n".join(json.dumps(e) for e in batch2) + "\n", encoding="utf-8")
    ing2 = validate_and_load_events(log_file)
    f2 = build_ml_features(ing2.valid_df, window_minutes=5, dataset_version="v1.1.0")
    write_partitioned_parquet(f2, out_dir, partition_layout="domain/dt", compression="zstd")

    gas_dir = out_dir / "domain=gas-metering" / "dt=2026-02-10"
    assert len(list(gas_dir.glob("*.parquet"))) == 2

    compacted = compact_parquet_partitions(out_dir, compression="zstd")
    assert len(compacted) == 2
    assert len(list(gas_dir.glob("*.parquet"))) == 1
    gas_df = pd.read_parquet(gas_dir / "part-compacted-00000.parquet")
    assert len(gas_df) == 2
    assert set(gas_df["primary_metric_name"]) == {"flow_nm3_h"}
