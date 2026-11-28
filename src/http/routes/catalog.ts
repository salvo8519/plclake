import type { Router } from 'express';
import { formatZodIssues, PlcCatalogUpsertPermissiveSchema, PlcCatalogUpsertStrictSchema, PlcOutputPreviewRequestSchema, projectRowFields } from '../../apiSchemas.ts';
import type { PlcCatalogProfile } from '../../types/pipeline.ts';
import { getRequestContext, logInternalError } from '../requestInput.ts';
import type { HttpContext } from '../context.ts';

/** PLC / machine catalog: built-in and custom profiles and output preview. */
export function registerCatalogRoutes(apiRouter: Router, ctx: HttpContext): void {
  const { plcCatalogManager, requireScope } = ctx;

  apiRouter.get('/catalog/machines', requireScope('read'), (req, res) => {
    const domain = typeof req.query.domain === 'string' ? req.query.domain.trim() : undefined;
    const protocol = typeof req.query.protocol === 'string' ? req.query.protocol.trim() : undefined;
    res.json(plcCatalogManager.listCatalog({ domain, protocol }));
  });

  apiRouter.get('/catalog/machines/:typeId', requireScope('read'), (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    const found = plcCatalogManager.getProfile(req.params.typeId);
    if (!found) {
      res.status(404).json({ error: 'PLC catalog profile not found', tier, requestId });
      return;
    }
    res.json(found);
  });

  apiRouter.post('/catalog/machines', requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    try {
      const schema =
        tier === 'strict' ? PlcCatalogUpsertStrictSchema : PlcCatalogUpsertPermissiveSchema;
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
      const saved = await plcCatalogManager.upsertProfile(
        parsed.data as Partial<PlcCatalogProfile>
      );
      res.status(saved.created ? 201 : 200).json(saved);
    } catch (err) {
      logInternalError(err, 'Failed to save PLC catalog profile', requestId);
      res.status(500).json({
        error: 'Failed to save PLC catalog profile',
        tier,
        requestId,
      });
    }
  });

  apiRouter.delete('/catalog/machines/:typeId', requireScope('admin'), async (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    try {
      const removed = await plcCatalogManager.deleteOrResetProfile(req.params.typeId);
      if (!removed.deleted && !removed.resetToBuiltIn) {
        res.status(404).json({ error: 'PLC catalog profile not found', tier, requestId });
        return;
      }
      res.json(removed);
    } catch (err) {
      logInternalError(err, 'Failed to remove PLC catalog profile', requestId);
      res.status(500).json({
        error: 'Failed to remove PLC catalog profile',
        tier,
        requestId,
      });
    }
  });

  apiRouter.post('/catalog/machines/:typeId/preview-output', requireScope('read'), (req, res) => {
    const { requestId, tier } = getRequestContext(req, res);
    const profile = plcCatalogManager.getProfile(req.params.typeId);
    if (!profile) {
      res.status(404).json({ error: 'PLC catalog profile not found', tier, requestId });
      return;
    }
    const parsed = PlcOutputPreviewRequestSchema.safeParse(req.body ?? {});
    const input = parsed.success ? parsed.data : {};
    const nowIso = new Date().toISOString();
    const machineId = typeof input.machineId === 'string' ? input.machineId : 'PLC-PREVIEW-01';
    const lineId = typeof input.lineId === 'string' ? input.lineId : 'line-01';
    const state = typeof input.state === 'string' ? input.state : 'RUNNING';
    const isFault = state === 'FAULT';
    const isDegraded = state === 'DEGRADED';

    const tempVal = Number(
      (
        profile.tempNominalC +
        (isFault ? (profile.tempFaultThresholdC - profile.tempNominalC) * 1.05 : isDegraded ? 12 : 1.2)
      ).toFixed(2)
    );
    const primaryVal = Number(
      (
        profile.primaryNominal +
        (isFault
          ? (profile.primaryFaultThreshold - profile.primaryNominal) * 1.05
          : isDegraded
          ? (profile.primaryFaultThreshold - profile.primaryNominal) * 0.45
          : profile.primaryStd * 0.5)
      ).toFixed(3)
    );
    const secondaryVal = Number(
      (profile.secondaryNominal + (isFault ? profile.secondaryStd * 4 : profile.secondaryStd * 0.4)).toFixed(3)
    );

    const extraMetrics: Record<string, number> = {};
    for (const ch of profile.extraChannels) {
      extraMetrics[ch.key] = Number((ch.nominal + (isFault ? ch.std * 2.5 : ch.std * 0.3)).toFixed(3));
    }

    const sampleEnvelope = {
      event_id: `prev-${profile.typeId}-${Date.now().toString(36)}`,
      timestamp: nowIso,
      machine_id: machineId,
      line_id: lineId,
      machine_type: profile.typeId,
      domain: profile.domain,
      state,
      level: isFault ? 'ERROR' : isDegraded ? 'WARN' : 'INFO',
      error_code: isFault ? 'ERR_THRESHOLD_EXCEEDED' : null,
      metrics: {
        temp_c: tempVal,
        [profile.primaryKey]: primaryVal,
        [profile.secondaryKey]: secondaryVal,
        ...extraMetrics,
      },
    };

    const fullFeatureRow: Record<string, unknown> = {
      machine_id: machineId,
      line_id: lineId,
      machine_type: profile.typeId,
      domain: profile.domain,
      window_start: `${nowIso.slice(0, 16)}:00.000Z`,
      sample_count: 150,
      valid_sample_ratio: 1,
      temp_mean: tempVal,
      temp_max: Number((tempVal + 1.5).toFixed(2)),
      primary_metric_mean: primaryVal,
      primary_metric_p95: Number((primaryVal * 1.06).toFixed(3)),
      primary_metric_max: Number((primaryVal * 1.1).toFixed(3)),
      secondary_metric_mean: secondaryVal,
      vibration_p95: profile.primaryKey === 'vibration_mm_s' ? primaryVal : secondaryVal,
      cycle_ms_mean: profile.primaryKey === 'cycle_ms' ? primaryVal : 950,
      fault_count: isFault ? 4 : 0,
      time_in_fault_sec: isFault ? 24 : 0,
      is_anomalous_window: isFault || isDegraded ? 1 : 0,
      will_fail_next_window: isDegraded ? 1 : 0,
      custom_metrics_avg: extraMetrics,
    };

    const requestedFields =
      Array.isArray(input.fields) && input.fields.length > 0
        ? input.fields
        : profile.defaultOutputFields;

    const fullBaRow: Record<string, unknown> = {
      dt: nowIso.slice(0, 10),
      domain: profile.domain,
      line_id: lineId,
      machine_id: machineId,
      machine_type: profile.typeId,
      ba_formula: profile.baFormula,
      availability_oee_pct: isFault ? 82.5 : isDegraded ? 96.4 : 99.8,
      primary_metric_name: profile.primaryKey,
      primary_metric_unit: profile.primaryUnit,
      primary_metric_avg: primaryVal,
      estimated_energy_kwh:
        profile.baFormula === 'energy_kwh_integration' ? Number((primaryVal * 8).toFixed(2)) : 0,
      estimated_gas_volume_nm3:
        profile.baFormula === 'gas_nm3_integration' ? Number((primaryVal * 8).toFixed(2)) : 0,
    };

    res.json({
      typeId: profile.typeId,
      profile,
      sampleEnvelope,
      projectedFeatureWindow: projectRowFields(fullFeatureRow, requestedFields),
      projectedBaKpi: fullBaRow,
    });
  });
}
