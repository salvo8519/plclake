from __future__ import annotations

import http.server
import json
import socket
import tempfile
import threading
import unittest
from pathlib import Path

from edge_gateway.collector import (
    ConnectionSpec,
    EdgeCollector,
    EdgeConfigSyncClient,
    HttpBatchSink,
    LocalSegmentSink,
    SpoolStore,
    TagBinding,
    normalize_raw_sample,
)


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class EdgeGatewayTests(unittest.TestCase):
    def test_normalize_scales_modbus_registers_to_common_envelope(self) -> None:
        conn = ConnectionSpec(
            id="conn-gas-1",
            name="Biomethane Flow",
            machine_id="M-10",
            line_id="line-02",
            machine_type="gas-flow-meter",
            protocol="modbus-tcp",
            host="192.168.10.24",
            port=502,
            endpoint_or_topic="unit=1;hr=40001..40006",
            tag_bindings=[
                TagBinding("HR:40001", "flow_nm3_h", 0.1, "Nm3/h"),
                TagBinding("HR:40003", "pressure_bar", 0.01, "bar"),
                TagBinding("HR:40005", "temp_c", 0.1, "C"),
            ],
        )
        envelope = normalize_raw_sample(
            conn,
            {"HR:40001": 4255, "HR:40003": 1480, "HR:40005": 245},
        )
        self.assertEqual(envelope["domain"], "gas-metering")
        self.assertEqual(envelope["machine_id"], "M-10")
        self.assertEqual(envelope["metrics"]["flow_nm3_h"], 425.5)
        self.assertEqual(envelope["metrics"]["pressure_bar"], 14.8)
        self.assertEqual(envelope["metrics"]["temp_c"], 24.5)

    def test_sqlite_spool_buffers_offline_then_flushes_with_bearer_auth(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            spool = SpoolStore(Path(tmp) / "spool.db", max_mb=64)
            meter_port = _free_port()
            ingest_port = _free_port()

            # Start fake smart HTTP meter
            class MeterHandler(http.server.BaseHTTPRequestHandler):
                def do_GET(self) -> None:  # noqa: N802
                    body = json.dumps({"power_kw": 352.4, "frequency_hz": 50.01, "temp_c": 44.2}).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(body)

                def log_message(self, format: str, *args: object) -> None:
                    return

            meter_srv = http.server.ThreadingHTTPServer(("127.0.0.1", meter_port), MeterHandler)
            meter_thread = threading.Thread(target=meter_srv.serve_forever, daemon=True)
            meter_thread.start()

            try:
                conn = ConnectionSpec(
                    id="conn-pwr-http",
                    name="Power Meter HTTP",
                    machine_id="M-20",
                    line_id="line-03",
                    machine_type="power-meter",
                    protocol="http-rest-meter",
                    host="127.0.0.1",
                    port=meter_port,
                    endpoint_or_topic="/api/v1/telemetry",
                    tag_bindings=[
                        TagBinding("power_kw", "power_kw", 1.0, "kW"),
                        TagBinding("frequency_hz", "frequency_hz", 1.0, "Hz"),
                        TagBinding("temp_c", "temp_c", 1.0, "C"),
                    ],
                )
                sink = HttpBatchSink(
                    ingest_url=f"http://127.0.0.1:{ingest_port}/api/v1/ingest/batch",
                    token="gw_test_secret",
                    timeout_sec=1.5,
                )
                collector = EdgeCollector(connections=[conn], spool=spool, sink=sink)

                # Phase 1: Ingest server down -> event must persist in SQLite spool
                offline_res = collector.run_once()
                self.assertEqual(offline_res["collected"], 1)
                self.assertEqual(offline_res["flushed"], 0)
                self.assertEqual(spool.count(), 1)

                # Phase 2: Ingest server online -> spool drains FIFO with Bearer token
                received: list[dict[str, object]] = []
                auth_headers: list[str] = []

                class IngestHandler(http.server.BaseHTTPRequestHandler):
                    def do_POST(self) -> None:  # noqa: N802
                        auth_headers.append(self.headers.get("Authorization", ""))
                        length = int(self.headers.get("Content-Length", "0"))
                        data = json.loads(self.rfile.read(length).decode("utf-8"))
                        received.extend(data.get("events", []))
                        self.send_response(202)
                        self.send_header("Content-Type", "application/json")
                        self.end_headers()
                        self.wfile.write(json.dumps({"accepted": len(data.get("events", []))}).encode("utf-8"))

                    def log_message(self, format: str, *args: object) -> None:
                        return

                ingest_srv = http.server.ThreadingHTTPServer(("127.0.0.1", ingest_port), IngestHandler)
                ingest_thread = threading.Thread(target=ingest_srv.serve_forever, daemon=True)
                ingest_thread.start()
                try:
                    online_res = collector.run_once()
                    self.assertEqual(online_res["collected"], 1)
                    self.assertEqual(online_res["flushed"], 2)
                    self.assertEqual(spool.count(), 0)
                    self.assertEqual(len(received), 2)
                    self.assertEqual(auth_headers[0], "Bearer gw_test_secret")
                finally:
                    ingest_srv.shutdown()
                    ingest_srv.server_close()
            finally:
                meter_srv.shutdown()
                meter_srv.server_close()

    def test_plug_and_play_config_auto_sync_and_cache(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            cache_file = tmp_path / "connections.cache.json"
            spool = SpoolStore(tmp_path / "spool.db", max_mb=32)
            cfg_port = _free_port()
            observed_auth: list[str] = []

            remote_payload = {
                "config_hash": "abc12345",
                "connections": [
                    {
                        "id": "conn-sync-1",
                        "name": "Synced Gas Meter",
                        "machine_id": "M-SYNC-01",
                        "line_id": "line-09",
                        "machine_type": "gas-flow-meter",
                        "protocol": "modbus-tcp",
                        "host": "127.0.0.1",
                        "port": 1502,
                        "endpoint_or_topic": "unit=1",
                        "poll_interval_sec": 2,
                        "auth_mode": "anonymous",
                        "tag_bindings": [
                            {"source_tag": "HR:40001", "target_metric": "flow_nm3_h", "scale_factor": 0.1, "unit": "Nm3/h"}
                        ],
                    }
                ],
            }

            class CfgHandler(http.server.BaseHTTPRequestHandler):
                def do_GET(self) -> None:  # noqa: N802
                    observed_auth.append(self.headers.get("Authorization", ""))
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps(remote_payload).encode("utf-8"))

                def log_message(self, format: str, *args: object) -> None:
                    return

            srv = http.server.ThreadingHTTPServer(("127.0.0.1", cfg_port), CfgHandler)
            thread = threading.Thread(target=srv.serve_forever, daemon=True)
            thread.start()
            try:
                sync = EdgeConfigSyncClient(
                    config_url=f"http://127.0.0.1:{cfg_port}/api/v1/edge/config",
                    token="gw_sync_secret",
                    cache_path=cache_file,
                )
                collector = EdgeCollector(
                    connections=[],
                    spool=spool,
                    sink=LocalSegmentSink(tmp_path / "logs"),
                    config_sync=sync,
                )
                reloaded = collector.sync_config_if_due(force=True)
                self.assertTrue(reloaded)
                self.assertEqual(len(collector.connections), 1)
                self.assertEqual(collector.connections[0].machine_id, "M-SYNC-01")
                self.assertEqual(observed_auth[0], "Bearer gw_sync_secret")
                self.assertTrue(cache_file.exists())

                # Second poll with unchanged hash does not reload redundantly
                self.assertFalse(collector.sync_config_if_due(force=True))
            finally:
                srv.shutdown()
                srv.server_close()

    def test_local_segment_sink_writes_and_rotates(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp) / "logs"
            sink = LocalSegmentSink(out_dir=out_dir, rotate_max_lines=2)
            sink.push_batch([{"event_id": "e1"}, {"event_id": "e2"}])
            segments = list((out_dir / "segments").glob("telemetry.*.jsonl"))
            self.assertEqual(len(segments), 1)
            self.assertEqual(len(segments[0].read_text(encoding="utf-8").splitlines()), 2)


if __name__ == "__main__":
    unittest.main()
