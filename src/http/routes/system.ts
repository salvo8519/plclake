import express, { type Express, type Request, type Response, type Router } from 'express';
import { generateOpenApiSpec } from '../../apiSchemas.ts';
import {
  API_CONTRACT,
  APP_NAME,
  APP_VERSION,
  buildRuntimeVersionInfo,
} from '../../config/appMeta.ts';
import { resolveSiteId } from '../../logger.ts';
import { metricsRegistry } from '../../observability.ts';
import { extractRequestCredential } from '../../security.ts';
import { forwardAsyncErrors } from '../../utils/asyncRouter.ts';
import { getRequestContext, resolveRequestLanguage } from '../requestInput.ts';
import type { HttpContext } from '../context.ts';

export type PrometheusMetricsHandler = (req: Request, res: Response) => Promise<void>;

/** Prometheus OpenMetrics payload builder and scrape handler (optionally authenticated). */
export function createPrometheusMetricsHandler(ctx: HttpContext): PrometheusMetricsHandler {
  const { dbStore, runManager, connectionManager, authAuditManager } = ctx;

  const buildPrometheusMetricsText = async (): Promise<string> => {
    const storageHealth = await dbStore.getHealthStatus();
    const latestSnap = runManager.getLatestSnapshot();
    const features = latestSnap?.features ?? [];
    const activeConns = connectionManager.getPublicState().connections.length;

    let oeePct = 100;
    let faultWindows = 0;
    if (features.length > 0) {
      let totalWindowSec = 0;
      let totalFaultSec = 0;
      for (const f of features) {
        totalWindowSec += Math.max(60, f.window_minutes * 60);
        totalFaultSec += Math.max(0, f.time_in_fault_sec);
        if (f.fault_count > 0 || f.is_anomalous_window > 0) {
          faultWindows += 1;
        }
      }
      oeePct =
        totalWindowSec > 0
          ? Number(Math.max(0, 100 * (1 - totalFaultSec / totalWindowSec)).toFixed(2))
          : 100;
    }

    return metricsRegistry.renderPrometheusText({
      dbConnected: storageHealth.connected,
      activeConnectionsCount: activeConns,
      featureRowsStored: storageHealth.featureRowsStored ?? features.length,
      plantOeeAvailabilityPct: oeePct,
      plantFaultWindows: faultWindows,
    });
  };

  // Prometheus OpenMetrics scrape endpoint
  const servePrometheusMetrics = async (req: Request, res: Response) => {
    if (process.env.METRICS_AUTH_REQUIRED === 'true') {
      const cred = extractRequestCredential(req);
      const scope = connectionManager.resolveCredentialScope(cred);
      const sessionUser = authAuditManager.resolveSessionToken(cred);
      const managedTok = cred.startsWith('pat_live_')
        ? authAuditManager.resolveApiToken(cred)
        : null;
      const managedAuthorized = Boolean(
        managedTok?.authorized &&
          managedTok.record &&
          (managedTok.record.scopes.includes('read') || managedTok.record.scopes.includes('admin'))
      );
      if (!scope && !sessionUser && !managedAuthorized) {
        res.status(401).json({ error: 'Authentication required for /metrics.' });
        return;
      }
    }
    const payload = await buildPrometheusMetricsText();
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(payload);
  };

  return servePrometheusMetrics;
}

