import type { Router } from 'express';
import { formatZodIssues, PipelineRunCreatePermissiveSchema, PipelineRunCreateStrictSchema } from '../../apiSchemas.ts';
import type { JobConfig, LiveRunSnapshot, MachineProfileMode } from '../../types/pipeline.ts';
import { getRequestContext, logInternalError } from '../requestInput.ts';
import type { HttpContext } from '../context.ts';

/** Pipeline runs: create, inspect, stream (SSE), pause, resume and stop live simulation or ingestion runs. */
export function registerPipelineRoutes(apiRouter: Router, ctx: HttpContext): void {
  const { runManager, jobConfig, requireScope, runCreateRateLimit } = ctx;

  apiRouter.get('/pipeline/runs/latest', requireScope('read'), (_req, res) => {
    const snap = runManager.getLatestSnapshot();
    res.json({ run: snap });
  });

  apiRouter.post('/pipeline/runs', runCreateRateLimit, requireScope('admin'), (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    try {
      const schema = tier === 'strict' ? PipelineRunCreateStrictSchema : PipelineRunCreatePermissiveSchema;
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

      const body = parsed.data as Record<string, unknown>;
      const snapshot = runManager.startRun({
        durationMinutes: Number(body.durationMinutes ?? 15),
        eventsPerSec: Number(body.eventsPerSec ?? 10),
        speedMultiplier: Number(body.speedMultiplier ?? 10) as 1 | 10 | 60 | 300,
        windowMinutes: Number(body.windowMinutes ?? jobConfig.current.windowMinutes),
        machineCount: Number(body.machineCount ?? 4),
        machinesPerLine: Number(body.machinesPerLine ?? jobConfig.current.machinesPerLine),
        machineProfileMode:
          (body.machineProfileMode as MachineProfileMode | undefined) ??
          jobConfig.current.machineProfileMode,
        selectedPlcTypes: Array.isArray(body.selectedPlcTypes)
          ? (body.selectedPlcTypes as string[])
          : undefined,
        outputFields: Array.isArray(body.outputFields)
          ? (body.outputFields as string[])
          : undefined,
        faultProbabilityPct: Number(body.faultProbabilityPct ?? 5),
        malformedRatePct: Number(body.malformedRatePct ?? 7),
        outOfOrderRatePct: Number(body.outOfOrderRatePct ?? 8),
        rotateMaxLines: Number(body.rotateMaxLines ?? jobConfig.current.rotateMaxLines),
        seed: Number(body.seed ?? 42),
        customMachineTopology:
          typeof body.customMachineTopology === 'string'
            ? body.customMachineTopology
            : jobConfig.current.customMachineTopology,
        ignoredErrorCodes:
          typeof body.ignoredErrorCodes === 'string'
            ? body.ignoredErrorCodes
            : jobConfig.current.ignoredErrorCodes,
        horizonWindows: Number(body.horizonWindows ?? jobConfig.current.horizonWindows),
        tempAnomalyThresholdC: Number(
          body.tempAnomalyThresholdC ?? jobConfig.current.tempAnomalyThresholdC
        ),
        vibrationP95Threshold: Number(
          body.vibrationP95Threshold ?? jobConfig.current.vibrationP95Threshold
        ),
        minValidSampleRatio: Number(
          body.minValidSampleRatio ?? jobConfig.current.minValidSampleRatio
        ),
        dedupStrategy:
          (body.dedupStrategy as JobConfig['dedupStrategy'] | undefined) ??
          jobConfig.current.dedupStrategy,
        malformedPolicy:
          (body.malformedPolicy as JobConfig['malformedPolicy'] | undefined) ??
          jobConfig.current.malformedPolicy,
        parquetCompression:
          (body.parquetCompression as JobConfig['parquetCompression'] | undefined) ??
          jobConfig.current.parquetCompression,
        datasetVersion:
          typeof body.datasetVersion === 'string'
            ? body.datasetVersion
            : jobConfig.current.datasetVersion,
        partitionLayout:
          (body.partitionLayout as JobConfig['partitionLayout'] | undefined) ??
          jobConfig.current.partitionLayout,
        lakehouseFormat:
          (body.lakehouseFormat as JobConfig['lakehouseFormat'] | undefined) ??
          jobConfig.current.lakehouseFormat,
        hotRetentionDays: Number(body.hotRetentionDays ?? jobConfig.current.hotRetentionDays),
        coldRetentionDays: Number(body.coldRetentionDays ?? jobConfig.current.coldRetentionDays),
        coldStorageEndpoint:
          (body.coldStorageEndpoint as JobConfig['coldStorageEndpoint'] | undefined) ??
          jobConfig.current.coldStorageEndpoint,
        compactionSchedule:
          (body.compactionSchedule as JobConfig['compactionSchedule'] | undefined) ??
          jobConfig.current.compactionSchedule,
        ingestTransport:
          (body.ingestTransport as JobConfig['ingestTransport'] | undefined) ??
          jobConfig.current.ingestTransport,
      });
      res.status(201).json(snapshot);
    } catch (err) {
      logInternalError(err, 'Unable to start streaming simulation', requestId);
      res.status(500).json({
        error: 'Unable to start streaming simulation',
        tier,
        requestId,
      });
    }
  });

  apiRouter.get('/pipeline/runs/:id', requireScope('read'), (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    const run = runManager.getRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: 'Simulation run not found', tier, requestId });
      return;
    }
    res.json(runManager.buildSnapshot(run));
  });

  apiRouter.get('/pipeline/runs/:id/stream', requireScope('read'), (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    const runId = req.params.id;
    const run = runManager.getRun(runId);
    if (!run) {
      res.status(404).json({ error: 'Simulation run not found', tier, requestId });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sendEvent = (snapshot: LiveRunSnapshot) => {
      res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      if (snapshot.status === 'completed' || snapshot.status === 'stopped') {
        cleanup();
        res.end();
      }
    };

    const unsubscribe = runManager.subscribe(runId, sendEvent);
    const keepAlive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 15000);

    const cleanup = () => {
      clearInterval(keepAlive);
      unsubscribe();
    };

    req.on('close', cleanup);
    sendEvent(runManager.buildSnapshot(run));
  });

  apiRouter.post('/pipeline/runs/:id/pause', requireScope('admin'), (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    const snap = runManager.pauseRun(req.params.id);
    if (!snap) {
      res.status(404).json({ error: 'Simulation run not found', tier, requestId });
      return;
    }
    res.json(snap);
  });

  apiRouter.post('/pipeline/runs/:id/resume', requireScope('admin'), (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    const snap = runManager.resumeRun(req.params.id);
    if (!snap) {
      res.status(404).json({ error: 'Simulation run not found', tier, requestId });
      return;
    }
    res.json(snap);
  });

  apiRouter.post('/pipeline/runs/:id/stop', requireScope('admin'), (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    const snap = runManager.stopRun(req.params.id);
    if (!snap) {
      res.status(404).json({ error: 'Simulation run not found', tier, requestId });
      return;
    }
    res.json(snap);
  });
}
