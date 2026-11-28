import type express from 'express';
import type { Request, Response } from 'express';
import { roleToApiScope, type AuthAuditManager } from '../authAudit.ts';
import type { ConnectionManager } from '../connectionManager.ts';
import { logger } from '../logger.ts';
import { extractRequestCredential, type ApiAuthScope } from '../security.ts';
import { withName } from '../utils/asyncRouter.ts';
import { getRequestContext } from './requestInput.ts';

export interface AuthGuardDependencies {
  authAuditManager: AuthAuditManager;
  connectionManager: ConnectionManager;
}

/**
 * Authentication and authorization guards shared by every router:
 * - `resolveActor`: who is calling (session, OIDC proxy, managed API token, scoped key, anonymous);
 * - `requireScope`: middleware enforcing an API scope (`read`, `edge`, `admin`).
 */
export function createAuthGuards({ authAuditManager, connectionManager }: AuthGuardDependencies) {
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

  const requireScope = (scope: ApiAuthScope) =>
    withName((req: Request, res: Response, next: express.NextFunction) => {
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
    }, `requireScope(${scope})`);

  return { resolveActor, requireScope };
}

export type AuthGuards = ReturnType<typeof createAuthGuards>;
