#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "=== Installing On-Premise Industrial Telemetry Stack ==="
if [ ! -f "$ROOT_DIR/.env" ]; then
  echo "Creating .env from .env.example (update credentials before production rollout)..."
  cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
fi

docker compose -f "$SCRIPT_DIR/docker-compose.onprem.yml" up -d --build
docker compose -f "$SCRIPT_DIR/docker-compose.onprem.yml" ps

echo "On-Premise stack started:"
echo "  - Postgres BI/BA Mart: localhost:5432"
echo "  - Garage S3 Cold Lakehouse: localhost:3900"
echo "  - Grafana BA Dashboards: http://localhost:3001"
