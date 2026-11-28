import type { Router } from 'express';
import { projectRowFields } from '../../apiSchemas.ts';
import { sanitizeCsvCell } from '../../utils/persistence.ts';
import type { HttpContext } from '../context.ts';

/** Business analytics: controllo di gestione KPIs (JSON and formula-safe CSV) for Power BI and Grafana. */
export function registerAnalyticsRoutes(apiRouter: Router, ctx: HttpContext): void {
  const { dbStore, runManager, jobConfig, requireScope } = ctx;

  apiRouter.get('/ba/kpi', requireScope('read'), async (req, res) => {
    const machineType =
      typeof req.query.machineType === 'string' && req.query.machineType.trim()
        ? req.query.machineType.trim()
        : undefined;
    const domain =
      typeof req.query.domain === 'string' && req.query.domain.trim()
        ? req.query.domain.trim()
        : undefined;
    const fromDate =
      typeof req.query.fromDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.fromDate.trim())
        ? req.query.fromDate.trim()
        : undefined;
    const toDate =
      typeof req.query.toDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.toDate.trim())
        ? req.query.toDate.trim()
        : undefined;
    const sourcePref =
      typeof req.query.source === 'string' ? req.query.source.trim().toLowerCase() : 'auto';
    const fieldsRaw = typeof req.query.fields === 'string' ? req.query.fields : '';
    const requestedFields = fieldsRaw
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean);
    const format = typeof req.query.format === 'string' ? req.query.format.trim().toLowerCase() : 'json';

    let dataSource: 'postgres' | 'live-snapshot' = 'live-snapshot';
    let rawRows: Array<Record<string, unknown>> = [];

    if (sourcePref !== 'live' && dbStore.isPostgresActive()) {
      try {
        const pgRows = await dbStore.queryBaKpiDaily({
          domain,
          machineType,
          fromDate,
          toDate,
        });
        if (pgRows.length > 0 || sourcePref === 'postgres') {
          rawRows = pgRows as unknown as Array<Record<string, unknown>>;
          dataSource = 'postgres';
        }
      } catch {
        // Fallback to live snapshot if Postgres view query fails
      }
    }

    if (dataSource === 'live-snapshot') {
      rawRows = runManager.getBusinessAnalyticsKpis({ machineType, domain }) as unknown as Array<
        Record<string, unknown>
      >;
    }

    const projectedRows =
      requestedFields.length > 0
        ? rawRows.map((r) => projectRowFields(r, requestedFields))
        : rawRows;

    if (format === 'csv') {
      const cols =
        projectedRows.length > 0
          ? Object.keys(projectedRows[0])
          : requestedFields.length > 0
          ? requestedFields
          : [
              'dt',
              'domain',
              'line_id',
              'machine_id',
              'machine_type',
              'availability_oee_pct',
              'primary_metric_name',
              'primary_metric_avg',
              'estimated_energy_kwh',
              'estimated_gas_volume_nm3',
            ];
      const lines = [
        cols.map((c) => sanitizeCsvCell(c)).join(','),
        ...projectedRows.map((row) =>
          cols
            .map((c) => sanitizeCsvCell((row as Record<string, unknown>)[c] ?? ''))
            .join(',')
        ),
      ];
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="ba_kpi_export.csv"');
      res.send(lines.join('\n'));
      return;
    }

    res.json({
      generatedAt: new Date().toISOString(),
      dataSource,
      datasetVersion: jobConfig.current.datasetVersion,
      filters: {
        machineType: machineType ?? null,
        domain: domain ?? null,
        fromDate: fromDate ?? null,
        toDate: toDate ?? null,
        fields: requestedFields.length > 0 ? requestedFields : null,
      },
      rowCount: projectedRows.length,
      rows: projectedRows,
    });
  });
}
