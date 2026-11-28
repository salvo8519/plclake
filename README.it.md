# PLCLake — Industrial Telemetry Connector

**Piattaforma di Telemetria Industriale, Edge Gateway & ML Lakehouse**

<p align="center">
  <a href="README.md">English</a> · <strong>Italiano</strong> · <a href="https://salvo8519.github.io/plclake/it/">Documentazione Live</a> · <a href="https://salvo8519.github.io/plclake/api/scalar.html?lang=it">API Interattive (Scalar)</a>
</p>

<!-- BADGES:START -->
<p align="center">
  <img src="https://img.shields.io/badge/Versione-v1.0.0-C9A45C?style=flat-square&labelColor=0B1622" alt="Release" />
  <img src="https://img.shields.io/badge/OpenAPI-3.1.0%20%C2%B7%2051%20endpoints-16324F?style=flat-square&labelColor=0B1622" alt="OpenAPI" />
  <img src="https://img.shields.io/badge/i18n-EN%20%7C%20IT%20%C2%B7%201206%20chiavi-C9A45C?style=flat-square&labelColor=0B1622" alt="i18n" />
  <img src="https://img.shields.io/badge/Docs%20Zensical-8%C3%972%20pagine%20EN%2FIT-16324F?style=flat-square&labelColor=0B1622" alt="Docs" />
  <img src="https://img.shields.io/badge/Gate%20CI-ESLint%20%C2%B7%20Biome%20%C2%B7%20Ruff%20%C2%B7%20Vitest-0F6B54?style=flat-square&labelColor=0B1622" alt="CI Gate" />
  <br />
  <img src="https://img.shields.io/badge/React-19.0.1-16324F?style=flat-square&labelColor=0B1622" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-6.0.3-16324F?style=flat-square&labelColor=0B1622" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Express-4.21.2-16324F?style=flat-square&labelColor=0B1622" alt="Express" />
  <img src="https://img.shields.io/badge/i18next-27.2.6-C9A45C?style=flat-square&labelColor=0B1622" alt="i18next" />
  <img src="https://img.shields.io/badge/Sicurezza-RBAC%20%C2%B7%20AES--256--GCM%20%C2%B7%20scrypt-0F6B54?style=flat-square&labelColor=0B1622" alt="Security" />
</p>
<!-- BADGES:END -->

---

## Cos'è PLCLake?

**PLCLake** raccoglie in tempo reale i dati delle macchine di stabilimento (PLC, centri CNC, compressori, contatori elettrici e gas) e li trasforma in **visibilità operativa immediata**, **alert preventivi sui guasti** e **dati puliti pronti per analisi** su Grafana, Power BI e modelli di Manutenzione Predittiva — senza dover gestire infrastrutture big-data complesse o costose in fabbrica.

È progettato per girare **on-premise sul server del cliente**, in **reti di stabilimento isolate (air-gapped)** oppure su **cloud / Kubernetes**.

```mermaid
flowchart LR
  A["Macchine di Impianto<br/>PLC · CNC · Contatori Energia & Gas"] --> B["Edge Gateway<br/>Buffer Locale · Auto-Sync"]
  B --> C["Piattaforma PLCLake<br/>Validazione · Alert · Governance"]
  C --> D["Storage Operativo<br/>PostgreSQL 16"]
  C --> E["Archivio Storico<br/>Parquet · S3"]
  D --> F["Grafana · Power BI · ML"]
```

---

## Valore per Ogni Ruolo

| Profilo | Cosa Ottiene da PLCLake |
| :--- | :--- |
| **Plant & Operations Manager** | Controllo in tempo reale di stato macchine, anomalie e fermi impianto, con notifiche automatiche via email e webhook prima che un'anomalia diventi un fermo critico. |
| **Business Manager & Controllo di Gestione** | Flussi giornalieri puliti e certificati su disponibilità (OEE), ore di fermo, consumi elettrici (kWh) e gas (Nm3), pronti per Power BI e Grafana. |
| **CTO, Team Lead & IT/OT** | Architettura full-stack moderna e snella (React, TypeScript, Node.js, PostgreSQL, Python Edge), API OpenAPI 3.1 tipizzate, sicurezza RBAC + Audit Log e deploy pronto per Docker e Kubernetes/Helm. |

---

## Anteprima della Piattaforma

### Streaming Telemetrico in Tempo Reale

![PLCLake Streaming Telemetrico Live](docs/assets/screenshots/00-live-stream-demo-it.gif)

