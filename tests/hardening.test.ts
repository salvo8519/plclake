import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server.ts';
import {
  collectProductionConfigErrors,
  isApiAuthEnforced,
  resolveTrustProxySetting,
} from '../src/config/runtimeEnv.ts';
import { DatabaseStore } from '../src/db.ts';
import { StructuredLogger } from '../src/logger.ts';
import { validateOutboundHost } from '../src/security.ts';
import { SimulationRunManager } from '../src/simulationRunner.ts';
import { createJsonErrorHandler, forwardAsyncErrors } from '../src/utils/asyncRouter.ts';
import { BoundedRecentSet } from '../src/utils/boundedRecentSet.ts';

const STRONG_SECRET_KEY = 'a'.repeat(64);

function withEnv(overrides: Record<string, string | undefined>): () => void {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

describe('Production fail-closed configuration', () => {
  let restoreEnv: (() => void) | null = null;
  afterEach(() => {
    restoreEnv?.();
    restoreEnv = null;
  });

  it('always enforces API authentication in production, even with API_ENFORCE_AUTH=false', () => {
    restoreEnv = withEnv({ NODE_ENV: 'production', API_ENFORCE_AUTH: 'false' });
    expect(isApiAuthEnforced(false)).toBe(true);
  });

  it('keeps the explicit opt-in rules outside production', () => {
    restoreEnv = withEnv({ NODE_ENV: 'development', API_ENFORCE_AUTH: undefined });
    expect(isApiAuthEnforced(false)).toBe(false);
    expect(isApiAuthEnforced(true)).toBe(true);
  });

  it('rejects a production boot without admin password or encryption key', () => {
    expect(collectProductionConfigErrors({ NODE_ENV: 'production' })).toHaveLength(2);
    expect(
      collectProductionConfigErrors({
        NODE_ENV: 'production',
        AUTH_ADMIN_PASSWORD: 'short',
        SECRETS_ENCRYPTION_KEY: STRONG_SECRET_KEY,
      })
    ).toHaveLength(1);
    expect(
      collectProductionConfigErrors({
        NODE_ENV: 'production',
        AUTH_ADMIN_PASSWORD: 'a-long-enough-password',
        SECRETS_ENCRYPTION_KEY: STRONG_SECRET_KEY,
      })
    ).toEqual([]);
    expect(collectProductionConfigErrors({ NODE_ENV: 'development' })).toEqual([]);
  });

  it('refuses to create the app with an insecure production configuration', async () => {
    restoreEnv = withEnv({
      NODE_ENV: 'production',
      AUTH_ADMIN_PASSWORD: undefined,
      SECRETS_ENCRYPTION_KEY: undefined,
    });
    await expect(createApp({ rootDir: os.tmpdir(), mountFrontend: false })).rejects.toThrow(
      /insecure production configuration/
    );
  });

  it('parses TRUST_PROXY safely (off by default)', () => {
    expect(resolveTrustProxySetting(undefined)).toBe(false);
    expect(resolveTrustProxySetting('false')).toBe(false);
    expect(resolveTrustProxySetting('true')).toBe(true);
    expect(resolveTrustProxySetting('2')).toBe(2);
    expect(resolveTrustProxySetting('loopback,10.0.0.0/8')).toBe('loopback,10.0.0.0/8');
  });
});

describe('Anonymous access in production', () => {
  let tmpDir: string;
  let app: Awaited<ReturnType<typeof createApp>>['app'];
  let drainPendingWrites: () => Promise<void>;
  let restoreEnv: () => void;

  beforeAll(async () => {
    restoreEnv = withEnv({
      NODE_ENV: 'production',
      API_ENFORCE_AUTH: 'false',
      SECRETS_ENCRYPTION_KEY: STRONG_SECRET_KEY,
    });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'telemetry-hardening-prod-'));
    const created = await createApp({ rootDir: tmpDir, mountFrontend: false });
    app = created.app;
    drainPendingWrites = created.drainPendingWrites;
  });

  afterAll(async () => {
    restoreEnv();
    await drainPendingWrites();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects unauthenticated admin, read and sandbox-token requests', async () => {
    const createUser = await request(app)
      .post('/api/v1/users')
      .send({ email: 'intruder@example.com', fullName: 'X', role: 'admin', password: 'Intruder123!' });
    expect(createUser.status).toBe(401);

    const users = await request(app).get('/api/v1/users');
    expect(users.status).toBe(401);

    const sandbox = await request(app).post('/api/v1/tokens/sandbox').send({ role: 'admin' });
    expect(sandbox.status).toBe(401);
  });

  it('does not seed demo accounts in production', async () => {
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'operator@plant.local', password: 'OperatorPlant2026!' });
    expect(login.status).toBe(401);
  });
});

