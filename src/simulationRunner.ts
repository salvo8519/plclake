import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getAllCatalogProfiles, resolveMachineSpec } from './machineCatalog.ts';
import { resolveSiteId } from './logger.ts';
import { BoundedRecentSet } from './utils/boundedRecentSet.ts';
import { atomicWriteJson } from './utils/persistence.ts';
import type { AlertEngine } from './alertEngine.ts';
import type { DatabaseStore } from './db.ts';
import {
  createMachineProfiles,
  floorToWindowIso,
  generateMalformedRecord,
  generateValidEvent,
  payloadHash,
  SeededRng,
  VALID_STATES,
  type MachineProfile,
} from './pipelineSimulation.ts';
import type {
  BusinessAnalyticsKpiRow,
  LiveLogFeedEntry,
  LiveRunConfig,
  LiveRunSnapshot,
  LiveRunStatus,
  LogLevel,
  LogSegmentInfo,
  MachineDomain,
  MachineProfileMode,
  MachineState,
  MlFeatureRow,
  QuarantineRecord,
  RawMachineEvent,
} from './types/pipeline.ts';

interface WindowBucket {
  machineId: string;
  windowStart: string;
  dt: string;
  lineId: string;
  machineType: string;
  domain: MachineDomain;
  primaryMetricName: string;
  primaryMetricUnit: string;
  secondaryMetricName: string;
  secondaryMetricUnit: string;
  sampleCount: number;
  faultCount: number;
  degradedCount: number;
  errorCount: number;
  primarySum: number;
  primaryMax: number;
  primaryValues: number[];
  secondarySum: number;
  tempSum: number;
  tempMax: number;
  vibSum: number;
  vibMax: number;
  vibValues: number[];
  cycleSum: number;
  cycleSqSum: number;
  customSums: Record<string, number>;
  customCounts: Record<string, number>;
  timeline: Array<{ tsMs: number; state: MachineState }>;
}

interface InternalRun {
  runId: string;
  status: LiveRunStatus;
  config: LiveRunConfig;
  ignoredErrorSet: Set<string>;
  startedAtMs: number;
  lastTickMs: number;
  elapsedWallMs: number;
  elapsedSimSec: number;
  targetSimSec: number;
  targetTotalCalls: number;
  totalCallsEmitted: number;
  validEventsCount: number;
  quarantinedCount: number;
  outOfOrderCount: number;
  expectedSampleSec: number;
  highWatermarkIso: string | null;
  baseSimMs: number;
  rng: SeededRng;
  profiles: MachineProfile[];
  seenQuarantineIds: BoundedRecentSet;
  seenEventKeys: BoundedRecentSet;
  quarantineRecords: QuarantineRecord[];
  recentLogs: LiveLogFeedEntry[];
  segments: LogSegmentInfo[];
  currentSegLines: number;
  currentSegBytes: number;
  segSeq: number;
  windowBuckets: Map<string, WindowBucket>;
  /** Feature rows / anomalous windows already evicted from `windowBuckets`. */
  evictedFeatureRows: number;
  evictedAnomalousWindows: number;
  /** Newest window start already evicted: older events would re-create a counted window. */
  evictionWatermark: string | null;
  /** Events dropped because their window was already evicted (too late to aggregate). */
  lateEventsDropped: number;
  partitionSet: Set<string>;
  timer: ReturnType<typeof setInterval> | null;
  emitter: EventEmitter;
}

const TICK_MS = 400;
const MAX_RECENT_LOGS = 180;
const MAX_QUARANTINE_DISPLAY = 200;
const MAX_FEATURE_DISPLAY = 360;
const MAX_EVENTS_PER_TICK = 4000;
/**
 * Upper bound on aggregation windows kept in memory per run. Continuous edge ingestion would
 * otherwise grow memory and per-batch feature computation without limit. Older windows are
 * folded into cumulative counters before eviction; snapshots only expose the newest rows.
 */
const MAX_WINDOW_BUCKETS = 5000;
const WINDOW_BUCKET_EVICTION_TARGET = Math.floor(MAX_WINDOW_BUCKETS * 0.9);
const MAX_DEDUP_KEYS = 50_000;

const DOMAIN_PROFILE_MODES = new Set<string>([
  'mixed',
  'manufacturing',
  'gas-metering',
  'power-generation',
]);

export class SimulationRunManager {
  private runs = new Map<string, InternalRun>();
  private latestRunId: string | null = null;
  private restoredSnapshot: LiveRunSnapshot | null = null;
  private stateFile: string | null;
  private dbStore: DatabaseStore | null;
  private alertEngine: AlertEngine | null;

  constructor(rootDir?: string, dbStore?: DatabaseStore, alertEngine?: AlertEngine) {
    this.stateFile = rootDir ? path.resolve(rootDir, '.state', 'latest-run.json') : null;
    this.dbStore = dbStore ?? null;
    this.alertEngine = alertEngine ?? null;
  }

  async init(): Promise<void> {
    if (!this.stateFile) return;
    try {
      const raw = await fs.readFile(this.stateFile, 'utf-8');
      const parsed = JSON.parse(raw) as LiveRunSnapshot;
      if (parsed && typeof parsed.runId === 'string' && Array.isArray(parsed.features)) {
        if (parsed.status === 'running') {
          parsed.status = 'paused';
        }
        this.restoredSnapshot = parsed;
      }
    } catch {
      // No persisted run snapshot yet
    }
  }

  private async persistSnapshot(snapshot: LiveRunSnapshot): Promise<void> {
    if (this.alertEngine && snapshot.features.length > 0) {
      try {
        await this.alertEngine.evaluateFeatureRows(snapshot.features.slice(0, 40));
      } catch {
        // Non-fatal alert dispatch failure
      }
    }
    if (this.dbStore?.isPostgresActive() && snapshot.features.length > 0) {
      try {
        await this.dbStore.upsertFeatureRows(
          snapshot.features,
          snapshot.config.datasetVersion || 'v1.0.0'
        );
      } catch {
        // Non-fatal if Postgres is momentarily unavailable
      }
    }
    if (!this.stateFile) return;
    try {
      await atomicWriteJson(this.stateFile, snapshot, false);
    } catch {
      // Non-fatal in ephemeral containers
    }
  }

