import { describe, expect, it } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import { DatabaseStore, type QueryablePool } from '../src/db.ts';
import type { MlFeatureRow } from '../src/types/pipeline.ts';

function createMockPool() {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const stateMap = new Map<string, unknown>();

  const pool: QueryablePool = {
    async query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: unknown[]
    ): Promise<QueryResult<R>> {
      calls.push({ text, values });
      const normalized = text.trim().toUpperCase();

      if (normalized.startsWith('INSERT INTO CONTROL_PLANE_STATE')) {
        stateMap.set(String(values?.[0]), JSON.parse(String(values?.[1])));
        return { rows: [], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
      }
      if (normalized.startsWith('SELECT PAYLOAD_JSON FROM CONTROL_PLANE_STATE')) {
        const key = String(values?.[0]);
        const found = stateMap.get(key);
        return {
          rows: found !== undefined ? ([{ payload_json: found }] as unknown as R[]) : [],
          rowCount: found !== undefined ? 1 : 0,
          command: 'SELECT',
          oid: 0,
          fields: [],
        };
      }
      if (normalized.includes('FROM ML_MACHINE_FEATURES') && normalized.includes('COUNT(*)')) {
        return {
          rows: [{ total: '42' }] as unknown as R[],
          rowCount: 1,
          command: 'SELECT',
          oid: 0,
          fields: [],
        };
      }
      if (normalized.includes('FROM VW_BA_CONTROLLO_GESTIONE_DAILY')) {
        return {
          rows: [
            {
              dt: '2026-11-22',
              domain: 'gas-metering',
              line_id: 'line-01',
              machine_id: 'GAS-01',
              machine_type: 'gas-flow-meter',
              observed_windows: 12,
              total_samples: 360,
              monitored_hours: 1.0,
              downtime_fault_hours: 0.02,
              availability_oee_pct: 98.0,
              total_errors: 1,
              total_fault_events: 1,
              anomalous_windows: 0,
              avg_temp_c: 23.1,
              peak_temp_c: 25.4,
              primary_metric_name: 'flow_nm3_h',
              primary_metric_unit: 'Nm3/h',
              primary_metric_avg: 425.2,
              primary_metric_peak: 460.0,
              estimated_energy_kwh: 0,
              estimated_gas_volume_nm3: 425.2,
              dataset_version: 'v1.0.0',
            },
          ] as unknown as R[],
          rowCount: 1,
          command: 'SELECT',
          oid: 0,
          fields: [],
        };
      }
      return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
    },
    async end() {
      
    },
  };

  return { pool, calls };
}

const SAMPLE_FEATURE_ROW: MlFeatureRow = {
  machine_id: 'GAS-01',
  window_start: '2026-11-22T06:00:00.000Z',
  window_minutes: 5,
  dt: '2026-11-22',
  line_id: 'line-01',
  machine_type: 'gas-flow-meter',
  domain: 'gas-metering',
  sample_count: 30,
  valid_sample_ratio: 1,
  primary_metric_name: 'flow_nm3_h',
  primary_metric_unit: 'Nm3/h',
  primary_metric_mean: 425.5,
  primary_metric_p95: 448.0,
  primary_metric_max: 455.2,
  secondary_metric_name: 'pressure_bar',
  secondary_metric_unit: 'bar',
  secondary_metric_mean: 14.8,
  temp_mean: 22.8,
  temp_max: 24.1,
  vibration_mean: 0,
  vibration_p95: 0,
  vibration_max: 0,
  cycle_ms_mean: 0,
  cycle_ms_std: 0,
  error_count: 0,
  fault_count: 0,
  degraded_count: 0,
  state_transitions_count: 0,
  time_in_fault_sec: 0,
  missing_heartbeat_count: 0,
  is_anomalous_window: 0,
  will_fail_next_window: 0,
  custom_metrics_avg: { calorific_mj_m3: 38.6 },
  dataset_version: 'v1.0.0',
};

describe('PostgreSQL DatabaseStore Adapter', () => {
  it('runs cleanly in file-fallback mode when DATABASE_URL is absent', async () => {
    const store = new DatabaseStore({ databaseUrl: '' });
    const connected = await store.init();
    expect(connected).toBe(false);
    expect(store.isPostgresActive()).toBe(false);

    const health = await store.getHealthStatus();
    expect(health.mode).toBe('file-fallback');
    expect(health.connected).toBe(false);
  });

  it('bootstraps schema, persists JSONB control-plane state, upserts ML features, and queries BA views', async () => {
    const { pool, calls } = createMockPool();
    const store = new DatabaseStore({ pool });

    const connected = await store.init();
    expect(connected).toBe(true);
    expect(store.isPostgresActive()).toBe(true);

    // Bootstrap ran SELECT 1 + idempotent DDL
    expect(calls.some((c) => c.text.includes('CREATE TABLE IF NOT EXISTS control_plane_state'))).toBe(true);
    expect(calls.some((c) => c.text.includes('CREATE OR REPLACE VIEW vw_ba_controllo_gestione_daily'))).toBe(true);

    // JSONB control plane round-trip
    await store.saveState('job_config', { environment: 'production', windowMinutes: 5 });
    const loaded = await store.getState<{ environment: string; windowMinutes: number }>('job_config');
    expect(loaded).toEqual({ environment: 'production', windowMinutes: 5 });

    // Parameterized ML feature mart upsert
    const written = await store.upsertFeatureRows([SAMPLE_FEATURE_ROW], 'v1.0.0');
    expect(written).toBe(1);
    const upsertCall = calls.find((c) => c.text.includes('INSERT INTO ml_machine_features'));
    expect(upsertCall).toBeDefined();
    expect(upsertCall?.values?.length).toBe(35);

    // Parameterized BA view query (blocks invalid date injection)
    const rows = await store.queryBaKpiDaily({
      domain: 'gas-metering',
      fromDate: '2026-11-01',
      toDate: "2026-11-30; DROP TABLE ml_machine_features;--",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].machine_id).toBe('GAS-01');
    const baCall = calls.find(
      (c) =>
        c.text.trim().startsWith('SELECT') &&
        c.text.includes('FROM vw_ba_controllo_gestione_daily')
    );
    expect(baCall?.text).toContain('domain = $1');
    expect(baCall?.text).toContain('dt::DATE >= $2::DATE');
    // Malformed toDate must be ignored and never interpolated
    expect(baCall?.text).not.toContain('DROP TABLE');

    const health = await store.getHealthStatus();
    expect(health.mode).toBe('postgres');
    expect(health.connected).toBe(true);
    expect(health.featureRowsStored).toBe(42);
  });
});
