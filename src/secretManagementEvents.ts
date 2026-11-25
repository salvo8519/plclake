import crypto from 'node:crypto';
import { logger } from './logger.ts';
import type { ApiTokenPublic, ApiTokenScope, AuditLogEntry } from './types/pipeline.ts';

export type TokenLifecycleEventType = 'token.created' | 'token.rotated' | 'token.revoked';

/**
 * Strongly typed domain event emitted by the SecretManagement service on every
 * API key creation, rotation, or revocation (manual or cascade).
 *
 * Security invariant: NEVER carries plaintext tokens or encrypted digests—only
 * public key identifiers, prefixes, scopes, and attribution metadata.
 */
export interface TokenLifecycleEvent {
  eventId: string;
  type: TokenLifecycleEventType;
  occurredAt: string;
  actor: string;
  actorRole: string;
  requestId: string;
  tokenId: string;
  tokenName: string;
  tokenPrefix: string;
  scopes: ApiTokenScope[];
  ownerUserId: string;
  ownerEmail: string;
  ownerRole: string;
  expiresAt: string | null;
  isSandbox: boolean;
  previousTokenId?: string;
  reason?: string;
}

export type TokenLifecycleListener = (event: TokenLifecycleEvent) => void | Promise<void>;

export interface AuditLogSystemSink {
  recordAudit(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>): Promise<AuditLogEntry>;
}

/**
 * In-process typed Pub/Sub event bus for SecretManagement token lifecycle transitions.
 * Dispatches to all registered subscribers with per-subscriber error isolation so
 * secondary telemetry failures never disrupt critical key issuance or revocation.
 */
export class SecretManagementEventBus {
  private readonly listeners = new Set<TokenLifecycleListener>();
  private publishedCount = 0;

  subscribe(listener: TokenLifecycleListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscriberCount(): number {
    return this.listeners.size;
  }

  totalPublished(): number {
    return this.publishedCount;
  }

  async publish(event: TokenLifecycleEvent): Promise<void> {
    this.publishedCount += 1;
    const deliveries = Array.from(this.listeners).map(async (listener) => {
      try {
        await listener(event);
      } catch (err) {
        logger.error('security', 'SecretManagement event subscriber failed', {
          eventType: event.type,
          eventId: event.eventId,
          tokenId: event.tokenId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
    await Promise.all(deliveries);
  }
}

export function buildTokenLifecycleEvent(params: {
  type: TokenLifecycleEventType;
  record: ApiTokenPublic;
  actor: string;
  actorRole?: string;
  requestId?: string;
  previousTokenId?: string;
  reason?: string;
}): TokenLifecycleEvent {
  return {
    eventId: `evt-${crypto.randomUUID().slice(0, 12)}`,
    type: params.type,
    occurredAt: new Date().toISOString(),
    actor: params.actor,
    actorRole: params.actorRole || 'admin',
    requestId: params.requestId || `secret-evt-${crypto.randomUUID().slice(0, 8)}`,
    tokenId: params.record.id,
    tokenName: params.record.name,
    tokenPrefix: params.record.tokenPrefix,
    scopes: [...params.record.scopes],
    ownerUserId: params.record.ownerUserId,
    ownerEmail: params.record.ownerEmail,
    ownerRole: params.record.ownerRole,
    expiresAt: params.record.expiresAt,
    isSandbox: params.record.isSandbox,
    ...(params.previousTokenId ? { previousTokenId: params.previousTokenId } : {}),
    ...(params.reason ? { reason: params.reason } : {}),
  };
}

/**
 * Registers the automated SecretManagement -> AuditLogSystem subscriber.
 * Every creation, rotation, and revocation event is immediately persisted into
 * the immutable Audit Log and mirrored to structured JSON security logs.
 */
export function registerAuditLogTokenSubscriber(
  bus: SecretManagementEventBus,
  auditLogSystem: AuditLogSystemSink
): () => void {
  return bus.subscribe(async (event) => {
    const resource = `secret-management://tokens/${event.tokenId}`;
    const details: Record<string, unknown> = {
      eventId: event.eventId,
      tokenId: event.tokenId,
      tokenName: event.tokenName,
      tokenPrefix: event.tokenPrefix,
      scopes: event.scopes,
      ownerEmail: event.ownerEmail,
      ownerRole: event.ownerRole,
      expiresAt: event.expiresAt,
      isSandbox: event.isSandbox,
      ...(event.previousTokenId ? { previousTokenId: event.previousTokenId } : {}),
      ...(event.reason ? { reason: event.reason } : {}),
    };

    await auditLogSystem.recordAudit({
      actor: event.actor,
      actorRole: event.actorRole,
      action: event.type,
      resource,
      status: 'ok',
      requestId: event.requestId,
      details,
    });

    logger.info('security', `AuditLogSystem recorded ${event.type}`, {
      event: event.type,
      eventId: event.eventId,
      tokenId: event.tokenId,
      tokenPrefix: event.tokenPrefix,
      ownerEmail: event.ownerEmail,
      actor: event.actor,
      requestId: event.requestId,
      ...(event.previousTokenId ? { previousTokenId: event.previousTokenId } : {}),
      ...(event.reason ? { reason: event.reason } : {}),
    });
  });
}
