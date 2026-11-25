<div class="erp-docs-lang-bar">
  <span>Lingua:</span>
  <strong>IT</strong>
  <span>·</span>
  <a href="../../en/architecture/ot-it-topology.md">EN (English)</a>
</div>

# Topologia OT/IT & Edge Gateway Plug & Play

La piattaforma è progettata per adattarsi alle policy di sicurezza delle reti industriali (modello Purdue / IEC 62443), senza richiedere l'apertura di porte in ingresso verso la VLAN dei PLC dall'esterno.

---

## Modalità di Installazione Supportate

| Topologia | Dove gira il software | Porte Firewall richieste | Resilienza offline |
| :--- | :--- | :--- | :--- |
| **On-Premise Direct LAN** | Interamente su server/VM o PC industriale in rete aziendale | Nessuna porta esposta su Internet; solo LAN OT → Collector (`4840`, `502`, `8883`) | Massima (tutto locale) |
| **Edge Gateway Push** | Collector su IPC/Raspberry/VM in impianto; DB/BI su server centrale | **Zero porte inbound** verso lo stabilimento; solo `443/tcp` outbound | **SQLite WAL Spool** fino a 4 GB (~28M eventi) |
| **Site-to-Site VPN** | Server centrale con instradamento verso subnet PLC | Regole ACL su tunnel VPN verso IP/porte PLC consentite | Spool locale su collector |

---

## Protocolli Industriali & Mappatura Tag

L'Edge Collector (`src/edge_gateway/collector.py`) normalizza quattro famiglie di protocolli nel **Common Telemetry Envelope v2**:

- **OPC-UA (`opcua`, porta `4840`)**: Siemens S7-1500, Rockwell ControlLogix, Beckhoff, B&R (`asyncua`).
- **Modbus TCP (`modbus-tcp`, porta `502`)**: flussimetri gas, compressori, analizzatori di rete (`pymodbus`, notazione `HR:40001` con `scale_factor`).
- **MQTT Sparkplug B (`mqtt-sparkplug`, porta `8883`)**: broker OT con sottoscrizione asincrona (`paho-mqtt`).
- **HTTP/REST Smart Meter (`http-rest-meter`, porta `8080/443`)**: contatori intelligenti con endpoint JSON.
