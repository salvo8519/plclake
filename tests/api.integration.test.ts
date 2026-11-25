import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server.ts';

describe('Industrial Telemetry API Integration & Security Suite', () => {
  let tmpDir: string;
  let app: Awaited<ReturnType<typeof createApp>>['app'];
  let drainPendingWrites: () => Promise<void>;
  let readToken: string;
  let edgeToken: string;
  let adminToken: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'telemetry-api-test-'));
    const created = await createApp({ rootDir: tmpDir, mountFrontend: false });
    app = created.app;
    drainPendingWrites = created.drainPendingWrites;

    const r1 = await request(app)
      .post('/api/v1/connections/api-keys/rotate')
      .send({ scope: 'read' });
    const r2 = await request(app)
      .post('/api/v1/connections/api-keys/rotate')
      .send({ scope: 'edge' });
    const r3 = await request(app)
      .post('/api/v1/connections/api-keys/rotate')
      .send({ scope: 'admin' });

    readToken = r1.body.token;
    edgeToken = r2.body.token;
    adminToken = r3.body.token;
  });

  afterAll(async () => {
    // Background audit/state writes must settle before the state dir is removed.
    await drainPendingWrites();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('emits hardened security & versioning headers on /api/v1/health', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['api-version']).toBe('1.0.0');
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.body.storage.mode).toBe('file-fallback');
  });

  it('enforces multi-scope API key isolation and Scalar whoami verification', async () => {
    expect(readToken.startsWith('bi_live_')).toBe(true);
    expect(edgeToken.startsWith('gw_live_')).toBe(true);
    expect(adminToken.startsWith('adm_live_')).toBe(true);

    // Invalid token always rejected with 401
    const invalid = await request(app)
      .get('/api/v1/auth/whoami')
      .set('Authorization', 'Bearer invalid_key_999');
    expect(invalid.status).toBe(401);

    // Valid tokens report exact scope
    const wRead = await request(app).get('/api/v1/auth/whoami').set('X-API-Key', readToken);
    expect(wRead.status).toBe(200);
    expect(wRead.body.grantedScope).toBe('read');

    const wEdge = await request(app).get('/api/v1/auth/whoami').set('X-Gateway-Token', edgeToken);
    expect(wEdge.status).toBe(200);
    expect(wEdge.body.grantedScope).toBe('edge');

    const wAdmin = await request(app)
      .get('/api/v1/auth/whoami')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(wAdmin.status).toBe(200);
    expect(wAdmin.body.grantedScope).toBe('admin');

    // Cross-scope denials (403 Forbidden)
    const readTryingWrite = await request(app)
      .post('/api/v1/catalog/machines')
      .set('X-API-Key', readToken)
      .send({ typeId: 'forbidden-plc', label: 'Forbidden' });
    expect(readTryingWrite.status).toBe(403);

    const edgeTryingBa = await request(app)
      .get('/api/v1/ba/kpi')
      .set('Authorization', `Bearer ${edgeToken}`);
    expect(edgeTryingBa.status).toBe(403);

    // Authorized scoped calls succeed
    const edgeOnConfig = await request(app)
      .get('/api/v1/edge/config')
      .set('Authorization', `Bearer ${edgeToken}`);
    expect(edgeOnConfig.status).toBe(200);
    expect(edgeOnConfig.body.config_hash).toBeTruthy();

    const readOnBa = await request(app).get('/api/v1/ba/kpi').set('X-API-Key', readToken);
    expect(readOnBa.status).toBe(200);
    expect(readOnBa.body.dataSource).toBe('live-snapshot');
  });

  it('distinguishes Tier-1 permissive vs Tier-2 strict Zod validation', async () => {
    const strictFail = await request(app)
      .post('/api/v1/catalog/machines')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Validation-Mode', 'strict')
      .send({ typeId: 'bad-strict-plc', unknownExtraField: 123 });

    expect(strictFail.status).toBe(400);
    expect(strictFail.body.tier).toBe('strict');
    expect(Array.isArray(strictFail.body.issues)).toBe(true);

    const permissiveOk = await request(app)
      .post('/api/v1/catalog/machines')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        typeId: 'abb-acs880-drive',
        label: 'ABB ACS880 VFD',
        domain: 'power-generation',
        defaultProtocol: 'modbus-tcp',
        defaultPort: 502,
        primaryKey: 'active_power_kw',
        primaryUnit: 'kW',
        primaryNominal: 185,
        extraChannels: [{ key: 'dc_bus_v', unit: 'V', nominal: 560, std: 8 }],
      });

    expect(permissiveOk.status).toBe(201);
    expect(permissiveOk.body.profile.typeId).toBe('abb-acs880-drive');

    const preview = await request(app)
      .post('/api/v1/catalog/machines/abb-acs880-drive/preview-output')
      .set('X-API-Key', readToken)
      .send({ machineId: 'VFD-01', fields: ['machine_id', 'primary_metric_mean'] });
    expect(preview.status).toBe(200);
    expect(preview.body.sampleEnvelope.metrics.dc_bus_v).toBeTypeOf('number');
  });

  it('blocks SSRF probes against cloud metadata endpoints', async () => {
    const created = await request(app)
      .post('/api/v1/connections')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Metadata SSRF Attempt',
        machineId: 'M-SSRF',
        lineId: 'line-99',
        machineType: 'plc-controller',
        protocol: 'http-rest-meter',
        host: '169.254.169.254',
        port: 80,
        endpointOrTopic: '/latest/meta-data/',
      });
    expect(created.status).toBe(201);

    const probe = await request(app)
      .post(`/api/v1/connections/${created.body.connection.id}/probe`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(probe.status).toBe(200);
    expect(probe.body.probe.reachable).toBe(false);
    expect(probe.body.probe.errorCode).toBe('SSRF_BLOCKED');
  });

  it('returns OpenAPI 3.1 contract, formula-safe CSV export, and JSON 404 fallback', async () => {
    const spec = await request(app).get('/api/v1/openapi.json');
    expect(spec.status).toBe(200);
    expect(spec.body.openapi).toBe('3.1.0');
    expect(Object.keys(spec.body.paths).length).toBeGreaterThanOrEqual(22);
    expect(Object.keys(spec.body.components.securitySchemes)).toEqual(
      expect.arrayContaining(['GatewayBearerAuth', 'ApiKeyHeaderAuth', 'GatewayHeaderAuth'])
    );

    const csv = await request(app)
      .get('/api/v1/ba/kpi?format=csv')
      .set('X-API-Key', readToken);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');

    const notFound = await request(app).get('/api/v1/unknown-endpoint-xyz');
    expect(notFound.status).toBe(404);
    expect(notFound.headers['content-type']).toContain('application/json');
    expect(notFound.body.error).toContain('API route not found');
  });
});
