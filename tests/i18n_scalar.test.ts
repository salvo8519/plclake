import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server.ts';

function collectKeys(obj: unknown, prefix = '', out: string[] = []): string[] {
  if (typeof obj === 'string' || Array.isArray(obj)) {
    out.push(prefix);
    return out;
  }
  if (obj && typeof obj === 'object') {
    for (const [key, val] of Object.entries(obj)) {
      collectKeys(val, prefix ? `${prefix}.${key}` : key, out);
    }
  }
  return out;
}

describe('Bilingual i18n (EN/IT) & Editorial Scalar OpenAPI 3.1', () => {
  let tmpDir: string;
  let app: Awaited<ReturnType<typeof createApp>>['app'];

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'telemetry-i18n-test-'));
    const created = await createApp({ rootDir: tmpDir, mountFrontend: false });
    app = created.app;
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('serves localized OpenAPI 3.1 specs for EN and IT via ?lang= and telemetry_erp_lang cookie', async () => {
    const enRes = await request(app).get('/api/v1/openapi.json?lang=en');
    expect(enRes.status).toBe(200);
    expect(enRes.headers['content-language']).toBe('en');
    expect(enRes.body.info.description).toContain('Production REST & Edge Ingestion API');
    expect(enRes.body.paths['/api/v1/health'].get.summary).toContain('Service health');

    const itRes = await request(app).get('/api/v1/openapi.json?lang=it');
    expect(itRes.status).toBe(200);
    expect(itRes.headers['content-language']).toBe('it');
    expect(itRes.body.info.description).toContain('telemetria industriale multi-dominio');
    expect(itRes.body.paths['/api/v1/health'].get.summary).toContain('Stato di salute');

    const cookieItRes = await request(app)
      .get('/api/v1/openapi.json')
      .set('Cookie', 'telemetry_erp_lang=it');
    expect(cookieItRes.status).toBe(200);
    expect(cookieItRes.headers['content-language']).toBe('it');
    expect(cookieItRes.body.info.description).toContain('telemetria industriale multi-dominio');
  });

  it('serves Editorial Finance Scalar HTML in EN and IT with synced cookie and switcher bar', async () => {
    const itDocs = await request(app).get('/api/v1/docs?lang=it');
    expect(itDocs.status).toBe(200);
    expect(itDocs.headers['content-language']).toBe('it');
    expect(String(itDocs.headers['set-cookie'] ?? '')).toContain('telemetry_erp_lang=it');
    expect(itDocs.text).toContain('lang="it"');
    expect(itDocs.text).toContain('Torna alla Console');
    expect(itDocs.text).toContain('/api/v1/openapi.json?lang=it');

    const enDocs = await request(app).get('/api/v1/docs?lang=en');
    expect(enDocs.status).toBe(200);
    expect(enDocs.headers['content-language']).toBe('en');
    expect(String(enDocs.headers['set-cookie'] ?? '')).toContain('telemetry_erp_lang=en');
    expect(enDocs.text).toContain('lang="en"');
    expect(enDocs.text).toContain('Back to Console');
    expect(enDocs.text).toContain('/api/v1/openapi.json?lang=en');
  });

  it('maintains 100% key parity across all EN and IT i18n locale namespaces', async () => {
    const enDir = path.resolve(process.cwd(), 'src/i18n/locales/en');
    const itDir = path.resolve(process.cwd(), 'src/i18n/locales/it');
    const enFiles = (await fs.readdir(enDir)).filter((f) => f.endsWith('.json')).sort();
    const itFiles = (await fs.readdir(itDir)).filter((f) => f.endsWith('.json')).sort();

    expect(itFiles).toEqual(enFiles);

    for (const file of enFiles) {
      const enJson = JSON.parse(await fs.readFile(path.join(enDir, file), 'utf-8'));
      const itJson = JSON.parse(await fs.readFile(path.join(itDir, file), 'utf-8'));
      expect(collectKeys(itJson).sort()).toEqual(collectKeys(enJson).sort());
    }
  });
});
