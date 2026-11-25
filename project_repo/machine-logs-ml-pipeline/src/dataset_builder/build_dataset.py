from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import boto3
import duckdb
import pandas as pd
import psycopg
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

VALID_STATES = {"IDLE", "RUNNING", "DEGRADED", "FAULT", "MAINTENANCE"}

MACHINE_SPECS: dict[str, dict[str, Any]] = {
    "plc-controller": {
        "domain": "manufacturing",
        "primary_key": "cycle_ms",
        "primary_unit": "ms",
        "secondary_key": "vibration_mm_s",
        "secondary_unit": "mm/s",
        "temp_fault_c": 82.0,
        "primary_fault": 1750.0,
    },
    "cnc-mill": {
        "domain": "manufacturing",
        "primary_key": "vibration_mm_s",
        "primary_unit": "mm/s",
        "secondary_key": "cycle_ms",
        "secondary_unit": "ms",
        "temp_fault_c": 84.0,
        "primary_fault": 5.2,
    },
    "gas-flow-meter": {
        "domain": "gas-metering",
        "primary_key": "flow_nm3_h",
        "primary_unit": "Nm3/h",
        "secondary_key": "pressure_bar",
        "secondary_unit": "bar",
        "temp_fault_c": 65.0,
        "primary_fault": 1450.0,
    },
    "methane-compressor": {
        "domain": "gas-metering",
        "primary_key": "pressure_bar",
        "primary_unit": "bar",
        "secondary_key": "flow_nm3_h",
        "secondary_unit": "Nm3/h",
        "temp_fault_c": 95.0,
        "primary_fault": 38.0,
    },
    "power-meter": {
        "domain": "power-generation",
        "primary_key": "power_kw",
        "primary_unit": "kW",
        "secondary_key": "frequency_hz",
        "secondary_unit": "Hz",
        "temp_fault_c": 75.0,
        "primary_fault": 680.0,
    },
    "turbine-generator": {
        "domain": "power-generation",
        "primary_key": "power_kw",
        "primary_unit": "kW",
        "secondary_key": "voltage_v",
        "secondary_unit": "V",
        "temp_fault_c": 105.0,
        "primary_fault": 3800.0,
    },
}

FEATURE_COLUMNS = [
    "machine_id",
    "window_start",
    "window_minutes",
    "dt",
    "line_id",
    "machine_type",
    "domain",
    "sample_count",
    "valid_sample_ratio",
    "primary_metric_name",
    "primary_metric_unit",
    "primary_metric_mean",
    "primary_metric_p95",
    "primary_metric_max",
    "secondary_metric_name",
    "secondary_metric_unit",
    "secondary_metric_mean",
    "temp_mean",
    "temp_max",
    "vibration_mean",
    "vibration_p95",
    "vibration_max",
    "cycle_ms_mean",
    "cycle_ms_std",
    "error_count",
    "fault_count",
    "degraded_count",
    "state_transitions_count",
    "time_in_fault_sec",
    "missing_heartbeat_count",
    "is_anomalous_window",
    "will_fail_next_window",
    "dataset_version",
]


def resolve_machine_spec(machine_type: str) -> dict[str, Any]:
    return MACHINE_SPECS.get(machine_type, MACHINE_SPECS["plc-controller"])


@dataclass
class IngestionResult:
    valid_df: pd.DataFrame
    quarantine_records: list[dict[str, Any]]
    total_raw_lines: int
    new_offset: int = 0
    file_inode: int | None = None


@dataclass
class BuilderCheckpoint:
    processed_segments: list[str]
    active_offset: int
    active_inode: int | None
    high_watermark_ts: str | None


def _payload_hash(reason: str, raw_line: str) -> str:
    return hashlib.sha256(f"{reason}:{raw_line}".encode()).hexdigest()[:16]


def load_checkpoint(checkpoint_path: Path | None) -> BuilderCheckpoint:
    if checkpoint_path is None or not checkpoint_path.exists():
        return BuilderCheckpoint(
            processed_segments=[],
            active_offset=0,
            active_inode=None,
            high_watermark_ts=None,
        )
    try:
        raw = json.loads(checkpoint_path.read_text(encoding="utf-8"))
        return BuilderCheckpoint(
            processed_segments=list(raw.get("processed_segments", [])),
            active_offset=int(raw.get("active_offset", 0)),
            active_inode=raw.get("active_inode"),
            high_watermark_ts=raw.get("high_watermark_ts"),
        )
    except (json.JSONDecodeError, TypeError, ValueError):
        return BuilderCheckpoint([], 0, None, None)


def save_checkpoint(checkpoint_path: Path | None, ckpt: BuilderCheckpoint) -> None:
    if checkpoint_path is None:
        return
    checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
    checkpoint_path.write_text(
        json.dumps(
            {
                "processed_segments": ckpt.processed_segments,
                "active_offset": ckpt.active_offset,
                "active_inode": ckpt.active_inode,
                "high_watermark_ts": ckpt.high_watermark_ts,
                "updated_at": datetime.now(UTC).isoformat(),
            },
            indent=2,
        ),
        encoding="utf-8",
    )


