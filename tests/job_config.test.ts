import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../server.ts';

/**
 * Characterization of the job configuration lifecycle: update through the API, read back,
 * and reload from persisted state after a restart (same rootDir, new process).
 */
describe('Job configuration lifecycle', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('applies updates, keeps untouched fields and survives a restart', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'telemetry-job-config-'));
    dirs.push(rootDir);

    const first = await createApp({ rootDir, mountFrontend: false });
    const login = await request(first.app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@plant.local', password: process.env.AUTH_ADMIN_PASSWORD });
    const auth = { Authorization: `Bearer ${login.body.token}` };

    const before = await request(first.app).get('/api/v1/job/config').set(auth);
    expect(before.status).toBe(200);

    const update = await request(first.app)
      .put('/api/v1/job/config')
      .set(auth)
      .send({ watchIntervalSec: 30, environment: 'staging' });
    expect(update.status).toBe(200);
    expect(update.body.config.watchIntervalSec).toBe(30);
    expect(update.body.config.environment).toBe('staging');
    expect(update.body.config.windowMinutes).toBe(before.body.config.windowMinutes);
    expect(Date.parse(update.body.updatedAt)).toBeGreaterThanOrEqual(Date.parse(before.body.updatedAt));

    const readBack = await request(first.app).get('/api/v1/job/config').set(auth);
    expect(readBack.body).toEqual(update.body);

    const health = await request(first.app).get('/api/v1/health');
    expect(health.body.environment).toBe('staging');
    await first.drainPendingWrites();

    // Restart on the same state directory: the persisted configuration is reloaded.
    const second = await createApp({ rootDir, mountFrontend: false });
    const relogin = await request(second.app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@plant.local', password: process.env.AUTH_ADMIN_PASSWORD });
    const reloaded = await request(second.app)
      .get('/api/v1/job/config')
      .set({ Authorization: `Bearer ${relogin.body.token}` });
    expect(reloaded.body).toEqual(update.body);
    await second.drainPendingWrites();
  });
});
