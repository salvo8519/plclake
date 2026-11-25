<div class="erp-docs-lang-bar">
  <span>Lingua:</span>
  <strong>IT</strong>
  <span>·</span>
  <a href="../../en/guides/plc-catalog-and-output.md">EN (English)</a>
</div>

# Catalogo PLC Dinamico & Output Parametrizzabile

Ogni tipologia di PLC o misuratore industriale è definita nel **Catalogo PLC** (`/api/v1/catalog/machines`), che pilota simulazione, mapping tag su Edge Gateway, colonne esportate nel Feature Mart e formule di Business Analytics.

| Type ID | Modello / Famiglia | Dominio | Protocollo Default | Canale Primario |
| :--- | :--- | :--- | :--- | :--- |
| `siemens-s7-1500` | Siemens SIMATIC S7-1500 | `manufacturing` | `opcua:4840` | `cycle_ms` (ms) |
| `rockwell-controllogix` | Rockwell ControlLogix 5580 | `manufacturing` | `opcua:4840` | `cycle_ms` (ms) |
| `plc-controller` | IEC 61131-3 Generic PLC | `manufacturing` | `opcua:4840` | `cycle_ms` (ms) |
| `cnc-mill` | CNC Precision Mill (Fanuc/Haas) | `manufacturing` | `opcua:4840` | `vibration_mm_s` (mm/s) |
| `gas-flow-meter` | Endress+Hauser / Emerson | `gas-metering` | `modbus-tcp:502` | `flow_nm3_h` (Nm³/h) |
| `methane-compressor` | Biomethane Compressor Skid | `gas-metering` | `modbus-tcp:502` | `pressure_bar` (bar) |
| `power-meter` | Schneider PowerLogic / ABB | `power-generation` | `mqtt-sparkplug:8883` | `power_kw` (kW) |
| `turbine-generator` | GE / Siemens Cogeneration | `power-generation` | `opcua:4840` | `power_kw` (kW) |