def resolve_expected_sample_sec(contract_file: Path | None, fallback: float = 4.0) -> float:
    if contract_file is None or not contract_file.exists():
        return fallback
    try:
        data = json.loads(contract_file.read_text(encoding="utf-8"))
        val = float(data.get("expected_sample_sec", fallback))
        return max(0.25, val)
    except (json.JSONDecodeError, TypeError, ValueError):
        return fallback


def validate_and_load_events(
    log_path: Path,
    start_offset: int = 0,
) -> IngestionResult:
    valid_records: list[dict[str, Any]] = []
    quarantine_records: list[dict[str, Any]] = []
    total_raw_lines = 0

    if not log_path.exists():
        return IngestionResult(
            valid_df=pd.DataFrame(),
            quarantine_records=[],
            total_raw_lines=0,
            new_offset=0,
            file_inode=None,
        )

    stat = log_path.stat()
    inode = getattr(stat, "st_ino", None)
    safe_offset = start_offset if 0 <= start_offset <= stat.st_size else 0

    with log_path.open("rb") as f:
        f.seek(safe_offset)
        while True:
            raw_bytes = f.readline()
            if not raw_bytes:
                break
            stripped = raw_bytes.decode("utf-8", errors="replace").strip()
            if not stripped:
                continue
            total_raw_lines += 1

            def add_quarantine(reason: str, raw_line: str = stripped) -> None:
                quarantine_records.append(
                    {
                        "quarantine_id": _payload_hash(reason, raw_line),
                        "quarantined_at": datetime.now(UTC).isoformat(),
                        "source": "dataset_builder",
                        "error_reason": reason,
                        "raw_payload": raw_line,
                    }
                )

            try:
                item = json.loads(stripped)
            except json.JSONDecodeError:
                add_quarantine("json_decode_error")
                continue

            if not isinstance(item, dict):
                add_quarantine("invalid_json_object")
                continue

            if any(k not in item or item[k] is None for k in ("machine_id", "timestamp", "state")):
                add_quarantine("missing_required_field")
                continue

            metrics_obj = item.get("metrics") if isinstance(item.get("metrics"), dict) else None
            machine_type = str(item.get("machine_type") or "plc-controller")
            spec = resolve_machine_spec(machine_type)
            domain = str(item.get("domain") or spec["domain"])

            raw_temp = metrics_obj.get("temp_c") if metrics_obj else item.get("temp_c")
            if raw_temp is None:
                add_quarantine("missing_required_field")
                continue

            try:
                temp_val = float(raw_temp)
                ts = pd.to_datetime(item["timestamp"], utc=True)

                if metrics_obj is not None:
                    raw_primary = metrics_obj.get(spec["primary_key"])
                    if raw_primary is None:
                        add_quarantine("missing_required_field")
                        continue
                    primary_val = float(raw_primary)
                    raw_secondary = metrics_obj.get(spec["secondary_key"], 0.0)
                    secondary_val = float(raw_secondary)
                    vib_val = float(metrics_obj.get("vibration_mm_s", 0.0))
                    cycle_val = int(float(metrics_obj.get("cycle_ms", 1000)))
                else:
                    if item.get("vibration_mm_s") is None or item.get("cycle_ms") is None:
                        add_quarantine("missing_required_field")
                        continue
                    vib_val = float(item["vibration_mm_s"])
                    cycle_val = int(item["cycle_ms"])
                    primary_val = float(item.get(spec["primary_key"], cycle_val))
                    secondary_val = float(item.get(spec["secondary_key"], vib_val))
            except (TypeError, ValueError):
                add_quarantine("invalid_numeric_or_timestamp")
                continue

            if (
                not math.isfinite(temp_val)
                or not math.isfinite(vib_val)
                or not math.isfinite(primary_val)
                or not math.isfinite(secondary_val)
                or not (-50.0 <= temp_val <= 250.0)
                or not (0.0 <= vib_val <= 100.0)
                or cycle_val <= 0
                or primary_val < 0.0
            ):
                add_quarantine("out_of_range_value")
                continue

            state = str(item["state"]).upper()
            if state not in VALID_STATES:
                add_quarantine("invalid_state")
                continue

            event_id = str(item.get("event_id") or _payload_hash("event", stripped))
            valid_records.append(
                {
                    "event_id": event_id,
                    "timestamp": ts,
                    "machine_id": str(item["machine_id"]),
                    "line_id": str(item.get("line_id") or "line-01"),
                    "machine_type": machine_type,
                    "domain": domain,
                    "state": state,
                    "error_code": str(item["error_code"]) if item.get("error_code") else None,
                    "temp_c": temp_val,
                    "vibration_mm_s": vib_val,
                    "cycle_ms": cycle_val,
                    "primary_metric_name": spec["primary_key"],
                    "primary_metric_value": primary_val,
                    "primary_metric_unit": spec["primary_unit"],
                    "secondary_metric_name": spec["secondary_key"],
                    "secondary_metric_value": secondary_val,
                    "secondary_metric_unit": spec["secondary_unit"],
                }
            )
        new_offset = f.tell()

    if not valid_records:
        return IngestionResult(
            valid_df=pd.DataFrame(),
            quarantine_records=quarantine_records,
            total_raw_lines=total_raw_lines,
            new_offset=new_offset,
            file_inode=inode,
        )

    df = pd.DataFrame.from_records(valid_records)
    df = df.drop_duplicates(subset=["event_id"], keep="last")
    df = df.sort_values(["machine_id", "timestamp", "event_id"]).reset_index(drop=True)
    return IngestionResult(
        valid_df=df,
        quarantine_records=quarantine_records,
        total_raw_lines=total_raw_lines,
        new_offset=new_offset,
        file_inode=inode,
    )


