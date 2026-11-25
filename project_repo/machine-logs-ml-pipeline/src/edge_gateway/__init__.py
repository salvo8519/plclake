"""Industrial Edge Gateway Collector (OPC-UA, Modbus TCP, MQTT, HTTP -> Common Telemetry Envelope v2)."""

from .collector import (
    EdgeCollector,
    HttpBatchSink,
    LocalSegmentSink,
    SpoolStore,
    normalize_raw_sample,
)

__all__ = [
    "EdgeCollector",
    "HttpBatchSink",
    "LocalSegmentSink",
    "SpoolStore",
    "normalize_raw_sample",
]
