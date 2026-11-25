import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { resolveMachineSpec } from './machineCatalog.ts';
import {
  sha256Hex,
  timingSafeHashMatch,
  timingSafeStringEqual,
  validateOutboundHost,
  type ApiAuthScope,
} from './security.ts';
import { isApiAuthEnforced } from './config/runtimeEnv.ts';
import { atomicWriteJson } from './utils/persistence.ts';
import type { DatabaseStore } from './db.ts';
import type {
  ConnectionAuthMode,
  ConnectionProbeResult,
  ConnectionProtocol,
  ConnectionsStateResponse,
  DeploymentTopology,
  NetworkDeploymentSettings,
  OnPremDeployBundle,
  PlcConnection,
  TagBinding,
} from './types/pipeline.ts';

interface PersistedConnectionsState {
  settings: NetworkDeploymentSettings;
  tokenHash: string | null;
  readTokenHash?: string | null;
  adminTokenHash?: string | null;
  connections: PlcConnection[];
  updatedAt: string;
}

const DEFAULT_SETTINGS: NetworkDeploymentSettings = {
  topologyMode: 'on-premise-lan',
  siteName: 'Stabilimento Principale IT-01',
  plantVlanCidr: '192.168.10.0/24',
  ingestApiUrl: 'http://10.10.20.15:3000/api/v1/ingest/batch',
  requireGatewayToken: false,
  spoolMaxMb: 1024,
  tokenFingerprint: null,
  tokenUpdatedAt: null,
  readTokenFingerprint: null,
  adminTokenFingerprint: null,
};

const DEFAULT_CONNECTIONS: PlcConnection[] = [
  {
    id: 'conn-plc-line01',
    name: 'Siemens S7-1500 Line 01',
    machineId: 'M-01',
    lineId: 'line-01',
    machineType: 'plc-controller',
    protocol: 'opcua',
    deploymentTopology: 'on-premise-lan',
    host: '192.168.10.11',
    port: 4840,
    endpointOrTopic: 'opc.tcp://192.168.10.11:4840/UA/S71500',
    pollIntervalSec: 2,
    authMode: 'x509-cert',
    enabled: true,
    status: 'configured',
    lastProbeAt: null,
    lastLatencyMs: null,
    lastError: null,
    samplesIngested: 0,
    tagBindings: [
      { sourceTag: 'ns=3;s="DB_Telemetry"."TempC"', targetMetric: 'temp_c', scaleFactor: 1, unit: 'C' },
      { sourceTag: 'ns=3;s="DB_Telemetry"."CycleMs"', targetMetric: 'cycle_ms', scaleFactor: 1, unit: 'ms' },
      { sourceTag: 'ns=3;s="DB_Telemetry"."Vibration"', targetMetric: 'vibration_mm_s', scaleFactor: 0.01, unit: 'mm/s' },
    ],
  },
  {
    id: 'conn-gas-line02',
    name: 'Endress+Hauser Methane Skid',
    machineId: 'M-03',
    lineId: 'line-02',
    machineType: 'gas-flow-meter',
    protocol: 'modbus-tcp',
    deploymentTopology: 'edge-gateway-push',
    host: '192.168.10.24',
    port: 502,
    endpointOrTopic: 'unit=1;hr=40001..40006',
    pollIntervalSec: 5,
    authMode: 'anonymous',
    enabled: true,
    status: 'configured',
    lastProbeAt: null,
    lastLatencyMs: null,
    lastError: null,
    samplesIngested: 0,
    tagBindings: [
      { sourceTag: 'HR:40001', targetMetric: 'flow_nm3_h', scaleFactor: 0.1, unit: 'Nm3/h' },
      { sourceTag: 'HR:40003', targetMetric: 'pressure_bar', scaleFactor: 0.01, unit: 'bar' },
      { sourceTag: 'HR:40005', targetMetric: 'temp_c', scaleFactor: 0.1, unit: 'C' },
    ],
  },
  {
    id: 'conn-pwr-line03',
    name: 'Schneider PowerLogic Cabin 03',
    machineId: 'M-04',
    lineId: 'line-03',
    machineType: 'power-meter',
    protocol: 'mqtt-sparkplug',
    deploymentTopology: 'site-to-site-vpn',
    host: '10.20.40.12',
    port: 8883,
    endpointOrTopic: 'spBv1.0/plant01/DDATA/line-03/M-04',
    pollIntervalSec: 5,
    authMode: 'username-password',
    username: 'ot_broker_ro',
    enabled: true,
    status: 'configured',
    lastProbeAt: null,
    lastLatencyMs: null,
    lastError: null,
    samplesIngested: 0,
    tagBindings: [
      { sourceTag: 'metrics.power_kw', targetMetric: 'power_kw', scaleFactor: 1, unit: 'kW' },
      { sourceTag: 'metrics.frequency_hz', targetMetric: 'frequency_hz', scaleFactor: 1, unit: 'Hz' },
      { sourceTag: 'metrics.temp_c', targetMetric: 'temp_c', scaleFactor: 1, unit: 'C' },
    ],
  },
];

