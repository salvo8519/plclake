import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJson } from './utils/persistence.ts';
import type { DatabaseStore } from './db.ts';
import type {
  ConnectionProtocol,
  MachineDomain,
  MachineProfileMode,
  PlcBaFormula,
  PlcCatalogListResponse,
  PlcCatalogProfile,
  PlcExtraChannelSpec,
} from './types/pipeline.ts';

export type MachineChannelSpec = PlcCatalogProfile;

export const AVAILABLE_OUTPUT_FIELDS = [
  'machine_id',
  'line_id',
  'machine_type',
  'domain',
  'window_start',
  'sample_count',
  'valid_sample_ratio',
  'temp_mean',
  'temp_max',
  'primary_metric_mean',
  'primary_metric_p95',
  'primary_metric_max',
  'secondary_metric_mean',
  'vibration_p95',
  'cycle_ms_mean',
  'fault_count',
  'time_in_fault_sec',
  'is_anomalous_window',
  'will_fail_next_window',
  'custom_metrics_avg',
] as const;

const BUILTIN_TIMESTAMP = '2026-11-01T00:00:00.000Z';

export const BUILTIN_MACHINE_CATALOG: Record<string, PlcCatalogProfile> = {
  'plc-controller': {
    typeId: 'plc-controller',
    label: 'PLC Line Controller (Generic)',
    vendorFamily: 'IEC 61131-3 Generic PLC',
    domain: 'manufacturing',
    defaultProtocol: 'opcua',
    defaultPort: 4840,
    isBuiltIn: true,
    primaryKey: 'cycle_ms',
    primaryUnit: 'ms',
    primaryNominal: 920,
    primaryStd: 22,
    primaryFaultThreshold: 1450,
    secondaryKey: 'vibration_mm_s',
    secondaryUnit: 'mm/s',
    secondaryNominal: 1.15,
    secondaryStd: 0.14,
    secondaryFaultThreshold: 4.5,
    tempNominalC: 54.0,
    tempStdC: 1.6,
    tempFaultThresholdC: 82.0,
    extraChannels: [{ key: 'parts_per_min', unit: 'pcs/min', nominal: 48, std: 1.8 }],
    defaultOutputFields: [
      'machine_id',
      'line_id',
      'window_start',
      'sample_count',
      'temp_mean',
      'primary_metric_mean',
      'primary_metric_p95',
      'vibration_p95',
      'is_anomalous_window',
      'will_fail_next_window',
    ],
    baFormula: 'oee_cycle_count',
    updatedAt: BUILTIN_TIMESTAMP,
  },
  'siemens-s7-1500': {
    typeId: 'siemens-s7-1500',
    label: 'Siemens SIMATIC S7-1500',
    vendorFamily: 'Siemens TIA / PROFINET OPC-UA',
    domain: 'manufacturing',
    defaultProtocol: 'opcua',
    defaultPort: 4840,
    isBuiltIn: true,
    primaryKey: 'cycle_ms',
    primaryUnit: 'ms',
    primaryNominal: 780,
    primaryStd: 18,
    primaryFaultThreshold: 1280,
    secondaryKey: 'vibration_mm_s',
    secondaryUnit: 'mm/s',
    secondaryNominal: 0.95,
    secondaryStd: 0.12,
    secondaryFaultThreshold: 4.0,
    tempNominalC: 51.0,
    tempStdC: 1.4,
    tempFaultThresholdC: 80.0,
    extraChannels: [
      { key: 'cpu_scan_ms', unit: 'ms', nominal: 8.4, std: 0.6 },
      { key: 'servo_torque_pct', unit: '%', nominal: 62.0, std: 3.1 },
    ],
    defaultOutputFields: [
      'machine_id',
      'line_id',
      'machine_type',
      'window_start',
      'sample_count',
      'temp_mean',
      'primary_metric_mean',
      'primary_metric_p95',
      'custom_metrics_avg',
      'is_anomalous_window',
      'will_fail_next_window',
    ],
    baFormula: 'oee_cycle_count',
    updatedAt: BUILTIN_TIMESTAMP,
  },
  'rockwell-controllogix': {
    typeId: 'rockwell-controllogix',
    label: 'Rockwell ControlLogix 5580',
    vendorFamily: 'Allen-Bradley EtherNet/IP + OPC-UA',
    domain: 'manufacturing',
    defaultProtocol: 'opcua',
    defaultPort: 4840,
    isBuiltIn: true,
    primaryKey: 'cycle_ms',
    primaryUnit: 'ms',
    primaryNominal: 840,
    primaryStd: 20,
    primaryFaultThreshold: 1350,
    secondaryKey: 'vibration_mm_s',
    secondaryUnit: 'mm/s',
    secondaryNominal: 1.08,
    secondaryStd: 0.15,
    secondaryFaultThreshold: 4.2,
    tempNominalC: 52.5,
    tempStdC: 1.5,
    tempFaultThresholdC: 82.0,
    extraChannels: [{ key: 'motor_current_a', unit: 'A', nominal: 18.5, std: 0.9 }],
    defaultOutputFields: [
      'machine_id',
      'window_start',
      'temp_mean',
      'primary_metric_mean',
      'primary_metric_p95',
      'fault_count',
      'custom_metrics_avg',
      'is_anomalous_window',
    ],
    baFormula: 'oee_cycle_count',
    updatedAt: BUILTIN_TIMESTAMP,
  },
  'cnc-mill': {
    typeId: 'cnc-mill',
    label: 'CNC Precision Mill',
    vendorFamily: 'Fanuc / Haas High-Speed Spindle',
    domain: 'manufacturing',
    defaultProtocol: 'opcua',
    defaultPort: 4840,
    isBuiltIn: true,
    primaryKey: 'vibration_mm_s',
    primaryUnit: 'mm/s',
    primaryNominal: 1.65,
    primaryStd: 0.22,
    primaryFaultThreshold: 4.5,
    secondaryKey: 'cycle_ms',
    secondaryUnit: 'ms',
    secondaryNominal: 1120,
    secondaryStd: 35,
    secondaryFaultThreshold: 1650,
    tempNominalC: 61.5,
    tempStdC: 2.0,
    tempFaultThresholdC: 85.0,
    extraChannels: [{ key: 'spindle_rpm', unit: 'rpm', nominal: 11800, std: 210 }],
    defaultOutputFields: [
      'machine_id',
      'window_start',
      'sample_count',
      'temp_mean',
      'temp_max',
      'primary_metric_mean',
      'primary_metric_p95',
      'custom_metrics_avg',
      'is_anomalous_window',
      'will_fail_next_window',
    ],
    baFormula: 'oee_cycle_count',
    updatedAt: BUILTIN_TIMESTAMP,
  },
  'gas-flow-meter': {
    typeId: 'gas-flow-meter',
    label: 'Methane Flow Meter',
    vendorFamily: 'Endress+Hauser / Emerson Modbus',
    domain: 'gas-metering',
    defaultProtocol: 'modbus-tcp',
    defaultPort: 502,
    isBuiltIn: true,
    primaryKey: 'flow_nm3_h',
    primaryUnit: 'Nm3/h',
    primaryNominal: 425.0,
    primaryStd: 14.0,
    primaryFaultThreshold: 640.0,
    primaryFaultLowThreshold: 90.0,
    secondaryKey: 'pressure_bar',
    secondaryUnit: 'bar',
    secondaryNominal: 14.8,
    secondaryStd: 0.45,
    secondaryFaultThreshold: 22.5,
    tempNominalC: 22.5,
    tempStdC: 1.1,
    tempFaultThresholdC: 48.0,
    extraChannels: [{ key: 'calorific_mj_m3', unit: 'MJ/m3', nominal: 38.6, std: 0.35 }],
    defaultOutputFields: [
      'machine_id',
      'line_id',
      'domain',
      'window_start',
      'sample_count',
      'primary_metric_mean',
      'primary_metric_p95',
      'secondary_metric_mean',
      'temp_mean',
      'is_anomalous_window',
    ],
    baFormula: 'gas_nm3_integration',
    updatedAt: BUILTIN_TIMESTAMP,
  },
  'methane-compressor': {
    typeId: 'methane-compressor',
    label: 'Biomethane Compressor',
    vendorFamily: 'Atlas Copco / Siemens Compressor Skid',
    domain: 'gas-metering',
    defaultProtocol: 'modbus-tcp',
    defaultPort: 502,
    isBuiltIn: true,
    primaryKey: 'pressure_bar',
    primaryUnit: 'bar',
    primaryNominal: 28.4,
    primaryStd: 0.75,
    primaryFaultThreshold: 38.0,
    secondaryKey: 'flow_nm3_h',
    secondaryUnit: 'Nm3/h',
    secondaryNominal: 840.0,
    secondaryStd: 22.0,
    secondaryFaultThreshold: 1200.0,
    tempNominalC: 66.0,
    tempStdC: 2.3,
    tempFaultThresholdC: 92.0,
    extraChannels: [{ key: 'suction_bar', unit: 'bar', nominal: 4.2, std: 0.15 }],
    defaultOutputFields: [
      'machine_id',
      'window_start',
      'primary_metric_mean',
      'primary_metric_max',
      'secondary_metric_mean',
      'temp_mean',
      'temp_max',
      'time_in_fault_sec',
      'is_anomalous_window',
    ],
    baFormula: 'gas_nm3_integration',
    updatedAt: BUILTIN_TIMESTAMP,
  },
  'power-meter': {
    typeId: 'power-meter',
    label: 'Substation Power Meter',
    vendorFamily: 'Schneider PowerLogic / ABB M2M',
    domain: 'power-generation',
    defaultProtocol: 'mqtt-sparkplug',
    defaultPort: 8883,
    isBuiltIn: true,
    primaryKey: 'power_kw',
    primaryUnit: 'kW',
    primaryNominal: 340.0,
    primaryStd: 11.5,
    primaryFaultThreshold: 510.0,
    secondaryKey: 'frequency_hz',
    secondaryUnit: 'Hz',
    secondaryNominal: 50.0,
    secondaryStd: 0.04,
    secondaryFaultThreshold: 50.65,
    tempNominalC: 41.0,
    tempStdC: 1.4,
    tempFaultThresholdC: 72.0,
    extraChannels: [{ key: 'power_factor', unit: 'cosPhi', nominal: 0.96, std: 0.015 }],
    defaultOutputFields: [
      'machine_id',
      'domain',
      'window_start',
      'primary_metric_mean',
      'primary_metric_p95',
      'secondary_metric_mean',
      'custom_metrics_avg',
      'temp_mean',
      'is_anomalous_window',
    ],
    baFormula: 'energy_kwh_integration',
    updatedAt: BUILTIN_TIMESTAMP,
  },
  'turbine-generator': {
    typeId: 'turbine-generator',
    label: 'Gas Turbine Generator',
    vendorFamily: 'GE / Siemens Energy Cogeneration',
    domain: 'power-generation',
    defaultProtocol: 'opcua',
    defaultPort: 4840,
    isBuiltIn: true,
    primaryKey: 'power_kw',
    primaryUnit: 'kW',
    primaryNominal: 1260.0,
    primaryStd: 28.0,
    primaryFaultThreshold: 1620.0,
    secondaryKey: 'voltage_v',
    secondaryUnit: 'V',
    secondaryNominal: 400.0,
    secondaryStd: 2.2,
    secondaryFaultThreshold: 432.0,
    tempNominalC: 74.0,
    tempStdC: 2.4,
    tempFaultThresholdC: 96.0,
    extraChannels: [{ key: 'exhaust_temp_c', unit: 'C', nominal: 465.0, std: 8.5 }],
    defaultOutputFields: [
      'machine_id',
      'window_start',
      'primary_metric_mean',
      'primary_metric_p95',
      'secondary_metric_mean',
      'temp_max',
      'custom_metrics_avg',
      'is_anomalous_window',
      'will_fail_next_window',
    ],
    baFormula: 'energy_kwh_integration',
    updatedAt: BUILTIN_TIMESTAMP,
  },
};