### Operazioni, Connessioni Impianto & Configurazione Pipeline

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/assets/screenshots/01-live-console-it.png"><img src="docs/assets/screenshots/01-live-console-it.png" alt="PLCLake Console Operativa Live" width="100%" /></a>
      <br />
      <strong>1. Console Operativa Live</strong><br />
      Indicatori KPI in tempo reale, stato di salute della pipeline, quarantena anomalie e ispezione eventi JSON.
    </td>
    <td width="50%" valign="top">
      <a href="docs/assets/screenshots/05-plant-connections-it.png"><img src="docs/assets/screenshots/05-plant-connections-it.png" alt="PLCLake Connessioni Impianto ed Edge Gateway" width="100%" /></a>
      <br />
      <strong>2. Connessioni Impianto &amp; Edge Gateway</strong><br />
      Connetti macchine e contatori via OPC-UA, Modbus TCP, MQTT Sparkplug o VPN/LAN con buffer offline SQLite e kit di installazione on-premise generato in un clic.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/assets/screenshots/02-plc-catalog-it.png"><img src="docs/assets/screenshots/02-plc-catalog-it.png" alt="PLCLake Catalogo Dinamico PLC" width="100%" /></a>
      <br />
      <strong>3. Catalogo Dinamico PLC</strong><br />
      Configura macchinari Siemens, Rockwell, CNC, Gas ed Energia, protocolli, soglie di guasto e formule KPI senza scrivere codice.
    </td>
    <td width="50%" valign="top">
      <a href="docs/assets/screenshots/06-job-config-it.png"><img src="docs/assets/screenshots/06-job-config-it.png" alt="PLCLake Configurazione Job e Policy Lakehouse" width="100%" /></a>
      <br />
      <strong>4. Configurazione Job &amp; Lakehouse Hot/Cold</strong><br />
      Imposta finestre di aggregazione, lookback watermark, policy di quarantena, SLA anomalie e retention tra PostgreSQL Hot e Parquet S3 Cold.
    </td>
  </tr>
</table>

### Sicurezza, Governance & Portale API

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/assets/screenshots/03-rbac-roles-it.png"><img src="docs/assets/screenshots/03-rbac-roles-it.png" alt="PLCLake Ruoli e Permessi" width="100%" /></a>
      <br />
      <strong>5. Accessi e Permessi (RBAC)</strong><br />
      Gestisci visibilità delle viste e permessi operativi per <code>Admin</code>, <code>Operatore</code> e <code>Visualizzatore</code> da un'unica matrice.
    </td>
    <td width="50%" valign="top">
      <a href="docs/assets/screenshots/07-api-tokens-it.png"><img src="docs/assets/screenshots/07-api-tokens-it.png" alt="PLCLake Gestione Token e Chiavi API" width="100%" /></a>
      <br />
      <strong>6. Token API &amp; Ciclo di Vita Chiavi</strong><br />
      Emetti, ruota e revoca credenziali <code>X-API-Key</code> con scope dedicati (<code>read</code>, <code>edge</code>, <code>admin</code>), avvisi di scadenza e cifratura AES-256-GCM.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/assets/screenshots/08-audit-log-it.png"><img src="docs/assets/screenshots/08-audit-log-it.png" alt="PLCLake Registro Audit Immutabile" width="100%" /></a>
      <br />
      <strong>7. Registro Audit Sicurezza e Operazioni</strong><br />
      Traccia ogni accesso, emissione o rotazione di chiavi, modifica RBAC e configurazione con Attore, Esito, ID Richiesta ed export CSV.
    </td>
    <td width="50%" valign="top">
      <a href="https://salvo8519.github.io/plclake/api/scalar.html?lang=it"><img src="docs/assets/screenshots/04-api-docs-it.png" alt="PLCLake Portale API OpenAPI 3.1" width="100%" /></a>
      <br />
      <strong>8. Portale API OpenAPI 3.1 (<a href="https://salvo8519.github.io/plclake/api/scalar.html?lang=it">Apri Scalar Live</a>)</strong><br />
      Esplora e testa tutti i 51 endpoint tipizzati direttamente dal browser con autenticazione integrata e documentazione <code>IT | EN</code>.
    </td>
  </tr>
</table>

---

## Funzionalità Principali

- **Console Operativa & Simulazione Live**: monitora i flussi telemetrici in tempo reale, lo stato di salute della pipeline (`Stabile`, `Degradata`, `Critica`), i payload JSON completi, i dati in quarantena e lo stato della flotta.
- **Connessioni Impianto & Edge Gateway**: integra PLC e contatori industriali via **OPC-UA**, **Modbus TCP**, **MQTT Sparkplug** o **HTTP/REST** in LAN diretta, VPN Site-to-Site o tramite Edge Gateway con buffer offline SQLite e generazione automatica del kit di installazione on-premise.
- **Catalogo PLC Dinamico & Configurazione Job**: definisci nuove famiglie di macchine (Siemens, Rockwell, CNC, Gas, Energia) e regola da interfaccia finestre di aggregazione, watermark, policy di quarantena e retention Hot/Cold.
- **Sicurezza, Token API & Registro Audit Immutabile**: gestione separata di Utenti e Ruoli (`Admin`, `Operatore`, `Visualizzatore`), chiavi `X-API-Key` con scope dedicati (`read`, `edge`, `admin`), scadenza e rotazione automatica, segreti cifrati a riposo e registro Audit esportabile in CSV.
- **Nativamente Bilingue (`IT | EN`) & Pronto per la Produzione**: console web, portale API Scalar live, sito documentazione Zensical, immagine Docker non-root, pacchetto on-premise chiavi in mano e Helm Chart per k3s/Kubernetes.

