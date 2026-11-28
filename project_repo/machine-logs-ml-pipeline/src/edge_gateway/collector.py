from __future__ import annotations

import argparse
import json
import os
import socket
import sqlite3
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from edge_gateway.drivers import (
    MqttSubscriptionBuffer,
    poll_http_rest_meter,
    poll_modbus_tcp,
    poll_opcua,
)

DOMAIN_BY_MACHINE_TYPE: dict[str, str] = {
    "plc-controller": "manufacturing",
    "siemens-s7-1500": "manufacturing",
    "rockwell-controllogix": "manufacturing",
    "cnc-mill": "manufacturing",
    "gas-flow-meter": "gas-metering",
    "methane-compressor": "gas-metering",
    "power-meter": "power-generation",
    "turbine-generator": "power-generation",
}


@dataclass
class TagBinding:
    source_tag: str
    target_metric: str
    scale_factor: float = 1.0
    unit: str = ""


@dataclass
class ConnectionSpec:
    id: str
    name: str
    machine_id: str
    line_id: str
    machine_type: str
    protocol: str
    host: str
    port: int
    endpoint_or_topic: str
    poll_interval_sec: float = 5.0
    auth_mode: str = "anonymous"
    # HTTP REST meters: explicit TLS flag from the console. None = legacy config (port 443 rule).
    use_tls: bool | None = None
    domain: str | None = None
    tag_bindings: list[TagBinding] = field(default_factory=list)


def normalize_raw_sample(
    conn: ConnectionSpec,
    raw_readings: dict[str, Any],
    state: str = "RUNNING",
    error_code: str | None = None,
    ts: datetime | None = None,
) -> dict[str, Any]:
    """Map PLC registers/OPC-UA nodes/JSON fields into Common Telemetry Envelope v2."""
    event_time = ts or datetime.now(UTC)
    metrics: dict[str, float] = {}
    for binding in conn.tag_bindings:
        if binding.source_tag in raw_readings and raw_readings[binding.source_tag] is not None:
            val = float(raw_readings[binding.source_tag]) * float(binding.scale_factor)
            metrics[binding.target_metric] = round(val, 4)

    if "temp_c" not in metrics and "temp_c" in raw_readings and raw_readings["temp_c"] is not None:
        metrics["temp_c"] = round(float(raw_readings["temp_c"]), 2)

    normalized_state = state.upper()
    level = (
        "ERROR"
        if normalized_state == "FAULT"
        else ("WARN" if normalized_state == "DEGRADED" else "INFO")
    )
    domain = conn.domain or DOMAIN_BY_MACHINE_TYPE.get(conn.machine_type, "manufacturing")

    return {
        "event_id": f"gw-{conn.machine_id}-{uuid.uuid4().hex[:12]}",
        "timestamp": event_time.isoformat(),
        "machine_id": conn.machine_id,
        "line_id": conn.line_id,
        "machine_type": conn.machine_type,
        "domain": domain,
        "state": normalized_state,
        "level": level,
        "error_code": error_code,
        "metrics": metrics,
        "source_protocol": conn.protocol,
        "source_host": f"{conn.host}:{conn.port}",
    }


def parse_connections_payload(raw: dict[str, Any]) -> tuple[dict[str, Any], list[ConnectionSpec]]:
    conns: list[ConnectionSpec] = []
    for item in raw.get("connections", []):
        bindings = [
            TagBinding(
                source_tag=str(b["source_tag"]),
                target_metric=str(b["target_metric"]),
                scale_factor=float(b.get("scale_factor", 1.0)),
                unit=str(b.get("unit", "")),
            )
            for b in item.get("tag_bindings", [])
        ]
        conns.append(
            ConnectionSpec(
                id=str(item["id"]),
                name=str(item.get("name", item["machine_id"])),
                machine_id=str(item["machine_id"]),
                line_id=str(item.get("line_id", "line-01")),
                machine_type=str(item.get("machine_type", "plc-controller")),
                protocol=str(item.get("protocol", "opcua")),
                host=str(item["host"]),
                port=int(item["port"]),
                endpoint_or_topic=str(item.get("endpoint_or_topic", "/")),
                poll_interval_sec=float(item.get("poll_interval_sec", 5.0)),
                auth_mode=str(item.get("auth_mode", "anonymous")),
                use_tls=item["use_tls"] if isinstance(item.get("use_tls"), bool) else None,
                domain=str(item["domain"]) if item.get("domain") else None,
                tag_bindings=bindings,
            )
        )
    return raw, conns


