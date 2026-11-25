import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express, { type Request, type Response } from 'express';
import { apiReference } from '@scalar/express-api-reference';
import {
  ConnectionUpsertPermissiveSchema,
  ConnectionUpsertStrictSchema,
  IngestBatchPermissiveSchema,
  IngestBatchStrictSchema,
  JobConfigPermissiveSchema,
  JobConfigStrictSchema,
  NetworkSettingsPermissiveSchema,
  NetworkSettingsStrictSchema,
  PipelineRunCreatePermissiveSchema,
  PipelineRunCreateStrictSchema,
  PlcCatalogUpsertPermissiveSchema,
  PlcCatalogUpsertStrictSchema,
  PlcOutputPreviewRequestSchema,
  ScopedKeyRotateRequestSchema,
  formatZodIssues,
  generateOpenApiSpec,
  getOpenApiLocale,
  projectRowFields,
  resolveValidationTier,
} from './src/apiSchemas.ts';
import {
  LANGUAGE_COOKIE_NAME,
  normalizeLanguage,
  type SupportedLanguage,
} from './src/i18n/types.ts';
import { AlertEngine } from './src/alertEngine.ts';
import {
  ADMIN_FULL_POLICY,
  AuthAuditManager,
  roleToApiScope,
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
  type ApiAuthScope,
} from './src/security.ts';
import {
  DEFAULT_JOB_CONFIG,
  WHITE_LABEL_EDITORIAL_CSS,
  buildScalarTopBarHtml,
  sanitizeJobConfig,
} from './src/serverConfig.ts';
import { SimulationRunManager } from './src/simulationRunner.ts';
import { atomicWriteJson, flushPendingWrites, sanitizeCsvCell } from './src/utils/persistence.ts';
import type {
  JobConfig,
  LiveRunSnapshot,
  MachineProfileMode,
  NetworkDeploymentSettings,
  PlcCatalogProfile,
  PlcConnection,
} from './src/types/pipeline.ts';

const PORT = Number(process.env.PORT) || 3000;
const DEFAULT_ROOT_DIR = process.cwd();

// Job config & editorial CSS extracted to src/serverConfig.ts for modularity.

function getRequestContext(req: Request, res: Response) {
  const requestId = req.header('x-request-id') || crypto.randomUUID();
  const tier = resolveValidationTier(req.header('x-validation-mode'), req.query.mode);
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-API-Validation-Tier', tier);
  return { requestId, tier };
}

function normalizePermissiveEvent(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const obj = { ...(raw as Record<string, unknown>) };
  if (obj.machine_id === undefined && typeof obj.machineId === 'string') obj.machine_id = obj.machineId;
  if (obj.line_id === undefined && typeof obj.lineId === 'string') obj.line_id = obj.lineId;
  if (obj.machine_type === undefined && typeof obj.machineType === 'string') obj.machine_type = obj.machineType;
  if (obj.event_id === undefined && typeof obj.eventId === 'string') obj.event_id = obj.eventId;
  return obj;
}

function normalizePermissiveConnectionInput(raw: Record<string, unknown>): Partial<PlcConnection> {
  return {
    ...(typeof raw.id === 'string' ? { id: raw.id } : {}),
    name: typeof raw.name === 'string' ? raw.name : undefined,
    machineId:
      typeof raw.machineId === 'string'
        ? raw.machineId
        : typeof raw.machine_id === 'string'
        ? raw.machine_id
        : undefined,
    lineId:
      typeof raw.lineId === 'string'
        ? raw.lineId
        : typeof raw.line_id === 'string'
        ? raw.line_id
        : undefined,
    machineType:
      typeof raw.machineType === 'string'
        ? raw.machineType
        : typeof raw.machine_type === 'string'
        ? raw.machine_type
        : undefined,
    protocol: raw.protocol as PlcConnection['protocol'] | undefined,
    deploymentTopology: raw.deploymentTopology as PlcConnection['deploymentTopology'] | undefined,
    host: typeof raw.host === 'string' ? raw.host : undefined,
    port: raw.port !== undefined ? Number(raw.port) : undefined,
    endpointOrTopic: typeof raw.endpointOrTopic === 'string' ? raw.endpointOrTopic : undefined,
    pollIntervalSec:
      raw.pollIntervalSec !== undefined
        ? (Number(raw.pollIntervalSec) as PlcConnection['pollIntervalSec'])
        : undefined,
    authMode: raw.authMode as PlcConnection['authMode'] | undefined,
    username: typeof raw.username === 'string' ? raw.username : undefined,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : undefined,
    tagBindings: Array.isArray(raw.tagBindings) ? (raw.tagBindings as PlcConnection['tagBindings']) : undefined,
  };
}

// WHITE_LABEL_EDITORIAL_CSS imported from src/serverConfig.ts

export interface CreateAppOptions {
  rootDir?: string;
  dbStore?: DatabaseStore;
  mountFrontend?: boolean;
}

