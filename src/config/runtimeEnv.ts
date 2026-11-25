/**
 * Single source of truth for runtime-environment decisions that affect security posture.
 *
 * Production always fails closed: insecure development conveniences (anonymous API access,
 * demo accounts, default passwords, per-container encryption keys) are refused even if an
 * environment variable asks for them.
 */

export const MIN_ADMIN_PASSWORD_LENGTH = 12;

export function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * API authentication is mandatory in production. Outside production it is enforced when
 * `API_ENFORCE_AUTH=true` or when the operator enabled strict gateway mode in the console.
 */
export function isApiAuthEnforced(strictGatewayMode: boolean): boolean {
  return isProductionRuntime() || strictGatewayMode || process.env.API_ENFORCE_AUTH === 'true';
}

/**
 * Collects configuration errors that must stop a production boot. Returns an empty list
 * outside production or when the configuration is safe.
 */
export function collectProductionConfigErrors(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const errors: string[] = [];

  const adminPassword = env.AUTH_ADMIN_PASSWORD ?? '';
  if (adminPassword.length < MIN_ADMIN_PASSWORD_LENGTH) {
    errors.push(
      `AUTH_ADMIN_PASSWORD must be set to at least ${MIN_ADMIN_PASSWORD_LENGTH} characters in production.`
    );
  }
  if (!env.SECRETS_ENCRYPTION_KEY?.trim()) {
    errors.push(
      'SECRETS_ENCRYPTION_KEY must be set in production: an auto-generated per-container key makes encrypted API tokens and alert secrets unreadable after a restart or across replicas.'
    );
  }
  return errors;
}

/**
 * Express `trust proxy` setting from `TRUST_PROXY` (hop count, `true`/`false`, or a
 * comma-separated list of trusted subnets such as `loopback,10.0.0.0/8`).
 * Defaults to `false` so `X-Forwarded-For` cannot be spoofed by direct clients.
 */
export function resolveTrustProxySetting(raw = process.env.TRUST_PROXY): boolean | number | string {
  const value = raw?.trim();
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}