export function defaultPortForProtocol(protocol: ConnectionProtocol): number {
  switch (protocol) {
    case 'opcua':
      return 4840;
    case 'modbus-tcp':
      return 502;
    case 'mqtt-sparkplug':
      return 8883;
    case 'http-rest-meter':
      return 8080;
  }
}

export function defaultTagBindingsForMachine(
  machineType: string,
  protocol: ConnectionProtocol
): TagBinding[] {
  const spec = resolveMachineSpec(machineType);
  if (protocol === 'modbus-tcp') {
    return [
      { sourceTag: 'HR:40001', targetMetric: spec.primaryKey, scaleFactor: 0.1, unit: spec.primaryUnit },
      { sourceTag: 'HR:40003', targetMetric: spec.secondaryKey, scaleFactor: 0.01, unit: spec.secondaryUnit },
      { sourceTag: 'HR:40005', targetMetric: 'temp_c', scaleFactor: 0.1, unit: 'C' },
    ];
  }
  if (protocol === 'opcua') {
    return [
      { sourceTag: `ns=2;s=Machine.${spec.primaryKey}`, targetMetric: spec.primaryKey, scaleFactor: 1, unit: spec.primaryUnit },
      { sourceTag: `ns=2;s=Machine.${spec.secondaryKey}`, targetMetric: spec.secondaryKey, scaleFactor: 1, unit: spec.secondaryUnit },
      { sourceTag: 'ns=2;s=Machine.temp_c', targetMetric: 'temp_c', scaleFactor: 1, unit: 'C' },
    ];
  }
  return [
    { sourceTag: `metrics.${spec.primaryKey}`, targetMetric: spec.primaryKey, scaleFactor: 1, unit: spec.primaryUnit },
    { sourceTag: `metrics.${spec.secondaryKey}`, targetMetric: spec.secondaryKey, scaleFactor: 1, unit: spec.secondaryUnit },
    { sourceTag: 'metrics.temp_c', targetMetric: 'temp_c', scaleFactor: 1, unit: 'C' },
  ];
}

export class ConnectionManager {
  private stateFile: string;
  private state: PersistedConnectionsState;
  private dbStore: DatabaseStore | null;

  constructor(rootDir: string, dbStore?: DatabaseStore) {
    this.stateFile = path.resolve(rootDir, '.state', 'connections.json');
    this.dbStore = dbStore ?? null;
    this.state = {
      settings: { ...DEFAULT_SETTINGS },
      tokenHash: null,
      readTokenHash: null,
      adminTokenHash: null,
      connections: DEFAULT_CONNECTIONS.map((c) => ({
        ...c,
        tagBindings: c.tagBindings.map((b) => ({ ...b })),
      })),
      updatedAt: new Date().toISOString(),
    };
  }

