import crypto from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import nodemailer from 'nodemailer';
import type { DatabaseStore } from './db.ts';
import { logger } from './logger.ts';
import { metricsRegistry } from './observability.ts';
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  resolveSecretsMasterKey,
  validateOutboundHost,
} from './security.ts';
import { fetchPinned } from './utils/outboundHttp.ts';
import { atomicWriteJson } from './utils/persistence.ts';
import type {
  AlertChannelType,
  AlertDeliveryOutcome,
  AlertEvent,
  AlertMetric,
  AlertOperator,
  AlertRule,
  AlertSeverity,
  AlertsStateResponse,
  MailpitAddress,
  MailpitMessageDetail,
  MailpitMessageDetailResponse,
  MailpitMessageSummary,
  MailpitMessagesResponse,
  MailpitStatusResponse,
  MlFeatureRow,
  SmtpChannelConfig,
  SmtpDiagnosticSendResult,
  SmtpVerifyResult,
  WebhookChannelConfig,
} from './types/pipeline.ts';

async function validateMailpitApiUrl(
  rawUrl: string
): Promise<{ allowed: boolean; normalizedUrl: string; reason?: string; addresses: string[] }> {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return { allowed: false, normalizedUrl: '', reason: 'Mailpit Web UI / API URL is empty.', addresses: [] };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { allowed: false, normalizedUrl: trimmed, reason: 'Invalid Mailpit URL format.', addresses: [] };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      allowed: false,
      normalizedUrl: trimmed,
      reason: 'Mailpit URL must use http:// or https://.',
      addresses: [],
    };
  }
  if (parsed.username || parsed.password) {
    return {
      allowed: false,
      normalizedUrl: trimmed,
      reason: 'Mailpit URL must not embed credentials.',
      addresses: [],
    };
  }

  const hostCheck = await validateOutboundHost(parsed.hostname, { allowLoopback: true });
  if (!hostCheck.allowed) {
    return {
      allowed: false,
      normalizedUrl: trimmed,
      reason: `SSRF_BLOCKED: ${hostCheck.reason ?? 'Disallowed Mailpit host.'}`,
      addresses: [],
    };
  }

  return {
    allowed: true,
    normalizedUrl: `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, ''),
    addresses: hostCheck.addresses,
  };
}

function formatMailpitAddress(addr?: MailpitAddress | null): string {
  if (!addr) return '';
  if (addr.Name && addr.Address) return `${addr.Name} <${addr.Address}>`;
  return addr.Address || addr.Name || '';
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

interface PersistedAlertsState {
  smtp: {
    enabled: boolean;
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password: string;
    fromAddress: string;
    recipients: string[];
    mailpitUiUrl: string;
  };
  webhook: {
    enabled: boolean;
    url: string;
    signingSecret: string;
    timeoutMs: number;
  };
  rules: AlertRule[];
  recentEvents: AlertEvent[];
  updatedAt: string;
}

const DEFAULT_RULES: AlertRule[] = [
  {
    id: 'rule-temp-critical',
    name: 'Over-Temperature Critical (> 85 °C)',
    enabled: true,
    metric: 'temp_max',
    operator: 'gt',
    threshold: 85,
    severity: 'critical',
    channels: ['email', 'webhook'],
    cooldownSec: 180,
    domainFilter: null,
    machineTypeFilter: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'rule-fault-burst',
    name: 'Repeated PLC Faults (>= 2 in window)',
    enabled: true,
    metric: 'fault_count',
    operator: 'gte',
    threshold: 2,
    severity: 'warning',
    channels: ['email', 'webhook'],
    cooldownSec: 300,
    domainFilter: null,
    machineTypeFilter: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'rule-oee-drop',
    name: 'Availability Drop (< 80%)',
    enabled: true,
    metric: 'availability_pct',
    operator: 'lt',
    threshold: 80,
    severity: 'warning',
    channels: ['email'],
    cooldownSec: 300,
    domainFilter: null,
    machineTypeFilter: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

function createDefaultState(): PersistedAlertsState {
  return {
    smtp: {
      enabled: Boolean(process.env.SMTP_HOST),
      host: process.env.SMTP_HOST?.trim() || '127.0.0.1',
      port: Number(process.env.SMTP_PORT) || 1025,
      secure: process.env.SMTP_SECURE === 'true',
      username: process.env.SMTP_USER?.trim() || '',
      password: process.env.SMTP_PASS || '',
      fromAddress: process.env.SMTP_FROM?.trim() || 'alerts@telemetry.plant.local',
      recipients: (process.env.ALERT_EMAIL_TO || 'maintenance@plant.local')
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean),
      mailpitUiUrl: process.env.MAILPIT_UI_URL?.trim() || 'http://localhost:8025',
    },
    webhook: {
      enabled: Boolean(process.env.ALERT_WEBHOOK_URL),
      url: process.env.ALERT_WEBHOOK_URL?.trim() || '',
      signingSecret: process.env.ALERT_WEBHOOK_SECRET || '',
      timeoutMs: 4000,
    },
    rules: DEFAULT_RULES.map((r) => ({ ...r, channels: [...r.channels] })),
    recentEvents: [],
    updatedAt: new Date().toISOString(),
  };
}

function compareMetric(value: number, op: AlertOperator, threshold: number): boolean {
  if (op === 'gt') return value > threshold;
  if (op === 'gte') return value >= threshold;
  if (op === 'lt') return value < threshold;
  return value <= threshold;
}

function extractFeatureMetric(row: MlFeatureRow, metric: AlertMetric): number {
  switch (metric) {
    case 'temp_max':
      return row.temp_max;
    case 'temp_mean':
      return row.temp_mean;
    case 'primary_metric_mean':
      return row.primary_metric_mean;
    case 'primary_metric_p95':
      return row.primary_metric_p95;
    case 'fault_count':
      return row.fault_count;
    case 'is_anomalous_window':
      return row.is_anomalous_window;
    case 'availability_pct': {
      const windowSec = Math.max(60, row.window_minutes * 60);
      return Number(Math.max(0, 100 * (1 - row.time_in_fault_sec / windowSec)).toFixed(2));
    }
  }
}

export class AlertEngine {
  private rootDir: string;
  private stateFile: string;
  private dbStore: DatabaseStore | null;
  private state: PersistedAlertsState;
  private masterKey: Buffer | null = null;
  private cooldownMap = new Map<string, number>();

  constructor(rootDir: string, dbStore?: DatabaseStore) {
    this.rootDir = rootDir;
    this.stateFile = path.resolve(rootDir, '.state', 'alerts.json');
    this.dbStore = dbStore ?? null;
    this.state = createDefaultState();
  }

  private async getMasterKey(): Promise<Buffer> {
    if (!this.masterKey) {
      this.masterKey = await resolveSecretsMasterKey(this.rootDir);
    }
    return this.masterKey;
  }

  async init(): Promise<void> {
    const key = await this.getMasterKey();
    let loaded: Partial<PersistedAlertsState> | null = null;
    try {
      if (this.dbStore?.isPostgresActive()) {
        loaded = await this.dbStore.getState<Partial<PersistedAlertsState>>('alerts_state');
      }
    } catch {
      // Fallback to local state file
    }
    if (!loaded) {
      try {
        const raw = await fs.readFile(this.stateFile, 'utf-8');
        loaded = JSON.parse(raw) as Partial<PersistedAlertsState>;
      } catch {
        // Fresh default state
      }
    }

    let needsEncryptionMigration = false;
    if (loaded) {
      if (loaded.smtp) {
        const rawPass = typeof loaded.smtp.password === 'string' ? loaded.smtp.password : '';
        let decodedPass = '';
        if (rawPass) {
          if (!isEncryptedSecret(rawPass)) {
            needsEncryptionMigration = true;
            decodedPass = rawPass;
          } else {
            try {
              decodedPass = decryptSecret(rawPass, key);
            } catch (err) {
              logger.warn('alerting', 'smtp_password_decrypt_failed', {
                reason: err instanceof Error ? err.message : 'decrypt_error',
              });
              decodedPass = '';
            }
          }
        }
        this.state.smtp = { ...this.state.smtp, ...loaded.smtp, password: decodedPass };
      }
      if (loaded.webhook) {
        const rawSecret =
          typeof loaded.webhook.signingSecret === 'string' ? loaded.webhook.signingSecret : '';
        let decodedSecret = '';
        if (rawSecret) {
          if (!isEncryptedSecret(rawSecret)) {
            needsEncryptionMigration = true;
            decodedSecret = rawSecret;
          } else {
            try {
              decodedSecret = decryptSecret(rawSecret, key);
            } catch (err) {
              logger.warn('alerting', 'webhook_secret_decrypt_failed', {
                reason: err instanceof Error ? err.message : 'decrypt_error',
              });
              decodedSecret = '';
            }
          }
        }
        this.state.webhook = {
          ...this.state.webhook,
          ...loaded.webhook,
          signingSecret: decodedSecret,
        };
      }
      if (Array.isArray(loaded.rules)) {
        this.state.rules = loaded.rules;
      }
      if (Array.isArray(loaded.recentEvents)) {
        this.state.recentEvents = loaded.recentEvents.slice(0, 200);
      }
      if (typeof loaded.updatedAt === 'string') {
        this.state.updatedAt = loaded.updatedAt;
      }
    }

    if (needsEncryptionMigration) {
      await this.persist();
    }
  }

  private async persist(): Promise<void> {
    this.state.updatedAt = new Date().toISOString();
    const key = await this.getMasterKey();
    const encryptedPayload: PersistedAlertsState = {
      ...this.state,
      smtp: {
        ...this.state.smtp,
        password: this.state.smtp.password ? encryptSecret(this.state.smtp.password, key) : '',
      },
      webhook: {
        ...this.state.webhook,
        signingSecret: this.state.webhook.signingSecret
          ? encryptSecret(this.state.webhook.signingSecret, key)
          : '',
      },
    };

    try {
      if (this.dbStore?.isPostgresActive()) {
        await this.dbStore.saveState('alerts_state', encryptedPayload);
      }
    } catch {
      // Mirror locally
    }
    try {
      await atomicWriteJson(this.stateFile, encryptedPayload, true, 0o600);
    } catch {
      // Non-fatal in ephemeral containers
    }
  }

  getPublicState(): AlertsStateResponse {
    const smtp: SmtpChannelConfig = {
      enabled: this.state.smtp.enabled,
      host: this.state.smtp.host,
      port: this.state.smtp.port,
      secure: this.state.smtp.secure,
      username: this.state.smtp.username,
      passwordSet: Boolean(this.state.smtp.password),
      fromAddress: this.state.smtp.fromAddress,
      recipients: [...this.state.smtp.recipients],
      mailpitUiUrl: this.state.smtp.mailpitUiUrl,
    };
    const webhook: WebhookChannelConfig = {
      enabled: this.state.webhook.enabled,
      url: this.state.webhook.url,
      signingSecretSet: Boolean(this.state.webhook.signingSecret),
      timeoutMs: this.state.webhook.timeoutMs,
    };
    return {
      smtp,
      webhook,
      rules: this.state.rules.map((r) => ({ ...r, channels: [...r.channels] })),
      recentEvents: this.state.recentEvents.slice(0, 100),
      updatedAt: this.state.updatedAt,
    };
  }

  async updateChannels(patch: {
    smtp?: Partial<PersistedAlertsState['smtp']>;
    webhook?: Partial<PersistedAlertsState['webhook']>;
  }): Promise<AlertsStateResponse> {
    if (patch.smtp) {
      const s = patch.smtp;
      if (typeof s.enabled === 'boolean') this.state.smtp.enabled = s.enabled;
      if (typeof s.host === 'string' && s.host.trim()) this.state.smtp.host = s.host.trim().slice(0, 128);
      if (Number.isInteger(Number(s.port)) && Number(s.port) >= 1 && Number(s.port) <= 65535) {
        this.state.smtp.port = Number(s.port);
      }
      if (typeof s.secure === 'boolean') this.state.smtp.secure = s.secure;
      if (typeof s.username === 'string') this.state.smtp.username = s.username.trim().slice(0, 128);
      if (typeof s.password === 'string' && s.password.length > 0) {
        this.state.smtp.password = s.password;
      }
      if (typeof s.fromAddress === 'string' && s.fromAddress.trim()) {
        this.state.smtp.fromAddress = s.fromAddress.trim().slice(0, 128);
      }
      if (Array.isArray(s.recipients)) {
        this.state.smtp.recipients = s.recipients
          .map((r) => String(r).trim())
          .filter((r) => r.includes('@'))
          .slice(0, 20);
      }
      if (typeof s.mailpitUiUrl === 'string') {
        this.state.smtp.mailpitUiUrl = s.mailpitUiUrl.trim().slice(0, 200);
      }
    }

    if (patch.webhook) {
      const w = patch.webhook;
      if (typeof w.enabled === 'boolean') this.state.webhook.enabled = w.enabled;
      if (typeof w.url === 'string') this.state.webhook.url = w.url.trim().slice(0, 300);
      if (typeof w.signingSecret === 'string' && w.signingSecret.length > 0) {
        this.state.webhook.signingSecret = w.signingSecret;
      }
      if (Number.isFinite(Number(w.timeoutMs))) {
        this.state.webhook.timeoutMs = Math.min(15000, Math.max(1000, Number(w.timeoutMs)));
      }
    }

    await this.persist();
    return this.getPublicState();
  }

  async upsertRule(input: Partial<AlertRule>): Promise<{ rule: AlertRule; state: AlertsStateResponse }> {
    const existing = input.id ? this.state.rules.find((r) => r.id === input.id) : undefined;
    const validChannels: AlertChannelType[] = Array.isArray(input.channels)
      ? input.channels.filter((c): c is AlertChannelType => c === 'email' || c === 'webhook')
      : existing?.channels ?? ['email'];

    const rule: AlertRule = {
      id: existing?.id ?? `rule-${crypto.randomUUID().slice(0, 8)}`,
      name:
        typeof input.name === 'string' && input.name.trim()
          ? input.name.trim().slice(0, 90)
          : existing?.name ?? 'Custom Threshold Alert',
      enabled: typeof input.enabled === 'boolean' ? input.enabled : existing?.enabled ?? true,
      metric:
        input.metric &&
        [
          'temp_max',
          'temp_mean',
          'primary_metric_mean',
          'primary_metric_p95',
          'fault_count',
          'is_anomalous_window',
          'availability_pct',
        ].includes(input.metric)
          ? input.metric
          : existing?.metric ?? 'temp_max',
      operator:
        input.operator && ['gt', 'gte', 'lt', 'lte'].includes(input.operator)
          ? input.operator
          : existing?.operator ?? 'gt',
      threshold: Number.isFinite(Number(input.threshold))
        ? Number(input.threshold)
        : existing?.threshold ?? 85,
      severity:
        input.severity && ['info', 'warning', 'critical'].includes(input.severity)
          ? (input.severity as AlertSeverity)
          : existing?.severity ?? 'warning',
      channels: validChannels.length > 0 ? validChannels : ['email'],
      cooldownSec: Math.min(3600, Math.max(10, Number(input.cooldownSec ?? existing?.cooldownSec ?? 180))),
      domainFilter: input.domainFilter !== undefined ? input.domainFilter : existing?.domainFilter ?? null,
      machineTypeFilter:
        input.machineTypeFilter !== undefined ? input.machineTypeFilter : existing?.machineTypeFilter ?? null,
      updatedAt: new Date().toISOString(),
    };

    if (existing) {
      const idx = this.state.rules.findIndex((r) => r.id === existing.id);
      this.state.rules[idx] = rule;
    } else {
      this.state.rules.unshift(rule);
    }
    await this.persist();
    return { rule, state: this.getPublicState() };
  }

  async deleteRule(ruleId: string): Promise<{ deleted: boolean; state: AlertsStateResponse }> {
    const before = this.state.rules.length;
    this.state.rules = this.state.rules.filter((r) => r.id !== ruleId);
    const deleted = this.state.rules.length < before;
    if (deleted) await this.persist();
    return { deleted, state: this.getPublicState() };
  }

  async acknowledgeEvent(
    eventId: string,
    actor: string,
    note?: string
  ): Promise<AlertEvent | null> {
    const ev = this.state.recentEvents.find((e) => e.id === eventId);
    if (!ev) return null;
    const now = new Date().toISOString();
    ev.acknowledgedAt = now;
    ev.acknowledgedBy = actor;
    const cleanNote = typeof note === 'string' ? note.trim().slice(0, 1000) : undefined;
    if (cleanNote !== undefined) {
      ev.acknowledgementNote = cleanNote || null;
    }
    const history = Array.isArray(ev.actionHistory) ? ev.actionHistory : [];
    history.push({
      action: 'acknowledged',
      actor,
      at: now,
      note: cleanNote || null,
    });
    ev.actionHistory = history.slice(-25);
    await this.persist();
    return ev;
  }

  async reopenEvent(
    eventId: string,
    actor: string,
    reason?: string
  ): Promise<AlertEvent | null> {
    const ev = this.state.recentEvents.find((e) => e.id === eventId);
    if (!ev) return null;
    const now = new Date().toISOString();
    ev.acknowledgedAt = null;
    ev.acknowledgedBy = null;
    ev.reopenedAt = now;
    ev.reopenedBy = actor;
    const cleanReason = typeof reason === 'string' ? reason.trim().slice(0, 1000) : '';
    const history = Array.isArray(ev.actionHistory) ? ev.actionHistory : [];
    history.push({
      action: 'reopened',
      actor,
      at: now,
      note: cleanReason || null,
    });
    ev.actionHistory = history.slice(-25);
    await this.persist();
    return ev;
  }

  async updateEventNote(
    eventId: string,
    actor: string,
    note: string
  ): Promise<AlertEvent | null> {
    const ev = this.state.recentEvents.find((e) => e.id === eventId);
    if (!ev) return null;
    const now = new Date().toISOString();
    const cleanNote = note.trim().slice(0, 1000);
    ev.acknowledgementNote = cleanNote || null;
    const history = Array.isArray(ev.actionHistory) ? ev.actionHistory : [];
    history.push({
      action: 'note_updated',
      actor,
      at: now,
      note: cleanNote || null,
    });
    ev.actionHistory = history.slice(-25);
    await this.persist();
    return ev;
  }

  /**
   * @param validatedAddresses addresses approved by the SSRF policy: the transport connects to
   * the first one, while TLS still verifies the certificate against the configured host name.
   */
  private createSmtpTransporter(validatedAddresses: readonly string[]) {
    const configuredHost = this.state.smtp.host.trim();
    const rejectUnauthorized = this.state.smtp.secure
      ? process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== 'false'
      : process.env.SMTP_TLS_REJECT_UNAUTHORIZED === 'true';

    return nodemailer.createTransport({
      host: validatedAddresses[0] ?? configuredHost,
      port: this.state.smtp.port,
      secure: this.state.smtp.secure,
      connectionTimeout: 4000,
      greetingTimeout: 4000,
      socketTimeout: 5000,
      ...(this.state.smtp.username
        ? {
            auth: {
              user: this.state.smtp.username,
              pass: this.state.smtp.password,
            },
          }
        : {}),
      tls: {
        rejectUnauthorized,
        // SNI and certificate verification use the configured name, not the pinned IP.
        ...(net.isIP(configuredHost) ? {} : { servername: configuredHost }),
      },
    });
  }

  async verifySmtpConnection(): Promise<SmtpVerifyResult> {
    const checkedAt = new Date().toISOString();
    const startMs = Date.now();
    if (!this.state.smtp.host) {
      return {
        reachable: false,
        host: '',
        port: this.state.smtp.port,
        secure: this.state.smtp.secure,
        authConfigured: Boolean(this.state.smtp.username),
        latencyMs: 0,
        checkedAt,
        error: 'SMTP host is not configured.',
      };
    }

    const smtpHostCheck = await validateOutboundHost(this.state.smtp.host, { allowLoopback: true });
    if (!smtpHostCheck.allowed) {
      return {
        reachable: false,
        host: this.state.smtp.host,
        port: this.state.smtp.port,
        secure: this.state.smtp.secure,
        authConfigured: Boolean(this.state.smtp.username),
        latencyMs: 0,
        checkedAt,
        error: `SSRF_BLOCKED: ${smtpHostCheck.reason ?? 'Disallowed SMTP host.'}`,
      };
    }

    try {
      const transporter = this.createSmtpTransporter(smtpHostCheck.addresses);
      await transporter.verify();
      return {
        reachable: true,
        host: this.state.smtp.host,
        port: this.state.smtp.port,
        secure: this.state.smtp.secure,
        authConfigured: Boolean(this.state.smtp.username),
        latencyMs: Date.now() - startMs,
        checkedAt,
        error: null,
      };
    } catch (err) {
      return {
        reachable: false,
        host: this.state.smtp.host,
        port: this.state.smtp.port,
        secure: this.state.smtp.secure,
        authConfigured: Boolean(this.state.smtp.username),
        latencyMs: Date.now() - startMs,
        checkedAt,
        error: err instanceof Error ? err.message : 'SMTP handshake verification failed',
      };
    }
  }

  async sendDiagnosticEmail(options?: {
    recipient?: string;
    subject?: string;
    body?: string;
  }): Promise<SmtpDiagnosticSendResult> {
    const sentAt = new Date().toISOString();
    const startMs = Date.now();
    const recipients = options?.recipient
      ? options.recipient
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean)
      : [...this.state.smtp.recipients];

    const subject =
      options?.subject?.trim()
        ? options.subject.trim().slice(0, 160)
        : `[Industrial Telemetry] SMTP Diagnostic Test (${sentAt.slice(11, 19)} UTC)`;

    const textBody =
      options?.body?.trim()
        ? options.body.trim().slice(0, 4000)
        : `Diagnostic test email dispatched at ${sentAt}.\nConfigured SMTP relay: ${this.state.smtp.host}:${this.state.smtp.port} (TLS=${this.state.smtp.secure ? 'implicit' : 'plain/starttls'}).`;

    if (!this.state.smtp.host || recipients.length === 0) {
      return {
        outcome: {
          channel: 'email',
          status: 'failed',
          target: `${this.state.smtp.host}:${this.state.smtp.port}`,
          error: 'SMTP host or recipients missing.',
          sentAt,
        },
        latencyMs: Date.now() - startMs,
        smtpResponse: null,
        subject,
        recipients,
      };
    }

    const htmlBody = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:600px;padding:16px;border:1px solid #cbd5e1;border-radius:6px;background:#ffffff;color:#0f172a;">
      <h3 style="margin:0 0 8px;font-size:15px;color:#0f172a;">${escapeHtml(subject)}</h3>
      <p style="margin:0 0 12px;font-size:13px;line-height:1.5;color:#334155;white-space:pre-line;">${escapeHtml(textBody)}</p>
      <div style="padding-top:10px;border-top:1px solid #e2e8f0;font-size:11px;color:#64748b;font-family:monospace;">
        SMTP: ${escapeHtml(this.state.smtp.host)}:${this.state.smtp.port} &middot; Sent: ${escapeHtml(sentAt)}
      </div>
    </div>`;

    const smtpHostCheck = await validateOutboundHost(this.state.smtp.host, { allowLoopback: true });
    if (!smtpHostCheck.allowed) {
      return {
        outcome: {
          channel: 'email',
          status: 'failed',
          target: `${this.state.smtp.host}:${this.state.smtp.port}`,
          error: `SSRF_BLOCKED: ${smtpHostCheck.reason ?? 'Disallowed SMTP host.'}`,
          sentAt,
        },
        latencyMs: Date.now() - startMs,
        smtpResponse: null,
        subject,
        recipients,
      };
    }

    try {
      const transporter = this.createSmtpTransporter(smtpHostCheck.addresses);
      const info = await transporter.sendMail({
        from: this.state.smtp.fromAddress,
        to: recipients.join(', '),
        subject,
        text: textBody,
        html: htmlBody,
      });

      return {
        outcome: {
          channel: 'email',
          status: 'sent',
          target: `${this.state.smtp.host}:${this.state.smtp.port} -> ${recipients.join(', ')}`,
          messageId: info.messageId ?? null,
          sentAt,
        },
        latencyMs: Date.now() - startMs,
        smtpResponse: typeof info.response === 'string' ? info.response : null,
        subject,
        recipients,
      };
    } catch (err) {
      return {
        outcome: {
          channel: 'email',
          status: 'failed',
          target: `${this.state.smtp.host}:${this.state.smtp.port}`,
          error: err instanceof Error ? err.message : 'SMTP delivery failed',
          sentAt,
        },
        latencyMs: Date.now() - startMs,
        smtpResponse: null,
        subject,
        recipients,
      };
    }
  }

  async fetchMailpitStatus(apiBaseUrl?: string): Promise<MailpitStatusResponse> {
    const checkedAt = new Date().toISOString();
    const startMs = Date.now();
    const candidateBase = apiBaseUrl?.trim() || this.state.smtp.mailpitUiUrl;
    const validation = await validateMailpitApiUrl(candidateBase);
    if (!validation.allowed) {
      return {
        connected: false,
        apiBaseUrl: candidateBase,
        latencyMs: Date.now() - startMs,
        checkedAt,
        queueDepth: 0,
        unreadCount: 0,
        version: null,
        databaseSizeBytes: null,
        uptimeSec: null,
        smtpAccepted: null,
        smtpRejected: null,
        error: validation.reason ?? 'Invalid Mailpit URL',
      };
    }

    try {
      const infoResp = await fetchPinned(`${validation.normalizedUrl}/api/v1/info`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(4000),
      }, validation.addresses);

      if (infoResp.ok) {
        const info = (await infoResp.json()) as {
          Version?: string;
          DatabaseSize?: number;
          Messages?: number;
          Unread?: number;
          RuntimeStats?: {
            Uptime?: number;
            SMTPAccepted?: number;
            SMTPRejected?: number;
          };
        };

        return {
          connected: true,
          apiBaseUrl: validation.normalizedUrl,
          latencyMs: Date.now() - startMs,
          checkedAt,
          queueDepth: Number(info.Messages ?? 0),
          unreadCount: Number(info.Unread ?? 0),
          version: typeof info.Version === 'string' ? info.Version : null,
          databaseSizeBytes:
            typeof info.DatabaseSize === 'number' ? info.DatabaseSize : null,
          uptimeSec:
            typeof info.RuntimeStats?.Uptime === 'number' ? info.RuntimeStats.Uptime : null,
          smtpAccepted:
            typeof info.RuntimeStats?.SMTPAccepted === 'number'
              ? info.RuntimeStats.SMTPAccepted
              : null,
          smtpRejected:
            typeof info.RuntimeStats?.SMTPRejected === 'number'
              ? info.RuntimeStats.SMTPRejected
              : null,
          error: null,
        };
      }

      // Fallback to /api/v1/messages?limit=1 if /api/v1/info is unavailable on an older Mailpit build
      if (infoResp.status === 404) {
        const msgResp = await fetchPinned(`${validation.normalizedUrl}/api/v1/messages?limit=1`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(4000),
        }, validation.addresses);
        if (msgResp.ok) {
          const raw = (await msgResp.json()) as { total?: number; unread?: number };
          return {
            connected: true,
            apiBaseUrl: validation.normalizedUrl,
            latencyMs: Date.now() - startMs,
            checkedAt,
            queueDepth: Number(raw.total ?? 0),
            unreadCount: Number(raw.unread ?? 0),
            version: null,
            databaseSizeBytes: null,
            uptimeSec: null,
            smtpAccepted: null,
            smtpRejected: null,
            error: null,
          };
        }
      }

      return {
        connected: false,
        apiBaseUrl: validation.normalizedUrl,
        latencyMs: Date.now() - startMs,
        checkedAt,
        queueDepth: 0,
        unreadCount: 0,
        version: null,
        databaseSizeBytes: null,
        uptimeSec: null,
        smtpAccepted: null,
        smtpRejected: null,
        error: `Mailpit API returned HTTP ${infoResp.status}`,
      };
    } catch (err) {
      return {
        connected: false,
        apiBaseUrl: validation.normalizedUrl,
        latencyMs: Date.now() - startMs,
        checkedAt,
        queueDepth: 0,
        unreadCount: 0,
        version: null,
        databaseSizeBytes: null,
        uptimeSec: null,
        smtpAccepted: null,
        smtpRejected: null,
        error: err instanceof Error ? err.message : 'Unable to reach Mailpit API',
      };
    }
  }

  async fetchMailpitMessages(options?: {
    limit?: number;
    query?: string;
    apiBaseUrl?: string;
  }): Promise<MailpitMessagesResponse> {
    const checkedAt = new Date().toISOString();
    const startMs = Date.now();
    const candidateBase = options?.apiBaseUrl?.trim() || this.state.smtp.mailpitUiUrl;
    const validation = await validateMailpitApiUrl(candidateBase);
    if (!validation.allowed) {
      return {
        reachable: false,
        apiBaseUrl: candidateBase,
        latencyMs: Date.now() - startMs,
        checkedAt,
        total: 0,
        unread: 0,
        messagesCount: 0,
        messages: [],
        error: validation.reason ?? 'Invalid Mailpit URL',
      };
    }

    const limit = Math.min(100, Math.max(1, Number(options?.limit) || 25));
    const searchQuery = options?.query?.trim() || '';
    const endpoint = searchQuery
      ? `${validation.normalizedUrl}/api/v1/search?query=${encodeURIComponent(searchQuery)}&limit=${limit}`
      : `${validation.normalizedUrl}/api/v1/messages?limit=${limit}`;

    try {
      const resp = await fetchPinned(endpoint, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(4000),
      }, validation.addresses);
      if (!resp.ok) {
        return {
          reachable: false,
          apiBaseUrl: validation.normalizedUrl,
          latencyMs: Date.now() - startMs,
          checkedAt,
          total: 0,
          unread: 0,
          messagesCount: 0,
          messages: [],
          error: `Mailpit API returned HTTP ${resp.status}`,
        };
      }

      const raw = (await resp.json()) as {
        total?: number;
        unread?: number;
        messages_count?: number;
        messages?: Array<{
          ID?: string;
          MessageID?: string;
          From?: MailpitAddress;
          To?: MailpitAddress[];
          Subject?: string;
          Snippet?: string;
          Created?: string;
          Size?: number;
          Read?: boolean;
          Attachments?: number;
        }>;
      };

      const mapped: MailpitMessageSummary[] = Array.isArray(raw.messages)
        ? raw.messages.map((m) => ({
            id: String(m.ID ?? ''),
            messageId: String(m.MessageID ?? ''),
            from: formatMailpitAddress(m.From),
            to: Array.isArray(m.To) ? m.To.map((t) => formatMailpitAddress(t)).filter(Boolean) : [],
            subject: String(m.Subject ?? '(no subject)'),
            snippet: String(m.Snippet ?? ''),
            createdAt: String(m.Created ?? checkedAt),
            sizeBytes: Number(m.Size ?? 0),
            read: Boolean(m.Read),
            attachments: Number(m.Attachments ?? 0),
          }))
        : [];

      return {
        reachable: true,
        apiBaseUrl: validation.normalizedUrl,
        latencyMs: Date.now() - startMs,
        checkedAt,
        total: Number(raw.total ?? mapped.length),
        unread: Number(raw.unread ?? 0),
        messagesCount: Number(raw.messages_count ?? mapped.length),
        messages: mapped,
        error: null,
      };
    } catch (err) {
      return {
        reachable: false,
        apiBaseUrl: validation.normalizedUrl,
        latencyMs: Date.now() - startMs,
        checkedAt,
        total: 0,
        unread: 0,
        messagesCount: 0,
        messages: [],
        error: err instanceof Error ? err.message : 'Unable to reach Mailpit API',
      };
    }
  }

  async fetchMailpitMessageDetail(
    messageId: string,
    apiBaseUrl?: string
  ): Promise<MailpitMessageDetailResponse> {
    const candidateBase = apiBaseUrl?.trim() || this.state.smtp.mailpitUiUrl;
    const validation = await validateMailpitApiUrl(candidateBase);
    if (!validation.allowed) {
      return {
        reachable: false,
        apiBaseUrl: candidateBase,
        message: null,
        error: validation.reason ?? 'Invalid Mailpit URL',
      };
    }

    const safeId = messageId.trim();
    if (!safeId || !/^[a-zA-Z0-9._-]+$/.test(safeId)) {
      return {
        reachable: false,
        apiBaseUrl: validation.normalizedUrl,
        message: null,
        error: 'Invalid Mailpit message ID.',
      };
    }

    try {
      const msgResp = await fetchPinned(
        `${validation.normalizedUrl}/api/v1/message/${encodeURIComponent(safeId)}`,
        {
          method: 'GET',
          headers: { Accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(4000),
        }, validation.addresses);
      if (!msgResp.ok) {
        return {
          reachable: false,
          apiBaseUrl: validation.normalizedUrl,
          message: null,
          error: `Mailpit message endpoint returned HTTP ${msgResp.status}`,
        };
      }

      const raw = (await msgResp.json()) as {
        ID?: string;
        MessageID?: string;
        From?: MailpitAddress;
        To?: MailpitAddress[];
        Cc?: MailpitAddress[];
        Subject?: string;
        Date?: string;
        Created?: string;
        Size?: number;
        Text?: string;
        HTML?: string;
        Headers?: Record<string, string[]>;
      };

      let headers: Record<string, string[]> =
        raw.Headers && typeof raw.Headers === 'object' ? raw.Headers : {};
      if (Object.keys(headers).length === 0) {
        try {
          const hdrResp = await fetchPinned(
            `${validation.normalizedUrl}/api/v1/message/${encodeURIComponent(safeId)}/headers`,
            {
              method: 'GET',
              headers: { Accept: 'application/json' },
              redirect: 'error',
              signal: AbortSignal.timeout(2500),
            }, validation.addresses);
          if (hdrResp.ok) {
            const parsedHdr = (await hdrResp.json()) as Record<string, string[]>;
            if (parsedHdr && typeof parsedHdr === 'object') {
              headers = parsedHdr;
            }
          }
        } catch {
          // Optional headers endpoint
        }
      }

      const detail: MailpitMessageDetail = {
        id: String(raw.ID ?? safeId),
        messageId: String(raw.MessageID ?? ''),
        from: formatMailpitAddress(raw.From),
        to: Array.isArray(raw.To) ? raw.To.map((t) => formatMailpitAddress(t)).filter(Boolean) : [],
        cc: Array.isArray(raw.Cc) ? raw.Cc.map((t) => formatMailpitAddress(t)).filter(Boolean) : [],
        subject: String(raw.Subject ?? '(no subject)'),
        createdAt: String(raw.Date ?? raw.Created ?? ''),
        sizeBytes: Number(raw.Size ?? 0),
        text: String(raw.Text ?? ''),
        html: String(raw.HTML ?? ''),
        headers,
      };

      return {
        reachable: true,
        apiBaseUrl: validation.normalizedUrl,
        message: detail,
        error: null,
      };
    } catch (err) {
      return {
        reachable: false,
        apiBaseUrl: validation.normalizedUrl,
        message: null,
        error: err instanceof Error ? err.message : 'Unable to fetch Mailpit message detail',
      };
    }
  }

  async clearMailpitInbox(apiBaseUrl?: string): Promise<{
    cleared: boolean;
    apiBaseUrl: string;
    error?: string | null;
  }> {
    const candidateBase = apiBaseUrl?.trim() || this.state.smtp.mailpitUiUrl;
    const validation = await validateMailpitApiUrl(candidateBase);
    if (!validation.allowed) {
      return {
        cleared: false,
        apiBaseUrl: candidateBase,
        error: validation.reason ?? 'Invalid Mailpit URL',
      };
    }

    try {
      const resp = await fetchPinned(`${validation.normalizedUrl}/api/v1/messages`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        redirect: 'error',
        signal: AbortSignal.timeout(4000),
      }, validation.addresses);
      if (!resp.ok) {
        return {
          cleared: false,
          apiBaseUrl: validation.normalizedUrl,
          error: `Mailpit DELETE /api/v1/messages returned HTTP ${resp.status}`,
        };
      }
      return { cleared: true, apiBaseUrl: validation.normalizedUrl, error: null };
    } catch (err) {
      return {
        cleared: false,
        apiBaseUrl: validation.normalizedUrl,
        error: err instanceof Error ? err.message : 'Unable to clear Mailpit inbox',
      };
    }
  }

  async sendEmailViaSmtp(
    subject: string,
    textBody: string,
    htmlBody: string,
    overrideRecipients?: string[]
  ): Promise<AlertDeliveryOutcome> {
    const sentAt = new Date().toISOString();
    const recipients =
      overrideRecipients && overrideRecipients.length > 0
        ? overrideRecipients
        : this.state.smtp.recipients;

    if (!this.state.smtp.host || recipients.length === 0) {
      return {
        channel: 'email',
        status: 'failed',
        target: `${this.state.smtp.host}:${this.state.smtp.port}`,
        error: 'SMTP host or recipients missing.',
        sentAt,
      };
    }

    const smtpHostCheck = await validateOutboundHost(this.state.smtp.host, { allowLoopback: true });
    if (!smtpHostCheck.allowed) {
      return {
        channel: 'email',
        status: 'failed',
        target: `${this.state.smtp.host}:${this.state.smtp.port}`,
        error: `SSRF_BLOCKED: ${smtpHostCheck.reason ?? 'Disallowed SMTP host.'}`,
        sentAt,
      };
    }

    try {
      const transporter = this.createSmtpTransporter(smtpHostCheck.addresses);

      const info = await transporter.sendMail({
        from: this.state.smtp.fromAddress,
        to: recipients.join(', '),
        subject,
        text: textBody,
        html: htmlBody,
      });

      metricsRegistry.recordAlertDelivery('email', 'sent');
      logger.info('alerting', 'SMTP alert email delivered', {
        target: `${this.state.smtp.host}:${this.state.smtp.port}`,
        recipientsCount: recipients.length,
        messageId: info.messageId ?? null,
      });

      return {
        channel: 'email',
        status: 'sent',
        target: `${this.state.smtp.host}:${this.state.smtp.port} -> ${recipients.join(', ')}`,
        messageId: info.messageId ?? null,
        sentAt,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'SMTP delivery failed';
      metricsRegistry.recordAlertDelivery('email', 'failed');
      logger.warn('alerting', 'SMTP alert email failed', {
        target: `${this.state.smtp.host}:${this.state.smtp.port}`,
        error: errMsg,
      });
      return {
        channel: 'email',
        status: 'failed',
        target: `${this.state.smtp.host}:${this.state.smtp.port}`,
        error: errMsg,
        sentAt,
      };
    }
  }

  async sendWebhook(payload: Record<string, unknown>, overrideUrl?: string): Promise<AlertDeliveryOutcome> {
    const sentAt = new Date().toISOString();
    const targetUrl = (overrideUrl || this.state.webhook.url).trim();
    if (!targetUrl) {
      return {
        channel: 'webhook',
        status: 'failed',
        target: '(unset)',
        error: 'Webhook URL is not configured.',
        sentAt,
      };
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(targetUrl);
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error('Webhook URL must use http:// or https://');
      }
    } catch (err) {
      return {
        channel: 'webhook',
        status: 'failed',
        target: targetUrl,
        error: err instanceof Error ? err.message : 'Invalid Webhook URL',
        sentAt,
      };
    }

    const hostCheck = await validateOutboundHost(parsedUrl.hostname);
    if (!hostCheck.allowed) {
      return {
        channel: 'webhook',
        status: 'failed',
        target: targetUrl,
        error: `SSRF_BLOCKED: ${hostCheck.reason}`,
        sentAt,
      };
    }

    const bodyStr = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Industrial-Telemetry-AlertEngine/1.0',
    };
    if (this.state.webhook.signingSecret) {
      const sig = crypto
        .createHmac('sha256', this.state.webhook.signingSecret)
        .update(bodyStr)
        .digest('hex');
      headers['X-Telemetry-Signature'] = `sha256=${sig}`;
    }

    try {
      const resp = await fetchPinned(targetUrl, {
        method: 'POST',
        headers,
        body: bodyStr,
        redirect: 'error',
        signal: AbortSignal.timeout(this.state.webhook.timeoutMs),
      }, hostCheck.addresses);
      if (!resp.ok) {
        metricsRegistry.recordAlertDelivery('webhook', 'failed');
        logger.warn('alerting', 'Webhook alert returned non-2xx HTTP status', {
          targetUrl,
          httpStatus: resp.status,
        });
        return {
          channel: 'webhook',
          status: 'failed',
          target: targetUrl,
          httpStatus: resp.status,
          error: `Webhook endpoint returned HTTP ${resp.status}`,
          sentAt,
        };
      }
      metricsRegistry.recordAlertDelivery('webhook', 'sent');
      logger.info('alerting', 'Webhook alert delivered', {
        targetUrl,
        httpStatus: resp.status,
      });
      return {
        channel: 'webhook',
        status: 'sent',
        target: targetUrl,
        httpStatus: resp.status,
        sentAt,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Webhook HTTP POST failed';
      metricsRegistry.recordAlertDelivery('webhook', 'failed');
      logger.warn('alerting', 'Webhook HTTP POST failed', {
        targetUrl,
        error: errMsg,
      });
      return {
        channel: 'webhook',
        status: 'failed',
        target: targetUrl,
        error: errMsg,
        sentAt,
      };
    }
  }

  async testChannel(
    channel: AlertChannelType,
    options?: { recipient?: string; webhookUrl?: string }
  ): Promise<AlertDeliveryOutcome> {
    const nowIso = new Date().toISOString();
    if (channel === 'email') {
      const recipients = options?.recipient ? [options.recipient.trim()] : undefined;
      return this.sendEmailViaSmtp(
        '[Industrial Telemetry] Test SMTP / Mailpit Alert Delivery',
        `Test alert sent at ${nowIso} from Industrial Telemetry Platform.\nSMTP Target: ${this.state.smtp.host}:${this.state.smtp.port}`,
        `<div style="font-family:Inter,Arial,sans-serif;padding:16px;border:1px solid #cbd5e1;border-radius:6px;">
          <h3 style="margin:0 0 8px;color:#0f172a;">Industrial Telemetry — Test Alert SMTP / Mailpit</h3>
          <p style="margin:0 0 8px;color:#334155;">Canale Email SMTP verificato con successo alle <strong>${nowIso}</strong>.</p>
          <p style="margin:0;font-size:12px;color:#64748b;">Server SMTP: <code>${this.state.smtp.host}:${this.state.smtp.port}</code></p>
        </div>`,
        recipients
      );
    }

    return this.sendWebhook(
      {
        eventType: 'telemetry.alert.test',
        severity: 'info',
        message: 'Test webhook delivery from Industrial Telemetry Platform',
        timestamp: nowIso,
      },
      options?.webhookUrl
    );
  }

  async evaluateFeatureRows(rows: MlFeatureRow[]): Promise<AlertEvent[]> {
    const activeRules = this.state.rules.filter((r) => r.enabled);
    if (activeRules.length === 0 || rows.length === 0) return [];

    const nowMs = Date.now();
    const triggered: AlertEvent[] = [];

    for (const row of rows) {
      for (const rule of activeRules) {
        if (rule.domainFilter && row.domain !== rule.domainFilter) continue;
        if (rule.machineTypeFilter && row.machine_type !== rule.machineTypeFilter) continue;

        const observed = extractFeatureMetric(row, rule.metric);
        if (!compareMetric(observed, rule.operator, rule.threshold)) continue;

        const cooldownKey = `${rule.id}:${row.machine_id}`;
        const lastFired = this.cooldownMap.get(cooldownKey) ?? 0;
        if (nowMs - lastFired < rule.cooldownSec * 1000) continue;
        this.cooldownMap.set(cooldownKey, nowMs);

        const message = `[${rule.severity.toUpperCase()}] ${rule.name}: ${row.machine_id} (${row.machine_type}) ${rule.metric}=${observed} (threshold ${rule.operator} ${rule.threshold})`;
        const deliveries: AlertDeliveryOutcome[] = [];

        if (rule.channels.includes('email')) {
          if (this.state.smtp.enabled) {
            deliveries.push(
              await this.sendEmailViaSmtp(
                `[${rule.severity.toUpperCase()}] ${row.machine_id} — ${rule.name}`,
                `${message}\nLine: ${row.line_id}\nDomain: ${row.domain}\nWindow: ${row.window_start}`,
                `<div style="font-family:Inter,Arial,sans-serif;padding:16px;border:1px solid #cbd5e1;border-radius:6px;">
                  <h3 style="margin:0 0 8px;color:#991b1b;">${rule.name}</h3>
                  <p style="margin:0 0 8px;color:#0f172a;">${message}</p>
                  <p style="margin:0;font-size:12px;color:#475569;">Line: ${row.line_id} | Domain: ${row.domain} | Window: ${row.window_start}</p>
                </div>`
              )
            );
          } else {
            deliveries.push({
              channel: 'email',
              status: 'skipped',
              target: `${this.state.smtp.host}:${this.state.smtp.port}`,
              error: 'SMTP channel disabled',
              sentAt: new Date().toISOString(),
            });
          }
        }

        if (rule.channels.includes('webhook')) {
          if (this.state.webhook.enabled && this.state.webhook.url) {
            deliveries.push(
              await this.sendWebhook({
                eventType: 'telemetry.alert.triggered',
                ruleId: rule.id,
                ruleName: rule.name,
                severity: rule.severity,
                machineId: row.machine_id,
                lineId: row.line_id,
                machineType: row.machine_type,
                domain: row.domain,
                metric: rule.metric,
                observedValue: observed,
                threshold: rule.threshold,
                windowStart: row.window_start,
                message,
              })
            );
          } else {
            deliveries.push({
              channel: 'webhook',
              status: 'skipped',
              target: this.state.webhook.url || '(unset)',
              error: 'Webhook channel disabled',
              sentAt: new Date().toISOString(),
            });
          }
        }

        const event: AlertEvent = {
          id: `alt-${crypto.randomUUID().slice(0, 10)}`,
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          machineId: row.machine_id,
          lineId: row.line_id,
          machineType: row.machine_type,
          domain: row.domain,
          metric: rule.metric,
          observedValue: observed,
          threshold: rule.threshold,
          message,
          triggeredAt: new Date().toISOString(),
          acknowledgedAt: null,
          acknowledgedBy: null,
          acknowledgementNote: null,
          reopenedAt: null,
          reopenedBy: null,
          actionHistory: [],
          deliveries,
        };
        triggered.push(event);
        this.state.recentEvents.unshift(event);
      }
    }

    if (triggered.length > 0) {
      this.state.recentEvents = this.state.recentEvents.slice(0, 200);
      await this.persist();
    }
    return triggered;
  }
}
