import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  AlertTriangle,
  Check,
  Code2,
  Columns3,
  Copy,
  Cpu,
  Database,
  Download,
  Eye,
  Pause,
  Play,
  RotateCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Square,
} from 'lucide-react';
import { LogStreamViewer } from './LogStreamViewer';
import {
  Button,
  HIGH_VOLUME_PAGE_SIZE,
  paginateItems,
  SectionCard,
  SlideOverDrawer,
  TablePagination,
} from './ui';
import { ERP_INPUT_COMPACT_CLASS, ERP_TABLE_HEAD_ROW_CLASS } from '../theme/tokens';
import { formatBytes, formatClock, formatUtcTimestamp } from '../utils/formatters';
import type {
  JobConfig,
  LiveLogFeedEntry,
  LiveRunConfig,
  LiveRunSnapshot,
  MlFeatureRow,
  PlcCatalogListResponse,
  QuarantineRecord,
} from '../types/pipeline';

interface WorkbenchSectionProps {
  liveRun: LiveRunSnapshot | null;
  jobConfig: JobConfig;
  plcCatalog: PlcCatalogListResponse | null;
  isSimulating: boolean;
  canControlSimulation: boolean;
  initialSelectedPlcType?: string | null;
  onStartLiveRun: (config: LiveRunConfig) => void;
  onControlLiveRun: (action: 'pause' | 'resume' | 'stop') => void;
  onOpenJobConfig: () => void;
  onOpenPlcCatalog: () => void;
}

type WorkbenchTab = 'live_logs' | 'features' | 'quarantine' | 'segments';
type LogLevelFilter = 'ALL' | 'INFO' | 'WARN' | 'ERROR' | 'QUARANTINE';
type StressScenario = 'nominal' | 'degraded' | 'stress';
type InspectedRecord =
  | { kind: 'log'; entry: LiveLogFeedEntry }
  | { kind: 'quarantine'; record: QuarantineRecord };

function parsePayloadForInspector(raw: string): {
  parsedObject: Record<string, unknown> | null;
  formattedText: string;
  isValidJson: boolean;
  byteLength: number;
  lineCount: number;
} {
  const byteLength = new TextEncoder().encode(raw).length;
  try {
    const parsed: unknown = JSON.parse(raw);
    const formattedText = JSON.stringify(parsed, null, 2);
    const parsedObject =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    return {
      parsedObject,
      formattedText,
      isValidJson: true,
      byteLength,
      lineCount: formattedText.split('\n').length,
    };
  } catch {
    return {
      parsedObject: null,
      formattedText: raw,
      isValidJson: false,
      byteLength,
      lineCount: raw.split('\n').length,
    };
  }
}

const SCENARIO_PRESETS: Record<
  StressScenario,
  { faultProbabilityPct: number; malformedRatePct: number; outOfOrderRatePct: number }
> = {
  nominal: { faultProbabilityPct: 5, malformedRatePct: 7, outOfOrderRatePct: 8 },
  degraded: { faultProbabilityPct: 12, malformedRatePct: 10, outOfOrderRatePct: 12 },
  stress: { faultProbabilityPct: 20, malformedRatePct: 15, outOfOrderRatePct: 18 },
};

const CORE_FEATURE_FIELDS = [
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
];

const FIELD_LABELS: Record<string, string> = {
  machine_id: 'Machine',
  line_id: 'Line',
  machine_type: 'PLC Type',
  domain: 'Domain',
  window_start: 'Window Start (UTC)',
  sample_count: 'Samples',
  valid_sample_ratio: 'Valid %',
  temp_mean: 'Temp Mean',
  temp_max: 'Temp Max',
  primary_metric_mean: 'Primary Mean',
  primary_metric_p95: 'Primary p95',
  primary_metric_max: 'Primary Max',
  secondary_metric_mean: 'Secondary Mean',
  vibration_p95: 'Vib p95',
  cycle_ms_mean: 'Cycle (ms)',
  fault_count: 'Faults',
  time_in_fault_sec: 'Fault (s)',
  is_anomalous_window: 'Anomalous (t)',
  will_fail_next_window: 'Lead (t+1)',
  custom_metrics_avg: 'Extra Channels',
};

const RIGHT_ALIGN_FIELDS = new Set([
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
]);

interface FeatureCellLabels {
  anomalousYes: string;
  anomalousNo: string;
  leadOpen: string;
  leadFail: string;
  leadNominal: string;
}

function formatFeatureCell(row: MlFeatureRow, field: string, labels: FeatureCellLabels): string {
  switch (field) {
    case 'machine_id':
      return row.machine_id;
    case 'line_id':
      return row.line_id;
    case 'machine_type':
      return row.machine_type;
    case 'domain':
      return row.domain;
    case 'window_start':
      return formatUtcTimestamp(row.window_start);
    case 'sample_count':
      return String(row.sample_count);
    case 'valid_sample_ratio':
      return `${(row.valid_sample_ratio * 100).toFixed(0)}%`;
    case 'temp_mean':
      return `${row.temp_mean.toFixed(1)} °C`;
    case 'temp_max':
      return `${row.temp_max.toFixed(1)} °C`;
    case 'primary_metric_mean':
      return `${row.primary_metric_mean.toFixed(2)} ${row.primary_metric_unit}`;
    case 'primary_metric_p95':
      return `${row.primary_metric_p95.toFixed(2)} ${row.primary_metric_unit}`;
    case 'primary_metric_max':
      return `${row.primary_metric_max.toFixed(2)} ${row.primary_metric_unit}`;
    case 'secondary_metric_mean':
      return `${row.secondary_metric_mean.toFixed(2)} ${row.secondary_metric_unit}`;
    case 'vibration_p95':
      return row.vibration_p95.toFixed(2);
    case 'cycle_ms_mean':
      return row.cycle_ms_mean.toFixed(0);
    case 'fault_count':
      return String(row.fault_count);
    case 'time_in_fault_sec':
      return row.time_in_fault_sec.toFixed(1);
    case 'is_anomalous_window':
      return row.is_anomalous_window === 1 ? labels.anomalousYes : labels.anomalousNo;
    case 'will_fail_next_window':
      return row.will_fail_next_window === null
        ? labels.leadOpen
        : row.will_fail_next_window === 1
        ? labels.leadFail
        : labels.leadNominal;
    case 'custom_metrics_avg': {
      const entries = Object.entries(row.custom_metrics_avg ?? {});
      if (entries.length === 0) return '--';
      return entries.map(([k, v]) => `${k}=${v}`).join(' · ');
    }
    default:
      return String((row as unknown as Record<string, unknown>)[field] ?? '--');
  }
}

