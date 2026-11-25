from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

STATES = ["IDLE", "RUNNING", "DEGRADED", "FAULT", "MAINTENANCE"]

DEFAULT_TOPOLOGY: list[tuple[str, str, str]] = [
    ("M-01", "line-01", "plc-controller"),
    ("M-02", "line-01", "cnc-mill"),
    ("M-03", "line-02", "gas-flow-meter"),
    ("M-04", "line-03", "power-meter"),
]

MACHINE_SPECS: dict[str, dict[str, Any]] = {
    "plc-controller": {
        "domain": "manufacturing",
        "primary_key": "cycle_ms",
        "primary_unit": "ms",
        "primary_nominal": 920.0,
        "primary_fault": 1750.0,
        "primary_std": 55.0,
        "secondary_key": "vibration_mm_s",
        "secondary_nominal": 1.2,
        "secondary_fault": 4.2,
        "secondary_std": 0.25,
        "temp_nominal_c": 52.0,
        "temp_fault_c": 82.0,
        "temp_std_c": 2.0,
    },
    "cnc-mill": {
        "domain": "manufacturing",
        "primary_key": "vibration_mm_s",
        "primary_unit": "mm/s",
        "primary_nominal": 1.5,
        "primary_fault": 5.2,
        "primary_std": 0.35,
        "secondary_key": "cycle_ms",
        "secondary_nominal": 1350.0,
        "secondary_fault": 2200.0,
        "secondary_std": 95.0,
        "temp_nominal_c": 57.0,
        "temp_fault_c": 84.0,
        "temp_std_c": 2.4,
    },
    "gas-flow-meter": {
        "domain": "gas-metering",
        "primary_key": "flow_nm3_h",
        "primary_unit": "Nm3/h",
        "primary_nominal": 420.0,
        "primary_fault": 1450.0,
        "primary_std": 28.0,
        "secondary_key": "pressure_bar",
        "secondary_nominal": 12.4,
        "secondary_fault": 19.5,
        "secondary_std": 0.5,
        "temp_nominal_c": 24.0,
        "temp_fault_c": 65.0,
        "temp_std_c": 1.5,
    },
    "methane-compressor": {
        "domain": "gas-metering",
        "primary_key": "pressure_bar",
        "primary_unit": "bar",
        "primary_nominal": 24.0,
        "primary_fault": 38.0,
        "primary_std": 1.1,
        "secondary_key": "flow_nm3_h",
        "secondary_nominal": 890.0,
        "secondary_fault": 1500.0,
        "secondary_std": 45.0,
        "temp_nominal_c": 68.0,
        "temp_fault_c": 95.0,
        "temp_std_c": 2.8,
    },
    "power-meter": {
        "domain": "power-generation",
        "primary_key": "power_kw",
        "primary_unit": "kW",
        "primary_nominal": 340.0,
        "primary_fault": 680.0,
        "primary_std": 18.0,
        "secondary_key": "frequency_hz",
        "secondary_nominal": 50.0,
        "secondary_fault": 50.9,
        "secondary_std": 0.04,
        "temp_nominal_c": 46.0,
        "temp_fault_c": 75.0,
        "temp_std_c": 1.8,
    },
    "turbine-generator": {
        "domain": "power-generation",
        "primary_key": "power_kw",
        "primary_unit": "kW",
        "primary_nominal": 2400.0,
        "primary_fault": 3800.0,
        "primary_std": 85.0,
        "secondary_key": "voltage_v",
        "secondary_nominal": 6300.0,
        "secondary_fault": 6950.0,
        "secondary_std": 45.0,
        "temp_nominal_c": 79.0,
        "temp_fault_c": 105.0,
        "temp_std_c": 2.9,
    },
}


@dataclass
class MachineProfile:
    machine_id: str
    line_id: str
    machine_type: str
    drift_ratio: float = 0.0
    in_maintenance_ticks: int = 0


def resolve_spec(machine_type: str) -> dict[str, Any]:
    return MACHINE_SPECS.get(machine_type, MACHINE_SPECS["plc-controller"])


def _quarantine_id(reason: str, payload: str) -> str:
    return hashlib.sha256(f"{reason}:{payload}".encode()).hexdigest()[:16]


def build_s3_client() -> Any | None:
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


