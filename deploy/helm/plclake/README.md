# PLCLake Helm Chart (k3s / Kubernetes)

Production-grade Helm chart for deploying **PLCLake** into isolated **Staging** and **Production** namespaces on k3s (on-premise) or managed Kubernetes (GKE, EKS, AKS, Hetzner).

## 1. Create Environment Secrets (Never Commit to Git)

```bash
kubectl create namespace plclake-staging
kubectl -n plclake-staging create secret generic plclake-staging-secrets \
  --from-literal=DATABASE_URL="postgres://plclake:<PASSWORD>@<PG_HOST>:5432/plclake_staging?sslmode=require" \
  --from-literal=SECRETS_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  --from-literal=AUTH_ADMIN_EMAIL="admin@company.com" \
  --from-literal=AUTH_ADMIN_PASSWORD="<STRONG_PASSWORD>"
```

Repeat in `plclake-prod` with `plclake-prod-secrets` pointing to your dedicated production PostgreSQL (Managed PostgreSQL or CloudNativePG + PgBouncer).

## 2. Deploy Staging & Production

```bash
# Staging
helm upgrade --install plclake ./deploy/helm/plclake \
  -n plclake-staging --create-namespace \
  -f ./deploy/helm/plclake/values-staging.yaml \
  --set image.repository="ghcr.io/salvo8519/plclake" \
  --set image.tag="1.0.0-<short-sha>" \
  --wait --timeout 3m

# Production (promote the exact same tested image tag)
helm upgrade --install plclake ./deploy/helm/plclake \
  -n plclake-prod --create-namespace \
  -f ./deploy/helm/plclake/values-prod.yaml \
  --set image.repository="ghcr.io/salvo8519/plclake" \
  --set image.tag="1.0.0" \
  --wait --timeout 3m
```

## 3. Instant Rollback & Verification

```bash
curl -fsS https://plclake.example.com/readyz
curl -fsS https://plclake.example.com/api/v1/version
helm rollback plclake -n plclake-prod
```