  private evictStaleRuns(maxRetained = 10): void {
    if (this.runs.size <= maxRetained) return;
    for (const [id, run] of this.runs.entries()) {
      if (this.runs.size <= maxRetained) break;
      if (id !== this.latestRunId && (run.status === 'completed' || run.status === 'stopped')) {
        if (run.timer) clearInterval(run.timer);
        run.emitter.removeAllListeners();
        this.runs.delete(id);
      }
    }
  }

  startRun(rawConfig: Partial<LiveRunConfig>): LiveRunSnapshot {
    this.restoredSnapshot = null;
    if (this.latestRunId) {
      const prev = this.runs.get(this.latestRunId);
      if (prev && (prev.status === 'running' || prev.status === 'paused')) {
        this.stopRun(prev.runId);
      }
    }
    this.evictStaleRuns(10);

    const durationMinutes = Math.min(1440, Math.max(1, Math.round(Number(rawConfig.durationMinutes ?? 15))));
    const eventsPerSec = Math.min(50, Math.max(1, Math.round(Number(rawConfig.eventsPerSec ?? 10))));
    const speedMultiplier = ([1, 10, 60, 300].includes(Number(rawConfig.speedMultiplier))
      ? Number(rawConfig.speedMultiplier)
      : 10) as 1 | 10 | 60 | 300;
    const windowMinutes = [1, 5, 15].includes(Number(rawConfig.windowMinutes))
      ? Number(rawConfig.windowMinutes)
      : 5;
    const machineCount = Math.min(32, Math.max(2, Math.round(Number(rawConfig.machineCount ?? 4))));
    const machinesPerLine = Math.min(16, Math.max(1, Math.round(Number(rawConfig.machinesPerLine ?? 2))));
    const catalogIds = new Set(getAllCatalogProfiles().map((p) => p.typeId));
    const candidateMode = typeof rawConfig.machineProfileMode === 'string' ? rawConfig.machineProfileMode.trim().toLowerCase() : 'mixed';
    const machineProfileMode: MachineProfileMode =
      DOMAIN_PROFILE_MODES.has(candidateMode) || catalogIds.has(candidateMode)
        ? candidateMode
        : 'mixed';
    const selectedPlcTypes = Array.isArray(rawConfig.selectedPlcTypes)
      ? rawConfig.selectedPlcTypes.filter((t) => typeof t === 'string' && catalogIds.has(t.trim().toLowerCase()))
      : undefined;
    const outputFields = Array.isArray(rawConfig.outputFields) && rawConfig.outputFields.length > 0
      ? rawConfig.outputFields.filter((f) => typeof f === 'string' && f.trim().length > 0)
      : undefined;
    const faultProbabilityPct = Math.min(30, Math.max(0, Number(rawConfig.faultProbabilityPct ?? 5)));
    const malformedRatePct = Math.min(25, Math.max(0, Number(rawConfig.malformedRatePct ?? 7)));
    const outOfOrderRatePct = Math.min(30, Math.max(0, Number(rawConfig.outOfOrderRatePct ?? 8)));
    const rotateMaxLines = Math.max(100, Math.min(10000, Math.round(Number(rawConfig.rotateMaxLines ?? 1000))));
    const seed = Number.isFinite(Number(rawConfig.seed)) ? Math.round(Number(rawConfig.seed)) : 42;
    const horizonWindows = Math.min(3, Math.max(1, Math.round(Number(rawConfig.horizonWindows ?? 1))));
    const tempAnomalyThresholdC = Number.isFinite(Number(rawConfig.tempAnomalyThresholdC))
      ? Number(rawConfig.tempAnomalyThresholdC)
      : undefined;
    const vibrationP95Threshold = Number.isFinite(Number(rawConfig.vibrationP95Threshold))
      ? Number(rawConfig.vibrationP95Threshold)
      : 3.5;
    const minValidSampleRatio = Number.isFinite(Number(rawConfig.minValidSampleRatio))
      ? Number(rawConfig.minValidSampleRatio)
      : 0.75;
    const datasetVersion = rawConfig.datasetVersion || 'v1.0.0';

    const config: LiveRunConfig = {
      durationMinutes,
      eventsPerSec,
      speedMultiplier,
      windowMinutes,
      machineCount,
      machinesPerLine,
      machineProfileMode,
      ...(selectedPlcTypes && selectedPlcTypes.length > 0 ? { selectedPlcTypes } : {}),
      ...(outputFields && outputFields.length > 0 ? { outputFields } : {}),
      faultProbabilityPct,
      malformedRatePct,
      outOfOrderRatePct,
      rotateMaxLines,
      seed,
      customMachineTopology: rawConfig.customMachineTopology,
      ignoredErrorCodes: rawConfig.ignoredErrorCodes,
      horizonWindows,
      tempAnomalyThresholdC,
      vibrationP95Threshold,
      minValidSampleRatio,
      dedupStrategy: rawConfig.dedupStrategy ?? 'event_id_strict',
      malformedPolicy: rawConfig.malformedPolicy ?? 'quarantine_sha256',
      parquetCompression: rawConfig.parquetCompression ?? 'zstd',
      datasetVersion,
      partitionLayout: rawConfig.partitionLayout ?? 'domain/dt',
      lakehouseFormat: rawConfig.lakehouseFormat ?? 'duckdb-parquet-compacted',
      hotRetentionDays: Number(rawConfig.hotRetentionDays ?? 90),
      coldRetentionDays: Number(rawConfig.coldRetentionDays ?? 1095),
      coldStorageEndpoint: rawConfig.coldStorageEndpoint ?? 'garage-s3-cold',
      compactionSchedule: rawConfig.compactionSchedule ?? 'daily-01utc',
      ingestTransport: rawConfig.ingestTransport ?? 'local-segments',
    };

    const ignoredErrorSet = new Set(
      (rawConfig.ignoredErrorCodes ?? '')
        .split(/[\n,]+/)
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean)
    );

    const runId = `sim-${crypto.randomUUID().slice(0, 8)}`;
    const baseSimMs = Math.floor(Date.now() / 1000) * 1000;
    const targetSimSec = durationMinutes * 60;
    const targetTotalCalls = targetSimSec * eventsPerSec;
    const profiles = createMachineProfiles(
      machineCount,
      machinesPerLine,
      machineProfileMode,
      rawConfig.customMachineTopology,
      selectedPlcTypes
    );
    const expectedSampleSec = Number((profiles.length / eventsPerSec).toFixed(3));