def ingest_incremental_sources(
    log_path: Path,
    segments_dir: Path | None,
    checkpoint: BuilderCheckpoint,
) -> tuple[IngestionResult, BuilderCheckpoint]:
    dfs: list[pd.DataFrame] = []
    quarantine_all: list[dict[str, Any]] = []
    total_lines = 0

    processed_segments = list(checkpoint.processed_segments)
    processed_set = set(processed_segments)

    if segments_dir is not None and segments_dir.exists():
        for seg_path in sorted(segments_dir.glob("telemetry.*.jsonl")):
            if seg_path.name in processed_set:
                continue
            seg_res = validate_and_load_events(seg_path, start_offset=0)
            total_lines += seg_res.total_raw_lines
            quarantine_all.extend(seg_res.quarantine_records)
            if not seg_res.valid_df.empty:
                dfs.append(seg_res.valid_df)
            processed_segments.append(seg_path.name)
            processed_set.add(seg_path.name)

    active_offset = checkpoint.active_offset
    if log_path.exists():
        stat = log_path.stat()
        current_inode = getattr(stat, "st_ino", None)
        if checkpoint.active_inode is not None and current_inode != checkpoint.active_inode:
            active_offset = 0
        elif stat.st_size < active_offset:
            active_offset = 0
    else:
        active_offset = 0

    active_res = validate_and_load_events(log_path, start_offset=active_offset)
    total_lines += active_res.total_raw_lines
    quarantine_all.extend(active_res.quarantine_records)
    if not active_res.valid_df.empty:
        dfs.append(active_res.valid_df)

    merged_df = (
        pd.concat(dfs, ignore_index=True)
        .drop_duplicates(subset=["event_id"], keep="last")
        .sort_values(["machine_id", "timestamp", "event_id"])
        .reset_index(drop=True)
        if dfs
        else pd.DataFrame()
    )

    next_watermark = checkpoint.high_watermark_ts
    if not merged_df.empty:
        max_ts = merged_df["timestamp"].max().isoformat()
        if next_watermark is None or max_ts > next_watermark:
            next_watermark = max_ts

    next_ckpt = BuilderCheckpoint(
        processed_segments=processed_segments[-500:],
        active_offset=active_res.new_offset,
        active_inode=active_res.file_inode,
        high_watermark_ts=next_watermark,
    )
    return (
        IngestionResult(
            valid_df=merged_df,
            quarantine_records=quarantine_all,
            total_raw_lines=total_lines,
            new_offset=active_res.new_offset,
            file_inode=active_res.file_inode,
        ),
        next_ckpt,
    )


def merge_and_prune_event_store(
    new_df: pd.DataFrame,
    staging_parquet: Path | None,
    min_affected_ts: pd.Timestamp | None,
    retention_hours: int = 24,
) -> pd.DataFrame:
    """
    Merge new events with local DuckDB-backed Parquet staging store, deduplicate by event_id,
    prune rows older than retention_hours via SQL, and return only the affected recompute window.
    """
    if staging_parquet is None:
        return new_df

    has_existing = staging_parquet.exists()
    has_new = not new_df.empty
    if not has_existing and not has_new:
        return pd.DataFrame()

    staging_parquet.parent.mkdir(parents=True, exist_ok=True)
    tmp_staging = staging_parquet.parent / f".staging-{uuid.uuid4().hex[:8]}.parquet"

    con = duckdb.connect()
    try:
        if has_existing and has_new:
            con.register("incoming_events", new_df)
            source_sql = f"""
                SELECT * FROM read_parquet('{staging_parquet}')
                UNION ALL BY NAME
                SELECT * FROM incoming_events
            """  # noqa: S608
        elif has_existing:
            source_sql = f"SELECT * FROM read_parquet('{staging_parquet}')"  # noqa: S608
        else:
            con.register("incoming_events", new_df)
            source_sql = "SELECT * FROM incoming_events"

        con.execute(
            f"""
            CREATE TEMP TABLE deduped_events AS
            SELECT * EXCLUDE (rn) FROM (
                SELECT *, ROW_NUMBER() OVER (
                    PARTITION BY event_id
                    ORDER BY timestamp DESC
                ) AS rn
                FROM ({source_sql})
            )
            WHERE rn = 1;
        """  # noqa: S608
        )

        con.execute(
            f"""
            COPY (
                WITH max_ref AS (SELECT MAX(timestamp) AS max_ts FROM deduped_events)
                SELECT d.*
                FROM deduped_events d, max_ref
                WHERE d.timestamp >= max_ref.max_ts - INTERVAL '{int(retention_hours)} hours'
                ORDER BY d.machine_id, d.timestamp, d.event_id
            ) TO '{tmp_staging}' (FORMAT PARQUET, COMPRESSION ZSTD);
        """  # noqa: S608
        )
        tmp_staging.replace(staging_parquet)

        if min_affected_ts is not None:
            cutoff_iso = min_affected_ts.isoformat()
            result = con.execute(
                f"SELECT * FROM read_parquet('{staging_parquet}') WHERE timestamp >= CAST(? AS TIMESTAMPTZ) ORDER BY machine_id, timestamp, event_id",  # noqa: S608
                [cutoff_iso],
            ).fetch_df()
        else:
            result = con.execute(
                f"SELECT * FROM read_parquet('{staging_parquet}') ORDER BY machine_id, timestamp, event_id"  # noqa: S608
            ).fetch_df()
        if not result.empty:
            result["timestamp"] = pd.to_datetime(result["timestamp"], utc=True)
        return result
    finally:
        con.close()