def ensure_bucket(s3_client: Any, bucket: str) -> None:
    try:
        s3_client.head_bucket(Bucket=bucket)
    except ClientError:
        s3_client.create_bucket(Bucket=bucket)


def parse_topology(machines_arg: str | None) -> list[MachineProfile]:
    if not machines_arg:
        return [MachineProfile(m, line, t) for m, line, t in DEFAULT_TOPOLOGY]

    profiles: list[MachineProfile] = []
    for idx, raw_item in enumerate(machines_arg.split(",")):
        item = raw_item.strip()
        if not item:
            continue
        parts = item.split(":")
        machine_id = parts[0].strip()
        line_id = (
            parts[1].strip() if len(parts) > 1 and parts[1].strip() else f"line-0{(idx // 2) + 1}"
        )
        machine_type = (
            parts[2].strip()
            if len(parts) > 2 and parts[2].strip()
            else ("plc-controller" if line_id == "line-01" else "cnc-mill")
        )
        profiles.append(
            MachineProfile(machine_id=machine_id, line_id=line_id, machine_type=machine_type)
        )
    return profiles


def write_telemetry_contract(
    out_dir: Path,
    profiles: list[MachineProfile],
    interval_sec: float,
) -> Path:
    contract_path = out_dir / "telemetry_contract.json"
    effective_interval = max(0.01, interval_sec)
    rate_hz = round(1.0 / effective_interval, 4)
    expected_sample_sec = round(effective_interval * max(1, len(profiles)), 4)
    contract = {
        "schema_version": "2.0-common-envelope",
        "updated_at": datetime.now(UTC).isoformat(),
        "machine_count": len(profiles),
        "rate_hz": rate_hz,
        "expected_sample_sec": expected_sample_sec,
        "machines": [
            {
                "machine_id": p.machine_id,
                "line_id": p.line_id,
                "machine_type": p.machine_type,
                "domain": resolve_spec(p.machine_type)["domain"],
            }
            for p in profiles
        ],
    }
    contract_path.write_text(json.dumps(contract, indent=2), encoding="utf-8")
    return contract_path


def generate_event(
    profile: MachineProfile,
    rng: random.Random,
    now: datetime | None = None,
) -> dict[str, Any]:
    event_time = now or datetime.now(UTC)
    spec = resolve_spec(profile.machine_type)

    if profile.in_maintenance_ticks > 0:
        state = "MAINTENANCE"
        profile.in_maintenance_ticks -= 1
        profile.drift_ratio = max(0.0, profile.drift_ratio - 0.32)
    else:
        if rng.random() < 0.22:
            profile.drift_ratio = min(1.25, profile.drift_ratio + rng.uniform(0.05, 0.16))

        if profile.drift_ratio >= 0.92 or rng.random() < 0.05:
            state = "FAULT"
            profile.in_maintenance_ticks = 2
        elif profile.drift_ratio >= 0.48 or rng.random() < 0.12:
            state = "DEGRADED"
        else:
            state = rng.choices(["IDLE", "RUNNING"], weights=[0.18, 0.82], k=1)[0]

    if rng.random() < 0.08:
        event_time = event_time - timedelta(seconds=rng.randint(5, 45))

    idle_factor = 0.55 if state == "IDLE" else (0.25 if state == "MAINTENANCE" else 1.0)
    fault_bump = 0.38 if state == "FAULT" else (0.18 if state == "DEGRADED" else 0.0)
    spike_ratio = rng.uniform(0.25, 0.48) if rng.random() < 0.04 else 0.0
    excursion = min(1.5, profile.drift_ratio + fault_bump + spike_ratio)

    temp_span = max(8.0, spec["temp_fault_c"] - spec["temp_nominal_c"])
    temp_c = round(
        max(
            -20.0,
            spec["temp_nominal_c"] * (0.92 if state == "IDLE" else 1.0)
            + temp_span * excursion * 0.95
            + rng.gauss(0, spec["temp_std_c"]),
        ),
        2,
    )

    primary_span = max(1.0, spec["primary_fault"] - spec["primary_nominal"])
    primary_val = round(
        max(
            0.0,
            spec["primary_nominal"] * idle_factor
            + primary_span * excursion * 0.9
            + rng.gauss(0, spec["primary_std"]),
        ),
        2,
    )

    secondary_span = max(0.2, spec["secondary_fault"] - spec["secondary_nominal"])
    secondary_base = (
        spec["secondary_nominal"]
        if spec["secondary_key"] in ("frequency_hz", "voltage_v")
        else spec["secondary_nominal"] * idle_factor
    )
    secondary_val = round(
        max(
            0.01,
            secondary_base
            + secondary_span * excursion * 0.75
            + rng.gauss(0, spec["secondary_std"]),
        ),
        3,
    )

    metrics: dict[str, Any] = {
        "temp_c": temp_c,
        spec["primary_key"]: primary_val,
        spec["secondary_key"]: secondary_val,
    }

    level = "ERROR" if state == "FAULT" else ("WARN" if state == "DEGRADED" else "INFO")
    domain = spec["domain"]
    if state == "FAULT":
        if domain == "gas-metering":
            error_code = f"GAS-ERR-{rng.randint(100, 149)}"
        elif domain == "power-generation":
            error_code = f"PWR-ERR-{rng.randint(200, 249)}"
        else:
            error_code = f"ERR-{rng.randint(100, 199)}"
    else:
        error_code = None

    return {
        "event_id": f"evt-{uuid.uuid4().hex[:12]}",
        "timestamp": event_time.isoformat(),
        "machine_id": profile.machine_id,
        "line_id": profile.line_id,
        "machine_type": profile.machine_type,
        "domain": domain,
        "state": state,
        "level": level,
        "error_code": error_code,
        "metrics": metrics,
    }


