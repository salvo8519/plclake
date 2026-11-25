import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseStore } from './db.ts';
import {
  decryptSecret,
  encryptSecret,
  resolveSecretsMasterKey,
  sha256Hex,
  timingSafeHashMatch,
  timingSafeStringEqual,
  type ApiAuthScope,
} from './security.ts';
import { atomicWriteJson } from './utils/persistence.ts';
import {
  buildTokenLifecycleEvent,
  registerAuditLogTokenSubscriber,
  SecretManagementEventBus,
  type TokenLifecycleListener,
} from './secretManagementEvents.ts';
import type {
  ApiTokenPublic,
  ApiTokenScope,
  ApiTokenStatus,
  AppViewId,
  AuditLogEntry,
  RolePermissionPolicy,
  RolePermissionsMatrix,
  RolePermissionsResponse,
  SessionUserInfo,
  UserAccountPublic,
  UserRole,
} from './types/pipeline.ts';

export const ALL_APP_VIEWS: AppViewId[] = [
  'workbench',
  'fleet',
  'connections',
  'plc_catalog',
  'job_config',
  'notifications',
  'users',
  'roles',
  'tokens',
  'audit',
];

const VALID_VIEW_SET = new Set<string>(ALL_APP_VIEWS);

export const ADMIN_FULL_POLICY: RolePermissionPolicy = {
  allowedViews: [...ALL_APP_VIEWS],
  canControlSimulation: true,
  canWriteConfig: true,
  canManageAlerts: true,
  canManageUsers: true,
};

export const DEFAULT_ROLE_PERMISSIONS: RolePermissionsMatrix = {
  admin: {
    ...ADMIN_FULL_POLICY,
    allowedViews: [...ALL_APP_VIEWS],
  },
  operator: {
    allowedViews: ['workbench', 'fleet', 'connections', 'plc_catalog', 'notifications', 'audit'],
    canControlSimulation: true,
    canWriteConfig: false,
    canManageAlerts: true,
    canManageUsers: false,
  },
  viewer: {
    allowedViews: ['workbench', 'fleet', 'plc_catalog', 'audit'],
    canControlSimulation: false,
    canWriteConfig: false,
    canManageAlerts: false,
    canManageUsers: false,
  },
};

function clonePolicy(p: RolePermissionPolicy): RolePermissionPolicy {
  return {
    allowedViews: [...p.allowedViews],
    canControlSimulation: Boolean(p.canControlSimulation),
    canWriteConfig: Boolean(p.canWriteConfig),
    canManageAlerts: Boolean(p.canManageAlerts),
    canManageUsers: Boolean(p.canManageUsers),
  };
}

function sanitizeRolePolicy(
  input: Partial<RolePermissionPolicy> | undefined,
  fallback: RolePermissionPolicy
): RolePermissionPolicy {
  if (!input || typeof input !== 'object') {
    return clonePolicy(fallback);
  }
  const rawViews = Array.isArray(input.allowedViews)
    ? input.allowedViews.filter((v): v is AppViewId => typeof v === 'string' && VALID_VIEW_SET.has(v))
    : fallback.allowedViews;
  const dedupedViews = Array.from(new Set(rawViews));
  return {
    allowedViews: dedupedViews.length > 0 ? dedupedViews : ['workbench'],
    canControlSimulation:
      typeof input.canControlSimulation === 'boolean'
        ? input.canControlSimulation
        : fallback.canControlSimulation,
    canWriteConfig:
      typeof input.canWriteConfig === 'boolean' ? input.canWriteConfig : fallback.canWriteConfig,
    canManageAlerts:
      typeof input.canManageAlerts === 'boolean'
        ? input.canManageAlerts
        : fallback.canManageAlerts,
    canManageUsers:
      typeof input.canManageUsers === 'boolean' ? input.canManageUsers : fallback.canManageUsers,
  };
}

interface StoredUserAccount extends UserAccountPublic {
  passwordHash: string;
  passwordSalt: string;
}