def prune_expired_segments(
    segments_dir: Path | None,
    processed_segments: list[str],
    retention_hours: int = 48,
) -> int:
    """Remove rotated JSONL segments older than retention_hours once already checkpointed."""
    if segments_dir is None or not segments_dir.exists():
        return 0
    processed_set = set(processed_segments)
    cutoff_ts = time.time() - (retention_hours * 3600)
    removed = 0
    for seg_path in segments_dir.glob("telemetry.*.jsonl"):
        if seg_path.name in processed_set and seg_path.stat().st_mtime < cutoff_ts:
            seg_path.unlink(missing_ok=True)
            removed += 1
    return removed


def write_quarantine_idempotent(quarantine_file: Path, new_records: list[dict[str, Any]]) -> int:
    """
    Append quarantined records idempotently using a compact .idx hash sidecar
    so large quarantine logs do not require full JSONL re-parsing every cycle.
    """
    if not new_records:
        return 0

    quarantine_file.parent.mkdir(parents=True, exist_ok=True)
    idx_file = quarantine_file.with_suffix(quarantine_file.suffix + ".idx")
    existing_ids: set[str] = set()

    if idx_file.exists():
        with idx_file.open("r", encoding="utf-8") as idxf:
            existing_ids = {line.strip() for line in idxf if line.strip()}
    elif quarantine_file.exists():
        with quarantine_file.open("r", encoding="utf-8") as qf:
            for line in qf:
                stripped = line.strip()
                if not stripped:
                    continue
                try:
                    obj = json.loads(stripped)
                    if isinstance(obj, dict) and "quarantine_id" in obj:
                        existing_ids.add(str(obj["quarantine_id"]))
                except json.JSONDecodeError:
                    continue
        if existing_ids:
            idx_file.write_text("\n".join(sorted(existing_ids)) + "\n", encoding="utf-8")

    added = 0
    new_idx_lines: list[str] = []
    with quarantine_file.open("a", encoding="utf-8") as qf:
        for rec in new_records:
            qid = str(rec["quarantine_id"])
            if qid not in existing_ids:
                qf.write(json.dumps(rec) + "\n")
                existing_ids.add(qid)
                new_idx_lines.append(qid)
                added += 1

    if new_idx_lines:
        with idx_file.open("a", encoding="utf-8") as idxf:
            idxf.write("\n".join(new_idx_lines) + "\n")
    return added


def _compute_time_in_fault_sec(group: pd.DataFrame, default_step_sec: float) -> float:
    ordered = group.sort_values("timestamp")
    states = ordered["state"].tolist()
    timestamps = ordered["timestamp"].tolist()
    if not states:
        return 0.0

    total_fault_sec = 0.0
    for idx, state in enumerate(states):
        if state != "FAULT":
            continue
        if idx + 1 < len(timestamps):
            delta = (timestamps[idx + 1] - timestamps[idx]).total_seconds()
            total_fault_sec += max(0.0, min(delta, default_step_sec * 3.0))
        else:
            total_fault_sec += default_step_sec
    return round(total_fault_sec, 2)


def _compute_state_transitions(group: pd.DataFrame) -> int:
    ordered = group.sort_values("timestamp")
    states = ordered["state"].tolist()
    if len(states) <= 1:
        return 0
    return sum(1 for prev, curr in zip(states, states[1:], strict=False) if prev != curr)


