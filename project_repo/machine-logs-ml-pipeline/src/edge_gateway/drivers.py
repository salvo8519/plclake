"""
Production-grade Industrial OT Protocol Drivers for Edge Gateway Collector.

Supported protocols:
  - modbus-tcp: Supports pymodbus (when installed) plus a built-in zero-dependency
    binary Modbus TCP (MBAP) client supporting FC01 (Coils), FC02 (Discrete Inputs),
    FC03 (Holding Registers), and FC04 (Input Registers) with uint16/int16/uint32/
    int32/float32/float32_le decoding and automatic Modicon 40001/30001 addressing.
  - opcua: Supports asyncua (sync) and legacy python-opcua with anonymous,
    username-password, and X.509 certificate (Basic256Sha256) authentication.
  - mqtt-sparkplug: Supports paho-mqtt v2 with TLS (port 8883 / EDGE_MQTT_TLS),
    username/password auth, nested JSON dot-paths, and Sparkplug B metric arrays.
  - http-rest-meter: Supports HTTP/HTTPS GET with optional Bearer token auth and
    nested JSON dot-path extraction.
"""

from __future__ import annotations

import json
import os
import re
import socket
import ssl
import struct
import threading
import urllib.request
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ParsedModbusTag:
    area: str  # HR | IR | COIL | DI
    address: int  # 0-based PDU address
    data_type: str  # uint16 | int16 | uint32 | int32 | float32 | float32_le | bool
    register_count: int


_MODBUS_TAG_RE = re.compile(
    r"^(HR|IR|COIL|DI):(\d+)(?::(uint16|int16|uint32|int32|float32|float32_le|bool))?$",
    re.IGNORECASE,
)


def parse_modbus_tag(source_tag: str) -> ParsedModbusTag:
    """
    Parse industrial Modbus tag notation into PDU address & data type.

    Examples:
      HR:40001          -> area=HR, address=0, uint16 (Modicon 1-based offset)
      HR:40003:float32  -> area=HR, address=2, float32 (2 registers, big-endian)
      HR:100:int16      -> area=HR, address=100, int16 (direct 0-based address)
      IR:30001:float32  -> area=IR, address=0, float32
      COIL:1            -> area=COIL, address=0, bool
      DI:10001          -> area=DI, address=0, bool
    """
    match = _MODBUS_TAG_RE.match(source_tag.strip())
    if not match:
        raise ValueError(f"Unsupported Modbus tag format: '{source_tag}'")

    area = match.group(1).upper()
    raw_addr = int(match.group(2))
    dtype = (match.group(3) or ("bool" if area in ("COIL", "DI") else "uint16")).lower()

    # Normalize Modicon 1-based register conventions to 0-based PDU offsets
    if area == "HR" and 40001 <= raw_addr <= 49999:
        pdu_addr = raw_addr - 40001
    elif area == "IR" and 30001 <= raw_addr <= 39999:
        pdu_addr = raw_addr - 30001
    elif area == "DI" and 10001 <= raw_addr <= 19999:
        pdu_addr = raw_addr - 10001
    elif area == "COIL" and 1 <= raw_addr <= 9999:
        pdu_addr = raw_addr - 1
    else:
        pdu_addr = raw_addr

    reg_count = 2 if dtype in ("uint32", "int32", "float32", "float32_le") else 1
    return ParsedModbusTag(
        area=area,
        address=pdu_addr,
        data_type=dtype,
        register_count=reg_count,
    )


def decode_modbus_registers(registers: list[int], data_type: str) -> float | int:
    """Decode raw 16-bit Modbus register words into numeric telemetry values."""
    if not registers:
        raise ValueError("Empty Modbus register list")
    r0 = registers[0] & 0xFFFF
    if data_type == "uint16":
        return r0
    if data_type == "int16":
        return struct.unpack(">h", struct.pack(">H", r0))[0]
    if data_type == "bool":
        return 1 if r0 else 0
    if len(registers) < 2:
        raise ValueError(
            f"Data type '{data_type}' requires 2 Modbus registers, got {len(registers)}"
        )
    r1 = registers[1] & 0xFFFF
    if data_type == "uint32":
        return struct.unpack(">I", struct.pack(">HH", r0, r1))[0]
    if data_type == "int32":
        return struct.unpack(">i", struct.pack(">HH", r0, r1))[0]
    if data_type == "float32":
        return round(struct.unpack(">f", struct.pack(">HH", r0, r1))[0], 6)
    if data_type == "float32_le":
        # Word-swapped CDAB float32 common on Siemens / Schneider / Endress+Hauser meters
        return round(struct.unpack(">f", struct.pack(">HH", r1, r0))[0], 6)
    raise ValueError(f"Unsupported Modbus data type: '{data_type}'")


