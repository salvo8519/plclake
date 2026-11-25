import { useEffect, useState, type FormEvent } from 'react';
import { CheckCircle2, RotateCcw, Save, Settings2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  JobConfig,
  MachineProfileMode,
  PlcCatalogListResponse,
} from '../types/pipeline';
import { ERP_INPUT_CLASS, ERP_INPUT_COMPACT_CLASS } from '../theme/tokens';

interface JobConfigSectionProps {
  jobConfig: JobConfig;
  plcCatalog: PlcCatalogListResponse | null;
  updatedAt: string | null;
  isSaving: boolean;
  onSaveJobConfig: (nextConfig: JobConfig) => Promise<boolean>;
}

const DEFAULT_JOB_CONFIG: JobConfig = {
  environment: 'production',
  executionMode: 'continuous-watch',
  watchIntervalSec: 30,
  windowMinutes: 5,
  watermarkLookbackMin: 15,
  horizonWindows: 1,
  rotateMaxLines: 1000,
  dedupStrategy: 'event_id_strict',
  malformedPolicy: 'quarantine_sha256',
  timestampMode: 'utc_iso8601_strict',
  machineProfileMode: 'mixed',
  machinesPerLine: 2,
  tempAnomalyThresholdC: 82,
  vibrationP95Threshold: 3.5,
  minValidSampleRatio: 0.75,
  datasetVersion: 'v1.0.0',
  storageTarget: 'garage-s3',
  parquetCompression: 'zstd',
  partitionLayout: 'domain/dt',
  featureMartSink: 'postgres-upsert',
  hotRetentionDays: 90,
  coldRetentionDays: 1095,
  coldStorageEndpoint: 'garage-s3-cold',
  lakehouseFormat: 'duckdb-parquet-compacted',
  compactionSchedule: 'daily-01utc',
  ingestTransport: 'local-segments',
  customMachineTopology: '',
  ignoredErrorCodes: 'E_SENSOR_CAL, E_MAINT_TEST',
};

