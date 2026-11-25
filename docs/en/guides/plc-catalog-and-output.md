<div class="erp-docs-lang-bar">
  <span>Language:</span>
  <strong>EN</strong>
  <span>·</span>
  <a href="../../it/guides/plc-catalog-and-output.md">IT (Italiano)</a>
</div>

# Dynamic PLC Catalog & Parameterized Output

Every PLC family or industrial meter is modeled in the **PLC Catalog** (`/api/v1/catalog/machines`), automatically driving simulation, Edge Gateway tag mapping, exported Feature Mart columns, and Business Analytics KPI formulas.

| Type ID | Model / Family | Domain | Default Protocol | Primary Channel |
| :--- | :--- | :--- | :--- | :--- |
| `siemens-s7-1500` | Siemens SIMATIC S7-1500 | `manufacturing` | `opcua:4840` | `cycle_ms` (ms) |
| `rockwell-controllogix` | Rockwell ControlLogix 5580 | `manufacturing` | `opcua:4840` | `cycle_ms` (ms) |
| `plc-controller` | IEC 61131-3 Generic PLC | `manufacturing` | `opcua:4840` | `cycle_ms` (ms) |
| `cnc-mill` | CNC Precision Mill (Fanuc/Haas) | `manufacturing` | `opcua:4840` | `vibration_mm_s` (mm/s) |
| `gas-flow-meter` | Endress+Hauser / Emerson | `gas-metering` | `modbus-tcp:502` | `flow_nm3_h` (Nm³/h) |
| `methane-compressor` | Biomethane Compressor Skid | `gas-metering` | `modbus-tcp:502` | `pressure_bar` (bar) |
| `power-meter` | Schneider PowerLogic / ABB | `power-generation` | `mqtt-sparkplug:8883` | `power_kw` (kW) |
| `turbine-generator` | GE / Siemens Cogeneration | `power-generation` | `opcua:4840` | `power_kw` (kW) |
