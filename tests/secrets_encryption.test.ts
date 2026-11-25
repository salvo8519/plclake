import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AlertEngine } from '../src/alertEngine.ts';
import { AuthAuditManager } from '../src/authAudit.ts';
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  resolveSecretsMasterKey,
} from '../src/security.ts';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'telemetry-erp-secrets-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('AES-256-GCM secrets encryption at rest & scrypt password storage', () => {
  it('encrypts and decrypts secrets with unique IVs, idempotency, and tamper rejection', () => {
    const key = crypto.randomBytes(32);
    const plain = 'Smtp!Plant#2026_Secret';

    const enc1 = encryptSecret(plain, key);
    const enc2 = encryptSecret(plain, key);

    expect(isEncryptedSecret(enc1)).toBe(true);
    expect(enc1).not.toContain(plain);
    expect(enc1).not.toBe(enc2); // fresh 96-bit IV each time
    expect(encryptSecret(enc1, key)).toBe(enc1); // idempotent
    expect(decryptSecret(enc1, key)).toBe(plain);
    expect(decryptSecret(enc2, key)).toBe(plain);

    // Tampering with ciphertext must fail GCM authentication
    const tampered = `${enc1.slice(0, -2)}${enc1.endsWith('aa') ? 'bb' : 'aa'}`;
    expect(() => decryptSecret(tampered, key)).toThrow();
  });

  it('persists SMTP password and webhook signing secret encrypted on disk and auto-migrates legacy plaintext', async () => {
    const dir = await makeTempDir();
    const prevEnvKey = process.env.SECRETS_ENCRYPTION_KEY;
    delete process.env.SECRETS_ENCRYPTION_KEY;

    try {
      const engine = new AlertEngine(dir);
      await engine.init();

      await engine.updateChannels({
        smtp: {
          enabled: true,
          host: 'smtp.plant.local',
          port: 587,
          username: 'alerts@plant.local',
          password: 'SuperSecretSmtpPassword!99',
        },
        webhook: {
          enabled: true,
          url: 'https://hooks.plant.local/alerts',
          signingSecret: 'whsec_live_hmac_secret_12345',
        },
      });

      const persistedRaw = await fs.readFile(path.join(dir, '.state', 'alerts.json'), 'utf-8');
      expect(persistedRaw).not.toContain('SuperSecretSmtpPassword!99');
      expect(persistedRaw).not.toContain('whsec_live_hmac_secret_12345');

      const parsed = JSON.parse(persistedRaw) as {
        smtp: { password: string };
        webhook: { signingSecret: string };
      };
      expect(isEncryptedSecret(parsed.smtp.password)).toBe(true);
      expect(isEncryptedSecret(parsed.webhook.signingSecret)).toBe(true);

      // Public state must never expose secrets (only boolean flags)
      const pub = engine.getPublicState();
      expect(pub.smtp.passwordSet).toBe(true);
      expect(pub.webhook.signingSecretSet).toBe(true);
      expect(JSON.stringify(pub)).not.toContain('SuperSecretSmtpPassword!99');
      expect(JSON.stringify(pub)).not.toContain(parsed.smtp.password);

      // Master key decrypts stored ciphertext cleanly
      const masterKey = await resolveSecretsMasterKey(dir);
      expect(decryptSecret(parsed.smtp.password, masterKey)).toBe('SuperSecretSmtpPassword!99');
      expect(decryptSecret(parsed.webhook.signingSecret, masterKey)).toBe(
        'whsec_live_hmac_secret_12345'
      );

      // Simulate legacy plaintext alerts.json migration on init()
      parsed.smtp.password = 'LegacyPlaintextSmtpPass!';
      parsed.webhook.signingSecret = 'LegacyPlaintextWebhookKey!';
      await fs.writeFile(
        path.join(dir, '.state', 'alerts.json'),
        JSON.stringify(parsed, null, 2),
        'utf-8'
      );

      const reloaded = new AlertEngine(dir);
      await reloaded.init();

      const migratedRaw = await fs.readFile(path.join(dir, '.state', 'alerts.json'), 'utf-8');
      expect(migratedRaw).not.toContain('LegacyPlaintextSmtpPass!');
      expect(migratedRaw).not.toContain('LegacyPlaintextWebhookKey!');
      const migrated = JSON.parse(migratedRaw) as {
        smtp: { password: string };
        webhook: { signingSecret: string };
      };
      expect(isEncryptedSecret(migrated.smtp.password)).toBe(true);
      expect(decryptSecret(migrated.smtp.password, masterKey)).toBe('LegacyPlaintextSmtpPass!');
      expect(decryptSecret(migrated.webhook.signingSecret, masterKey)).toBe(
        'LegacyPlaintextWebhookKey!'
      );
    } finally {
      if (prevEnvKey !== undefined) {
        process.env.SECRETS_ENCRYPTION_KEY = prevEnvKey;
      } else {
        delete process.env.SECRETS_ENCRYPTION_KEY;
      }
    }
  });

  it('stores user passwords strictly as salted scrypt hashes and never in plaintext', async () => {
    const dir = await makeTempDir();
    const auth = new AuthAuditManager(dir);
    await auth.init();

    const userPass = 'PlantOperator#2026!';
    await auth.createUser({
      email: 'sec-check@plant.local',
      fullName: 'Security Check User',
      role: 'operator',
      password: userPass,
    });

    const usersRaw = await fs.readFile(path.join(dir, '.state', 'users.json'), 'utf-8');
    expect(usersRaw).not.toContain(userPass);
    expect(usersRaw).not.toContain('AdminPlant2026!');
    expect(usersRaw).not.toContain('OperatorPlant2026!');

    const loginOk = await auth.authenticateLogin('sec-check@plant.local', userPass);
    expect(loginOk).not.toBeNull();
    expect(loginOk?.user.email).toBe('sec-check@plant.local');

    const loginBad = await auth.authenticateLogin('sec-check@plant.local', 'WrongPassword123');
    expect(loginBad).toBeNull();
  });
});