    const run: InternalRun = {
      runId,
      status: 'running',
      config,
      ignoredErrorSet,
      startedAtMs: Date.now(),
      lastTickMs: Date.now(),
      elapsedWallMs: 0,
      elapsedSimSec: 0,
      targetSimSec,
      targetTotalCalls,
      totalCallsEmitted: 0,
      validEventsCount: 0,
      quarantinedCount: 0,
      outOfOrderCount: 0,
      expectedSampleSec,
      highWatermarkIso: null,
      baseSimMs,
      rng: new SeededRng(seed),
      profiles,
      seenQuarantineIds: new BoundedRecentSet(MAX_DEDUP_KEYS),
      seenEventKeys: new BoundedRecentSet(MAX_DEDUP_KEYS),
      quarantineRecords: [],
      recentLogs: [],
      segments: [],
      currentSegLines: 0,
      currentSegBytes: 0,
      segSeq: 0,
      windowBuckets: new Map<string, WindowBucket>(),
      evictedFeatureRows: 0,
      evictedAnomalousWindows: 0,
      evictionWatermark: null,
      lateEventsDropped: 0,
      partitionSet: new Set<string>(),
      timer: null,
      emitter: new EventEmitter(),
    };

    if (this.runs.size >= 5) {
      const oldestKey = this.runs.keys().next().value;
      if (oldestKey) {
        const oldRun = this.runs.get(oldestKey);
        if (oldRun?.timer) clearInterval(oldRun.timer);
        this.runs.delete(oldestKey);
      }
    }

    this.runs.set(runId, run);
    this.latestRunId = runId;

    if (run.status === 'running') {
      run.timer = setInterval(() => this.onTick(run), TICK_MS);
    }

