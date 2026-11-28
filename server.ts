import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express, { type Request, type Response } from 'express';
import { apiReference } from '@scalar/express-api-reference';
import {
  ConnectionUpsertPermissiveSchema,
  ConnectionUpsertStrictSchema,
  NetworkSettingsPermissiveSchema,
  NetworkSettingsStrictSchema,
  PipelineRunCreatePermissiveSchema,
  PipelineRunCreateStrictSchema,
  ScopedKeyRotateRequestSchema,
  formatZodIssues,
  generateOpenApiSpec,
  getOpenApiLocale,
  projectRowFields,
} from './src/apiSchemas.ts';
import {
  LANGUAGE_COOKIE_NAME,
  type SupportedLanguage,
} from './src/i18n/types.ts';
import { AlertEngine } from './src/alertEngine.ts';
import {
  AuthAuditManager,
} from './src/authAudit.ts';
import {
  API_CONTRACT,
  APP_NAME,
  APP_VERSION,
  buildRuntimeVersionInfo,
} from './src/config/appMeta.ts';
import { ConnectionManager } from './src/connectionManager.ts';
import { DatabaseStore } from './src/db.ts';
import { createHttpLoggerMiddleware, logger, resolveSiteId } from './src/logger.ts';
import {
  PlcCatalogManager,
  resolveMachineSpec,
} from './src/machineCatalog.ts';
import { metricsRegistry } from './src/observability.ts';
import {
  createRateLimiter,
  extractRequestCredential,
  securityHeadersMiddleware,
} from './src/security.ts';
import {
  WHITE_LABEL_EDITORIAL_CSS,
  buildScalarTopBarHtml,
} from './src/serverConfig.ts';
import { SimulationRunManager } from './src/simulationRunner.ts';
import { flushPendingWrites, sanitizeCsvCell } from './src/utils/persistence.ts';
import { createJsonErrorHandler, forwardAsyncErrors } from './src/utils/asyncRouter.ts';
import {
  getRequestContext,
  normalizePermissiveConnectionInput,
  logInternalError,
  resolveRequestLanguage,
} from './src/http/requestInput.ts';
import { JobConfigStore } from './src/http/jobConfigStore.ts';
import { createAuthGuards } from './src/http/authGuards.ts';
import type { HttpContext } from './src/http/context.ts';
import { registerAuthRoutes } from './src/http/routes/auth.ts';
import { registerAlertRoutes } from './src/http/routes/alerts.ts';
import { registerCatalogRoutes } from './src/http/routes/catalog.ts';
import { registerIngestionRoutes } from './src/http/routes/ingestion.ts';
// ROUTER_IMPORTS
import {
  collectProductionConfigErrors,
  isProductionRuntime,
  resolveTrustProxySetting,
} from './src/config/runtimeEnv.ts';
import type {
  JobConfig,
  LiveRunSnapshot,
  MachineProfileMode,
  NetworkDeploymentSettings,
  PlcConnection,
} from './src/types/pipeline.ts';

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

  // Kubernetes / Docker liveness probe (always 200 while event loop is alive)
  app.get('/healthz', (_req, res) => {
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
  app.get('/readyz', async (_req, res) => {
    if (isShuttingDown) {
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
  app.get('/version', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(
      buildRuntimeVersionInfo({
        environment: jobConfig.current.environment,
        plantSiteId: resolveSiteId(),
      })
    );
  });

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

  app.get('/metrics', (req, res) => {
    void servePrometheusMetrics(req, res);
  });

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

  const apiRouter = forwardAsyncErrors(express.Router());

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

  registerAuthRoutes(apiRouter, ctx);

  registerAlertRoutes(apiRouter, ctx);

  registerCatalogRoutes(apiRouter, ctx);

  registerIngestionRoutes(apiRouter, ctx);

  apiRouter.get('/connections', requireScope('read'), (_req, res) => {
    res.json(connectionManager.getPublicState());
  });

  apiRouter.put('/connections/settings', requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    try {
      const schema = tier === 'strict' ? NetworkSettingsStrictSchema : NetworkSettingsPermissiveSchema;
      const parsed = schema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({
          error: `Validation failed (${tier})`,
          tier,
          requestId,
          issues: formatZodIssues(parsed.error),
        });
        return;
      }
      const updated = await connectionManager.updateSettings(
        parsed.data as Partial<NetworkDeploymentSettings>
      );
      res.json(updated);
    } catch (err) {
      logInternalError(err, 'Failed to update network deployment settings', requestId);
      res.status(500).json({
        error: 'Failed to update network deployment settings',
        tier,
        requestId,
      });
    }
  });

  apiRouter.post('/connections/gateway-token/rotate', keyRotateRateLimit, requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    try {
      const rotated = await connectionManager.rotateGatewayToken();
      res.json(rotated);
    } catch (err) {
      logInternalError(err, 'Failed to rotate gateway token', requestId);
      res.status(500).json({
        error: 'Failed to rotate gateway token',
        tier,
        requestId,
      });
    }
  });

  apiRouter.post('/connections/api-keys/rotate', keyRotateRateLimit, requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    try {
      const parsed = ScopedKeyRotateRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({
          error: 'Specify scope as one of: edge, read, admin.',
          tier,
          requestId,
          issues: formatZodIssues(parsed.error),
        });
        return;
      }
      const rotated = await connectionManager.rotateScopedKey(parsed.data.scope);
      res.json(rotated);
    } catch (err) {
      logInternalError(err, 'Failed to rotate scoped API key', requestId);
      res.status(500).json({
        error: 'Failed to rotate scoped API key',
        tier,
        requestId,
      });
    }
  });

  apiRouter.post('/connections', requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    try {
      const schema = tier === 'strict' ? ConnectionUpsertStrictSchema : ConnectionUpsertPermissiveSchema;
      const parsed = schema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({
          error: `Validation failed (${tier})`,
          tier,
          requestId,
          issues: formatZodIssues(parsed.error),
        });
        return;
      }
      const payload =
        tier === 'strict'
          ? (parsed.data as Partial<PlcConnection>)
          : normalizePermissiveConnectionInput(parsed.data as Record<string, unknown>);
      const saved = await connectionManager.upsertConnection(payload);
      res.status(payload.id ? 200 : 201).json(saved);
    } catch (err) {
      logInternalError(err, 'Failed to save connection', requestId);
      res.status(500).json({
        error: 'Failed to save connection',
        tier,
        requestId,
      });
    }
  });

  apiRouter.delete('/connections/:id', requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    try {
      const removed = await connectionManager.deleteConnection(req.params.id);
      if (!removed.deleted) {
        res.status(404).json({ error: 'Connection not found', tier, requestId });
        return;
      }
      res.json(removed);
    } catch (err) {
      logInternalError(err, 'Failed to delete connection', requestId);
      res.status(500).json({
        error: 'Failed to delete connection',
        tier,
        requestId,
      });
    }
  });

  apiRouter.post('/connections/:id/probe', probeRateLimit, requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    try {
      const probe = await connectionManager.probeConnection(req.params.id);
      if (!probe) {
        res.status(404).json({ error: 'Connection not found', tier, requestId });
        return;
      }
      res.json({ probe, state: connectionManager.getPublicState() });
    } catch (err) {
      logInternalError(err, 'Connection probe failed', requestId);
      res.status(500).json({
        error: 'Connection probe failed',
        tier,
        requestId,
      });
    }
  });

  apiRouter.post('/connections/:id/send-test-batch', requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    try {
      const conn = connectionManager.getConnection(req.params.id);
      if (!conn) {
        res.status(404).json({ error: 'Connection not found', tier, requestId });
        return;
      }
      const spec = resolveMachineSpec(conn.machineType);
      const envelope = {
        event_id: `gw-test-${conn.machineId}-${Date.now()}`,
        timestamp: new Date().toISOString(),
        machine_id: conn.machineId,
        line_id: conn.lineId,
        machine_type: conn.machineType,
        domain: spec.domain,
        state: 'RUNNING',
        level: 'INFO',
        error_code: null,
        metrics: {
          temp_c: Number((spec.tempNominalC + 0.8).toFixed(2)),
          [spec.primaryKey]: Number(spec.primaryNominal.toFixed(2)),
          [spec.secondaryKey]: Number(spec.secondaryNominal.toFixed(3)),
        },
        source_protocol: conn.protocol,
        source_host: `${conn.host}:${conn.port}`,
      };

      const result = runManager.ingestExternalBatch([envelope], {
        windowMinutes: jobConfig.current.windowMinutes,
        machinesPerLine: jobConfig.current.machinesPerLine,
        machineProfileMode: jobConfig.current.machineProfileMode,
        rotateMaxLines: jobConfig.current.rotateMaxLines,
        dedupStrategy: jobConfig.current.dedupStrategy,
        malformedPolicy: jobConfig.current.malformedPolicy,
        parquetCompression: jobConfig.current.parquetCompression,
        datasetVersion: jobConfig.current.datasetVersion,
        partitionLayout: jobConfig.current.partitionLayout,
        lakehouseFormat: jobConfig.current.lakehouseFormat,
        ingestTransport: 'http-batch-ingest',
      });

      if (result.accepted > 0) {
        await connectionManager.recordIngestedMachineCounts(new Map([[conn.machineId, result.accepted]]));
      }

      res.status(202).json({
        result,
        envelope,
        state: connectionManager.getPublicState(),
      });
    } catch (err) {
      logInternalError(err, 'Test batch dispatch failed', requestId);
      res.status(500).json({
        error: 'Test batch dispatch failed',
        tier,
        requestId,
      });
    }
  });

  apiRouter.get('/connections/deploy-bundle', requireScope('admin'), (_req, res) => {
    res.json(connectionManager.buildDeployBundle());
  });

  apiRouter.get('/ba/kpi', requireScope('read'), async (req, res) => {
    const machineType =
      typeof req.query.machineType === 'string' && req.query.machineType.trim()
        ? req.query.machineType.trim()
        : undefined;
    const domain =
      typeof req.query.domain === 'string' && req.query.domain.trim()
        ? req.query.domain.trim()
        : undefined;
    const fromDate =
      typeof req.query.fromDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.fromDate.trim())
        ? req.query.fromDate.trim()
        : undefined;
    const toDate =
      typeof req.query.toDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.toDate.trim())
        ? req.query.toDate.trim()
        : undefined;
    const sourcePref =
      typeof req.query.source === 'string' ? req.query.source.trim().toLowerCase() : 'auto';
    const fieldsRaw = typeof req.query.fields === 'string' ? req.query.fields : '';
    const requestedFields = fieldsRaw
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean);
    const format = typeof req.query.format === 'string' ? req.query.format.trim().toLowerCase() : 'json';

    let dataSource: 'postgres' | 'live-snapshot' = 'live-snapshot';
    let rawRows: Array<Record<string, unknown>> = [];

    if (sourcePref !== 'live' && dbStore.isPostgresActive()) {
      try {
        const pgRows = await dbStore.queryBaKpiDaily({
          domain,
          machineType,
          fromDate,
          toDate,
        });
        if (pgRows.length > 0 || sourcePref === 'postgres') {
          rawRows = pgRows as unknown as Array<Record<string, unknown>>;
          dataSource = 'postgres';
        }
      } catch {
        // Fallback to live snapshot if Postgres view query fails
      }
    }

    if (dataSource === 'live-snapshot') {
      rawRows = runManager.getBusinessAnalyticsKpis({ machineType, domain }) as unknown as Array<
        Record<string, unknown>
      >;
    }

    const projectedRows =
      requestedFields.length > 0
        ? rawRows.map((r) => projectRowFields(r, requestedFields))
        : rawRows;

    if (format === 'csv') {
      const cols =
        projectedRows.length > 0
          ? Object.keys(projectedRows[0])
          : requestedFields.length > 0
          ? requestedFields
          : [
              'dt',
              'domain',
              'line_id',
              'machine_id',
              'machine_type',
              'availability_oee_pct',
              'primary_metric_name',
              'primary_metric_avg',
              'estimated_energy_kwh',
              'estimated_gas_volume_nm3',
            ];
      const lines = [
        cols.map((c) => sanitizeCsvCell(c)).join(','),
        ...projectedRows.map((row) =>
          cols
            .map((c) => sanitizeCsvCell((row as Record<string, unknown>)[c] ?? ''))
            .join(',')
        ),
      ];
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="ba_kpi_export.csv"');
      res.send(lines.join('\n'));
      return;
    }

    res.json({
      generatedAt: new Date().toISOString(),
      dataSource,
      datasetVersion: jobConfig.current.datasetVersion,
      filters: {
        machineType: machineType ?? null,
        domain: domain ?? null,
        fromDate: fromDate ?? null,
        toDate: toDate ?? null,
        fields: requestedFields.length > 0 ? requestedFields : null,
      },
      rowCount: projectedRows.length,
      rows: projectedRows,
    });
  });

  apiRouter.get('/pipeline/runs/latest', requireScope('read'), (_req, res) => {
    const snap = runManager.getLatestSnapshot();
    res.json({ run: snap });
  });

  apiRouter.post('/pipeline/runs', runCreateRateLimit, requireScope('admin'), (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    try {
      const schema = tier === 'strict' ? PipelineRunCreateStrictSchema : PipelineRunCreatePermissiveSchema;
      const parsed = schema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({
          error: `Validation failed (${tier})`,
          tier,
          requestId,
          issues: formatZodIssues(parsed.error),
        });
        return;
      }

      const body = parsed.data as Record<string, unknown>;
      const snapshot = runManager.startRun({
        durationMinutes: Number(body.durationMinutes ?? 15),
        eventsPerSec: Number(body.eventsPerSec ?? 10),
        speedMultiplier: Number(body.speedMultiplier ?? 10) as 1 | 10 | 60 | 300,
        windowMinutes: Number(body.windowMinutes ?? jobConfig.current.windowMinutes),
        machineCount: Number(body.machineCount ?? 4),
        machinesPerLine: Number(body.machinesPerLine ?? jobConfig.current.machinesPerLine),
        machineProfileMode:
          (body.machineProfileMode as MachineProfileMode | undefined) ??
          jobConfig.current.machineProfileMode,
        selectedPlcTypes: Array.isArray(body.selectedPlcTypes)
          ? (body.selectedPlcTypes as string[])
          : undefined,
        outputFields: Array.isArray(body.outputFields)
          ? (body.outputFields as string[])
          : undefined,
        faultProbabilityPct: Number(body.faultProbabilityPct ?? 5),
        malformedRatePct: Number(body.malformedRatePct ?? 7),
        outOfOrderRatePct: Number(body.outOfOrderRatePct ?? 8),
        rotateMaxLines: Number(body.rotateMaxLines ?? jobConfig.current.rotateMaxLines),
        seed: Number(body.seed ?? 42),
        customMachineTopology:
          typeof body.customMachineTopology === 'string'
            ? body.customMachineTopology
            : jobConfig.current.customMachineTopology,
        ignoredErrorCodes:
          typeof body.ignoredErrorCodes === 'string'
            ? body.ignoredErrorCodes
            : jobConfig.current.ignoredErrorCodes,
        horizonWindows: Number(body.horizonWindows ?? jobConfig.current.horizonWindows),
        tempAnomalyThresholdC: Number(
          body.tempAnomalyThresholdC ?? jobConfig.current.tempAnomalyThresholdC
        ),
        vibrationP95Threshold: Number(
          body.vibrationP95Threshold ?? jobConfig.current.vibrationP95Threshold
        ),
        minValidSampleRatio: Number(
          body.minValidSampleRatio ?? jobConfig.current.minValidSampleRatio
        ),
        dedupStrategy:
          (body.dedupStrategy as JobConfig['dedupStrategy'] | undefined) ??
          jobConfig.current.dedupStrategy,
        malformedPolicy:
          (body.malformedPolicy as JobConfig['malformedPolicy'] | undefined) ??
          jobConfig.current.malformedPolicy,
        parquetCompression:
          (body.parquetCompression as JobConfig['parquetCompression'] | undefined) ??
          jobConfig.current.parquetCompression,
        datasetVersion:
          typeof body.datasetVersion === 'string'
            ? body.datasetVersion
            : jobConfig.current.datasetVersion,
        partitionLayout:
          (body.partitionLayout as JobConfig['partitionLayout'] | undefined) ??
          jobConfig.current.partitionLayout,
        lakehouseFormat:
          (body.lakehouseFormat as JobConfig['lakehouseFormat'] | undefined) ??
          jobConfig.current.lakehouseFormat,
        hotRetentionDays: Number(body.hotRetentionDays ?? jobConfig.current.hotRetentionDays),
        coldRetentionDays: Number(body.coldRetentionDays ?? jobConfig.current.coldRetentionDays),
        coldStorageEndpoint:
          (body.coldStorageEndpoint as JobConfig['coldStorageEndpoint'] | undefined) ??
          jobConfig.current.coldStorageEndpoint,
        compactionSchedule:
          (body.compactionSchedule as JobConfig['compactionSchedule'] | undefined) ??
          jobConfig.current.compactionSchedule,
        ingestTransport:
          (body.ingestTransport as JobConfig['ingestTransport'] | undefined) ??
          jobConfig.current.ingestTransport,
      });
      res.status(201).json(snapshot);
    } catch (err) {
      logInternalError(err, 'Unable to start streaming simulation', requestId);
      res.status(500).json({
        error: 'Unable to start streaming simulation',
        tier,
        requestId,
      });
    }
  });

  apiRouter.get('/pipeline/runs/:id', requireScope('read'), (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    const run = runManager.getRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: 'Simulation run not found', tier, requestId });
      return;
    }
    res.json(runManager.buildSnapshot(run));
  });

  apiRouter.get('/pipeline/runs/:id/stream', requireScope('read'), (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    const runId = req.params.id;
    const run = runManager.getRun(runId);
    if (!run) {
      res.status(404).json({ error: 'Simulation run not found', tier, requestId });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sendEvent = (snapshot: LiveRunSnapshot) => {
      res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      if (snapshot.status === 'completed' || snapshot.status === 'stopped') {
        cleanup();
        res.end();
      }
    };

    const unsubscribe = runManager.subscribe(runId, sendEvent);
    const keepAlive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 15000);

    const cleanup = () => {
      clearInterval(keepAlive);
      unsubscribe();
    };

    req.on('close', cleanup);
    sendEvent(runManager.buildSnapshot(run));
  });

  apiRouter.post('/pipeline/runs/:id/pause', requireScope('admin'), (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    const snap = runManager.pauseRun(req.params.id);
    if (!snap) {
      res.status(404).json({ error: 'Simulation run not found', tier, requestId });
      return;
    }
    res.json(snap);
  });

  apiRouter.post('/pipeline/runs/:id/resume', requireScope('admin'), (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    const snap = runManager.resumeRun(req.params.id);
    if (!snap) {
      res.status(404).json({ error: 'Simulation run not found', tier, requestId });
      return;
    }
    res.json(snap);
  });

  apiRouter.post('/pipeline/runs/:id/stop', requireScope('admin'), (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    const snap = runManager.stopRun(req.params.id);
    if (!snap) {
      res.status(404).json({ error: 'Simulation run not found', tier, requestId });
      return;
    }
    res.json(snap);
  });

  apiRouter.get('/metrics', (req, res) => {
    void servePrometheusMetrics(req, res);
  });

  // Strict JSON 404 fallback for unmatched API routes (never fall through to SPA HTML)
  apiRouter.use((req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    res.status(404).json({
      error: `API route not found: ${req.method} ${req.originalUrl}`,
      tier,
      requestId,
    });
  });

  // Bilingual White-label Editorial Finance Scalar OpenAPI 3.1 Reference UI
  const scalarCdnOverride = process.env.SCALAR_CDN_URL?.trim() || undefined;
  const buildScalarMiddleware = (lang: SupportedLanguage) => {
    const locale = getOpenApiLocale(lang);
    return apiReference({
      url: `/api/v1/openapi.json?lang=${lang}`,
      ...(scalarCdnOverride ? { cdn: scalarCdnOverride } : {}),
      pageTitle: locale.pageTitle,
      theme: 'default',
      darkMode: false,
      hideDarkModeToggle: true,
      hideClientButton: true,
      showDeveloperTools: 'never',
      telemetry: false,
      authentication: {
        preferredSecurityScheme: 'ApiKeyHeaderAuth',
      },
      customCss: WHITE_LABEL_EDITORIAL_CSS,
    });
  };

  const scalarHandlers: Record<SupportedLanguage, express.RequestHandler> = {
    en: buildScalarMiddleware('en') as unknown as express.RequestHandler,
    it: buildScalarMiddleware('it') as unknown as express.RequestHandler,
  };

  const serveBilingualScalar = (docsBasePath: string) => (req: Request, res: Response, next: express.NextFunction) => {
    const lang = resolveRequestLanguage(req);
    const locale = getOpenApiLocale(lang);
    res.setHeader('Content-Language', lang);
    res.setHeader('Vary', 'Accept-Language, Cookie');
    res.setHeader(
      'Set-Cookie',
      `${LANGUAGE_COOKIE_NAME}=${lang}; Path=/; Max-Age=31536000; SameSite=Lax`
    );

    const topBar = buildScalarTopBarHtml({
      lang,
      brand: locale.header.brand,
      subtitle: locale.header.subtitle,
      backToConsole: locale.header.backToConsole,
      docsBasePath,
      authEnforced: connectionManager.isAuthEnforced(),
    });

    const originalSend = res.send.bind(res);
    res.send = ((body?: unknown) => {
      if (typeof body === 'string' && body.includes('<html')) {
        let html = body.replace(/<html(?:\s+lang="[^"]*")?/, `<html lang="${lang}"`);
        if (html.includes('<body')) {
          html = html.replace(/<body([^>]*)>/, `<body$1>${topBar}`);
        } else {
          html = `${topBar}${html}`;
        }
        return originalSend(html);
      }
      return originalSend(body);
    }) as Response['send'];

    scalarHandlers[lang](req, res, next);
  };

  app.use('/api/v1/docs', serveBilingualScalar('/api/v1/docs'));
  app.use('/api/docs', serveBilingualScalar('/api/v1/docs'));
  app.get('/docs', (req, res) => {
    const lang = resolveRequestLanguage(req);
    res.redirect(`/api/v1/docs?lang=${lang}`);
  });

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