  async init(): Promise<void> {
    let parsed: Partial<PersistedConnectionsState> | null = null;
    try {
      if (this.dbStore?.isPostgresActive()) {
        parsed = await this.dbStore.getState<Partial<PersistedConnectionsState>>('connections_state');
      }
    } catch {
      // Fallback to local state file
    }

    if (!parsed) {
      try {
        const raw = await fs.readFile(this.stateFile, 'utf-8');
        parsed = JSON.parse(raw) as Partial<PersistedConnectionsState>;
      } catch {
        // Initial run without persisted connections file
      }
    }

    if (parsed) {
      if (parsed.settings) {
        this.state.settings = this.sanitizeSettings(parsed.settings, DEFAULT_SETTINGS);
      }
      if (typeof parsed.tokenHash === 'string' || parsed.tokenHash === null) {
        this.state.tokenHash = parsed.tokenHash ?? null;
      }
      if (typeof parsed.readTokenHash === 'string' || parsed.readTokenHash === null) {
        this.state.readTokenHash = parsed.readTokenHash ?? null;
      }
      if (typeof parsed.adminTokenHash === 'string' || parsed.adminTokenHash === null) {
        this.state.adminTokenHash = parsed.adminTokenHash ?? null;
      }
      if (Array.isArray(parsed.connections)) {
        this.state.connections = parsed.connections.map((c) => this.sanitizeConnection(c));
      }
      if (typeof parsed.updatedAt === 'string') {
        this.state.updatedAt = parsed.updatedAt;
      }
    }
  }

  private async persist(): Promise<void> {
    try {
      if (this.dbStore?.isPostgresActive()) {
        await this.dbStore.saveState('connections_state', this.state);
      }
    } catch {
      // Fall through to local atomic file mirror
    }
    try {
      await atomicWriteJson(this.stateFile, this.state, true);
    } catch {
      // Non-fatal in ephemeral containers
    }
  }

  getPublicState(): ConnectionsStateResponse {
    return {
      settings: { ...this.state.settings },
      connections: this.state.connections.map((c) => ({
        ...c,
        tagBindings: c.tagBindings.map((b) => ({ ...b })),
      })),
      updatedAt: this.state.updatedAt,
    };
  }

  private sanitizeSettings(
    raw: Partial<NetworkDeploymentSettings>,
    fallback: NetworkDeploymentSettings
  ): NetworkDeploymentSettings {
    const topologyMode: DeploymentTopology =
      raw.topologyMode === 'on-premise-lan' ||
      raw.topologyMode === 'site-to-site-vpn' ||
      raw.topologyMode === 'edge-gateway-push'
        ? raw.topologyMode
        : fallback.topologyMode;
    const spoolMaxMb = [256, 1024, 4096].includes(Number(raw.spoolMaxMb))
      ? (Number(raw.spoolMaxMb) as NetworkDeploymentSettings['spoolMaxMb'])
      : fallback.spoolMaxMb;

    return {
      topologyMode,
      siteName:
        typeof raw.siteName === 'string' && raw.siteName.trim()
          ? raw.siteName.trim().slice(0, 80)
          : fallback.siteName,
      plantVlanCidr:
        typeof raw.plantVlanCidr === 'string' && raw.plantVlanCidr.trim()
          ? raw.plantVlanCidr.trim().slice(0, 64)
          : fallback.plantVlanCidr,
      ingestApiUrl:
        typeof raw.ingestApiUrl === 'string' && raw.ingestApiUrl.trim()
          ? raw.ingestApiUrl.trim().slice(0, 200)
          : fallback.ingestApiUrl,
      requireGatewayToken:
        typeof raw.requireGatewayToken === 'boolean'
          ? raw.requireGatewayToken
          : fallback.requireGatewayToken,
      spoolMaxMb,
      tokenFingerprint: raw.tokenFingerprint ?? fallback.tokenFingerprint,
      tokenUpdatedAt: raw.tokenUpdatedAt ?? fallback.tokenUpdatedAt,
      readTokenFingerprint: raw.readTokenFingerprint ?? fallback.readTokenFingerprint ?? null,
      adminTokenFingerprint: raw.adminTokenFingerprint ?? fallback.adminTokenFingerprint ?? null,
    };
  }

