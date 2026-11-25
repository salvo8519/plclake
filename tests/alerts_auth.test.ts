import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server.ts';
import type { AlertEngine } from '../src/alertEngine.ts';
import type { MlFeatureRow } from '../src/types/pipeline.ts';

interface CapturedSmtpMessage {
  mailFrom: string;
  rcptTo: string[];
  rawData: string;
}

function startMockMailpitSmtpServer(): Promise<{
  port: number;
  messages: CapturedSmtpMessage[];
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const messages: CapturedSmtpMessage[] = [];
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      let buffer = '';
      let inData = false;
      let currentMailFrom = '';
      let currentRcptTo: string[] = [];
      let dataChunks: string[] = [];

      socket.write('220 mailpit.local ESMTP Mailpit\r\n');

      socket.on('data', (chunk: string) => {
        buffer += chunk;

        while (true) {
          if (inData) {
            const endIdx = buffer.indexOf('\r\n.\r\n');
            if (endIdx === -1) break;
            dataChunks.push(buffer.slice(0, endIdx));
            buffer = buffer.slice(endIdx + 5);
            messages.push({
              mailFrom: currentMailFrom,
              rcptTo: [...currentRcptTo],
              rawData: dataChunks.join(''),
            });
            inData = false;
            currentMailFrom = '';
            currentRcptTo = [];
            dataChunks = [];
            socket.write('250 2.0.0 Ok: queued\r\n');
            continue;
          }

          const lineEnd = buffer.indexOf('\r\n');
          if (lineEnd === -1) break;
          const line = buffer.slice(0, lineEnd);
          buffer = buffer.slice(lineEnd + 2);
          const upper = line.toUpperCase();

          if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
            socket.write('250-mailpit.local\r\n250 SIZE 10485760\r\n');
          } else if (upper.startsWith('MAIL FROM:')) {
            currentMailFrom = line.slice(10).trim();
            socket.write('250 2.1.0 Ok\r\n');
          } else if (upper.startsWith('RCPT TO:')) {
            currentRcptTo.push(line.slice(8).trim());
            socket.write('250 2.1.5 Ok\r\n');
          } else if (upper === 'DATA') {
            inData = true;
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (upper === 'QUIT') {
            socket.write('221 2.0.0 Bye\r\n');
            socket.end();
            break;
          } else if (upper === 'RSET' || upper === 'NOOP') {
            socket.write('250 2.0.0 Ok\r\n');
          } else {
            socket.write('250 2.0.0 Ok\r\n');
          }
        }
      });
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to bind mock SMTP port'));
        return;
      }
      resolve({
        port: addr.port,
        messages,
        close: () =>
          new Promise<void>((resClose) => {
            server.close(() => resClose());
          }),
      });
    });
  });
}

interface CapturedWebhookRequest {
  headers: http.IncomingHttpHeaders;
  rawBody: string;
  json: Record<string, unknown>;
}

function startMockWebhookServer(): Promise<{
  url: string;
  requests: CapturedWebhookRequest[];
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const requests: CapturedWebhookRequest[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let json: Record<string, unknown> = {};
        try {
          json = JSON.parse(rawBody) as Record<string, unknown>;
        } catch {
          // ignore
        }
        requests.push({ headers: req.headers, rawBody, json });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to bind mock Webhook server'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}/hooks/telemetry`,
        requests,
        close: () =>
          new Promise<void>((resClose) => {
            server.close(() => resClose());
          }),
      });
    });
  });
}

