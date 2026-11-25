import type { NextFunction, Request, Response } from 'express';
import { APP_SLUG } from './config/appMeta.ts';

export type LogSeverity = 'debug' | 'info' | 'warn' | 'error';

export type LogCategory =
  | 'system'
  | 'http'
  | 'ingestion'
  | 'alerting'
  | 'database'
  | 'security';

export interface StructuredLogRecord {
  timestamp: string;
  level: LogSeverity;
  service: string;
  site_id: string;
  category: LogCategory;
  msg: string;
  requestId?: string;
  [key: string]: unknown;
}

const LEVEL_WEIGHT: Record<LogSeverity, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_KEY_PATTERN =
  /(pass(word)?|secret|token|authorization|api[-_]?key|cookie|credential|private[-_]?key|smtpPass)/i;

const INLINE_SECRET_PATTERNS: RegExp[] = [
  /\b(adm_live|bi_live|gw_live|pat_live|sess)_[a-zA-Z0-9_-]{6,}\b/g,
  /(Bearer\s+)[a-zA-Z0-9._~+/-]{8,}=*/gi,
  /(postgres(?:ql)?:\/\/[^:\s/]+:)([^@\s/]+)(@)/gi,
];

export function redactStringSecrets(input: string): string {
  let out = input;
  out = out.replace(INLINE_SECRET_PATTERNS[0], '$1_[REDACTED]');
  out = out.replace(INLINE_SECRET_PATTERNS[1], '$1[REDACTED]');
  out = out.replace(INLINE_SECRET_PATTERNS[2], '$1[REDACTED]$3');
  return out;
}

export function redactSensitiveData(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return redactStringSecrets(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactStringSecrets(value.message),
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactSensitiveData(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        out[key] = '[REDACTED]';
      } else {
        out[key] = redactSensitiveData(val, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

export function resolveSiteId(): string {
  const raw = process.env.PLANT_SITE_ID?.trim();
  return raw && raw.length > 0 ? raw.slice(0, 64) : 'plant-01';
}

function resolveMinLevel(): LogSeverity {
  const env = (process.env.LOG_LEVEL || 'info').trim().toLowerCase();
  if (env === 'debug' || env === 'info' || env === 'warn' || env === 'error') {
    return env;
  }
  return 'info';
}

export class StructuredLogger {
  private service: string;
  private writer: (line: string) => void;

  constructor(
    service = APP_SLUG,
    writer?: (line: string) => void
  ) {
    this.service = service;
    this.writer =
      writer ??
      ((line: string) => {
        if (process.env.VITEST === 'true' && process.env.LOG_IN_TEST !== 'true') {
          return;
        }
        process.stdout.write(`${line}\n`);
      });
  }

  emit(
    level: LogSeverity,
    category: LogCategory,
    msg: string,
    fields?: Record<string, unknown>
  ): StructuredLogRecord {
    const minLevel = resolveMinLevel();
    const sanitizedFields = fields
      ? (redactSensitiveData(fields) as Record<string, unknown>)
      : {};

    const record: StructuredLogRecord = {
      timestamp: new Date().toISOString(),
      level,
      service: this.service,
      site_id: resolveSiteId(),
      category,
      msg: redactStringSecrets(msg),
      ...sanitizedFields,
    };

    if (LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[minLevel]) {
      this.writer(JSON.stringify(record));
    }
    return record;
  }

  debug(category: LogCategory, msg: string, fields?: Record<string, unknown>) {
    return this.emit('debug', category, msg, fields);
  }

  info(category: LogCategory, msg: string, fields?: Record<string, unknown>) {
    return this.emit('info', category, msg, fields);
  }

  warn(category: LogCategory, msg: string, fields?: Record<string, unknown>) {
    return this.emit('warn', category, msg, fields);
  }

  error(category: LogCategory, msg: string, fields?: Record<string, unknown>) {
    return this.emit('error', category, msg, fields);
  }
}

export const logger = new StructuredLogger();

export function createHttpLoggerMiddleware(
  logInstance: StructuredLogger,
  onResponseRecorded?: (info: {
    method: string;
    route: string;
    statusCode: number;
    durationMs: number;
  }) => void
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startNs = process.hrtime.bigint();
    res.on('finish', () => {
      const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
      const durationMs = Number(elapsedMs.toFixed(2));
      const rawPath = req.originalUrl.split('?')[0] || req.path || '/';
      const normalizedRoute = rawPath
        .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
        .replace(/\/(sim|conn|alt|rule|usr|mp|tok)-[a-zA-Z0-9_-]+/g, '/:id');

      onResponseRecorded?.({
        method: req.method,
        route: normalizedRoute,
        statusCode: res.statusCode,
        durationMs,
      });

      // Skip noisy health/metrics/static asset chatter unless error
      const isProbe =
        rawPath === '/healthz' ||
        rawPath === '/readyz' ||
        rawPath === '/metrics' ||
        rawPath === '/api/v1/metrics';
      if (isProbe && res.statusCode < 400) return;

      const level: LogSeverity =
        res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

      const authTokenId = String(res.getHeader('X-Auth-Token-Id') ?? '');
      const authScope = String(res.getHeader('X-Auth-Scope') ?? '');
      const authUser = String(res.getHeader('X-Auth-User') ?? '');

      logInstance.emit(level, 'http', `${req.method} ${rawPath} -> ${res.statusCode}`, {
        requestId: String(res.getHeader('X-Request-Id') ?? ''),
        method: req.method,
        path: rawPath,
        route: normalizedRoute,
        statusCode: res.statusCode,
        durationMs,
        validationTier: String(res.getHeader('X-API-Validation-Tier') ?? ''),
        ...(authScope ? { authScope } : {}),
        ...(authUser ? { authUser } : {}),
        ...(authTokenId ? { authTokenId } : {}),
        remoteIp: req.ip || req.socket.remoteAddress || 'unknown',
      });
    });
    next();
  };
}
