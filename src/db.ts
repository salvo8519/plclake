import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import { resolveSiteId } from './logger.ts';
import type { AuditLogEntry, MlFeatureRow } from './types/pipeline.ts';

export interface QueryablePool {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<QueryResult<R>>;
  end(): Promise<void>;
}

export interface BaKpiQueryFilter {
  domain?: string;
  lineId?: string;
  machineId?: string;
  machineType?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
}

export interface BaKpiDailyRow {
  dt: string;
  domain: string;
  line_id: string;
  machine_id: string;
  machine_type: string;
  observed_windows: number;
  total_samples: number;
  monitored_hours: number;
  downtime_fault_hours: number;
  availability_oee_pct: number;
  total_errors: number;
  total_fault_events: number;
  anomalous_windows: number;
  avg_temp_c: number;
  peak_temp_c: number;
  primary_metric_name: string;
  primary_metric_unit: string;
  primary_metric_avg: number;
  primary_metric_peak: number;
  estimated_energy_kwh: number;
  estimated_gas_volume_nm3: number;
  dataset_version: string;
}

export interface StorageHealthStatus {
  mode: 'postgres' | 'file-fallback';
  connected: boolean;
  databaseHost: string | null;
  featureRowsStored: number | null;
  lastError: string | null;
}

const BOOTSTRAP_DDL = `
CREATE TABLE IF NOT EXISTS control_plane_state (
  state_key TEXT PRIMARY KEY,
  payload_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  status TEXT NOT NULL,
  request_id TEXT NOT NULL,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log (action);

CREATE TABLE IF NOT EXISTS ml_machine_features (
  machine_id TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_minutes INTEGER NOT NULL,
  dt DATE NOT NULL,
  line_id TEXT NOT NULL,
  machine_type TEXT NOT NULL,
  domain TEXT NOT NULL DEFAULT 'manufacturing',
  sample_count INTEGER NOT NULL,
  valid_sample_ratio DOUBLE PRECISION NOT NULL,
  primary_metric_name TEXT NOT NULL DEFAULT 'cycle_ms',
  primary_metric_unit TEXT NOT NULL DEFAULT 'ms',
  primary_metric_mean DOUBLE PRECISION NOT NULL DEFAULT 0,
  primary_metric_p95 DOUBLE PRECISION NOT NULL DEFAULT 0,
  primary_metric_max DOUBLE PRECISION NOT NULL DEFAULT 0,
  secondary_metric_name TEXT NOT NULL DEFAULT 'vibration_mm_s',
  secondary_metric_unit TEXT NOT NULL DEFAULT 'mm/s',
  secondary_metric_mean DOUBLE PRECISION NOT NULL DEFAULT 0,
  temp_mean DOUBLE PRECISION NOT NULL,
  temp_max DOUBLE PRECISION NOT NULL,
  vibration_mean DOUBLE PRECISION NOT NULL,
  vibration_p95 DOUBLE PRECISION NOT NULL,
  vibration_max DOUBLE PRECISION NOT NULL,
  cycle_ms_mean DOUBLE PRECISION NOT NULL,
  cycle_ms_std DOUBLE PRECISION NOT NULL,
  error_count INTEGER NOT NULL,
  fault_count INTEGER NOT NULL,
  degraded_count INTEGER NOT NULL,
  state_transitions_count INTEGER NOT NULL,
  time_in_fault_sec DOUBLE PRECISION NOT NULL,
  missing_heartbeat_count INTEGER NOT NULL,
  is_anomalous_window INTEGER NOT NULL,
  will_fail_next_window INTEGER,
  custom_metrics_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  dataset_version TEXT NOT NULL DEFAULT 'v1.0.0',
  site_id TEXT NOT NULL DEFAULT 'plant-01',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (dt, machine_id, window_start, window_minutes)
);

ALTER TABLE ml_machine_features
  ADD COLUMN IF NOT EXISTS custom_metrics_json JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE ml_machine_features
  ADD COLUMN IF NOT EXISTS site_id TEXT NOT NULL DEFAULT 'plant-01';

CREATE INDEX IF NOT EXISTS idx_ml_machine_features_dt
  ON ml_machine_features (dt, machine_id);

CREATE INDEX IF NOT EXISTS idx_ml_machine_features_domain_dt
  ON ml_machine_features (domain, dt, line_id);

CREATE OR REPLACE VIEW vw_ba_controllo_gestione_daily AS
SELECT
  dt::TEXT AS dt,
  domain,
  line_id,
  machine_id,
  machine_type,
  COUNT(*)::INTEGER AS observed_windows,
  SUM(sample_count)::INTEGER AS total_samples,
  ROUND(SUM(window_minutes)::NUMERIC / 60.0, 2)::DOUBLE PRECISION AS monitored_hours,
  ROUND(SUM(time_in_fault_sec)::NUMERIC / 3600.0, 4)::DOUBLE PRECISION AS downtime_fault_hours,
  ROUND(
    GREATEST(
      0.0,
      100.0 * (1.0 - (SUM(time_in_fault_sec) / NULLIF(SUM(window_minutes) * 60.0, 0)))
    )::NUMERIC,
    2
  )::DOUBLE PRECISION AS availability_oee_pct,
  SUM(error_count)::INTEGER AS total_errors,
  SUM(fault_count)::INTEGER AS total_fault_events,
  SUM(is_anomalous_window)::INTEGER AS anomalous_windows,
  ROUND(AVG(temp_mean)::NUMERIC, 2)::DOUBLE PRECISION AS avg_temp_c,
  ROUND(MAX(temp_max)::NUMERIC, 2)::DOUBLE PRECISION AS peak_temp_c,
  MAX(primary_metric_name) AS primary_metric_name,
  MAX(primary_metric_unit) AS primary_metric_unit,
  ROUND(AVG(primary_metric_mean)::NUMERIC, 3)::DOUBLE PRECISION AS primary_metric_avg,
  ROUND(MAX(primary_metric_max)::NUMERIC, 3)::DOUBLE PRECISION AS primary_metric_peak,
  ROUND(
    CASE
      WHEN MAX(domain) = 'power-generation'
        THEN SUM(primary_metric_mean * (window_minutes / 60.0))
      ELSE 0.0
    END::NUMERIC,
    2
  )::DOUBLE PRECISION AS estimated_energy_kwh,
  ROUND(
    CASE
      WHEN MAX(domain) = 'gas-metering' AND MAX(primary_metric_name) = 'flow_nm3_h'
        THEN SUM(primary_metric_mean * (window_minutes / 60.0))
      ELSE 0.0
    END::NUMERIC,
    2
  )::DOUBLE PRECISION AS estimated_gas_volume_nm3,
  MAX(dataset_version) AS dataset_version
FROM ml_machine_features
GROUP BY dt, domain, line_id, machine_id, machine_type;

CREATE OR REPLACE VIEW vw_ba_plant_cost_kpi AS
SELECT
  date_trunc('month', dt::DATE)::DATE AS period_month,
  domain,
  line_id,
  COUNT(DISTINCT machine_id)::INTEGER AS active_assets,
  SUM(monitored_hours) AS total_monitored_hours,
  SUM(downtime_fault_hours) AS total_downtime_hours,
  ROUND(AVG(availability_oee_pct)::NUMERIC, 2)::DOUBLE PRECISION AS avg_availability_pct,
  SUM(estimated_energy_kwh) AS total_energy_kwh,
  SUM(estimated_gas_volume_nm3) AS total_gas_nm3,
  SUM(total_fault_events)::INTEGER AS total_faults
FROM vw_ba_controllo_gestione_daily
GROUP BY date_trunc('month', dt::DATE)::DATE, domain, line_id;
`;