---

## Punti Chiave Architetturali (Per Team Tecnici)

- **Zero Over-Engineering**: PostgreSQL 16 + PgBouncer per query operative istantanee ("Hot") abbinato ad archivio compresso Parquet su S3 ("Cold") — nessun cluster Kafka o Spark da mantenere in stabilimento.
- **API Contract-First**: 51 endpoint OpenAPI 3.1 generati direttamente da schemi Zod, con validazione a due livelli (`permissive` per resilienza in fabbrica, `strict` per integrazioni enterprise) e [Portale Interattivo Scalar OpenAPI 3.1](https://salvo8519.github.io/plclake/api/scalar.html?lang=it).
- **Osservabilità Nativa**: endpoint `/healthz`, `/readyz`, `/api/v1/version`, metriche Prometheus `/metrics`, log JSON strutturati con redaction dei segreti e dashboard Grafana preconfigurate.

Tutti gli approfondimenti tecnici sono pubblicati sul **[Sito Documentazione Live](https://salvo8519.github.io/plclake/it/)** e raccolti nell'[Hub Documentazione](docs/index.md).

---

## Avvio Rapido

### Sviluppo Locale

```bash
cp .env.example .env
npm ci
npm run hooks:install
npm run dev
```

### Stack Completo con Docker

Avvia **PLCLake + PostgreSQL 16 + Mailpit + Prometheus + Grafana** con un solo comando:

```bash
docker compose up -d --build
```

| Servizio | URL |
| :--- | :--- |
| **Console Web (IT / EN)** | `http://localhost:3000` |
| **API Versione Release** | `http://localhost:3000/api/v1/version` |
| **Documentazione API Interattiva (IT)** | `http://localhost:3000/api/v1/docs?lang=it` |
| **Documentazione API Interattiva (EN)** | `http://localhost:3000/api/v1/docs?lang=en` |
| **Metriche Prometheus** | `http://localhost:3000/api/v1/metrics` |

Per il rilascio su server cliente o ambienti Staging/Produzione:
- **[Guida Deploy On-Premise & Air-Gapped (Docker)](deploy/onprem/README.md)**
- **[Guida Deploy Kubernetes / k3s con Helm (Staging & Prod)](deploy/helm/plclake/README.md)**

---

## Documentazione & Portale API Live

Esplora subito online senza installare nulla:
- **[Portale Documentazione Live (IT)](https://salvo8519.github.io/plclake/it/)** · **[Live Documentation Portal (EN)](https://salvo8519.github.io/plclake/en/)**
- **[Portale API Interattivo Live — Scalar OpenAPI 3.1 (IT)](https://salvo8519.github.io/plclake/api/scalar.html?lang=it)** · **[Scalar OpenAPI 3.1 (EN)](https://salvo8519.github.io/plclake/api/scalar.html?lang=en)**

Documentazione nel repository (rispecchiata 1:1 in Italiano e Inglese):

- **[Hub Documentazione (IT / EN)](docs/index.md)**
- **[Topologia OT/IT & Edge Gateway](docs/it/architecture/ot-it-topology.md)**
- **[Hot/Cold Lakehouse & Big Data](docs/it/architecture/hot-cold-lakehouse.md)**
- **[Catalogo PLC Dinamico & Contratto Output](docs/it/guides/plc-catalog-and-output.md)**
- **[Guida Giorno 1: PLC verso Grafana & Power BI](docs/it/guides/grafana-powerbi.md)**
- **[Sicurezza: Auth, API Key & Hardening](docs/it/security/api-auth-and-hardening.md)**
- **[API Reference & Guida Estrazione Dati](docs/it/api/reference.md)**
- **[Governance i18n, CI & Automazione](docs/it/guides/i18n-and-docs-governance.md)**

---

## Comandi di Qualità & Manutenzione

```bash
npm run verify         # Controllo completo pre-push (TypeScript, ESLint, Biome, i18n, Vitest, Build Frontend e Server)
npm test               # Test automatici su sicurezza, RBAC, ciclo di vita token, DB e API
npm run sync:badges    # Allinea la versione di config/app.json su package.json, Helm Chart e badge README
npm run docs:openapi   # Esporta le specifiche statiche OpenAPI 3.1 EN/IT
```

---

## Licenza

Distribuito con licenza [Apache License 2.0](LICENSE).
