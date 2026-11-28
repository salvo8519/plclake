# Contributing to Industrial Telemetry & Edge Gateway Platform

Thank you for your interest in contributing. This repository is maintained as an **Open Core single-plant industrial telemetry platform** designed for rapid on-premise deployment.

## Scope Guidance

- **In Scope (Open Source Core):**
  - OT protocol drivers (Modbus TCP, OPC-UA, MQTT Sparkplug B, HTTP REST meters)
  - PLC catalog parameterization, Common Telemetry Envelope v2, and Two-Tier Zod/OpenAPI 3.1 contracts
  - PostgreSQL feature mart, BI/Grafana connectors, SMTP/Mailpit & HMAC-signed Webhook alerting
  - Structured JSON logging, Prometheus `/metrics`, Kubernetes probes, and Grafana dashboards
- **Out of Scope for Open Source Core:**
  - Multi-tenant / multi-plant federation and cross-plant Row-Level Security (the optional `site_id` field is preserved in telemetry schemas for forward compatibility).

## Local Development Setup

```bash
# 1. Install Node.js dependencies (exact versions from package-lock.json)
npm ci

# 2. Copy environment template
cp .env.example .env

# 3. Start development server (Express API + Vite frontend on port 3000)
npm run dev
```

No password is hard-coded. Set `AUTH_ADMIN_PASSWORD` in `.env`, or read the password generated on first boot in `.state/initial-credentials.txt`. `AUTH_SEED_DEMO_USERS=true` also creates the operator and viewer demo accounts.

Optional local services (PostgreSQL, Mailpit, Prometheus, Grafana). The root Compose stack runs in production mode, so set `AUTH_ADMIN_PASSWORD`, `SECRETS_ENCRYPTION_KEY`, `POSTGRES_PASSWORD` and `GRAFANA_ADMIN_PASSWORD` in `.env` first:

```bash
docker compose up -d
```

## Code Organization

- `server.ts` is the composition root: it builds services, the `HttpContext` (`src/http/context.ts`) and registers the domain routers in order.
- Each API domain lives in `src/http/routes/<domain>.ts` and exports `register<Domain>Routes(apiRouter, ctx)`. Shared pieces: `src/http/authGuards.ts` (`requireScope`, `resolveActor`), `src/http/requestInput.ts` (request id, validation tier, error logging), `src/http/jobConfigStore.ts` (the shared job configuration).
- Protect every new route with `requireScope(...)` (and a rate limiter where relevant). `tests/route_table.test.ts` snapshots the full route table with its middleware chain: after adding or changing a route, review the diff and update it with `npx vitest run tests/route_table.test.ts -u`.
- Security-relevant runtime rules (production fail-closed, trust proxy) are centralized in `src/config/runtimeEnv.ts`.

## Dependency Management

Builds are reproducible: CI and Docker install only from committed lockfiles.

- **Node.js (npm)**: `package-lock.json` is the single source of truth. Install with `npm ci`; add or upgrade a package with `npm install <pkg>@<version>` and commit both `package.json` and `package-lock.json`. Run `npm audit` before opening the PR.
- **Python** (`project_repo/machine-logs-ml-pipeline/src`): `pyproject.toml` declares ranges, `requirements-lock.txt` pins exact versions with hashes. After editing `pyproject.toml`, regenerate the lock with the `uv pip compile` command written at the top of the lock file and commit both files. Install locally with `pip install --require-hashes -r requirements-lock.txt`.
- Renovate opens grouped update PRs every Monday and refreshes `package-lock.json` (lock file maintenance).

## Verification Checklist Before Opening a PR

Run all checks locally and ensure they pass cleanly:

```bash
npm run verify        # Full gate: TypeScript, ESLint (Airbnb), Biome (warnings fail), EN/IT + OpenAPI drift, Vitest, builds
npm run lint:fix      # Auto-fix lint issues (Biome lint + ESLint). ESLint is the style authority for TS/TSX:
                      # the Biome formatter is disabled for JavaScript/TypeScript on purpose.
npm run docs:openapi  # Regenerate docs/api/openapi.{en,it,}.json if API routes changed
```

For Python Edge Collector changes (`project_repo/machine-logs-ml-pipeline`):

```bash
pip install --require-hashes -r project_repo/machine-logs-ml-pipeline/src/requirements-lock.txt
ruff check project_repo/ && ruff format --check project_repo/
pip-audit --require-hashes --disable-pip -r project_repo/machine-logs-ml-pipeline/src/requirements-lock.txt
PYTHONPATH=project_repo/machine-logs-ml-pipeline/src pytest project_repo/machine-logs-ml-pipeline/tests
```

## Commit & Pull Request Guidelines

- Keep PRs focused and small; include tests for any new API route, driver parser, or security rule.
- Never commit `.env` files, API keys, or local `.state/*.json` runtime data.
- Update OpenAPI 3.1 schemas in `src/apiSchemas.ts` whenever adding or changing `/api/v1/*` endpoints.