def extract_unit_id(endpoint_or_topic: str) -> int:
    """Extract Modbus unit/slave ID from endpoint string (e.g. 'unit=3', 'slave=2', 'unit/1')."""
    m = re.search(r"(?:unit|slave)[=:/](\d+)", endpoint_or_topic or "", re.IGNORECASE)
    if m:
        uid = int(m.group(1))
        if 0 <= uid <= 247:
            return uid
    return 1


def extract_nested_value(payload: Any, path_expr: str) -> Any:
    """
    Extract a metric from nested JSON dicts or Sparkplug B metric lists.

    Supports:
      - Direct key: 'temp_c'
      - Dot path: 'metrics.pressure_bar' or 'device.sensors.temp_c'
      - Sparkplug B metric list: {'metrics': [{'name': 'flow_nm3_h', 'value': 420.5}]}
    """
    if not isinstance(payload, dict):
        return None
    if path_expr in payload:
        return payload[path_expr]

    # Check Sparkplug B array format: {"metrics": [{"name": "...", "value": ...}]}
    metrics_field = payload.get("metrics")
    if isinstance(metrics_field, list):
        target_name = path_expr.split(".")[-1]
        for item in metrics_field:
            if isinstance(item, dict) and item.get("name") in (path_expr, target_name):
                return item.get("value")

    # Dot-path traversal
    current: Any = payload
    for segment in path_expr.split("."):
        if isinstance(current, dict) and segment in current:
            current = current[segment]
        else:
            current = None
            break
    if current is not None:
        return current

    # Fallback: check inside payload['metrics'] dict with stripped prefix
    if isinstance(metrics_field, dict):
        leaf = path_expr.split(".")[-1]
        if leaf in metrics_field:
            return metrics_field[leaf]
    return None


class NativeModbusTcpClient:
    """
    Zero-dependency RFC-compliant Modbus TCP (MBAP) client over raw TCP sockets.
    Acts as a rock-solid fallback when pymodbus is not installed and allows
    deterministic wire-level testing in CI without binary wheels.
    """

    def __init__(
        self, host: str, port: int = 502, timeout_sec: float = 2.5, unit_id: int = 1
    ) -> None:
        self.host = host
        self.port = port
        self.timeout_sec = timeout_sec
        self.unit_id = unit_id
        self._sock: socket.socket | None = None
        self._tx_id = 0

    def __enter__(self) -> NativeModbusTcpClient:
        self._sock = socket.create_connection((self.host, self.port), timeout=self.timeout_sec)
        self._sock.settimeout(self.timeout_sec)
        return self

    def __exit__(self, _exc_type: Any, _exc: Any, _tb: Any) -> None:
        if self._sock is not None:
            try:
                self._sock.close()
            finally:
                self._sock = None

    def _recv_exact(self, n: int) -> bytes:
        if self._sock is None:
            raise ConnectionError("Modbus TCP socket is not connected")
        chunks: list[bytes] = []
        remaining = n
        while remaining > 0:
            chunk = self._sock.recv(remaining)
            if not chunk:
                raise ConnectionError("Modbus TCP peer closed connection unexpectedly")
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def _transact(self, function_code: int, address: int, count: int) -> bytes:
        if self._sock is None:
            raise ConnectionError("Modbus TCP socket is not connected")
        self._tx_id = (self._tx_id + 1) & 0xFFFF
        pdu = struct.pack(">BHH", function_code, address, count)
        mbap = struct.pack(">HHHB", self._tx_id, 0, len(pdu) + 1, self.unit_id)
        self._sock.sendall(mbap + pdu)

        resp_header = self._recv_exact(7)
        rx_tx_id, proto_id, length, _rx_unit = struct.unpack(">HHHB", resp_header)
        if proto_id != 0 or rx_tx_id != self._tx_id:
            raise RuntimeError(f"Modbus MBAP mismatch (tx={rx_tx_id}, expected={self._tx_id})")
        body = self._recv_exact(max(0, length - 1))
        if not body:
            raise RuntimeError("Empty Modbus PDU response")
        rx_fc = body[0]
        if rx_fc & 0x80:
            exc_code = body[1] if len(body) > 1 else 0
            raise RuntimeError(f"Modbus exception FC={rx_fc & 0x7F} code={exc_code}")
        return body

    def read_tag(self, parsed: ParsedModbusTag) -> float | int:
        if parsed.area in ("HR", "IR"):
            fc = 3 if parsed.area == "HR" else 4
            body = self._transact(fc, parsed.address, parsed.register_count)
            byte_count = body[1]
            data = body[2 : 2 + byte_count]
            regs = list(struct.unpack(f">{len(data) // 2}H", data))
            return decode_modbus_registers(regs, parsed.data_type)

        fc = 1 if parsed.area == "COIL" else 2
        body = self._transact(fc, parsed.address, 1)
        bit_val = body[2] & 0x01 if len(body) >= 3 else 0
        return bit_val


