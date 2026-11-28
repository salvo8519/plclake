import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { AlertEngine } from './src/alertEngine.ts';
import {
  AuthAuditManager,
} from './src/authAudit.ts';
import { ConnectionManager } from './src/connectionManager.ts';
import { DatabaseStore } from './src/db.ts';
import { createHttpLoggerMiddleware, logger, resolveSiteId } from './src/logger.ts';
import {
  PlcCatalogManager,
} from './src/machineCatalog.ts';
import { metricsRegistry } from './src/observability.ts';
import {
  createRateLimiter,
  securityHeadersMiddleware,
} from './src/security.ts';
import { SimulationRunManager } from './src/simulationRunner.ts';
import { flushPendingWrites } from './src/utils/persistence.ts';
import { createJsonErrorHandler, forwardAsyncErrors } from './src/utils/asyncRouter.ts';
import { JobConfigStore } from './src/http/jobConfigStore.ts';
import { createAuthGuards } from './src/http/authGuards.ts';
import type { HttpContext } from './src/http/context.ts';
import { registerAuthRoutes } from './src/http/routes/auth.ts';
import { registerAlertRoutes } from './src/http/routes/alerts.ts';
import { registerCatalogRoutes } from './src/http/routes/catalog.ts';
import { registerIngestionRoutes } from './src/http/routes/ingestion.ts';
import { registerConnectionRoutes } from './src/http/routes/connections.ts';
import { registerAnalyticsRoutes } from './src/http/routes/analytics.ts';
import { registerPipelineRoutes } from './src/http/routes/pipeline.ts';
import {
  createPrometheusMetricsHandler,
  registerApiBaseRoutes,
  registerApiTailRoutes,
  registerProbeRoutes,
} from './src/http/routes/system.ts';
import { registerDocsRoutes } from './src/http/routes/docs.ts';
// ROUTER_IMPORTS
import {
  collectProductionConfigErrors,
  isProductionRuntime,
  resolveTrustProxySetting,
} from './src/config/runtimeEnv.ts';

const PORT = Number(process.env.PORT) || 3000;
const DEFAULT_ROOT_DIR = process.cwd();

// Job config & editorial CSS extracted to src/serverConfig.ts for modularity.

export interface CreateAppOptions {
  rootDir?: string;
  dbStore?: DatabaseStore;
  mountFrontend?: boolean;
}