const liveCatalogMap = new Map<string, PlcCatalogProfile>(
  Object.entries(BUILTIN_MACHINE_CATALOG).map(([k, v]) => [k, cloneProfile(v)])
);

function cloneProfile(p: PlcCatalogProfile): PlcCatalogProfile {
  return {
    ...p,
    extraChannels: p.extraChannels.map((c) => ({ ...c })),
    defaultOutputFields: [...p.defaultOutputFields],
  };
}

export function resolveMachineSpec(machineType: string): PlcCatalogProfile {
  const normalized = machineType.trim().toLowerCase();
  const direct = liveCatalogMap.get(normalized);
  if (direct) return direct;
  if (normalized.includes('s7') || normalized.includes('siemens')) {
    return liveCatalogMap.get('siemens-s7-1500') ?? BUILTIN_MACHINE_CATALOG['siemens-s7-1500'];
  }
  if (normalized.includes('rockwell') || normalized.includes('allen') || normalized.includes('clx')) {
    return liveCatalogMap.get('rockwell-controllogix') ?? BUILTIN_MACHINE_CATALOG['rockwell-controllogix'];
  }
  if (normalized.includes('gas') || normalized.includes('methane') || normalized.includes('flow')) {
    return liveCatalogMap.get('gas-flow-meter') ?? BUILTIN_MACHINE_CATALOG['gas-flow-meter'];
  }
  if (normalized.includes('comp')) {
    return liveCatalogMap.get('methane-compressor') ?? BUILTIN_MACHINE_CATALOG['methane-compressor'];
  }
  if (normalized.includes('turb') || normalized.includes('gen')) {
    return liveCatalogMap.get('turbine-generator') ?? BUILTIN_MACHINE_CATALOG['turbine-generator'];
  }
  if (normalized.includes('power') || normalized.includes('elec') || normalized.includes('kwh')) {
    return liveCatalogMap.get('power-meter') ?? BUILTIN_MACHINE_CATALOG['power-meter'];
  }
  if (normalized.includes('cnc') || normalized.includes('mill')) {
    return liveCatalogMap.get('cnc-mill') ?? BUILTIN_MACHINE_CATALOG['cnc-mill'];
  }
  return liveCatalogMap.get('plc-controller') ?? BUILTIN_MACHINE_CATALOG['plc-controller'];
}

