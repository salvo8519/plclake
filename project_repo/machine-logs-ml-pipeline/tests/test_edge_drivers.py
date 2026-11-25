from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest
from edge_gateway.collector import (
    ConnectionSpec,
    EdgeCollector,
    LocalSegmentSink,
    SpoolStore,
    TagBinding,
    normalize_raw_sample,
    poll_connection,
)
from edge_gateway.drivers import (
    MqttSubscriptionBuffer,
    decode_modbus_registers,
    extract_nested_value,
    parse_modbus_tag,
)
from edge_gateway.plc_simulator import VirtualPlcBench


def test_modbus_tag_parsing_and_decoding() -> None:
    t1 = parse_modbus_tag("HR:40001")
    assert (t1.area, t1.address, t1.data_type, t1.register_count) == ("HR", 0, "uint16", 1)

    t2 = parse_modbus_tag("HR:40003:float32")
    assert (t2.area, t2.address, t2.data_type, t2.register_count) == ("HR", 2, "float32", 2)

    t3 = parse_modbus_tag("IR:30001:int16")
    assert (t3.area, t3.address, t3.data_type, t3.register_count) == ("IR", 0, "int16", 1)

    assert decode_modbus_registers([0xFFF4], "int16") == -12
    assert decode_modbus_registers([0x416D, 0x999A], "float32") == pytest.approx(14.85, abs=0.01)
    assert decode_modbus_registers([0x999A, 0x416D], "float32_le") == pytest.approx(14.85, abs=0.01)


def test_live_modbus_tcp_and_http_rest_against_virtual_plc_bench() -> None:
    bench = VirtualPlcBench(
        host="127.0.0.1", modbus_port=0, http_port=0, http_bearer_token="meter_secret_123"
    )
    bench.start()
    prev_token = os.environ.get("EDGE_HTTP_METER_TOKEN")
    os.environ["EDGE_HTTP_METER_TOKEN"] = "meter_secret_123"
    try:
        # 1. Real wire-level Modbus TCP polling (uint16 + IEEE-754 float32 + signed int16 + coil)
        modbus_conn = ConnectionSpec(
            id="conn-gas-modbus",
            name="Methane Skid Modbus",
            machine_id="GAS-01",
            line_id="line-01",
            machine_type="gas-flow-meter",
            protocol="modbus-tcp",
            host="127.0.0.1",
            port=bench.modbus_port,
            endpoint_or_topic="unit=1",
            tag_bindings=[
                TagBinding(
                    source_tag="HR:40001",
                    target_metric="flow_nm3_h",
                    scale_factor=0.1,
                    unit="Nm3/h",
                ),
                TagBinding(
                    source_tag="HR:40003:float32",
                    target_metric="pressure_bar",
                    scale_factor=1.0,
                    unit="bar",
                ),
                TagBinding(
                    source_tag="HR:40005", target_metric="temp_c", scale_factor=0.1, unit="C"
                ),
                TagBinding(
                    source_tag="IR:30001:int16",
                    target_metric="ambient_delta_c",
                    scale_factor=0.1,
                    unit="C",
                ),
                TagBinding(
                    source_tag="COIL:1", target_metric="valve_open", scale_factor=1.0, unit="bool"
                ),
            ],
        )
        raw_modbus = poll_connection(modbus_conn, timeout_sec=2.0)
        envelope = normalize_raw_sample(modbus_conn, raw_modbus)
        assert envelope["domain"] == "gas-metering"
        assert envelope["metrics"]["flow_nm3_h"] == pytest.approx(425.0, abs=0.1)
        assert envelope["metrics"]["pressure_bar"] == pytest.approx(14.85, abs=0.02)
        assert envelope["metrics"]["temp_c"] == pytest.approx(23.6, abs=0.1)
        assert envelope["metrics"]["ambient_delta_c"] == pytest.approx(-1.2, abs=0.05)
        assert envelope["metrics"]["valve_open"] == 1.0

        # 2. Real HTTP REST Smart Meter polling with Bearer token & dot-path extraction
        http_conn = ConnectionSpec(
            id="conn-pwr-http",
            name="Substation Smart Meter",
            machine_id="PWR-01",
            line_id="line-02",
            machine_type="power-meter",
            protocol="http-rest-meter",
            host="127.0.0.1",
            port=bench.http_port,
            endpoint_or_topic="/api/v1/telemetry",
            auth_mode="bearer-token",
            tag_bindings=[
                TagBinding(
                    source_tag="metrics.active_power_kw",
                    target_metric="active_power_kw",
                    scale_factor=1.0,
                    unit="kW",
                ),
                TagBinding(
                    source_tag="metrics.power_factor",
                    target_metric="power_factor",
                    scale_factor=1.0,
                    unit="pf",
                ),
                TagBinding(
                    source_tag="metrics.temp_c", target_metric="temp_c", scale_factor=1.0, unit="C"
                ),
            ],
        )
        raw_http = poll_connection(http_conn, timeout_sec=2.0)
        http_env = normalize_raw_sample(http_conn, raw_http)
        assert http_env["domain"] == "power-generation"
        assert http_env["metrics"]["active_power_kw"] == pytest.approx(312.4, abs=0.01)
        assert http_env["metrics"]["power_factor"] == pytest.approx(0.96, abs=0.001)
        assert http_env["metrics"]["temp_c"] == pytest.approx(44.2, abs=0.01)

        # 3. End-to-end EdgeCollector run_once -> SQLite WAL spool -> LocalSegmentSink flush
        with tempfile.TemporaryDirectory() as tmp:
            spool = SpoolStore(Path(tmp) / "spool.db")
            sink = LocalSegmentSink(Path(tmp) / "out")
            collector = EdgeCollector(connections=[modbus_conn, http_conn], spool=spool, sink=sink)
            stats = collector.run_once()
            assert stats["collected"] == 2
            assert stats["flushed"] == 2
            assert stats["remaining_spool"] == 0
            assert stats["poll_errors"] == []
    finally:
        if prev_token is None:
            os.environ.pop("EDGE_HTTP_METER_TOKEN", None)
        else:
            os.environ["EDGE_HTTP_METER_TOKEN"] = prev_token
        bench.stop()


def test_mqtt_sparkplug_b_and_nested_payload_extraction() -> None:
    sparkplug_payload = {
        "timestamp": 1763800000000,
        "metrics": [
            {"name": "flow_nm3_h", "value": 512.75},
            {"name": "temp_c", "value": 24.4},
        ],
    }
    assert extract_nested_value(sparkplug_payload, "metrics.flow_nm3_h") == 512.75

    buf = MqttSubscriptionBuffer()
    bindings = [
        TagBinding(source_tag="metrics.flow_nm3_h", target_metric="flow_nm3_h", scale_factor=1.0),
        TagBinding(source_tag="metrics.temp_c", target_metric="temp_c", scale_factor=1.0),
    ]
    buf.ingest_payload("conn-mqtt-1", sparkplug_payload, bindings)
    popped = buf.pop_latest("conn-mqtt-1")
    assert popped["metrics.flow_nm3_h"] == 512.75
    assert popped["metrics.temp_c"] == 24.4
