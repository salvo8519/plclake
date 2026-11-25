import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { AlertEngine } from '../src/alertEngine.ts';
import {
  securityHeadersMiddleware,
  sha256Hex,
  timingSafeHashMatch,
  timingSafeStringEqual,
  validateProbeHost,
} from '../src/security.ts';
import { buildScalarTopBarHtml } from '../src/serverConfig.ts';
import { atomicWriteJson, sanitizeCsvCell } from '../src/utils/persistence.ts';

describe('Security Primitives & Persistence Hardening', () => {
  it('verifies constant-time string and SHA-256 token matching', () => {
    const secret = 'adm_live_8c7a9d4e2f1b0a3c5d6e7f8091a2b3c4';
    const hash = sha256Hex(secret);

    expect(timingSafeStringEqual(secret, secret)).toBe(true);
    expect(timingSafeStringEqual(secret, `${secret}x`)).toBe(false);
    expect(timingSafeHashMatch(secret, hash)).toBe(true);
    expect(timingSafeHashMatch('adm_live_wrong', hash)).toBe(false);
    expect(timingSafeHashMatch('', hash)).toBe(false);
  });

  it('blocks cloud metadata, loopback, and malformed hosts in outbound host validator', () => {
    delete process.env.ALLOW_LOOPBACK_PROBE;

    expect(validateProbeHost('169.254.169.254').allowed).toBe(false);
    expect(validateProbeHost('metadata.google.internal').allowed).toBe(false);
    expect(validateProbeHost('127.0.0.1').allowed).toBe(false);
    expect(validateProbeHost('localhost').allowed).toBe(false);
    expect(validateProbeHost('::1').allowed).toBe(false);
    expect(validateProbeHost('0.0.0.0').allowed).toBe(false);
    expect(validateProbeHost('fe80::1').allowed).toBe(false);
    expect(validateProbeHost('admin@192.168.10.15').allowed).toBe(false);
    expect(validateProbeHost('http://192.168.10.15').allowed).toBe(false);

    // Valid corporate LAN / OT VLAN addresses must be allowed
    expect(validateProbeHost('192.168.10.15').allowed).toBe(true);
    expect(validateProbeHost('10.42.8.101').allowed).toBe(true);
    expect(validateProbeHost('plc-line01.plant.local').allowed).toBe(true);
  });

  it('blocks IPv4-mapped IPv6, expanded IPv6, bracketed IPv6, and integer/octal/hex IPv4 bypasses', () => {
    delete process.env.ALLOW_LOOPBACK_PROBE;

    const bypassPayloads = [
      '::ffff:169.254.169.254',
      '[::ffff:169.254.169.254]',
      '::ffff:a9fe:a9fe',
      '::ffff:127.0.0.1',
      '::ffff:0.0.0.0',
      '0:0:0:0:0:0:0:1',
      '0000::1',
      '0:0:0:0:0:0:0:0',
      '[fe80::1]',
      'fd00:ec2::254',
      '2852039166',
      '0x7f000001',
      '0177.0.0.1',
      '0xa9.0xfe.0xa9.0xfe',
      '[::1',
    ];

    for (const host of bypassPayloads) {
      expect(validateProbeHost(host).allowed, `expected ${host} to be blocked`).toBe(false);
    }

    // Even when allowLoopback is enabled (e.g. local Mailpit), metadata IPv4-mapped IPv6 stays blocked
    expect(validateProbeHost('::ffff:169.254.169.254', { allowLoopback: true }).allowed).toBe(false);
    expect(validateProbeHost('::ffff:a9fe:a9fe', { allowLoopback: true }).allowed).toBe(false);
    expect(validateProbeHost('127.0.0.1', { allowLoopback: true }).allowed).toBe(true);
    expect(validateProbeHost('[::1]', { allowLoopback: true }).allowed).toBe(true);
  });

  it('allows loopback probes only when ALLOW_LOOPBACK_PROBE=true', () => {
    process.env.ALLOW_LOOPBACK_PROBE = 'true';
    try {
      expect(validateProbeHost('127.0.0.1').allowed).toBe(true);
      expect(validateProbeHost('localhost').allowed).toBe(true);
      // Cloud metadata remains unconditionally blocked
      expect(validateProbeHost('169.254.169.254').allowed).toBe(false);
      expect(validateProbeHost('::ffff:169.254.169.254').allowed).toBe(false);
    } finally {
      delete process.env.ALLOW_LOOPBACK_PROBE;
    }
  });

  it('disallows wildcard CORS (*) on /api/* while honoring explicit allowlisted origins and PATCH', async () => {
    const prevCors = process.env.CORS_ORIGIN;
    const app = express();
    app.use(securityHeadersMiddleware);
    app.get('/api/v1/test', (_req, res) => res.json({ ok: true }));
    app.get('/public-status', (_req, res) => res.json({ ok: true }));

    try {
      process.env.CORS_ORIGIN = '*';
      const apiRes = await request(app)
        .get('/api/v1/test')
        .set('Origin', 'https://untrusted.example');
      expect(apiRes.headers['access-control-allow-origin']).toBeUndefined();

      process.env.CORS_ORIGIN = 'https://console.plant.local';
      const allowedRes = await request(app)
        .options('/api/v1/test')
        .set('Origin', 'https://console.plant.local');
      expect(allowedRes.status).toBe(204);
      expect(allowedRes.headers['access-control-allow-origin']).toBe('https://console.plant.local');
      expect(allowedRes.headers['access-control-allow-methods']).toContain('PATCH');
    } finally {
      if (prevCors === undefined) delete process.env.CORS_ORIGIN;
      else process.env.CORS_ORIGIN = prevCors;
    }
  });

  it('blocks outbound webhook HTTP redirects to internal metadata services and blocks metadata SMTP hosts', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'telemetry-alert-sec-'));
    const server = http.createServer((_req, res) => {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const prevAllow = process.env.ALLOW_LOOPBACK_PROBE;
    process.env.ALLOW_LOOPBACK_PROBE = 'true';

    try {
      const engine = new AlertEngine(tmpDir);
      await engine.init();

      const webhookOutcome = await engine.sendWebhook(
        { test: true },
        `http://127.0.0.1:${port}/redirect-trap`
      );
      expect(webhookOutcome.status).toBe('failed');

      await engine.updateChannels({ smtp: { host: '::ffff:169.254.169.254', port: 1025 } });
      const smtpVerify = await engine.verifySmtpConnection();
      expect(smtpVerify.reachable).toBe(false);
      expect(smtpVerify.error).toContain('SSRF_BLOCKED');
    } finally {
      if (prevAllow === undefined) delete process.env.ALLOW_LOOPBACK_PROBE;
      else process.env.ALLOW_LOOPBACK_PROBE = prevAllow;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('escapes HTML metacharacters in Scalar top bar header rendering', () => {
    const html = buildScalarTopBarHtml({
      lang: 'en',
      brand: '<script>alert(1)</script>',
      subtitle: 'API "Ref"',
      backToConsole: 'Back <home>',
      docsBasePath: '/api/v1/docs',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('API &quot;Ref&quot;');
  });

  it('neutralizes CSV formula injection payloads for Excel & Power BI', () => {
    expect(sanitizeCsvCell('=cmd|"/C calc"!A0')).toBe('"\'=cmd|""/C calc""!A0"');
    expect(sanitizeCsvCell('+1+1')).toBe('"\'+1+1"');
    expect(sanitizeCsvCell('-2+3')).toBe('"\'-2+3"');
    expect(sanitizeCsvCell('@SUM(A1:A10)')).toBe('"\'@SUM(A1:A10)"');
    expect(sanitizeCsvCell('normal_machine_01')).toBe('"normal_machine_01"');
    expect(sanitizeCsvCell(42.5)).toBe('"42.5"');
  });

  it('serializes concurrent atomicWriteJson calls without corruption', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'telemetry-atomic-'));
    const targetFile = path.join(tmpDir, 'state.json');
    try {
      await Promise.all(
        Array.from({ length: 12 }, (_, idx) =>
          atomicWriteJson(targetFile, { revision: idx, ok: true }, true)
        )
      );
      const raw = await fs.readFile(targetFile, 'utf-8');
      const parsed = JSON.parse(raw) as { revision: number; ok: boolean };
      expect(parsed.ok).toBe(true);
      expect(parsed.revision).toBe(11);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
