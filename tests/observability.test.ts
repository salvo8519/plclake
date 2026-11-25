import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server.ts';
import { APP_NAME, APP_SLUG, APP_VERSION } from '../src/config/appMeta.ts';
import { StructuredLogger, redactSensitiveData } from '../src/logger.ts';

describe('Fascia C Observability, Structured Logging, Probes & Grafana Dashboards', () => {
  let tmpDir: string;
  let app: Awaited<ReturnType<typeof createApp>>['app'];
  let drainPendingWrites: () => Promise<void>;
  let markShuttingDown: () => void;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'telemetry-obs-test-'));
    const created = await createApp({ rootDir: tmpDir, mountFrontend: false });
    app = created.app;
    drainPendingWrites = created.drainPendingWrites;
    markShuttingDown = created.markShuttingDown;
  });

  afterAll(async () => {
    // Background audit/state writes must settle before the state dir is removed.
    await drainPendingWrites();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('redacts sensitive keys and inline bearer/API/DB secrets in structured JSON logs', () => {
    const emitted: string[] = [];
    const testLogger = new StructuredLogger('telemetry-test', (line) => emitted.push(line));

    testLogger.info('security', 'Auth attempt with Bearer adm_live_secret999999 and sess_abcdef123456', {
      authorization: 'Bearer bi_live_topsecret123',
      smtpPass: 'SuperSecretPass!',
      nested: {
        signingSecret: 'whsec_123456',
        dbUrl: 'postgres://mlops:MyDbPassword@db.local:5432/machine_logs',
        safeField: 'siemens-s7-1500',
      },
    });

    expect(emitted.length).toBe(1);
    const parsed = JSON.parse(emitted[0]) as Record<string, unknown>;
    expect(parsed.level).toBe('info');
    expect(parsed.category).toBe('security');
    expect(parsed.site_id).toBeTruthy();
    expect(parsed.authorization).toBe('[REDACTED]');
    expect(parsed.smtpPass).toBe('[REDACTED]');
    expect((parsed.nested as Record<string, unknown>).signingSecret).toBe('[REDACTED]');
    expect((parsed.nested as Record<string, unknown>).safeField).toBe('siemens-s7-1500');
    expect(emitted[0]).not.toContain('secret999999');
    expect(emitted[0]).not.toContain('abcdef123456');
    expect(emitted[0]).not.toContain('SuperSecretPass');
    expect(emitted[0]).not.toContain('MyDbPassword');
    expect(emitted[0]).not.toContain('whsec_123456');

    const redactedErr = redactSensitiveData(new Error('Failed with gw_live_001122334455')) as {
      message: string;
    };
    expect(redactedErr.message).not.toContain('001122334455');
  });

  it('serves /healthz, /readyz (and 503 during shutdown), and Prometheus /metrics format', async () => {
    const live = await request(app).get('/healthz');
    expect(live.status).toBe(200);
    expect(live.body.status).toBe('alive');
    expect(live.body.siteId).toBeTruthy();

    const ready = await request(app).get('/readyz');
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('ready');

    // Trigger some API traffic + batch ingest so counters populate
    await request(app).get('/api/v1/health');
    await request(app)
      .post('/api/v1/ingest/batch')
      .send({
        events: [
          {
            event_id: 'obs-ev-1',
            timestamp: new Date().toISOString(),
            site_id: 'plant-01',
            machine_id: 'M-OBS-01',
            line_id: 'line-01',
            machine_type: 'siemens-s7-1500',
            state: 'RUNNING',
            metrics: { temp_c: 52.3, cycle_ms: 910 },
          },
        ],
      });

    const metricsRes = await request(app).get('/metrics');
    expect(metricsRes.status).toBe(200);
    expect(metricsRes.headers['content-type']).toContain('text/plain');
    expect(metricsRes.text).toContain('# TYPE telemetry_http_requests_total counter');
    expect(metricsRes.text).toContain('# TYPE telemetry_http_request_duration_ms histogram');
    expect(metricsRes.text).toContain('telemetry_events_ingested_total');
    expect(metricsRes.text).toContain('telemetry_db_connected');
    expect(metricsRes.text).toContain('telemetry_plant_oee_availability_pct');

    const v1MetricsRes = await request(app).get('/api/v1/metrics');
    expect(v1MetricsRes.status).toBe(200);
    expect(v1MetricsRes.text).toContain('telemetry_process_uptime_seconds');

    // Flip graceful shutdown readiness flag -> /readyz must return 503
    markShuttingDown();
    const shuttingDownReady = await request(app).get('/readyz');
    expect(shuttingDownReady.status).toBe(503);
    expect(shuttingDownReady.body.status).toBe('shutting_down');
  });

  it('ships valid pre-provisioned Grafana dashboards for Platform Logs/System and Plant PLC Monitoring', async () => {
    const d1Path = path.resolve(
      process.cwd(),
      'monitoring/grafana/dashboards/01_platform_system_observability.json'
    );
    const d2Path = path.resolve(
      process.cwd(),
      'monitoring/grafana/dashboards/02_plant_plc_monitoring.json'
    );

    const d1 = JSON.parse(await fs.readFile(d1Path, 'utf-8')) as {
      uid: string;
      panels: Array<{ title: string; datasource?: { uid?: string } }>;
    };
    const d2 = JSON.parse(await fs.readFile(d2Path, 'utf-8')) as {
      uid: string;
      panels: Array<{ title: string; datasource?: { uid?: string } }>;
    };

    expect(d1.uid).toBe('itp-platform-system-obs');
    expect(d1.panels.length).toBeGreaterThanOrEqual(8);
    expect(d1.panels.some((p) => p.datasource?.uid === 'prom-telemetry')).toBe(true);
    expect(d1.panels.some((p) => p.datasource?.uid === 'pg-telemetry')).toBe(true);

    expect(d2.uid).toBe('itp-plant-plc-monitoring');
    expect(d2.panels.length).toBeGreaterThanOrEqual(8);
    expect(d2.panels.some((p) => p.datasource?.uid === 'pg-telemetry')).toBe(true);
  });

  it('exposes centralized platform version and identity on /api/v1/version, /version, and /api/v1/health', async () => {
    const v1Res = await request(app).get('/api/v1/version');
    expect(v1Res.status).toBe(200);
    expect(v1Res.headers['api-version']).toBe(APP_VERSION);
    expect(v1Res.body.name).toBe(APP_NAME);
    expect(v1Res.body.slug).toBe(APP_SLUG);
    expect(v1Res.body.version).toBe(APP_VERSION);
    expect(v1Res.body.tag).toBe(`v${APP_VERSION}`);

    const aliasRes = await request(app).get('/version');
    expect(aliasRes.status).toBe(200);
    expect(aliasRes.body.version).toBe(APP_VERSION);
    expect(aliasRes.body.name).toBe(APP_NAME);

    const healthRes = await request(app).get('/api/v1/health');
    expect(healthRes.status).toBe(200);
    expect(healthRes.body.version).toBe(APP_VERSION);
    expect(healthRes.body.apiVersion).toBe(APP_VERSION);
    expect(healthRes.body.name).toBe(APP_NAME);
  });
});