def build_ml_features(
    df: pd.DataFrame,
    window_minutes: int = 5,
    expected_sample_sec: float = 4.0,
    horizon_windows: int = 1,
    dataset_version: str = "v1",
) -> pd.DataFrame:
    if df.empty:
        return pd.DataFrame(columns=FEATURE_COLUMNS)

    work = df.copy()
    work["window_start"] = work["timestamp"].dt.floor(f"{window_minutes}min")
    expected_samples = max(1, int((window_minutes * 60) / expected_sample_sec))

    rows: list[dict[str, Any]] = []
    for (machine_id, window_start), grp in work.groupby(["machine_id", "window_start"], sort=True):
        sample_count = int(len(grp))
        fault_count = int((grp["state"] == "FAULT").sum())
        degraded_count = int((grp["state"] == "DEGRADED").sum())
        error_count = int(grp["error_code"].notna().sum())

        machine_type = str(grp["machine_type"].mode().iloc[0])
        spec = resolve_machine_spec(machine_type)
        domain = str(grp["domain"].mode().iloc[0]) if "domain" in grp.columns else spec["domain"]

        primary_col = (
            grp["primary_metric_value"]
            if "primary_metric_value" in grp.columns
            else grp["cycle_ms"]
        )
        secondary_col = (
            grp["secondary_metric_value"]
            if "secondary_metric_value" in grp.columns
            else grp["vibration_mm_s"]
        )

        primary_mean = round(float(primary_col.mean()), 3)
        primary_p95 = round(float(primary_col.quantile(0.95)), 3)
        primary_max = round(float(primary_col.max()), 3)
        secondary_mean = round(float(secondary_col.mean()), 3)

        temp_mean = round(float(grp["temp_c"].mean()), 3)
        temp_max = round(float(grp["temp_c"].max()), 3)
        vib_mean = round(float(grp["vibration_mm_s"].mean()), 3)
        vib_p95 = round(float(grp["vibration_mm_s"].quantile(0.95)), 3)
        vib_max = round(float(grp["vibration_mm_s"].max()), 3)
        cycle_mean = round(float(grp["cycle_ms"].mean()), 2)
        cycle_std = round(float(grp["cycle_ms"].std(ddof=0)), 2) if sample_count > 1 else 0.0

        transitions = _compute_state_transitions(grp)
        fault_sec = _compute_time_in_fault_sec(grp, default_step_sec=expected_sample_sec)
        missing_hb = max(0, expected_samples - sample_count)
        valid_ratio = round(min(1.0, sample_count / float(expected_samples)), 4)

        is_anomalous = int(
            fault_count > 0
            or degraded_count >= 2
            or temp_max > spec["temp_fault_c"]
            or primary_max > spec["primary_fault"]
            or vib_p95 > 4.5
        )

        rows.append(
            {
                "machine_id": str(machine_id),
                "window_start": window_start,
                "window_minutes": int(window_minutes),
                "dt": window_start.strftime("%Y-%m-%d"),
                "line_id": str(grp["line_id"].mode().iloc[0]),
                "machine_type": machine_type,
                "domain": domain,
                "sample_count": sample_count,
                "valid_sample_ratio": valid_ratio,
                "primary_metric_name": spec["primary_key"],
                "primary_metric_unit": spec["primary_unit"],
                "primary_metric_mean": primary_mean,
                "primary_metric_p95": primary_p95,
                "primary_metric_max": primary_max,
                "secondary_metric_name": spec["secondary_key"],
                "secondary_metric_unit": spec["secondary_unit"],
                "secondary_metric_mean": secondary_mean,
                "temp_mean": temp_mean,
                "temp_max": temp_max,
                "vibration_mean": vib_mean,
                "vibration_p95": vib_p95,
                "vibration_max": vib_max,
                "cycle_ms_mean": cycle_mean,
                "cycle_ms_std": cycle_std,
                "error_count": error_count,
                "fault_count": fault_count,
                "degraded_count": degraded_count,
                "state_transitions_count": transitions,
                "time_in_fault_sec": fault_sec,
                "missing_heartbeat_count": missing_hb,
                "is_anomalous_window": is_anomalous,
                "will_fail_next_window": pd.NA,
                "dataset_version": dataset_version,
            }
        )

    out_df = pd.DataFrame.from_records(rows, columns=FEATURE_COLUMNS)
    out_df = out_df.sort_values(["machine_id", "window_start"]).reset_index(drop=True)

    # Anti-leakage predictive target: label window t using future window t + horizon_windows
    if horizon_windows >= 1 and not out_df.empty:
        future_shifted = out_df.groupby("machine_id")["is_anomalous_window"].shift(-horizon_windows)
        out_df["will_fail_next_window"] = future_shifted.astype("Int64")

    return out_df.sort_values(["dt", "machine_id", "window_start"]).reset_index(drop=True)


def write_partitioned_parquet(
    features: pd.DataFrame,
    out_dir: Path,
    partition_layout: str = "dt/machine_id",
    compression: str = "zstd",
) -> list[Path]:
    written_files: list[Path] = []
    if features.empty:
        return written_files

    if partition_layout == "domain/dt":
        for (domain_val, dt_val), part_df in features.groupby(["domain", "dt"], sort=True):
            part_dir = out_dir / f"domain={domain_val}" / f"dt={dt_val}"
            part_dir.mkdir(parents=True, exist_ok=True)
            batch_file = part_dir / f"batch-{uuid.uuid4().hex[:8]}.parquet"
            incoming = (
                part_df.drop(columns=["domain", "dt"])
                .sort_values(["machine_id", "window_start"])
                .copy()
            )
            incoming.to_parquet(batch_file, index=False, compression=compression)
            written_files.append(batch_file)
        return written_files

    for (dt_val, machine_id), part_df in features.groupby(["dt", "machine_id"], sort=True):
        part_dir = out_dir / f"dt={dt_val}" / f"machine_id={machine_id}"
        part_dir.mkdir(parents=True, exist_ok=True)
        part_file = part_dir / "part-00000.parquet"
        incoming = part_df.drop(columns=["dt", "machine_id"]).copy()

        # Idempotent partition merge so incremental batches never erase earlier windows on the same day
        if part_file.exists():
            existing = pd.read_parquet(part_file)
            combined = pd.concat([existing, incoming], ignore_index=True)
            combined = combined.drop_duplicates(
                subset=["window_start", "window_minutes"], keep="last"
            ).sort_values("window_start")
            combined.to_parquet(part_file, index=False, compression=compression)
        else:
            incoming.to_parquet(part_file, index=False, compression=compression)
        written_files.append(part_file)
    return written_files