interface ActiveSession {
  tokenHash: string;
  userId: string;
  expiresAtMs: number;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_LOCAL_AUDIT_ENTRIES = 2000;

function hashPasswordScrypt(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function sha256(val: string): string {
  return crypto.createHash('sha256').update(val).digest('hex');
}

function toPublicUser(u: StoredUserAccount): UserAccountPublic {
  return {
    id: u.id,
    email: u.email,
    fullName: u.fullName,
    role: u.role,
    active: u.active,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
  };
}

export function roleToApiScope(role: UserRole): ApiAuthScope {
  if (role === 'admin') return 'admin';
  if (role === 'operator') return 'admin';
  return 'read';
}

interface StoredApiToken {
  id: string;
  name: string;
  description: string;
  tokenPrefix: string;
  /** AES-256-GCM encrypted SHA-256 digest (`enc:v1:...`) — plaintext token is never stored. */
  tokenHashEncrypted: string;
  scopes: ApiTokenScope[];
  ownerUserId: string;
  ownerEmail: string;
  ownerRole: UserRole;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  ttlHours: number | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  usageCount: number;
  revokedAt: string | null;
  revokedBy: string | null;
  revokedReason: string | null;
  isSandbox: boolean;
}

interface RuntimeApiToken extends StoredApiToken {
  /** Decrypted SHA-256 digest kept strictly in memory for constant-time verification. */
  tokenHashRuntime: string;
}

export interface ResolvedApiTokenResult {
  authorized: boolean;
  deniedReason?: 'invalid' | 'revoked' | 'expired' | 'owner_disabled';
  record?: ApiTokenPublic;
  scopes?: ApiTokenScope[];
  ownerUser?: SessionUserInfo;
}

const VALID_TOKEN_SCOPES = new Set<ApiTokenScope>(['read', 'edge', 'admin']);
const EXPIRING_SOON_MS = 7 * 24 * 60 * 60 * 1000;

function computeTokenStatus(tok: StoredApiToken, nowMs = Date.now()): ApiTokenStatus {
  if (tok.revokedAt) return 'revoked';
  if (tok.expiresAt) {
    const expMs = Date.parse(tok.expiresAt);
    if (Number.isFinite(expMs)) {
      if (nowMs >= expMs) return 'expired';
      if (expMs - nowMs <= EXPIRING_SOON_MS) return 'expiring_soon';
    }
  }
  return 'active';
}

function toPublicApiToken(tok: StoredApiToken): ApiTokenPublic {
  return {
    id: tok.id,
    name: tok.name,
    description: tok.description,
    tokenPrefix: tok.tokenPrefix,
    scopes: [...tok.scopes],
    ownerUserId: tok.ownerUserId,
    ownerEmail: tok.ownerEmail,
    ownerRole: tok.ownerRole,
    createdBy: tok.createdBy,
    createdAt: tok.createdAt,
    expiresAt: tok.expiresAt,
    lastUsedAt: tok.lastUsedAt,
    lastUsedIp: tok.lastUsedIp,
    usageCount: tok.usageCount,
    revokedAt: tok.revokedAt,
    revokedBy: tok.revokedBy,
    revokedReason: tok.revokedReason,
    isSandbox: tok.isSandbox,
    status: computeTokenStatus(tok),
  };
}

function stripRuntimeToken(tok: RuntimeApiToken): StoredApiToken {
  const { tokenHashRuntime: _omitted, ...stored } = tok;
  return stored;
}

export class AuthAuditManager {
  private rootDir: string;
  private usersFile: string;
  private auditFile: string;
  private rolePermissionsFile: string;
  private apiTokensFile: string;
  private dbStore: DatabaseStore | null;
  private masterKey: Buffer = crypto.randomBytes(32);
  private users: StoredUserAccount[] = [];
  private apiTokens: RuntimeApiToken[] = [];
  private lastTokenUsagePersistMs = 0;
  private auditLogs: AuditLogEntry[] = [];
  private rolePermissions: RolePermissionsMatrix = {
    admin: clonePolicy(DEFAULT_ROLE_PERMISSIONS.admin),
    operator: clonePolicy(DEFAULT_ROLE_PERMISSIONS.operator),
    viewer: clonePolicy(DEFAULT_ROLE_PERMISSIONS.viewer),
  };
  private rolePermissionsUpdatedAt = new Date().toISOString();
  private sessions = new Map<string, ActiveSession>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly secretEventBus = new SecretManagementEventBus();

  constructor(rootDir: string, dbStore?: DatabaseStore) {
    this.rootDir = rootDir;
    this.usersFile = path.resolve(rootDir, '.state', 'users.json');
    this.auditFile = path.resolve(rootDir, '.state', 'audit-log.json');
    this.rolePermissionsFile = path.resolve(rootDir, '.state', 'role-permissions.json');
    this.apiTokensFile = path.resolve(rootDir, '.state', 'api-tokens.json');
    this.dbStore = dbStore ?? null;

    // Automated SecretManagement -> AuditLogSystem subscriber for all token lifecycle events
    registerAuditLogTokenSubscriber(this.secretEventBus, this);
  }

  getSecretEventBus(): SecretManagementEventBus {
    return this.secretEventBus;
  }

  subscribeTokenLifecycle(listener: TokenLifecycleListener): () => void {
    return this.secretEventBus.subscribe(listener);
  }

  async init(): Promise<void> {
    this.masterKey = await resolveSecretsMasterKey(this.rootDir);
    await this.loadUsers();
    await this.loadAuditLogs();
    await this.loadRolePermissions();
    await this.loadApiTokens();

    if (this.users.length === 0) {
      const now = new Date().toISOString();
      const adminEmail = (process.env.AUTH_ADMIN_EMAIL || 'admin@plant.local').trim().toLowerCase();
      const adminPass = process.env.AUTH_ADMIN_PASSWORD || 'AdminPlant2026!';
      const adminSalt = crypto.randomBytes(16).toString('hex');

      const opSalt = crypto.randomBytes(16).toString('hex');
      const viewerSalt = crypto.randomBytes(16).toString('hex');

      this.users = [
        {
          id: 'usr-admin',
          email: adminEmail,
          fullName: 'Plant Administrator',
          role: 'admin',
          active: true,
          createdAt: now,
          lastLoginAt: null,
          passwordSalt: adminSalt,
          passwordHash: hashPasswordScrypt(adminPass, adminSalt),
        },
        {
          id: 'usr-operator',
          email: 'operator@plant.local',
          fullName: 'Shift Line Operator',
          role: 'operator',
          active: true,
          createdAt: now,
          lastLoginAt: null,
          passwordSalt: opSalt,
          passwordHash: hashPasswordScrypt('OperatorPlant2026!', opSalt),
        },
        {
          id: 'usr-viewer',
          email: 'controller@plant.local',
          fullName: 'BI & Controllo Gestione',
          role: 'viewer',
          active: true,
          createdAt: now,
          lastLoginAt: null,
          passwordSalt: viewerSalt,
          passwordHash: hashPasswordScrypt('ViewerPlant2026!', viewerSalt),
        },
      ];
      await this.persistUsers();
    }
  }

  private async loadUsers(): Promise<void> {
    let loaded: StoredUserAccount[] | null = null;
    try {
      if (this.dbStore?.isPostgresActive()) {
        loaded = await this.dbStore.getState<StoredUserAccount[]>('auth_users');
      }
    } catch {
      // Fallback to local file
    }
    if (!loaded) {
      try {
        const raw = await fs.readFile(this.usersFile, 'utf-8');
        const parsed = JSON.parse(raw) as StoredUserAccount[];
        if (Array.isArray(parsed)) loaded = parsed;
      } catch {
        // Fresh workspace
      }
    }
    if (Array.isArray(loaded) && loaded.length > 0) {
      this.users = loaded;
    }
  }

  private async persistUsers(): Promise<void> {
    try {
      if (this.dbStore?.isPostgresActive()) {
        await this.dbStore.saveState('auth_users', this.users);
      }
    } catch {
      // Mirror to local atomic file
    }
    try {
      await atomicWriteJson(this.usersFile, this.users, true, 0o600);
    } catch {
      // Non-fatal in ephemeral containers
    }
  }

  private async loadAuditLogs(): Promise<void> {
    try {
      const raw = await fs.readFile(this.auditFile, 'utf-8');
      const parsed = JSON.parse(raw) as AuditLogEntry[];
      if (Array.isArray(parsed)) {
        this.auditLogs = parsed.slice(0, MAX_LOCAL_AUDIT_ENTRIES);
      }
    } catch {
      this.auditLogs = [];
    }
  }

  private async persistAuditLogs(): Promise<void> {
    try {
      await atomicWriteJson(this.auditFile, this.auditLogs.slice(0, MAX_LOCAL_AUDIT_ENTRIES), false);
    } catch {
      // Non-fatal in ephemeral containers
    }
  }

  private async loadRolePermissions(): Promise<void> {
    let loaded: { matrix?: Partial<RolePermissionsMatrix>; updatedAt?: string } | null = null;
    try {
      if (this.dbStore?.isPostgresActive()) {
        loaded = await this.dbStore.getState<{
          matrix?: Partial<RolePermissionsMatrix>;
          updatedAt?: string;
        }>('role_permissions');
      }
    } catch {
      // Fallback to file
    }
    if (!loaded) {
      try {
        const raw = await fs.readFile(this.rolePermissionsFile, 'utf-8');
        loaded = JSON.parse(raw) as {
          matrix?: Partial<RolePermissionsMatrix>;
          updatedAt?: string;
        };
      } catch {
        // Use defaults
      }
    }
    if (loaded?.matrix) {
      this.rolePermissions = {
        admin: clonePolicy(ADMIN_FULL_POLICY),
        operator: sanitizeRolePolicy(loaded.matrix.operator, DEFAULT_ROLE_PERMISSIONS.operator),
        viewer: sanitizeRolePolicy(loaded.matrix.viewer, DEFAULT_ROLE_PERMISSIONS.viewer),
      };
      if (loaded.updatedAt) {
        this.rolePermissionsUpdatedAt = loaded.updatedAt;
      }
    }
  }

  private async persistRolePermissions(): Promise<void> {
    const payload: RolePermissionsResponse = {
      matrix: this.getRolePermissions().matrix,
      updatedAt: this.rolePermissionsUpdatedAt,
    };
    try {
      if (this.dbStore?.isPostgresActive()) {
        await this.dbStore.saveState('role_permissions', payload);
      }
    } catch {
      // Fallback to file
    }
    try {
      await atomicWriteJson(this.rolePermissionsFile, payload, true);
    } catch {
      // Non-fatal in ephemeral containers
    }
  }

  getRolePermissions(): RolePermissionsResponse {
    return {
      matrix: {
        admin: clonePolicy(ADMIN_FULL_POLICY),
        operator: clonePolicy(this.rolePermissions.operator),
        viewer: clonePolicy(this.rolePermissions.viewer),
      },
      updatedAt: this.rolePermissionsUpdatedAt,
    };
  }

  getPermissionsForRole(role: UserRole): RolePermissionPolicy {
    if (role === 'admin') return clonePolicy(ADMIN_FULL_POLICY);
    if (role === 'operator') return clonePolicy(this.rolePermissions.operator);
    return clonePolicy(this.rolePermissions.viewer);
  }

  async updateRolePermissions(
    patch: Partial<Record<UserRole, Partial<RolePermissionPolicy>>>
  ): Promise<RolePermissionsResponse> {
    this.rolePermissions = {
      admin: clonePolicy(ADMIN_FULL_POLICY),
      operator: sanitizeRolePolicy(patch.operator, this.rolePermissions.operator),
      viewer: sanitizeRolePolicy(patch.viewer, this.rolePermissions.viewer),
    };
    this.rolePermissionsUpdatedAt = new Date().toISOString();
    await this.persistRolePermissions();
    return this.getRolePermissions();
  }

  listUsers(): UserAccountPublic[] {
    return this.users.map(toPublicUser);
  }

  async createUser(input: {
    email: string;
    fullName: string;
    role: UserRole;
    password: string;
  }): Promise<UserAccountPublic> {
    const email = input.email.trim().toLowerCase();
    if (!email || !email.includes('@')) {
      throw new Error('Valid email address is required.');
    }
    if (!input.password || input.password.length < 8) {
      throw new Error('Password must be at least 8 characters long.');
    }
    if (this.users.some((u) => u.email === email)) {
      throw new Error(`User with email '${email}' already exists.`);
    }
    const role: UserRole =
      input.role === 'admin' || input.role === 'operator' || input.role === 'viewer'
        ? input.role
        : 'viewer';
    const salt = crypto.randomBytes(16).toString('hex');
    const created: StoredUserAccount = {
      id: `usr-${crypto.randomUUID().slice(0, 8)}`,
      email,
      fullName: input.fullName.trim().slice(0, 80) || email.split('@')[0],
      role,
      active: true,
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
      passwordSalt: salt,
      passwordHash: hashPasswordScrypt(input.password, salt),
    };
    this.users.push(created);
    await this.persistUsers();
    return toPublicUser(created);
  }

  async updateUser(
    userId: string,
    patch: { role?: UserRole; active?: boolean; password?: string; fullName?: string },
    context?: { actor?: string; actorRole?: string; requestId?: string }
  ): Promise<UserAccountPublic | null> {
    const target = this.users.find((u) => u.id === userId);
    if (!target) return null;

    const cascadeRevokedTokens: ApiTokenPublic[] = [];

    if (patch.role === 'admin' || patch.role === 'operator' || patch.role === 'viewer') {
      target.role = patch.role;
    }
    if (typeof patch.active === 'boolean') {
      target.active = patch.active;
      if (!target.active) {
        // Revoke active sessions and managed API keys for disabled user
        for (const [key, sess] of this.sessions.entries()) {
          if (sess.userId === target.id) this.sessions.delete(key);
        }
        const revokedAt = new Date().toISOString();
        const revokedBy = context?.actor || 'system:user-disabled';
        for (const tok of this.apiTokens) {
          if (tok.ownerUserId === target.id && !tok.revokedAt) {
            tok.revokedAt = revokedAt;
            tok.revokedBy = revokedBy;
            tok.revokedReason = 'owner_account_disabled';
            cascadeRevokedTokens.push(toPublicApiToken(tok));
          }
        }
        if (cascadeRevokedTokens.length > 0) {
          await this.persistApiTokens();
        }
      }
    }
    if (typeof patch.fullName === 'string' && patch.fullName.trim()) {
      target.fullName = patch.fullName.trim().slice(0, 80);
    }
    if (typeof patch.password === 'string' && patch.password.length >= 8) {
      const salt = crypto.randomBytes(16).toString('hex');
      target.passwordSalt = salt;
      target.passwordHash = hashPasswordScrypt(patch.password, salt);
    }
    await this.persistUsers();

    // Emit automated token.revoked events for every cascade-revoked key
    for (const revokedRecord of cascadeRevokedTokens) {
      await this.secretEventBus.publish(
        buildTokenLifecycleEvent({
          type: 'token.revoked',
          record: revokedRecord,
          actor: context?.actor || 'system:user-disabled',
          actorRole: context?.actorRole || 'system',
          requestId: context?.requestId,
          reason: 'owner_account_disabled',
        })
      );
    }

    return toPublicUser(target);
  }

  async authenticateLogin(
    emailInput: string,
    password: string
  ): Promise<{ token: string; user: UserAccountPublic; expiresAt: string } | null> {
    const email = emailInput.trim().toLowerCase();
    const user = this.users.find((u) => u.email === email && u.active);
    if (!user) return null;

    const candidateHash = hashPasswordScrypt(password, user.passwordSalt);
    if (!timingSafeStringEqual(candidateHash, user.passwordHash)) {
      return null;
    }

    const token = `sess_${crypto.randomBytes(24).toString('hex')}`;
    const tokenHash = sha256(token);
    const expiresAtMs = Date.now() + SESSION_TTL_MS;
    this.sessions.set(tokenHash, { tokenHash, userId: user.id, expiresAtMs });

    user.lastLoginAt = new Date().toISOString();
    await this.persistUsers();

    return {
      token,
      user: toPublicUser(user),
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  revokeSessionToken(token: string): boolean {
    if (!token.startsWith('sess_')) return false;
    return this.sessions.delete(sha256(token));
  }

  resolveSessionToken(token: string): SessionUserInfo | null {
    if (!token || !token.startsWith('sess_')) return null;
    const tokenHash = sha256(token);
    const sess = this.sessions.get(tokenHash);
    if (!sess) return null;
    if (Date.now() > sess.expiresAtMs) {
      this.sessions.delete(tokenHash);
      return null;
    }
    const user = this.users.find((u) => u.id === sess.userId && u.active);
    if (!user) {
      this.sessions.delete(tokenHash);
      return null;
    }
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      authSource: 'session',
    };
  }

  resolveOidcProxyHeaders(headers: Record<string, string | string[] | undefined>): SessionUserInfo | null {
    if (process.env.TRUST_PROXY_AUTH_HEADERS !== 'true') return null;
    const emailRaw = headers['x-auth-request-email'] || headers['x-forwarded-email'];
    const email = Array.isArray(emailRaw) ? emailRaw[0] : emailRaw;
    if (!email || !email.includes('@')) return null;

    const normalized = email.trim().toLowerCase();
    const matched = this.users.find((u) => u.email === normalized && u.active);
    if (matched) {
      return {
        id: matched.id,
        email: matched.email,
        fullName: matched.fullName,
        role: matched.role,
        authSource: 'oidc-proxy',
      };
    }
    return {
      id: `oidc-${sha256(normalized).slice(0, 8)}`,
      email: normalized,
      fullName: normalized.split('@')[0],
      role: 'viewer',
      authSource: 'oidc-proxy',
    };
  }

  /**
   * Registers a background persistence operation so `flush()` can await it.
   * Callers that cannot await (response `finish` hooks, hot auth paths) must go
   * through here instead of a bare `void` to avoid losing writes on shutdown.
   */
  private track<T>(operation: Promise<T>): Promise<T> {
    this.inFlight.add(operation);
    operation
      .finally(() => this.inFlight.delete(operation))
      .catch(() => undefined);
    return operation;
  }

  /** Resolves once every tracked audit / token persistence operation has settled. */
  async flush(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  recordAudit(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>): Promise<AuditLogEntry> {
    return this.track(this.writeAuditEntry(entry));
  }

  private async writeAuditEntry(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>): Promise<AuditLogEntry> {
    const fullEntry: AuditLogEntry = {
      id: `aud-${crypto.randomUUID().slice(0, 12)}`,
      timestamp: new Date().toISOString(),
      ...entry,
    };

    this.auditLogs.unshift(fullEntry);
    if (this.auditLogs.length > MAX_LOCAL_AUDIT_ENTRIES) {
      this.auditLogs.length = MAX_LOCAL_AUDIT_ENTRIES;
    }

    try {
      if (this.dbStore?.isPostgresActive()) {
        await this.dbStore.insertAuditLog(fullEntry);
      }
    } catch {
      // Non-fatal fallback to file audit log
    }
    await this.persistAuditLogs();
    return fullEntry;
  }

  async queryAuditLogs(filters?: {
    action?: string;
    actor?: string;
    status?: string;
    limit?: number;
  }): Promise<AuditLogEntry[]> {
    const limit = Math.min(Math.max(1, Number(filters?.limit) || 100), 500);
    if (this.dbStore?.isPostgresActive()) {
      try {
        const pgRows = await this.dbStore.queryAuditLogs({ ...filters, limit });
        if (pgRows.length > 0) return pgRows;
      } catch {
        // Fallback to in-memory/file entries
      }
    }

    let items = this.auditLogs;
    if (filters?.action) {
      const q = filters.action.trim().toLowerCase();
      items = items.filter((e) => e.action.toLowerCase().includes(q));
    }
    if (filters?.actor) {
      const q = filters.actor.trim().toLowerCase();
      items = items.filter((e) => e.actor.toLowerCase().includes(q));
    }
    if (filters?.status) {
      items = items.filter((e) => e.status === filters.status);
    }
    return items.slice(0, limit);
  }

  private async loadApiTokens(): Promise<void> {
    let loaded: StoredApiToken[] | null = null;
    try {
      if (this.dbStore?.isPostgresActive()) {
        loaded = await this.dbStore.getState<StoredApiToken[]>('api_tokens');
      }
    } catch {
      // Fallback to local file
    }
    if (!loaded) {
      try {
        const raw = await fs.readFile(this.apiTokensFile, 'utf-8');
        const parsed = JSON.parse(raw) as StoredApiToken[];
        if (Array.isArray(parsed)) loaded = parsed;
      } catch {
        // Fresh workspace
      }
    }
    if (!Array.isArray(loaded)) {
      this.apiTokens = [];
      return;
    }

    const hydrated: RuntimeApiToken[] = [];
    for (const item of loaded) {
      if (!item || typeof item.tokenHashEncrypted !== 'string') continue;
      try {
        const decryptedHash = decryptSecret(item.tokenHashEncrypted, this.masterKey);
        if (/^[0-9a-f]{64}$/i.test(decryptedHash)) {
          hydrated.push({
            ...item,
            tokenHashRuntime: decryptedHash,
          });
        }
      } catch {
        // Skip records encrypted with an unreadable/corrupted key
      }
    }
    this.apiTokens = hydrated;
  }

  private async persistApiTokens(): Promise<void> {
    const serialized = this.apiTokens.map(stripRuntimeToken);
    try {
      if (this.dbStore?.isPostgresActive()) {
        await this.dbStore.saveState('api_tokens', serialized);
      }
    } catch {
      // Mirror to local atomic file
    }
    try {
      await atomicWriteJson(this.apiTokensFile, serialized, true, 0o600);
    } catch {
      // Non-fatal in ephemeral containers
    }
  }

  listApiTokens(): {
    tokens: ApiTokenPublic[];
    summary: {
      total: number;
      active: number;
      expiringSoon: number;
      revokedOrExpired: number;
      totalUsageCount: number;
    };
  } {
    const tokens = this.apiTokens
      .map(toPublicApiToken)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

    let active = 0;
    let expiringSoon = 0;
    let revokedOrExpired = 0;
    let totalUsageCount = 0;

    for (const t of tokens) {
      totalUsageCount += t.usageCount;
      if (t.status === 'active') active += 1;
      else if (t.status === 'expiring_soon') {
        active += 1;
        expiringSoon += 1;
      } else {
        revokedOrExpired += 1;
      }
    }

    return {
      tokens,
      summary: {
        total: tokens.length,
        active,
        expiringSoon,
        revokedOrExpired,
        totalUsageCount,
      },
    };
  }

  async issueApiToken(input: {
    name: string;
    description?: string;
    scopes: ApiTokenScope[];
    ownerUserId?: string;
    ownerEmail?: string;
    createdBy: string;
    actorRole?: string;
    requestId?: string;
    ttlHours?: number | null;
    isSandbox?: boolean;
    suppressCreatedEvent?: boolean;
  }): Promise<{ token: string; record: ApiTokenPublic }> {
    const cleanName = input.name.trim().slice(0, 80);
    if (!cleanName) {
      throw new Error('Token name is required.');
    }

    const sanitizedScopes = Array.from(
      new Set(
        (Array.isArray(input.scopes) ? input.scopes : []).filter((s): s is ApiTokenScope =>
          VALID_TOKEN_SCOPES.has(s)
        )
      )
    );
    if (sanitizedScopes.length === 0) {
      throw new Error('At least one valid scope (read, edge, or admin) is required.');
    }

    let owner = input.ownerUserId
      ? this.users.find((u) => u.id === input.ownerUserId)
      : undefined;
    if (!owner && input.ownerEmail) {
      const normEmail = input.ownerEmail.trim().toLowerCase();
      owner = this.users.find((u) => u.email === normEmail);
    }
    if (!owner) {
      owner = this.users.find((u) => u.role === 'admin' && u.active) ?? this.users[0];
    }
    if (!owner || !owner.active) {
      throw new Error('Target owner account does not exist or is disabled.');
    }

    const ttlHours =
      input.ttlHours === null
        ? null
        : typeof input.ttlHours === 'number' && Number.isFinite(input.ttlHours) && input.ttlHours > 0
        ? Math.min(input.ttlHours, 24 * 365 * 2)
        : 24 * 30;

    const nowMs = Date.now();
    const createdAt = new Date(nowMs).toISOString();
    const expiresAt = ttlHours !== null ? new Date(nowMs + ttlHours * 3600_000).toISOString() : null;

    const rawSecret = crypto.randomBytes(24).toString('hex');
    const rawToken = `pat_live_${rawSecret}`;
    const tokenPrefix = `pat_live_${rawSecret.slice(0, 6)}...${rawSecret.slice(-4)}`;
    const digest = sha256Hex(rawToken);
    const encryptedDigest = encryptSecret(digest, this.masterKey);

    const runtimeRecord: RuntimeApiToken = {
      id: `tok-${crypto.randomUUID().slice(0, 10)}`,
      name: cleanName,
      description: (input.description ?? '').trim().slice(0, 240),
      tokenPrefix,
      tokenHashEncrypted: encryptedDigest,
      tokenHashRuntime: digest,
      scopes: sanitizedScopes,
      ownerUserId: owner.id,
      ownerEmail: owner.email,
      ownerRole: owner.role,
      createdBy: input.createdBy,
      createdAt,
      expiresAt,
      ttlHours,
      lastUsedAt: null,
      lastUsedIp: null,
      usageCount: 0,
      revokedAt: null,
      revokedBy: null,
      revokedReason: null,
      isSandbox: Boolean(input.isSandbox),
    };

    this.apiTokens.unshift(runtimeRecord);
    await this.persistApiTokens();

    const publicRecord = toPublicApiToken(runtimeRecord);
    if (!input.suppressCreatedEvent) {
      await this.secretEventBus.publish(
        buildTokenLifecycleEvent({
          type: 'token.created',
          record: publicRecord,
          actor: input.createdBy,
          actorRole: input.actorRole || owner.role,
          requestId: input.requestId,
        })
      );
    }

    return {
      token: rawToken,
      record: publicRecord,
    };
  }

  async rotateApiToken(
    tokenId: string,
    actor: string,
    context?: { actorRole?: string; requestId?: string }
  ): Promise<{ token: string; record: ApiTokenPublic; previousId: string } | null> {
    const existing = this.apiTokens.find((t) => t.id === tokenId);
    if (!existing) return null;

    if (!existing.revokedAt) {
      existing.revokedAt = new Date().toISOString();
      existing.revokedBy = actor;
      existing.revokedReason = 'rotated';
    }

    const issued = await this.issueApiToken({
      name: existing.name,
      description: existing.description,
      scopes: [...existing.scopes],
      ownerUserId: existing.ownerUserId,
      createdBy: actor,
      actorRole: context?.actorRole,
      requestId: context?.requestId,
      ttlHours: existing.ttlHours,
      isSandbox: existing.isSandbox,
      suppressCreatedEvent: true,
    });

    await this.secretEventBus.publish(
      buildTokenLifecycleEvent({
        type: 'token.rotated',
        record: issued.record,
        actor,
        actorRole: context?.actorRole || 'admin',
        requestId: context?.requestId,
        previousTokenId: existing.id,
        reason: 'rotated',
      })
    );

    return {
      ...issued,
      previousId: existing.id,
    };
  }

  async revokeApiToken(
    tokenId: string,
    revokedBy: string,
    reason = 'manual_revocation',
    context?: { actorRole?: string; requestId?: string }
  ): Promise<ApiTokenPublic | null> {
    const existing = this.apiTokens.find((t) => t.id === tokenId);
    if (!existing) return null;
    const wasActive = !existing.revokedAt;
    if (wasActive) {
      existing.revokedAt = new Date().toISOString();
      existing.revokedBy = revokedBy;
      existing.revokedReason = reason;
      await this.persistApiTokens();
    }

    const publicRecord = toPublicApiToken(existing);
    if (wasActive) {
      await this.secretEventBus.publish(
        buildTokenLifecycleEvent({
          type: 'token.revoked',
          record: publicRecord,
          actor: revokedBy,
          actorRole: context?.actorRole || 'admin',
          requestId: context?.requestId,
          reason,
        })
      );
    }

    return publicRecord;
  }

  resolveApiToken(rawToken: string, clientIp?: string): ResolvedApiTokenResult {
    if (!rawToken || !rawToken.startsWith('pat_live_')) {
      return { authorized: false, deniedReason: 'invalid' };
    }

    let matched: RuntimeApiToken | null = null;
    for (const candidate of this.apiTokens) {
      if (timingSafeHashMatch(rawToken, candidate.tokenHashRuntime)) {
        matched = candidate;
        break;
      }
    }

    if (!matched) {
      return { authorized: false, deniedReason: 'invalid' };
    }
    if (matched.revokedAt) {
      return { authorized: false, deniedReason: 'revoked', record: toPublicApiToken(matched) };
    }
    if (matched.expiresAt && Date.now() >= Date.parse(matched.expiresAt)) {
      return { authorized: false, deniedReason: 'expired', record: toPublicApiToken(matched) };
    }

    const owner = this.users.find((u) => u.id === matched.ownerUserId);
    if (!owner || !owner.active) {
      return { authorized: false, deniedReason: 'owner_disabled', record: toPublicApiToken(matched) };
    }

    matched.usageCount += 1;
    matched.lastUsedAt = new Date().toISOString();
    if (clientIp) {
      matched.lastUsedIp = clientIp.slice(0, 64);
    }

    const nowMs = Date.now();
    if (matched.usageCount === 1 || nowMs - this.lastTokenUsagePersistMs > 5_000) {
      this.lastTokenUsagePersistMs = nowMs;
      void this.track(this.persistApiTokens());
    }

    return {
      authorized: true,
      record: toPublicApiToken(matched),
      scopes: [...matched.scopes],
      ownerUser: {
        id: owner.id,
        email: owner.email,
        fullName: owner.fullName,
        role: owner.role,
        authSource: 'session',
      },
    };
  }
}