def poll_modbus_tcp(
    host: str,
    port: int,
    endpoint_or_topic: str,
    tag_bindings: list[Any],
    timeout_sec: float = 2.5,
) -> dict[str, Any]:
    """Poll Modbus TCP registers using pymodbus if available, otherwise NativeModbusTcpClient."""
    unit_id = extract_unit_id(endpoint_or_topic)
    parsed_tags = [(b.source_tag, parse_modbus_tag(b.source_tag)) for b in tag_bindings]

    try:
        from pymodbus.client import ModbusTcpClient  # type: ignore[import-not-found]

        client = ModbusTcpClient(host=host, port=port, timeout=timeout_sec)
        if not client.connect():
            raise ConnectionError(f"Modbus TCP connect failed: {host}:{port}")
        try:
            readings: dict[str, Any] = {}
            for raw_tag, parsed in parsed_tags:
                kwargs: dict[str, Any] = {"address": parsed.address, "count": parsed.register_count}
                # pymodbus 3.7+ uses device_id, 3.0-3.6 uses slave
                if parsed.area == "HR":
                    try:
                        res = client.read_holding_registers(**kwargs, device_id=unit_id)
                    except TypeError:
                        res = client.read_holding_registers(**kwargs, slave=unit_id)
                elif parsed.area == "IR":
                    try:
                        res = client.read_input_registers(**kwargs, device_id=unit_id)
                    except TypeError:
                        res = client.read_input_registers(**kwargs, slave=unit_id)
                elif parsed.area == "COIL":
                    try:
                        res = client.read_coils(address=parsed.address, count=1, device_id=unit_id)
                    except TypeError:
                        res = client.read_coils(address=parsed.address, count=1, slave=unit_id)
                else:
                    try:
                        res = client.read_discrete_inputs(
                            address=parsed.address, count=1, device_id=unit_id
                        )
                    except TypeError:
                        res = client.read_discrete_inputs(
                            address=parsed.address, count=1, slave=unit_id
                        )

                if res.isError():
                    raise RuntimeError(f"Modbus read error at {raw_tag}: {res}")
                if parsed.area in ("COIL", "DI"):
                    readings[raw_tag] = 1 if res.bits[0] else 0
                else:
                    readings[raw_tag] = decode_modbus_registers(
                        list(res.registers), parsed.data_type
                    )
            return readings
        finally:
            client.close()
    except ImportError:
        with NativeModbusTcpClient(
            host=host, port=port, timeout_sec=timeout_sec, unit_id=unit_id
        ) as native:
            return {raw_tag: native.read_tag(parsed) for raw_tag, parsed in parsed_tags}


def poll_opcua(
    host: str,
    port: int,
    endpoint_or_topic: str,
    auth_mode: str,
    tag_bindings: list[Any],
    timeout_sec: float = 2.5,
) -> dict[str, Any]:
    """Poll OPC-UA server nodes with anonymous, username-password, or X.509 certificate auth."""
    ClientCls: Any = None
    try:
        from asyncua.sync import Client as AsyncUaSyncClient  # type: ignore[import-not-found]

        ClientCls = AsyncUaSyncClient
    except ImportError:
        try:
            from opcua import Client as LegacyOpcUaClient  # type: ignore[import-not-found]

            ClientCls = LegacyOpcUaClient
        except ImportError as exc:
            raise RuntimeError(
                "Install optional [edge] extra ('asyncua') to poll live OPC-UA nodes."
            ) from exc

    url = (
        endpoint_or_topic
        if endpoint_or_topic.startswith("opc.tcp://")
        else f"opc.tcp://{host}:{port}{endpoint_or_topic if endpoint_or_topic.startswith('/') else ''}"
    )
    client = ClientCls(url, timeout=timeout_sec)

    if auth_mode == "username-password":
        user = os.getenv("EDGE_OPCUA_USERNAME", "").strip()
        password = os.getenv("EDGE_OPCUA_PASSWORD", "").strip()
        if user:
            client.set_user(user)
            client.set_password(password)
    elif auth_mode == "x509-cert":
        cert_path = os.getenv("EDGE_OPCUA_CERT_PATH", "").strip()
        key_path = os.getenv("EDGE_OPCUA_KEY_PATH", "").strip()
        if cert_path and key_path:
            client.set_security_string(f"Basic256Sha256,SignAndEncrypt,{cert_path},{key_path}")

    client.connect()
    try:
        return {b.source_tag: client.get_node(b.source_tag).get_value() for b in tag_bindings}
    finally:
        client.disconnect()


