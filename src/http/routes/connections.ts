import type { Router } from 'express';
import { ConnectionUpsertPermissiveSchema, ConnectionUpsertStrictSchema, formatZodIssues, NetworkSettingsPermissiveSchema, NetworkSettingsStrictSchema, ScopedKeyRotateRequestSchema } from '../../apiSchemas.ts';
import { resolveMachineSpec } from '../../machineCatalog.ts';
import type { NetworkDeploymentSettings, PlcConnection } from '../../types/pipeline.ts';
import { getRequestContext, logInternalError, normalizePermissiveConnectionInput } from '../requestInput.ts';
import type { HttpContext } from '../context.ts';

/** Plant OT/IT connections: network settings, gateway and scoped key rotation, endpoints, probes, test batches and the on-premise deploy bundle. */
export function registerConnectionRoutes(apiRouter: Router, ctx: HttpContext): void {
  const { runManager, connectionManager, jobConfig, requireScope, probeRateLimit, keyRotateRateLimit } = ctx;

  apiRouter.get('/connections', requireScope('read'), (_req, res) => {
    res.json(connectionManager.getPublicState());
  });

  apiRouter.put('/connections/settings', requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    try {
      const schema = tier === 'strict' ? NetworkSettingsStrictSchema : NetworkSettingsPermissiveSchema;
      const parsed = schema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({
          error: `Validation failed (${tier})`,
          tier,
          requestId,
          issues: formatZodIssues(parsed.error),
        });
        return;
      }
      const updated = await connectionManager.updateSettings(
        parsed.data as Partial<NetworkDeploymentSettings>
      );
      res.json(updated);
    } catch (err) {
      logInternalError(err, 'Failed to update network deployment settings', requestId);
      res.status(500).json({
        error: 'Failed to update network deployment settings',
        tier,
        requestId,
      });
    }
  });

  apiRouter.post('/connections/gateway-token/rotate', keyRotateRateLimit, requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    try {
      const rotated = await connectionManager.rotateGatewayToken();
      res.json(rotated);
    } catch (err) {
      logInternalError(err, 'Failed to rotate gateway token', requestId);
      res.status(500).json({
        error: 'Failed to rotate gateway token',
        tier,
        requestId,
      });
    }
  });

  apiRouter.post('/connections/api-keys/rotate', keyRotateRateLimit, requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    try {
      const parsed = ScopedKeyRotateRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({
          error: 'Specify scope as one of: edge, read, admin.',
          tier,
          requestId,
          issues: formatZodIssues(parsed.error),
        });
        return;
      }
      const rotated = await connectionManager.rotateScopedKey(parsed.data.scope);
      res.json(rotated);
    } catch (err) {
      logInternalError(err, 'Failed to rotate scoped API key', requestId);
      res.status(500).json({
        error: 'Failed to rotate scoped API key',
        tier,
        requestId,
      });
    }
  });

  apiRouter.post('/connections', requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    try {
      const schema = tier === 'strict' ? ConnectionUpsertStrictSchema : ConnectionUpsertPermissiveSchema;
      const parsed = schema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({
          error: `Validation failed (${tier})`,
          tier,
          requestId,
          issues: formatZodIssues(parsed.error),
        });
        return;
      }
      const payload =
        tier === 'strict'
          ? (parsed.data as Partial<PlcConnection>)
          : normalizePermissiveConnectionInput(parsed.data as Record<string, unknown>);
      const saved = await connectionManager.upsertConnection(payload);
      res.status(payload.id ? 200 : 201).json(saved);
    } catch (err) {
      logInternalError(err, 'Failed to save connection', requestId);
      res.status(500).json({
        error: 'Failed to save connection',
        tier,
        requestId,
      });
    }
  });

  apiRouter.delete('/connections/:id', requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    try {
      const removed = await connectionManager.deleteConnection(req.params.id);
      if (!removed.deleted) {
        res.status(404).json({ error: 'Connection not found', tier, requestId });
        return;
      }
      res.json(removed);
    } catch (err) {
      logInternalError(err, 'Failed to delete connection', requestId);
      res.status(500).json({
        error: 'Failed to delete connection',
        tier,
        requestId,
      });
    }
  });

  apiRouter.post('/connections/:id/probe', probeRateLimit, requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    try {
      const probe = await connectionManager.probeConnection(req.params.id);
      if (!probe) {
        res.status(404).json({ error: 'Connection not found', tier, requestId });
        return;
      }
      res.json({ probe, state: connectionManager.getPublicState() });
    } catch (err) {
      logInternalError(err, 'Connection probe failed', requestId);
      res.status(500).json({
        error: 'Connection probe failed',
        tier,
        requestId,
      });
    }
  });

  apiRouter.post('/connections/:id/send-test-batch', requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    try {
      const conn = connectionManager.getConnection(req.params.id);
      if (!conn) {
        res.status(404).json({ error: 'Connection not found', tier, requestId });
        return;
      }
      const spec = resolveMachineSpec(conn.machineType);
      const envelope = {
        event_id: `gw-test-${conn.machineId}-${Date.now()}`,
        timestamp: new Date().toISOString(),
        machine_id: conn.machineId,
        line_id: conn.lineId,
        machine_type: conn.machineType,
        domain: spec.domain,
        state: 'RUNNING',
        level: 'INFO',
        error_code: null,
        metrics: {
          temp_c: Number((spec.tempNominalC + 0.8).toFixed(2)),
          [spec.primaryKey]: Number(spec.primaryNominal.toFixed(2)),
          [spec.secondaryKey]: Number(spec.secondaryNominal.toFixed(3)),
        },
        source_protocol: conn.protocol,
        source_host: `${conn.host}:${conn.port}`,
      };

      const result = runManager.ingestExternalBatch([envelope], {
        windowMinutes: jobConfig.current.windowMinutes,
        machinesPerLine: jobConfig.current.machinesPerLine,
        machineProfileMode: jobConfig.current.machineProfileMode,
        rotateMaxLines: jobConfig.current.rotateMaxLines,
        dedupStrategy: jobConfig.current.dedupStrategy,
        malformedPolicy: jobConfig.current.malformedPolicy,
        parquetCompression: jobConfig.current.parquetCompression,
        datasetVersion: jobConfig.current.datasetVersion,
        partitionLayout: jobConfig.current.partitionLayout,
        lakehouseFormat: jobConfig.current.lakehouseFormat,
        ingestTransport: 'http-batch-ingest',
      });

      if (result.accepted > 0) {
        await connectionManager.recordIngestedMachineCounts(new Map([[conn.machineId, result.accepted]]));
      }

      res.status(202).json({
        result,
        envelope,
        state: connectionManager.getPublicState(),
      });
    } catch (err) {
      logInternalError(err, 'Test batch dispatch failed', requestId);
      res.status(500).json({
        error: 'Test batch dispatch failed',
        tier,
        requestId,
      });
    }
  });

  apiRouter.get('/connections/deploy-bundle', requireScope('admin'), (_req, res) => {
    res.json(connectionManager.buildDeployBundle());
  });
}