export function selectTypesForProfileMode(
  mode: MachineProfileMode,
  explicitTypes?: string[]
): string[] {
  if (explicitTypes && explicitTypes.length > 0) {
    const cleaned = explicitTypes
      .map((t) => t.trim().toLowerCase())
      .filter((t) => liveCatalogMap.has(t));
    if (cleaned.length > 0) return cleaned;
  }

  if (liveCatalogMap.has(mode)) {
    return [mode];
  }

  const allProfiles = Array.from(liveCatalogMap.values());
  switch (mode) {
    case 'manufacturing': {
      const mfg = allProfiles.filter((p) => p.domain === 'manufacturing').map((p) => p.typeId);
      return mfg.length > 0 ? mfg : ['plc-controller', 'cnc-mill'];
    }
    case 'gas-metering': {
      const gas = allProfiles.filter((p) => p.domain === 'gas-metering').map((p) => p.typeId);
      return gas.length > 0 ? gas : ['gas-flow-meter', 'methane-compressor'];
    }
    case 'power-generation': {
      const pwr = allProfiles.filter((p) => p.domain === 'power-generation').map((p) => p.typeId);
      return pwr.length > 0 ? pwr : ['power-meter', 'turbine-generator'];
    }
    case 'mixed':
    default:
      return ['plc-controller', 'siemens-s7-1500', 'cnc-mill', 'gas-flow-meter', 'power-meter'].filter(
        (id) => liveCatalogMap.has(id)
      );
  }
}

