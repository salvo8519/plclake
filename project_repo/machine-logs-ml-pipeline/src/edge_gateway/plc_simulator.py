"""
Virtual Industrial PLC & Smart Meter Test Bench (Modbus TCP + HTTP REST).

Allows field engineers and CI pipelines to test the real Edge Collector against
live wire-level Modbus TCP (binary MBAP FC01/02/03/04 with uint16/int16/float32)
and authenticated HTTP REST endpoints before factory cutover.

Usage:
    python -m edge_gateway.plc_simulator --modbus-port 1502 --http-port 18080
"""
from __future__ import annotations

import argparse
import json
import math
import socketserver
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


class VirtualModbusMemory:
    """Thread-safe simulated Modbus register bank supporting dynamic drift and float32 packing."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.holding: dict[int, int] = {}
        self.input_regs: dict[int, int] = {}
        self.coils: dict[int, int] = {0: 1, 1: 0}
        self.discrete_inputs: dict[int, int] = {0: 1}
        self._seed_defaults()

    def _seed_defaults(self) -> None:
        # HR:40001 (addr 0) -> uint16 flow_nm3_h * 10 = 4250 -> 425.0 Nm3/h
        self.set_uint16("HR", 0, 4250)
        # HR:40003 (addr 2..3) -> IEEE-754 float32 pressure_bar = 14.85 bar
        self.set_float32("HR", 2, 14.85)
        # HR:40005 (addr 4) -> uint16 temp_c * 10 = 236 -> 23.6 C
        self.set_uint16("HR", 4, 236)
        # IR:30001 (addr 0) -> int16 ambient delta = -12 -> -1.2 C (scale 0.1)
        self.set_int16("IR", 0, -12)

    def set_uint16(self, area: str, addr: int, value: int) -> None:
        bank = self.holding if area == "HR" else self.input_regs
        with self._lock:
            bank[addr] = value & 0xFFFF

    def set_int16(self, area: str, addr: int, value: int) -> None:
        packed = struct.unpack(">H", struct.pack(">h", value))[0]
        self.set_uint16(area, addr, packed)

    def set_float32(self, area: str, addr: int, value: float, word_swap: bool = False) -> None:
        w0, w1 = struct.unpack(">HH", struct.pack(">f", float(value)))
        bank = self.holding if area == "HR" else self.input_regs
        with self._lock:
            bank[addr] = w1 if word_swap else w0
            bank[addr + 1] = w0 if word_swap else w1

    def read_registers(self, area: str, addr: int, count: int) -> list[int]:
        bank = self.holding if area == "HR" else self.input_regs
        with self._lock:
            return [bank.get(addr + i, 0) & 0xFFFF for i in range(count)]

    def read_bits(self, area: str, addr: int, count: int) -> list[int]:
        bank = self.coils if area == "COIL" else self.discrete_inputs
        with self._lock:
            return [1 if bank.get(addr + i, 0) else 0 for i in range(count)]

    def step_waveform(self, t_sec: float) -> None:
        """Apply realistic sinusoidal plant variation for live field bench demos."""
        flow_raw = int(round((425.0 + 18.0 * math.sin(t_sec / 6.0)) * 10.0))
        pressure = 14.8 + 0.65 * math.cos(t_sec / 8.0)
        temp_raw = int(round((23.5 + 1.4 * math.sin(t_sec / 11.0)) * 10.0))
        self.set_uint16("HR", 0, flow_raw)
        self.set_float32("HR", 2, pressure)
        self.set_uint16("HR", 4, temp_raw)


class _ModbusTcpServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, server_address: tuple[str, int], memory: VirtualModbusMemory) -> None:
        self.memory = memory
        super().__init__(server_address, _ModbusTcpHandler)


class _ModbusTcpHandler(socketserver.BaseRequestHandler):
    def _recv_exact(self, n: int) -> bytes | None:
        buf = bytearray()
        while len(buf) < n:
            chunk = self.request.recv(n - len(buf))
            if not chunk:
                return None
            buf.extend(chunk)
        return bytes(buf)

    def handle(self) -> None:
        memory: VirtualModbusMemory = self.server.memory  # type: ignore[attr-defined]
        while True:
            header = self._recv_exact(7)
            if not header:
                return
            tx_id, proto_id, length, unit_id = struct.unpack(">HHHB", header)
            pdu = self._recv_exact(max(0, length - 1))
            if not pdu:
                return

            fc = pdu[0]
            if fc in (3, 4) and len(pdu) >= 5:
                addr, count = struct.unpack(">HH", pdu[1:5])
                area = "HR" if fc == 3 else "IR"
                regs = memory.read_registers(area, addr, count)
                payload = struct.pack(f">BB{len(regs)}H", fc, len(regs) * 2, *regs)
            elif fc in (1, 2) and len(pdu) >= 5:
                addr, count = struct.unpack(">HH", pdu[1:5])
                area = "COIL" if fc == 1 else "DI"
                bits = memory.read_bits(area, addr, count)
                byte_val = 0
                for idx, bit in enumerate(bits[:8]):
                    if bit:
                        byte_val |= 1 << idx
                payload = struct.pack(">BBB", fc, 1, byte_val)
            else:
                # Illegal function exception (0x01)
                payload = struct.pack(">BB", fc | 0x80, 0x01)

            resp_mbap = struct.pack(">HHHB", tx_id, proto_id, len(payload) + 1, unit_id)
            self.request.sendall(resp_mbap + payload)


class VirtualPlcBench:
    """Starts paired Modbus TCP + HTTP REST virtual PLC endpoints on chosen or ephemeral ports."""

    def __init__(
        self,
        host: str = "127.0.0.1",
        modbus_port: int = 0,
        http_port: int = 0,
        http_bearer_token: str | None = None,
    ) -> None:
        self.memory = VirtualModbusMemory()
        self.http_bearer_token = http_bearer_token
        self.http_metrics: dict[str, Any] = {
            "active_power_kw": 312.4,
            "power_factor": 0.96,
            "temp_c": 44.2,
            "grid_freq_hz": 50.01,
        }
        self._modbus_server = _ModbusTcpServer((host, modbus_port), self.memory)
        self.modbus_port: int = self._modbus_server.server_address[1]

        bench = self

        class _MeterHandler(BaseHTTPRequestHandler):
            def log_message(self, _fmt: str, *_args: Any) -> None:
                return

            def do_GET(self) -> None:  # noqa: N802
                if bench.http_bearer_token:
                    auth = self.headers.get("Authorization", "")
                    if auth != f"Bearer {bench.http_bearer_token}":
                        self.send_response(401)
                        self.send_header("Content-Type", "application/json")
                        self.end_headers()
                        self.wfile.write(b'{"error":"Unauthorized meter request"}')
                        return

                body = json.dumps({"status": "RUNNING", "metrics": bench.http_metrics}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self._http_server = ThreadingHTTPServer((host, http_port), _MeterHandler)
        self.http_port: int = self._http_server.server_address[1]
        self._threads: list[threading.Thread] = []

    def start(self) -> None:
        t_modbus = threading.Thread(target=self._modbus_server.serve_forever, daemon=True)
        t_http = threading.Thread(target=self._http_server.serve_forever, daemon=True)
        t_modbus.start()
        t_http.start()
        self._threads = [t_modbus, t_http]

    def stop(self) -> None:
        self._modbus_server.shutdown()
        self._modbus_server.server_close()
        self._http_server.shutdown()
        self._http_server.server_close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Virtual Industrial PLC Bench (Modbus TCP + HTTP REST)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--modbus-port", type=int, default=1502)
    parser.add_argument("--http-port", type=int, default=18080)
    parser.add_argument("--http-token", type=str, default=None)
    args = parser.parse_args()

    bench = VirtualPlcBench(
        host=args.host,
        modbus_port=args.modbus_port,
        http_port=args.http_port,
        http_bearer_token=args.http_token,
    )
    bench.start()
    print(
        json.dumps(
            {
                "status": "listening",
                "modbus_tcp": f"{args.host}:{bench.modbus_port}",
                "http_rest_meter": f"http://{args.host}:{bench.http_port}/api/v1/telemetry",
            }
        ),
        flush=True,
    )
    t0 = time.monotonic()
    try:
        while True:
            bench.memory.step_waveform(time.monotonic() - t0)
            time.sleep(1.0)
    except KeyboardInterrupt:
        bench.stop()


if __name__ == "__main__":
    main()