def poll_http_rest_meter(
    host: str,
    port: int,
    endpoint_or_topic: str,
    auth_mode: str,
    tag_bindings: list[Any],
    timeout_sec: float = 2.5,
    use_tls: bool | None = None,
) -> dict[str, Any]:
    """Poll HTTP/HTTPS smart meters with optional Bearer token auth & dot-path extraction.

    ``use_tls`` comes from the console connection; ``None`` (legacy configuration without the
    field) keeps the previous rule: HTTPS only on port 443.
    """
    scheme = "https" if (use_tls if use_tls is not None else port == 443) else "http"
    suffix = endpoint_or_topic if endpoint_or_topic.startswith("/") else f"/{endpoint_or_topic}"
    url = f"{scheme}://{host}:{port}{suffix}"
    headers = {"Accept": "application/json"}
    if auth_mode == "bearer-token":
        meter_token = os.getenv("EDGE_HTTP_METER_TOKEN", "").strip()
        if meter_token:
            # Never leak the meter credential over clear-text HTTP unless explicitly accepted
            # (e.g. an isolated OT segment where the meter has no TLS).
            allow_plaintext = (
                os.getenv("EDGE_HTTP_METER_ALLOW_PLAINTEXT_TOKEN", "").strip().lower() == "true"
            )
            if scheme != "https" and not allow_plaintext:
                raise ValueError(
                    f"Refusing to send bearer token over plain HTTP to {host}:{port}; "
                    "enable TLS on the connection (useTls) or set EDGE_HTTP_METER_ALLOW_PLAINTEXT_TOKEN=true"
                )
            headers["Authorization"] = f"Bearer {meter_token}"

    req = urllib.request.Request(url, headers=headers, method="GET")  # noqa: S310
    with urllib.request.urlopen(req, timeout=timeout_sec) as resp:  # noqa: S310
        payload = json.loads(resp.read().decode("utf-8"))

    if not isinstance(payload, dict):
        return {}

    readings: dict[str, Any] = {}
    for binding in tag_bindings:
        val = extract_nested_value(payload, binding.source_tag)
        if val is not None:
            readings[binding.source_tag] = val

    # Preserve direct temp_c if present and not bound explicitly
    if "temp_c" not in readings:
        temp_val = extract_nested_value(payload, "temp_c")
        if temp_val is not None:
            readings["temp_c"] = temp_val

    return readings


class MqttSubscriptionBuffer:
    """Background paho-mqtt topic cache supporting TLS, auth, nested JSON, and Sparkplug B payloads."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._latest_by_conn: dict[str, dict[str, Any]] = {}
        self._started_ids: set[str] = set()

    def ingest_payload(
        self, conn_id: str, payload: dict[str, Any], tag_bindings: list[Any]
    ) -> dict[str, Any]:
        """Normalize an incoming MQTT JSON or Sparkplug B payload into tag-keyed readings."""
        readings: dict[str, Any] = {}
        for binding in tag_bindings:
            val = extract_nested_value(payload, binding.source_tag)
            if val is not None:
                readings[binding.source_tag] = val
        if not readings and isinstance(payload.get("metrics"), dict):
            readings = dict(payload["metrics"])
        with self._lock:
            self._latest_by_conn[conn_id] = readings
        return readings

    def ensure_started(self, conn: Any) -> None:
        if conn.id in self._started_ids:
            return
        try:
            import paho.mqtt.client as mqtt  # type: ignore[import-not-found]
        except ImportError:
            return

        self._started_ids.add(conn.id)
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)

        if conn.auth_mode == "username-password":
            user = os.getenv("EDGE_MQTT_USERNAME", "").strip()
            pwd = os.getenv("EDGE_MQTT_PASSWORD", "").strip()
            if user:
                client.username_pw_set(user, pwd)

        if conn.port == 8883 or os.getenv("EDGE_MQTT_TLS", "").lower() == "true":
            ca_certs = os.getenv("EDGE_MQTT_CA_CERT", "").strip() or None
            client.tls_set(ca_certs=ca_certs, tls_version=ssl.PROTOCOL_TLS_CLIENT)

        def on_connect(
            cli: Any, _userdata: Any, _flags: Any, reason_code: Any, _props: Any
        ) -> None:
            if reason_code == 0:
                cli.subscribe(conn.endpoint_or_topic)

        def on_message(_cli: Any, _userdata: Any, msg: Any) -> None:
            try:
                payload = json.loads(msg.payload.decode("utf-8"))
                if isinstance(payload, dict):
                    self.ingest_payload(conn.id, payload, conn.tag_bindings)
            except (UnicodeDecodeError, json.JSONDecodeError):
                return

        client.on_connect = on_connect
        client.on_message = on_message
        try:
            client.connect_async(conn.host, conn.port, keepalive=30)
            client.loop_start()
        except OSError:
            return

    def pop_latest(self, conn_id: str) -> dict[str, Any]:
        with self._lock:
            return dict(self._latest_by_conn.pop(conn_id, {}))