function parseDatabaseHost(connectionString: string): string | null {
  try {
    const parsed = new URL(connectionString);
    return parsed.hostname || null;
  } catch {
    return null;
  }
}

export class DatabaseStore {
  private pool: QueryablePool | null = null;
  private databaseUrl: string | null;
  private databaseHost: string | null = null;
  private connected = false;
  private lastError: string | null = null;

  constructor(options?: { databaseUrl?: string; pool?: QueryablePool }) {
    this.databaseUrl = options?.databaseUrl?.trim() || process.env.DATABASE_URL?.trim() || null;
    if (this.databaseUrl) {
      this.databaseHost = parseDatabaseHost(this.databaseUrl);
    }
    if (options?.pool) {
      this.pool = options.pool;
      this.databaseHost = this.databaseHost ?? 'injected-pool';
    }
  }

  isPostgresActive(): boolean {
    return this.connected && this.pool !== null;
  }

  async init(): Promise<boolean> {
    if (!this.pool && !this.databaseUrl) {
      this.connected = false;
      return false;
    }

    if (!this.pool && this.databaseUrl) {
      const useSsl =
        process.env.DATABASE_SSL === 'true' ||
        this.databaseUrl.includes('sslmode=require');
      this.pool = new Pool({
        connectionString: this.databaseUrl,
        max: Number(process.env.DATABASE_POOL_MAX) || 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 3_000,
        ...(useSsl ? { ssl: { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' } } : {}),
      });
    }

    try {
      await this.pool!.query('SELECT 1');
      await this.pool!.query(BOOTSTRAP_DDL);
      this.connected = true;
      this.lastError = null;
      return true;
    } catch (err) {
      this.connected = false;
      this.lastError = err instanceof Error ? err.message : 'PostgreSQL connection failed';
      return false;
    }
  }

  async getState<T>(stateKey: string): Promise<T | null> {
    if (!this.isPostgresActive()) return null;
    const res = await this.pool!.query<{ payload_json: T }>(
      'SELECT payload_json FROM control_plane_state WHERE state_key = $1',
      [stateKey]
    );
    return res.rows[0]?.payload_json ?? null;
  }

  async saveState(stateKey: string, payload: unknown): Promise<boolean> {
    if (!this.isPostgresActive()) return false;
    await this.pool!.query(
      `INSERT INTO control_plane_state (state_key, payload_json, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (state_key)
       DO UPDATE SET payload_json = EXCLUDED.payload_json, updated_at = NOW()`,
      [stateKey, JSON.stringify(payload)]
    );
    return true;
  }

  async upsertFeatureRows(rows: MlFeatureRow[], datasetVersion = 'v1.0.0'): Promise<number> {
    if (!this.isPostgresActive() || rows.length === 0) return 0;

    const batchSize = 50;
    let totalWritten = 0;

    for (let offset = 0; offset < rows.length; offset += batchSize) {
      const chunk = rows.slice(offset, offset + batchSize);
      const values: unknown[] = [];
      const placeholders: string[] = [];

      chunk.forEach((row, idx) => {
        const base = idx * 35;
        const dt = row.dt || row.window_start.slice(0, 10);
        const cols: string[] = [];
        for (let c = 1; c <= 35; c += 1) {
          cols.push(c === 33 ? `$${base + c}::jsonb` : `$${base + c}`);
        }
        placeholders.push(`(${cols.join(', ')})`);

        values.push(
          row.machine_id,
          row.window_start,
          row.window_minutes,
          dt,
          row.line_id,
          row.machine_type,
          row.domain,
          row.sample_count,
          row.valid_sample_ratio,
          row.primary_metric_name,
          row.primary_metric_unit,
          row.primary_metric_mean,
          row.primary_metric_p95,
          row.primary_metric_max,
          row.secondary_metric_name,
          row.secondary_metric_unit,
          row.secondary_metric_mean,
          row.temp_mean,
          row.temp_max,
          row.vibration_mean,
          row.vibration_p95,
          row.vibration_max,
          row.cycle_ms_mean,
          row.cycle_ms_std,
          row.error_count,
          row.fault_count,
          row.degraded_count,
          row.state_transitions_count,
          row.time_in_fault_sec,
          row.missing_heartbeat_count,
          row.is_anomalous_window,
          row.will_fail_next_window,
          JSON.stringify(row.custom_metrics_avg ?? {}),
          datasetVersion,
          row.site_id || resolveSiteId()
        );
      });

      const sql = `
        INSERT INTO ml_machine_features (
          machine_id, window_start, window_minutes, dt, line_id, machine_type, domain,
          sample_count, valid_sample_ratio,
          primary_metric_name, primary_metric_unit, primary_metric_mean, primary_metric_p95, primary_metric_max,
          secondary_metric_name, secondary_metric_unit, secondary_metric_mean,
          temp_mean, temp_max, vibration_mean, vibration_p95, vibration_max,
          cycle_ms_mean, cycle_ms_std, error_count, fault_count, degraded_count,
          state_transitions_count, time_in_fault_sec, missing_heartbeat_count,
          is_anomalous_window, will_fail_next_window, custom_metrics_json, dataset_version, site_id
        )
        VALUES ${placeholders.join(', ')}
        ON CONFLICT (dt, machine_id, window_start, window_minutes)
        DO UPDATE SET
          line_id = EXCLUDED.line_id,
          machine_type = EXCLUDED.machine_type,
          domain = EXCLUDED.domain,
          sample_count = EXCLUDED.sample_count,
          valid_sample_ratio = EXCLUDED.valid_sample_ratio,
          primary_metric_mean = EXCLUDED.primary_metric_mean,
          primary_metric_p95 = EXCLUDED.primary_metric_p95,
          primary_metric_max = EXCLUDED.primary_metric_max,
          secondary_metric_mean = EXCLUDED.secondary_metric_mean,
          temp_mean = EXCLUDED.temp_mean,
          temp_max = EXCLUDED.temp_max,
          vibration_mean = EXCLUDED.vibration_mean,
          vibration_p95 = EXCLUDED.vibration_p95,
          vibration_max = EXCLUDED.vibration_max,
          cycle_ms_mean = EXCLUDED.cycle_ms_mean,
          cycle_ms_std = EXCLUDED.cycle_ms_std,
          error_count = EXCLUDED.error_count,
          fault_count = EXCLUDED.fault_count,
          degraded_count = EXCLUDED.degraded_count,
          state_transitions_count = EXCLUDED.state_transitions_count,
          time_in_fault_sec = EXCLUDED.time_in_fault_sec,
          missing_heartbeat_count = EXCLUDED.missing_heartbeat_count,
          is_anomalous_window = EXCLUDED.is_anomalous_window,
          will_fail_next_window = EXCLUDED.will_fail_next_window,
          custom_metrics_json = EXCLUDED.custom_metrics_json,
          dataset_version = EXCLUDED.dataset_version,
          site_id = EXCLUDED.site_id,
          updated_at = NOW()
      `;

      await this.pool!.query(sql, values);
      totalWritten += chunk.length;
    }

    return totalWritten;
  }

  async queryBaKpiDaily(filter: BaKpiQueryFilter = {}): Promise<BaKpiDailyRow[]> {
    if (!this.isPostgresActive()) return [];

    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter.domain) {
      params.push(filter.domain);
      clauses.push(`domain = $${params.length}`);
    }
    if (filter.lineId) {
      params.push(filter.lineId);
      clauses.push(`line_id = $${params.length}`);
    }
    if (filter.machineId) {
      params.push(filter.machineId);
      clauses.push(`machine_id = $${params.length}`);
    }
    if (filter.machineType) {
      params.push(filter.machineType);
      clauses.push(`machine_type = $${params.length}`);
    }
    if (filter.fromDate && /^\d{4}-\d{2}-\d{2}$/.test(filter.fromDate)) {
      params.push(filter.fromDate);
      clauses.push(`dt::DATE >= $${params.length}::DATE`);
    }
    if (filter.toDate && /^\d{4}-\d{2}-\d{2}$/.test(filter.toDate)) {
      params.push(filter.toDate);
      clauses.push(`dt::DATE <= $${params.length}::DATE`);
    }

    const safeLimit = Math.min(Math.max(1, Number(filter.limit) || 500), 5000);
    params.push(safeLimit);

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const sql = `
      SELECT
        dt, domain, line_id, machine_id, machine_type,
        observed_windows, total_samples, monitored_hours, downtime_fault_hours,
        availability_oee_pct, total_errors, total_fault_events, anomalous_windows,
        avg_temp_c, peak_temp_c, primary_metric_name, primary_metric_unit,
        primary_metric_avg, primary_metric_peak,
        estimated_energy_kwh, estimated_gas_volume_nm3, dataset_version
      FROM vw_ba_controllo_gestione_daily
      ${whereClause}
      ORDER BY dt DESC, machine_id ASC
      LIMIT $${params.length}
    `;

    const res = await this.pool!.query<BaKpiDailyRow>(sql, params);
    return res.rows;
  }

  async insertAuditLog(entry: AuditLogEntry): Promise<void> {
    if (!this.isPostgresActive()) return;
    await this.pool!.query(
      `INSERT INTO audit_log (id, timestamp, actor, actor_role, action, resource, status, request_id, details_json)
       VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        entry.id,
        entry.timestamp,
        entry.actor,
        entry.actorRole,
        entry.action,
        entry.resource,
        entry.status,
        entry.requestId,
        JSON.stringify(entry.details ?? {}),
      ]
    );
  }

  async queryAuditLogs(filter?: {
    action?: string;
    actor?: string;
    status?: string;
    limit?: number;
  }): Promise<AuditLogEntry[]> {
    if (!this.isPostgresActive()) return [];
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter?.action) {
      params.push(`%${filter.action.trim()}%`);
      clauses.push(`action ILIKE $${params.length}`);
    }
    if (filter?.actor) {
      params.push(`%${filter.actor.trim()}%`);
      clauses.push(`actor ILIKE $${params.length}`);
    }
    if (filter?.status) {
      params.push(filter.status.trim());
      clauses.push(`status = $${params.length}`);
    }
    const safeLimit = Math.min(Math.max(1, Number(filter?.limit) || 100), 500);
    params.push(safeLimit);

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const res = await this.pool!.query<{
      id: string;
      timestamp: string | Date;
      actor: string;
      actor_role: string;
      action: string;
      resource: string;
      status: 'ok' | 'denied' | 'error';
      request_id: string;
      details_json: Record<string, unknown>;
    }>(
      `SELECT id, timestamp, actor, actor_role, action, resource, status, request_id, details_json
       FROM audit_log
       ${where}
       ORDER BY timestamp DESC
       LIMIT $${params.length}`,
      params
    );
    return res.rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : String(r.timestamp),
      actor: r.actor,
      actorRole: r.actor_role,
      action: r.action,
      resource: r.resource,
      status: r.status,
      requestId: r.request_id,
      details: r.details_json ?? {},
    }));
  }

  async getHealthStatus(): Promise<StorageHealthStatus> {
    if (!this.isPostgresActive()) {
      return {
        mode: 'file-fallback',
        connected: false,
        databaseHost: this.databaseHost,
        featureRowsStored: null,
        lastError: this.lastError,
      };
    }

    try {
      const countRes = await this.pool!.query<{ total: string }>(
        'SELECT COUNT(*)::TEXT AS total FROM ml_machine_features'
      );
      return {
        mode: 'postgres',
        connected: true,
        databaseHost: this.databaseHost,
        featureRowsStored: Number(countRes.rows[0]?.total ?? 0),
        lastError: null,
      };
    } catch (err) {
      return {
        mode: 'postgres',
        connected: false,
        databaseHost: this.databaseHost,
        featureRowsStored: null,
        lastError: err instanceof Error ? err.message : 'PostgreSQL health query failed',
      };
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end().catch(() => {});
      this.pool = null;
      this.connected = false;
    }
  }
}
