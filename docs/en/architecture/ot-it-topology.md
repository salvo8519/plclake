<div class="erp-docs-lang-bar">
  <span>Language:</span>
  <strong>EN</strong>
  <span>·</span>
  <a href="../../it/architecture/ot-it-topology.md">IT (Italiano)</a>
</div>

# OT/IT Topology & Plug-and-Play Edge Gateway

The platform is engineered to comply with industrial network security policies (Purdue model / IEC 62443) without requiring any inbound firewall ports to be opened toward the plant PLC VLAN from external networks.

---

## Supported Deployment Topologies

| Topology | Where the Software Runs | Required Firewall Ports | Offline Resilience |
| :--- | :--- | :--- | :--- |
| **On-Premise Direct LAN** | Entirely on a corporate server, VM, or industrial IPC on the local network | Zero ports exposed to the Internet; OT LAN → Collector only (`4840`, `502`, `8883`) | Maximum (100% local) |
| **Edge Gateway Push** | Collector on plant IPC/Raspberry/VM; DB/BI on central control plane | **Zero inbound ports** toward the plant; outbound `443/tcp` only | **SQLite WAL Spool** up to 4 GB (~28M events) |
| **Site-to-Site VPN** | Central server routed to remote PLC subnets | VPN tunnel ACLs restricted to allowed PLC IPs/ports | Local spool on collector |

---

## Industrial Protocols & Tag Mapping

The Edge Collector (`src/edge_gateway/collector.py`) normalizes four protocol families into the **Common Telemetry Envelope v2**:

- **OPC-UA (`opcua`, port `4840`)**: Siemens S7-1500, Rockwell ControlLogix, Beckhoff, B&R (`asyncua`).
- **Modbus TCP (`modbus-tcp`, port `502`)**: gas flow meters, compressors, power analyzers (`pymodbus`, `HR:40001` notation with `scale_factor`).
- **MQTT Sparkplug B (`mqtt-sparkplug`, port `8883`)**: OT brokers with asynchronous subscriptions (`paho-mqtt`).
- **HTTP/REST Smart Meter (`http-rest-meter`, port `8080/443`)**: smart metering endpoints exposing JSON payloads.