export function getAllCatalogProfiles(): PlcCatalogProfile[] {
  return Array.from(liveCatalogMap.values()).map(cloneProfile);
}

export class PlcCatalogManager {
  private stateFile: string;
  private updatedAt: string = BUILTIN_TIMESTAMP;
  private dbStore: DatabaseStore | null;

  constructor(rootDir: string, dbStore?: DatabaseStore) {
    this.stateFile = path.resolve(rootDir, '.state', 'plc-catalog.json');
    this.dbStore = dbStore ?? null;
  }

  async init(): Promise<void> {
    liveCatalogMap.clear();
    for (const [key, profile] of Object.entries(BUILTIN_MACHINE_CATALOG)) {
      liveCatalogMap.set(key, cloneProfile(profile));
    }

    type PersistedCatalog = {
      profiles?: Partial<PlcCatalogProfile>[];
      updatedAt?: string;
    };
    let parsed: PersistedCatalog | null = null;
    try {
      if (this.dbStore?.isPostgresActive()) {
        parsed = await this.dbStore.getState<PersistedCatalog>('plc_catalog_custom');
      }
    } catch {
      // Fallback to local file
    }

    if (!parsed) {
      try {
        const raw = await fs.readFile(this.stateFile, 'utf-8');
        parsed = JSON.parse(raw) as PersistedCatalog;
      } catch {
        // No custom catalog persisted yet; built-in catalog active
      }
    }

    if (parsed) {
      if (Array.isArray(parsed.profiles)) {
        for (const p of parsed.profiles) {
          if (typeof p.typeId === 'string' && p.typeId.trim()) {
            const existing = liveCatalogMap.get(p.typeId.trim().toLowerCase());
            const sanitized = this.sanitizeProfile(p, existing);
            liveCatalogMap.set(sanitized.typeId, sanitized);
          }
        }
      }
      if (typeof parsed.updatedAt === 'string') {
        this.updatedAt = parsed.updatedAt;
      }
    }
  }

