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
- **Protezione Rete in Uscita & Redirect**: Tutti i probe verso endpoint PLC, relay SMTP, diagnostica Mailpit e webhook validano l'host di destinazione bloccando metadata cloud (`169.254.0.0/16`, `metadata.google.internal`, `fd00:ec2::/32`), intervalli link-local/non specificati, indirizzi IPv6 mappati IPv4 (`::ffff:...`), loopback IPv6 espansi/tra parentesi quadre e codifiche numeriche/ottali/esadecimali IPv4. Tutte le chiamate HTTP `fetch()` in uscita impongono `redirect: 'error'`.
- **Hardening Trasporto & CORS**: I relay SMTP TLS impliciti (`secure: true`) verificano i certificati TLS per impostazione predefinita (`SMTP_TLS_REJECT_UNAUTHORIZED !== 'false'`). Le rotte autenticate `/api/*` non emettono mai wildcard `Access-Control-Allow-Origin: *` e richiedono origini esplicite in `CORS_ORIGIN`.
- **Rate Limiting & Sanitizzazione CSV**: Rate limiter sliding-window proteggono login, rotazione chiavi/token, probe, avvio run e ingest batch. Tutti gli export CSV neutralizzano i prefissi formula (`=`, `+`, `-`, `@`).
