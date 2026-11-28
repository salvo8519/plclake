# syntax=docker/dockerfile:1.7
# Industrial Telemetry & Edge Gateway Platform — Hardened Multi-Stage Production Dockerfile
# Produces a minimal, non-root Node.js 22 Alpine image with pre-compiled frontend (dist/)
# and pre-bundled ESM backend (dist-server/server.mjs) for <2s container cold start.

# ── Stage 1: Full dependencies (for Vite + esbuild compilation) ────────────────
FROM node:22-alpine AS deps
WORKDIR /app

# The committed lockfile is mandatory: npm ci fails if it is missing or out of sync.
COPY package.json package-lock.json .npmrc* ./
RUN npm ci --no-audit --no-fund --ignore-scripts

# ── Stage 2: Build static SPA bundle + compiled Express ESM server ─────────────
FROM deps AS builder
WORKDIR /app

COPY index.html tsconfig.json vite.config.ts server.ts ./
COPY config ./config
COPY src ./src

RUN npm run build && npm run build:server

# ── Stage 3: Production-only node_modules ──────────────────────────────────────
FROM node:22-alpine AS prod-deps
WORKDIR /app

COPY package.json package-lock.json .npmrc* ./
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts

# ── Stage 4: Hardened non-root production runtime ──────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

ARG APP_BUILD_SHA=""
ARG APP_BUILD_TIME=""

ENV NODE_ENV=production \
    PORT=3000 \
    APP_BUILD_SHA=${APP_BUILD_SHA} \
    APP_BUILD_TIME=${APP_BUILD_TIME}

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/dist-server ./dist-server
COPY --from=builder --chown=node:node /app/src/i18n/locales ./src/i18n/locales

# Writable persistent state directory for atomic .state/*.json fallback & master key
RUN mkdir -p /app/.state && chown -R node:node /app/.state

USER node

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/readyz >/dev/null 2>&1 || exit 1

CMD ["node", "dist-server/server.mjs"]