def generate_malformed_record(machine_id: str, rng: random.Random) -> tuple[str, str]:
    kind = rng.choice(["invalid_type", "missing_timestamp", "corrupt_json", "out_of_range"])
    if kind == "invalid_type":
        payload = json.dumps(
            {
                "event_id": f"evt-bad-{uuid.uuid4().hex[:8]}",
                "timestamp": datetime.now(UTC).isoformat(),
                "machine_id": machine_id,
                "metrics": {"temp_c": "NOT_A_NUMBER"},
                "state": "RUNNING",
            }
        )
        return "invalid_numeric_type", payload
    if kind == "missing_timestamp":
        payload = json.dumps(
            {
                "event_id": f"evt-bad-{uuid.uuid4().hex[:8]}",
                "machine_id": machine_id,
                "metrics": {"temp_c": 58.1},
            }
        )
        return "missing_required_field", payload
    if kind == "out_of_range":
        payload = json.dumps(
            {
                "event_id": f"evt-bad-{uuid.uuid4().hex[:8]}",
                "timestamp": datetime.now(UTC).isoformat(),
                "machine_id": machine_id,
                "metrics": {"temp_c": 9999.0, "vibration_mm_s": -4.0, "cycle_ms": 900},
                "state": "FAULT",
            }
        )
        return "out_of_range_value", payload
    return "json_decode_error", '{"machine_id": "' + machine_id + '", "metrics": '


def upload_file_safe(s3_client: Any | None, bucket: str, key: str, file_path: Path) -> None:
    if s3_client is None or not file_path.exists():
        return
    try:
        ensure_bucket(s3_client, bucket)
        s3_client.upload_file(str(file_path), bucket, key)
    except (BotoCoreError, ClientError) as exc:
        print(json.dumps({"level": "WARN", "message": f"S3 upload skipped: {exc}"}), flush=True)


def rotate_log_segment(log_path: Path, segments_dir: Path, seq: int) -> Path | None:
    if not log_path.exists() or log_path.stat().st_size == 0:
        return None
    segments_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    segment_path = segments_dir / f"telemetry.{stamp}.{seq:04d}.jsonl"
    log_path.replace(segment_path)
    log_path.touch()
    return segment_path