  private sanitizeConnection(raw: Partial<PlcConnection>, existing?: PlcConnection): PlcConnection {
    const protocol: ConnectionProtocol =
      raw.protocol === 'opcua' ||
      raw.protocol === 'modbus-tcp' ||
      raw.protocol === 'mqtt-sparkplug' ||
      raw.protocol === 'http-rest-meter'
        ? raw.protocol
        : existing?.protocol ?? 'opcua';

    const deploymentTopology: DeploymentTopology =
      raw.deploymentTopology === 'on-premise-lan' ||
      raw.deploymentTopology === 'site-to-site-vpn' ||
      raw.deploymentTopology === 'edge-gateway-push'
        ? raw.deploymentTopology
        : existing?.deploymentTopology ?? this.state.settings.topologyMode;

    const authMode: ConnectionAuthMode =
      raw.authMode === 'anonymous' ||
      raw.authMode === 'username-password' ||
      raw.authMode === 'x509-cert' ||
      raw.authMode === 'bearer-token'
        ? raw.authMode
        : existing?.authMode ?? 'anonymous';

    const pollIntervalSec = [1, 2, 5, 10, 30].includes(Number(raw.pollIntervalSec))
      ? (Number(raw.pollIntervalSec) as PlcConnection['pollIntervalSec'])
      : existing?.pollIntervalSec ?? 5;

    const rawPort = Number(raw.port ?? existing?.port ?? defaultPortForProtocol(protocol));
    const port = Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535
      ? rawPort
      : defaultPortForProtocol(protocol);

    const machineType =
      typeof raw.machineType === 'string' && raw.machineType.trim()
        ? raw.machineType.trim().slice(0, 48)
        : existing?.machineType ?? 'plc-controller';

    const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : existing?.enabled ?? true;

    const tagBindings: TagBinding[] = Array.isArray(raw.tagBindings) && raw.tagBindings.length > 0
      ? raw.tagBindings.slice(0, 16).map((b) => ({
          sourceTag: String(b.sourceTag ?? '').trim().slice(0, 120) || 'tag_0',
          targetMetric: String(b.targetMetric ?? '').trim().slice(0, 48) || 'temp_c',
          scaleFactor: Number.isFinite(Number(b.scaleFactor)) && Number(b.scaleFactor) > 0
            ? Number(b.scaleFactor)
            : 1,
          unit: String(b.unit ?? '').trim().slice(0, 16) || '',
        }))
      : existing?.tagBindings ?? defaultTagBindingsForMachine(machineType, protocol);

    return {
      id: existing?.id ?? (typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `conn-${crypto.randomUUID().slice(0, 8)}`),
      name:
        typeof raw.name === 'string' && raw.name.trim()
          ? raw.name.trim().slice(0, 80)
          : existing?.name ?? 'Industrial Device',
      machineId:
        typeof raw.machineId === 'string' && raw.machineId.trim()
          ? raw.machineId.trim().slice(0, 32)
          : existing?.machineId ?? 'M-01',
      lineId:
        typeof raw.lineId === 'string' && raw.lineId.trim()
          ? raw.lineId.trim().slice(0, 32)
          : existing?.lineId ?? 'line-01',
      machineType,
      protocol,
      deploymentTopology,
      host:
        typeof raw.host === 'string' && raw.host.trim()
          ? raw.host.trim().slice(0, 128)
          : existing?.host ?? '192.168.10.10',
      port,
      endpointOrTopic:
        typeof raw.endpointOrTopic === 'string' && raw.endpointOrTopic.trim()
          ? raw.endpointOrTopic.trim().slice(0, 200)
          : existing?.endpointOrTopic ?? '/',
      pollIntervalSec,
      authMode,
      username:
        typeof raw.username === 'string' && raw.username.trim()
          ? raw.username.trim().slice(0, 64)
          : existing?.username,
      enabled,
      status: !enabled ? 'disabled' : existing?.status === 'disabled' ? 'configured' : existing?.status ?? 'configured',
      lastProbeAt: existing?.lastProbeAt ?? null,
      lastLatencyMs: existing?.lastLatencyMs ?? null,
      lastError: existing?.lastError ?? null,
      samplesIngested: existing?.samplesIngested ?? 0,
      tagBindings,
    };
  }

  async updateSettings(raw: Partial<NetworkDeploymentSettings>): Promise<ConnectionsStateResponse> {
    this.state.settings = this.sanitizeSettings(raw, this.state.settings);
    this.state.updatedAt = new Date().toISOString();
    await this.persist();
    return this.getPublicState();
  }