export async function createApp(options: CreateAppOptions = {}) {
  const productionConfigErrors = collectProductionConfigErrors();
  if (productionConfigErrors.length > 0) {
    throw new Error(`Refusing to start with insecure production configuration:\n- ${productionConfigErrors.join('\n- ')}`);
  }
  if (isProductionRuntime() && process.env.API_ENFORCE_AUTH === 'false') {
    logger.warn('security', 'API_ENFORCE_AUTH=false is ignored in production: authentication stays enforced', {
      event: 'auth.enforcement_override_ignored',
    });
  }
  const rootDir = options.rootDir ?? DEFAULT_ROOT_DIR;
  const dbStore = options.dbStore ?? new DatabaseStore();
  await dbStore.init();

  const authAuditManager = new AuthAuditManager(rootDir, dbStore);
  const alertEngine = new AlertEngine(rootDir, dbStore);
  const runManager = new SimulationRunManager(rootDir, dbStore, alertEngine);
  const connectionManager = new ConnectionManager(rootDir, dbStore);
  const plcCatalogManager = new PlcCatalogManager(rootDir, dbStore);
  const jobConfig = new JobConfigStore(rootDir, dbStore);

  await authAuditManager.init();
  await alertEngine.init();
  await plcCatalogManager.init();
  await jobConfig.load();
  await connectionManager.init();
  await runManager.init();

  let isShuttingDown = false;
  const markShuttingDown = () => {
    isShuttingDown = true;
  };

  const app = express();
  app.disable('x-powered-by');
  // Real client IPs for rate limiting and audit behind an ingress (off by default: anti-spoofing).
  app.set('trust proxy', resolveTrustProxySetting());
  app.use(securityHeadersMiddleware);
  app.use(express.json({ limit: '4mb' }));
  app.use(
    createHttpLoggerMiddleware(logger, ({ method, route, statusCode, durationMs }) => {
      metricsRegistry.recordHttpRequest(method, route, statusCode, durationMs);
    })
  );

  const probeRateLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: 'probe' });
  const keyRotateRateLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 10, keyPrefix: 'key-rotate' });
  const ingestRateLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 300, keyPrefix: 'ingest' });
  const runCreateRateLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: 'run-create' });
  const loginRateLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 20, keyPrefix: 'login' });

  const { resolveActor, requireScope } = createAuthGuards({ authAuditManager, connectionManager });

  const ctx: HttpContext = {
    dbStore,
    authAuditManager,
    alertEngine,
    runManager,
    connectionManager,
    plcCatalogManager,
    jobConfig,
    resolveActor,
    requireScope,
    probeRateLimit,
    keyRotateRateLimit,
    ingestRateLimit,
    runCreateRateLimit,
    loginRateLimit,
  };

  const servePrometheusMetrics = createPrometheusMetricsHandler(ctx);
  registerProbeRoutes(app, ctx, { isShuttingDown: () => isShuttingDown, servePrometheusMetrics });

  const apiRouter = forwardAsyncErrors(express.Router());

  registerApiBaseRoutes(apiRouter, ctx);

  registerAuthRoutes(apiRouter, ctx);

  registerAlertRoutes(apiRouter, ctx);

  registerCatalogRoutes(apiRouter, ctx);

  registerIngestionRoutes(apiRouter, ctx);

  registerConnectionRoutes(apiRouter, ctx);

  registerAnalyticsRoutes(apiRouter, ctx);

  registerPipelineRoutes(apiRouter, ctx);

  registerApiTailRoutes(apiRouter, servePrometheusMetrics);

  registerDocsRoutes(app, ctx);

  // Primary versioned endpoint namespace (/api/v1/*)
  app.use('/api/v1', apiRouter);

  // Legacy unversioned compatibility alias (/api/*) with RFC 9745 / 8594 Deprecation & Sunset headers
  app.use('/api', (req, res, next) => {
    res.setHeader('Deprecation', 'true');
    res.setHeader('Sunset', 'Wed, 31 Dec 2026 23:59:59 GMT');
    res.setHeader('Link', '</api/v1/docs>; rel="deprecation"; type="text/html"');
    res.setHeader(
      'X-API-Deprecated',
      'Unversioned /api/* endpoint is deprecated; migrate to /api/v1/*'
    );
    apiRouter(req, res, next);
  });

  if (options.mountFrontend !== false) {
    const isProd = process.env.NODE_ENV === 'production';
    if (!isProd) {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true, allowedHosts: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    } else {
      const distDir = path.resolve(rootDir, 'dist');
      app.use(express.static(distDir));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  app.use(createJsonErrorHandler(logger));

  /**
   * Drains background persistence (audit log, token usage, atomic `.state/` writes).
   * Must run after the HTTP server stops accepting requests and before the DB pool
   * closes or the state directory is removed.
   */
  const drainPendingWrites = async (): Promise<void> => {
    // Let pending response `finish` hooks enqueue their audit writes first.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await authAuditManager.flush();
    await flushPendingWrites();
  };

  return {
    app,
    dbStore,
    authAuditManager,
    alertEngine,
    runManager,
    connectionManager,
    plcCatalogManager,
    markShuttingDown,
    drainPendingWrites,
  };
}

const isMainEntry =
  process.env.VITEST !== 'true' &&
  typeof process.argv[1] === 'string' &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMainEntry) {
  createApp().then(({ app, dbStore, runManager, markShuttingDown, drainPendingWrites }) => {
    const httpServer = app.listen(PORT, '0.0.0.0', () => {
      const storageMode = dbStore.isPostgresActive() ? 'postgres' : 'file-fallback';
      logger.info('system', 'Industrial Telemetry server listening', {
        port: PORT,
        storageMode,
        siteId: resolveSiteId(),
        nodeEnv: process.env.NODE_ENV || 'development',
      });
    });

    let shuttingDown = false;
    const gracefulShutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      markShuttingDown();
      logger.info('system', 'Graceful shutdown initiated', { signal });

      const forceExitTimer = setTimeout(() => {
        logger.error('system', 'Forced exit after graceful shutdown timeout', { signal });
        process.exit(1);
      }, 10_000);
      forceExitTimer.unref();

      try {
        runManager.stopAllRuns();
        await new Promise<void>((resolve) => {
          httpServer.close(() => resolve());
        });
        await drainPendingWrites();
        await dbStore.close();
        logger.info('system', 'Graceful shutdown completed cleanly', { signal });
        process.exit(0);
      } catch (err) {
        logger.error('system', 'Error during graceful shutdown', {
          signal,
          error: err instanceof Error ? err.message : String(err),
        });
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => {
      void gracefulShutdown('SIGTERM');
    });
    process.on('SIGINT', () => {
      void gracefulShutdown('SIGINT');
    });
  }).catch((err: unknown) => {
    logger.error('system', 'Server failed to start', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
