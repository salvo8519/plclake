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

Optional local services (PostgreSQL, Mailpit, Prometheus, Grafana):

```bash
docker compose up -d
```

## Dependency Management

Builds are reproducible: CI and Docker install only from committed lockfiles.

- **Node.js (npm)**: `package-lock.json` is the single source of truth. Install with `npm ci`; add or upgrade a package with `npm install <pkg>@<version>` and commit both `package.json` and `package-lock.json`. Run `npm audit` before opening the PR.
- **Python** (`project_repo/machine-logs-ml-pipeline/src`): `pyproject.toml` declares ranges, `requirements-lock.txt` pins exact versions with hashes. After editing `pyproject.toml`, regenerate the lock with the `uv pip compile` command written at the top of the lock file and commit both files. Install locally with `pip install --require-hashes -r requirements-lock.txt`.
- Renovate opens grouped update PRs every Monday and refreshes `package-lock.json` (lock file maintenance).

## Verification Checklist Before Opening a PR

Run all checks locally and ensure they pass cleanly:

```bash
npm run verify        # Full gate: TypeScript, ESLint (Airbnb), Biome, EN/IT + OpenAPI drift, Vitest, Vite build
npm run lint:fix      # Auto-fix formatting & lint issues (Biome + ESLint Airbnb)
npm run docs:openapi  # Regenerate docs/api/openapi.{en,it,}.json if API routes changed
```

For Python Edge Collector changes (`project_repo/machine-logs-ml-pipeline`):

```bash
ruff check project_repo/ && ruff format --check project_repo/
python3 -m unittest discover -s project_repo/machine-logs-ml-pipeline/tests
```

## Commit & Pull Request Guidelines

- Keep PRs focused and small; include tests for any new API route, driver parser, or security rule.
- Never commit `.env` files, API keys, or local `.state/*.json` runtime data.
- Update OpenAPI 3.1 schemas in `src/apiSchemas.ts` whenever adding or changing `/api/v1/*` endpoints.