  async rotateScopedKey(scope: ApiAuthScope): Promise<{
    scope: ApiAuthScope;
    token: string;
    tokenFingerprint: string;
    tokenUpdatedAt: string;
    state: ConnectionsStateResponse;
  }> {
    const prefix = scope === 'admin' ? 'adm_live_' : scope === 'read' ? 'bi_live_' : 'gw_live_';
    const token = `${prefix}${crypto.randomBytes(24).toString('hex')}`;
    const tokenFingerprint = `${token.slice(0, 13)}...${token.slice(-4)}`;
    const nowIso = new Date().toISOString();
    const hashed = sha256Hex(token);

    if (scope === 'admin') {
      this.state.adminTokenHash = hashed;
      this.state.settings.adminTokenFingerprint = tokenFingerprint;
    } else if (scope === 'read') {
      this.state.readTokenHash = hashed;
      this.state.settings.readTokenFingerprint = tokenFingerprint;
    } else {
      this.state.tokenHash = hashed;
      this.state.settings.tokenFingerprint = tokenFingerprint;
    }
    this.state.settings.tokenUpdatedAt = nowIso;
    this.state.updatedAt = nowIso;
    await this.persist();
    return {
      scope,
      token,
      tokenFingerprint,
      tokenUpdatedAt: nowIso,
      state: this.getPublicState(),
    };
  }

  async rotateGatewayToken(): Promise<{
    token: string;
    tokenFingerprint: string;
    tokenUpdatedAt: string;
    state: ConnectionsStateResponse;
  }> {
    const rotated = await this.rotateScopedKey('edge');
    return {
      token: rotated.token,
      tokenFingerprint: rotated.tokenFingerprint,
      tokenUpdatedAt: rotated.tokenUpdatedAt,
      state: rotated.state,
    };
  }

  /** Always true in production; see `isApiAuthEnforced` for the non-production rules. */
  isAuthEnforced(): boolean {
    return isApiAuthEnforced(this.state.settings.requireGatewayToken);
  }

  resolveCredentialScope(candidate: string): ApiAuthScope | null {
    if (!candidate) return null;

    const envAdmin = process.env.API_ADMIN_TOKEN?.trim();
    if (envAdmin && timingSafeStringEqual(candidate, envAdmin)) return 'admin';
    if (this.state.adminTokenHash && timingSafeHashMatch(candidate, this.state.adminTokenHash)) {
      return 'admin';
    }

    const envRead = process.env.API_READ_TOKEN?.trim();
    if (envRead && timingSafeStringEqual(candidate, envRead)) return 'read';
    if (this.state.readTokenHash && timingSafeHashMatch(candidate, this.state.readTokenHash)) {
      return 'read';
    }

    const envEdge = process.env.EDGE_GATEWAY_TOKEN?.trim();
    if (envEdge && timingSafeStringEqual(candidate, envEdge)) return 'edge';
    if (this.state.tokenHash && timingSafeHashMatch(candidate, this.state.tokenHash)) {
      return 'edge';
    }

    return null;
  }

  authorizeRequest(
    requiredScope: ApiAuthScope,
    candidate: string
  ): { authorized: boolean; grantedScope: ApiAuthScope | 'anonymous'; enforced: boolean; reason?: string } {
    const enforced = this.isAuthEnforced();
    const matchedScope = this.resolveCredentialScope(candidate);

    // Always reject explicitly supplied invalid credentials (allows testing invalid tokens in Scalar even when enforcement is off)
    if (candidate && !matchedScope) {
      return {
        authorized: false,
        grantedScope: 'anonymous',
        enforced,
        reason: 'Invalid Bearer, X-API-Key, or X-Gateway-Token credential.',
      };
    }

    if (matchedScope) {
      const allowed =
        matchedScope === 'admin' ||
        matchedScope === requiredScope;
      if (!allowed) {
        return {
          authorized: false,
          grantedScope: matchedScope,
          enforced,
          reason: `Insufficient scope: credential has '${matchedScope}' but endpoint requires '${requiredScope}'.`,
        };
      }
      return { authorized: true, grantedScope: matchedScope, enforced };
    }

    if (!enforced) {
      return { authorized: true, grantedScope: 'anonymous', enforced: false };
    }

    return {
      authorized: false,
      grantedScope: 'anonymous',
      enforced: true,
      reason: `Missing credential (Authorization: Bearer <token> or X-API-Key) for '${requiredScope}' scope.`,
    };
  }