def compact_parquet_partitions(out_dir: Path, compression: str = "zstd") -> list[Path]:
    """
    Lakehouse anti-small-file compaction using DuckDB:
    Consolidates multiple append-only batch-*.parquet files per partition into a single
    sorted, deduplicated ZSTD Parquet file ready for Spark, Trino, Snowflake, or DuckDB.
    """
    compacted_files: list[Path] = []
    if not out_dir.exists():
        return compacted_files

    con = duckdb.connect()
    try:
        for part_dir in sorted({p.parent for p in out_dir.rglob("*.parquet")}):
            parquet_inputs = sorted(part_dir.glob("*.parquet"))
            if len(parquet_inputs) <= 1:
                if parquet_inputs:
                    compacted_files.append(parquet_inputs[0])
                continue

            glob_pattern = str(part_dir / "*.parquet")
            tmp_target = part_dir / f".compact-{uuid.uuid4().hex[:8]}.parquet"
            final_target = part_dir / "part-compacted-00000.parquet"

            cols = [
                r[0]
                for r in con.execute(
                    f"DESCRIBE SELECT * FROM read_parquet('{glob_pattern}', union_by_name=true)"  # noqa: S608
                ).fetchall()
            ]
            if "machine_id" in cols:
                sql = f"""
                    COPY (
                        SELECT * EXCLUDE (rn) FROM (
                            SELECT *, ROW_NUMBER() OVER (
                                PARTITION BY machine_id, window_start, window_minutes
                                ORDER BY sample_count DESC
                            ) AS rn
                            FROM read_parquet('{glob_pattern}', union_by_name=true)
                        )
                        WHERE rn = 1
                        ORDER BY machine_id, window_start
                    ) TO '{tmp_target}' (FORMAT PARQUET, COMPRESSION '{compression.upper()}');
                """  # noqa: S608
            else:
                sql = f"""
                    COPY (
                        SELECT * EXCLUDE (rn) FROM (
                            SELECT *, ROW_NUMBER() OVER (
                                PARTITION BY window_start, window_minutes
                                ORDER BY sample_count DESC
                            ) AS rn
                            FROM read_parquet('{glob_pattern}', union_by_name=true)
                        )
                        WHERE rn = 1
                        ORDER BY window_start
                    ) TO '{tmp_target}' (FORMAT PARQUET, COMPRESSION '{compression.upper()}');
                """  # noqa: S608
            con.execute(sql)
            for old_file in parquet_inputs:
                old_file.unlink(missing_ok=True)
            tmp_target.replace(final_target)
            compacted_files.append(final_target)
    finally:
        con.close()
    return compacted_files


def _build_s3_client(cold: bool = False) -> Any | None:
    endpoint = os.getenv("S3_COLD_ENDPOINT") if cold else os.getenv("S3_ENDPOINT")
    access_key = os.getenv("S3_COLD_ACCESS_KEY") if cold else os.getenv("S3_ACCESS_KEY")
    secret_key = os.getenv("S3_COLD_SECRET_KEY") if cold else os.getenv("S3_SECRET_KEY")
    if cold and not endpoint:
        endpoint = os.getenv("S3_ENDPOINT")
        access_key = os.getenv("S3_ACCESS_KEY")
        secret_key = os.getenv("S3_SECRET_KEY")
    if not endpoint or not access_key or not secret_key:
        return None
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="us-east-1",
        config=Config(s3={"addressing_style": "path"}),
    )


def _ensure_bucket(s3_client: Any, bucket: str) -> None:
    try:
        s3_client.head_bucket(Bucket=bucket)
    except ClientError:
        s3_client.create_bucket(Bucket=bucket)


def upload_artifacts_to_s3(
    out_dir: Path,
    parquet_files: list[Path],
    quarantine_file: Path,
    dataset_version: str,
) -> str | None:
    s3_cold_client = _build_s3_client(cold=True)
    if s3_cold_client is None:
        return None

    ml_bucket = os.getenv("S3_COLD_BUCKET", os.getenv("S3_ML_BUCKET", "machine-ml-cold"))
    quarantine_bucket = os.getenv("S3_QUARANTINE_BUCKET", "machine-quarantine")
    s3_prefix = f"lakehouse/{dataset_version}"

    try:
        _ensure_bucket(s3_cold_client, ml_bucket)
        for pfile in parquet_files:
            rel_path = pfile.relative_to(out_dir).as_posix()
            s3_cold_client.upload_file(str(pfile), ml_bucket, f"{s3_prefix}/{rel_path}")

        if quarantine_file.exists():
            _ensure_bucket(s3_cold_client, quarantine_bucket)
            day_prefix = datetime.now(UTC).strftime("%Y-%m-%d")
            s3_cold_client.upload_file(
                str(quarantine_file),
                quarantine_bucket,
                f"quarantine/dt={day_prefix}/quarantine.jsonl",
            )
        return f"s3://{ml_bucket}/{s3_prefix}"
    except (BotoCoreError, ClientError) as exc:
        print(f"WARN: S3 cold upload failed: {exc}")
        return None