export function JobConfigSection({
  jobConfig,
  plcCatalog,
  updatedAt,
  isSaving,
  onSaveJobConfig,
}: JobConfigSectionProps) {
  const { t } = useTranslation(['configuration', 'common']);
  const [draft, setDraft] = useState<JobConfig>(jobConfig);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    setDraft(jobConfig);
  }, [jobConfig]);

  const isDirty = JSON.stringify(draft) !== JSON.stringify(jobConfig);

  const updateField = <K extends keyof JobConfig>(key: K, value: JobConfig[K]) => {
    setJustSaved(false);
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const ok = await onSaveJobConfig(draft);
    if (ok) {
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2500);
    }
  };

  const handleReset = () => {
    setJustSaved(false);
    setDraft(DEFAULT_JOB_CONFIG);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <section className="bg-white border border-hairline rounded-[2px] overflow-hidden">
        <div className="px-5 py-4 border-b border-hairline flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <Settings2 className="w-4 h-4 text-brand mt-0.5 shrink-0" />
            <div>
              <h1 className="text-[15px] font-semibold tracking-tight text-ink">
                {t('configuration:jobConfig.title')}
              </h1>
              <p className="text-xs text-slate-600 mt-0.5">
                {t('configuration:jobConfig.subtitle')}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {justSaved && (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 mr-1">
                <CheckCircle2 className="w-3.5 h-3.5" />
                {t('configuration:jobConfig.savedBadge')}
              </span>
            )}

            <button
              type="button"
              onClick={handleReset}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-hairline-strong hover:bg-[#f4f6f9] rounded-[2px] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              {t('common:actions.reset')}
            </button>

            <button
              type="submit"
              disabled={isSaving}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-white bg-brand hover:bg-brand-hover disabled:opacity-50 rounded-[2px] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Save className="w-3.5 h-3.5" />
              {isSaving
                ? t('configuration:jobConfig.savingPolicy')
                : isDirty
                  ? t('configuration:jobConfig.savePolicy')
                  : t('common:actions.apply')}
            </button>
          </div>
        </div>

        <div className="px-5 py-2.5 bg-[#f8f9fb] border-b border-hairline flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
          <div className="font-mono tabular-nums">
            {t('configuration:jobConfig.activePolicy')}{' '}
            <span className="font-semibold text-ink">{draft.environment}</span> ·{' '}
            {draft.executionMode} ·{' '}
            {t('configuration:jobConfig.activePolicyMeta', {
              window: draft.windowMinutes,
              lookback: draft.watermarkLookbackMin,
              lines: draft.rotateMaxLines.toLocaleString(),
            })}
          </div>
          {updatedAt && (
            <div className="font-mono tabular-nums text-[11px] text-slate-500">
              {t('configuration:jobConfig.lastApplied', {
                timestamp: updatedAt.replace('T', ' ').slice(0, 19),
              })}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-hairline">
          {/* Group 1: Execution & Scheduling */}
          <div className="p-5 space-y-4">
            <div>
              <h2 className="text-[13px] font-semibold text-ink tracking-tight">
                {t('configuration:jobConfig.groups.g1Title')}
              </h2>
              <p className="text-[11px] text-slate-500 mt-0.5">
                {t('configuration:jobConfig.groups.g1Subtitle')}
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div>
                <label htmlFor="job-env" className="block text-[11px] font-medium text-slate-600 mb-1">
                  {t('configuration:jobConfig.fields.environment')}
                </label>
                <select
                  id="job-env"
                  value={draft.environment}
                  onChange={(e) =>
                    updateField('environment', e.target.value as JobConfig['environment'])
                  }
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                >
                  <option value="local">local</option>
                  <option value="staging">staging</option>
                  <option value="production">production</option>
                </select>
              </div>

              <div>
                <label htmlFor="job-exec-mode" className="block text-[11px] font-medium text-slate-600 mb-1">
                  {t('configuration:jobConfig.fields.executionMode')}
                </label>
                <select
                  id="job-exec-mode"
                  value={draft.executionMode}
                  onChange={(e) =>
                    updateField('executionMode', e.target.value as JobConfig['executionMode'])
                  }
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                >
                  <option value="continuous-watch">{t('configuration:jobConfig.fields.execContinuous')}</option>
                  <option value="one-shot-batch">{t('configuration:jobConfig.fields.execOneShot')}</option>
                </select>
              </div>

              <div>
                <label htmlFor="job-watch-interval" className="block text-[11px] font-medium text-slate-600 mb-1">
                  {t('configuration:jobConfig.fields.watchInterval')}
                </label>
                <select
                  id="job-watch-interval"
                  value={draft.watchIntervalSec}
                  onChange={(e) =>
                    updateField('watchIntervalSec', Number(e.target.value) as JobConfig['watchIntervalSec'])
                  }
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                >
                  <option value={10}>{t('configuration:jobConfig.fields.watch10')}</option>
                  <option value={30}>{t('configuration:jobConfig.fields.watch30')}</option>
                  <option value={60}>{t('configuration:jobConfig.fields.watch60')}</option>
                  <option value={300}>{t('configuration:jobConfig.fields.watch300')}</option>
                </select>
              </div>

              <div>
                <label htmlFor="job-window" className="block text-[11px] font-medium text-slate-600 mb-1">
                  {t('configuration:jobConfig.fields.windowMinutes')}
                </label>
                <select
                  id="job-window"
                  value={draft.windowMinutes}
                  onChange={(e) =>
                    updateField('windowMinutes', Number(e.target.value) as JobConfig['windowMinutes'])
                  }
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                >
                  <option value={1}>{t('configuration:jobConfig.fields.windowOption', { minutes: 1 })}</option>
                  <option value={5}>{t('configuration:jobConfig.fields.windowOption', { minutes: 5 })}</option>
                  <option value={15}>{t('configuration:jobConfig.fields.windowOption', { minutes: 15 })}</option>
                </select>
              </div>

              <div>
                <label htmlFor="job-lookback" className="block text-[11px] font-medium text-slate-600 mb-1">
                  {t('configuration:jobConfig.fields.watermarkLookback')}
                </label>
                <select
                  id="job-lookback"
                  value={draft.watermarkLookbackMin}
                  onChange={(e) =>
                    updateField(
                      'watermarkLookbackMin',
                      Number(e.target.value) as JobConfig['watermarkLookbackMin']
                    )
                  }
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                >
                  <option value={5}>{t('configuration:jobConfig.fields.lookback5')}</option>
                  <option value={15}>{t('configuration:jobConfig.fields.lookback15')}</option>
                  <option value={30}>{t('configuration:jobConfig.fields.lookback30')}</option>
                  <option value={60}>{t('configuration:jobConfig.fields.lookback60')}</option>
                </select>
              </div>

              <div>
                <label htmlFor="job-horizon" className="block text-[11px] font-medium text-slate-600 mb-1">
                  {t('configuration:jobConfig.fields.leadHorizon')}
                </label>
                <select
                  id="job-horizon"
                  value={draft.horizonWindows}
                  onChange={(e) =>
                    updateField('horizonWindows', Number(e.target.value) as JobConfig['horizonWindows'])
                  }
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                >
                  <option value={1}>{t('configuration:jobConfig.fields.horizon1')}</option>
                  <option value={2}>{t('configuration:jobConfig.fields.horizon2')}</option>
                  <option value={3}>{t('configuration:jobConfig.fields.horizon3')}</option>
                </select>
              </div>
            </div>
          </div>

          {/* Group 2: Ingestion & Data Hygiene */}
          <div className="p-5 space-y-4">
            <div>
              <h2 className="text-[13px] font-semibold text-ink tracking-tight">
                {t('configuration:jobConfig.groups.g2Title')}
              </h2>
              <p className="text-[11px] text-slate-500 mt-0.5">
                {t('configuration:jobConfig.groups.g2Subtitle')}
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div>
                <label htmlFor="job-rotate" className="block text-[11px] font-medium text-slate-600 mb-1">
                  {t('configuration:jobConfig.fields.rotateMaxLines')}
                </label>
                <select
                  id="job-rotate"
                  value={draft.rotateMaxLines}
                  onChange={(e) =>
                    updateField('rotateMaxLines', Number(e.target.value) as JobConfig['rotateMaxLines'])
                  }
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                >
                  <option value={250}>{t('configuration:jobConfig.fields.rotateOption', { lines: '250' })}</option>
                  <option value={500}>{t('configuration:jobConfig.fields.rotateOption', { lines: '500' })}</option>
                  <option value={1000}>{t('configuration:jobConfig.fields.rotateOption', { lines: '1,000' })}</option>
                  <option value={2000}>{t('configuration:jobConfig.fields.rotateOption', { lines: '2,000' })}</option>
                  <option value={5000}>{t('configuration:jobConfig.fields.rotateOption', { lines: '5,000' })}</option>
                </select>
              </div>

              <div>
                <label htmlFor="job-dedup" className="block text-[11px] font-medium text-slate-600 mb-1">
                  {t('configuration:jobConfig.fields.dedupStrategy')}
                </label>
                <select
                  id="job-dedup"
                  value={draft.dedupStrategy}
                  onChange={(e) =>
                    updateField('dedupStrategy', e.target.value as JobConfig['dedupStrategy'])
                  }
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                >
                  <option value="event_id_strict">{t('configuration:jobConfig.fields.dedupStrict')}</option>
                  <option value="event_id_plus_timestamp">{t('configuration:jobConfig.fields.dedupComposite')}</option>
                </select>
              </div>

              <div>
                <label htmlFor="job-malformed" className="block text-[11px] font-medium text-slate-600 mb-1">
                  {t('configuration:jobConfig.fields.malformedPolicy')}
                </label>
                <select
                  id="job-malformed"
                  value={draft.malformedPolicy}
                  onChange={(e) =>
                    updateField('malformedPolicy', e.target.value as JobConfig['malformedPolicy'])
                  }
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                >
                  <option value="quarantine_sha256">{t('configuration:jobConfig.fields.malformedQuarantine')}</option>
                  <option value="drop_and_count">{t('configuration:jobConfig.fields.malformedDrop')}</option>
                  <option value="halt_on_error">{t('configuration:jobConfig.fields.malformedHalt')}</option>
                </select>
              </div>

              <div>
                <label htmlFor="job-ts-mode" className="block text-[11px] font-medium text-slate-600 mb-1">
                  {t('configuration:jobConfig.fields.timestampMode')}
                </label>
                <select
                  id="job-ts-mode"
                  value={draft.timestampMode}
                  onChange={(e) =>
                    updateField('timestampMode', e.target.value as JobConfig['timestampMode'])
                  }
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                >
                  <option value="utc_iso8601_strict">{t('configuration:jobConfig.fields.tsStrict')}</option>
                  <option value="utc_coerced">{t('configuration:jobConfig.fields.tsCoerced')}</option>
                </select>
              </div>

              <div>
                <label htmlFor="job-profile" className="block text-[11px] font-medium text-slate-600 mb-1">
                  {t('configuration:jobConfig.fields.machineProfileMode')}
                </label>
                <select
                  id="job-profile"
                  value={draft.machineProfileMode}
                  onChange={(e) =>
                    updateField('machineProfileMode', e.target.value as MachineProfileMode)
                  }
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                >
                  <optgroup label={t('configuration:jobConfig.fields.optgroupFleetMix')}>
                    <option value="mixed">{t('configuration:jobConfig.fields.mixMultiDomain')}</option>
                    <option value="manufacturing">{t('configuration:jobConfig.fields.mixManufacturing')}</option>
                    <option value="gas-metering">{t('configuration:jobConfig.fields.mixGas')}</option>
                    <option value="power-generation">{t('configuration:jobConfig.fields.mixPower')}</option>
                  </optgroup>
                  <optgroup label={t('configuration:jobConfig.fields.optgroupCatalog')}>
                    {(plcCatalog?.profiles ?? [
                      { typeId: 'plc-controller', label: 'PLC Line Controller (Generic)', primaryUnit: 'ms' },
                      { typeId: 'siemens-s7-1500', label: 'Siemens SIMATIC S7-1500', primaryUnit: 'ms' },
                      { typeId: 'rockwell-controllogix', label: 'Rockwell ControlLogix 5580', primaryUnit: 'ms' },
                      { typeId: 'cnc-mill', label: 'CNC Precision Mill', primaryUnit: 'mm/s' },
                      { typeId: 'gas-flow-meter', label: 'Methane Flow Meter', primaryUnit: 'Nm3/h' },
                      { typeId: 'power-meter', label: 'Substation Power Meter', primaryUnit: 'kW' },
                    ]).map((p) => (
                      <option key={p.typeId} value={p.typeId}>
                        {p.typeId} — {p.label} ({p.primaryUnit})
                      </option>
                    ))}
                  </optgroup>
                </select>
              </div>

              <div>
                <label htmlFor="job-per-line" className="block text-[11px] font-medium text-slate-600 mb-1">
                  {t('configuration:jobConfig.fields.machinesPerLine')}
                </label>
                <select
                  id="job-per-line"
                  value={draft.machinesPerLine}
                  onChange={(e) =>
                    updateField('machinesPerLine', Number(e.target.value) as JobConfig['machinesPerLine'])
                  }
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                >
                  <option value={1}>{t('configuration:jobConfig.fields.perLine1')}</option>
                  <option value={2}>{t('configuration:jobConfig.fields.perLineN', { count: 2 })}</option>
                  <option value={4}>{t('configuration:jobConfig.fields.perLineN', { count: 4 })}</option>
                  <option value={8}>{t('configuration:jobConfig.fields.perLineN', { count: 8 })}</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-hairline border-t border-hairline">
          {/* Group 3: Anomaly & SLA Thresholds */}
          <div className="p-5 space-y-4">
            <div>
              <h2 className="text-[13px] font-semibold text-ink tracking-tight">
                {t('configuration:jobConfig.groups.g3Title')}
              </h2>
              <p className="text-[11px] text-slate-500 mt-0.5">
                {t('configuration:jobConfig.groups.g3Subtitle')}
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div>
                <label htmlFor="job-temp-thresh" className="block text-[11px] font-medium text-slate-600 mb-1">
                  {t('configuration:jobConfig.fields.tempAnomalyCutoff')}
                </label>
                <select
                  id="job-temp-thresh"
                  value={draft.tempAnomalyThresholdC}
                  onChange={(e) =>
                    updateField(
                      'tempAnomalyThresholdC',
                      Number(e.target.value) as JobConfig['tempAnomalyThresholdC']
                    )
                  }
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                >
                  <option value={75}>{t('configuration:jobConfig.fields.temp75')}</option>
                  <option value={82}>{t('configuration:jobConfig.fields.temp82')}</option>
                  <option value={90}>{t('configuration:jobConfig.fields.temp90')}</option>
                  <option value={95}>{t('configuration:jobConfig.fields.temp95')}</option>
                </select>
              </div>

              <div>
                <label htmlFor="job-vib-thresh" className="block text-[11px] font-medium text-slate-600 mb-1">
                  {t('configuration:jobConfig.fields.vibCutoff')}
                </label>
                <select
                  id="job-vib-thresh"
                  value={draft.vibrationP95Threshold}
                  onChange={(e) =>
                    updateField(
                      'vibrationP95Threshold',
                      Number(e.target.value) as JobConfig['vibrationP95Threshold']
                    )
                  }
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                >
                  <option value={2.5}>{t('configuration:jobConfig.fields.vib25')}</option>
                  <option value={3.5}>{t('configuration:jobConfig.fields.vib35')}</option>
                  <option value={4.5}>{t('configuration:jobConfig.fields.vib45')}</option>
                  <option value={6.0}>{t('configuration:jobConfig.fields.vib60')}</option>
                </select>
              </div>

              <div>
                <label htmlFor="job-min-ratio" className="block text-[11px] font-medium text-slate-600 mb-1">
                  {t('configuration:jobConfig.fields.minValidRatio')}
                </label>
                <select
                  id="job-min-ratio"
                  value={draft.minValidSampleRatio}
                  onChange={(e) =>
                    updateField(
                      'minValidSampleRatio',
                      Number(e.target.value) as JobConfig['minValidSampleRatio']
                    )
                  }
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                >
                  <option value={0.5}>{t('configuration:jobConfig.fields.ratioOption', { ratio: '0.50', pct: 50 })}</option>
                  <option value={0.75}>{t('configuration:jobConfig.fields.ratioOption', { ratio: '0.75', pct: 75 })}</option>
                  <option value={0.85}>{t('configuration:jobConfig.fields.ratioOption', { ratio: '0.85', pct: 85 })}</option>
                  <option value={0.95}>{t('configuration:jobConfig.fields.ratioOption', { ratio: '0.95', pct: 95 })}</option>
                </select>
              </div>

              <div>
                <label htmlFor="job-version" className="block text-[11px] font-medium text-slate-600 mb-1">
                  {t('configuration:jobConfig.fields.datasetVersion')}
                </label>
                <select
                  id="job-version"
                  value={draft.datasetVersion}
                  onChange={(e) =>
                    updateField('datasetVersion', e.target.value as JobConfig['datasetVersion'])
                  }
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                >
                  <option value="v1.0.0">{t('configuration:jobConfig.fields.versionProd')}</option>
                  <option value="v1.1.0">v1.1.0</option>
                  <option value="v2.0.0-rc1">v2.0.0-rc1</option>
                </select>
              </div>
            </div>
          </div>

          {/* Group 4: Storage, Hot/Cold Tiering & Lakehouse Sinks */}
          <div className="p-5 space-y-4">
            <div>
              <h2 className="text-[13px] font-semibold text-ink tracking-tight">
                {t('configuration:jobConfig.groups.g4Title')}
              </h2>
              <p className="text-[11px] text-slate-500 mt-0.5">
                {t('configuration:jobConfig.groups.g4Subtitle')}
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div>
                <label htmlFor="job-storage" className="block text-[11px] font-medium text-slate-600 mb-1">
                  {t('configuration:jobConfig.fields.primaryStorage')}
                </label>
                <select
                  id="job-storage"
                  value={draft.storageTarget}
                  onChange={(e) =>
                    updateField('storageTarget', e.target.value as JobConfig['storageTarget'])
                  }
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                >
                  <option value="garage-s3">{t('configuration:jobConfig.fields.storageGarage')}</option>
                  <option value="rustfs-s3">{t('configuration:jobConfig.fields.storageRustfs')}</option>
                  <option value="local-fs">{t('configuration:jobConfig.fields.storageLocal')}</option>
                </select>
              </div>

              <div>
                <label htmlFor="job-cold-storage" className="block text-[11px] font-medium text-slate-600 mb-1">
                  {t('configuration:jobConfig.fields.coldArchive')}
                </label>
                <select
                  id="job-cold-storage"
                  value={draft.coldStorageEndpoint}
                  onChange={(e) =>
                    updateField(
                      'coldStorageEndpoint',
                      e.target.value as JobConfig['coldStorageEndpoint']
                    )
                  }
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                >
                  <option value="garage-s3-cold">{t('configuration:jobConfig.fields.coldGarage')}</option>
                  <option value="s3-glacier-compatible">{t('configuration:jobConfig.fields.coldGlacier')}</option>
                  <option value="nas-cold-archive">{t('configuration:jobConfig.fields.coldNas')}</option>
                </select>
              </div>

              <div>
                <label htmlFor="job-hot-ret" className="block text-[11px] font-medium text-slate-600 mb-1">
                  {t('configuration:jobConfig.fields.hotRetention')}
                </label>
                <select
                  id="job-hot-ret"
                  value={draft.hotRetentionDays}
                  onChange={(e) =>
                    updateField(
                      'hotRetentionDays',
                      Number(e.target.value) as JobConfig['hotRetentionDays']
                    )
                  }
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                >
                  <option value={7}>{t('configuration:jobConfig.fields.hot7')}</option>
                  <option value={30}>{t('configuration:jobConfig.fields.hot30')}</option>
                  <option value={90}>{t('configuration:jobConfig.fields.hot90')}</option>
                  <option value={180}>{t('configuration:jobConfig.fields.hot180')}</option>
                </select>
              </div>

              <div>
                <label htmlFor="job-cold-ret" className="block text-[11px] font-medium text-slate-600 mb-1">
                  {t('configuration:jobConfig.fields.coldRetention')}
                </label>
                <select
                  id="job-cold-ret"
                  value={draft.coldRetentionDays}
                  onChange={(e) =>
                    updateField(
                      'coldRetentionDays',
                      Number(e.target.value) as JobConfig['coldRetentionDays']
                    )
                  }
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                >
                  <option value={180}>{t('configuration:jobConfig.fields.cold180')}</option>
                  <option value={365}>{t('configuration:jobConfig.fields.cold365')}</option>
                  <option value={1095}>{t('configuration:jobConfig.fields.cold1095')}</option>
                  <option value={1825}>{t('configuration:jobConfig.fields.cold1825')}</option>
                </select>
              </div>

              <div>
                <label htmlFor="job-lakehouse" className="block text-[11px] font-medium text-slate-600 mb-1">
                  {t('configuration:jobConfig.fields.lakehouseFormat')}
                </label>
                <select
                  id="job-lakehouse"
                  value={draft.lakehouseFormat}
                  onChange={(e) =>
                    updateField('lakehouseFormat', e.target.value as JobConfig['lakehouseFormat'])
                  }
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                >
                  <option value="duckdb-parquet-compacted">{t('configuration:jobConfig.fields.formatDuckdb')}</option>
                  <option value="hive-parquet-append">{t('configuration:jobConfig.fields.formatHive')}</option>
                </select>
              </div>

              <div>
                <label htmlFor="job-compaction" className="block text-[11px] font-medium text-slate-600 mb-1">
                  {t('configuration:jobConfig.fields.compactionSchedule')}
                </label>
                <select
                  id="job-compaction"
                  value={draft.compactionSchedule}
                  onChange={(e) =>
                    updateField(
                      'compactionSchedule',
                      e.target.value as JobConfig['compactionSchedule']
                    )
                  }
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                >
                  <option value="hourly">{t('configuration:jobConfig.fields.compactionHourly')}</option>
                  <option value="daily-01utc">{t('configuration:jobConfig.fields.compactionDaily')}</option>
                  <option value="weekly-sun">{t('configuration:jobConfig.fields.compactionWeekly')}</option>
                </select>
              </div>

              <div>
                <label htmlFor="job-partition" className="block text-[11px] font-medium text-slate-600 mb-1">
                  {t('configuration:jobConfig.fields.partitionLayout')}
                </label>
                <select
                  id="job-partition"
                  value={draft.partitionLayout}
                  onChange={(e) =>
                    updateField('partitionLayout', e.target.value as JobConfig['partitionLayout'])
                  }
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                >
                  <option value="domain/dt">{t('configuration:jobConfig.fields.partitionDomainDt')}</option>
                  <option value="dt/machine_id">dt / machine_id</option>
                  <option value="dt/line_id/machine_id">dt / line_id / machine_id</option>
                  <option value="dt/hour/machine_id">dt / hour / machine_id</option>
                </select>
              </div>

              <div>
                <label htmlFor="job-compression" className="block text-[11px] font-medium text-slate-600 mb-1">
                  {t('configuration:jobConfig.fields.compressionAndTransport')}
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <select
                    id="job-compression"
                    aria-label={t('configuration:jobConfig.fields.compressionAria')}
                    value={draft.parquetCompression}
                    onChange={(e) =>
                      updateField('parquetCompression', e.target.value as JobConfig['parquetCompression'])
                    }
                    className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                  >
                    <option value="zstd">ZSTD</option>
                    <option value="snappy">Snappy</option>
                    <option value="gzip">GZIP</option>
                  </select>
                  <select
                    id="job-transport"
                    aria-label={t('configuration:jobConfig.fields.transportAria')}
                    value={draft.ingestTransport}
                    onChange={(e) =>
                      updateField('ingestTransport', e.target.value as JobConfig['ingestTransport'])
                    }
                    className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                  >
                    <option value="local-segments">{t('configuration:jobConfig.fields.transportSegments')}</option>
                    <option value="http-batch-ingest">{t('configuration:jobConfig.fields.transportHttp')}</option>
                  </select>
                </div>
              </div>

              <div className="sm:col-span-2">
                <label htmlFor="job-mart-sink" className="block text-[11px] font-medium text-slate-600 mb-1">
                  {t('configuration:jobConfig.fields.featureMartSink')}
                </label>
                <select
                  id="job-mart-sink"
                  value={draft.featureMartSink}
                  onChange={(e) =>
                    updateField('featureMartSink', e.target.value as JobConfig['featureMartSink'])
                  }
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                >
                  <option value="postgres-upsert">{t('configuration:jobConfig.fields.sinkPostgres')}</option>
                  <option value="parquet-only">{t('configuration:jobConfig.fields.sinkParquetOnly')}</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        {/* Group 5: Custom Freeform Overrides (Textareas ONLY where choices cannot be enumerated) */}
        <div className="p-5 border-t border-hairline bg-[#f8f9fb] space-y-3">
          <div>
            <h2 className="text-[13px] font-semibold text-ink tracking-tight">
              {t('configuration:jobConfig.groups.g5Title')}
            </h2>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {t('configuration:jobConfig.groups.g5Subtitle')}
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <label htmlFor="job-custom-topology" className="block text-[11px] font-medium text-slate-600 mb-1">
                {t('configuration:jobConfig.fields.customTopology')}
              </label>
              <textarea
                id="job-custom-topology"
                rows={3}
                value={draft.customMachineTopology}
                onChange={(e) => updateField('customMachineTopology', e.target.value)}
                placeholder="M-01:line-01:gas-flow-meter, M-02:line-01:methane-compressor, M-03:line-02:power-meter"
                className={`${ERP_INPUT_CLASS} font-mono`}
              />
            </div>

            <div>
              <label htmlFor="job-ignored-errors" className="block text-[11px] font-medium text-slate-600 mb-1">
                {t('configuration:jobConfig.fields.ignoredErrors')}
              </label>
              <textarea
                id="job-ignored-errors"
                rows={3}
                value={draft.ignoredErrorCodes}
                onChange={(e) => updateField('ignoredErrorCodes', e.target.value)}
                placeholder="E_SENSOR_CAL, E_MAINT_TEST"
                className={`${ERP_INPUT_CLASS} font-mono`}
              />
            </div>
          </div>
        </div>
      </section>
    </form>
  );
}