  private async persist(): Promise<void> {
    const customOrModified = Array.from(liveCatalogMap.values()).filter((p) => {
      const builtin = BUILTIN_MACHINE_CATALOG[p.typeId];
      return !builtin || JSON.stringify(builtin) !== JSON.stringify(p);
    });
    const payload = { profiles: customOrModified, updatedAt: this.updatedAt };
    try {
      if (this.dbStore?.isPostgresActive()) {
        await this.dbStore.saveState('plc_catalog_custom', payload);
      }
    } catch {
      // Fall through to local atomic file mirror
    }
    try {
      await atomicWriteJson(this.stateFile, payload, true);
    } catch {
      // Non-fatal in ephemeral containers
    }
  }

  private sanitizeProfile(
    raw: Partial<PlcCatalogProfile>,
    fallback?: PlcCatalogProfile
  ): PlcCatalogProfile {
    const typeId = (raw.typeId ?? fallback?.typeId ?? 'custom-plc')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .slice(0, 48);

    const domain: MachineDomain =
      raw.domain === 'manufacturing' ||
      raw.domain === 'gas-metering' ||
      raw.domain === 'power-generation'
        ? raw.domain
        : fallback?.domain ?? 'manufacturing';

    const defaultProtocol: ConnectionProtocol =
      raw.defaultProtocol === 'opcua' ||
      raw.defaultProtocol === 'modbus-tcp' ||
      raw.defaultProtocol === 'mqtt-sparkplug' ||
      raw.defaultProtocol === 'http-rest-meter'
        ? raw.defaultProtocol
        : fallback?.defaultProtocol ?? 'opcua';

    const baFormula: PlcBaFormula =
      raw.baFormula === 'oee_cycle_count' ||
      raw.baFormula === 'gas_nm3_integration' ||
      raw.baFormula === 'energy_kwh_integration' ||
      raw.baFormula === 'custom_throughput'
        ? raw.baFormula
        : fallback?.baFormula ??
          (domain === 'gas-metering'
            ? 'gas_nm3_integration'
            : domain === 'power-generation'
            ? 'energy_kwh_integration'
            : 'oee_cycle_count');

    const defaultPortCandidate = Number(raw.defaultPort ?? fallback?.defaultPort ?? 4840);
    const defaultPort =
      Number.isInteger(defaultPortCandidate) && defaultPortCandidate >= 1 && defaultPortCandidate <= 65535
        ? defaultPortCandidate
        : 4840;

    const primaryNominal = Number(raw.primaryNominal ?? fallback?.primaryNominal ?? 100);
    const secondaryNominal = Number(raw.secondaryNominal ?? fallback?.secondaryNominal ?? 1.5);
    const tempNominalC = Number(raw.tempNominalC ?? fallback?.tempNominalC ?? 52);

    const extraChannels: PlcExtraChannelSpec[] = Array.isArray(raw.extraChannels)
      ? raw.extraChannels
          .filter((c) => c && typeof c.key === 'string' && c.key.trim().length > 0)
          .slice(0, 8)
          .map((c) => ({
            key: c.key.trim().replace(/[^a-zA-Z0-9_]+/g, '_').slice(0, 40),
            unit: String(c.unit ?? '').trim().slice(0, 16) || 'u',
            nominal: Number.isFinite(Number(c.nominal)) ? Number(c.nominal) : 0,
            std: Number.isFinite(Number(c.std)) && Number(c.std) >= 0 ? Number(c.std) : 1,
          }))
      : fallback?.extraChannels.map((c) => ({ ...c })) ?? [];

    const allowedFields = new Set<string>(AVAILABLE_OUTPUT_FIELDS);
    const defaultOutputFields =
      Array.isArray(raw.defaultOutputFields) && raw.defaultOutputFields.length > 0
        ? raw.defaultOutputFields.filter((f) => allowedFields.has(f))
        : fallback?.defaultOutputFields ?? [
            'machine_id',
            'line_id',
            'window_start',
            'sample_count',
            'temp_mean',
            'primary_metric_mean',
            'primary_metric_p95',
            'is_anomalous_window',
          ];

    return {
      typeId,
      label:
        typeof raw.label === 'string' && raw.label.trim()
          ? raw.label.trim().slice(0, 80)
          : fallback?.label ?? typeId,
      vendorFamily:
        typeof raw.vendorFamily === 'string' && raw.vendorFamily.trim()
          ? raw.vendorFamily.trim().slice(0, 80)
          : fallback?.vendorFamily ?? 'Custom Industrial PLC',
      domain,
      defaultProtocol,
      defaultPort,
      isBuiltIn: Boolean(BUILTIN_MACHINE_CATALOG[typeId]),
      primaryKey:
        typeof raw.primaryKey === 'string' && raw.primaryKey.trim()
          ? raw.primaryKey.trim().replace(/[^a-zA-Z0-9_]+/g, '_').slice(0, 40)
          : fallback?.primaryKey ?? 'cycle_ms',
      primaryUnit:
        typeof raw.primaryUnit === 'string' && raw.primaryUnit.trim()
          ? raw.primaryUnit.trim().slice(0, 16)
          : fallback?.primaryUnit ?? 'ms',
      primaryNominal: Number.isFinite(primaryNominal) ? primaryNominal : 100,
      primaryStd:
        Number.isFinite(Number(raw.primaryStd)) && Number(raw.primaryStd) >= 0
          ? Number(raw.primaryStd)
          : fallback?.primaryStd ?? Math.max(0.5, Math.abs(primaryNominal) * 0.04),
      primaryFaultThreshold:
        Number.isFinite(Number(raw.primaryFaultThreshold))
          ? Number(raw.primaryFaultThreshold)
          : fallback?.primaryFaultThreshold ?? primaryNominal * 1.45,
      ...(raw.primaryFaultLowThreshold !== undefined || fallback?.primaryFaultLowThreshold !== undefined
        ? {
            primaryFaultLowThreshold: Number(
              raw.primaryFaultLowThreshold ?? fallback?.primaryFaultLowThreshold
            ),
          }
        : {}),
      secondaryKey:
        typeof raw.secondaryKey === 'string' && raw.secondaryKey.trim()
          ? raw.secondaryKey.trim().replace(/[^a-zA-Z0-9_]+/g, '_').slice(0, 40)
          : fallback?.secondaryKey ?? 'vibration_mm_s',
      secondaryUnit:
        typeof raw.secondaryUnit === 'string' && raw.secondaryUnit.trim()
          ? raw.secondaryUnit.trim().slice(0, 16)
          : fallback?.secondaryUnit ?? 'mm/s',
      secondaryNominal: Number.isFinite(secondaryNominal) ? secondaryNominal : 1.5,
      secondaryStd:
        Number.isFinite(Number(raw.secondaryStd)) && Number(raw.secondaryStd) >= 0
          ? Number(raw.secondaryStd)
          : fallback?.secondaryStd ?? Math.max(0.05, Math.abs(secondaryNominal) * 0.1),
      secondaryFaultThreshold:
        Number.isFinite(Number(raw.secondaryFaultThreshold))
          ? Number(raw.secondaryFaultThreshold)
          : fallback?.secondaryFaultThreshold ?? secondaryNominal * 1.8,
      tempNominalC: Number.isFinite(tempNominalC) ? tempNominalC : 52,
      tempStdC:
        Number.isFinite(Number(raw.tempStdC)) && Number(raw.tempStdC) >= 0
          ? Number(raw.tempStdC)
          : fallback?.tempStdC ?? 1.5,
      tempFaultThresholdC:
        Number.isFinite(Number(raw.tempFaultThresholdC))
          ? Number(raw.tempFaultThresholdC)
          : fallback?.tempFaultThresholdC ?? Math.max(45, tempNominalC + 28),
      extraChannels,
      defaultOutputFields:
        defaultOutputFields.length > 0 ? defaultOutputFields : ['machine_id', 'primary_metric_mean'],
      baFormula,
      updatedAt: new Date().toISOString(),
    };
  }