describe('Account security', () => {
  let tmpDir: string;
  let app: Awaited<ReturnType<typeof createApp>>['app'];
  let drainPendingWrites: () => Promise<void>;
  let adminToken: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'telemetry-hardening-accounts-'));
    const created = await createApp({ rootDir: tmpDir, mountFrontend: false });
    app = created.app;
    drainPendingWrites = created.drainPendingWrites;
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@plant.local', password: process.env.AUTH_ADMIN_PASSWORD });
    adminToken = login.body.token;
  });

  afterAll(async () => {
    await drainPendingWrites();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects short passwords on update instead of silently ignoring them', async () => {
    const res = await request(app)
      .patch('/api/v1/users/usr-viewer')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ password: 'short' });
    expect(res.status).toBe(400);
  });

  it('revokes existing sessions when a password changes', async () => {
    const viewerLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'controller@plant.local', password: process.env.AUTH_DEMO_VIEWER_PASSWORD });
    expect(viewerLogin.status).toBe(200);
    const viewerToken: string = viewerLogin.body.token;

    const change = await request(app)
      .patch('/api/v1/users/usr-viewer')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ password: 'A-new-strong-password-1' });
    expect(change.status).toBe(200);

    const me = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${viewerToken}`);
    expect(me.body.user).toBeNull();
  });

  it('answers malformed JSON with 400 instead of a server error', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": ');
    expect(res.status).toBe(400);
  });
});

describe('Async error forwarding', () => {
  it('turns a rejected async handler into a JSON 500 without leaking the message', async () => {
    const app = express();
    const router = forwardAsyncErrors(express.Router());
    router.get('/boom', async () => {
      throw new Error('internal detail: db password=secret');
    });
    app.use(router);
    app.use(createJsonErrorHandler(new StructuredLogger()));

    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
});

describe('SSRF policy with DNS resolution', () => {
  const resolverFor =
    (addresses: string[]) =>
    async (): Promise<string[]> =>
      addresses;

  it('blocks hostnames that resolve to loopback or cloud metadata', async () => {
    const loopback = await validateOutboundHost('127.0.0.1.nip.io', {
      resolver: resolverFor(['127.0.0.1']),
    });
    expect(loopback.allowed).toBe(false);

    const metadata = await validateOutboundHost('evil.example.com', {
      resolver: resolverFor(['93.184.216.34', '169.254.169.254']),
    });
    expect(metadata.allowed).toBe(false);
    expect(metadata.reason).toContain('169.254.169.254');
  });

  it('allows hostnames that resolve only to permitted addresses', async () => {
    const ok = await validateOutboundHost('hooks.example.com', {
      resolver: resolverFor(['93.184.216.34']),
    });
    expect(ok).toEqual({ allowed: true, addresses: ['93.184.216.34'] });
  });

  it('fails closed when DNS resolution fails', async () => {
    const res = await validateOutboundHost('missing.example.com', {
      resolver: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    expect(res.allowed).toBe(false);
  });
});

describe('Database availability', () => {
  it('fails the boot when PostgreSQL is configured but unreachable', async () => {
    const failingPool = {
      query: async () => {
        throw new Error('connect ECONNREFUSED');
      },
      end: async () => undefined,
    };
    const store = new DatabaseStore({
      databaseUrl: 'postgres://u:p@db.invalid:5432/x',
      pool: failingPool as never,
    });
    await expect(store.init()).rejects.toThrow(/configured .* but unreachable/);
    expect(store.isConfigured()).toBe(true);
    expect(store.isPostgresActive()).toBe(false);
  });
});

describe('Bounded ingestion state', () => {
  it('BoundedRecentSet remembers recent keys across a generation switch', () => {
    const set = new BoundedRecentSet(3);
    for (const key of ['a', 'b', 'c', 'd']) set.add(key);
    // 'a'-'c' moved to the previous generation; they are still recognised as duplicates.
    expect(set.has('a')).toBe(true);
    expect(set.has('d')).toBe(true);
    for (const key of ['e', 'f', 'g']) set.add(key);
    expect(set.has('a')).toBe(false);
    expect(set.size).toBeLessThanOrEqual(6);
  });

  it('caps in-memory aggregation windows while keeping cumulative feature counts exact', () => {
    const manager = new SimulationRunManager();
    const totalWindows = 5600;
    const startMs = Date.UTC(2026, 0, 1);
    const events = Array.from({ length: totalWindows }, (_, i) => ({
      event_id: `evt-${i}`,
      timestamp: new Date(startMs + i * 60 * 60_000).toISOString(),
      machine_id: 'M-01',
      line_id: 'L-01',
      machine_type: 'siemens_s7_1500',
      state: 'RUNNING',
      metrics: { temp_c: 55 },
    }));

    const result = manager.ingestExternalBatch(events, { windowMinutes: 60 });
    expect(result.accepted).toBe(totalWindows);

    const snapshot = manager.getLatestSnapshot();
    expect(snapshot?.featureRowsCount).toBe(totalWindows);
    const run = (manager as unknown as { runs: Map<string, { windowBuckets: Map<string, unknown> }> }).runs
      .values()
      .next().value;
    expect(run?.windowBuckets.size).toBeLessThanOrEqual(5000);
    manager.stopAllRuns();
  });
});
