<div class="erp-docs-lang-bar">
  <span>Lingua:</span>
  <strong>IT</strong>
  <span>·</span>
  <a href="../../en/security/api-auth-and-hardening.md">EN (English)</a>
</div>

# Sicurezza API, Auth Multi-Scope, Chiavi API Gestite & Hardening

Tutte le API del Control Plane (`/api/v1/*`) applicano autenticazione **Multi-Scope** a privilegi minimi (`admin`, `read`, `edge`) tramite **Chiavi API Gestite (`X-API-Key`)**, sessioni operatore revocabili e chiavi di servizio legacy.

---

## 1. Chiavi API Gestite (`pat_live_...`) — Standard Consigliato per Integrazioni

Amministratori e system integrator emettono, ruotano e revocano chiavi API dedicate direttamente da **Amministrazione → Token API** (`POST /api/v1/tokens`, `POST /api/v1/tokens/:tokenId/rotate`, `DELETE /api/v1/tokens/:tokenId`).

- **Header**: `X-API-Key: pat_live_<random>` (accettata anche tramite `Authorization: Bearer pat_live_...` per client standardizzati su Bearer).
- **Visualizzazione Singola in Chiaro**: Il segreto grezzo viene mostrato **una sola volta** in fase di creazione o rotazione e non viene mai salvato in chiaro.
- **Archiviazione Crittografica a Riposo**: Le chiavi sono sottoposte a hash **SHA-256** e cifrate con **AES-256-GCM** (`enc:v1:<iv>:<tag>:<ciphertext>`) tramite `SECRETS_ENCRYPTION_KEY` (oppure chiave master `0600` in `.state/.master.key`). La verifica avviene a tempo costante con `crypto.timingSafeEqual`.
- **Tracciamento Audit Automatico (`SecretManagement` → `AuditLogSystem`)**: Ogni evento del ciclo di vita del token (`token.created`, `token.rotated`, `token.revoked`, inclusa la revoca a cascata alla disabilitazione dell'utente proprietario) viene propagato sul bus eventi interno verso l'Audit Log Immutabile e i log strutturati JSON senza mai registrare segreti in chiaro.
- **Test Interattivo in Scalar**: Apri `/api/v1/docs?lang=it` e premi **Chiave API / Test** per staccare una chiave temporanea `pat_live_...` valida 1 ora (oppure autenticarti con account impianto in modalità strict) e incollarla in `ApiKeyHeaderAuth`.

---

## 2. Tipologie di Credenziali e Matrice Scope

| Prefisso Credenziale | Header / Origine | Scope | Endpoint Autorizzati |
| :--- | :--- | :--- | :--- |
| `pat_live_...` | `X-API-Key` (Gestite in **Token API**) | Configurabili (`read`, `edge`, `admin`) | Endpoint a privilegi minimi coerenti con gli scope assegnati, incluso `/metrics` (`read`/`admin`) |
| `sess_...` | `Authorization: Bearer` / `X-API-Key` (Login) | Derivato dal ruolo RBAC (`admin`, `operator`, `viewer`) | Sessione Console mantenuta esclusivamente in memoria JS (mai in `localStorage` / `sessionStorage`) |
| `adm_live_...` | `API_ADMIN_TOKEN` (Chiave servizio) | **`admin`** | Accesso completo (scrittura, rotazione chiavi, probe, RBAC, governance token) |
| `bi_live_...` | `API_READ_TOKEN` (Chiave servizio) | **`read`** | Sola lettura analytics, catalogo, run, `/metrics` e ispezione audit |
| `gw_live_...` | `EDGE_GATEWAY_TOKEN` (Chiave servizio) | **`edge`** | `POST /ingest/batch`, `GET /edge/config` |

---

## 3. Controlli di Hardening Defense-in-Depth

- **RBAC & Ciclo di Vita Account**: Password sottoposte ad hash `scrypt` con salt per utente. Le sezioni **Utenti** e **Ruoli e Permessi** separate governano 10 viste di menu e 4 capacità operative. Disabilitare un utente revoca istantaneamente sia le sessioni browser attive sia tutti i token `pat_live_...` associati.
- **Protezione Rete in Uscita & Redirect**: Tutti i probe verso endpoint PLC, relay SMTP, diagnostica Mailpit e webhook validano l'host di destinazione bloccando metadata cloud (`169.254.0.0/16`, `metadata.google.internal`, `fd00:ec2::/32`), intervalli link-local/non specificati, indirizzi IPv6 mappati IPv4 (`::ffff:...`), loopback IPv6 espansi/tra parentesi quadre e codifiche numeriche/ottali/esadecimali IPv4. I nomi host vengono **risolti e ogni indirizzo restituito viene verificato**; la connessione viene poi **vincolata all'indirizzo validato** (nessuna seconda risoluzione DNS, chiudendo il DNS rebinding), mentre TLS verifica comunque il certificato sul nome host configurato. Tutte le chiamate HTTP in uscita impongono `redirect: 'error'`.
- **Hardening Trasporto & CORS**: I relay SMTP TLS impliciti (`secure: true`) verificano i certificati TLS per impostazione predefinita (`SMTP_TLS_REJECT_UNAUTHORIZED !== 'false'`). Le rotte autenticate `/api/*` non emettono mai wildcard `Access-Control-Allow-Origin: *` e richiedono origini esplicite in `CORS_ORIGIN`.
- **Rate Limiting & Sanitizzazione CSV**: Rate limiter sliding-window proteggono login, rotazione chiavi/token, probe, avvio run e ingest batch. Tutti gli export CSV neutralizzano i prefissi formula (`=`, `+`, `-`, `@`).
- **Header di Sicurezza**: In produzione ogni risposta API include `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`; la console usa una policy basata su `'self'` (Google Fonts consentito, frame consentiti per la casella Mailpit configurata). `Strict-Transport-Security` viene inviato solo su TLS (`TRUST_PROXY` rispetta `X-Forwarded-Proto` dietro un ingress). Il riferimento API Scalar è escluso perché carica le risorse da una CDN.
- **Gestione degli Errori**: Gli errori imprevisti non arrivano mai al client con dettagli interni: gli handler rispondono con un messaggio generico e un `requestId`, l'errore completo viene registrato lato server, e gli handler asincroni che falliscono vengono inoltrati a un gestore centrale JSON invece di terminare il processo.
- **Credenziali del Gateway Edge**: I contatori HTTP REST dichiarano TLS in modo esplicito (`useTls`, su qualsiasi porta). Il gateway non invia mai il token bearer del contatore su HTTP in chiaro, salvo `EDGE_HTTP_METER_ALLOW_PLAINTEXT_TOKEN=true`, e il suo file di ambiente non contiene credenziali del database. I batch rifiutati in modo definitivo dall'API (HTTP 400/422) finiscono in una tabella dead-letter invece di bloccare lo spool.
- **Mappa delle Autorizzazioni in CI**: `tests/route_table.test.ts` registra in uno snapshot ogni rotta con la sua catena di middleware (`requireScope(admin)`, `rateLimit(login)`, ...). Una rotta che perde o cambia la propria protezione fa fallire la CI finché la modifica non viene revisionata.

---

## 4. Baseline Fail-Closed in Produzione

Con `NODE_ENV=production` il server rifiuta le configurazioni insicure invece di ripiegare su valori di comodo:

| Regola | Comportamento |
| :--- | :--- |
| Autenticazione API | Sempre attiva. `API_ENFORCE_AUTH=false` e l'opzione "LAN Interna Fiducia" della console non hanno effetto (l'opzione viene mostrata bloccata). |
| `AUTH_ADMIN_PASSWORD` | Obbligatoria, almeno 12 caratteri; senza di essa il server non si avvia. |
| `SECRETS_ENCRYPTION_KEY` | Obbligatoria (64 caratteri esadecimali, `openssl rand -hex 32`). Una chiave per container renderebbe illeggibili i token cifrati dopo un riavvio o tra repliche diverse. |
| Account demo | Mai creati. Fuori dalla produzione sono facoltativi (`AUTH_SEED_DEMO_USERS=true`). |
| PostgreSQL | Se `DATABASE_URL` è impostato ma il database non è raggiungibile, il server riprova con backoff e poi si arresta, invece di lavorare in silenzio su file locali. `/readyz` restituisce `503` finché il database non è disponibile. |
| Stack Compose | `POSTGRES_PASSWORD` (e `GRAFANA_ADMIN_PASSWORD` dove gira Grafana) sono obbligatorie. I servizi interni sono pubblicati su `127.0.0.1`, salvo che `PLCLAKE_BIND_ADDR` li apra in modo esplicito. |

Fuori dalla produzione nessuna password è scritta nel codice: le password mancanti degli account predefiniti vengono generate al primo avvio e scritte una sola volta in `.state/initial-credentials.txt` (permessi `0600`).

Dietro un reverse proxy o un ingress, impostare `TRUST_PROXY` (numero di hop o subnet fidate) perché rate limit e voci di audit vedano i veri IP dei client; è disattivato per impostazione predefinita, così i client diretti non possono falsificare `X-Forwarded-For`.

> **Nota sulla scalabilità**: sessioni e contatori dei rate limit sono mantenuti nella memoria del processo, quindi il chart Helm esegue una sola replica. Uno store condiviso per i deployment multi-replica è tracciato nella [issue #4](https://github.com/salvo8519/plclake/issues/4).
