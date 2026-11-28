# PLCLake — On-Premise & Air-Gapped Deployment Runbook

Deploy the immutable **PLCLake** container stack on any Linux server (Ubuntu/RHEL/Debian) with Docker Engine + Compose v2 — with or without Internet access.

## Included Services

| Service | Role |
| :--- | :--- |
| `proxy` (Caddy 2) | TLS termination, gzip/zstd compression, unbuffered SSE streaming to PLCLake |
| `plclake` | Hardened non-root Node.js 22 app serving UI, REST API, OpenAPI 3.1, and `/metrics` |
| `pgbouncer` | Transaction-mode connection pooler for high-throughput concurrent PLC batch ingestion |
| `postgres` | PostgreSQL 16 (`scram-sha-256`, WAL compression, persistent volume) |
| `pg-backup` | Automated daily compressed `pg_dump` backups with configurable retention |
| `prometheus` + `grafana` | Optional bundled observability stack (`--profile observability`) |

---

## 1. Online Installation (Server with Registry Access)

```bash
cd deploy/onprem
cp .env.onprem.example .env
# Generate a 64-char hex encryption key:
openssl rand -hex 32
# Edit .env with your secrets, PLCLAKE_IMAGE tag, and PLCLAKE_SITE_ADDRESS
docker compose up -d
```

The stack runs in production mode and fails closed: `docker compose up` stops with an explicit message until the required values in `.env` are set.

| Variable | Requirement |
| :--- | :--- |
| `AUTH_ADMIN_PASSWORD` | Initial administrator, at least 12 characters (no default account password exists). |
| `SECRETS_ENCRYPTION_KEY` | 64 hex characters (`openssl rand -hex 32`); keep it stable, it decrypts stored API tokens and alert secrets. |
| `POSTGRES_PASSWORD` | Database password shared by PostgreSQL, PgBouncer, backups and the app. |
| `GRAFANA_ADMIN_PASSWORD` | Only with `--profile observability`. |

`TRUST_PROXY=1` is preset because Caddy is the only client of the app container: rate limits and the audit log then record real client IPs. Change it only if another proxy sits in front of Caddy.

Verify deployment version & readiness:

```bash
curl -fsS http://localhost/readyz
curl -fsS http://localhost/api/v1/version
```

---

## 2. Air-Gapped / Offline Plant Installation

On a connected workstation:

```bash
docker pull ghcr.io/salvo8519/plclake:1.0.0
docker pull postgres:16-alpine
docker pull edoburu/pgbouncer:v1.23.1-p1
docker pull caddy:2.8-alpine
docker save \
  ghcr.io/salvo8519/plclake:1.0.0 \
  postgres:16-alpine \
  edoburu/pgbouncer:v1.23.1-p1 \
  caddy:2.8-alpine \
  | gzip > plclake-1.0.0-offline-images.tar.gz
```

Transfer `plclake-1.0.0-offline-images.tar.gz` and `deploy/onprem/` to the plant server, then run:

```bash
gunzip -c plclake-1.0.0-offline-images.tar.gz | docker load
cd deploy/onprem
cp .env.onprem.example .env
# Set SCALAR_CDN_URL to an internal asset server if offline API docs are needed
docker compose up -d --no-build
```

---

## 3. Zero-Downtime Upgrade & Rollback

Update `PLCLAKE_IMAGE` in `.env` (e.g. `1.0.0` → `1.1.0`), then run:

```bash
docker compose pull plclake
docker compose up -d plclake
curl -fsS http://localhost/api/v1/version
```

To roll back immediately, revert `PLCLAKE_IMAGE` to the previous tag and run `docker compose up -d plclake`.

---

## 4. Database Backup & Restore

Backups are written daily to the `plclake_backups` volume (`plclake_YYYYMMDDTHHMMSSZ.dump`). To restore a dump:

```bash
docker compose stop plclake
docker compose exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists < backup.dump
docker compose start plclake
```
