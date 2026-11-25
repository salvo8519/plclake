import crypto from 'node:crypto';
import {
  resolveMachineSpec,
  selectTypesForProfileMode,
  type MachineChannelSpec,
} from './machineCatalog.ts';
import type {
  LogLevel,
  MachineDomain,
  MachineProfileMode,
  MachineState,
  RawMachineEvent,
} from './types/pipeline.ts';

export interface MachineProfile {
  machineId: string;
  lineId: string;
  machineType: string;
  domain: MachineDomain;
  spec: MachineChannelSpec;
  driftRatio: number;
  inMaintenanceTicks: number;
}

export const VALID_STATES = new Set<MachineState>([
  'IDLE',
  'RUNNING',
  'DEGRADED',
  'FAULT',
  'MAINTENANCE',
]);

export class SeededRng {
  private state: number;

  constructor(seed: number) {
    this.state = (seed >>> 0) || 42;
  }

  next(): number {
    this.state += 0x6d2b79f5;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  uniform(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  randint(min: number, maxInclusive: number): number {
    return Math.floor(this.uniform(min, maxInclusive + 1));
  }

  gauss(mean = 0, std = 1): number {
    const u1 = Math.max(1e-7, this.next());
    const u2 = this.next();
    const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    return mean + z0 * std;
  }

  choice<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }
}

export function payloadHash(reason: string, rawLine: string): string {
  return crypto
    .createHash('sha256')
    .update(`${reason}:${rawLine}`)
    .digest('hex')
    .slice(0, 16);
}

export function createMachineProfiles(
  machineCount: number,
  machinesPerLine = 2,
  profileMode: MachineProfileMode = 'mixed',
  customTopology?: string,
  selectedPlcTypes?: string[]
): MachineProfile[] {
  if (customTopology && customTopology.trim().length > 0) {
    const tokens = customTopology
      .split(/[\n,]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    const parsed: MachineProfile[] = [];
    for (let idx = 0; idx < tokens.length && parsed.length < 32; idx++) {
      const parts = tokens[idx].split(':').map((p) => p.trim());
      if (!parts[0]) continue;
      const machineId = parts[0];
      const lineId =
        parts[1] || `line-${String(Math.floor(idx / Math.max(1, machinesPerLine)) + 1).padStart(2, '0')}`;
      const machineType = parts[2] || selectTypesForProfileMode(profileMode, selectedPlcTypes)[0];
      const spec = resolveMachineSpec(machineType);
      parsed.push({
        machineId,
        lineId,
        machineType,
        domain: spec.domain,
        spec,
        driftRatio: 0,
        inMaintenanceTicks: 0,
      });
    }
    if (parsed.length > 0) {
      return parsed;
    }
  }

  const count = Math.min(32, Math.max(2, Math.round(machineCount)));
  const perLine = Math.min(16, Math.max(1, Math.round(machinesPerLine)));
  const typeChoices = selectTypesForProfileMode(profileMode, selectedPlcTypes);
  const profiles: MachineProfile[] = [];

  for (let i = 0; i < count; i++) {
    const num = String(i + 1).padStart(2, '0');
    const lineNum = String(Math.floor(i / perLine) + 1).padStart(2, '0');
    const machineType = typeChoices[i % typeChoices.length];
    const spec = resolveMachineSpec(machineType);
    profiles.push({
      machineId: `M-${num}`,
      lineId: `line-${lineNum}`,
      machineType,
      domain: spec.domain,
      spec,
      driftRatio: 0,
      inMaintenanceTicks: 0,
    });
  }
  return profiles;
}

export function generateMalformedRecord(
  machineId: string,
  rng: SeededRng,
  timestampIso: string
): { reason: string; payload: string } {
  const kind = rng.choice(['invalid_type', 'missing_timestamp', 'corrupt_json', 'out_of_range'] as const);
  const badId = `evt-bad-${Math.floor(rng.next() * 0xffffffff).toString(16).padStart(8, '0')}`;

  if (kind === 'invalid_type') {
    return {
      reason: 'invalid_numeric_type',
      payload: JSON.stringify({
        event_id: badId,
        timestamp: timestampIso,
        machine_id: machineId,
        metrics: { temp_c: 'NOT_A_NUMBER' },
        state: 'RUNNING',
      }),
    };
  }
  if (kind === 'missing_timestamp') {
    return {
      reason: 'missing_required_field',
      payload: JSON.stringify({
        event_id: badId,
        machine_id: machineId,
        metrics: { temp_c: 58.1 },
      }),
    };
  }
  if (kind === 'out_of_range') {
    return {
      reason: 'out_of_range_value',
      payload: JSON.stringify({
        event_id: badId,
        timestamp: timestampIso,
        machine_id: machineId,
        metrics: { temp_c: 9999.0, vibration_mm_s: -4.0, cycle_ms: 900 },
        state: 'FAULT',
      }),
    };
  }
  return {
    reason: 'json_decode_error',
    payload: `{"machine_id": "${machineId}", "metrics": `,
  };
}

export function generateValidEvent(
  profile: MachineProfile,
  rng: SeededRng,
  nominalMs: number,
  seqIndex: number,
  seed: number,
  options?: { faultProbabilityPct?: number; outOfOrderRatePct?: number; minTimestampMs?: number }
): { event: RawMachineEvent; isOutOfOrder: boolean } {
  const faultProb = Math.min(0.3, Math.max(0, (options?.faultProbabilityPct ?? 5) / 100));
  const oooProb = Math.min(0.3, Math.max(0, (options?.outOfOrderRatePct ?? 8) / 100));

  let state: MachineState;
  if (profile.inMaintenanceTicks > 0) {
    state = 'MAINTENANCE';
    profile.inMaintenanceTicks -= 1;
    profile.driftRatio = Math.max(0, profile.driftRatio - 0.32);
  } else {
    if (rng.next() < 0.22) {
      profile.driftRatio = Math.min(1.25, profile.driftRatio + rng.uniform(0.05, 0.16));
    }

    if (profile.driftRatio >= 0.92 || rng.next() < faultProb) {
      state = 'FAULT';
      profile.inMaintenanceTicks = 2;
    } else if (profile.driftRatio >= 0.48 || rng.next() < Math.min(0.35, faultProb * 2.2)) {
      state = 'DEGRADED';
    } else {
      state = rng.next() < 0.15 ? 'IDLE' : 'RUNNING';
    }
  }

  let eventMs = nominalMs;
  let isOutOfOrder = false;
  const minTs = options?.minTimestampMs;
  const maxAllowedLagMs = minTs !== undefined ? Math.max(0, nominalMs - minTs) : 45000;
  if (rng.next() < oooProb && maxAllowedLagMs >= 5000) {
    const lagSec = Math.min(Math.floor(maxAllowedLagMs / 1000), rng.randint(5, 45));
    eventMs = nominalMs - lagSec * 1000;
    isOutOfOrder = true;
  }

  const spec = profile.spec;
  const idleFactor = state === 'IDLE' ? 0.55 : state === 'MAINTENANCE' ? 0.25 : 1.0;
  const faultBump = state === 'FAULT' ? 0.38 : state === 'DEGRADED' ? 0.18 : 0.0;
  const spikeRatio = rng.next() < 0.04 ? rng.uniform(0.25, 0.48) : 0.0;
  const excursionRatio = Math.min(1.5, profile.driftRatio + faultBump + spikeRatio);

  const tempSpan = Math.max(8, spec.tempFaultThresholdC - spec.tempNominalC);
  const tempRaw =
    spec.tempNominalC * (state === 'IDLE' ? 0.92 : 1.0) +
    tempSpan * excursionRatio * 0.95 +
    rng.gauss(0, spec.tempStdC);
  const temp_c = Number(Math.max(-20, tempRaw).toFixed(2));

  const primarySpan = Math.max(1, spec.primaryFaultThreshold - spec.primaryNominal);
  let primaryVal: number;
  if (spec.primaryKey === 'flow_nm3_h' && state === 'FAULT' && rng.next() < 0.45) {
    primaryVal = Math.max(0, (spec.primaryFaultLowThreshold ?? 80) * rng.uniform(0.3, 0.85));
  } else {
    primaryVal =
      spec.primaryNominal * idleFactor +
      primarySpan * excursionRatio * 0.9 +
      rng.gauss(0, spec.primaryStd);
    primaryVal = Math.max(0, primaryVal);
  }
  const primary_metric_value = Number(
    primaryVal.toFixed(spec.primaryUnit === 'ms' ? 0 : spec.primaryUnit === 'mm/s' ? 3 : 2)
  );

  const secondarySpan = spec.secondaryFaultThreshold
    ? Math.max(0.2, spec.secondaryFaultThreshold - spec.secondaryNominal)
    : spec.secondaryNominal * 0.25;
  let secondaryVal =
    spec.secondaryNominal *
      (spec.secondaryKey === 'frequency_hz' || spec.secondaryKey === 'voltage_v' ? 1.0 : idleFactor) +
    secondarySpan * excursionRatio * 0.75 +
    rng.gauss(0, spec.secondaryStd);
  if (spec.secondaryKey === 'frequency_hz' && state === 'FAULT') {
    secondaryVal = spec.secondaryNominal + (rng.next() < 0.5 ? -0.75 : 0.75) + rng.gauss(0, 0.08);
  }
  const secondary_metric_value = Number(
    Math.max(0.01, secondaryVal).toFixed(spec.secondaryUnit === 'ms' ? 0 : spec.secondaryUnit === 'mm/s' ? 3 : 2)
  );

  const metrics: Record<string, number> = {
    temp_c,
    [spec.primaryKey]: primary_metric_value,
    [spec.secondaryKey]: secondary_metric_value,
  };
  for (const extra of spec.extraChannels ?? []) {
    const val = extra.nominal * idleFactor + rng.gauss(0, extra.std);
    metrics[extra.key] = Number(Math.max(0, val).toFixed(3));
  }

  const vibration_mm_s =
    typeof metrics.vibration_mm_s === 'number'
      ? metrics.vibration_mm_s
      : Number(Math.max(0.05, 0.4 + excursionRatio * 2.1).toFixed(3));
  const cycle_ms =
    typeof metrics.cycle_ms === 'number'
      ? Math.max(100, Math.round(metrics.cycle_ms))
      : Math.max(200, Math.round(1000 * (1 + excursionRatio * 0.25)));

  const level: LogLevel = state === 'FAULT' ? 'ERROR' : state === 'DEGRADED' ? 'WARN' : 'INFO';
  const error_code =
    state === 'FAULT'
      ? spec.domain === 'gas-metering'
        ? `GAS-ERR-${rng.randint(100, 149)}`
        : spec.domain === 'power-generation'
        ? `PWR-ERR-${rng.randint(200, 249)}`
        : `ERR-${rng.randint(100, 199)}`
      : null;

  const evtId = `evt-${payloadHash('id', `${seqIndex}:${profile.machineId}:${seed}`).slice(0, 12)}`;

  return {
    isOutOfOrder,
    event: {
      event_id: evtId,
      timestamp: new Date(eventMs).toISOString(),
      machine_id: profile.machineId,
      line_id: profile.lineId,
      machine_type: profile.machineType,
      domain: profile.domain,
      state,
      error_code,
      temp_c,
      vibration_mm_s,
      cycle_ms,
      primary_metric_name: spec.primaryKey,
      primary_metric_value,
      primary_metric_unit: spec.primaryUnit,
      secondary_metric_name: spec.secondaryKey,
      secondary_metric_value,
      secondary_metric_unit: spec.secondaryUnit,
      metrics,
      payload_valid: true,
      level,
    },
  };
}

export function floorToWindowIso(tsMs: number, windowMinutes: number): string {
  const windowMs = windowMinutes * 60 * 1000;
  const floored = Math.floor(tsMs / windowMs) * windowMs;
  return new Date(floored).toISOString();
}