def run_loop(
    interval_sec: float,
    out_dir: Path,
    quarantine_file: Path,
    profiles: list[MachineProfile],
    max_events: int | None = None,
    duration_minutes: float | None = None,
    rotate_max_lines: int = 2000,
    upload_s3: bool = False,
    seed: int = 42,
) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    segments_dir = out_dir / "segments"
    segments_dir.mkdir(parents=True, exist_ok=True)
    quarantine_file.parent.mkdir(parents=True, exist_ok=True)
    log_path = out_dir / "telemetry.jsonl"
    rng = random.Random(seed)  # noqa: S311

    write_telemetry_contract(out_dir=out_dir, profiles=profiles, interval_sec=interval_sec)

    s3_client = build_s3_client() if upload_s3 else None
    raw_bucket = os.getenv("S3_RAW_BUCKET", "machine-raw")
    quarantine_bucket = os.getenv("S3_QUARANTINE_BUCKET", "machine-quarantine")

    deadline_mono = (
        time.monotonic() + (duration_minutes * 60.0)
        if duration_minutes is not None and duration_minutes > 0
        else None
    )

    seen_quarantine_ids: set[str] = set()
    count = 0
    lines_in_current_segment = 0
    segment_seq = 0

    while (max_events is None or count < max_events) and (
        deadline_mono is None or time.monotonic() < deadline_mono
    ):
        profile = profiles[count % len(profiles)]
        roll = rng.random()

        if roll < 0.04:
            reason, bad_payload = generate_malformed_record(profile.machine_id, rng)
            qid = _quarantine_id(reason, bad_payload)
            if qid not in seen_quarantine_ids:
                seen_quarantine_ids.add(qid)
                q_entry = {
                    "quarantine_id": qid,
                    "quarantined_at": datetime.now(UTC).isoformat(),
                    "source": "simulator",
                    "error_reason": reason,
                    "raw_payload": bad_payload,
                }
                with quarantine_file.open("a", encoding="utf-8") as qf:
                    qf.write(json.dumps(q_entry) + "\n")
        elif roll < 0.07:
            _, dirty_payload = generate_malformed_record(profile.machine_id, rng)
            with log_path.open("a", encoding="utf-8") as lf:
                lf.write(dirty_payload + "\n")
            lines_in_current_segment += 1
        else:
            event = generate_event(profile=profile, rng=rng)
            line = json.dumps(event)
            with log_path.open("a", encoding="utf-8") as lf:
                lf.write(line + "\n")
            print(line, flush=True)
            lines_in_current_segment += 1

        if rotate_max_lines > 0 and lines_in_current_segment >= rotate_max_lines:
            segment_seq += 1
            rotated = rotate_log_segment(log_path, segments_dir, segment_seq)
            lines_in_current_segment = 0
            if rotated is not None and upload_s3:
                day_prefix = datetime.now(UTC).strftime("%Y-%m-%d")
                upload_file_safe(
                    s3_client,
                    raw_bucket,
                    f"raw/dt={day_prefix}/segments/{rotated.name}",
                    rotated,
                )

        count += 1
        if upload_s3 and count % 100 == 0:
            day_prefix = datetime.now(UTC).strftime("%Y-%m-%d")
            upload_file_safe(
                s3_client,
                quarantine_bucket,
                f"quarantine/dt={day_prefix}/quarantine.jsonl",
                quarantine_file,
            )

        if interval_sec > 0 and (max_events is None or count < max_events):
            if deadline_mono is None or time.monotonic() + interval_sec < deadline_mono:
                time.sleep(interval_sec)
            else:
                break


def main() -> None:
    parser = argparse.ArgumentParser(description="Multi-domain industrial telemetry simulator")
    parser.add_argument("--interval-sec", type=float, default=None)
    parser.add_argument(
        "--rate-hz", type=float, default=2.0, help="Target events per second across fleet"
    )
    parser.add_argument(
        "--duration-minutes", type=float, default=None, help="Optional run duration in minutes"
    )
    parser.add_argument(
        "--rotate-max-lines", type=int, default=2000, help="Rotate telemetry.jsonl after N lines"
    )
    parser.add_argument("--out-dir", type=Path, default=Path("/var/log/machines"))
    parser.add_argument(
        "--quarantine-file", type=Path, default=Path("/var/log/machines/quarantine.jsonl")
    )
    parser.add_argument(
        "--machines", type=str, default=None, help="Comma-separated M-01:line-01:plc-controller"
    )
    parser.add_argument("--max-events", type=int, default=None)
    parser.add_argument("--upload-s3", action="store_true")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    effective_interval = (
        args.interval_sec if args.interval_sec is not None else (1.0 / max(0.05, args.rate_hz))
    )
    profiles = parse_topology(args.machines)
    run_loop(
        interval_sec=effective_interval,
        out_dir=args.out_dir,
        quarantine_file=args.quarantine_file,
        profiles=profiles,
        max_events=args.max_events,
        duration_minutes=args.duration_minutes,
        rotate_max_lines=args.rotate_max_lines,
        upload_s3=args.upload_s3,
        seed=args.seed,
    )


if __name__ == "__main__":
    main()