export function WorkbenchSection({
  liveRun,
  jobConfig,
  plcCatalog,
  isSimulating,
  canControlSimulation,
  initialSelectedPlcType,
  onStartLiveRun,
  onControlLiveRun,
  onOpenJobConfig,
  onOpenPlcCatalog,
}: WorkbenchSectionProps) {
  const { t } = useTranslation(['operations', 'common']);
  const featureCellLabels: FeatureCellLabels = {
    anomalousYes: t('operations:workbench.featuresTable.anomalousYes'),
    anomalousNo: t('operations:workbench.featuresTable.anomalousNo'),
    leadOpen: t('operations:workbench.featuresTable.leadOpen'),
    leadFail: t('operations:workbench.featuresTable.leadFail'),
    leadNominal: t('operations:workbench.featuresTable.leadNominal'),
  };
  const [durationMinutes, setDurationMinutes] = useState<number>(15);
  const [eventsPerSec, setEventsPerSec] = useState<number>(10);
  const [speedMultiplier, setSpeedMultiplier] = useState<1 | 10 | 60 | 300>(10);
  const [machineCount, setMachineCount] = useState<number>(4);
  const [scenario, setScenario] = useState<StressScenario>('nominal');
  const [profileMode, setProfileMode] = useState<string>(
    initialSelectedPlcType || jobConfig.machineProfileMode
  );
  const [selectedPlcTypes, setSelectedPlcTypes] = useState<string[]>(
    initialSelectedPlcType ? [initialSelectedPlcType] : []
  );
  const [outputFields, setOutputFields] = useState<string[]>([
    'machine_id',
    'line_id',
    'machine_type',
    'window_start',
    'sample_count',
    'valid_sample_ratio',
    'temp_mean',
    'temp_max',
    'primary_metric_mean',
    'primary_metric_p95',
    'time_in_fault_sec',
    'is_anomalous_window',
    'will_fail_next_window',
    'custom_metrics_avg',
  ]);
  const [showSchemaDrawer, setShowSchemaDrawer] = useState(false);
  const [inspectedRecord, setInspectedRecord] = useState<InspectedRecord | null>(null);
  const [copiedPayload, setCopiedPayload] = useState(false);

  const [activeTab, setActiveTab] = useState<WorkbenchTab>('live_logs');
  const [logLevelFilter, setLogLevelFilter] = useState<LogLevelFilter>('ALL');
  const [logSearchQuery, setLogSearchQuery] = useState('');
  const [machineQuery, setMachineQuery] = useState('');
  const [anomalyFilter, setAnomalyFilter] = useState<'all' | 'anomalous' | 'nominal'>('all');
  const [logsPage, setLogsPage] = useState(1);
  const [featuresPage, setFeaturesPage] = useState(1);
  const [quarantinePage, setQuarantinePage] = useState(1);
  const [segmentsPage, setSegmentsPage] = useState(1);
  const [tablePageSize, setTablePageSize] = useState<number>(HIGH_VOLUME_PAGE_SIZE);
  const tableScrollRef = useRef<HTMLDivElement | null>(null);
  const lastRunIdRef = useRef<string | null>(null);

  useEffect(() => {
    const nextId = liveRun?.runId ?? null;
    if (nextId !== lastRunIdRef.current) {
      lastRunIdRef.current = nextId;
      setLogLevelFilter('ALL');
      setLogSearchQuery('');
      setMachineQuery('');
      setAnomalyFilter('all');
      setLogsPage(1);
      setFeaturesPage(1);
      setQuarantinePage(1);
      setSegmentsPage(1);
      setInspectedRecord(null);
      if (tableScrollRef.current) {
        tableScrollRef.current.scrollTop = 0;
        tableScrollRef.current.scrollLeft = 0;
      }
    }
  }, [liveRun?.runId]);

  useEffect(() => {
    setLogsPage(1);
  }, [logLevelFilter, logSearchQuery]);

  useEffect(() => {
    setFeaturesPage(1);
  }, [machineQuery, anomalyFilter]);

  useEffect(() => {
    if (initialSelectedPlcType) {
      setProfileMode(initialSelectedPlcType);
      setSelectedPlcTypes([initialSelectedPlcType]);
    }
  }, [initialSelectedPlcType]);

  useEffect(() => {
    if (!initialSelectedPlcType) {
      setProfileMode(jobConfig.machineProfileMode);
    }
  }, [jobConfig.machineProfileMode, initialSelectedPlcType]);

  const availableFields = useMemo(
    () => plcCatalog?.availableOutputFields ?? CORE_FEATURE_FIELDS,
    [plcCatalog]
  );

  const catalogProfiles = useMemo(() => plcCatalog?.profiles ?? [], [plcCatalog]);

  const activeFeatures = useMemo(() => liveRun?.features ?? [], [liveRun]);
  const activeQuarantine = useMemo(() => liveRun?.quarantineRecords ?? [], [liveRun]);
  const activeSegments = useMemo(() => liveRun?.segments ?? [], [liveRun]);
  const activePartitions = useMemo(() => liveRun?.partitionPaths ?? [], [liveRun]);

  const filteredLogs = useMemo(() => {
    const entries = liveRun?.recentLogs ?? [];
    return entries.filter((entry) => {
      if (logLevelFilter !== 'ALL' && entry.level !== logLevelFilter) return false;
      if (logSearchQuery.trim()) {
        const q = logSearchQuery.trim().toLowerCase();
        return (
          entry.machine_id.toLowerCase().includes(q) ||
          entry.line_id.toLowerCase().includes(q) ||
          entry.state.toLowerCase().includes(q) ||
          entry.raw.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [liveRun, logLevelFilter, logSearchQuery]);

  const filteredFeatures = useMemo(() => activeFeatures.filter((row) => {
      if (anomalyFilter === 'anomalous' && row.is_anomalous_window !== 1) return false;
      if (anomalyFilter === 'nominal' && row.is_anomalous_window !== 0) return false;
      if (machineQuery.trim()) {
        const q = machineQuery.trim().toLowerCase();
        return (
          row.machine_id.toLowerCase().includes(q) ||
          row.line_id.toLowerCase().includes(q) ||
          row.machine_type.toLowerCase().includes(q)
        );
      }
      return true;
    }), [activeFeatures, anomalyFilter, machineQuery]);

  const { pageItems: pagedLogs, safePage: safeLogsPage } = paginateItems(
    filteredLogs,
    logsPage,
    tablePageSize
  );
  const { pageItems: pagedFeatures, safePage: safeFeaturesPage } = paginateItems(
    filteredFeatures,
    featuresPage,
    tablePageSize
  );
  const { pageItems: pagedQuarantine, safePage: safeQuarantinePage } = paginateItems(
    activeQuarantine,
    quarantinePage,
    tablePageSize
  );
  const { pageItems: pagedSegments, safePage: safeSegmentsPage } = paginateItems(
    activeSegments,
    segmentsPage,
    tablePageSize
  );

  const handleTablePageSizeChange = (nextSize: number) => {
    setTablePageSize(nextSize);
    setLogsPage(1);
    setFeaturesPage(1);
    setQuarantinePage(1);
    setSegmentsPage(1);
  };

  const visibleColumns = useMemo(() => {
    const chosen = outputFields.filter((f) => availableFields.includes(f));
    return chosen.length > 0
      ? chosen
      : ['machine_id', 'machine_type', 'window_start', 'temp_mean', 'primary_metric_mean'];
  }, [outputFields, availableFields]);

  const exportFeaturesCsv = () => {
    if (activeFeatures.length === 0) return;
    const headers = visibleColumns;
    const esc = (v: unknown) => {
      let text = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '');
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const csvRows = [
      headers.map(esc).join(','),
      ...activeFeatures.map((row) =>
        headers.map((h) => esc((row as unknown as Record<string, unknown>)[h])).join(',')
      ),
    ];
    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'ml_machine_features_mart.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const inspectedPayloadInfo = useMemo(() => {
    if (!inspectedRecord) return null;
    const raw =
      inspectedRecord.kind === 'log'
        ? inspectedRecord.entry.raw
        : inspectedRecord.record.raw_payload;
    return parsePayloadForInspector(raw);
  }, [inspectedRecord]);

  const handleCopyInspectedJson = async () => {
    if (!inspectedPayloadInfo) return;
    try {
      await navigator.clipboard.writeText(inspectedPayloadInfo.formattedText);
      setCopiedPayload(true);
      setTimeout(() => setCopiedPayload(false), 1800);
    } catch {
      // Clipboard unavailable
    }
  };

  const handleDownloadInspectedJson = () => {
    if (!inspectedRecord || !inspectedPayloadInfo) return;
    const filename =
      inspectedRecord.kind === 'log'
        ? `telemetry_seq_${inspectedRecord.entry.seq}_${inspectedRecord.entry.machine_id}.json`
        : `quarantine_${inspectedRecord.record.quarantine_id}.json`;
    const blob = new Blob([inspectedPayloadInfo.formattedText], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const toggleOutputField = (field: string) => {
    setOutputFields((prev) => {
      if (prev.includes(field)) {
        return prev.length > 1 ? prev.filter((f) => f !== field) : prev;
      }
      return [...prev, field];
    });
  };

  const togglePlcInMix = (typeId: string) => {
    setSelectedPlcTypes((prev) =>
      prev.includes(typeId) ? prev.filter((id) => id !== typeId) : [...prev, typeId]
    );
  };

  const plannedCalls = durationMinutes * 60 * eventsPerSec;
  const runStatus = liveRun?.status ?? 'stopped';
  const isRunning = runStatus === 'running';
  const isPaused = runStatus === 'paused';

  const preset = SCENARIO_PRESETS[scenario];
  const currentRunConfig: LiveRunConfig = {
    durationMinutes,
    eventsPerSec,
    speedMultiplier,
    windowMinutes: jobConfig.windowMinutes,
    machineCount,
    machinesPerLine: jobConfig.machinesPerLine,
    machineProfileMode: profileMode,
    selectedPlcTypes: selectedPlcTypes.length > 0 ? selectedPlcTypes : undefined,
    outputFields: visibleColumns,
    faultProbabilityPct: preset.faultProbabilityPct,
    malformedRatePct: preset.malformedRatePct,
    outOfOrderRatePct: preset.outOfOrderRatePct,
    rotateMaxLines: jobConfig.rotateMaxLines,
    seed: 42,
    customMachineTopology: jobConfig.customMachineTopology,
    ignoredErrorCodes: jobConfig.ignoredErrorCodes,
    horizonWindows: jobConfig.horizonWindows,
    tempAnomalyThresholdC: jobConfig.tempAnomalyThresholdC,
    vibrationP95Threshold: jobConfig.vibrationP95Threshold,
    minValidSampleRatio: jobConfig.minValidSampleRatio,
    dedupStrategy: jobConfig.dedupStrategy,
    malformedPolicy: jobConfig.malformedPolicy,
    parquetCompression: jobConfig.parquetCompression,
    datasetVersion: jobConfig.datasetVersion,
    partitionLayout: jobConfig.partitionLayout,
    lakehouseFormat: jobConfig.lakehouseFormat,
    hotRetentionDays: jobConfig.hotRetentionDays,
    coldRetentionDays: jobConfig.coldRetentionDays,
    coldStorageEndpoint: jobConfig.coldStorageEndpoint,
    compactionSchedule: jobConfig.compactionSchedule,
    ingestTransport: jobConfig.ingestTransport,
  };

  const hasPendingParams = useMemo(() => {
    if (!liveRun) return false;
    const active = liveRun.config;
    const activeMix = (active.selectedPlcTypes ?? []).slice().sort().join(',');
    const nextMix = selectedPlcTypes.slice().sort().join(',');
    return (
      active.machineProfileMode !== profileMode ||
      activeMix !== nextMix ||
      active.durationMinutes !== durationMinutes ||
      active.eventsPerSec !== eventsPerSec ||
      active.speedMultiplier !== speedMultiplier ||
      active.machineCount !== machineCount ||
      active.faultProbabilityPct !== preset.faultProbabilityPct
    );
  }, [
    liveRun,
    profileMode,
    selectedPlcTypes,
    durationMinutes,
    eventsPerSec,
    speedMultiplier,
    machineCount,
    preset.faultProbabilityPct,
  ]);

  const storageLabel =
    jobConfig.storageTarget === 'garage-s3'
      ? 'Garage S3'
      : jobConfig.storageTarget === 'rustfs-s3'
      ? 'RustFS S3'
      : t('operations:workbench.featuresTable.storageLocal');

  const pipelineHealth = useMemo(() => {
    if (!liveRun || liveRun.totalCallsEmitted === 0) {
      return {
        level: 'idle' as const,
        label: t('operations:workbench.health.idle'),
        summary: t('operations:workbench.health.idleSummary'),
        badgeClass: 'bg-slate-50 border-slate-300 text-slate-800',
        dotClass: 'bg-slate-400',
        labelClass: 'text-slate-600',
      };
    }

    const total = Math.max(1, liveRun.totalCallsEmitted);
    const validPct = ((liveRun.validEventsCount / total) * 100).toFixed(1);
    const quarantineRatePct = (liveRun.quarantinedCount / total) * 100;
    const quarantinePct = quarantineRatePct.toFixed(1);
    const totalWindows = liveRun.featureRowsCount;
    const anomalousWindows = liveRun.anomalousWindowsCount;
    const anomalyRatePct = totalWindows > 0 ? (anomalousWindows / totalWindows) * 100 : 0;

    const recentSlice = liveRun.recentLogs.slice(0, 25);
    const recentFaultCount = recentSlice.filter((e) => e.level === 'ERROR').length;
    const recentFaultRatePct =
      recentSlice.length > 0 ? (recentFaultCount / recentSlice.length) * 100 : 0;

    const metricsSummary = t('operations:workbench.health.metricsSummary', {
      validPct,
      quarantinePct,
      anomalous: anomalousWindows,
      totalWin: totalWindows,
    });

    const isCritical =
      quarantineRatePct >= 14 ||
      recentFaultRatePct >= 18 ||
      (totalWindows >= 4 && anomalyRatePct >= 80 && recentFaultRatePct >= 10);

    if (isCritical) {
      return {
        level: 'critical' as const,
        label: t('operations:workbench.health.critical'),
        summary: metricsSummary,
        badgeClass: 'bg-red-50 border-red-300 text-red-900',
        dotClass: 'bg-red-600',
        labelClass: 'text-red-700',
      };
    }

    const isDegraded =
      quarantineRatePct >= 9 ||
      recentFaultRatePct >= 8 ||
      liveRun.status === 'paused' ||
      (totalWindows >= 2 && anomalyRatePct >= 50 && recentFaultRatePct >= 5);

    if (isDegraded) {
      return {
        level: 'degraded' as const,
        label: t('operations:workbench.health.degraded'),
        summary:
          liveRun.status === 'paused'
            ? t('operations:workbench.health.pausedSummary', { validPct })
            : metricsSummary,
        badgeClass: 'bg-amber-50 border-amber-300 text-amber-900',
        dotClass: 'bg-amber-500',
        labelClass: 'text-amber-700',
      };
    }

    return {
      level: 'stable' as const,
      label: t('operations:workbench.health.stable'),
      summary: metricsSummary,
      badgeClass: 'bg-emerald-50 border-emerald-300 text-emerald-900',
      dotClass: 'bg-emerald-600',
      labelClass: 'text-emerald-700',
    };
  }, [liveRun, t]);

  return (
    <div className="space-y-5">
      {/* Compact ERP Simulation Control Panel */}
      <section className="bg-white border border-hairline rounded-[2px]">
        <div className="px-5 py-4 border-b border-hairline flex flex-col xl:flex-row xl:items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-[15px] font-semibold tracking-tight text-ink">
                {t('operations:workbench.title')}
              </h1>
              <div
                role="status"
                aria-live="polite"
                data-testid="pipeline-health-badge"
                data-health-level={pipelineHealth.level}
                title={`${t('operations:workbench.health.label')}: ${pipelineHealth.label} — ${pipelineHealth.summary}`}
                className={`inline-flex items-center gap-2 px-2.5 py-1 border rounded-[2px] text-xs font-medium shrink-0 ${pipelineHealth.badgeClass}`}
              >
                <span className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className={`w-2 h-2 rounded-[1px] shrink-0 ${pipelineHealth.dotClass}`}
                  />
                  {pipelineHealth.level === 'critical' ? (
                    <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
                  ) : pipelineHealth.level === 'degraded' ? (
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  ) : pipelineHealth.level === 'stable' ? (
                    <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                  ) : (
                    <Activity className="w-3.5 h-3.5 shrink-0" />
                  )}
                  <span className={`text-[10px] font-mono uppercase tracking-[0.06em] ${pipelineHealth.labelClass}`}>
                    {t('operations:workbench.health.label')}
                  </span>
                  <span className="font-semibold tracking-tight">{pipelineHealth.label}</span>
                </span>
                <span className="hidden sm:inline text-[11px] font-mono opacity-80 border-l border-current/20 pl-2">
                  {pipelineHealth.summary}
                </span>
              </div>
            </div>
            <p className="text-xs text-slate-600 mt-0.5">
              {t('operations:workbench.subtitlePrefix')}{' '}
              <button
                type="button"
                onClick={onOpenPlcCatalog}
                className="font-medium text-brand hover:underline cursor-pointer"
              >
                {t('operations:workbench.subtitlePlcCatalog', { count: catalogProfiles.length })}
              </button>{' '}
              {t('operations:workbench.subtitleMiddle')}{' '}
              <button
                type="button"
                onClick={onOpenJobConfig}
                className="font-medium text-brand hover:underline cursor-pointer"
              >
                {t('operations:workbench.subtitleJobConfig')}
              </button>{' '}
              {t('operations:workbench.subtitlePolicySummary', {
                windowMinutes: jobConfig.windowMinutes,
                rotateLines: jobConfig.rotateMaxLines.toLocaleString(),
                mix:
                  selectedPlcTypes.length > 0
                    ? t('operations:workbench.customMixCount', { count: selectedPlcTypes.length })
                    : profileMode,
              })}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <Button variant="secondary" size="sm" onClick={() => setShowSchemaDrawer(true)}>
              <Columns3 className="w-3.5 h-3.5 text-brand" />
              <span>
                {t('operations:workbench.mixAndColumns', {
                  mix: selectedPlcTypes.length || t('operations:workbench.mixAuto'),
                  cols: visibleColumns.length,
                })}
              </span>
            </Button>

            <Button
              variant="primary"
              size="sm"
              onClick={() => onStartLiveRun(currentRunConfig)}
              disabled={isSimulating || !canControlSimulation}
              title={!canControlSimulation ? t('operations:workbench.noSimPermission') : undefined}
            >
              {isRunning ? <RotateCw className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              {isRunning ? t('operations:workbench.restartStream') : t('operations:workbench.startStream')}
            </Button>

            {isRunning && canControlSimulation && (
              <button
                type="button"
                onClick={() => onControlLiveRun('pause')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-800 bg-white border border-hairline-strong hover:bg-slate-50 rounded-[2px] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Pause className="w-3.5 h-3.5" />
                {t('operations:workbench.pause')}
              </button>
            )}

            {isPaused && canControlSimulation && (
              <button
                type="button"
                onClick={() => onControlLiveRun('resume')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-300 hover:bg-emerald-100 rounded-[2px] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Play className="w-3.5 h-3.5" />
                {t('operations:workbench.resume')}
              </button>
            )}

            {(isRunning || isPaused) && canControlSimulation && (
              <button
                type="button"
                onClick={() => onControlLiveRun('stop')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-800 bg-red-50 border border-red-300 hover:bg-red-100 rounded-[2px] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Square className="w-3 h-3" />
                {t('operations:workbench.stop')}
              </button>
            )}
          </div>
        </div>

        {/* Clean Dropdown Parameter Grid */}
        <div className="px-5 py-3 bg-[#f8f9fb] border-b border-hairline grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          <div>
            <label htmlFor="erp-plc-profile" className="block text-[11px] font-medium text-slate-600 mb-1">
              {t('operations:workbench.controls.plcProfile')}
            </label>
            <select
              id="erp-plc-profile"
              value={profileMode}
              onChange={(e) => {
                const nextMode = e.target.value;
                setProfileMode(nextMode);
                setSelectedPlcTypes([]);
                if (canControlSimulation && !isSimulating) {
                  onStartLiveRun({
                    ...currentRunConfig,
                    machineProfileMode: nextMode,
                    selectedPlcTypes: undefined,
                  });
                }
              }}
              className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
            >
              <option value="mixed">{t('operations:workbench.controls.plcProfileMixed')}</option>
              <option value="manufacturing">{t('operations:workbench.controls.plcProfileManufacturing')}</option>
              <option value="gas-metering">{t('operations:workbench.controls.plcProfileGas')}</option>
              <option value="power-generation">{t('operations:workbench.controls.plcProfilePower')}</option>
              {catalogProfiles.map((p) => (
                <option key={p.typeId} value={p.typeId}>
                  {t('operations:workbench.controls.plcProfilePrefix', { label: p.label })}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="erp-duration" className="block text-[11px] font-medium text-slate-600 mb-1">
              {t('operations:workbench.controls.duration')}
            </label>
            <select
              id="erp-duration"
              value={durationMinutes}
              onChange={(e) => setDurationMinutes(Number(e.target.value))}
              className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
            >
              <option value={1}>{t('operations:workbench.controls.duration1')}</option>
              <option value={5}>{t('operations:workbench.controls.duration5')}</option>
              <option value={15}>{t('operations:workbench.controls.duration15')}</option>
              <option value={30}>{t('operations:workbench.controls.duration30')}</option>
              <option value={60}>{t('operations:workbench.controls.duration60')}</option>
              <option value={120}>{t('operations:workbench.controls.duration120')}</option>
              <option value={240}>{t('operations:workbench.controls.duration240')}</option>
              <option value={480}>{t('operations:workbench.controls.duration480')}</option>
              <option value={1440}>{t('operations:workbench.controls.duration1440')}</option>
            </select>
          </div>

          <div>
            <label htmlFor="erp-rate" className="block text-[11px] font-medium text-slate-600 mb-1">
              {t('operations:workbench.controls.callRate')}
            </label>
            <select
              id="erp-rate"
              value={eventsPerSec}
              onChange={(e) => setEventsPerSec(Number(e.target.value))}
              className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
            >
              <option value={2}>{t('operations:workbench.controls.rateEvtSec', { rate: 2 })}</option>
              <option value={10}>{t('operations:workbench.controls.rateEvtSec', { rate: 10 })}</option>
              <option value={25}>{t('operations:workbench.controls.rateEvtSec', { rate: 25 })}</option>
              <option value={50}>{t('operations:workbench.controls.rateEvtSec', { rate: 50 })}</option>
            </select>
          </div>

          <div>
            <label htmlFor="erp-speed" className="block text-[11px] font-medium text-slate-600 mb-1">
              {t('operations:workbench.controls.streamSpeed')}
            </label>
            <select
              id="erp-speed"
              value={speedMultiplier}
              onChange={(e) => setSpeedMultiplier(Number(e.target.value) as 1 | 10 | 60 | 300)}
              className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
            >
              <option value={1}>{t('operations:workbench.controls.speed1')}</option>
              <option value={10}>{t('operations:workbench.controls.speed10')}</option>
              <option value={60}>{t('operations:workbench.controls.speed60')}</option>
              <option value={300}>{t('operations:workbench.controls.speed300')}</option>
            </select>
          </div>

          <div>
            <label htmlFor="erp-machines" className="block text-[11px] font-medium text-slate-600 mb-1">
              {t('operations:workbench.controls.fleetScale')}
            </label>
            <select
              id="erp-machines"
              value={machineCount}
              onChange={(e) => setMachineCount(Number(e.target.value))}
              className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
            >
              <option value={4}>{t('operations:workbench.controls.machinesCount', { count: 4 })}</option>
              <option value={8}>{t('operations:workbench.controls.machinesCount', { count: 8 })}</option>
              <option value={16}>{t('operations:workbench.controls.machinesCount', { count: 16 })}</option>
              <option value={24}>{t('operations:workbench.controls.machinesCount', { count: 24 })}</option>
            </select>
          </div>

          <div>
            <label htmlFor="erp-scenario" className="block text-[11px] font-medium text-slate-600 mb-1">
              {t('operations:workbench.controls.faultProfile')}
            </label>
            <select
              id="erp-scenario"
              value={scenario}
              onChange={(e) => setScenario(e.target.value as StressScenario)}
              className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
            >
              <option value="nominal">{t('operations:workbench.controls.scenarioNominal')}</option>
              <option value="degraded">{t('operations:workbench.controls.scenarioDegraded')}</option>
              <option value="stress">{t('operations:workbench.controls.scenarioStress')}</option>
            </select>
          </div>

          <div>
            <div className="block text-[11px] font-medium text-slate-600 mb-1">
              {t('operations:workbench.controls.plannedVolume')}
            </div>
            <div className="px-2.5 py-1.5 text-xs font-mono bg-[#f0f3f8] border border-hairline rounded-[2px] text-ink font-medium tabular-nums">
              {t('operations:workbench.controls.plannedCalls', { count: plannedCalls.toLocaleString() })}
            </div>
          </div>
        </div>

        {/* Pending Parameter Changes Banner */}
        {hasPendingParams && (
          <div className="px-5 py-2 bg-amber-50 border-b border-amber-200 flex flex-wrap items-center justify-between gap-2 text-xs text-amber-900">
            <span>
              {t('operations:workbench.pendingBanner')}{' '}
              <span className="font-mono font-semibold">{liveRun?.runId}</span>.
            </span>
            <Button
              variant="primary"
              size="xs"
              disabled={isSimulating || !canControlSimulation}
              onClick={() => onStartLiveRun(currentRunConfig)}
            >
              <RotateCw className="w-3 h-3" />
              {t('operations:workbench.applyAndRestart')}
            </Button>
          </div>
        )}

        {/* Real-Time Active Simulation Telemetry Strip */}
        <div className="px-5 py-3.5 border-b border-hairline space-y-3">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 text-xs">
              <span
                className={`font-mono font-semibold ${
                  isRunning
                    ? 'text-emerald-800'
                    : isPaused
                    ? 'text-amber-800'
                    : runStatus === 'completed'
                    ? 'text-slate-900'
                    : 'text-slate-600'
                }`}
              >
                {isRunning
                  ? t('operations:workbench.status.running')
                  : isPaused
                  ? t('operations:workbench.status.paused')
                  : runStatus === 'completed'
                  ? t('operations:workbench.status.completed')
                  : t('operations:workbench.status.idle')}
              </span>
              {liveRun && (
                <span className="text-slate-500 font-mono">
                  ·{' '}
                  {t('operations:workbench.status.runMeta', {
                    runId: liveRun.runId,
                    speed: liveRun.config.speedMultiplier,
                    sampleSec: liveRun.expectedSampleSec,
                  })}
                </span>
              )}
            </div>

            {liveRun && (
              <div className="text-xs font-mono tabular-nums text-slate-700">
                {t('operations:workbench.status.clockMeta', {
                  elapsed: formatClock(liveRun.elapsedSimSec),
                  target: formatClock(liveRun.targetSimSec),
                  wall: liveRun.elapsedWallSec.toFixed(1),
                  pct: liveRun.progressPct.toFixed(1),
                })}
              </div>
            )}
          </div>

          <div className="w-full h-2 bg-slate-200 rounded-[1px] overflow-hidden">
            <div
              className={`h-full transition-all duration-300 ${
                isRunning
                  ? 'bg-brand'
                  : isPaused
                  ? 'bg-amber-600'
                  : 'bg-emerald-700'
              }`}
              style={{ width: `${liveRun ? liveRun.progressPct : 0}%` }}
            />
          </div>
        </div>

        {/* ERP Ledger KPI Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 divide-y sm:divide-y-0 sm:divide-x divide-hairline">
          <div className="px-4 py-3.5">
            <div className="text-[11px] font-medium text-slate-500">{t('operations:workbench.kpi.callsProduced')}</div>
            <div className="mt-1 text-base font-semibold tracking-tight text-ink font-mono tabular-nums">
              {(liveRun?.totalCallsEmitted ?? 0).toLocaleString()}
              {liveRun ? (
                <span className="text-[11px] font-normal text-slate-500">
                  {' '}
                  / {liveRun.targetTotalCalls.toLocaleString()}
                </span>
              ) : null}
            </div>
          </div>
          <div className="px-4 py-3.5">
            <div className="text-[11px] font-medium text-slate-500">{t('operations:workbench.kpi.validEvents')}</div>
            <div className="mt-1 text-base font-semibold tracking-tight text-emerald-700 font-mono tabular-nums">
              {(liveRun?.validEventsCount ?? 0).toLocaleString()}
            </div>
          </div>
          <div className="px-4 py-3.5">
            <div className="text-[11px] font-medium text-slate-500">{t('operations:workbench.kpi.quarantined')}</div>
            <div className="mt-1 text-base font-semibold tracking-tight text-amber-700 font-mono tabular-nums">
              {(liveRun?.quarantinedCount ?? 0).toLocaleString()}
            </div>
          </div>
          <div className="px-4 py-3.5">
            <div className="text-[11px] font-medium text-slate-500">{t('operations:workbench.kpi.outOfOrder')}</div>
            <div className="mt-1 text-base font-semibold tracking-tight text-ink font-mono tabular-nums">
              {(liveRun?.outOfOrderCount ?? 0).toLocaleString()}
            </div>
          </div>
          <div className="px-4 py-3.5">
            <div className="text-[11px] font-medium text-slate-500">{t('operations:workbench.kpi.logSegments')}</div>
            <div className="mt-1 text-base font-semibold tracking-tight text-ink font-mono tabular-nums">
              {liveRun?.rotatedSegmentsCount ?? 0}
            </div>
          </div>
          <div className="px-4 py-3.5">
            <div className="text-[11px] font-medium text-slate-500">{t('operations:workbench.kpi.mlWindows')}</div>
            <div className="mt-1 text-base font-semibold tracking-tight text-ink font-mono tabular-nums">
              {liveRun?.featureRowsCount ?? 0}
            </div>
          </div>
          <div className="px-4 py-3.5">
            <div className="text-[11px] font-medium text-slate-500">{t('operations:workbench.kpi.anomalousWin')}</div>
            <div className="mt-1 text-base font-semibold tracking-tight text-red-700 font-mono tabular-nums">
              {liveRun?.anomalousWindowsCount ?? 0}
            </div>
          </div>
          <div className="px-4 py-3.5">
            <div className="text-[11px] font-medium text-slate-500">{t('operations:workbench.kpi.highWatermark')}</div>
            <div className="mt-1 text-sm font-semibold text-ink font-mono tabular-nums truncate">
              {liveRun?.highWatermarkIso?.slice(11, 19) ?? '--'} UTC
            </div>
          </div>
        </div>
      </section>

      {/* Always-Visible Last-10 Log Stream Viewer */}
      <LogStreamViewer
        liveRun={liveRun}
        onSelectEntry={(entry) => setInspectedRecord({ kind: 'log', entry })}
      />

      {/* Operational Data Tabs — Clean Two-Row ERP Navigation & Filter Toolbar */}
      <SectionCard borderless>
        {/* Row 1: Single-line underline navigation tabs + active run context */}
        <div className="px-5 border-b border-hairline bg-surface flex items-center justify-between gap-4">
          <div
            role="tablist"
            aria-label={t('operations:workbench.tabsAriaLabel')}
            className="flex items-center gap-1 overflow-x-auto -mb-px"
          >
            {(
              [
                {
                  id: 'live_logs' as const,
                  label: t('operations:workbench.tabs.liveLogs'),
                  count: liveRun?.recentLogs.length ?? 0,
                },
                {
                  id: 'features' as const,
                  label: t('operations:workbench.tabs.features'),
                  count: activeFeatures.length,
                },
                {
                  id: 'quarantine' as const,
                  label: t('operations:workbench.tabs.quarantine'),
                  count: activeQuarantine.length,
                },
                {
                  id: 'segments' as const,
                  label: t('operations:workbench.tabs.segments'),
                  count: activeSegments.length,
                },
              ]
            ).map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setActiveTab(tab.id)}
                  className={`px-3 py-3 text-xs border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer inline-flex items-center gap-1.5 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand ${
                    isActive
                      ? 'border-brand text-brand font-semibold'
                      : 'border-transparent text-slate-600 hover:text-slate-900 hover:border-slate-300 font-medium'
                  }`}
                >
                  <span>{tab.label}</span>
                  <span
                    className={`font-mono text-[11px] tabular-nums ${
                      isActive ? 'text-brand' : 'text-slate-500'
                    }`}
                  >
                    ({tab.count})
                  </span>
                </button>
              );
            })}
          </div>

          {liveRun && (
            <div className="hidden lg:flex items-center gap-1.5 text-[11px] font-mono text-slate-500 whitespace-nowrap shrink-0">
              <span>{t('operations:workbench.activeRunLabel')}</span>
              <span className="text-slate-800 font-semibold">{liveRun.runId}</span>
              <span>·</span>
              <span>
                {liveRun.config.selectedPlcTypes?.length
                  ? t('operations:workbench.activeRunMix', { count: liveRun.config.selectedPlcTypes.length })
                  : liveRun.config.machineProfileMode}
              </span>
            </div>
          )}
        </div>

        {/* Row 2: Contextual Filter & Export Toolbar */}
        {(activeTab === 'live_logs' || activeTab === 'features' || liveRun) && (
          <div className="px-5 py-2.5 bg-white flex flex-wrap items-center justify-between gap-3">
            {activeTab === 'live_logs' && (
              <>
                <div className="flex flex-wrap items-center gap-2.5">
                  <div className="relative w-full sm:w-64">
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={logSearchQuery}
                      onChange={(e) => setLogSearchQuery(e.target.value)}
                      placeholder={t('operations:workbench.filters.logSearchPlaceholder')}
                      aria-label={t('operations:workbench.filters.logSearchAria')}
                      className={`${ERP_INPUT_COMPACT_CLASS} pl-8`}
                    />
                  </div>

                  <div
                    role="group"
                    aria-label={t('operations:workbench.filters.logLevelAria')}
                    className="inline-flex items-center rounded-[2px] border border-hairline-strong bg-surface overflow-hidden divide-x divide-hairline"
                  >
                    {(['ALL', 'INFO', 'WARN', 'ERROR', 'QUARANTINE'] as const).map((lvl) => (
                      <button
                        key={lvl}
                        type="button"
                        onClick={() => setLogLevelFilter(lvl)}
                        className={`px-2.5 py-1.5 text-[11px] font-mono font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                          logLevelFilter === lvl
                            ? 'bg-brand text-white'
                            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                        }`}
                      >
                        {lvl === 'ALL' ? t('operations:workbench.filters.logLevelAll') : lvl}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono text-slate-600 tabular-nums whitespace-nowrap">
                  <span className="text-slate-500 hidden md:inline">
                    {t('operations:workbench.logsTable.clickToInspectHint')}
                  </span>
                  <span>
                    {t('operations:workbench.filters.showingLogs', {
                      shown: filteredLogs.length,
                      total: liveRun?.recentLogs.length ?? 0,
                    })}
                  </span>
                </div>
              </>
            )}

            {activeTab === 'features' && (
              <>
                <div className="flex flex-wrap items-center gap-2.5">
                  <div className="relative w-full sm:w-64">
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={machineQuery}
                      onChange={(e) => setMachineQuery(e.target.value)}
                      placeholder={t('operations:workbench.filters.machineSearchPlaceholder')}
                      aria-label={t('operations:workbench.filters.machineSearchAria')}
                      className={`${ERP_INPUT_COMPACT_CLASS} pl-8`}
                    />
                  </div>

                  <div
                    role="group"
                    aria-label={t('operations:workbench.filters.windowStatusAria')}
                    className="inline-flex items-center rounded-[2px] border border-hairline-strong bg-surface overflow-hidden divide-x divide-hairline"
                  >
                    {(
                      [
                        { id: 'all' as const, label: t('operations:workbench.filters.statusAll') },
                        { id: 'anomalous' as const, label: t('operations:workbench.filters.statusAnomalous') },
                        { id: 'nominal' as const, label: t('operations:workbench.filters.statusNominal') },
                      ]
                    ).map((mode) => (
                      <button
                        key={mode.id}
                        type="button"
                        onClick={() => setAnomalyFilter(mode.id)}
                        className={`px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                          anomalyFilter === mode.id
                            ? 'bg-brand text-white'
                            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                        }`}
                      >
                        {mode.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-[11px] font-mono text-slate-600 tabular-nums whitespace-nowrap">
                    {t('operations:workbench.filters.showingWindows', {
                      shown: filteredFeatures.length,
                      total: activeFeatures.length,
                    })}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={exportFeaturesCsv}
                    disabled={activeFeatures.length === 0}
                  >
                    <Download className="w-3.5 h-3.5" />
                    {t('operations:workbench.filters.exportCsvCols', { count: visibleColumns.length })}
                  </Button>
                </div>
              </>
            )}

            {activeTab === 'quarantine' && (
              <div className="w-full flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-slate-600 tabular-nums">
                <span>{t('operations:workbench.filters.quarantineHint')}</span>
                <span>
                  {t('operations:workbench.filters.quarantineCount', { count: activeQuarantine.length })}
                </span>
              </div>
            )}

            {activeTab === 'segments' && (
              <div className="w-full flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-slate-600 tabular-nums">
                <span>
                  {t('operations:workbench.filters.segmentsHint', {
                    lines: jobConfig.rotateMaxLines.toLocaleString(),
                  })}
                </span>
                <span>
                  {t('operations:workbench.filters.segmentsCount', { count: activeSegments.length })}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Tab 1: Live Log Stream */}
        {activeTab === 'live_logs' && (
          <div>
            <div ref={tableScrollRef} className="erp-table-scroll max-h-[580px] overflow-y-auto">
              {!liveRun ? (
                <div className="p-8 text-center text-xs text-slate-500">
                  {t('operations:workbench.logsTable.emptyNoRun')}
                </div>
              ) : filteredLogs.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-500">
                  {t('operations:workbench.logsTable.emptyFiltered')}
                </div>
              ) : (
                <table className="w-full min-w-[980px] text-left border-collapse text-xs">
                  <thead className={`sticky top-0 z-10 ${ERP_TABLE_HEAD_ROW_CLASS}`}>
                    <tr>
                      <th className="py-2.5 px-3 w-16 text-right">{t('operations:workbench.logsTable.colSeq')}</th>
                      <th className="py-2.5 px-3">{t('operations:workbench.logsTable.colTimestamp')}</th>
                      <th className="py-2.5 px-3">{t('operations:workbench.logsTable.colMachine')}</th>
                      <th className="py-2.5 px-3">{t('operations:workbench.logsTable.colLevel')}</th>
                      <th className="py-2.5 px-3">{t('operations:workbench.logsTable.colState')}</th>
                      <th className="py-2.5 px-3 text-right">{t('operations:workbench.logsTable.colTemp')}</th>
                      <th className="py-2.5 px-3 text-right">{t('operations:workbench.logsTable.colPrimary')}</th>
                      <th className="py-2.5 px-3">{t('operations:workbench.logsTable.colPayload')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-hairline font-mono">
                    {pagedLogs.map((entry) => {
                      const isSelected =
                        inspectedRecord?.kind === 'log' &&
                        inspectedRecord.entry.seq === entry.seq &&
                        inspectedRecord.entry.timestamp === entry.timestamp;
                      return (
                        <tr
                          key={`${entry.seq}-${entry.timestamp}`}
                          tabIndex={0}
                          onClick={() => setInspectedRecord({ kind: 'log', entry })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setInspectedRecord({ kind: 'log', entry });
                            }
                          }}
                          className={`cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand ${
                            isSelected
                              ? 'bg-brand-subtle'
                              : entry.quarantined
                              ? 'bg-amber-50/70 hover:bg-amber-100/70'
                              : entry.level === 'ERROR'
                              ? 'bg-red-50/60 hover:bg-red-100/60'
                              : 'hover:bg-slate-100/80'
                          }`}
                        >
                          <td className="py-1.5 px-3 text-right text-slate-500 tabular-nums">
                            #{entry.seq}
                          </td>
                          <td className="py-1.5 px-3 text-slate-700 tabular-nums whitespace-nowrap">
                            {formatUtcTimestamp(entry.timestamp)}
                          </td>
                          <td className="py-1.5 px-3 font-medium text-slate-900 whitespace-nowrap">
                            {entry.machine_id} · {entry.machine_type}
                          </td>
                          <td
                            className={`py-1.5 px-3 font-semibold whitespace-nowrap ${
                              entry.level === 'ERROR'
                                ? 'text-red-700'
                                : entry.level === 'WARN' || entry.level === 'QUARANTINE'
                                ? 'text-amber-700'
                                : 'text-emerald-700'
                            }`}
                          >
                            {entry.level}
                          </td>
                          <td className="py-1.5 px-3 text-slate-800 whitespace-nowrap">
                            {entry.quarantined
                              ? t('operations:workbench.logsTable.corruptState', { reason: entry.error_reason })
                              : entry.state}
                          </td>
                          <td className="py-1.5 px-3 text-right text-slate-800 tabular-nums">
                            {entry.temp_c !== null ? entry.temp_c.toFixed(1) : '--'}
                          </td>
                          <td className="py-1.5 px-3 text-right text-slate-800 tabular-nums whitespace-nowrap">
                            {entry.primary_metric_value !== null
                              ? `${entry.primary_metric_value} ${entry.primary_metric_unit ?? ''}`
                              : '--'}
                          </td>
                          <td className="py-1.5 px-3 text-slate-600 max-w-md">
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate">{entry.raw}</span>
                              <span className="inline-flex items-center gap-1 text-[10px] font-sans font-medium text-brand shrink-0">
                                <Eye className="w-3 h-3" />
                                {t('operations:workbench.logsTable.inspectCue')}
                              </span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {liveRun && filteredLogs.length > 0 && (
              <TablePagination
                currentPage={safeLogsPage}
                totalItems={filteredLogs.length}
                pageSize={tablePageSize}
                maxVisiblePages={3}
                onPageChange={setLogsPage}
                onPageSizeChange={handleTablePageSizeChange}
                itemLabel={t('operations:workbench.pagination.lines')}
              />
            )}
          </div>
        )}

        {/* Tab 2: ML Feature Mart */}
        {activeTab === 'features' && (
          <div>
            <div ref={tableScrollRef} className="erp-table-scroll max-h-[580px] overflow-y-auto">
              <table className="w-full min-w-max text-left border-collapse text-xs">
                <thead className={`sticky top-0 z-10 ${ERP_TABLE_HEAD_ROW_CLASS}`}>
                  <tr>
                    {visibleColumns.map((col) => (
                      <th
                        key={col}
                        className={`py-2.5 px-3 whitespace-nowrap ${
                          RIGHT_ALIGN_FIELDS.has(col) ? 'text-right' : ''
                        }`}
                      >
                        {t(`operations:workbench.fieldLabels.${col}`, {
                          defaultValue: FIELD_LABELS[col] ?? col,
                        })}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {filteredFeatures.length === 0 ? (
                    <tr>
                      <td colSpan={visibleColumns.length} className="py-8 text-center text-slate-500">
                        {t('operations:workbench.featuresTable.empty')}
                      </td>
                    </tr>
                  ) : (
                    pagedFeatures.map((row) => (
                      <tr key={`${row.machine_id}-${row.window_start}`} className="hover:bg-slate-50">
                        {visibleColumns.map((col) => {
                          const val = formatFeatureCell(row, col, featureCellLabels);
                          const isAnom = col === 'is_anomalous_window';
                          const isLead = col === 'will_fail_next_window';
                          let tone = 'text-slate-800';
                          if (isAnom) {
                            tone =
                              row.is_anomalous_window === 1
                                ? 'text-red-700 font-medium'
                                : 'text-emerald-700 font-medium';
                          } else if (isLead) {
                            tone =
                              row.will_fail_next_window === 1
                                ? 'text-red-700 font-medium'
                                : row.will_fail_next_window === 0
                                ? 'text-emerald-700 font-medium'
                                : 'text-slate-400 font-medium';
                          } else if (col === 'machine_id') {
                            tone = 'font-semibold text-slate-900';
                          }
                          return (
                            <td
                              key={col}
                              className={`py-2 px-3 font-mono tabular-nums whitespace-nowrap ${
                                RIGHT_ALIGN_FIELDS.has(col) ? 'text-right' : ''
                              } ${tone}`}
                            >
                              {val}
                            </td>
                          );
                        })}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {filteredFeatures.length > 0 && (
              <TablePagination
                currentPage={safeFeaturesPage}
                totalItems={filteredFeatures.length}
                pageSize={tablePageSize}
                maxVisiblePages={3}
                onPageChange={setFeaturesPage}
                onPageSizeChange={handleTablePageSizeChange}
                itemLabel={t('operations:workbench.pagination.featureWindows')}
              />
            )}

            {(activePartitions.length > 0 || liveRun?.tieringSummary) && (
              <div className="px-4 py-2.5 border-t border-hairline bg-[#f8f9fb] text-xs text-slate-600 space-y-1">
                {liveRun?.tieringSummary && (
                  <div className="font-mono text-[11px] text-slate-700">
                    <span className="font-semibold text-slate-900">
                      {t('operations:workbench.featuresTable.tieringLabel')}
                    </span>{' '}
                    {t('operations:workbench.featuresTable.tieringSummary', {
                      hotLabel: liveRun.tieringSummary.hotStoreLabel,
                      hotDays: liveRun.tieringSummary.hotRetentionDays,
                      coldLabel: liveRun.tieringSummary.coldStoreLabel,
                      coldDays: liveRun.tieringSummary.coldRetentionDays,
                      format: liveRun.tieringSummary.lakehouseFormat,
                      mb: liveRun.tieringSummary.estimatedColdParquetMb,
                      schedule: liveRun.tieringSummary.compactionSchedule,
                    })}
                  </div>
                )}
                {activePartitions.length > 0 && (
                  <div>
                    <span className="font-medium text-slate-800">
                      {t('operations:workbench.featuresTable.partitionsLabel', { storage: storageLabel })}
                    </span>{' '}
                    <span className="font-mono">{activePartitions.join(', ')}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Tab 3: Quarantine Sink */}
        {activeTab === 'quarantine' && (
          <div>
            <div ref={tableScrollRef} className="erp-table-scroll max-h-[580px] overflow-y-auto">
              <table className="w-full min-w-[860px] text-left border-collapse text-xs">
                <thead className={`sticky top-0 z-10 ${ERP_TABLE_HEAD_ROW_CLASS}`}>
                  <tr>
                    <th className="py-2.5 px-3">{t('operations:workbench.quarantineTable.colId')}</th>
                    <th className="py-2.5 px-3">{t('operations:workbench.quarantineTable.colAt')}</th>
                    <th className="py-2.5 px-3">{t('operations:workbench.quarantineTable.colSource')}</th>
                    <th className="py-2.5 px-3">{t('operations:workbench.quarantineTable.colReason')}</th>
                    <th className="py-2.5 px-3">{t('operations:workbench.quarantineTable.colPayload')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {activeQuarantine.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-8 text-center text-slate-500">
                        {t('operations:workbench.quarantineTable.empty')}
                      </td>
                    </tr>
                  ) : (
                    pagedQuarantine.map((rec, idx) => (
                      <tr
                        key={`${rec.quarantine_id}-${rec.source}-${idx}`}
                        tabIndex={0}
                        onClick={() => setInspectedRecord({ kind: 'quarantine', record: rec })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setInspectedRecord({ kind: 'quarantine', record: rec });
                          }
                        }}
                        className="cursor-pointer hover:bg-amber-50/70 transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand"
                      >
                        <td className="py-2 px-3 font-mono text-slate-700">{rec.quarantine_id}</td>
                        <td className="py-2 px-3 font-mono text-slate-600 tabular-nums whitespace-nowrap">
                          {formatUtcTimestamp(rec.quarantined_at)}
                        </td>
                        <td className="py-2 px-3 text-slate-700">{rec.source}</td>
                        <td className="py-2 px-3 font-mono text-amber-800 font-medium">
                          {rec.error_reason}
                        </td>
                        <td className="py-2 px-3 font-mono text-slate-600 max-w-xl">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate">{rec.raw_payload}</span>
                            <span className="inline-flex items-center gap-1 text-[10px] font-sans font-medium text-brand shrink-0">
                              <Eye className="w-3 h-3" />
                              {t('operations:workbench.logsTable.inspectCue')}
                            </span>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {activeQuarantine.length > 0 && (
              <TablePagination
                currentPage={safeQuarantinePage}
                totalItems={activeQuarantine.length}
                pageSize={tablePageSize}
                maxVisiblePages={3}
                onPageChange={setQuarantinePage}
                onPageSizeChange={handleTablePageSizeChange}
                itemLabel={t('operations:workbench.pagination.quarantine')}
              />
            )}
          </div>
        )}

        {/* Tab 4: Rotated Segments */}
        {activeTab === 'segments' && (
          <div>
            <div ref={tableScrollRef} className="erp-table-scroll max-h-[580px] overflow-y-auto">
              <table className="w-full min-w-[820px] text-left border-collapse text-xs">
                <thead className={`sticky top-0 z-10 ${ERP_TABLE_HEAD_ROW_CLASS}`}>
                  <tr>
                    <th className="py-2.5 px-3">{t('operations:workbench.segmentsTable.colFile')}</th>
                    <th className="py-2.5 px-3">{t('operations:workbench.segmentsTable.colRotatedAt')}</th>
                    <th className="py-2.5 px-3 text-right">{t('operations:workbench.segmentsTable.colLines')}</th>
                    <th className="py-2.5 px-3 text-right">{t('operations:workbench.segmentsTable.colSize')}</th>
                    <th className="py-2.5 px-3">
                      {t('operations:workbench.segmentsTable.colObjectKey', { storage: storageLabel })}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {activeSegments.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-8 text-center text-slate-500">
                        {t('operations:workbench.segmentsTable.empty', {
                          lines: (liveRun?.config.rotateMaxLines ?? jobConfig.rotateMaxLines).toLocaleString(),
                        })}
                      </td>
                    </tr>
                  ) : (
                    pagedSegments.map((seg) => (
                      <tr key={seg.name} className="hover:bg-slate-50">
                        <td className="py-2 px-3 font-mono font-medium text-slate-900">{seg.name}</td>
                        <td className="py-2 px-3 font-mono text-slate-600 tabular-nums">
                          {formatUtcTimestamp(seg.rotatedAt)}
                        </td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-800">
                          {seg.lines.toLocaleString()}
                        </td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-800">
                          {formatBytes(seg.sizeBytes)}
                        </td>
                        <td className="py-2 px-3 font-mono text-slate-600">{seg.s3Key}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {activeSegments.length > 0 && (
              <TablePagination
                currentPage={safeSegmentsPage}
                totalItems={activeSegments.length}
                pageSize={tablePageSize}
                maxVisiblePages={3}
                onPageChange={setSegmentsPage}
                onPageSizeChange={handleTablePageSizeChange}
                itemLabel={t('operations:workbench.pagination.segments')}
              />
            )}
          </div>
        )}
      </SectionCard>

      {/* Right-Side Drawer: Custom Multi-PLC Simulation Mix & Output Columns */}
      <SlideOverDrawer
        open={showSchemaDrawer}
        onClose={() => setShowSchemaDrawer(false)}
        title={t('operations:workbench.drawer.title')}
        subtitle={t('operations:workbench.drawer.subtitle')}
        size="lg"
        footer={
          <>
            <button
              type="button"
              onClick={() => {
                setShowSchemaDrawer(false);
                onOpenPlcCatalog();
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-slate-100 border border-hairline-strong rounded-[2px] cursor-pointer mr-auto"
            >
              <Cpu className="w-3.5 h-3.5" />
              {t('operations:workbench.drawer.openFullCatalog')}
            </button>
            <Button variant="secondary" size="sm" onClick={() => setShowSchemaDrawer(false)}>
              {t('common:actions.close')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={isSimulating || !canControlSimulation}
              onClick={() => {
                setShowSchemaDrawer(false);
                onStartLiveRun(currentRunConfig);
              }}
            >
              <RotateCw className="w-3.5 h-3.5" />
              {t('operations:workbench.applyAndRestart')}
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          {/* Custom PLC Mix Selection */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-slate-900">
                {t('operations:workbench.drawer.customMixHeading', { count: selectedPlcTypes.length })}
              </h3>
              {selectedPlcTypes.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSelectedPlcTypes([])}
                  className="text-[11px] text-slate-600 hover:underline cursor-pointer"
                >
                  {t('operations:workbench.drawer.clearMix')}
                </button>
              )}
            </div>
            <p className="text-[11px] text-slate-600">
              {t('operations:workbench.drawer.customMixHint')}
            </p>
            <div className="border border-hairline rounded-[2px] divide-y divide-hairline max-h-60 overflow-y-auto">
              {catalogProfiles.map((p) => {
                const checked = selectedPlcTypes.includes(p.typeId);
                return (
                  <label
                    key={p.typeId}
                    className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-slate-50 cursor-pointer text-xs"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => togglePlcInMix(p.typeId)}
                        className="rounded-[2px] border-slate-300 accent-brand"
                      />
                      <div className="min-w-0">
                        <div className="font-mono font-medium text-slate-900 truncate">{p.typeId}</div>
                        <div className="text-[11px] text-slate-500 truncate">
                          {p.label} · {p.domain}
                        </div>
                      </div>
                    </div>
                    <span className="font-mono text-[11px] text-slate-500 shrink-0">
                      {p.primaryKey} ({p.primaryUnit})
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          {/* Output Contract Columns */}
          <div className="space-y-2 pt-3 border-t border-hairline">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-slate-900">
                {t('operations:workbench.drawer.visibleColsHeading', {
                  visible: visibleColumns.length,
                  total: availableFields.length,
                })}
              </h3>
              <div className="flex items-center gap-3 text-[11px]">
                <button
                  type="button"
                  onClick={() => setOutputFields(availableFields)}
                  className="text-brand hover:underline cursor-pointer"
                >
                  {t('operations:workbench.drawer.selectAll')}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setOutputFields([
                      'machine_id',
                      'line_id',
                      'machine_type',
                      'window_start',
                      'sample_count',
                      'temp_mean',
                      'primary_metric_mean',
                      'time_in_fault_sec',
                      'is_anomalous_window',
                      'custom_metrics_avg',
                    ])
                  }
                  className="text-slate-600 hover:underline cursor-pointer"
                >
                  {t('operations:workbench.drawer.resetDefault')}
                </button>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {availableFields.map((field) => {
                const active = visibleColumns.includes(field);
                return (
                  <button
                    key={field}
                    type="button"
                    onClick={() => toggleOutputField(field)}
                    className={`px-2 py-1 text-[11px] font-mono border rounded-[2px] transition-colors cursor-pointer ${
                      active
                        ? 'bg-brand text-white border-brand'
                        : 'bg-white text-slate-700 border-hairline-strong hover:bg-slate-50'
                    }`}
                  >
                    {field}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </SlideOverDrawer>
      {/* Right-Side Drawer: Full Log / Quarantine Record Payload Inspector */}
      <SlideOverDrawer
        open={inspectedRecord !== null}
        onClose={() => {
          setInspectedRecord(null);
          setCopiedPayload(false);
        }}
        title={
          inspectedRecord?.kind === 'log'
            ? t('operations:workbench.recordInspector.titleLog', {
                seq: inspectedRecord.entry.seq,
                machineId: inspectedRecord.entry.machine_id,
              })
            : inspectedRecord?.kind === 'quarantine'
            ? t('operations:workbench.recordInspector.titleQuarantine', {
                id: inspectedRecord.record.quarantine_id,
              })
            : ''
        }
        subtitle={
          inspectedRecord?.kind === 'log'
            ? t('operations:workbench.recordInspector.subtitleLog', {
                timestamp: formatUtcTimestamp(inspectedRecord.entry.timestamp),
                lineId: inspectedRecord.entry.line_id,
                machineType: inspectedRecord.entry.machine_type,
                domain: inspectedRecord.entry.domain,
              })
            : inspectedRecord?.kind === 'quarantine'
            ? t('operations:workbench.recordInspector.subtitleQuarantine', {
                timestamp: formatUtcTimestamp(inspectedRecord.record.quarantined_at),
                source: inspectedRecord.record.source,
              })
            : ''
        }
        size="xl"
        footer={
          <>
            <button
              type="button"
              onClick={handleDownloadInspectedJson}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-[#f4f6f9] border border-hairline-strong rounded-[2px] cursor-pointer mr-auto"
            >
              <Download className="w-3.5 h-3.5" />
              {t('operations:workbench.recordInspector.downloadJson')}
            </button>
            <button
              type="button"
              onClick={() => void handleCopyInspectedJson()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-800 bg-white hover:bg-[#f4f6f9] border border-hairline-strong rounded-[2px] cursor-pointer"
            >
              {copiedPayload ? (
                <Check className="w-3.5 h-3.5 text-emerald-700" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
              {copiedPayload
                ? t('operations:workbench.recordInspector.copiedJson')
                : t('operations:workbench.recordInspector.copyJson')}
            </button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setInspectedRecord(null);
                setCopiedPayload(false);
              }}
            >
              {t('common:actions.close')}
            </Button>
          </>
        }
      >
        {inspectedRecord && inspectedPayloadInfo && (
          <div className="space-y-5">
            {/* Envelope & Classification Grid */}
            <div className="space-y-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                {t('operations:workbench.recordInspector.metadataHeading')}
              </h3>
              {inspectedRecord.kind === 'log' ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
                  <div className="p-2.5 bg-[#f8f9fb] border border-hairline rounded-[2px]">
                    <div className="text-[10px] uppercase tracking-wider text-slate-500">
                      {t('operations:workbench.recordInspector.fieldSeq')} /{' '}
                      {t('operations:workbench.recordInspector.fieldEventId')}
                    </div>
                    <div className="mt-0.5 font-mono text-ink font-semibold break-all">
                      #{inspectedRecord.entry.seq}
                      {typeof inspectedPayloadInfo.parsedObject?.event_id === 'string'
                        ? ` · ${inspectedPayloadInfo.parsedObject.event_id}`
                        : ''}
                    </div>
                  </div>
                  <div className="p-2.5 bg-[#f8f9fb] border border-hairline rounded-[2px]">
                    <div className="text-[10px] uppercase tracking-wider text-slate-500">
                      {t('operations:workbench.recordInspector.fieldTimestamp')}
                    </div>
                    <div className="mt-0.5 font-mono text-ink tabular-nums">
                      {inspectedRecord.entry.timestamp}
                    </div>
                  </div>
                  <div className="p-2.5 bg-[#f8f9fb] border border-hairline rounded-[2px]">
                    <div className="text-[10px] uppercase tracking-wider text-slate-500">
                      {t('operations:workbench.recordInspector.fieldMachine')}
                    </div>
                    <div className="mt-0.5 font-mono text-ink font-medium">
                      {inspectedRecord.entry.machine_id} · {inspectedRecord.entry.line_id}
                    </div>
                  </div>
                  <div className="p-2.5 bg-[#f8f9fb] border border-hairline rounded-[2px]">
                    <div className="text-[10px] uppercase tracking-wider text-slate-500">
                      {t('operations:workbench.recordInspector.fieldProfile')}
                    </div>
                    <div className="mt-0.5 font-mono text-ink">
                      {inspectedRecord.entry.machine_type} · {inspectedRecord.entry.domain}
                    </div>
                  </div>
                  <div className="p-2.5 bg-[#f8f9fb] border border-hairline rounded-[2px]">
                    <div className="text-[10px] uppercase tracking-wider text-slate-500">
                      {t('operations:workbench.recordInspector.fieldState')}
                    </div>
                    <div className="mt-0.5 font-mono font-semibold text-ink">
                      {inspectedRecord.entry.state} ·{' '}
                      <span
                        className={
                          inspectedRecord.entry.level === 'ERROR'
                            ? 'text-red-700'
                            : inspectedRecord.entry.level === 'WARN' ||
                              inspectedRecord.entry.level === 'QUARANTINE'
                            ? 'text-amber-700'
                            : 'text-emerald-700'
                        }
                      >
                        {inspectedRecord.entry.level}
                      </span>
                    </div>
                  </div>
                  <div className="p-2.5 bg-[#f8f9fb] border border-hairline rounded-[2px]">
                    <div className="text-[10px] uppercase tracking-wider text-slate-500">
                      {t('operations:workbench.recordInspector.fieldValidation')}
                    </div>
                    <div
                      className={`mt-0.5 font-mono font-semibold ${
                        inspectedRecord.entry.quarantined ? 'text-amber-800' : 'text-emerald-700'
                      }`}
                    >
                      {inspectedRecord.entry.quarantined
                        ? t('operations:workbench.recordInspector.quarantinedEnvelope', {
                            reason: inspectedRecord.entry.error_reason ?? 'schema_error',
                          })
                        : t('operations:workbench.recordInspector.validEnvelope')}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
                  <div className="p-2.5 bg-[#f8f9fb] border border-hairline rounded-[2px]">
                    <div className="text-[10px] uppercase tracking-wider text-slate-500">
                      {t('operations:workbench.quarantineTable.colId')}
                    </div>
                    <div className="mt-0.5 font-mono font-semibold text-ink break-all">
                      {inspectedRecord.record.quarantine_id}
                    </div>
                  </div>
                  <div className="p-2.5 bg-[#f8f9fb] border border-hairline rounded-[2px]">
                    <div className="text-[10px] uppercase tracking-wider text-slate-500">
                      {t('operations:workbench.quarantineTable.colReason')}
                    </div>
                    <div className="mt-0.5 font-mono font-semibold text-amber-800">
                      {inspectedRecord.record.error_reason}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Parsed Telemetry Channels */}
            {inspectedRecord.kind === 'log' && !inspectedRecord.entry.quarantined && (
              <div className="space-y-2">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  {t('operations:workbench.recordInspector.metricsHeading')}
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono">
                  <div className="p-2.5 bg-white border border-hairline rounded-[2px]">
                    <div className="text-[10px] font-sans text-slate-500">
                      {t('operations:workbench.recordInspector.metricTemp')}
                    </div>
                    <div className="mt-0.5 font-semibold text-ink tabular-nums">
                      {inspectedRecord.entry.temp_c !== null
                        ? `${inspectedRecord.entry.temp_c.toFixed(2)} °C`
                        : '--'}
                    </div>
                  </div>
                  <div className="p-2.5 bg-white border border-hairline rounded-[2px]">
                    <div className="text-[10px] font-sans text-slate-500">
                      {t('operations:workbench.recordInspector.metricVibration')}
                    </div>
                    <div className="mt-0.5 font-semibold text-ink tabular-nums">
                      {inspectedRecord.entry.vibration_mm_s !== null
                        ? `${inspectedRecord.entry.vibration_mm_s.toFixed(2)} mm/s`
                        : '--'}
                    </div>
                  </div>
                  <div className="p-2.5 bg-white border border-hairline rounded-[2px]">
                    <div className="text-[10px] font-sans text-slate-500">
                      {t('operations:workbench.recordInspector.metricCycle')}
                    </div>
                    <div className="mt-0.5 font-semibold text-ink tabular-nums">
                      {inspectedRecord.entry.cycle_ms !== null
                        ? `${inspectedRecord.entry.cycle_ms.toFixed(1)} ms`
                        : '--'}
                    </div>
                  </div>
                  <div className="p-2.5 bg-white border border-hairline rounded-[2px]">
                    <div className="text-[10px] font-sans text-slate-500 truncate">
                      {inspectedRecord.entry.primary_metric_name ??
                        t('operations:workbench.recordInspector.metricPrimary')}
                    </div>
                    <div className="mt-0.5 font-semibold text-brand tabular-nums">
                      {inspectedRecord.entry.primary_metric_value !== null
                        ? `${inspectedRecord.entry.primary_metric_value} ${
                            inspectedRecord.entry.primary_metric_unit ?? ''
                          }`
                        : '--'}
                    </div>
                  </div>
                  {typeof inspectedPayloadInfo.parsedObject?.metrics === 'object' &&
                  inspectedPayloadInfo.parsedObject.metrics !== null &&
                  !Array.isArray(inspectedPayloadInfo.parsedObject.metrics)
                    ? Object.entries(
                        inspectedPayloadInfo.parsedObject.metrics as Record<string, unknown>
                      ).map(([metricKey, metricVal]) => (
                        <div
                          key={metricKey}
                          className="p-2.5 bg-[#f8f9fb] border border-hairline rounded-[2px]"
                        >
                          <div className="text-[10px] text-slate-500 truncate">{metricKey}</div>
                          <div className="mt-0.5 font-semibold text-ink tabular-nums">
                            {String(metricVal)}
                          </div>
                        </div>
                      ))
                    : null}
                </div>
              </div>
            )}

            {/* Complete Un-truncated Structured JSON Payload */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 inline-flex items-center gap-1.5">
                  <Code2 className="w-3.5 h-3.5 text-brand" />
                  {inspectedPayloadInfo.isValidJson
                    ? t('operations:workbench.recordInspector.payloadHeading')
                    : t('operations:workbench.recordInspector.payloadRawHeading')}
                </h3>
                <span className="text-[11px] font-mono text-slate-500 tabular-nums">
                  {t('operations:workbench.recordInspector.payloadStats', {
                    bytes: inspectedPayloadInfo.byteLength,
                    lines: inspectedPayloadInfo.lineCount,
                  })}
                </span>
              </div>

              {!inspectedPayloadInfo.isValidJson && (
                <div className="px-3 py-2 bg-amber-50 border border-amber-300 rounded-[2px] text-xs text-amber-950 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                  <span>
                    {t('operations:workbench.recordInspector.parseErrorNotice', {
                      reason:
                        inspectedRecord.kind === 'log'
                          ? inspectedRecord.entry.error_reason ?? 'malformed_json'
                          : inspectedRecord.record.error_reason,
                    })}
                  </span>
                </div>
              )}

              <pre className="p-4 bg-chrome text-slate-100 font-mono text-xs leading-relaxed rounded-[2px] overflow-x-auto whitespace-pre-wrap break-words max-h-[380px] overflow-y-auto border border-chrome-border">
                {inspectedPayloadInfo.formattedText}
              </pre>
            </div>

            {/* Data Storage & REST Query Lineage */}
            <div className="p-3.5 bg-[#f8f9fb] border border-hairline rounded-[2px] space-y-1.5">
              <div className="text-[11px] font-semibold text-ink inline-flex items-center gap-1.5">
                <Database className="w-3.5 h-3.5 text-brand" />
                {t('operations:workbench.recordInspector.lineageHeading')}
              </div>
              <p className="text-xs text-slate-600 leading-relaxed">
                {t('operations:workbench.recordInspector.lineageBody')}
              </p>
            </div>
          </div>
        )}
      </SlideOverDrawer>
    </div>
  );
}