def load_connections_config(config_path: Path) -> tuple[dict[str, Any], list[ConnectionSpec]]:
    raw = json.loads(config_path.read_text(encoding="utf-8"))
    return parse_connections_payload(raw)


class EdgeConfigSyncClient:
    """
    Plug & Play remote topology sync: pulls GET /api/v1/edge/config, checks config_hash,
    persists an atomic local cache for offline restarts, and returns hot-reloaded connections.
    """

    def __init__(
        self,
        config_url: str,
        token: str | None = None,
        cache_path: Path | None = None,
        timeout_sec: float = 4.0,
    ) -> None:
        self.config_url = config_url
        self.token = token.strip() if token else None
        self.cache_path = cache_path
        self.timeout_sec = timeout_sec
        self.last_hash: str | None = None

    def fetch_if_changed(self) -> tuple[bool, dict[str, Any] | None, list[ConnectionSpec] | None]:
        headers = {"Accept": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        if not self.config_url.startswith(("http://", "https://")):
            raise ValueError(f"Unsupported config URL scheme: {self.config_url}")
        req = urllib.request.Request(self.config_url, headers=headers, method="GET")  # noqa: S310
        with urllib.request.urlopen(req, timeout=self.timeout_sec) as resp:  # noqa: S310
            raw = json.loads(resp.read().decode("utf-8"))

        new_hash = str(raw.get("config_hash", ""))
        if self.last_hash and new_hash == self.last_hash:
            return False, None, None

        if self.cache_path is not None:
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            tmp_path = self.cache_path.with_suffix(".tmp")
            tmp_path.write_text(json.dumps(raw, indent=2), encoding="utf-8")
            tmp_path.replace(self.cache_path)

        self.last_hash = new_hash
        meta, conns = parse_connections_payload(raw)
        return True, meta, conns


# HTTP statuses meaning "this payload will never be accepted": retrying would block the spool.
# 401/403/408/429 and 5xx are transient or configuration issues and are retried.
PERMANENT_REJECTION_STATUSES = frozenset({400, 413, 422})


class SpoolStore:
    """Crash-safe SQLite WAL store-and-forward queue for VPN/WAN outages."""

    def __init__(self, db_path: Path, max_mb: int = 1024) -> None:
        self.db_path = db_path
        self.max_bytes = max(16, max_mb) * 1024 * 1024
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        con = sqlite3.connect(str(self.db_path), timeout=10.0)
        con.execute("PRAGMA journal_mode=WAL;")
        con.execute("PRAGMA synchronous=NORMAL;")
        return con

    def _init_schema(self) -> None:
        with self._connect() as con:
            con.execute(
                """
                CREATE TABLE IF NOT EXISTS spooled_events (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_id TEXT UNIQUE NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                """
            )
            con.execute(
                """
                CREATE TABLE IF NOT EXISTS dead_letter_events (
                    seq INTEGER PRIMARY KEY,
                    event_id TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    rejected_at TEXT NOT NULL
                );
                """
            )
            con.commit()

    def count(self) -> int:
        with self._connect() as con:
            row = con.execute("SELECT COUNT(*) FROM spooled_events;").fetchone()
            return int(row[0]) if row else 0

    def enqueue(self, events: list[dict[str, Any]]) -> int:
        if not events:
            return 0
        if self.db_path.exists() and self.db_path.stat().st_size > self.max_bytes:
            self._evict_oldest(limit=max(100, len(events)))

        now_iso = datetime.now(UTC).isoformat()
        rows = [
            (str(ev["event_id"]), json.dumps(ev, separators=(",", ":")), now_iso) for ev in events
        ]
        with self._connect() as con:
            con.executemany(
                "INSERT OR IGNORE INTO spooled_events (event_id, payload_json, created_at) VALUES (?, ?, ?);",
                rows,
            )
            con.commit()
        return len(rows)

    def _evict_oldest(self, limit: int) -> None:
        with self._connect() as con:
            con.execute(
                "DELETE FROM spooled_events WHERE seq IN (SELECT seq FROM spooled_events ORDER BY seq ASC LIMIT ?);",
                (limit,),
            )
            con.commit()

    def peek_batch(self, batch_size: int = 200) -> list[tuple[int, dict[str, Any]]]:
        with self._connect() as con:
            rows = con.execute(
                "SELECT seq, payload_json FROM spooled_events ORDER BY seq ASC LIMIT ?;",
                (batch_size,),
            ).fetchall()
        return [(int(seq), json.loads(payload_json)) for seq, payload_json in rows]

    def dead_letter(self, seqs: list[int], reason: str) -> int:
        """Moves rejected events out of the live queue so they cannot block later telemetry."""
        if not seqs:
            return 0
        # Only "?" placeholders are interpolated; every value is a bound parameter.
        in_clause = f"seq IN ({','.join('?' for _ in seqs)})"
        move_sql = f"INSERT OR REPLACE INTO dead_letter_events (seq, event_id, payload_json, reason, rejected_at) SELECT seq, event_id, payload_json, ?, ? FROM spooled_events WHERE {in_clause};"  # noqa: S608, E501
        delete_sql = f"DELETE FROM spooled_events WHERE {in_clause};"  # noqa: S608
        now_iso = datetime.now(UTC).isoformat()
        with self._connect() as con:
            con.execute(move_sql, [reason[:500], now_iso, *seqs])
            moved = con.execute(delete_sql, seqs).rowcount
            con.commit()
        return int(moved)

    def dead_letter_count(self) -> int:
        with self._connect() as con:
            row = con.execute("SELECT COUNT(*) FROM dead_letter_events;").fetchone()
            return int(row[0]) if row else 0

    def ack_seqs(self, seqs: list[int]) -> None:
        if not seqs:
            return
        placeholders = ",".join("?" for _ in seqs)
        with self._connect() as con:
            con.execute(f"DELETE FROM spooled_events WHERE seq IN ({placeholders});", seqs)  # noqa: S608
            con.commit()


class HttpBatchSink:
    """Pushes normalized event batches to POST /api/v1/ingest/batch with optional Bearer token auth."""

    def __init__(self, ingest_url: str, token: str | None = None, timeout_sec: float = 5.0) -> None:
        self.ingest_url = ingest_url
        self.token = token.strip() if token else None
        self.timeout_sec = timeout_sec

    def push_batch(self, events: list[dict[str, Any]]) -> dict[str, Any]:
        body = json.dumps({"events": events}).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"

        if not self.ingest_url.startswith(("http://", "https://")):
            raise ValueError(f"Unsupported ingest URL scheme: {self.ingest_url}")
        req = urllib.request.Request(self.ingest_url, data=body, headers=headers, method="POST")  # noqa: S310
        with urllib.request.urlopen(req, timeout=self.timeout_sec) as resp:  # noqa: S310
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {"accepted": len(events)}


class LocalSegmentSink:
    """Writes normalized events directly into local JSONL segments when installed on-premise alongside builder."""

    def __init__(self, out_dir: Path, rotate_max_lines: int = 2000) -> None:
        self.out_dir = out_dir
        self.segments_dir = out_dir / "segments"
        self.log_path = out_dir / "telemetry.jsonl"
        self.rotate_max_lines = rotate_max_lines
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.segments_dir.mkdir(parents=True, exist_ok=True)
        self._seq = 0

    def push_batch(self, events: list[dict[str, Any]]) -> dict[str, Any]:
        if not events:
            return {"accepted": 0}
        with self.log_path.open("a", encoding="utf-8") as f:
            for ev in events:
                f.write(json.dumps(ev) + "\n")

        with self.log_path.open("r", encoding="utf-8") as lf:
            line_count = sum(1 for _ in lf)
        if line_count >= self.rotate_max_lines:
            self._seq += 1
            stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
            rotated = self.segments_dir / f"telemetry.{stamp}.{self._seq:04d}.jsonl"
            self.log_path.replace(rotated)
            self.log_path.touch()
        return {"accepted": len(events)}


_MQTT_BUFFER = MqttSubscriptionBuffer()


def poll_connection(conn: ConnectionSpec, timeout_sec: float = 2.5) -> dict[str, Any]:
    """
    Poll an industrial endpoint via its configured protocol using production OT drivers.
    Supports HTTP/REST (Bearer + dot-paths), Modbus TCP (pymodbus or zero-dep MBAP with
    uint16/int16/float32), OPC-UA (anonymous/user-pass/X.509), and MQTT Sparkplug (TLS/auth).
    """
    if conn.protocol == "http-rest-meter":
        return poll_http_rest_meter(
            host=conn.host,
            port=conn.port,
            endpoint_or_topic=conn.endpoint_or_topic,
            auth_mode=conn.auth_mode,
            tag_bindings=conn.tag_bindings,
            timeout_sec=timeout_sec,
            use_tls=conn.use_tls,
        )

    if conn.protocol == "modbus-tcp":
        return poll_modbus_tcp(
            host=conn.host,
            port=conn.port,
            endpoint_or_topic=conn.endpoint_or_topic,
            tag_bindings=conn.tag_bindings,
            timeout_sec=timeout_sec,
        )

    if conn.protocol == "opcua":
        return poll_opcua(
            host=conn.host,
            port=conn.port,
            endpoint_or_topic=conn.endpoint_or_topic,
            auth_mode=conn.auth_mode,
            tag_bindings=conn.tag_bindings,
            timeout_sec=timeout_sec,
        )

    if conn.protocol == "mqtt-sparkplug":
        _MQTT_BUFFER.ensure_started(conn)
        cached = _MQTT_BUFFER.pop_latest(conn.id)
        if cached:
            return cached
        with socket.create_connection((conn.host, conn.port), timeout=timeout_sec):
            return {}

    with socket.create_connection((conn.host, conn.port), timeout=timeout_sec):
        return {}


class EdgeCollector:
    """Polls OT connections, auto-syncs console topology, spools into SQLite WAL, and flushes to Ingest API."""

    def __init__(
        self,
        connections: list[ConnectionSpec],
        spool: SpoolStore,
        sink: HttpBatchSink | LocalSegmentSink,
        batch_size: int = 200,
        config_sync: EdgeConfigSyncClient | None = None,
        sync_interval_sec: float = 30.0,
    ) -> None:
        self.connections = connections
        self.spool = spool
        self.sink = sink
        self.batch_size = batch_size
        self.config_sync = config_sync
        self.sync_interval_sec = max(5.0, sync_interval_sec)
        self._last_sync_mono = 0.0

    def sync_config_if_due(self, force: bool = False) -> bool:
        if self.config_sync is None:
            return False
        now_mono = time.monotonic()
        if not force and (now_mono - self._last_sync_mono) < self.sync_interval_sec:
            return False
        self._last_sync_mono = now_mono
        try:
            changed, _meta, new_conns = self.config_sync.fetch_if_changed()
            if changed and new_conns is not None:
                self.connections = new_conns
                print(
                    json.dumps(
                        {
                            "level": "INFO",
                            "message": f"Hot-reloaded {len(new_conns)} PLC/meter connections from console",
                            "config_hash": self.config_sync.last_hash,
                        }
                    ),
                    flush=True,
                )
                return True
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
            print(
                json.dumps(
                    {
                        "level": "WARN",
                        "message": f"Config auto-sync skipped (keeping active list): {exc}",
                    }
                ),
                flush=True,
            )
        return False

    def flush_spool(self) -> dict[str, int]:
        flushed = 0
        failed_batches = 0
        dead_lettered = 0
        batch_size = self.batch_size
        while True:
            batch = self.spool.peek_batch(batch_size)
            if not batch:
                break
            seqs = [seq for seq, _ in batch]
            events = [ev for _, ev in batch]
            try:
                self.sink.push_batch(events)
                self.spool.ack_seqs(seqs)
                flushed += len(events)
            except urllib.error.HTTPError as exc:
                if exc.code == 413 and len(batch) > 1:
                    # Payload too large: retry the same events in smaller batches.
                    batch_size = max(1, len(batch) // 2)
                    continue
                if exc.code in PERMANENT_REJECTION_STATUSES:
                    # The server will never accept these events: park them in the dead-letter
                    # table instead of blocking every later batch at the head of the queue.
                    dead_lettered += self.spool.dead_letter(seqs, f"HTTP {exc.code}: {exc.reason}")
                    print(
                        json.dumps(
                            {
                                "level": "ERROR",
                                "message": f"Ingest rejected {len(seqs)} events (HTTP {exc.code}); moved to dead-letter table",
                            }
                        ),
                        flush=True,
                    )
                    continue
                failed_batches += 1
                print(
                    json.dumps(
                        {
                            "level": "WARN",
                            "message": f"Ingest returned HTTP {exc.code}; retained {self.spool.count()} events in SQLite spool",
                        }
                    ),
                    flush=True,
                )
                break
            except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
                failed_batches += 1
                print(
                    json.dumps(
                        {
                            "level": "WARN",
                            "message": f"Ingest unreachable; retained {self.spool.count()} events in SQLite spool ({exc})",
                        }
                    ),
                    flush=True,
                )
                break
        return {
            "flushed": flushed,
            "failed_batches": failed_batches,
            "dead_lettered": dead_lettered,
            "remaining_spool": self.spool.count(),
        }

    def run_once(self, force_sync: bool = False) -> dict[str, Any]:
        config_reloaded = self.sync_config_if_due(force=force_sync)
        collected: list[dict[str, Any]] = []
        poll_errors: list[dict[str, str]] = []
        for conn in self.connections:
            try:
                raw = poll_connection(conn)
                if raw:
                    collected.append(normalize_raw_sample(conn, raw))
            except Exception as exc:  # noqa: BLE001
                poll_errors.append({"connection_id": conn.id, "error": str(exc)})

        self.spool.enqueue(collected)
        flush_stats = self.flush_spool()
        return {
            "collected": len(collected),
            "config_reloaded": config_reloaded,
            "active_connections": len(self.connections),
            "poll_errors": poll_errors,
            **flush_stats,
        }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="On-Premise Industrial Edge Gateway Collector (Plug & Play)"
    )
    parser.add_argument("--config", type=Path, default=Path("/etc/edge-gateway/connections.json"))
    parser.add_argument("--config-url", type=str, default=os.getenv("EDGE_CONFIG_URL", ""))
    parser.add_argument(
        "--config-sync-sec", type=float, default=float(os.getenv("EDGE_CONFIG_SYNC_SEC", "30"))
    )
    parser.add_argument(
        "--config-cache", type=Path, default=Path("/var/spool/edge-gateway/connections.cache.json")
    )
    parser.add_argument(
        "--spool-db",
        type=Path,
        default=Path(os.getenv("EDGE_SPOOL_DB", "/var/spool/edge-gateway/spool.db")),
    )
    parser.add_argument("--ingest-url", type=str, default=os.getenv("EDGE_INGEST_URL", ""))
    parser.add_argument(
        "--local-out-dir",
        type=Path,
        default=None,
        help="Write JSONL segments locally instead of HTTP push",
    )
    parser.add_argument("--interval-sec", type=float, default=5.0)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()

    meta: dict[str, Any] = {}
    conns: list[ConnectionSpec] = []
    if args.config_cache.exists():
        meta, conns = load_connections_config(args.config_cache)
    elif args.config.exists():
        meta, conns = load_connections_config(args.config)

    token = os.getenv("EDGE_GATEWAY_TOKEN")
    sync_client = (
        EdgeConfigSyncClient(config_url=args.config_url, token=token, cache_path=args.config_cache)
        if args.config_url
        else None
    )

    spool = SpoolStore(
        args.spool_db, max_mb=int(meta.get("spool_max_mb", os.getenv("EDGE_SPOOL_MAX_MB", "1024")))
    )
    if args.local_out_dir is not None:
        sink: HttpBatchSink | LocalSegmentSink = LocalSegmentSink(args.local_out_dir)
    else:
        target_url = args.ingest_url or str(
            meta.get("ingest_api_url", "http://localhost:3000/api/v1/ingest/batch")
        )
        sink = HttpBatchSink(ingest_url=target_url, token=token)

    collector = EdgeCollector(
        connections=conns,
        spool=spool,
        sink=sink,
        config_sync=sync_client,
        sync_interval_sec=args.config_sync_sec,
    )
    if args.once:
        print(json.dumps(collector.run_once(force_sync=True)), flush=True)
        return

    while True:
        print(json.dumps(collector.run_once()), flush=True)
        time.sleep(max(0.5, args.interval_sec))


if __name__ == "__main__":
    main()
