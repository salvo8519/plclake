import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { isProductionRuntime } from './config/runtimeEnv.ts';
import { withName } from './utils/asyncRouter.ts';
import type { NextFunction, Request, Response } from 'express';

export type ApiAuthScope = 'edge' | 'read' | 'admin';

const SECRET_CIPHER_PREFIX = 'enc:v1:';
const SECRET_KEY_DERIVATION_SALT = 'telemetry-erp-secrets-at-rest-v1';

export function isEncryptedSecret(value: string): boolean {
  return typeof value === 'string' && value.startsWith(SECRET_CIPHER_PREFIX);
}

/**
 * Resolves the 32-byte AES-256-GCM master key for encrypting sensitive credentials
 * at rest (SMTP passwords, webhook signing secrets).
 *
 * Priority:
 * 1. `SECRETS_ENCRYPTION_KEY` env var (64-char hex key, or passphrase derived via scrypt).
 * 2. Auto-generated persistent 32-byte key stored in `<rootDir>/.state/.master.key`
 *    with strict owner-only permissions (0600, excluded from Git).
 */
export async function resolveSecretsMasterKey(rootDir?: string): Promise<Buffer> {
  const envRaw = process.env.SECRETS_ENCRYPTION_KEY?.trim();
  if (envRaw) {
    if (/^[0-9a-fA-F]{64}$/.test(envRaw)) {
      return Buffer.from(envRaw, 'hex');
    }
    return crypto.scryptSync(envRaw, SECRET_KEY_DERIVATION_SALT, 32);
  }

  const baseDir = rootDir ? path.resolve(rootDir) : process.cwd();
  const keyFile = path.resolve(baseDir, '.state', '.master.key');
  try {
    const existingHex = (await fs.readFile(keyFile, 'utf-8')).trim();
    if (/^[0-9a-fA-F]{64}$/.test(existingHex)) {
      return Buffer.from(existingHex, 'hex');
    }
  } catch {
    // Master key file does not exist yet — generate below
  }

  const generated = crypto.randomBytes(32);
  try {
    await fs.mkdir(path.dirname(keyFile), { recursive: true });
    await fs.writeFile(keyFile, `${generated.toString('hex')}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    await fs.chmod(keyFile, 0o600).catch(() => {});
  } catch {
    // Non-fatal in read-only ephemeral containers; key remains valid for process lifetime
  }
  return generated;
}

/**
 * Encrypts a secret string with AES-256-GCM using a fresh 96-bit random IV.
 * Output format: `enc:v1:<ivHex>:<authTagHex>:<ciphertextHex>`.
 * Idempotent: returns already-encrypted values unchanged.
 */
export function encryptSecret(plaintext: string, key: Buffer): string {
  if (!plaintext) return '';
  if (isEncryptedSecret(plaintext)) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${SECRET_CIPHER_PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts an `enc:v1:...` AES-256-GCM secret payload.
 * Legacy plaintext values (without the `enc:v1:` prefix) are returned as-is
 * so callers can transparently migrate them to encrypted storage on next persist.
 */
export function decryptSecret(stored: string, key: Buffer): string {
  if (!stored) return '';
  if (!isEncryptedSecret(stored)) return stored;
  const body = stored.slice(SECRET_CIPHER_PREFIX.length);
  const parts = body.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted secret envelope.');
  }
  const [ivHex, tagHex, dataHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(tagHex, 'hex');
  const ciphertext = Buffer.from(dataHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

export function sha256Hex(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Constant-time string comparison via SHA-256 digest equality so length differences
 * never leak timing information.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const digestA = crypto.createHash('sha256').update(a, 'utf8').digest();
  const digestB = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

/**
 * Constant-time check comparing a plaintext candidate against a stored hex SHA-256 hash.
 */
export function timingSafeHashMatch(candidate: string, expectedSha256Hex: string): boolean {
  if (expectedSha256Hex?.length !== 64) return false;
  const actualBuf = Buffer.from(sha256Hex(candidate), 'hex');
  let expectedBuf: Buffer;
  try {
    expectedBuf = Buffer.from(expectedSha256Hex, 'hex');
  } catch {
    return false;
  }
  if (actualBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

export function extractRequestCredential(req: Request): string {
  const authHeader = req.header('authorization');
  if (authHeader && /^Bearer\s+/i.test(authHeader)) {
    return authHeader.replace(/^Bearer\s+/i, '').trim();
  }
  const apiKey = req.header('x-api-key');
  if (apiKey?.trim()) {
    return apiKey.trim();
  }
  const gatewayToken = req.header('x-gateway-token');
  if (gatewayToken?.trim()) {
    return gatewayToken.trim();
  }
  return '';
}

const HOSTNAME_REGEX = /^[a-zA-Z0-9.-]{1,128}$/;

function isIpv4InCidr(ip: string, baseIp: string, prefixLen: number): boolean {
  const toInt = (addr: string) =>
    addr.split('.').reduce((acc, oct) => ((acc << 8) | (Number(oct) & 255)) >>> 0, 0);
  const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
  return (toInt(ip) & mask) === (toInt(baseIp) & mask);
}

/**
 * Detects non-canonical numeric IPv4 encodings (integer like 2852039166,
 * hex like 0x7f000001 / 0xa9.0xfe.0xa9.0xfe, or leading-zero octal octets like 0177.0.0.1)
 * that some HTTP clients normalize into loopback or cloud metadata IPs.
 */
function isNonCanonicalNumericIpv4(host: string): boolean {
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
    return true;
  }
  const parts = host.split('.');
  if (parts.length >= 2 && parts.length <= 4) {
    const allNumericLike = parts.every((p) => /^(?:0x[0-9a-f]+|0[0-7]+|\d+)$/i.test(p));
    if (allNumericLike) {
      const hasHexOrOctalOrShort =
        parts.length !== 4 ||
        parts.some((p) => /^0x/i.test(p) || (p.length > 1 && p.startsWith('0')));
      if (hasHexOrOctalOrShort) return true;
    }
  }
  return false;
}

/**
 * Expands a valid IPv6 literal into 8 normalized 16-bit integer groups.
 * Handles embedded dotted-quad IPv4 suffixes (e.g. ::ffff:169.254.169.254).
 */
function expandIpv6ToGroups(rawIpv6: string): number[] | null {
  let addr = rawIpv6.toLowerCase();
  const zoneIdx = addr.indexOf('%');
  if (zoneIdx !== -1) {
    addr = addr.slice(0, zoneIdx);
  }

  // Convert trailing dotted-quad IPv4 (e.g. ::ffff:169.254.169.254) into two 16-bit hex groups
  const lastColon = addr.lastIndexOf(':');
  if (lastColon !== -1 && addr.slice(lastColon + 1).includes('.')) {
    const ipv4Tail = addr.slice(lastColon + 1);
    if (net.isIP(ipv4Tail) !== 4) return null;
    const octets = ipv4Tail.split('.').map((o) => Number(o));
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const doubleColonParts = addr.split('::');
  if (doubleColonParts.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const tokens = side.split(':');
    const out: number[] = [];
    for (const tok of tokens) {
      if (!/^[0-9a-f]{1,4}$/.test(tok)) return null;
      out.push(Number.parseInt(tok, 16));
    }
    return out;
  };

  if (doubleColonParts.length === 1) {
    const groups = parseSide(doubleColonParts[0]);
    return groups && groups.length === 8 ? groups : null;
  }

  const left = parseSide(doubleColonParts[0]);
  const right = parseSide(doubleColonParts[1]);
  if (!left || !right) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function checkIpv4Policy(ip: string, allowLoopback: boolean): { allowed: boolean; reason?: string } {
  if (isIpv4InCidr(ip, '169.254.0.0', 16)) {
    return { allowed: false, reason: 'Link-local / cloud metadata range 169.254.0.0/16 is blocked.' };
  }
  if (isIpv4InCidr(ip, '0.0.0.0', 8)) {
    return { allowed: false, reason: 'Unspecified network 0.0.0.0/8 is blocked.' };
  }
  if (isIpv4InCidr(ip, '127.0.0.0', 8) && !allowLoopback) {
    return {
      allowed: false,
      reason: 'Loopback range 127.0.0.0/8 is blocked (set ALLOW_LOOPBACK_PROBE=true to allow).',
    };
  }
  return { allowed: true };
}

/**
 * Outbound host validation for industrial endpoint probing, webhooks, and relays.
 * Blocks cloud metadata services (169.254.0.0/16, metadata.google.internal, fd00:ec2::/32),
 * link-local/unspecified addresses, IPv4-mapped IPv6 bypasses, non-canonical numeric IPs,
 * credentials in host strings, and loopback unless explicitly opted in.
 */
export function validateProbeHost(
  rawHost: string,
  options?: { allowLoopback?: boolean }
): { allowed: boolean; reason?: string } {
  const trimmed = rawHost.trim().toLowerCase();
  if (!trimmed || trimmed.length > 128) {
    return { allowed: false, reason: 'Invalid empty or oversized host.' };
  }
  if (trimmed.includes('@') || trimmed.includes('/') || trimmed.includes('\\') || /\s/.test(trimmed)) {
    return { allowed: false, reason: 'Host contains disallowed URL or whitespace characters.' };
  }

  // Unwrap bracketed IPv6 literals (e.g. [::1], [::ffff:169.254.169.254])
  let host = trimmed;
  if (host.startsWith('[') || host.endsWith(']')) {
    if (!host.startsWith('[') || !host.endsWith(']')) {
      return { allowed: false, reason: 'Malformed IPv6 bracket notation.' };
    }
    host = host.slice(1, -1);
  }

  const allowLoopback = options?.allowLoopback ?? process.env.ALLOW_LOOPBACK_PROBE === 'true';

  if (
    host === 'metadata.google.internal' ||
    host === 'metadata' ||
    host.endsWith('.internal') ||
    host === '169.254.169.254'
  ) {
    return { allowed: false, reason: 'Cloud metadata endpoints are blocked by outbound host policy.' };
  }

  if (host === 'localhost') {
    if (!allowLoopback) {
      return {
        allowed: false,
        reason: 'Loopback probing is blocked by default (set ALLOW_LOOPBACK_PROBE=true to allow).',
      };
    }
    return { allowed: true };
  }

  if (isNonCanonicalNumericIpv4(host)) {
    return {
      allowed: false,
      reason: 'Non-canonical numeric/octal/hex IPv4 encodings are disallowed.',
    };
  }

  const ipVersion = net.isIP(host);
  if (ipVersion === 4) {
    return checkIpv4Policy(host, allowLoopback);
  }

  if (ipVersion === 6) {
    const groups = expandIpv6ToGroups(host);
    if (!groups) {
      return { allowed: false, reason: 'Invalid IPv6 address representation.' };
    }

    const isUnspecified = groups.every((g) => g === 0);
    if (isUnspecified) {
      return { allowed: false, reason: 'Unspecified IPv6 address :: is blocked.' };
    }

    const isLoopback = groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1;
    if (isLoopback) {
      if (!allowLoopback) {
        return {
          allowed: false,
          reason: 'IPv6 loopback ::1 is blocked by default (set ALLOW_LOOPBACK_PROBE=true to allow).',
        };
      }
      return { allowed: true };
    }

    // Link-local fe80::/10
    if ((groups[0] & 0xffc0) === 0xfe80) {
      return { allowed: false, reason: 'Link-local IPv6 range fe80::/10 is blocked.' };
    }

    // AWS IMDSv2 / cloud metadata ULA fd00:ec2::/32
    if (groups[0] === 0xfd00 && groups[1] === 0x0ec2) {
      return { allowed: false, reason: 'Cloud metadata IPv6 range fd00:ec2::/32 is blocked.' };
    }

    // IPv4-mapped (::ffff:0:0/96) or IPv4-compatible (::/96) IPv6 addresses
    const isIpv4Mapped =
      groups[0] === 0 &&
      groups[1] === 0 &&
      groups[2] === 0 &&
      groups[3] === 0 &&
      groups[4] === 0 &&
      (groups[5] === 0xffff || groups[5] === 0x0000);
    if (isIpv4Mapped) {
      const mappedIpv4 = [
        (groups[6] >> 8) & 0xff,
        groups[6] & 0xff,
        (groups[7] >> 8) & 0xff,
        groups[7] & 0xff,
      ].join('.');
      return checkIpv4Policy(mappedIpv4, allowLoopback);
    }

    return { allowed: true };
  }

  if (!HOSTNAME_REGEX.test(host)) {
    return { allowed: false, reason: 'Host must be a valid IPv4/IPv6 address or RFC hostname.' };
  }

  return { allowed: true };
}

export type HostResolver = (host: string) => Promise<string[]>;

const systemResolver: HostResolver = async (host) =>
  (await dns.lookup(host, { all: true, verbatim: true })).map((r) => r.address);

/**
 * Outbound host validation including DNS: `validateProbeHost` only inspects the host string,
 * so a hostname that resolves to loopback or cloud metadata (e.g. `127.0.0.1.nip.io`) would
 * pass. This resolves the name and applies the same policy to every returned address.
 *
 * Residual risk: DNS rebinding between this check and the actual connection. Raw TCP probes
 * should connect to one of the returned `addresses` to close that gap.
 */
export async function validateOutboundHost(
  rawHost: string,
  options?: { allowLoopback?: boolean; resolver?: HostResolver }
): Promise<{ allowed: boolean; reason?: string; addresses: string[] }> {
  const staticCheck = validateProbeHost(rawHost, options);
  if (!staticCheck.allowed) return { ...staticCheck, addresses: [] };

  const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return { allowed: true, addresses: [host] };

  let addresses: string[];
  try {
    addresses = await (options?.resolver ?? systemResolver)(host);
  } catch {
    return { allowed: false, reason: `Host '${host}' could not be resolved.`, addresses: [] };
  }
  if (addresses.length === 0) {
    return { allowed: false, reason: `Host '${host}' did not resolve to any address.`, addresses: [] };
  }
  for (const address of addresses) {
    const check = validateProbeHost(address, options);
    if (!check.allowed) {
      return {
        allowed: false,
        reason: `Host '${host}' resolves to blocked address ${address}: ${check.reason}`,
        addresses: [],
      };
    }
  }
  return { allowed: true, addresses };
}

/** Interactive API reference (Scalar): loads its bundle from a CDN with inline bootstrap code. */
const API_DOCS_PATH = /^\/api(?:\/v1)?\/docs(?:\/|$)/;

/** JSON/CSV API responses never execute or embed anything. */
export const API_CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'";

/**
 * Compiled SPA (production build has no inline scripts). Inline style attributes are used by
 * React components; Google Fonts is the only third-party origin; any http(s) frame source is
 * allowed for the admin-configured Mailpit inbox. No frame-ancestors: iframe embedding of the
 * console is an intentional feature.
 */
export const APP_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-src 'self' http: https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/** 180 days; no includeSubDomains, so on-prem sibling hosts without TLS are not affected. */
export const HSTS_HEADER_VALUE = 'max-age=15552000';

/**
 * Express middleware setting baseline HTTP security headers and strict CORS allowlist.
 * Preserves iframe embedding compatibility for preview environments while blocking MIME sniffing
 * and disallowing wildcard CORS (*) on authenticated /api/* endpoints.
 */
export function securityHeadersMiddleware(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  // CSP only for production builds: the Vite dev server injects inline scripts.
  if (isProductionRuntime() && !API_DOCS_PATH.test(req.path)) {
    res.setHeader(
      'Content-Security-Policy',
      req.path.startsWith('/api/') ? API_CONTENT_SECURITY_POLICY : APP_CONTENT_SECURITY_POLICY
    );
  }
  // HSTS only over TLS (req.secure honours TRUST_PROXY behind an ingress).
  if (isProductionRuntime() && req.secure) {
    res.setHeader('Strict-Transport-Security', HSTS_HEADER_VALUE);
  }

  const corsOriginEnv = process.env.CORS_ORIGIN?.trim();
  const reqOrigin = req.header('origin');
  if (corsOriginEnv && reqOrigin) {
    const allowedOrigins = corsOriginEnv
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    const isApiRoute = req.path.startsWith('/api/');
    const explicitMatch = allowedOrigins.includes(reqOrigin);
    const wildcardAllowed = !isApiRoute && allowedOrigins.includes('*');

    if (explicitMatch || wildcardAllowed) {
      res.setHeader('Access-Control-Allow-Origin', explicitMatch ? reqOrigin : '*');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type,Authorization,X-API-Key,X-Gateway-Token,X-Validation-Mode,X-Request-Id'
      );
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
    }
  }

  next();
}

interface RateBucket {
  count: number;
  resetAtMs: number;
}

/**
 * Lightweight sliding-window in-memory rate limiter for high-cost / sensitive API routes.
 */
export function createRateLimiter(options: {
  windowMs: number;
  maxRequests: number;
  keyPrefix: string;
}) {
  const buckets = new Map<string, RateBucket>();

  const limiter = (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${options.keyPrefix}:${clientIp}`;
    let bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAtMs) {
      bucket = { count: 0, resetAtMs: now + options.windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, options.maxRequests - bucket.count);
    res.setHeader('X-RateLimit-Limit', String(options.maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAtMs / 1000)));

    // Periodic lazy eviction to keep memory bounded
    if (buckets.size > 1000) {
      for (const [k, b] of buckets.entries()) {
        if (now >= b.resetAtMs) buckets.delete(k);
      }
    }

    if (bucket.count > options.maxRequests) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAtMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({
        error: `Rate limit exceeded for ${options.keyPrefix}. Retry after ${retryAfterSec}s.`,
        requestId: res.getHeader('X-Request-Id') ?? crypto.randomUUID(),
      });
      return;
    }

    next();
  };
  return withName(limiter, `rateLimit(${options.keyPrefix})`);
}
