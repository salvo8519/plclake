CREATE TABLE IF NOT EXISTS pipeline_runs (
    run_id TEXT PRIMARY KEY,
    started_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ NOT NULL,
    window_minutes INTEGER NOT NULL,
    total_raw_lines INTEGER NOT NULL,
    new_lines_processed INTEGER NOT NULL DEFAULT 0,
    valid_events INTEGER NOT NULL,
    quarantined_events INTEGER NOT NULL,
    feature_rows_written INTEGER NOT NULL,
    high_watermark_ts TIMESTAMPTZ,
    dataset_version TEXT NOT NULL,
    s3_prefix TEXT
);

-- Hot Operational & BI Feature Mart partitioned declaratively by date (dt)
-- Enables zero-lock retention aging via partition detach/drop instead of heavy DELETE + VACUUM.
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
    dataset_version TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (dt, machine_id, window_start, window_minutes)
) PARTITION BY RANGE (dt);

CREATE TABLE IF NOT EXISTS ml_machine_features_2026_h1
    PARTITION OF ml_machine_features
    FOR VALUES FROM ('2026-01-01') TO ('2026-07-01');

CREATE TABLE IF NOT EXISTS ml_machine_features_2026_q3
    PARTITION OF ml_machine_features
    FOR VALUES FROM ('2026-07-01') TO ('2026-10-01');

CREATE TABLE IF NOT EXISTS ml_machine_features_2026_q4
    PARTITION OF ml_machine_features
    FOR VALUES FROM ('2026-10-01') TO ('2027-01-01');

CREATE TABLE IF NOT EXISTS ml_machine_features_2027_h1
    PARTITION OF ml_machine_features
    FOR VALUES FROM ('2027-01-01') TO ('2027-07-01');

CREATE TABLE IF NOT EXISTS ml_machine_features_default
    PARTITION OF ml_machine_features DEFAULT;

CREATE INDEX IF NOT EXISTS idx_ml_machine_features_dt
    ON ml_machine_features (dt, machine_id);

CREATE INDEX IF NOT EXISTS idx_ml_machine_features_domain_dt
    ON ml_machine_features (domain, dt, line_id);

CREATE INDEX IF NOT EXISTS idx_ml_machine_features_horizon
    ON ml_machine_features (machine_id, window_start)
    WHERE will_fail_next_window IS NOT NULL;

-- Automated Hot Tier retention pruning: drops partitions strictly older than retention_days
-- Cold history remains queryable on Garage S3 / Iceberg / Parquet.
CREATE OR REPLACE FUNCTION prune_hot_feature_partitions(retention_days INTEGER DEFAULT 90)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    cutoff_date DATE := CURRENT_DATE - retention_days;
    rec RECORD;
    bound_text TEXT;
    upper_bound DATE;
    dropped_count INTEGER := 0;
BEGIN
    FOR rec IN
        SELECT c.relname AS part_name, pg_get_expr(c.relpartbound, c.oid) AS part_bound
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = 'ml_machine_features'
          AND c.relname <> 'ml_machine_features_default'
    LOOP
        bound_text := substring(rec.part_bound FROM 'TO \(''([^'']+)''\)');
        IF bound_text IS NOT NULL AND bound_text <> 'MAXVALUE' THEN
            upper_bound := bound_text::DATE;
            IF upper_bound <= cutoff_date THEN
                EXECUTE format('DROP TABLE IF EXISTS %I', rec.part_name);
                dropped_count := dropped_count + 1;
            END IF;
        END IF;
    END LOOP;
    RETURN dropped_count;
END;
$$;

-- Standard Business Analytics / Controllo di Gestione SQL Views
-- Ready for Power BI, Tableau, Qlik, Excel PowerQuery, SAP Analytics via PostgreSQL/ODBC/JDBC
CREATE OR REPLACE VIEW vw_ba_controllo_gestione_daily AS
SELECT
    dt,
    domain,
    line_id,
    machine_id,
    machine_type,
    COUNT(*) AS observed_windows,
    SUM(sample_count) AS total_samples,
    ROUND(SUM(window_minutes)::NUMERIC / 60.0, 2) AS monitored_hours,
    ROUND(SUM(time_in_fault_sec)::NUMERIC / 3600.0, 4) AS downtime_fault_hours,
    ROUND(
        GREATEST(
            0.0,
            100.0 * (1.0 - (SUM(time_in_fault_sec) / NULLIF(SUM(window_minutes) * 60.0, 0)))
        )::NUMERIC,
        2
    ) AS availability_oee_pct,
    SUM(error_count) AS total_errors,
    SUM(fault_count) AS total_fault_events,
    SUM(is_anomalous_window) AS anomalous_windows,
    ROUND(AVG(temp_mean)::NUMERIC, 2) AS avg_temp_c,
    ROUND(MAX(temp_max)::NUMERIC, 2) AS peak_temp_c,
    MAX(primary_metric_name) AS primary_metric_name,
    MAX(primary_metric_unit) AS primary_metric_unit,
    ROUND(AVG(primary_metric_mean)::NUMERIC, 3) AS primary_metric_avg,
    ROUND(MAX(primary_metric_max)::NUMERIC, 3) AS primary_metric_peak,
    ROUND(
        CASE
            WHEN MAX(domain) = 'power-generation'
                THEN SUM(primary_metric_mean * (window_minutes / 60.0))
            ELSE 0.0
        END::NUMERIC,
        2
    ) AS estimated_energy_kwh,
    ROUND(
        CASE
            WHEN MAX(domain) = 'gas-metering' AND MAX(primary_metric_name) = 'flow_nm3_h'
                THEN SUM(primary_metric_mean * (window_minutes / 60.0))
            ELSE 0.0
        END::NUMERIC,
        2
    ) AS estimated_gas_volume_nm3,
    MAX(dataset_version) AS dataset_version
FROM ml_machine_features
GROUP BY dt, domain, line_id, machine_id, machine_type;

CREATE OR REPLACE VIEW vw_ba_plant_cost_kpi AS
SELECT
    date_trunc('month', dt)::DATE AS period_month,
    domain,
    line_id,
    COUNT(DISTINCT machine_id) AS active_assets,
    SUM(monitored_hours) AS total_monitored_hours,
    SUM(downtime_fault_hours) AS total_downtime_hours,
    ROUND(AVG(availability_oee_pct), 2) AS avg_availability_pct,
    SUM(estimated_energy_kwh) AS total_energy_kwh,
    SUM(estimated_gas_volume_nm3) AS total_gas_nm3,
    SUM(total_fault_events) AS total_faults
FROM vw_ba_controllo_gestione_daily
GROUP BY date_trunc('month', dt)::DATE, domain, line_id;
