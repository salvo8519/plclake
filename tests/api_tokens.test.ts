import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server.ts';
import { AuthAuditManager } from '../src/authAudit.ts';
import { redactStringSecrets } from '../src/logger.ts';
import type { TokenLifecycleEvent } from '../src/secretManagementEvents.ts';

describe('Managed X-API-Key Lifecycle, Encrypted Storage, Sandbox Auth & Audit Trail', () => {
  let tmpDir: string;
  let app: Awaited<ReturnType<typeof createApp>>['app'];
  let adminSessionToken: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'telemetry-api-tokens-'));
    const created = await createApp({ rootDir: tmpDir, mountFrontend: false });
    app = created.app;

    // Enable strict auth enforcement so every key, scope, and revocation boundary is verified
    await request(app).post('/api/v1/connections/api-keys/rotate').send({ scope: 'admin' });
    await request(app)
      .put('/api/v1/connections/settings')
      .send({ requireGatewayToken: true });

    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@plant.local', password: 'AdminPlant2026!' });
    expect(loginRes.status).toBe(200);
    adminSessionToken = loginRes.body.token;
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('issues a scoped X-API-Key, encrypts its SHA-256 hash at rest (AES-256-GCM), and never persists plaintext', async () => {
    const issueRes = await request(app)
      .post('/api/v1/tokens')
      .set('Authorization', `Bearer ${adminSessionToken}`)
      .send({
        name: 'Power BI Plant Reader',
        description: 'Read-only KPI feed consumer',
        scopes: ['read'],
        ttlHours: 720,
      });

    expect(issueRes.status).toBe(201);
    const plaintextKey: string = issueRes.body.token;
    expect(plaintextKey).toMatch(/^pat_live_[a-f0-9]{48}$/);
    expect(issueRes.body.record.name).toBe('Power BI Plant Reader');
    expect(issueRes.body.record.scopes).toEqual(['read']);
    expect(issueRes.body.record.status).toBe('active');

    // Verify encrypted-at-rest persistence on disk: ZERO plaintext secret, ONLY enc:v1: ciphertext
    const rawFile = await fs.readFile(path.join(tmpDir, '.state', 'api-tokens.json'), 'utf8');
    expect(rawFile).not.toContain(plaintextKey);
    expect(rawFile).toContain('enc:v1:');

    // Verify GET /api/v1/tokens returns metadata only (no hash, no secret)
    const listRes = await request(app)
      .get('/api/v1/tokens')
      .set('X-API-Key', plaintextKey);
    expect(listRes.status).toBe(200);
    expect(JSON.stringify(listRes.body)).not.toContain(plaintextKey);
    expect(JSON.stringify(listRes.body)).not.toContain('enc:v1:');
    const listed = listRes.body.tokens.find((t: { id: string }) => t.id === issueRes.body.record.id);
    expect(listed).toBeTruthy();
    expect(listed.usageCount).toBeGreaterThanOrEqual(1);

    // Verify both X-API-Key and Authorization: Bearer work on whoami
    const whoamiApiKey = await request(app)
      .get('/api/v1/auth/whoami')
      .set('X-API-Key', plaintextKey);
    expect(whoamiApiKey.status).toBe(200);
    expect(whoamiApiKey.body.authenticated).toBe(true);
    expect(whoamiApiKey.body.grantedScope).toBe('read');
    expect(whoamiApiKey.body.token?.id).toBe(issueRes.body.record.id);

    const whoamiBearer = await request(app)
      .get('/api/v1/auth/whoami')
      .set('Authorization', `Bearer ${plaintextKey}`);
    expect(whoamiBearer.status).toBe(200);
    expect(whoamiBearer.body.authenticated).toBe(true);
    expect(whoamiBearer.body.token?.id).toBe(issueRes.body.record.id);

    // Scope enforcement: read-only key allowed on GET /job/config, denied 403 on admin & edge writes
    const readJob = await request(app)
      .get('/api/v1/job/config')
      .set('X-API-Key', plaintextKey);
    expect(readJob.status).toBe(200);

    const deniedAdmin = await request(app)
      .post('/api/v1/tokens')
      .set('X-API-Key', plaintextKey)
      .send({ name: 'Escalation Attempt', scopes: ['admin'] });
    expect(deniedAdmin.status).toBe(403);

    const deniedEdge = await request(app)
      .post('/api/v1/ingest/batch')
      .set('X-API-Key', plaintextKey)
      .send({
        events: [
          {
            timestamp: new Date().toISOString(),
            machine_id: 'M-01',
            line_id: 'L-01',
            machine_type: 'siemens_s7_1500',
            state: 'RUNNING',
            metrics: { temp_c: 55 },
          },
        ],
      });
    expect(deniedEdge.status).toBe(403);
  });

  it('enforces edge scope, atomic rotation, immediate revocation, and Audit Log attribution', async () => {
    const edgeIssue = await request(app)
      .post('/api/v1/tokens')
      .set('Authorization', `Bearer ${adminSessionToken}`)
      .send({
        name: 'Edge Collector Line-A',
        scopes: ['edge'],
        ttlHours: 24,
      });
    expect(edgeIssue.status).toBe(201);
    const edgeKey: string = edgeIssue.body.token;
    const edgeTokenId: string = edgeIssue.body.record.id;

    // Edge key succeeds on /ingest/batch
    const ingestRes = await request(app)
      .post('/api/v1/ingest/batch')
      .set('X-API-Key', edgeKey)
      .send({
        events: [
          {
            timestamp: new Date().toISOString(),
            machine_id: 'M-EDGE-1',
            line_id: 'L-EDGE',
            machine_type: 'siemens_s7_1500',
            state: 'RUNNING',
            metrics: { temp_c: 58.2 },
          },
        ],
      });
    expect(ingestRes.status).toBe(202);

    // Atomic rotation revokes old key and issues working replacement
    const rotateRes = await request(app)
      .post(`/api/v1/tokens/${encodeURIComponent(edgeTokenId)}/rotate`)
      .set('Authorization', `Bearer ${adminSessionToken}`);
    expect(rotateRes.status).toBe(201);
    const rotatedKey: string = rotateRes.body.token;
    const rotatedId: string = rotateRes.body.record.id;
    expect(rotatedKey).toMatch(/^pat_live_[a-f0-9]{48}$/);
    expect(rotatedKey).not.toBe(edgeKey);

    const oldKeyCheck = await request(app)
      .get('/api/v1/auth/whoami')
      .set('X-API-Key', edgeKey);
    expect(oldKeyCheck.status).toBe(401);

    const newKeyCheck = await request(app)
      .get('/api/v1/auth/whoami')
      .set('X-API-Key', rotatedKey);
    expect(newKeyCheck.status).toBe(200);
    expect(newKeyCheck.body.token?.id).toBe(rotatedId);

    // Immediate revocation blocks replacement key
    const revokeRes = await request(app)
      .delete(`/api/v1/tokens/${encodeURIComponent(rotatedId)}`)
      .set('Authorization', `Bearer ${adminSessionToken}`);
    expect(revokeRes.status).toBe(200);

    const revokedCheck = await request(app)
      .get('/api/v1/auth/whoami')
      .set('X-API-Key', rotatedKey);
    expect(revokedCheck.status).toBe(401);

    // Verify Audit Log attributes management writes performed with a managed X-API-Key
    const adminKeyIssue = await request(app)
      .post('/api/v1/tokens')
      .set('Authorization', `Bearer ${adminSessionToken}`)
      .send({
        name: 'ERP Orchestrator Bot',
        scopes: ['admin'],
        ttlHours: 24,
      });
    expect(adminKeyIssue.status).toBe(201);
    const adminApiKey: string = adminKeyIssue.body.token;

    const jobWriteRes = await request(app)
      .put('/api/v1/job/config')
      .set('X-API-Key', adminApiKey)
      .send({ watchIntervalSec: 30 });
    expect(jobWriteRes.status).toBe(200);

    // Audit Log recorded both token lifecycle mutations and token-attributed config writes
    const auditRes = await request(app)
      .get('/api/v1/audit/logs?limit=100')
      .set('Authorization', `Bearer ${adminSessionToken}`);
    expect(auditRes.status).toBe(200);
    const entries: Array<{ actor: string; action: string }> = auditRes.body.logs;
    expect(entries.some((e) => e.action.includes('/tokens'))).toBe(true);
    expect(entries.some((e) => e.actor.includes('token:ERP Orchestrator Bot'))).toBe(true);
  });

  it('mints 1-hour sandbox test keys for Scalar, enforces strict auth, and scrubs pat_live_ in structured logs', async () => {
    // Unauthenticated request in strict mode is rejected
    const unauthSandbox = await request(app)
      .post('/api/v1/tokens/sandbox')
      .send({ role: 'admin' });
    expect(unauthSandbox.status).toBe(401);

    // Valid operator credentials mint a bounded 1h sandbox key
    const sandboxRes = await request(app)
      .post('/api/v1/tokens/sandbox')
      .send({
        email: 'controller@plant.local',
        password: 'ViewerPlant2026!',
        name: 'Scalar BI Test',
      });
    expect(sandboxRes.status).toBe(201);
    expect(sandboxRes.body.token).toMatch(/^pat_live_[a-f0-9]{48}$/);
    expect(sandboxRes.body.record.isSandbox).toBe(true);
    expect(sandboxRes.body.record.scopes).toEqual(['read']);
    expect(sandboxRes.body.record.expiresAt).toBeTruthy();

    const whoamiSandbox = await request(app)
      .get('/api/v1/auth/whoami')
      .set('X-API-Key', sandboxRes.body.token);
    expect(whoamiSandbox.status).toBe(200);
    expect(whoamiSandbox.body.authenticated).toBe(true);
    expect(whoamiSandbox.body.grantedScope).toBe('read');

    // Structured log scrubber redacts pat_live_ tokens automatically
    const scrubbed = redactStringSecrets(`X-API-Key: ${sandboxRes.body.token}`);
    expect(scrubbed).not.toContain(sandboxRes.body.token);
    expect(scrubbed).toContain('pat_live_[REDACTED]');

    // Scalar interactive docs HTML serves the bilingual API Key / Test button & modal
    const scalarIt = await request(app).get('/api/v1/docs?lang=it');
    expect(scalarIt.status).toBe(200);
    expect(scalarIt.text).toContain('erp-scalar-auth-trigger');
    expect(scalarIt.text).toContain('Chiave API / Test');
  });

  it('automatically pushes token.created, token.rotated, and token.revoked (manual + cascade) events directly to AuditLogSystem', async () => {
    const isolatedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'telemetry-secret-events-'));
    try {
      const manager = new AuthAuditManager(isolatedDir);
      await manager.init();

      const observed: TokenLifecycleEvent[] = [];
      const unsubscribeObserver = manager.subscribeTokenLifecycle((evt) => {
        observed.push(evt);
      });
      // Register a deliberately failing subscriber to verify error isolation
      const unsubscribeFailing = manager.subscribeTokenLifecycle(() => {
        throw new Error('simulated downstream subscriber failure');
      });

      // 1. Token creation
      const created = await manager.issueApiToken({
        name: 'SCADA Telemetry Bridge',
        scopes: ['edge', 'read'],
        ownerEmail: 'operator@plant.local',
        createdBy: 'admin@plant.local',
        actorRole: 'admin',
        requestId: 'req-create-01',
        ttlHours: 48,
      });

      // 2. Token rotation
      const rotated = await manager.rotateApiToken(created.record.id, 'admin@plant.local', {
        actorRole: 'admin',
        requestId: 'req-rotate-01',
      });
      expect(rotated).not.toBeNull();

      // 3. Manual revocation of rotated key
      await manager.revokeApiToken(rotated!.record.id, 'admin@plant.local', 'manual_revocation', {
        actorRole: 'admin',
        requestId: 'req-revoke-01',
      });

      // 4. Cascade revocation when owner account is disabled
      const operatorKey = await manager.issueApiToken({
        name: 'Operator Shift Key',
        scopes: ['read'],
        ownerEmail: 'operator@plant.local',
        createdBy: 'admin@plant.local',
        actorRole: 'admin',
        requestId: 'req-create-02',
      });
      const opUser = manager.listUsers().find((u) => u.email === 'operator@plant.local')!;
      await manager.updateUser(
        opUser.id,
        { active: false },
        { actor: 'admin@plant.local', actorRole: 'admin', requestId: 'req-disable-op' }
      );

      unsubscribeObserver();
      unsubscribeFailing();

      // Verify observed domain events sequence & zero plaintext secret exposure
      expect(observed.map((e) => e.type)).toEqual([
        'token.created',
        'token.rotated',
        'token.revoked',
        'token.created',
        'token.revoked',
      ]);
      const serializedEvents = JSON.stringify(observed);
      expect(serializedEvents).not.toContain(created.token);
      expect(serializedEvents).not.toContain(rotated!.token);
      expect(serializedEvents).not.toContain(operatorKey.token);

      // Verify automated AuditLogSystem subscriber persisted every lifecycle event directly
      const auditEntries = await manager.queryAuditLogs({ action: 'token.', limit: 50 });
      const createdEntry = auditEntries.find(
        (e) => e.action === 'token.created' && e.requestId === 'req-create-01'
      );
      const rotatedEntry = auditEntries.find(
        (e) => e.action === 'token.rotated' && e.requestId === 'req-rotate-01'
      );
      const manualRevokeEntry = auditEntries.find(
        (e) => e.action === 'token.revoked' && e.requestId === 'req-revoke-01'
      );
      const cascadeRevokeEntry = auditEntries.find(
        (e) => e.action === 'token.revoked' && e.requestId === 'req-disable-op'
      );

      expect(createdEntry?.resource).toBe(`secret-management://tokens/${created.record.id}`);
      expect(rotatedEntry?.details.previousTokenId).toBe(created.record.id);
      expect(rotatedEntry?.resource).toBe(`secret-management://tokens/${rotated!.record.id}`);
      expect(manualRevokeEntry?.details.reason).toBe('manual_revocation');
      expect(cascadeRevokeEntry?.details.reason).toBe('owner_account_disabled');
      expect(cascadeRevokeEntry?.resource).toBe(`secret-management://tokens/${operatorKey.record.id}`);

      // Verify Audit Log contains zero plaintext tokens
      const serializedAudit = JSON.stringify(auditEntries);
      expect(serializedAudit).not.toContain(created.token);
      expect(serializedAudit).not.toContain(rotated!.token);
      expect(serializedAudit).not.toContain(operatorKey.token);
    } finally {
      await fs.rm(isolatedDir, { recursive: true, force: true });
    }
  });
});
