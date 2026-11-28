import type { Router } from 'express';
import { ADMIN_FULL_POLICY, roleToApiScope } from '../../authAudit.ts';
import { logger } from '../../logger.ts';
import { type ApiAuthScope, extractRequestCredential } from '../../security.ts';
import { sanitizeCsvCell } from '../../utils/persistence.ts';
import { getRequestContext } from '../requestInput.ts';
import type { HttpContext } from '../context.ts';

/** Identity and access: login and sessions, roles, users, managed API tokens and the audit log. */
export function registerAuthRoutes(apiRouter: Router, ctx: HttpContext): void {
  const { authAuditManager, connectionManager, resolveActor, requireScope, keyRotateRateLimit, loginRateLimit } = ctx;

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
    let updated: Awaited<ReturnType<typeof authAuditManager.updateUser>>;
    try {
      updated = await authAuditManager.updateUser(
        req.params.id,
        {
          role: req.body?.role,
          active: typeof req.body?.active === 'boolean' ? req.body.active : undefined,
          fullName: typeof req.body?.fullName === 'string' ? req.body.fullName : undefined,
          password: typeof req.body?.password === 'string' ? req.body.password : undefined,
        },
        { actor, actorRole, requestId }
      );
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Invalid user update.',
        tier,
        requestId,
      });
      return;
    }
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
}