    return this.buildSnapshot(run);
  }

  ingestExternalBatch(
    rawEvents: unknown[],
    runDefaults?: Partial<LiveRunConfig>
  ): {
    runId: string;
    accepted: number;
    deduplicated: number;
    quarantined: number;
  } {
    let run = this.latestRunId ? this.runs.get(this.latestRunId) : undefined;
    if (!run) {
      this.startRun({
        durationMinutes: 60,
        eventsPerSec: 10,
        speedMultiplier: 1,
        ...runDefaults,
      });
      run = this.latestRunId ? this.runs.get(this.latestRunId) : undefined;
      if (run) {
        this.pauseRun(run.runId);
      }
    }
    if (!run) {
      throw new Error('Unable to initialize target ingestion run');
    }

    let accepted = 0;
    let deduplicated = 0;
    let quarantined = 0;

    for (const rawItem of rawEvents) {
      const rawLine = typeof rawItem === 'string' ? rawItem : JSON.stringify(rawItem);
      const parsed =
        typeof rawItem === 'string'
          ? (() => {
              try {
                return JSON.parse(rawItem) as unknown;
              } catch {
                return null;
              }
            })()
          : rawItem;

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.recordQuarantine(run, 'http_ingest', 'invalid_json_object', rawLine, new Date().toISOString());
        quarantined += 1;
        run.totalCallsEmitted += 1;
        continue;
      }

      const obj = parsed as Record<string, unknown>;
      const machineId = typeof obj.machine_id === 'string' ? obj.machine_id.trim() : '';
      const tsStr = typeof obj.timestamp === 'string' ? obj.timestamp : '';
      const tsMs = Date.parse(tsStr);
      const stateUpper = typeof obj.state === 'string' ? (obj.state.toUpperCase() as MachineState) : null;
      const metricsObj =
        obj.metrics && typeof obj.metrics === 'object' && !Array.isArray(obj.metrics)
          ? (obj.metrics as Record<string, unknown>)
          : null;

      if (!machineId || Number.isNaN(tsMs) || !stateUpper || !VALID_STATES.has(stateUpper)) {
        this.recordQuarantine(run, 'http_ingest', 'missing_or_invalid_envelope', rawLine, new Date().toISOString());
        quarantined += 1;
        run.totalCallsEmitted += 1;
        continue;
      }

      const rawTemp = metricsObj ? Number(metricsObj.temp_c) : Number(obj.temp_c);
      if (!Number.isFinite(rawTemp) || rawTemp < -50 || rawTemp > 250) {
        this.recordQuarantine(run, 'http_ingest', 'invalid_or_out_of_range_temp', rawLine, new Date().toISOString());
        quarantined += 1;
        run.totalCallsEmitted += 1;
        continue;
      }

      const machineType = typeof obj.machine_type === 'string' ? obj.machine_type : 'plc-controller';
      const spec = resolveMachineSpec(machineType);
      const primaryVal = metricsObj && obj.metrics
        ? Number(metricsObj[spec.primaryKey] ?? rawTemp)
        : Number(obj[spec.primaryKey] ?? obj.cycle_ms ?? rawTemp);
      const secondaryVal = metricsObj && obj.metrics
        ? Number(metricsObj[spec.secondaryKey] ?? spec.secondaryNominal)
        : Number(obj[spec.secondaryKey] ?? obj.vibration_mm_s ?? spec.secondaryNominal);
      const vibVal = metricsObj ? Number(metricsObj.vibration_mm_s ?? 0) : Number(obj.vibration_mm_s ?? 0);
      const cycleVal = metricsObj ? Number(metricsObj.cycle_ms ?? 1000) : Number(obj.cycle_ms ?? 1000);

      if (!Number.isFinite(primaryVal) || primaryVal < 0) {
        this.recordQuarantine(run, 'http_ingest', 'invalid_primary_metric', rawLine, new Date().toISOString());
        quarantined += 1;
        run.totalCallsEmitted += 1;
        continue;
      }

      const normalizedIso = new Date(tsMs).toISOString();
      const eventId =
        typeof obj.event_id === 'string' && obj.event_id
          ? obj.event_id
          : `evt-${payloadHash('http', rawLine).slice(0, 12)}`;
      const dedupKey =
        run.config.dedupStrategy === 'event_id_plus_timestamp'
          ? `${eventId}::${normalizedIso}`
          : eventId;

      if (run.seenEventKeys.has(dedupKey)) {
        deduplicated += 1;
        continue;
      }
      run.seenEventKeys.add(dedupKey);

      const level: LogLevel = stateUpper === 'FAULT' ? 'ERROR' : stateUpper === 'DEGRADED' ? 'WARN' : 'INFO';
      const mergedMetrics: Record<string, number> = {
        temp_c: Number(rawTemp.toFixed(2)),
        [spec.primaryKey]: Number(primaryVal.toFixed(3)),
        [spec.secondaryKey]: Number.isFinite(secondaryVal)
          ? Number(secondaryVal.toFixed(3))
          : spec.secondaryNominal,
      };
      if (metricsObj) {
        for (const [k, v] of Object.entries(metricsObj)) {
          if (k !== 'temp_c' && k !== spec.primaryKey && k !== spec.secondaryKey && Number.isFinite(Number(v))) {
            mergedMetrics[k] = Number(Number(v).toFixed(4));
          }
        }
      }

      const event: RawMachineEvent = {
        event_id: eventId,
        timestamp: normalizedIso,
        machine_id: machineId,
        line_id: typeof obj.line_id === 'string' && obj.line_id ? obj.line_id : 'line-01',
        machine_type: machineType,
        domain: spec.domain,
        state: stateUpper,
        error_code: typeof obj.error_code === 'string' && obj.error_code ? obj.error_code : null,
        temp_c: Number(rawTemp.toFixed(2)),
        vibration_mm_s: Number.isFinite(vibVal) && vibVal >= 0 ? Number(vibVal.toFixed(3)) : 0,
        cycle_ms: Number.isFinite(cycleVal) && cycleVal > 0 ? Math.round(cycleVal) : 1000,
        primary_metric_name: spec.primaryKey,
        primary_metric_value: Number(primaryVal.toFixed(3)),
        primary_metric_unit: spec.primaryUnit,
        secondary_metric_name: spec.secondaryKey,
        secondary_metric_value: Number.isFinite(secondaryVal) ? Number(secondaryVal.toFixed(3)) : spec.secondaryNominal,
        secondary_metric_unit: spec.secondaryUnit,
        metrics: mergedMetrics,
        payload_valid: true,
        level,
      };

      const envelopeLine = JSON.stringify({
        event_id: event.event_id,
        timestamp: event.timestamp,
        machine_id: event.machine_id,
        line_id: event.line_id,
        machine_type: event.machine_type,
        domain: event.domain,
        state: event.state,
        level: event.level,
        error_code: event.error_code,
        metrics: event.metrics,
      });

      run.validEventsCount += 1;
      run.totalCallsEmitted += 1;
      run.currentSegLines += 1;
      run.currentSegBytes += Buffer.byteLength(envelopeLine, 'utf8') + 1;
      if (!run.highWatermarkIso || event.timestamp > run.highWatermarkIso) {
        run.highWatermarkIso = event.timestamp;
      }
      this.accumulateIntoWindow(run, event);
      this.pushRecentLog(run, {
        seq: run.totalCallsEmitted,
        timestamp: event.timestamp,
        machine_id: event.machine_id,
        line_id: event.line_id,
        machine_type: event.machine_type,
        domain: event.domain,
        state: event.state,
        level: event.level,
        temp_c: event.temp_c,
        vibration_mm_s: event.vibration_mm_s,
        cycle_ms: event.cycle_ms,
        primary_metric_name: event.primary_metric_name,
        primary_metric_value: event.primary_metric_value,
        primary_metric_unit: event.primary_metric_unit,
        quarantined: false,
        error_reason: null,
        raw: envelopeLine,
      });
      this.maybeRotateSegment(run, event.timestamp);
      accepted += 1;
    }

    const snap = this.buildSnapshot(run);
    run.emitter.emit('update', snap);
    void this.persistSnapshot(snap);
    return {
      runId: run.runId,
      accepted,
      deduplicated,
      quarantined,
    };
  }

  getBusinessAnalyticsKpis(filters?: {
    machineType?: string;
    domain?: string;
  }): BusinessAnalyticsKpiRow[] {
    const run = this.latestRunId ? this.runs.get(this.latestRunId) : undefined;
    const features = run ? this.materializeFeatures(run) : this.restoredSnapshot?.features ?? [];
    if (features.length === 0) return [];

    const filteredFeatures = features.filter((row) => {
      if (filters?.machineType && row.machine_type.toLowerCase() !== filters.machineType.trim().toLowerCase()) {
        return false;
      }
      if (filters?.domain && row.domain !== filters.domain) {
        return false;
      }
      return true;
    });

    const grouped = new Map<
      string,
      {
        dt: string;
        domain: MachineDomain;
        line_id: string;
        machine_id: string;
        machine_type: string;
        windows: number;
        windowMinutesSum: number;
        samples: number;
        faultSec: number;
        anomalousWindows: number;
        primaryName: string;
        primaryUnit: string;
        primaryWeightedSum: number;
        energyKwh: number;
        gasNm3: number;
      }
    >();

    for (const row of filteredFeatures) {
      const key = `${row.dt}::${row.machine_id}`;
      let acc = grouped.get(key);
      if (!acc) {
        acc = {
          dt: row.dt,
          domain: row.domain,
          line_id: row.line_id,
          machine_id: row.machine_id,
          machine_type: row.machine_type,
          windows: 0,
          windowMinutesSum: 0,
          samples: 0,
          faultSec: 0,
          anomalousWindows: 0,
          primaryName: row.primary_metric_name,
          primaryUnit: row.primary_metric_unit,
          primaryWeightedSum: 0,
          energyKwh: 0,
          gasNm3: 0,
        };
        grouped.set(key, acc);
      }
      const winHours = row.window_minutes / 60;
      const spec = resolveMachineSpec(row.machine_type);
      acc.windows += 1;
      acc.windowMinutesSum += row.window_minutes;
      acc.samples += row.sample_count;
      acc.faultSec += row.time_in_fault_sec;
      acc.anomalousWindows += row.is_anomalous_window;
      acc.primaryWeightedSum += row.primary_metric_mean;
      if (spec.baFormula === 'energy_kwh_integration' || row.domain === 'power-generation') {
        acc.energyKwh += row.primary_metric_mean * winHours;
      } else if (
        spec.baFormula === 'gas_nm3_integration' ||
        (row.domain === 'gas-metering' && row.primary_metric_name === 'flow_nm3_h')
      ) {
        acc.gasNm3 += row.primary_metric_mean * winHours;
      }
    }

    return Array.from(grouped.values())
      .map((item) => {
        const monitoredHours = item.windowMinutesSum / 60;
        const totalWindowSec = Math.max(1, monitoredHours * 3600);
        const availability = Math.max(0, Math.min(100, ((totalWindowSec - item.faultSec) / totalWindowSec) * 100));
        return {
          dt: item.dt,
          domain: item.domain,
          line_id: item.line_id,
          machine_id: item.machine_id,
          machine_type: item.machine_type,
          observed_windows: item.windows,
          total_samples: item.samples,
          monitored_hours: Number(monitoredHours.toFixed(2)),
          downtime_fault_hours: Number((item.faultSec / 3600).toFixed(4)),
          availability_oee_pct: Number(availability.toFixed(2)),
          anomalous_windows: item.anomalousWindows,
          primary_metric_name: item.primaryName,
          primary_metric_unit: item.primaryUnit,
          primary_metric_avg: Number((item.primaryWeightedSum / Math.max(1, item.windows)).toFixed(3)),
          estimated_energy_kwh: Number(item.energyKwh.toFixed(2)),
          estimated_gas_volume_nm3: Number(item.gasNm3.toFixed(2)),
        };
      })
      .sort((a, b) => b.dt.localeCompare(a.dt) || a.machine_id.localeCompare(b.machine_id));
  }

  private recordQuarantine(
    run: InternalRun,
    source: QuarantineRecord['source'],
    reason: string,
    payload: string,
    tsIso: string
  ): void {
    const qid = payloadHash(reason, payload);
    if (run.seenQuarantineIds.has(qid)) return;
    run.seenQuarantineIds.add(qid);
    run.quarantinedCount += 1;

    if (run.config.malformedPolicy !== 'drop_and_count') {
      run.quarantineRecords.unshift({
        quarantine_id: qid,
        quarantined_at: tsIso,
        source,
        error_reason: reason,
        raw_payload: payload,
      });
      if (run.quarantineRecords.length > MAX_QUARANTINE_DISPLAY) {
        run.quarantineRecords.length = MAX_QUARANTINE_DISPLAY;
      }
    }
  }

  private maybeRotateSegment(run: InternalRun, nominalIso: string): void {
    if (run.currentSegLines >= run.config.rotateMaxLines) {
      run.segSeq += 1;
      const stamp = `${nominalIso.replace(/[-:]/g, '').slice(0, 15)  }Z`;
      const name = `telemetry.${stamp}.${String(run.segSeq).padStart(4, '0')}.jsonl`;
      run.segments.unshift({
        name,
        lines: run.currentSegLines,
        sizeBytes: run.currentSegBytes,
        rotatedAt: nominalIso,
        s3Key: `raw/dt=${nominalIso.slice(0, 10)}/segments/${name}`,
      });
      if (run.segments.length > 100) run.segments.length = 100;
      run.currentSegLines = 0;
      run.currentSegBytes = 0;
    }
  }

  private onTick(run: InternalRun): void {
    if (run.status !== 'running') return;
    const nowMs = Date.now();
    const wallDeltaMs = Math.max(50, Math.min(1000, nowMs - run.lastTickMs));
    run.lastTickMs = nowMs;
    run.elapsedWallMs += wallDeltaMs;

    const simDeltaSec = (wallDeltaMs / 1000) * run.config.speedMultiplier;
    this.advanceRun(run, simDeltaSec);
    run.emitter.emit('update', this.buildSnapshot(run));
  }

  private advanceRun(run: InternalRun, simDeltaSec: number): void {
    const nextElapsedSim = Math.min(run.targetSimSec, run.elapsedSimSec + simDeltaSec);
    const targetCountNow = Math.min(
      run.targetTotalCalls,
      Math.floor(nextElapsedSim * run.config.eventsPerSec)
    );
    const toEmit = Math.min(MAX_EVENTS_PER_TICK, Math.max(0, targetCountNow - run.totalCallsEmitted));
    run.elapsedSimSec = nextElapsedSim;

    const malformedProb = run.config.malformedRatePct / 100;
    const simQuarantineCutoff = malformedProb * 0.55;

    for (let k = 0; k < toEmit; k++) {
      const idx = run.totalCallsEmitted;
      const profile = run.profiles[idx % run.profiles.length];
      const nominalMs = run.baseSimMs + Math.round((idx / run.config.eventsPerSec) * 1000);
      const nominalIso = new Date(nominalMs).toISOString();
      const roll = run.rng.next();

      if (roll < simQuarantineCutoff || roll < malformedProb) {
        const source = roll < simQuarantineCutoff ? 'simulator' : 'dataset_builder';
        const { reason, payload } = generateMalformedRecord(profile.machineId, run.rng, nominalIso);
        this.recordQuarantine(run, source, reason, payload, nominalIso);
        if (source === 'dataset_builder') {
          run.currentSegLines += 1;
          run.currentSegBytes += Buffer.byteLength(payload, 'utf8') + 1;
        }
        this.pushRecentLog(run, {
          seq: idx + 1,
          timestamp: nominalIso,
          machine_id: profile.machineId,
          line_id: profile.lineId,
          machine_type: profile.machineType,
          domain: profile.domain,
          state: 'CORRUPT',
          level: 'QUARANTINE',
          temp_c: null,
          vibration_mm_s: null,
          cycle_ms: null,
          primary_metric_name: profile.spec.primaryKey,
          primary_metric_value: null,
          primary_metric_unit: profile.spec.primaryUnit,
          quarantined: true,
          error_reason: reason,
          raw: payload,
        });
        if (run.config.malformedPolicy === 'halt_on_error') {
          run.totalCallsEmitted += 1;
          run.status = 'stopped';
          if (run.timer) {
            clearInterval(run.timer);
            run.timer = null;
          }
          break;
        }
      } else {
        const { event, isOutOfOrder } = generateValidEvent(
          profile,
          run.rng,
          nominalMs,
          idx,
          run.config.seed,
          {
            faultProbabilityPct: run.config.faultProbabilityPct,
            outOfOrderRatePct: run.config.outOfOrderRatePct,
            minTimestampMs: run.baseSimMs,
          }
        );
        if (isOutOfOrder) run.outOfOrderCount += 1;
        const line = JSON.stringify({
          event_id: event.event_id,
          timestamp: event.timestamp,
          machine_id: event.machine_id,
          line_id: event.line_id,
          machine_type: event.machine_type,
          domain: event.domain,
          state: event.state,
          level: event.level,
          error_code: event.error_code,
          metrics: event.metrics,
        });
        run.currentSegLines += 1;
        run.currentSegBytes += Buffer.byteLength(line, 'utf8') + 1;

        const dedupKey =
          run.config.dedupStrategy === 'event_id_plus_timestamp'
            ? `${event.event_id}::${event.timestamp}`
            : event.event_id;

        if (!run.seenEventKeys.has(dedupKey) && VALID_STATES.has(event.state)) {
          run.seenEventKeys.add(dedupKey);
          run.validEventsCount += 1;
          if (!run.highWatermarkIso || event.timestamp > run.highWatermarkIso) {
            run.highWatermarkIso = event.timestamp;
          }
          this.accumulateIntoWindow(run, event);
        }

        this.pushRecentLog(run, {
          seq: idx + 1,
          timestamp: event.timestamp,
          machine_id: event.machine_id,
          line_id: event.line_id,
          machine_type: event.machine_type,
          domain: event.domain,
          state: event.state,
          level: event.level,
          temp_c: event.temp_c,
          vibration_mm_s: event.vibration_mm_s,
          cycle_ms: event.cycle_ms,
          primary_metric_name: event.primary_metric_name,
          primary_metric_value: event.primary_metric_value,
          primary_metric_unit: event.primary_metric_unit,
          quarantined: false,
          error_reason: null,
          raw: line,
        });
      }

      this.maybeRotateSegment(run, nominalIso);
      run.totalCallsEmitted += 1;
    }

    if (
      run.status === 'running' &&
      run.elapsedSimSec >= run.targetSimSec &&
      run.totalCallsEmitted >= run.targetTotalCalls
    ) {
      run.status = 'completed';
      if (run.timer) {
        clearInterval(run.timer);
        run.timer = null;
      }
      void this.persistSnapshot(this.buildSnapshot(run));
    }
  }

  private pushRecentLog(run: InternalRun, entry: LiveLogFeedEntry): void {
    run.recentLogs.unshift(entry);
    if (run.recentLogs.length > MAX_RECENT_LOGS) {
      run.recentLogs.length = MAX_RECENT_LOGS;
    }
  }

  private accumulateIntoWindow(run: InternalRun, evt: RawMachineEvent): void {
    const tsMs = Date.parse(evt.timestamp);
    const winStart = floorToWindowIso(tsMs, run.config.windowMinutes);
    const dt = winStart.slice(0, 10);
    const key = `${evt.machine_id}::${winStart}`;
    let bucket = run.windowBuckets.get(key);
    if (!bucket && run.evictionWatermark !== null && winStart <= run.evictionWatermark) {
      // The window was already folded into the cumulative counters: aggregating it again
      // would count it twice. Record the drop instead of hiding it.
      run.lateEventsDropped += 1;
      return;
    }
    if (!bucket) {
      bucket = {
        machineId: evt.machine_id,
        windowStart: winStart,
        dt,
        lineId: evt.line_id,
        machineType: evt.machine_type,
        domain: evt.domain,
        primaryMetricName: evt.primary_metric_name,
        primaryMetricUnit: evt.primary_metric_unit,
        secondaryMetricName: evt.secondary_metric_name,
        secondaryMetricUnit: evt.secondary_metric_unit,
        sampleCount: 0,
        faultCount: 0,
        degradedCount: 0,
        errorCount: 0,
        primarySum: 0,
        primaryMax: -Infinity,
        primaryValues: [],
        secondarySum: 0,
        tempSum: 0,
        tempMax: -Infinity,
        vibSum: 0,
        vibMax: 0,
        vibValues: [],
        cycleSum: 0,
        cycleSqSum: 0,
        customSums: {},
        customCounts: {},
        timeline: [],
      };
      run.windowBuckets.set(key, bucket);
      if (run.windowBuckets.size > MAX_WINDOW_BUCKETS) {
        this.evictOldestWindowBuckets(run);
      }
      const layout = run.config.partitionLayout ?? 'domain/dt';
      const hourPart = winStart.slice(11, 13);
      const partPath =
        layout === 'domain/dt'
          ? `domain=${evt.domain}/dt=${dt}/part-compacted.parquet`
          : layout === 'dt/line_id/machine_id'
          ? `dt=${dt}/line_id=${evt.line_id}/machine_id=${evt.machine_id}/part-00000.parquet`
          : layout === 'dt/hour/machine_id'
          ? `dt=${dt}/hour=${hourPart}/machine_id=${evt.machine_id}/part-00000.parquet`
          : `dt=${dt}/machine_id=${evt.machine_id}/part-00000.parquet`;
      run.partitionSet.add(partPath);
    }

    const isIgnoredError =
      evt.error_code !== null && run.ignoredErrorSet.has(evt.error_code.toUpperCase());

    bucket.sampleCount += 1;
    if (evt.state === 'FAULT' && !isIgnoredError) bucket.faultCount += 1;
    if (evt.state === 'DEGRADED') bucket.degradedCount += 1;
    if (evt.error_code !== null && !isIgnoredError) bucket.errorCount += 1;

    bucket.primarySum += evt.primary_metric_value;
    if (evt.primary_metric_value > bucket.primaryMax) bucket.primaryMax = evt.primary_metric_value;
    if (bucket.primaryValues.length < 2500) {
      bucket.primaryValues.push(evt.primary_metric_value);
    }
    bucket.secondarySum += evt.secondary_metric_value;

    bucket.tempSum += evt.temp_c;
    if (evt.temp_c > bucket.tempMax) bucket.tempMax = evt.temp_c;
    bucket.vibSum += evt.vibration_mm_s;
    if (evt.vibration_mm_s > bucket.vibMax) bucket.vibMax = evt.vibration_mm_s;
    if (bucket.vibValues.length < 2500) {
      bucket.vibValues.push(evt.vibration_mm_s);
    }
    bucket.cycleSum += evt.cycle_ms;
    bucket.cycleSqSum += evt.cycle_ms * evt.cycle_ms;
    for (const [mKey, mVal] of Object.entries(evt.metrics)) {
      if (
        mKey !== 'temp_c' &&
        mKey !== evt.primary_metric_name &&
        mKey !== evt.secondary_metric_name &&
        Number.isFinite(mVal)
      ) {
        bucket.customSums[mKey] = (bucket.customSums[mKey] ?? 0) + mVal;
        bucket.customCounts[mKey] = (bucket.customCounts[mKey] ?? 0) + 1;
      }
    }
    if (bucket.timeline.length < 2500) {
      bucket.timeline.push({ tsMs, state: evt.state });
    }
  }

  /** Computes the ML feature row of a single aggregation window. */
  private materializeBucket(run: InternalRun, bucket: WindowBucket): MlFeatureRow {
    const expectedSamples = Math.max(
      1,
      Math.floor((run.config.windowMinutes * 60) / Math.max(0.25, run.expectedSampleSec))
    );
    const vibCutoff = run.config.vibrationP95Threshold ?? 3.5;
    const n = bucket.sampleCount;
    const spec = resolveMachineSpec(bucket.machineType);

    const primaryMean = Number((bucket.primarySum / n).toFixed(3));
    const sortedPrimary = [...bucket.primaryValues].sort((a, b) => a - b);
    const p95PIdx = Math.min(sortedPrimary.length - 1, Math.floor(0.95 * (sortedPrimary.length - 1)));
    const primaryP95 = Number((sortedPrimary[p95PIdx] ?? 0).toFixed(3));
    const primaryMax = Number(bucket.primaryMax.toFixed(3));
    const secondaryMean = Number((bucket.secondarySum / n).toFixed(3));

    const tempMean = Number((bucket.tempSum / n).toFixed(3));
    const tempMax = Number(bucket.tempMax.toFixed(3));
    const vibMean = Number((bucket.vibSum / n).toFixed(3));
    const sortedVibs = [...bucket.vibValues].sort((a, b) => a - b);
    const p95Idx = Math.min(sortedVibs.length - 1, Math.floor(0.95 * (sortedVibs.length - 1)));
    const vibP95 = Number((sortedVibs[p95Idx] ?? 0).toFixed(3));
    const vibMax = Number(bucket.vibMax.toFixed(3));

    const cycleMean = Number((bucket.cycleSum / n).toFixed(2));
    const cycleVar = n > 1 ? Math.max(0, bucket.cycleSqSum / n - cycleMean * cycleMean) : 0;
    const cycleStd = Number(Math.sqrt(cycleVar).toFixed(2));

    const ordered = [...bucket.timeline].sort((a, b) => a.tsMs - b.tsMs);
    let transitions = 0;
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i].state !== ordered[i - 1].state) transitions += 1;
    }

    let timeInFaultSec = 0;
    for (let i = 0; i < ordered.length; i++) {
      if (ordered[i].state !== 'FAULT') continue;
      if (i + 1 < ordered.length) {
        const delta = (ordered[i + 1].tsMs - ordered[i].tsMs) / 1000;
        timeInFaultSec += Math.max(0, Math.min(delta, run.expectedSampleSec * 3));
      } else {
        timeInFaultSec += run.expectedSampleSec;
      }
    }
    timeInFaultSec = Number(timeInFaultSec.toFixed(2));

    const missingHb = Math.max(0, expectedSamples - n);
    const validRatio = Number(Math.min(1.0, n / expectedSamples).toFixed(4));
    const tempLimit =
      spec.domain === 'manufacturing' && run.config.tempAnomalyThresholdC
        ? run.config.tempAnomalyThresholdC
        : spec.tempFaultThresholdC;
    const isAnomalous =
      bucket.faultCount > 0 ||
      bucket.degradedCount >= 2 ||
      tempMax > tempLimit ||
      primaryMax > spec.primaryFaultThreshold ||
      (spec.domain === 'manufacturing' && vibP95 > vibCutoff)
        ? 1
        : 0;

    const customMetricsAvg: Record<string, number> = {};
    for (const [k, sumVal] of Object.entries(bucket.customSums)) {
      const cnt = bucket.customCounts[k] ?? 1;
      customMetricsAvg[k] = Number((sumVal / Math.max(1, cnt)).toFixed(3));
    }

    return {
      site_id: resolveSiteId(),
      machine_id: bucket.machineId,
      window_start: bucket.windowStart,
      window_minutes: run.config.windowMinutes,
      dt: bucket.dt,
      line_id: bucket.lineId,
      machine_type: bucket.machineType,
      domain: bucket.domain,
      sample_count: n,
      valid_sample_ratio: validRatio,
      primary_metric_name: bucket.primaryMetricName,
      primary_metric_unit: bucket.primaryMetricUnit,
      primary_metric_mean: primaryMean,
      primary_metric_p95: primaryP95,
      primary_metric_max: primaryMax,
      secondary_metric_name: bucket.secondaryMetricName,
      secondary_metric_unit: bucket.secondaryMetricUnit,
      secondary_metric_mean: secondaryMean,
      temp_mean: tempMean,
      temp_max: tempMax,
      vibration_mean: vibMean,
      vibration_p95: vibP95,
      vibration_max: vibMax,
      cycle_ms_mean: cycleMean,
      cycle_ms_std: cycleStd,
      error_count: bucket.errorCount,
      fault_count: bucket.faultCount,
      degraded_count: bucket.degradedCount,
      state_transitions_count: transitions,
      time_in_fault_sec: timeInFaultSec,
      missing_heartbeat_count: missingHb,
      is_anomalous_window: isAnomalous,
      will_fail_next_window: null,
      dataset_version: run.config.datasetVersion || 'v1.0.0',
      ...(Object.keys(customMetricsAvg).length > 0 ? { custom_metrics_avg: customMetricsAvg } : {}),
    };
  }

  /**
   * Evicts the oldest aggregation windows (by window start) down to the eviction target,
   * folding them into cumulative counters so snapshot totals stay exact.
   */
  private evictOldestWindowBuckets(run: InternalRun): void {
    const overflow = run.windowBuckets.size - WINDOW_BUCKET_EVICTION_TARGET;
    if (overflow <= 0) return;
    const oldestFirst = [...run.windowBuckets.entries()].sort((a, b) =>
      a[1].windowStart.localeCompare(b[1].windowStart)
    );
    for (const [key, bucket] of oldestFirst.slice(0, overflow)) {
      const row = this.materializeBucket(run, bucket);
      run.evictedFeatureRows += 1;
      run.evictedAnomalousWindows += row.is_anomalous_window;
      if (run.evictionWatermark === null || bucket.windowStart > run.evictionWatermark) {
        run.evictionWatermark = bucket.windowStart;
      }
      run.windowBuckets.delete(key);
    }
  }

  private materializeFeatures(run: InternalRun): MlFeatureRow[] {
    const horizon = run.config.horizonWindows ?? 1;
    const features: MlFeatureRow[] = [];

    for (const bucket of run.windowBuckets.values()) {
      features.push(this.materializeBucket(run, bucket));
    }

    features.sort((a, b) => {
      if (a.machine_id !== b.machine_id) return a.machine_id.localeCompare(b.machine_id);
      return a.window_start.localeCompare(b.window_start);
    });

    const byMachine = new Map<string, MlFeatureRow[]>();
    for (const row of features) {
      const list = byMachine.get(row.machine_id) ?? [];
      list.push(row);
      byMachine.set(row.machine_id, list);
    }
    for (const list of byMachine.values()) {
      for (let i = 0; i + horizon < list.length; i++) {
        list[i].will_fail_next_window = list[i + horizon].is_anomalous_window;
      }
    }

    features.sort((a, b) => b.window_start.localeCompare(a.window_start) || a.machine_id.localeCompare(b.machine_id));
    return features;
  }

  buildSnapshot(run: InternalRun): LiveRunSnapshot {
    const allFeatures = this.materializeFeatures(run);
    const wallSec = Number((run.elapsedWallMs / 1000).toFixed(1));
    const progressPct =
      run.targetTotalCalls > 0
        ? Number(Math.min(100, (run.totalCallsEmitted / run.targetTotalCalls) * 100).toFixed(1))
        : 100;
    const effectiveRate = wallSec > 0.2 ? Number((run.totalCallsEmitted / wallSec).toFixed(1)) : run.config.eventsPerSec;

    const codecFactor =
      run.config.parquetCompression === 'snappy'
        ? 195
        : run.config.parquetCompression === 'gzip'
        ? 165
        : 135;
    const estimatedColdParquetMb = Number(
      Math.max(0.01, (run.validEventsCount * codecFactor) / (1024 * 1024)).toFixed(2)
    );
    const compactedFileCountEst = Math.max(1, Math.ceil(estimatedColdParquetMb / 256));

    return {
      runId: run.runId,
      status: run.status,
      config: run.config,
      startedAt: new Date(run.startedAtMs).toISOString(),
      updatedAt: new Date().toISOString(),
      elapsedWallSec: wallSec,
      elapsedSimSec: Number(run.elapsedSimSec.toFixed(1)),
      targetSimSec: run.targetSimSec,
      progressPct,
      totalCallsEmitted: run.totalCallsEmitted,
      targetTotalCalls: run.targetTotalCalls,
      effectiveRatePerSec: effectiveRate,
      validEventsCount: run.validEventsCount,
      quarantinedCount: run.quarantinedCount,
      outOfOrderCount: run.outOfOrderCount,
      lateEventsDropped: run.lateEventsDropped,
      rotatedSegmentsCount: run.segSeq,
      highWatermarkIso: run.highWatermarkIso,
      expectedSampleSec: run.expectedSampleSec,
      anomalousWindowsCount:
        run.evictedAnomalousWindows + allFeatures.filter((f) => f.is_anomalous_window === 1).length,
      featureRowsCount: run.evictedFeatureRows + allFeatures.length,
      tieringSummary: {
        hotStoreLabel: 'PostgreSQL 16 (Partitioned dt)',
        hotRetentionDays: run.config.hotRetentionDays ?? 90,
        coldStoreLabel:
          run.config.coldStorageEndpoint === 's3-glacier-compatible'
            ? 'S3 Cold / WORM Archive'
            : run.config.coldStorageEndpoint === 'nas-cold-archive'
            ? 'NAS / NFS Cold Archive'
            : 'Garage S3 Cold Lakehouse',
        coldRetentionDays: run.config.coldRetentionDays ?? 1095,
        lakehouseFormat: run.config.lakehouseFormat ?? 'duckdb-parquet-compacted',
        compactionSchedule: run.config.compactionSchedule ?? 'daily-01utc',
        ingestTransport: run.config.ingestTransport ?? 'local-segments',
        estimatedColdParquetMb,
        compactedFileCountEst,
      },
      recentLogs: run.recentLogs,
      segments: run.segments,
      quarantineRecords: run.quarantineRecords,
      features: allFeatures.slice(0, MAX_FEATURE_DISPLAY),
      partitionPaths: Array.from(run.partitionSet).sort().slice(-120),
    };
  }

  getLatestSnapshot(): LiveRunSnapshot | null {
    if (!this.latestRunId) return this.restoredSnapshot;
    const run = this.runs.get(this.latestRunId);
    return run ? this.buildSnapshot(run) : this.restoredSnapshot;
  }

  getRun(runId: string): InternalRun | undefined {
    return this.runs.get(runId);
  }

  pauseRun(runId: string): LiveRunSnapshot | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    if (run.status === 'running') {
      run.status = 'paused';
      if (run.timer) {
        clearInterval(run.timer);
        run.timer = null;
      }
      const snap = this.buildSnapshot(run);
      run.emitter.emit('update', snap);
      void this.persistSnapshot(snap);
      return snap;
    }
    return this.buildSnapshot(run);
  }

  resumeRun(runId: string): LiveRunSnapshot | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    if (run.status === 'paused') {
      run.status = 'running';
      run.lastTickMs = Date.now();
      run.timer = setInterval(() => this.onTick(run), TICK_MS);
      run.emitter.emit('update', this.buildSnapshot(run));
    }
    return this.buildSnapshot(run);
  }

  stopRun(runId: string): LiveRunSnapshot | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    if (run.status === 'running' || run.status === 'paused') {
      run.status = 'stopped';
      if (run.timer) {
        clearInterval(run.timer);
        run.timer = null;
      }
      const snap = this.buildSnapshot(run);
      run.emitter.emit('update', snap);
      void this.persistSnapshot(snap);
      return snap;
    }
    return this.buildSnapshot(run);
  }

  stopAllRuns(): void {
    for (const run of this.runs.values()) {
      if (run.timer) {
        clearInterval(run.timer);
        run.timer = null;
      }
      if (run.status === 'running') {
        run.status = 'stopped';
      }
    }
  }

  subscribe(runId: string, listener: (snapshot: LiveRunSnapshot) => void): () => void {
    const run = this.runs.get(runId);
    if (!run) return () => {};
    run.emitter.on('update', listener);
    return () => {
      run.emitter.off('update', listener);
    };
  }
}