/** Kubernetes / Docker probes, deployment version and the top-level Prometheus endpoint. */
export function registerProbeRoutes(
  app: Express,
  ctx: HttpContext,
  lifecycle: { isShuttingDown: () => boolean; servePrometheusMetrics: PrometheusMetricsHandler }
): void {
  const { dbStore, jobConfig } = ctx;
  const { isShuttingDown, servePrometheusMetrics } = lifecycle;
  // Same guarantee as the API router: a rejected async handler reaches the JSON error handler
  // instead of becoming an unhandled rejection (which terminates the process).
  const probes = forwardAsyncErrors(express.Router());

  // Kubernetes / Docker liveness probe (always 200 while event loop is alive)
  probes.get('/healthz', (_req, res) => {
    res.status(200).json({
      status: 'alive',
      name: APP_NAME,
      version: APP_VERSION,
      siteId: resolveSiteId(),
      uptimeSec: Number(process.uptime().toFixed(2)),
      timestamp: new Date().toISOString(),
    });
  });

  // Kubernetes / Docker readiness probe (returns 503 during graceful shutdown)
  probes.get('/readyz', async (_req, res) => {
    if (isShuttingDown()) {
      res.status(503).json({
        status: 'shutting_down',
        name: APP_NAME,
        version: APP_VERSION,
        siteId: resolveSiteId(),
        timestamp: new Date().toISOString(),
      });
      return;
    }
    // Readiness must stay O(1): a ping, never a table scan (probes run every few seconds).
    const dbConnected = dbStore.isConfigured() ? await dbStore.ping() : false;
    if (dbStore.isConfigured() && !dbConnected) {
      res.status(503).json({
        status: 'database_unavailable',
        name: APP_NAME,
        version: APP_VERSION,
        siteId: resolveSiteId(),
        timestamp: new Date().toISOString(),
      });
      return;
    }
    res.status(200).json({
      status: 'ready',
      name: APP_NAME,
      version: APP_VERSION,
      siteId: resolveSiteId(),
      storageMode: dbStore.isPostgresActive() ? 'postgres' : 'file-fallback',
      dbConnected,
      timestamp: new Date().toISOString(),
    });
  });

  // Top-level deployment version endpoint (mirrors GET /api/v1/version)
  probes.get('/version', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(
      buildRuntimeVersionInfo({
        environment: jobConfig.current.environment,
        plantSiteId: resolveSiteId(),
      })
    );
  });

  probes.get('/metrics', (req, res) => servePrometheusMetrics(req, res));

  app.use(probes);
}

/** API-wide middleware (version headers, audit trail of every write) and service endpoints. */
export function registerApiBaseRoutes(apiRouter: Router, ctx: HttpContext): void {
  const { authAuditManager, jobConfig, resolveActor, runManager, dbStore } = ctx;

  apiRouter.use((req, res, next) => {
    const { requestId } = getRequestContext(req, res);
    res.setHeader('API-Version', APP_VERSION);
    res.setHeader('X-API-Contract', API_CONTRACT);
    res.setHeader('Vary', 'X-Validation-Mode');

    // Automatically record immutable Audit Log entries for all state-changing API operations
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.path.startsWith('/ingest/batch') && !req.path.startsWith('/edge/ingest')) {
      res.on('finish', () => {
        const { actor, actorRole } = resolveActor(req);
        const status: 'ok' | 'denied' | 'error' =
          res.statusCode >= 200 && res.statusCode < 300
            ? 'ok'
            : res.statusCode === 401 || res.statusCode === 403
            ? 'denied'
            : 'error';
        void authAuditManager.recordAudit({
          actor,
          actorRole,
          action: `${req.method} ${req.path}`,
          resource: req.originalUrl,
          status,
          requestId,
          details: { statusCode: res.statusCode },
        });
      });
    }
    next();
  });

  apiRouter.get('/openapi.json', (req, res) => {
    const lang = resolveRequestLanguage(req);
    const host = req.get('host');
    const origin = host ? `${req.protocol}://${host}` : undefined;
    res.setHeader('Content-Language', lang);
    res.setHeader('Vary', 'Accept-Language, Cookie');
    res.json(generateOpenApiSpec(origin, lang));
  });

  apiRouter.get('/version', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(
      buildRuntimeVersionInfo({
        environment: jobConfig.current.environment,
        plantSiteId: resolveSiteId(),
      })
    );
  });

  apiRouter.get('/health', async (_req, res) => {
    const latest = runManager.getLatestSnapshot();
    const storage = await dbStore.getHealthStatus();
    res.json({
      status: 'ok',
      name: APP_NAME,
      version: APP_VERSION,
      environment: jobConfig.current.environment,
      apiVersion: APP_VERSION,
      activeRunId: latest?.runId ?? null,
      activeRunStatus: latest?.status ?? null,
      storage,
      updatedAt: new Date().toISOString(),
    });
  });
}

/** API Prometheus alias and the strict JSON 404 for unmatched API routes (registered last). */
export function registerApiTailRoutes(apiRouter: Router, servePrometheusMetrics: PrometheusMetricsHandler): void {
  apiRouter.get('/metrics', (req, res) => servePrometheusMetrics(req, res));

  // Strict JSON 404 fallback for unmatched API routes (never fall through to SPA HTML)
  apiRouter.use((req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    res.status(404).json({
      error: `API route not found: ${req.method} ${req.originalUrl}`,
      tier,
      requestId,
    });
  });
}