export async function createApp(options: CreateAppOptions = {}) {
  const rootDir = options.rootDir ?? DEFAULT_ROOT_DIR;
  const configStateFile = path.resolve(rootDir, '.state', 'job-config.json');
  const dbStore = options.dbStore ?? new DatabaseStore();
  await dbStore.init();

  const authAuditManager = new AuthAuditManager(rootDir, dbStore);
  const alertEngine = new AlertEngine(rootDir, dbStore);
  const runManager = new SimulationRunManager(rootDir, dbStore, alertEngine);
  const connectionManager = new ConnectionManager(rootDir, dbStore);
  const plcCatalogManager = new PlcCatalogManager(rootDir, dbStore);

  let activeJobConfig: JobConfig = { ...DEFAULT_JOB_CONFIG };
  let jobConfigUpdatedAt = new Date().toISOString();

  async function loadPersistedConfig(): Promise<void> {
    let parsed: { config?: Partial<JobConfig>; updatedAt?: string } | null = null;
    try {
      if (dbStore.isPostgresActive()) {
        parsed = await dbStore.getState<{ config?: Partial<JobConfig>; updatedAt?: string }>('job_config');
      }
    } catch {
      // Fallback to local state file
    }
    if (!parsed) {
      try {
        const raw = await fs.readFile(configStateFile, 'utf-8');
        parsed = JSON.parse(raw) as { config?: Partial<JobConfig>; updatedAt?: string };
      } catch {
        // Initial startup without persisted state file
      }
    }
    if (parsed?.config) {
      activeJobConfig = sanitizeJobConfig(parsed.config, DEFAULT_JOB_CONFIG);
      if (parsed.updatedAt) jobConfigUpdatedAt = parsed.updatedAt;
    }
  }

  async function persistJobConfig(): Promise<void> {
    const payload = { config: activeJobConfig, updatedAt: jobConfigUpdatedAt };
    try {
      if (dbStore.isPostgresActive()) {
        await dbStore.saveState('job_config', payload);
      }
    } catch {
      // Fall through to local atomic mirror
    }
    try {
      await atomicWriteJson(configStateFile, payload, true);
    } catch {
      // Non-fatal in ephemeral containers
    }
  }

  await authAuditManager.init();
  await alertEngine.init();
  await plcCatalogManager.init();
  await loadPersistedConfig();
  await connectionManager.init();
  await runManager.init();

  let isShuttingDown = false;
  const markShuttingDown = () => {
    isShuttingDown = true;
  };

  const app = express();
  app.disable('x-powered-by');
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
    const storage = await dbStore.getHealthStatus();
    res.status(200).json({
      status: 'ready',
      name: APP_NAME,
      version: APP_VERSION,
      siteId: resolveSiteId(),
      storageMode: storage.mode,
      dbConnected: storage.connected,
      timestamp: new Date().toISOString(),
    });
  });

  // Top-level deployment version endpoint (mirrors GET /api/v1/version)
  app.get('/version', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(
      buildRuntimeVersionInfo({
        environment: activeJobConfig.environment,
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

  const resolveActor = (req: Request): {
    actor: string;
    actorRole: string;
    sessionUser: ReturnType<AuthAuditManager['resolveSessionToken']>;
    tokenId?: string;
  } => {
    const credential = extractRequestCredential(req);
    const sessionUser =
      authAuditManager.resolveSessionToken(credential) ??
      authAuditManager.resolveOidcProxyHeaders(req.headers);
    if (sessionUser) {
      return { actor: sessionUser.email, actorRole: sessionUser.role, sessionUser };
    }
    if (credential.startsWith('pat_live_')) {
      const tokRes = authAuditManager.resolveApiToken(credential);
      if (tokRes.authorized && tokRes.record) {
        return {
          actor: `token:${tokRes.record.name} (${tokRes.record.ownerEmail})`,
          actorRole: tokRes.record.ownerRole,
          sessionUser: tokRes.ownerUser ?? null,
          tokenId: tokRes.record.id,
        };
      }
    }
    const apiScope = connectionManager.resolveCredentialScope(credential);
    if (apiScope) {
      return { actor: `api-key:${apiScope}`, actorRole: apiScope, sessionUser: null };
    }
    return { actor: 'console-anonymous', actorRole: 'anonymous', sessionUser: null };
  };

  const requireScope = (scope: ApiAuthScope) => (req: Request, res: Response, next: express.NextFunction) => {
    const { requestId, tier } = getRequestContext(req, res);
    const credential = extractRequestCredential(req);

    // 1. Human session token (sess_...) or trusted OIDC proxy headers
    const sessionUser =
      authAuditManager.resolveSessionToken(credential) ??
      authAuditManager.resolveOidcProxyHeaders(req.headers);
    if (sessionUser) {
      const granted = roleToApiScope(sessionUser.role);
      const allowed = granted === 'admin' || granted === scope;
      if (!allowed) {
        res.status(403).json({
          error: `Role '${sessionUser.role}' lacks required '${scope}' scope.`,
          tier,
          requestId,
        });
        return;
      }
      res.setHeader('X-Auth-Scope', granted);
      res.setHeader('X-Auth-User', sessionUser.email);
      next();
      return;
    }

    // 2. Managed Encrypted-at-Rest API Keys (pat_live_... via X-API-Key or Authorization: Bearer)
    if (credential.startsWith('pat_live_')) {
      const clientIp = req.ip || req.socket.remoteAddress || undefined;
      const resolved = authAuditManager.resolveApiToken(credential, clientIp);
      if (!resolved.authorized || !resolved.record || !resolved.scopes) {
        const reason = resolved.deniedReason ?? 'invalid';
        logger.warn('security', `API token rejected (${reason})`, {
          event: 'token.auth_denied',
          reason,
          requiredScope: scope,
          tokenId: resolved.record?.id ?? null,
          tokenPrefix: resolved.record?.tokenPrefix ?? null,
          path: req.originalUrl,
          requestId,
        });
        res.status(401).json({
          error:
            reason === 'revoked'
              ? 'API key has been revoked.'
              : reason === 'expired'
              ? 'API key has expired.'
              : reason === 'owner_disabled'
              ? 'API key owner account is disabled.'
              : 'Invalid API key.',
          tier,
          requestId,
        });
        return;
      }

      const hasScope = resolved.scopes.includes('admin') || resolved.scopes.includes(scope);
      if (!hasScope) {
        logger.warn('security', `API token insufficient scope (${scope} required)`, {
          event: 'token.scope_denied',
          requiredScope: scope,
          grantedScopes: resolved.scopes,
          tokenId: resolved.record.id,
          tokenPrefix: resolved.record.tokenPrefix,
          ownerEmail: resolved.record.ownerEmail,
          path: req.originalUrl,
          requestId,
        });
        res.status(403).json({
          error: `API key '${resolved.record.name}' lacks required '${scope}' scope (granted: ${resolved.scopes.join(', ')}).`,
          tier,
          requestId,
        });
        return;
      }

      const effectiveScope: ApiAuthScope = resolved.scopes.includes('admin') ? 'admin' : scope;
      res.setHeader('X-Auth-Scope', effectiveScope);
      res.setHeader('X-Auth-User', resolved.record.ownerEmail);
      res.setHeader('X-Auth-Token-Id', resolved.record.id);
      next();
      return;
    }

    // 3. Gateway Machine-to-Machine API Keys (adm_live_, bi_live_, gw_live_)
    const auth = connectionManager.authorizeRequest(scope, credential);
    if (!auth.authorized) {
      const status = auth.grantedScope !== 'anonymous' ? 403 : 401;
      res.status(status).json({
        error: auth.reason ?? 'Unauthorized API credential',
        tier,
        requestId,
      });
      return;
    }
    res.setHeader('X-Auth-Scope', auth.grantedScope);
    next();
  };

  const apiRouter = express.Router();

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

  const resolveRequestLanguage = (req: Request): SupportedLanguage => {
    const queryLang = typeof req.query.lang === 'string' ? req.query.lang : null;
    if (queryLang) return normalizeLanguage(queryLang);
    const cookieHeader = req.headers.cookie ?? '';
    const cookieMatch = cookieHeader.match(new RegExp(`(?:^|;\\s*)${LANGUAGE_COOKIE_NAME}=([^;]+)`));
    if (cookieMatch) return normalizeLanguage(decodeURIComponent(cookieMatch[1]));
    const acceptLang = req.headers['accept-language'];
    if (typeof acceptLang === 'string' && acceptLang.trim()) {
      return normalizeLanguage(acceptLang);
    }
    return 'en';
  };

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
        environment: activeJobConfig.environment,
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
      environment: activeJobConfig.environment,
      apiVersion: APP_VERSION,
      activeRunId: latest?.runId ?? null,
      activeRunStatus: latest?.status ?? null,
      storage,
      updatedAt: new Date().toISOString(),
    });
  });

  apiRouter.get('/auth/whoami', (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    const credential = extractRequestCredential(req);
    const sessionUser =
      authAuditManager.resolveSessionToken(credential) ??
      authAuditManager.resolveOidcProxyHeaders(req.headers);
    const enforcementEnabled = connectionManager.isAuthEnforced();

    if (sessionUser) {
      const grantedScope = roleToApiScope(sessionUser.role);
      res.json({
        authenticated: true,
        credentialType: sessionUser.authSource === 'oidc-proxy' ? 'oidc-proxy' : 'session',
        grantedScope,
        enforcementEnabled,
        requestId,
        allowedScopes: grantedScope === 'admin' ? ['admin', 'read', 'edge'] : ['read'],
        user: sessionUser,
        token: null,
      });
      return;
    }

    if (credential.startsWith('pat_live_')) {
      const resolved = authAuditManager.resolveApiToken(
        credential,
        req.ip || req.socket.remoteAddress || undefined
      );
      if (!resolved.authorized || !resolved.record || !resolved.scopes) {
        res.status(401).json({
          authenticated: false,
          credentialType: 'api-token',
          error: `API key rejected (${resolved.deniedReason ?? 'invalid'}).`,
          enforcementEnabled,
          tier,
          requestId,
        });
        return;
      }
      const primaryScope: ApiAuthScope = resolved.scopes.includes('admin')
        ? 'admin'
        : resolved.scopes.includes('edge')
        ? 'edge'
        : 'read';
      res.json({
        authenticated: true,
        credentialType: 'api-token',
        grantedScope: primaryScope,
        enforcementEnabled,
        requestId,
        allowedScopes: resolved.scopes,
        user: resolved.ownerUser ?? null,
        token: {
          id: resolved.record.id,
          name: resolved.record.name,
          prefix: resolved.record.tokenPrefix,
          expiresAt: resolved.record.expiresAt,
          isSandbox: resolved.record.isSandbox,
        },
      });
      return;
    }

    const matched = connectionManager.resolveCredentialScope(credential);
    if (credential && !matched) {
      res.status(401).json({
        error: 'Invalid Bearer, X-API-Key, or X-Gateway-Token credential.',
        tier,
        requestId,
      });
      return;
    }

    const grantedScope = matched ?? 'anonymous';
    const allowedScopes: ApiAuthScope[] =
      grantedScope === 'admin'
        ? ['admin', 'read', 'edge']
        : grantedScope === 'read'
        ? ['read']
        : grantedScope === 'edge'
        ? ['edge']
        : enforcementEnabled
        ? []
        : ['admin', 'read', 'edge'];

    res.json({
      authenticated: Boolean(matched),
      grantedScope,
      enforcementEnabled,
      requestId,
      allowedScopes,
    });
  });

  // Human Operator Login, Session & RBAC Management
  apiRouter.post('/auth/login', loginRateLimit, async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    const email = typeof req.body?.email === 'string' ? req.body.email : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const result = await authAuditManager.authenticateLogin(email, password);
    if (!result) {
      res.status(401).json({
        error: 'Invalid email or password.',
        tier,
        requestId,
      });
      return;
    }
    res.json({
      ...result,
      permissions: authAuditManager.getPermissionsForRole(result.user.role),
      authEnforced: connectionManager.isAuthEnforced(),
    });
  });

  apiRouter.post('/auth/logout', (req, res) => {
    const credential = extractRequestCredential(req);
    const revoked = authAuditManager.revokeSessionToken(credential);
    res.json({ revoked });
  });

  apiRouter.get('/auth/me', (req, res) => {
    const { sessionUser } = resolveActor(req);
    const authEnforced = connectionManager.isAuthEnforced();
    const permissions = sessionUser
      ? authAuditManager.getPermissionsForRole(sessionUser.role)
      : authEnforced
      ? {
          allowedViews: [],
          canControlSimulation: false,
          canWriteConfig: false,
          canManageAlerts: false,
          canManageUsers: false,
        }
      : { ...ADMIN_FULL_POLICY, allowedViews: [...ADMIN_FULL_POLICY.allowedViews] };
    res.json({ user: sessionUser, authEnforced, permissions });
  });

  apiRouter.get('/roles/permissions', requireScope('read'), (_req, res) => {
    res.json(authAuditManager.getRolePermissions());
  });

  apiRouter.put('/roles/permissions', requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    const { sessionUser } = resolveActor(req);
    if (sessionUser && sessionUser.role !== 'admin') {
      res.status(403).json({
        error: 'Only administrators can modify the role permissions matrix.',
        tier,
        requestId,
      });
      return;
    }
    const matrixInput =
      req.body && typeof req.body === 'object' && 'matrix' in req.body
        ? req.body.matrix
        : req.body;
    if (!matrixInput || typeof matrixInput !== 'object') {
      res.status(400).json({
        error: 'Role permissions matrix object is required.',
        tier,
        requestId,
      });
      return;
    }
    const updated = await authAuditManager.updateRolePermissions(matrixInput);
    res.json(updated);
  });

  apiRouter.get('/users', requireScope('read'), (_req, res) => {
    res.json({ users: authAuditManager.listUsers() });
  });

  apiRouter.post('/users', requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    const { sessionUser } = resolveActor(req);
    if (sessionUser && sessionUser.role !== 'admin') {
      res.status(403).json({
        error: 'Only administrators can create user accounts.',
        tier,
        requestId,
      });
      return;
    }
    try {
      const created = await authAuditManager.createUser({
        email: String(req.body?.email ?? ''),
        fullName: String(req.body?.fullName ?? ''),
        role: req.body?.role,
        password: String(req.body?.password ?? ''),
      });
      res.status(201).json({ user: created, users: authAuditManager.listUsers() });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to create user',
        tier,
        requestId,
      });
    }
  });

  apiRouter.patch('/users/:id', requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    const { actor, actorRole, sessionUser } = resolveActor(req);
    if (sessionUser && sessionUser.role !== 'admin') {
      res.status(403).json({
        error: 'Only administrators can update user accounts.',
        tier,
        requestId,
      });
      return;
    }
    const updated = await authAuditManager.updateUser(
      req.params.id,
      {
        role: req.body?.role,
        active: typeof req.body?.active === 'boolean' ? req.body.active : undefined,
        fullName: typeof req.body?.fullName === 'string' ? req.body.fullName : undefined,
        password: typeof req.body?.password === 'string' ? req.body.password : undefined,
      },
      { actor, actorRole, requestId }
    );
    if (!updated) {
      res.status(404).json({ error: 'User not found', tier, requestId });
      return;
    }
    res.json({ user: updated, users: authAuditManager.listUsers() });
  });

  // Managed API Keys (X-API-Key / Bearer, AES-256-GCM encrypted SHA-256 hashes at rest)
  apiRouter.get('/tokens', requireScope('read'), (_req, res) => {
    const listing = authAuditManager.listApiTokens();
    res.json({
      ...listing,
      authEnforced: connectionManager.isAuthEnforced(),
    });
  });

  apiRouter.post('/tokens', keyRotateRateLimit, requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    const { actor, actorRole, sessionUser } = resolveActor(req);
    if (sessionUser && sessionUser.role !== 'admin') {
      res.status(403).json({
        error: 'Only administrators can issue API keys.',
        tier,
        requestId,
      });
      return;
    }

    try {
      const rawTtl = req.body?.ttlHours;
      const ttlHours =
        rawTtl === null || rawTtl === 'never'
          ? null
          : typeof rawTtl === 'number'
          ? rawTtl
          : typeof rawTtl === 'string' && rawTtl.trim() !== ''
          ? Number(rawTtl)
          : 24 * 30;

      const issued = await authAuditManager.issueApiToken({
        name: String(req.body?.name ?? ''),
        description: typeof req.body?.description === 'string' ? req.body.description : '',
        scopes: Array.isArray(req.body?.scopes) ? req.body.scopes : ['read'],
        ownerUserId: typeof req.body?.ownerUserId === 'string' ? req.body.ownerUserId : undefined,
        ownerEmail: typeof req.body?.ownerEmail === 'string' ? req.body.ownerEmail : undefined,
        createdBy: actor,
        actorRole,
        requestId,
        ttlHours,
        isSandbox: Boolean(req.body?.isSandbox),
      });

      logger.info('security', 'Managed API key issued', {
        event: 'token.issued',
        tokenId: issued.record.id,
        tokenPrefix: issued.record.tokenPrefix,
        tokenName: issued.record.name,
        scopes: issued.record.scopes,
        ownerEmail: issued.record.ownerEmail,
        expiresAt: issued.record.expiresAt,
        isSandbox: issued.record.isSandbox,
        actor,
        requestId,
      });

      res.status(201).json({
        token: issued.token,
        record: issued.record,
        warning:
          'Copy this API key now. Only its AES-256-GCM encrypted SHA-256 hash is stored and the plaintext key will never be shown again.',
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to issue API key.',
        tier,
        requestId,
      });
    }
  });

  // Short-lived (1h) Sandbox Test API Key for Scalar interactive testing
  apiRouter.post('/tokens/sandbox', loginRateLimit, async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    const { actor, sessionUser } = resolveActor(req);
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const requestedName =
      typeof req.body?.name === 'string' && req.body.name.trim()
        ? req.body.name.trim().slice(0, 80)
        : '';

    let targetOwnerEmail: string | null = null;
    let targetRole: 'admin' | 'operator' | 'viewer' = 'viewer';
    let issuerActor = actor;

    if (email && password) {
      const loginRes = await authAuditManager.authenticateLogin(email, password);
      if (!loginRes) {
        logger.warn('security', 'Sandbox API key issuance denied (invalid credentials)', {
          event: 'token.sandbox_denied',
          email,
          requestId,
        });
        res.status(401).json({
          error: 'Invalid email or password.',
          tier,
          requestId,
        });
        return;
      }
      // Revoke the throwaway login session immediately; caller gets a bounded 1h pat_live_ sandbox key
      authAuditManager.revokeSessionToken(loginRes.token);
      targetOwnerEmail = loginRes.user.email;
      targetRole = loginRes.user.role;
      issuerActor = loginRes.user.email;
    } else if (sessionUser && sessionUser.role === 'admin') {
      const requestedRole =
        req.body?.role === 'admin' || req.body?.role === 'operator' || req.body?.role === 'viewer'
          ? req.body.role
          : 'operator';
      const matchingUser =
        authAuditManager.listUsers().find((u) => u.active && u.role === requestedRole) ??
        authAuditManager.listUsers().find((u) => u.id === sessionUser.id);
      targetOwnerEmail = matchingUser?.email ?? sessionUser.email;
      targetRole = matchingUser?.role ?? sessionUser.role;
    } else if (!connectionManager.isAuthEnforced()) {
      // Local dev convenience when API_ENFORCE_AUTH is false: issue bounded 1h sandbox key for requested built-in role
      const requestedRole =
        req.body?.role === 'admin' || req.body?.role === 'operator' || req.body?.role === 'viewer'
          ? req.body.role
          : 'operator';
      const matchingUser =
        authAuditManager.listUsers().find((u) => u.active && u.role === requestedRole) ??
        authAuditManager.listUsers().find((u) => u.active);
      if (!matchingUser) {
        res.status(400).json({ error: 'No active user account available for sandbox token.', tier, requestId });
        return;
      }
      targetOwnerEmail = matchingUser.email;
      targetRole = matchingUser.role;
      issuerActor = `local-sandbox:${matchingUser.email}`;
    } else {
      res.status(401).json({
        error: 'Valid email and password (or admin credentials) are required to issue a sandbox test key.',
        tier,
        requestId,
      });
      return;
    }

    const roleScopes: Array<'read' | 'edge' | 'admin'> =
      targetRole === 'admin'
        ? ['admin', 'read', 'edge']
        : targetRole === 'operator'
        ? ['read', 'edge']
        : ['read'];

    const issued = await authAuditManager.issueApiToken({
      name: requestedName || `Scalar Sandbox (${targetRole})`,
      description: 'Short-lived 1h interactive test key issued for OpenAPI / Scalar verification.',
      scopes: roleScopes,
      ownerEmail: targetOwnerEmail,
      createdBy: issuerActor,
      actorRole: targetRole,
      requestId,
      ttlHours: 1,
      isSandbox: true,
    });

    logger.info('security', 'Short-lived sandbox API key issued for Scalar', {
      event: 'token.sandbox_issued',
      tokenId: issued.record.id,
      tokenPrefix: issued.record.tokenPrefix,
      scopes: issued.record.scopes,
      ownerEmail: issued.record.ownerEmail,
      expiresAt: issued.record.expiresAt,
      actor: issuerActor,
      requestId,
    });

    res.status(201).json({
      token: issued.token,
      record: issued.record,
      warning: 'Short-lived 1-hour sandbox API key. Pass via X-API-Key or Authorization: Bearer.',
    });
  });

  apiRouter.post('/tokens/:id/rotate', keyRotateRateLimit, requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    const { actor, actorRole, sessionUser } = resolveActor(req);
    if (sessionUser && sessionUser.role !== 'admin') {
      res.status(403).json({
        error: 'Only administrators can rotate API keys.',
        tier,
        requestId,
      });
      return;
    }

    const rotated = await authAuditManager.rotateApiToken(req.params.id, actor, {
      actorRole,
      requestId,
    });
    if (!rotated) {
      res.status(404).json({ error: 'API key not found.', tier, requestId });
      return;
    }

    logger.info('security', 'Managed API key rotated', {
      event: 'token.rotated',
      previousTokenId: rotated.previousId,
      tokenId: rotated.record.id,
      tokenPrefix: rotated.record.tokenPrefix,
      scopes: rotated.record.scopes,
      ownerEmail: rotated.record.ownerEmail,
      actor,
      requestId,
    });

    res.status(201).json({
      token: rotated.token,
      record: rotated.record,
      previousId: rotated.previousId,
      warning: 'Previous API key has been immediately revoked. Copy the replacement key now.',
    });
  });

  apiRouter.delete('/tokens/:id', requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    const { actor, actorRole, sessionUser } = resolveActor(req);
    if (sessionUser && sessionUser.role !== 'admin') {
      res.status(403).json({
        error: 'Only administrators can revoke API keys.',
        tier,
        requestId,
      });
      return;
    }

    const revoked = await authAuditManager.revokeApiToken(
      req.params.id,
      actor,
      'manual_revocation',
      { actorRole, requestId }
    );
    if (!revoked) {
      res.status(404).json({ error: 'API key not found.', tier, requestId });
      return;
    }

    logger.info('security', 'Managed API key revoked', {
      event: 'token.revoked',
      tokenId: revoked.id,
      tokenPrefix: revoked.tokenPrefix,
      ownerEmail: revoked.ownerEmail,
      actor,
      requestId,
    });

    res.json({ revoked: true, record: revoked });
  });

  // Immutable Audit Log Query & CSV Export
  apiRouter.get('/audit/logs', requireScope('read'), async (req, res) => {
    const action = typeof req.query.action === 'string' ? req.query.action : undefined;
    const actor = typeof req.query.actor === 'string' ? req.query.actor : undefined;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const format = typeof req.query.format === 'string' ? req.query.format.trim().toLowerCase() : 'json';

    const logs = await authAuditManager.queryAuditLogs({ action, actor, status, limit });

    if (format === 'csv') {
      const cols = ['id', 'timestamp', 'actor', 'actorRole', 'action', 'resource', 'status', 'requestId'];
      const lines = [
        cols.map((c) => sanitizeCsvCell(c)).join(','),
        ...logs.map((row) =>
          cols.map((c) => sanitizeCsvCell((row as unknown as Record<string, unknown>)[c] ?? '')).join(',')
        ),
      ];
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="audit_log_export.csv"');
      res.send(lines.join('\n'));
      return;
    }

    res.json({ count: logs.length, logs });
  });

  // Notifications & Alerts (Email SMTP / Mailpit + HTTP Webhook)
  apiRouter.get('/alerts', requireScope('read'), (_req, res) => {
    res.json(alertEngine.getPublicState());
  });

  apiRouter.put('/alerts/channels', requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    try {
      const updated = await alertEngine.updateChannels({
        smtp: req.body?.smtp,
        webhook: req.body?.webhook,
      });
      res.json(updated);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to update notification channels',
        tier,
        requestId,
      });
    }
  });

  apiRouter.post('/alerts/rules', requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    try {
      const saved = await alertEngine.upsertRule(req.body ?? {});
      res.status(req.body?.id ? 200 : 201).json(saved);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to save alert rule',
        tier,
        requestId,
      });
    }
  });

  apiRouter.delete('/alerts/rules/:id', requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    const removed = await alertEngine.deleteRule(req.params.id);
    if (!removed.deleted) {
      res.status(404).json({ error: 'Alert rule not found', tier, requestId });
      return;
    }
    res.json(removed);
  });

  apiRouter.post('/alerts/test-channel', probeRateLimit, requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    const channel = req.body?.channel === 'webhook' ? 'webhook' : 'email';
    try {
      const outcome = await alertEngine.testChannel(channel, {
        recipient: typeof req.body?.recipient === 'string' ? req.body.recipient : undefined,
        webhookUrl: typeof req.body?.webhookUrl === 'string' ? req.body.webhookUrl : undefined,
      });
      res.status(outcome.status === 'sent' ? 200 : 502).json({ outcome });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Alert channel test failed',
        tier,
        requestId,
      });
    }
  });

  apiRouter.post('/alerts/events/:id/ack', requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    const { actor } = resolveActor(req);
    const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
    const event = await alertEngine.acknowledgeEvent(req.params.id, actor, note);
    if (!event) {
      res.status(404).json({ error: 'Alert event not found', tier, requestId });
      return;
    }
    res.json({ event, state: alertEngine.getPublicState() });
  });

  apiRouter.post('/alerts/events/:id/unack', requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    const { actor } = resolveActor(req);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
    const event = await alertEngine.reopenEvent(req.params.id, actor, reason);
    if (!event) {
      res.status(404).json({ error: 'Alert event not found', tier, requestId });
      return;
    }
    res.json({ event, state: alertEngine.getPublicState() });
  });

  apiRouter.patch('/alerts/events/:id/note', requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    const { actor } = resolveActor(req);
    const note = typeof req.body?.note === 'string' ? req.body.note : '';
    const event = await alertEngine.updateEventNote(req.params.id, actor, note);
    if (!event) {
      res.status(404).json({ error: 'Alert event not found', tier, requestId });
      return;
    }
    res.json({ event, state: alertEngine.getPublicState() });
  });

  // SMTP Diagnostics & Mailpit REST API Proxy
  apiRouter.post('/alerts/smtp/verify', probeRateLimit, requireScope('admin'), async (_req, res) => {
    const result = await alertEngine.verifySmtpConnection();
    res.status(result.reachable ? 200 : 502).json(result);
  });

  apiRouter.post('/alerts/smtp/send-test', probeRateLimit, requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    try {
      const result = await alertEngine.sendDiagnosticEmail({
        recipient: typeof req.body?.recipient === 'string' ? req.body.recipient : undefined,
        subject: typeof req.body?.subject === 'string' ? req.body.subject : undefined,
        body: typeof req.body?.body === 'string' ? req.body.body : undefined,
      });
      res.status(result.outcome.status === 'sent' ? 200 : 502).json(result);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'SMTP diagnostic send failed',
        tier,
        requestId,
      });
    }
  });

  apiRouter.get('/alerts/mailpit/status', requireScope('read'), async (req, res) => {
    const apiBaseUrl = typeof req.query.apiBaseUrl === 'string' ? req.query.apiBaseUrl : undefined;
    const result = await alertEngine.fetchMailpitStatus(apiBaseUrl);
    res.status(result.connected ? 200 : 502).json(result);
  });

  apiRouter.get('/alerts/mailpit/messages', requireScope('read'), async (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : 25;
    const query = typeof req.query.query === 'string' ? req.query.query : undefined;
    const apiBaseUrl = typeof req.query.apiBaseUrl === 'string' ? req.query.apiBaseUrl : undefined;
    const result = await alertEngine.fetchMailpitMessages({ limit, query, apiBaseUrl });
    res.status(result.reachable ? 200 : 502).json(result);
  });

  apiRouter.get('/alerts/mailpit/messages/:id', requireScope('read'), async (req, res) => {
    const apiBaseUrl = typeof req.query.apiBaseUrl === 'string' ? req.query.apiBaseUrl : undefined;
    const result = await alertEngine.fetchMailpitMessageDetail(req.params.id, apiBaseUrl);
    res.status(result.reachable ? 200 : 502).json(result);
  });

  apiRouter.delete('/alerts/mailpit/messages', requireScope('admin'), async (req, res) => {
    const apiBaseUrl = typeof req.query.apiBaseUrl === 'string' ? req.query.apiBaseUrl : undefined;
    const result = await alertEngine.clearMailpitInbox(apiBaseUrl);
    res.status(result.cleared ? 200 : 502).json(result);
  });

  apiRouter.get('/catalog/machines', requireScope('read'), (req, res) => {
    const domain = typeof req.query.domain === 'string' ? req.query.domain.trim() : undefined;
    const protocol = typeof req.query.protocol === 'string' ? req.query.protocol.trim() : undefined;
    res.json(plcCatalogManager.listCatalog({ domain, protocol }));
  });

  apiRouter.get('/catalog/machines/:typeId', requireScope('read'), (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    const found = plcCatalogManager.getProfile(req.params.typeId);
    if (!found) {
      res.status(404).json({ error: 'PLC catalog profile not found', tier, requestId });
      return;
    }
    res.json(found);
  });

  apiRouter.post('/catalog/machines', requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    try {
      const schema =
        tier === 'strict' ? PlcCatalogUpsertStrictSchema : PlcCatalogUpsertPermissiveSchema;
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
      const saved = await plcCatalogManager.upsertProfile(
        parsed.data as Partial<PlcCatalogProfile>
      );
      res.status(saved.created ? 201 : 200).json(saved);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to save PLC catalog profile',
        tier,
        requestId,
      });
    }
  });

  apiRouter.delete('/catalog/machines/:typeId', requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    try {
      const removed = await plcCatalogManager.deleteOrResetProfile(req.params.typeId);
      if (!removed.deleted && !removed.resetToBuiltIn) {
        res.status(404).json({ error: 'PLC catalog profile not found', tier, requestId });
        return;
      }
      res.json(removed);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to remove PLC catalog profile',
        tier,
        requestId,
      });
    }
  });

  apiRouter.post('/catalog/machines/:typeId/preview-output', requireScope('read'), (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    const profile = plcCatalogManager.getProfile(req.params.typeId);
    if (!profile) {
      res.status(404).json({ error: 'PLC catalog profile not found', tier, requestId });
      return;
    }
    const parsed = PlcOutputPreviewRequestSchema.safeParse(req.body ?? {});
    const input = parsed.success ? parsed.data : {};
    const nowIso = new Date().toISOString();
    const machineId = typeof input.machineId === 'string' ? input.machineId : 'PLC-PREVIEW-01';
    const lineId = typeof input.lineId === 'string' ? input.lineId : 'line-01';
    const state = typeof input.state === 'string' ? input.state : 'RUNNING';
    const isFault = state === 'FAULT';
    const isDegraded = state === 'DEGRADED';

    const tempVal = Number(
      (
        profile.tempNominalC +
        (isFault ? (profile.tempFaultThresholdC - profile.tempNominalC) * 1.05 : isDegraded ? 12 : 1.2)
      ).toFixed(2)
    );
    const primaryVal = Number(
      (
        profile.primaryNominal +
        (isFault
          ? (profile.primaryFaultThreshold - profile.primaryNominal) * 1.05
          : isDegraded
          ? (profile.primaryFaultThreshold - profile.primaryNominal) * 0.45
          : profile.primaryStd * 0.5)
      ).toFixed(3)
    );
    const secondaryVal = Number(
      (profile.secondaryNominal + (isFault ? profile.secondaryStd * 4 : profile.secondaryStd * 0.4)).toFixed(3)
    );

    const extraMetrics: Record<string, number> = {};
    for (const ch of profile.extraChannels) {
      extraMetrics[ch.key] = Number((ch.nominal + (isFault ? ch.std * 2.5 : ch.std * 0.3)).toFixed(3));
    }

    const sampleEnvelope = {
      event_id: `prev-${profile.typeId}-${Date.now().toString(36)}`,
      timestamp: nowIso,
      machine_id: machineId,
      line_id: lineId,
      machine_type: profile.typeId,
      domain: profile.domain,
      state,
      level: isFault ? 'ERROR' : isDegraded ? 'WARN' : 'INFO',
      error_code: isFault ? 'ERR_THRESHOLD_EXCEEDED' : null,
      metrics: {
        temp_c: tempVal,
        [profile.primaryKey]: primaryVal,
        [profile.secondaryKey]: secondaryVal,
        ...extraMetrics,
      },
    };

    const fullFeatureRow: Record<string, unknown> = {
      machine_id: machineId,
      line_id: lineId,
      machine_type: profile.typeId,
      domain: profile.domain,
      window_start: `${nowIso.slice(0, 16)}:00.000Z`,
      sample_count: 150,
      valid_sample_ratio: 1,
      temp_mean: tempVal,
      temp_max: Number((tempVal + 1.5).toFixed(2)),
      primary_metric_mean: primaryVal,
      primary_metric_p95: Number((primaryVal * 1.06).toFixed(3)),
      primary_metric_max: Number((primaryVal * 1.1).toFixed(3)),
      secondary_metric_mean: secondaryVal,
      vibration_p95: profile.primaryKey === 'vibration_mm_s' ? primaryVal : secondaryVal,
      cycle_ms_mean: profile.primaryKey === 'cycle_ms' ? primaryVal : 950,
      fault_count: isFault ? 4 : 0,
      time_in_fault_sec: isFault ? 24 : 0,
      is_anomalous_window: isFault || isDegraded ? 1 : 0,
      will_fail_next_window: isDegraded ? 1 : 0,
      custom_metrics_avg: extraMetrics,
    };

    const requestedFields =
      Array.isArray(input.fields) && input.fields.length > 0
        ? input.fields
        : profile.defaultOutputFields;

    const fullBaRow: Record<string, unknown> = {
      dt: nowIso.slice(0, 10),
      domain: profile.domain,
      line_id: lineId,
      machine_id: machineId,
      machine_type: profile.typeId,
      ba_formula: profile.baFormula,
      availability_oee_pct: isFault ? 82.5 : isDegraded ? 96.4 : 99.8,
      primary_metric_name: profile.primaryKey,
      primary_metric_unit: profile.primaryUnit,
      primary_metric_avg: primaryVal,
      estimated_energy_kwh:
        profile.baFormula === 'energy_kwh_integration' ? Number((primaryVal * 8).toFixed(2)) : 0,
      estimated_gas_volume_nm3:
        profile.baFormula === 'gas_nm3_integration' ? Number((primaryVal * 8).toFixed(2)) : 0,
    };

    res.json({
      typeId: profile.typeId,
      profile,
      sampleEnvelope,
      projectedFeatureWindow: projectRowFields(fullFeatureRow, requestedFields),
      projectedBaKpi: fullBaRow,
    });
  });

  apiRouter.get('/edge/config', requireScope('edge'), (_req, res) => {
    res.json(connectionManager.getEdgeSyncConfig());
  });

  apiRouter.get('/job/config', requireScope('read'), (_req, res) => {
    res.json({
      config: activeJobConfig,
      updatedAt: jobConfigUpdatedAt,
    });
  });

  apiRouter.put('/job/config', requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    try {
      const schema = tier === 'strict' ? JobConfigStrictSchema : JobConfigPermissiveSchema;
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

      activeJobConfig = sanitizeJobConfig(parsed.data as Partial<JobConfig>, activeJobConfig);
      jobConfigUpdatedAt = new Date().toISOString();
      await persistJobConfig();
      res.json({
        config: activeJobConfig,
        updatedAt: jobConfigUpdatedAt,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Unable to save job configuration',
        tier,
        requestId,
      });
    }
  });

  apiRouter.post('/ingest/batch', ingestRateLimit, requireScope('edge'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    try {

      let rawEvents: unknown[];
      if (tier === 'strict') {
        const parsed = IngestBatchStrictSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          res.status(400).json({
            error: 'Validation failed (Tier 2 Strict)',
            tier,
            requestId,
            issues: formatZodIssues(parsed.error),
          });
          return;
        }
        rawEvents = parsed.data.events;
      } else {
        const parsed = IngestBatchPermissiveSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          res.status(400).json({
            error: 'Request body must include a non-empty events array or single event object.',
            tier,
            requestId,
            issues: formatZodIssues(parsed.error),
          });
          return;
        }
        const sourceList = parsed.data.events ?? (parsed.data.event !== undefined ? [parsed.data.event] : []);
        rawEvents = sourceList.map(normalizePermissiveEvent);
      }

      if (rawEvents.length > 5000) {
        res.status(413).json({
          error: 'Batch size exceeds 5,000 events per request.',
          tier,
          requestId,
        });
        return;
      }

      const result = runManager.ingestExternalBatch(rawEvents, {
        windowMinutes: activeJobConfig.windowMinutes,
        machinesPerLine: activeJobConfig.machinesPerLine,
        machineProfileMode: activeJobConfig.machineProfileMode,
        rotateMaxLines: activeJobConfig.rotateMaxLines,
        customMachineTopology: activeJobConfig.customMachineTopology,
        ignoredErrorCodes: activeJobConfig.ignoredErrorCodes,
        horizonWindows: activeJobConfig.horizonWindows,
        tempAnomalyThresholdC: activeJobConfig.tempAnomalyThresholdC,
        vibrationP95Threshold: activeJobConfig.vibrationP95Threshold,
        minValidSampleRatio: activeJobConfig.minValidSampleRatio,
        dedupStrategy: activeJobConfig.dedupStrategy,
        malformedPolicy: activeJobConfig.malformedPolicy,
        parquetCompression: activeJobConfig.parquetCompression,
        datasetVersion: activeJobConfig.datasetVersion,
        partitionLayout: activeJobConfig.partitionLayout,
        lakehouseFormat: activeJobConfig.lakehouseFormat,
        hotRetentionDays: activeJobConfig.hotRetentionDays,
        coldRetentionDays: activeJobConfig.coldRetentionDays,
        coldStorageEndpoint: activeJobConfig.coldStorageEndpoint,
        compactionSchedule: activeJobConfig.compactionSchedule,
        ingestTransport: activeJobConfig.ingestTransport,
      });

      const countsByMachine = new Map<string, number>();
      if (result.accepted > 0) {
        for (const item of rawEvents) {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            const mId = (item as Record<string, unknown>).machine_id;
            if (typeof mId === 'string' && mId.trim()) {
              countsByMachine.set(mId.trim(), (countsByMachine.get(mId.trim()) ?? 0) + 1);
            }
          }
        }
        await connectionManager.recordIngestedMachineCounts(countsByMachine);
      }

      metricsRegistry.recordIngestionBatch(result.accepted, result.quarantined);
      logger.info('ingestion', 'Processed external telemetry batch', {
        requestId,
        accepted: result.accepted,
        quarantined: result.quarantined,
        validationTier: tier,
      });

      res.status(202).json(result);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Batch ingestion failed',
        tier,
        requestId,
      });
    }
  });

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
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to update network deployment settings',
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
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to rotate gateway token',
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
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to rotate scoped API key',
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
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to save connection',
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
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to delete connection',
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
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Connection probe failed',
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
        windowMinutes: activeJobConfig.windowMinutes,
        machinesPerLine: activeJobConfig.machinesPerLine,
        machineProfileMode: activeJobConfig.machineProfileMode,
        rotateMaxLines: activeJobConfig.rotateMaxLines,
        dedupStrategy: activeJobConfig.dedupStrategy,
        malformedPolicy: activeJobConfig.malformedPolicy,
        parquetCompression: activeJobConfig.parquetCompression,
        datasetVersion: activeJobConfig.datasetVersion,
        partitionLayout: activeJobConfig.partitionLayout,
        lakehouseFormat: activeJobConfig.lakehouseFormat,
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
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Test batch dispatch failed',
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
      datasetVersion: activeJobConfig.datasetVersion,
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
        windowMinutes: Number(body.windowMinutes ?? activeJobConfig.windowMinutes),
        machineCount: Number(body.machineCount ?? 4),
        machinesPerLine: Number(body.machinesPerLine ?? activeJobConfig.machinesPerLine),
        machineProfileMode:
          (body.machineProfileMode as MachineProfileMode | undefined) ??
          activeJobConfig.machineProfileMode,
        selectedPlcTypes: Array.isArray(body.selectedPlcTypes)
          ? (body.selectedPlcTypes as string[])
          : undefined,
        outputFields: Array.isArray(body.outputFields)
          ? (body.outputFields as string[])
          : undefined,
        faultProbabilityPct: Number(body.faultProbabilityPct ?? 5),
        malformedRatePct: Number(body.malformedRatePct ?? 7),
        outOfOrderRatePct: Number(body.outOfOrderRatePct ?? 8),
        rotateMaxLines: Number(body.rotateMaxLines ?? activeJobConfig.rotateMaxLines),
        seed: Number(body.seed ?? 42),
        customMachineTopology:
          typeof body.customMachineTopology === 'string'
            ? body.customMachineTopology
            : activeJobConfig.customMachineTopology,
        ignoredErrorCodes:
          typeof body.ignoredErrorCodes === 'string'
            ? body.ignoredErrorCodes
            : activeJobConfig.ignoredErrorCodes,
        horizonWindows: Number(body.horizonWindows ?? activeJobConfig.horizonWindows),
        tempAnomalyThresholdC: Number(
          body.tempAnomalyThresholdC ?? activeJobConfig.tempAnomalyThresholdC
        ),
        vibrationP95Threshold: Number(
          body.vibrationP95Threshold ?? activeJobConfig.vibrationP95Threshold
        ),
        minValidSampleRatio: Number(
          body.minValidSampleRatio ?? activeJobConfig.minValidSampleRatio
        ),
        dedupStrategy:
          (body.dedupStrategy as JobConfig['dedupStrategy'] | undefined) ??
          activeJobConfig.dedupStrategy,
        malformedPolicy:
          (body.malformedPolicy as JobConfig['malformedPolicy'] | undefined) ??
          activeJobConfig.malformedPolicy,
        parquetCompression:
          (body.parquetCompression as JobConfig['parquetCompression'] | undefined) ??
          activeJobConfig.parquetCompression,
        datasetVersion:
          typeof body.datasetVersion === 'string'
            ? body.datasetVersion
            : activeJobConfig.datasetVersion,
        partitionLayout:
          (body.partitionLayout as JobConfig['partitionLayout'] | undefined) ??
          activeJobConfig.partitionLayout,
        lakehouseFormat:
          (body.lakehouseFormat as JobConfig['lakehouseFormat'] | undefined) ??
          activeJobConfig.lakehouseFormat,
        hotRetentionDays: Number(body.hotRetentionDays ?? activeJobConfig.hotRetentionDays),
        coldRetentionDays: Number(body.coldRetentionDays ?? activeJobConfig.coldRetentionDays),
        coldStorageEndpoint:
          (body.coldStorageEndpoint as JobConfig['coldStorageEndpoint'] | undefined) ??
          activeJobConfig.coldStorageEndpoint,
        compactionSchedule:
          (body.compactionSchedule as JobConfig['compactionSchedule'] | undefined) ??
          activeJobConfig.compactionSchedule,
        ingestTransport:
          (body.ingestTransport as JobConfig['ingestTransport'] | undefined) ??
          activeJobConfig.ingestTransport,
      });
      res.status(201).json(snapshot);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Unable to start streaming simulation',
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
  });
}