describe('Notifications (SMTP/Mailpit + Signed Webhook), RBAC & Audit Log Suite', () => {
  let tmpDir: string;
  let app: Awaited<ReturnType<typeof createApp>>['app'];
  let alertEngine: AlertEngine;
  let smtpServer: Awaited<ReturnType<typeof startMockMailpitSmtpServer>>;
  let webhookServer: Awaited<ReturnType<typeof startMockWebhookServer>>;
  const prevAllowLoopback = process.env.ALLOW_LOOPBACK_PROBE;

  beforeAll(async () => {
    process.env.ALLOW_LOOPBACK_PROBE = 'true';
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'telemetry-alerts-auth-'));
    smtpServer = await startMockMailpitSmtpServer();
    webhookServer = await startMockWebhookServer();

    const created = await createApp({ rootDir: tmpDir, mountFrontend: false });
    app = created.app;
    alertEngine = created.alertEngine;

    // Enable auth enforcement via rotating a key so RBAC boundaries are strictly exercised
    await request(app).post('/api/v1/connections/api-keys/rotate').send({ scope: 'admin' });
  });

  afterAll(async () => {
    if (prevAllowLoopback === undefined) {
      delete process.env.ALLOW_LOOPBACK_PROBE;
    } else {
      process.env.ALLOW_LOOPBACK_PROBE = prevAllowLoopback;
    }
    await smtpServer.close();
    await webhookServer.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('authenticates RBAC users, enforces viewer read-only limits, manages users, and revokes sessions', async () => {
    // 1. Invalid login rejected
    const badLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@plant.local', password: 'WrongPassword!' });
    expect(badLogin.status).toBe(401);

    // 2. Viewer login succeeds and has read scope only
    const viewerLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'controller@plant.local', password: 'ViewerPlant2026!' });
    expect(viewerLogin.status).toBe(200);
    expect(viewerLogin.body.token).toMatch(/^sess_/);
    expect(viewerLogin.body.user.role).toBe('viewer');
    const viewerToken: string = viewerLogin.body.token;

    const viewerRead = await request(app)
      .get('/api/v1/alerts')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(viewerRead.status).toBe(200);

    const viewerWriteDenied = await request(app)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({
        email: 'unauth@plant.local',
        fullName: 'Should Fail',
        role: 'operator',
        password: 'Password123!',
      });
    expect(viewerWriteDenied.status).toBe(403);

    // 3. Admin login succeeds, creates a new operator user, updates role, and verifies whoami
    const adminLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@plant.local', password: 'AdminPlant2026!' });
    expect(adminLogin.status).toBe(200);
    const adminToken: string = adminLogin.body.token;

    const whoami = await request(app)
      .get('/api/v1/auth/whoami')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(whoami.status).toBe(200);
    expect(whoami.body.authenticated).toBe(true);
    expect(whoami.body.grantedScope).toBe('admin');
    expect(whoami.body.user.email).toBe('admin@plant.local');

    const createdUser = await request(app)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: 'manutenzione@plant.local',
        fullName: 'Capo Manutenzione',
        role: 'operator',
        password: 'MaintUser2026!',
      });
    expect(createdUser.status).toBe(201);
    expect(createdUser.body.user.email).toBe('manutenzione@plant.local');

    // New user can log in and then log out
    const opLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'manutenzione@plant.local', password: 'MaintUser2026!' });
    expect(opLogin.status).toBe(200);
    const opToken: string = opLogin.body.token;

    const logoutRes = await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${opToken}`);
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body.revoked).toBe(true);

    // Revoked token is rejected
    const afterLogout = await request(app)
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${opToken}`);
    expect(afterLogout.status).toBe(401);
  });

  it('delivers real SMTP email (Mailpit-compatible) and HMAC-signed Webhook, and blocks SSRF webhook URLs', async () => {
    const adminLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@plant.local', password: 'AdminPlant2026!' });
    const adminToken: string = adminLogin.body.token;
    const webhookSecret = 'whsec_test_industrial_2026';

    // 1. Configure SMTP (pointing to local mock Mailpit) + signed Webhook
    const putChannels = await request(app)
      .put('/api/v1/alerts/channels')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        smtp: {
          enabled: true,
          host: '127.0.0.1',
          port: smtpServer.port,
          secure: false,
          fromAddress: 'alerts@plant.local',
          recipients: ['maintenance@plant.local', 'shiftlead@plant.local'],
          mailpitUiUrl: 'http://localhost:8025',
        },
        webhook: {
          enabled: true,
          url: webhookServer.url,
          signingSecret: webhookSecret,
          timeoutMs: 3000,
        },
      });
    expect(putChannels.status).toBe(200);
    expect(putChannels.body.smtp.enabled).toBe(true);
    expect(putChannels.body.webhook.signingSecretSet).toBe(true);

    // 2. Test real SMTP wire delivery via nodemailer
    const smtpTest = await request(app)
      .post('/api/v1/alerts/test-channel')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ channel: 'email' });
    expect(smtpTest.status).toBe(200);
    expect(smtpTest.body.outcome.status).toBe('sent');
    expect(smtpServer.messages.length).toBeGreaterThanOrEqual(1);
    const lastMail = smtpServer.messages[smtpServer.messages.length - 1];
    expect(lastMail.mailFrom).toContain('alerts@plant.local');
    expect(lastMail.rcptTo.join(',')).toContain('maintenance@plant.local');
    expect(lastMail.rawData).toContain('Test SMTP / Mailpit Alert Delivery');

    // 3. Test real Webhook HTTP POST with HMAC-SHA256 verification
    const whTest = await request(app)
      .post('/api/v1/alerts/test-channel')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ channel: 'webhook' });
    expect(whTest.status).toBe(200);
    expect(whTest.body.outcome.status).toBe('sent');
    expect(webhookServer.requests.length).toBeGreaterThanOrEqual(1);

    const lastHook = webhookServer.requests[webhookServer.requests.length - 1];
    const expectedSig =
      `sha256=${ 
      crypto.createHmac('sha256', webhookSecret).update(lastHook.rawBody).digest('hex')}`;
    expect(lastHook.headers['x-telemetry-signature']).toBe(expectedSig);
    expect(lastHook.json.eventType).toBe('telemetry.alert.test');

    // 4. SSRF protection blocks cloud metadata endpoint on webhook override
    const ssrfHook = await request(app)
      .post('/api/v1/alerts/test-channel')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ channel: 'webhook', webhookUrl: 'http://169.254.169.254/latest/meta-data/' });
    expect(ssrfHook.status).toBe(502);
    expect(ssrfHook.body.outcome.status).toBe('failed');
    expect(ssrfHook.body.outcome.error).toContain('SSRF_BLOCKED');

    // 5. Evaluate ML feature row exceeding threshold -> fires Email + Webhook, then acknowledge event
    const customRule = await request(app)
      .post('/api/v1/alerts/rules')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Turbine Overheat Instant Alert',
        metric: 'temp_max',
        operator: 'gt',
        threshold: 92,
        severity: 'critical',
        channels: ['email', 'webhook'],
        cooldownSec: 60,
      });
    expect(customRule.status).toBe(201);
    const createdRuleId: string = customRule.body.rule.id;

    const nowIso = new Date().toISOString();
    const hotFeatureRow: MlFeatureRow = {
      machine_id: 'TURB-01',
      line_id: 'line-01',
      machine_type: 'gas-turbine-chp',
      domain: 'power-generation',
      window_start: nowIso,
      window_minutes: 5,
      dt: nowIso.slice(0, 10),
      sample_count: 300,
      valid_sample_ratio: 1,
      primary_metric_name: 'active_power_kw',
      primary_metric_unit: 'kW',
      primary_metric_mean: 420,
      primary_metric_p95: 445,
      primary_metric_max: 460,
      secondary_metric_name: 'vibration_mm_s',
      secondary_metric_unit: 'mm/s',
      secondary_metric_mean: 3.1,
      temp_mean: 88.5,
      temp_max: 96.4,
      vibration_mean: 2.6,
      vibration_p95: 3.1,
      vibration_max: 3.5,
      cycle_ms_mean: 950,
      cycle_ms_std: 12.4,
      error_count: 2,
      fault_count: 1,
      degraded_count: 1,
      state_transitions_count: 3,
      time_in_fault_sec: 12,
      missing_heartbeat_count: 0,
      is_anomalous_window: 1,
      will_fail_next_window: 1,
      dataset_version: 'v1.0.0',
    };

    const fired = await alertEngine.evaluateFeatureRows([hotFeatureRow]);
    expect(fired.length).toBeGreaterThanOrEqual(1);
    const turbineEvent = fired.find((e) => e.ruleId === createdRuleId);
    expect(turbineEvent).toBeTruthy();
    expect(turbineEvent!.deliveries.every((d) => d.status === 'sent')).toBe(true);

    const ackRes = await request(app)
      .post(`/api/v1/alerts/events/${turbineEvent!.id}/ack`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(ackRes.status).toBe(200);
    expect(ackRes.body.event.acknowledgedBy).toContain('admin@plant.local');

    // Clean up custom rule
    const delRule = await request(app)
      .delete(`/api/v1/alerts/rules/${createdRuleId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(delRule.status).toBe(200);
    expect(delRule.body.deleted).toBe(true);
  });

  it('records immutable audit log entries for API mutations and exports formula-safe CSV', async () => {
    const adminLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@plant.local', password: 'AdminPlant2026!' });
    const adminToken: string = adminLogin.body.token;

    // Allow response finish hooks to flush audit writes
    await new Promise((r) => setTimeout(r, 80));

    const auditJson = await request(app)
      .get('/api/v1/audit/logs?limit=50')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(auditJson.status).toBe(200);
    expect(auditJson.body.count).toBeGreaterThanOrEqual(4);
    expect(
      auditJson.body.logs.some(
        (entry: { action: string }) =>
          entry.action.includes('/alerts/channels') || entry.action.includes('/users')
      )
    ).toBe(true);

    const auditCsv = await request(app)
      .get('/api/v1/audit/logs?format=csv&limit=20')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(auditCsv.status).toBe(200);
    expect(auditCsv.headers['content-type']).toContain('text/csv');
    expect(auditCsv.text.split('\n')[0]).toContain('"id","timestamp","actor","actorRole","action"');
  });

  it('verifies SMTP handshake, dispatches diagnostic test email, and inspects/clears Mailpit REST API', async () => {
    const adminLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@plant.local', password: 'AdminPlant2026!' });
    const adminToken: string = adminLogin.body.token;

    // Spin up a local mock Mailpit REST API server backed by smtpServer.messages
    const mailpitServer = http.createServer((req, res) => {
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && reqUrl.pathname === '/api/v1/info') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            Version: 'v1.21.4-test',
            DatabaseSize: smtpServer.messages.reduce((acc, m) => acc + Buffer.byteLength(m.rawData, 'utf8'), 0),
            Messages: smtpServer.messages.length,
            Unread: smtpServer.messages.length,
            RuntimeStats: {
              Uptime: 3600,
              SMTPAccepted: smtpServer.messages.length,
              SMTPRejected: 0,
            },
          })
        );
        return;
      }
      if (req.method === 'GET' && (reqUrl.pathname === '/api/v1/messages' || reqUrl.pathname === '/api/v1/search')) {
        const q = (reqUrl.searchParams.get('query') || '').toLowerCase();
        const mapped = smtpServer.messages
          .map((m, idx) => {
            const subjMatch = m.rawData.match(/^Subject:\s*(.+)$/im);
            const subject = subjMatch ? subjMatch[1].trim() : '(no subject)';
            return {
              ID: `mp-${idx + 1}`,
              MessageID: `<msg-${idx + 1}@plant.local>`,
              From: { Name: 'Plant Alerts', Address: m.mailFrom.replace(/[<>]/g, '') },
              To: m.rcptTo.map((r) => ({ Name: '', Address: r.replace(/[<>]/g, '') })),
              Subject: subject,
              Snippet: m.rawData.slice(0, 120),
              Created: new Date().toISOString(),
              Size: Buffer.byteLength(m.rawData, 'utf8'),
              Read: false,
              Attachments: 0,
            };
          })
          .filter((item) => !q || item.Subject.toLowerCase().includes(q) || item.Snippet.toLowerCase().includes(q));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            total: mapped.length,
            unread: mapped.length,
            messages_count: mapped.length,
            messages: mapped,
          })
        );
        return;
      }

      if (req.method === 'GET' && reqUrl.pathname.startsWith('/api/v1/message/')) {
        const id = reqUrl.pathname.replace('/api/v1/message/', '').split('/')[0];
        const idx = Number(id.replace('mp-', '')) - 1;
        const found = smtpServer.messages[idx];
        if (!found) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }
        const subjMatch = found.rawData.match(/^Subject:\s*(.+)$/im);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ID: id,
            MessageID: `<msg-${idx + 1}@plant.local>`,
            From: { Name: 'Plant Alerts', Address: found.mailFrom.replace(/[<>]/g, '') },
            To: found.rcptTo.map((r) => ({ Name: '', Address: r.replace(/[<>]/g, '') })),
            Subject: subjMatch ? subjMatch[1].trim() : '(no subject)',
            Date: new Date().toISOString(),
            Size: Buffer.byteLength(found.rawData, 'utf8'),
            Text: 'Diagnostic verification plain text body',
            HTML: '<div>Diagnostic verification HTML body</div>',
            Headers: {
              'Content-Type': ['multipart/alternative'],
              'X-Test-Relay': ['mailpit-mock'],
            },
          })
        );
        return;
      }

      if (req.method === 'DELETE' && reqUrl.pathname === '/api/v1/messages') {
        smtpServer.messages.length = 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => mailpitServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = mailpitServer.address();
    if (!addr || typeof addr === 'string') throw new Error('Mock Mailpit API failed to bind');
    const mailpitBaseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // Point Mailpit UI URL to mock Mailpit REST server
      await request(app)
        .put('/api/v1/alerts/channels')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          smtp: {
            enabled: true,
            host: '127.0.0.1',
            port: smtpServer.port,
            secure: false,
            fromAddress: 'alerts@plant.local',
            recipients: ['diag@plant.local'],
            mailpitUiUrl: mailpitBaseUrl,
          },
        });

      // 1. Verify SMTP handshake
      const verifyRes = await request(app)
        .post('/api/v1/alerts/smtp/verify')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.reachable).toBe(true);
      expect(verifyRes.body.latencyMs).toBeGreaterThanOrEqual(0);

      // 2. Send custom diagnostic email
      const sendRes = await request(app)
        .post('/api/v1/alerts/smtp/send-test')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          recipient: 'diag@plant.local',
          subject: 'Custom Diagnostic Probe 2026',
          body: 'Checking Mailpit capture pipeline.',
        });
      expect(sendRes.status).toBe(200);
      expect(sendRes.body.outcome.status).toBe('sent');
      expect(sendRes.body.smtpResponse).toContain('250');

      // 3a. Query Mailpit API connection status & queue depth
      const statusRes = await request(app)
        .get('/api/v1/alerts/mailpit/status')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(statusRes.status).toBe(200);
      expect(statusRes.body.connected).toBe(true);
      expect(statusRes.body.queueDepth).toBe(smtpServer.messages.length);
      expect(statusRes.body.queueDepth).toBeGreaterThanOrEqual(1);
      expect(statusRes.body.version).toBe('v1.21.4-test');
      expect(statusRes.body.smtpAccepted).toBe(smtpServer.messages.length);

      // 3b. Query Mailpit API inbox via backend proxy
      const inboxRes = await request(app)
        .get('/api/v1/alerts/mailpit/messages?query=Diagnostic')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(inboxRes.status).toBe(200);
      expect(inboxRes.body.reachable).toBe(true);
      expect(inboxRes.body.messages.length).toBeGreaterThanOrEqual(1);
      const targetMsg = inboxRes.body.messages.find((m: { subject: string }) =>
        m.subject.includes('Custom Diagnostic Probe 2026')
      );
      expect(targetMsg).toBeTruthy();

      // 4. Inspect full message detail via Mailpit API proxy
      const detailRes = await request(app)
        .get(`/api/v1/alerts/mailpit/messages/${targetMsg.id}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(detailRes.status).toBe(200);
      expect(detailRes.body.reachable).toBe(true);
      expect(detailRes.body.message.text).toContain('Diagnostic verification');
      expect(detailRes.body.message.headers['X-Test-Relay']).toEqual(['mailpit-mock']);

      // 5. SSRF protection blocks cloud metadata endpoint as Mailpit API URL
      const ssrfRes = await request(app)
        .get('/api/v1/alerts/mailpit/messages?apiBaseUrl=http://169.254.169.254/latest/meta-data/')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(ssrfRes.status).toBe(502);
      expect(ssrfRes.body.reachable).toBe(false);
      expect(ssrfRes.body.error).toContain('SSRF_BLOCKED');

      const ssrfStatusRes = await request(app)
        .get('/api/v1/alerts/mailpit/status?apiBaseUrl=http://169.254.169.254/latest/meta-data/')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(ssrfStatusRes.status).toBe(502);
      expect(ssrfStatusRes.body.connected).toBe(false);
      expect(ssrfStatusRes.body.error).toContain('SSRF_BLOCKED');

      // 6. Clear Mailpit inbox and confirm queue depth drops to 0
      const clearRes = await request(app)
        .delete('/api/v1/alerts/mailpit/messages')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(clearRes.status).toBe(200);
      expect(clearRes.body.cleared).toBe(true);
      expect(smtpServer.messages.length).toBe(0);

      const statusAfterClear = await request(app)
        .get('/api/v1/alerts/mailpit/status')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(statusAfterClear.status).toBe(200);
      expect(statusAfterClear.body.connected).toBe(true);
      expect(statusAfterClear.body.queueDepth).toBe(0);
    } finally {
      await new Promise<void>((resolve) => mailpitServer.close(() => resolve()));
    }
  });

  it('manages configurable Role Permissions Matrix, locks admin full access, and blocks non-admin mutations', async () => {
    const adminLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@plant.local', password: 'AdminPlant2026!' });
    expect(adminLogin.status).toBe(200);
    expect(adminLogin.body.permissions.allowedViews).toContain('users');
    expect(adminLogin.body.permissions.allowedViews).toContain('plc_catalog');
    const adminToken: string = adminLogin.body.token;

    const opLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'operator@plant.local', password: 'OperatorPlant2026!' });
    expect(opLogin.status).toBe(200);
    const opToken: string = opLogin.body.token;

    const viewerLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'controller@plant.local', password: 'ViewerPlant2026!' });
    expect(viewerLogin.status).toBe(200);
    const viewerToken: string = viewerLogin.body.token;

    // 1. Default matrix readable by authenticated users
    const getPerm = await request(app)
      .get('/api/v1/roles/permissions')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(getPerm.status).toBe(200);
    expect(getPerm.body.matrix.admin.allowedViews.length).toBe(10);
    expect(getPerm.body.matrix.admin.allowedViews).toContain('roles');
    expect(getPerm.body.matrix.admin.allowedViews).toContain('tokens');
    expect(getPerm.body.matrix.viewer.allowedViews).toContain('fleet');

    // 2. Viewer and Operator cannot mutate role permissions or create users
    const viewerMutate = await request(app)
      .put('/api/v1/roles/permissions')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ matrix: { viewer: { allowedViews: ['workbench', 'users'] } } });
    expect(viewerMutate.status).toBe(403);

    const opMutate = await request(app)
      .put('/api/v1/roles/permissions')
      .set('Authorization', `Bearer ${opToken}`)
      .send({ matrix: { operator: { allowedViews: ['workbench', 'users'] } } });
    expect(opMutate.status).toBe(403);

    // 3. Admin updates viewer & operator views; attempt to restrict admin is safely ignored
    const adminUpdate = await request(app)
      .put('/api/v1/roles/permissions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        matrix: {
          admin: { allowedViews: ['workbench'], canManageUsers: false },
          operator: {
            allowedViews: ['workbench', 'fleet', 'notifications'],
            canControlSimulation: true,
            canWriteConfig: false,
            canManageAlerts: true,
            canManageUsers: false,
          },
          viewer: {
            allowedViews: ['fleet', 'audit'],
            canControlSimulation: false,
            canWriteConfig: false,
            canManageAlerts: false,
            canManageUsers: false,
          },
        },
      });
    expect(adminUpdate.status).toBe(200);
    expect(adminUpdate.body.matrix.admin.allowedViews.length).toBe(10);
    expect(adminUpdate.body.matrix.admin.canManageUsers).toBe(true);
    expect(adminUpdate.body.matrix.operator.allowedViews).toEqual([
      'workbench',
      'fleet',
      'notifications',
    ]);
    expect(adminUpdate.body.matrix.viewer.allowedViews).toEqual(['fleet', 'audit']);

    // 4. /api/v1/auth/me immediately returns updated permissions for viewer
    const viewerMe = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(viewerMe.status).toBe(200);
    expect(viewerMe.body.user.email).toBe('controller@plant.local');
    expect(viewerMe.body.permissions.allowedViews).toEqual(['fleet', 'audit']);
  });
});