  listCatalog(filters?: { domain?: string; protocol?: string }): PlcCatalogListResponse {
    let profiles = Array.from(liveCatalogMap.values()).map(cloneProfile);
    if (filters?.domain) {
      profiles = profiles.filter((p) => p.domain === filters.domain);
    }
    if (filters?.protocol) {
      profiles = profiles.filter((p) => p.defaultProtocol === filters.protocol);
    }
    return {
      profiles,
      availableOutputFields: [...AVAILABLE_OUTPUT_FIELDS],
      updatedAt: this.updatedAt,
    };
  }

  getProfile(typeId: string): PlcCatalogProfile | null {
    const found = liveCatalogMap.get(typeId.trim().toLowerCase());
    return found ? cloneProfile(found) : null;
  }

  async upsertProfile(raw: Partial<PlcCatalogProfile>): Promise<{
    profile: PlcCatalogProfile;
    catalog: PlcCatalogListResponse;
    created: boolean;
  }> {
    const candidateId = (raw.typeId ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-');
    const existing = candidateId ? liveCatalogMap.get(candidateId) : undefined;
    const profile = this.sanitizeProfile(raw, existing);
    liveCatalogMap.set(profile.typeId, profile);
    this.updatedAt = profile.updatedAt;
    await this.persist();
    return {
      profile: cloneProfile(profile),
      catalog: this.listCatalog(),
      created: !existing,
    };
  }

  async deleteOrResetProfile(typeId: string): Promise<{
    deleted: boolean;
    resetToBuiltIn: boolean;
    catalog: PlcCatalogListResponse;
  }> {
    const key = typeId.trim().toLowerCase();
    if (!liveCatalogMap.has(key)) {
      return { deleted: false, resetToBuiltIn: false, catalog: this.listCatalog() };
    }
    const builtin = BUILTIN_MACHINE_CATALOG[key];
    if (builtin) {
      liveCatalogMap.set(key, cloneProfile(builtin));
      this.updatedAt = new Date().toISOString();
      await this.persist();
      return { deleted: false, resetToBuiltIn: true, catalog: this.listCatalog() };
    }
    liveCatalogMap.delete(key);
    this.updatedAt = new Date().toISOString();
    await this.persist();
    return { deleted: true, resetToBuiltIn: false, catalog: this.listCatalog() };
  }
}