  isBatchTokenAuthorized(bearerHeader: string | undefined, altHeader: string | undefined): {
    authorized: boolean;
    reason?: string;
  } {
    const rawBearer = bearerHeader && /^Bearer\s+/i.test(bearerHeader)
      ? bearerHeader.replace(/^Bearer\s+/i, '').trim()
      : '';
    const candidate = rawBearer || (altHeader?.trim() ?? '');
    const res = this.authorizeRequest('edge', candidate);
    return { authorized: res.authorized, reason: res.reason };
  }

  async upsertConnection(raw: Partial<PlcConnection>): Promise<{
    connection: PlcConnection;
    state: ConnectionsStateResponse;
  }> {
    const existingIdx = raw.id
      ? this.state.connections.findIndex((c) => c.id === raw.id)
      : -1;
    const existing = existingIdx >= 0 ? this.state.connections[existingIdx] : undefined;
    const conn = this.sanitizeConnection(raw, existing);
    if (existingIdx >= 0) {
      this.state.connections[existingIdx] = conn;
    } else {
      this.state.connections.push(conn);
    }
    this.state.updatedAt = new Date().toISOString();
    await this.persist();
    return { connection: conn, state: this.getPublicState() };
  }

  async deleteConnection(connectionId: string): Promise<{ deleted: boolean; state: ConnectionsStateResponse }> {
    const before = this.state.connections.length;
    this.state.connections = this.state.connections.filter((c) => c.id !== connectionId);
    const deleted = this.state.connections.length < before;
    if (deleted) {
      this.state.updatedAt = new Date().toISOString();
      await this.persist();
    }
    return { deleted, state: this.getPublicState() };
  }

  getConnection(connectionId: string): PlcConnection | undefined {
    return this.state.connections.find((c) => c.id === connectionId);
  }

  async recordIngestedMachineCounts(machineCounts: Map<string, number>): Promise<void> {
    if (machineCounts.size === 0) return;
    const nowIso = new Date().toISOString();
    let changed = false;
    for (const conn of this.state.connections) {
      const inc = machineCounts.get(conn.machineId);
      if (inc && inc > 0) {
        conn.samplesIngested += inc;
        conn.lastProbeAt = nowIso;
        conn.lastError = null;
        if (conn.enabled) conn.status = 'connected';
        changed = true;
      }
    }
    if (changed) {
      this.state.updatedAt = nowIso;
      await this.persist();
    }
  }

  async probeConnection(connectionId: string): Promise<ConnectionProbeResult | null> {
    const conn = this.state.connections.find((c) => c.id === connectionId);
    if (!conn) return null;

    const checkedAt = new Date().toISOString();
    const startMs = Date.now();
    let reachable = false;
    let errorCode: string | null = null;
    let errorMessage: string | null = null;

    const hostCheck = await validateOutboundHost(conn.host);
    if (!hostCheck.allowed) {
      conn.lastProbeAt = checkedAt;
      conn.lastLatencyMs = null;
      conn.lastError = `SSRF_BLOCKED: ${hostCheck.reason}`;
      if (conn.enabled) conn.status = 'unreachable';
      this.state.updatedAt = checkedAt;
      await this.persist();
      return {
        connectionId: conn.id,
        reachable: false,
        protocol: conn.protocol,
        host: conn.host,
        port: conn.port,
        latencyMs: null,
        checkedAt,
        errorCode: 'SSRF_BLOCKED',
        errorMessage: hostCheck.reason ?? 'Target host blocked by SSRF policy.',
      };
    }

    if (conn.protocol === 'http-rest-meter') {
      try {
        const scheme = conn.port === 443 ? 'https' : 'http';
        const suffix = conn.endpointOrTopic.startsWith('/') ? conn.endpointOrTopic : `/${conn.endpointOrTopic}`;
        const url = `${scheme}://${conn.host}:${conn.port}${suffix}`;
        const resp = await fetch(url, {
          method: 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(2500),
        });
        reachable = resp.status < 500;
        if (!reachable) {
          errorCode = `HTTP_${resp.status}`;
          errorMessage = `Meter HTTP endpoint returned status ${resp.status}`;
        }
      } catch (err) {
        reachable = false;
        const msg = err instanceof Error ? err.message : 'HTTP probe failed';
        errorCode = msg.toLowerCase().includes('timeout') ? 'ETIMEDOUT' : 'ECONNREFUSED';
        errorMessage = msg;
      }
    } else {
      const tcpResult = await new Promise<{ ok: boolean; code: string | null; message: string | null }>(
        (resolve) => {
          // Connect to the address that passed the SSRF policy (no second DNS lookup).
          const socket = net.createConnection({ host: hostCheck.addresses[0], port: conn.port });
          let settled = false;
          const finish = (ok: boolean, code: string | null, message: string | null) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve({ ok, code, message });
          };
          socket.setTimeout(2500);
          socket.once('connect', () => finish(true, null, null));
          socket.once('timeout', () =>
            finish(false, 'ETIMEDOUT', `TCP timeout after 2500ms connecting to ${conn.host}:${conn.port}`)
          );
          socket.once('error', (err: NodeJS.ErrnoException) =>
            finish(false, err.code ?? 'TCP_ERROR', err.message)
          );
        }
      );
      reachable = tcpResult.ok;
      errorCode = tcpResult.code;
      errorMessage = tcpResult.message;
    }

