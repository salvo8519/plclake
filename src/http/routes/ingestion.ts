import type { Router } from 'express';
import {
  formatZodIssues,
  IngestBatchPermissiveSchema,
  IngestBatchStrictSchema,
  JobConfigPermissiveSchema,
  JobConfigStrictSchema,
} from '../../apiSchemas.ts';
import { logger } from '../../logger.ts';
import { metricsRegistry } from '../../observability.ts';
import type { JobConfig } from '../../types/pipeline.ts';
import { getRequestContext, logInternalError, normalizePermissiveEvent } from '../requestInput.ts';
import type { HttpContext } from '../context.ts';

/** Edge ingestion: gateway sync configuration, job configuration and batch telemetry ingest. */
export function registerIngestionRoutes(apiRouter: Router, ctx: HttpContext): void {
  const { runManager, connectionManager, jobConfig, requireScope, ingestRateLimit } = ctx;

  apiRouter.get('/edge/config', requireScope('edge'), (_req, res) => {
    res.json(connectionManager.getEdgeSyncConfig());
  });

  apiRouter.get('/job/config', requireScope('read'), (_req, res) => {
    res.json({
      config: jobConfig.current,
      updatedAt: jobConfig.updatedAt,
    });
  });

  apiRouter.put('/job/config', requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    try {
      const schema = tier === 'strict' ? JobConfigStrictSchema : JobConfigPermissiveSchema;
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

      await jobConfig.update(parsed.data as Partial<JobConfig>);
      res.json({
        config: jobConfig.current,
        updatedAt: jobConfig.updatedAt,
      });
    } catch (err) {
      logInternalError(err, 'Unable to save job configuration', requestId);
      res.status(500).json({
        error: 'Unable to save job configuration',
        tier,
        requestId,
      });
    }
  });

  apiRouter.post('/ingest/batch', ingestRateLimit, requireScope('edge'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    try {

      let rawEvents: unknown[];
      if (tier === 'strict') {
        const parsed = IngestBatchStrictSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          res.status(400).json({
            error: 'Validation failed (Tier 2 Strict)',
            tier,
            requestId,
            issues: formatZodIssues(parsed.error),
          });
          return;
        }
        rawEvents = parsed.data.events;
      } else {
        const parsed = IngestBatchPermissiveSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          res.status(400).json({
            error: 'Request body must include a non-empty events array or single event object.',
            tier,
            requestId,
            issues: formatZodIssues(parsed.error),
          });
          return;
        }
        const sourceList = parsed.data.events ?? (parsed.data.event !== undefined ? [parsed.data.event] : []);
        rawEvents = sourceList.map(normalizePermissiveEvent);
      }

      if (rawEvents.length > 5000) {
        res.status(413).json({
          error: 'Batch size exceeds 5,000 events per request.',
          tier,
          requestId,
        });
        return;
      }

      const result = runManager.ingestExternalBatch(rawEvents, {
        windowMinutes: jobConfig.current.windowMinutes,
        machinesPerLine: jobConfig.current.machinesPerLine,
        machineProfileMode: jobConfig.current.machineProfileMode,
        rotateMaxLines: jobConfig.current.rotateMaxLines,
        customMachineTopology: jobConfig.current.customMachineTopology,
        ignoredErrorCodes: jobConfig.current.ignoredErrorCodes,
        horizonWindows: jobConfig.current.horizonWindows,
        tempAnomalyThresholdC: jobConfig.current.tempAnomalyThresholdC,
        vibrationP95Threshold: jobConfig.current.vibrationP95Threshold,
        minValidSampleRatio: jobConfig.current.minValidSampleRatio,
        dedupStrategy: jobConfig.current.dedupStrategy,
        malformedPolicy: jobConfig.current.malformedPolicy,
        parquetCompression: jobConfig.current.parquetCompression,
        datasetVersion: jobConfig.current.datasetVersion,
        partitionLayout: jobConfig.current.partitionLayout,
        lakehouseFormat: jobConfig.current.lakehouseFormat,
        hotRetentionDays: jobConfig.current.hotRetentionDays,
        coldRetentionDays: jobConfig.current.coldRetentionDays,
        coldStorageEndpoint: jobConfig.current.coldStorageEndpoint,
        compactionSchedule: jobConfig.current.compactionSchedule,
        ingestTransport: jobConfig.current.ingestTransport,
      });

      const countsByMachine = new Map<string, number>();
      if (result.accepted > 0) {
        for (const item of rawEvents) {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            const mId = (item as Record<string, unknown>).machine_id;
            if (typeof mId === 'string' && mId.trim()) {
              countsByMachine.set(mId.trim(), (countsByMachine.get(mId.trim()) ?? 0) + 1);
            }
          }
        }
        await connectionManager.recordIngestedMachineCounts(countsByMachine);
      }

      metricsRegistry.recordIngestionBatch(result.accepted, result.quarantined);
      logger.info('ingestion', 'Processed external telemetry batch', {
        requestId,
        accepted: result.accepted,
        quarantined: result.quarantined,
        validationTier: tier,
      });

      res.status(202).json(result);
    } catch (err) {
      logInternalError(err, 'Batch ingestion failed', requestId);
      res.status(500).json({
        error: 'Batch ingestion failed',
        tier,
        requestId,
      });
    }
  });
}
