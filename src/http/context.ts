import type { RequestHandler } from 'express';
import type { AlertEngine } from '../alertEngine.ts';
import type { AuthAuditManager } from '../authAudit.ts';
import type { ConnectionManager } from '../connectionManager.ts';
import type { DatabaseStore } from '../db.ts';
import type { PlcCatalogManager } from '../machineCatalog.ts';
import type { SimulationRunManager } from '../simulationRunner.ts';
import type { AuthGuards } from './authGuards.ts';
import type { JobConfigStore } from './jobConfigStore.ts';

/**
 * Everything a domain router needs, built once by createApp (the composition root).
 * Routers receive services and guards explicitly instead of closing over createApp locals,
 * so each router module can be read, tested and owned on its own.
 */
export interface HttpContext {
  dbStore: DatabaseStore;
  authAuditManager: AuthAuditManager;
  alertEngine: AlertEngine;
  runManager: SimulationRunManager;
  connectionManager: ConnectionManager;
  plcCatalogManager: PlcCatalogManager;
  jobConfig: JobConfigStore;
  resolveActor: AuthGuards['resolveActor'];
  requireScope: AuthGuards['requireScope'];
  probeRateLimit: RequestHandler;
  keyRotateRateLimit: RequestHandler;
  ingestRateLimit: RequestHandler;
  runCreateRateLimit: RequestHandler;
  loginRateLimit: RequestHandler;
}