    const latencyMs = Date.now() - startMs;
    conn.lastProbeAt = checkedAt;
    conn.lastLatencyMs = reachable ? latencyMs : null;
    conn.lastError = reachable ? null : `${errorCode ?? 'UNREACHABLE'}: ${errorMessage ?? 'Connection failed'}`;
    if (conn.enabled) {
      conn.status = reachable ? 'connected' : 'unreachable';
    }
    this.state.updatedAt = checkedAt;
    await this.persist();

    return {
      connectionId: conn.id,
      reachable,
      protocol: conn.protocol,
      host: conn.host,
      port: conn.port,
      latencyMs: reachable ? latencyMs : null,
      checkedAt,
      errorCode,
      errorMessage,
    };
  }

  getEdgeSyncConfig() {
    const activeConns = this.state.connections.filter((c) => c.enabled);
    const serializedConns = activeConns.map((c) => ({
      id: c.id,
      name: c.name,
      machine_id: c.machineId,
      line_id: c.lineId,
      machine_type: c.machineType,
      domain: resolveMachineSpec(c.machineType).domain,
      protocol: c.protocol,
      host: c.host,
      port: c.port,
      endpoint_or_topic: c.endpointOrTopic,
      poll_interval_sec: c.pollIntervalSec,
      auth_mode: c.authMode,
      tag_bindings: c.tagBindings.map((b) => ({
        source_tag: b.sourceTag,
        target_metric: b.targetMetric,
        scale_factor: b.scaleFactor,
        unit: b.unit,
      })),
    }));

    const basePayload = {
      site_name: this.state.settings.siteName,
      deployment_topology: this.state.settings.topologyMode,
      ingest_api_url: this.state.settings.ingestApiUrl,
      spool_max_mb: this.state.settings.spoolMaxMb,
      connections: serializedConns,
    };
    const configHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(basePayload))
      .digest('hex')
      .slice(0, 16);

    return {
      config_hash: configHash,
      updated_at: this.state.updatedAt,
      sync_interval_sec: 30,
      ...basePayload,
    };
  }

  buildDeployBundle(): OnPremDeployBundle {
    const syncConfig = this.getEdgeSyncConfig();
    const edgePayload = {
      ...syncConfig,
      spool_db_path: '/var/spool/edge-gateway/spool.db',
    };
    const configSyncUrl = this.state.settings.ingestApiUrl.replace(
      /\/api(?:\/v1)?\/ingest\/batch$/,
      '/api/v1/edge/config'
    );
    const healthUrl = this.state.settings.ingestApiUrl.replace(
      /\/api(?:\/v1)?\/ingest\/batch$/,
      '/api/v1/health'
    );

    const edgeEnvFile = [
      `# Edge Gateway Plug & Play Configuration — ${this.state.settings.siteName}`,
      `DEPLOYMENT_TOPOLOGY=${this.state.settings.topologyMode}`,
      `PLANT_VLAN_CIDR=${this.state.settings.plantVlanCidr}`,
      `EDGE_INGEST_URL=${this.state.settings.ingestApiUrl}`,
      `EDGE_CONFIG_URL=${configSyncUrl}`,
      `EDGE_CONFIG_SYNC_SEC=30`,
      `EDGE_CONNECTIONS_FILE=/etc/edge-gateway/connections.json`,
      `EDGE_SPOOL_DB=/var/spool/edge-gateway/spool.db`,
      `EDGE_SPOOL_MAX_MB=${this.state.settings.spoolMaxMb}`,
      `EDGE_BATCH_SIZE=200`,
      `EDGE_GATEWAY_TOKEN=${this.state.settings.requireGatewayToken ? '<PASTE_ROTATED_TOKEN>' : ''}`,
      `DATABASE_URL=postgres://mlops:change_me_onprem@postgres:5432/machine_logs`,
      `SMTP_HOST=mailpit`,
      `SMTP_PORT=1025`,
      `SMTP_FROM=alerts@telemetry.plant.local`,
      `MAILPIT_UI_URL=http://localhost:8025`,
    ].join('\n');

    /* eslint-disable no-template-curly-in-string */
    const onPremComposeYml = [
      '# On-Premise Corporate LAN Stack (OT/IT Plug & Play Plant Deployment + Mailpit SMTP)',
      'services:',
      '  postgres:',
      '    image: postgres:16-alpine',
      '    restart: unless-stopped',
      '    environment:',
      '      POSTGRES_USER: ${POSTGRES_USER:-mlops}',
      '      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-change_me_onprem}',
      '      POSTGRES_DB: ${POSTGRES_DB:-machine_logs}',
      '    ports:',
      '      - "5432:5432"',
      '    volumes:',
      '      - postgres_data:/var/lib/postgresql/data',
      '      - ./deploy/postgres/init.sql:/docker-entrypoint-initdb.d/01_init.sql:ro',
      '',
      '  mailpit:',
      '    image: axllent/mailpit:latest',
      '    restart: unless-stopped',
      '    ports:',
      '      - "1025:1025"',
      '      - "8025:8025"',
      '    environment:',
      '      MP_MAX_MESSAGES: "5000"',
      '      MP_SMTP_AUTH_ACCEPT_ANY: "1"',
      '      MP_SMTP_AUTH_ALLOW_INSECURE: "1"',
      '',
      '  garage-cold:',
      '    image: dxflrs/garage:v1.0.1',
      '    restart: unless-stopped',
      '    ports:',
      '      - "3900:3900"',
      '    volumes:',
      '      - garage_cold_data:/var/lib/garage/data',
      '',
      '  edge-gateway:',
      '    build:',
      '      context: ../../src',
      '      dockerfile: Dockerfile',
      '    restart: unless-stopped',
      '    network_mode: host',
      '    env_file:',
      '      - ./edge-gateway.env',
      '    command: ["python", "-m", "edge_gateway.collector", "--config", "/etc/edge-gateway/connections.json", "--config-url", "${EDGE_CONFIG_URL}", "--config-sync-sec", "30"]',
      '    volumes:',
      '      - ./connections.json:/etc/edge-gateway/connections.json:ro',
      '      - edge_spool:/var/spool/edge-gateway',
      '      - logs_data:/var/log/machines',
      '',
      'volumes:',
      '  postgres_data:',
      '  garage_cold_data:',
      '  edge_spool:',
      '  logs_data:',
    ].join('\n');
    /* eslint-enable no-template-curly-in-string */

    const installScriptSh = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `# On-Premise Installer for ${this.state.settings.siteName}`,
      `# OT Subnet: ${this.state.settings.plantVlanCidr}`,
      'mkdir -p /etc/edge-gateway /var/spool/edge-gateway',
      'cp ./connections.json /etc/edge-gateway/connections.json',
      'docker compose -f deploy/on-premise/docker-compose.onprem.yml up -d --build',
      `echo "Checking Ingest API health at ${healthUrl}..."`,
      `curl -fsS "${healthUrl}"`,
    ].join('\n');

    return {
      generatedAt: new Date().toISOString(),
      topologyMode: this.state.settings.topologyMode,
      edgeConnectionsJson: JSON.stringify(edgePayload, null, 2),
      edgeEnvFile,
      onPremComposeYml,
      installScriptSh,
    };
  }
}
