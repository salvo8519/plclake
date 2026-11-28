import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { resolveValidationTier } from '../apiSchemas.ts';
import type { PlcConnection } from '../types/pipeline.ts';

/**
 * Request-level input helpers shared by every router: correlation id and validation tier,
 * plus normalization of permissive (snake_case / camelCase) payloads.
 */

export function getRequestContext(req: Request, res: Response) {
  const requestId = req.header('x-request-id') || crypto.randomUUID();
  const tier = resolveValidationTier(req.header('x-validation-mode'), req.query.mode);
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-API-Validation-Tier', tier);
  return { requestId, tier };
}

export function normalizePermissiveEvent(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const obj = { ...(raw as Record<string, unknown>) };
  if (obj.machine_id === undefined && typeof obj.machineId === 'string') obj.machine_id = obj.machineId;
  if (obj.line_id === undefined && typeof obj.lineId === 'string') obj.line_id = obj.lineId;
  if (obj.machine_type === undefined && typeof obj.machineType === 'string') obj.machine_type = obj.machineType;
  if (obj.event_id === undefined && typeof obj.eventId === 'string') obj.event_id = obj.eventId;
  return obj;
}

export function normalizePermissiveConnectionInput(raw: Record<string, unknown>): Partial<PlcConnection> {
  return {
    ...(typeof raw.id === 'string' ? { id: raw.id } : {}),
    name: typeof raw.name === 'string' ? raw.name : undefined,
    machineId:
      typeof raw.machineId === 'string'
        ? raw.machineId
        : typeof raw.machine_id === 'string'
        ? raw.machine_id
        : undefined,
    lineId:
      typeof raw.lineId === 'string'
        ? raw.lineId
        : typeof raw.line_id === 'string'
        ? raw.line_id
        : undefined,
    machineType:
      typeof raw.machineType === 'string'
        ? raw.machineType
        : typeof raw.machine_type === 'string'
        ? raw.machine_type
        : undefined,
    protocol: raw.protocol as PlcConnection['protocol'] | undefined,
    deploymentTopology: raw.deploymentTopology as PlcConnection['deploymentTopology'] | undefined,
    host: typeof raw.host === 'string' ? raw.host : undefined,
    port: raw.port !== undefined ? Number(raw.port) : undefined,
    endpointOrTopic: typeof raw.endpointOrTopic === 'string' ? raw.endpointOrTopic : undefined,
    useTls:
      typeof raw.useTls === 'boolean' ? raw.useTls : typeof raw.use_tls === 'boolean' ? raw.use_tls : undefined,
    pollIntervalSec:
      raw.pollIntervalSec !== undefined
        ? (Number(raw.pollIntervalSec) as PlcConnection['pollIntervalSec'])
        : undefined,
    authMode: raw.authMode as PlcConnection['authMode'] | undefined,
    username: typeof raw.username === 'string' ? raw.username : undefined,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : undefined,
    tagBindings: Array.isArray(raw.tagBindings) ? (raw.tagBindings as PlcConnection['tagBindings']) : undefined,
  };
}

// WHITE_LABEL_EDITORIAL_CSS imported from src/serverConfig.ts