def write_to_postgres(
    features: pd.DataFrame,
    run_id: str,
    started_at: datetime,
    finished_at: datetime,
    window_minutes: int,
    total_raw_lines: int,
    new_lines_processed: int,
    valid_events: int,
    quarantined_events: int,
    high_watermark_ts: str | None,
    dataset_version: str,
    s3_prefix: str | None,
) -> None:
    pg_dsn = os.getenv("PG_DSN")
    if not pg_dsn:
        return

    with psycopg.connect(pg_dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO pipeline_runs (
                    run_id, started_at, finished_at, window_minutes,
                    total_raw_lines, new_lines_processed, valid_events, quarantined_events,
                    feature_rows_written, high_watermark_ts, dataset_version, s3_prefix
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (run_id) DO NOTHING
                """,
                (
                    run_id,
                    started_at,
                    finished_at,
                    window_minutes,
                    total_raw_lines,
                    new_lines_processed,
                    valid_events,
                    quarantined_events,
                    len(features),
                    pd.to_datetime(high_watermark_ts, utc=True).to_pydatetime()
                    if high_watermark_ts
                    else None,
                    dataset_version,
                    s3_prefix,
                ),
            )

            upsert_sql = """
                INSERT INTO ml_machine_features (
                    machine_id, window_start, window_minutes, dt, line_id, machine_type, domain,
                    sample_count, valid_sample_ratio,
                    primary_metric_name, primary_metric_unit, primary_metric_mean, primary_metric_p95, primary_metric_max,
                    secondary_metric_name, secondary_metric_unit, secondary_metric_mean,
                    temp_mean, temp_max,
                    vibration_mean, vibration_p95, vibration_max,
                    cycle_ms_mean, cycle_ms_std, error_count, fault_count, degraded_count,
                    state_transitions_count, time_in_fault_sec, missing_heartbeat_count,
                    is_anomalous_window, will_fail_next_window, dataset_version
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s,
                    %s, %s,
                    %s, %s, %s, %s, %s,
                    %s, %s, %s,
                    %s, %s,
                    %s, %s, %s,
                    %s, %s, %s, %s, %s,
                    %s, %s, %s,
                    %s, %s, %s
                )
                ON CONFLICT (dt, machine_id, window_start, window_minutes)
                DO UPDATE SET
                    line_id = EXCLUDED.line_id,
                    machine_type = EXCLUDED.machine_type,
                    domain = EXCLUDED.domain,
                    sample_count = EXCLUDED.sample_count,
                    valid_sample_ratio = EXCLUDED.valid_sample_ratio,
                    primary_metric_name = EXCLUDED.primary_metric_name,
                    primary_metric_unit = EXCLUDED.primary_metric_unit,
                    primary_metric_mean = EXCLUDED.primary_metric_mean,
                    primary_metric_p95 = EXCLUDED.primary_metric_p95,
                    primary_metric_max = EXCLUDED.primary_metric_max,
                    secondary_metric_name = EXCLUDED.secondary_metric_name,
                    secondary_metric_unit = EXCLUDED.secondary_metric_unit,
                    secondary_metric_mean = EXCLUDED.secondary_metric_mean,
                    temp_mean = EXCLUDED.temp_mean,
                    temp_max = EXCLUDED.temp_max,
                    vibration_mean = EXCLUDED.vibration_mean,
                    vibration_p95 = EXCLUDED.vibration_p95,
                    vibration_max = EXCLUDED.vibration_max,
                    cycle_ms_mean = EXCLUDED.cycle_ms_mean,
                    cycle_ms_std = EXCLUDED.cycle_ms_std,
                    error_count = EXCLUDED.error_count,
                    fault_count = EXCLUDED.fault_count,
                    degraded_count = EXCLUDED.degraded_count,
                    state_transitions_count = EXCLUDED.state_transitions_count,
                    time_in_fault_sec = EXCLUDED.time_in_fault_sec,
                    missing_heartbeat_count = EXCLUDED.missing_heartbeat_count,
                    is_anomalous_window = EXCLUDED.is_anomalous_window,
                    will_fail_next_window = COALESCE(EXCLUDED.will_fail_next_window, ml_machine_features.will_fail_next_window),
                    dataset_version = EXCLUDED.dataset_version,
                    updated_at = NOW()
            """
            rows = [
                (
                    r.machine_id,
                    r.window_start.to_pydatetime(),
                    int(r.window_minutes),
                    r.dt,
                    r.line_id,
                    r.machine_type,
                    r.domain,
                    int(r.sample_count),
                    float(r.valid_sample_ratio),
                    r.primary_metric_name,
                    r.primary_metric_unit,
                    float(r.primary_metric_mean),
                    float(r.primary_metric_p95),
                    float(r.primary_metric_max),
                    r.secondary_metric_name,
                    r.secondary_metric_unit,
                    float(r.secondary_metric_mean),
                    float(r.temp_mean),
                    float(r.temp_max),
                    float(r.vibration_mean),
                    float(r.vibration_p95),
                    float(r.vibration_max),
                    float(r.cycle_ms_mean),
                    float(r.cycle_ms_std),
                    int(r.error_count),
                    int(r.fault_count),
                    int(r.degraded_count),
                    int(r.state_transitions_count),
                    float(r.time_in_fault_sec),
                    int(r.missing_heartbeat_count),
                    int(r.is_anomalous_window),
                    None if pd.isna(r.will_fail_next_window) else int(r.will_fail_next_window),
                    r.dataset_version,
                )
                for r in features.itertuples(index=False)
            ]
            if rows:
                cur.executemany(upsert_sql, rows)
        conn.commit()


def run_once(args: argparse.Namespace) -> dict[str, Any]:
    started_at = datetime.now(UTC)
    checkpoint = load_checkpoint(args.checkpoint_file)
    ingestion, next_ckpt = ingest_incremental_sources(
        log_path=args.log_file,
        segments_dir=args.segments_dir,
        checkpoint=checkpoint,
    )
    write_quarantine_idempotent(args.quarantine_file, ingestion.quarantine_records)

    min_affected_ts: pd.Timestamp | None = None
    if not ingestion.valid_df.empty and checkpoint.high_watermark_ts is not None:
        wm = pd.to_datetime(checkpoint.high_watermark_ts, utc=True) - timedelta(
            minutes=args.watermark_lookback_minutes
        )
        earliest_new = ingestion.valid_df["timestamp"].min()
        min_affected_ts = min(wm, earliest_new).floor(f"{args.window_minutes}min")

    staging_parquet = (
        args.checkpoint_file.parent / "normalized_events.parquet"
        if args.checkpoint_file is not None
        else None
    )
    recompute_df = merge_and_prune_event_store(
        new_df=ingestion.valid_df,
        staging_parquet=staging_parquet,
        min_affected_ts=min_affected_ts,
    )

    expected_sample_sec = resolve_expected_sample_sec(
        args.contract_file,
        fallback=args.expected_sample_sec,
    )
    features = build_ml_features(
        recompute_df,
        window_minutes=args.window_minutes,
        expected_sample_sec=expected_sample_sec,
        horizon_windows=args.horizon_windows,
        dataset_version=args.dataset_version,
    )
    parquet_files = write_partitioned_parquet(
        features,
        args.out_dir,
        partition_layout=args.partition_layout,
        compression=args.compression,
    )
    if args.compact:
        parquet_files = compact_parquet_partitions(args.out_dir, compression=args.compression)

    pruned_segments = prune_expired_segments(
        args.segments_dir,
        next_ckpt.processed_segments,
        retention_hours=args.local_segment_retention_hours,
    )

    s3_prefix = None
    if args.upload_s3:
        s3_prefix = upload_artifacts_to_s3(
            out_dir=args.out_dir,
            parquet_files=parquet_files,
            quarantine_file=args.quarantine_file,
            dataset_version=args.dataset_version,
        )

    save_checkpoint(args.checkpoint_file, next_ckpt)

    finished_at = datetime.now(UTC)
    if args.write_postgres:
        write_to_postgres(
            features=features,
            run_id=f"run-{uuid.uuid4().hex[:12]}",
            started_at=started_at,
            finished_at=finished_at,
            window_minutes=args.window_minutes,
            total_raw_lines=ingestion.total_raw_lines,
            new_lines_processed=ingestion.total_raw_lines,
            valid_events=len(ingestion.valid_df),
            quarantined_events=len(ingestion.quarantine_records),
            high_watermark_ts=next_ckpt.high_watermark_ts,
            dataset_version=args.dataset_version,
            s3_prefix=s3_prefix,
        )

    summary = {
        "new_raw_lines": ingestion.total_raw_lines,
        "new_valid_events": len(ingestion.valid_df),
        "recomputed_events": len(recompute_df),
        "quarantined_events": len(ingestion.quarantine_records),
        "feature_rows": len(features),
        "parquet_partitions": len(parquet_files),
        "pruned_local_segments": pruned_segments,
        "high_watermark_ts": next_ckpt.high_watermark_ts,
        "expected_sample_sec": expected_sample_sec,
        "s3_prefix": s3_prefix,
    }
    print(json.dumps(summary), flush=True)
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Incremental watermark ML & Lakehouse dataset builder"
    )
    parser.add_argument("--log-file", type=Path, default=Path("/var/log/machines/telemetry.jsonl"))
    parser.add_argument("--segments-dir", type=Path, default=Path("/var/log/machines/segments"))
    parser.add_argument(
        "--quarantine-file", type=Path, default=Path("/var/log/machines/quarantine.jsonl")
    )
    parser.add_argument("--checkpoint-file", type=Path, default=None)
    parser.add_argument("--contract-file", type=Path, default=None)
    parser.add_argument("--out-dir", type=Path, default=Path("/var/log/machines/ml_dataset"))
    parser.add_argument("--window-minutes", type=int, default=5)
    parser.add_argument("--watermark-lookback-minutes", type=int, default=15)
    parser.add_argument("--horizon-windows", type=int, default=1)
    parser.add_argument("--expected-sample-sec", type=float, default=4.0)
    parser.add_argument("--dataset-version", type=str, default="v1")
    parser.add_argument("--partition-layout", type=str, default="domain/dt")
    parser.add_argument("--compression", type=str, default="zstd")
    parser.add_argument("--local-segment-retention-hours", type=int, default=48)
    parser.add_argument("--compact", action="store_true")
    parser.add_argument("--watch-interval-sec", type=float, default=0.0)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--upload-s3", action="store_true")
    parser.add_argument("--write-postgres", action="store_true")
    args = parser.parse_args()

    if args.once or args.watch_interval_sec <= 0:
        run_once(args)
        return

    while True:
        try:
            run_once(args)
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"level": "ERROR", "message": str(exc)}), flush=True)
        time.sleep(args.watch_interval_sec)


if __name__ == "__main__":
    main()
