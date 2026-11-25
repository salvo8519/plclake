import { useEffect, useMemo, useState } from 'react';
import { Download, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { LiveRunSnapshot, MachineDomain, MachineState } from '../types/pipeline';
import {
  ERP_INPUT_COMPACT_CLASS,
  ERP_SEGMENTED_GROUP_CLASS,
  ERP_TABLE_HEAD_ROW_CLASS,
} from '../theme/tokens';
import { DEFAULT_TABLE_PAGE_SIZE, paginateItems, TablePagination } from './ui';

interface FleetEvaluationSectionProps {
  liveRun: LiveRunSnapshot | null;
}

interface MachineRollup {
  machineId: string;
  lineId: string;
  machineType: string;
  domain: MachineDomain;
  latestState: MachineState | 'CORRUPT' | '--';
  latestLevel: string;
  windowsCount: number;
  anomalousWindows: number;
  leadFailWindows: number;
  totalSamples: number;
  primaryMetricName: string;
  primaryMetricUnit: string;
  primaryMeanAvg: number;
  primaryPeak: number;
  tempMeanAvg: number;
  tempPeak: number;
  faultSecTotal: number;
  missingHeartbeatsTotal: number;
  availabilityPct: number;
  baOutputEstimate: string;
}

export function FleetEvaluationSection({ liveRun }: FleetEvaluationSectionProps) {
  const { t } = useTranslation('operations');
  const [searchQuery, setSearchQuery] = useState('');
  const [lineFilter, setLineFilter] = useState<string>('ALL');
  const [currentPage, setCurrentPage] = useState(1);

  useEffect(() => {
    setSearchQuery('');
    setLineFilter('ALL');
    setCurrentPage(1);
  }, [liveRun?.runId]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, lineFilter]);

  const activeFeatures = useMemo(() => liveRun?.features ?? [], [liveRun]);

  const latestByMachine = useMemo(() => {
    const map = new Map<string, { state: MachineState | 'CORRUPT'; level: string }>();
    const logs = liveRun?.recentLogs ?? [];
    for (const entry of logs) {
      if (entry.machine_id && entry.machine_id !== '--' && !map.has(entry.machine_id)) {
        map.set(entry.machine_id, { state: entry.state, level: entry.level });
      }
    }
    return map;
  }, [liveRun]);

  const rollups = useMemo<MachineRollup[]>(() => {
    const grouped = new Map<
      string,
      {
        machineId: string;
        lineId: string;
        machineType: string;
        domain: MachineDomain;
        windowsCount: number;
        anomalousWindows: number;
        leadFailWindows: number;
        totalSamples: number;
        primaryMetricName: string;
        primaryMetricUnit: string;
        primarySum: number;
        primaryPeak: number;
        tempSum: number;
        tempPeak: number;
        faultSecTotal: number;
        missingHeartbeatsTotal: number;
      }
    >();

    for (const row of activeFeatures) {
      let acc = grouped.get(row.machine_id);
      if (!acc) {
        acc = {
          machineId: row.machine_id,
          lineId: row.line_id,
          machineType: row.machine_type,
          domain: row.domain,
          windowsCount: 0,
          anomalousWindows: 0,
          leadFailWindows: 0,
          totalSamples: 0,
          primaryMetricName: row.primary_metric_name,
          primaryMetricUnit: row.primary_metric_unit,
          primarySum: 0,
          primaryPeak: row.primary_metric_max,
          tempSum: 0,
          tempPeak: row.temp_max,
          faultSecTotal: 0,
          missingHeartbeatsTotal: 0,
        };
        grouped.set(row.machine_id, acc);
      }
      acc.windowsCount += 1;
      acc.anomalousWindows += row.is_anomalous_window === 1 ? 1 : 0;
      acc.leadFailWindows += row.will_fail_next_window === 1 ? 1 : 0;
      acc.totalSamples += row.sample_count;
      acc.primarySum += row.primary_metric_mean;
      if (row.primary_metric_max > acc.primaryPeak) acc.primaryPeak = row.primary_metric_max;
      acc.tempSum += row.temp_mean;
      if (row.temp_max > acc.tempPeak) acc.tempPeak = row.temp_max;
      acc.faultSecTotal += row.time_in_fault_sec;
      acc.missingHeartbeatsTotal += row.missing_heartbeat_count;
    }

    return Array.from(grouped.values())
      .map((item) => {
        const latest = latestByMachine.get(item.machineId);
        const avgPrimary = item.windowsCount > 0 ? item.primarySum / item.windowsCount : 0;
        const windowHours = (item.windowsCount * (liveRun?.config.windowMinutes ?? 5)) / 60;
        const totalWindowSec = Math.max(1, windowHours * 3600);
        const availabilityPct = Math.max(
          0,
          Math.min(100, ((totalWindowSec - item.faultSecTotal) / totalWindowSec) * 100)
        );
        let baOutputEstimate = `${item.totalSamples.toLocaleString()} cyc`;
        if (item.domain === 'power-generation') {
          baOutputEstimate = `${(avgPrimary * windowHours).toFixed(1)} kWh`;
        } else if (item.domain === 'gas-metering') {
          baOutputEstimate = `${(avgPrimary * windowHours).toFixed(1)} Nm3`;
        }
        return {
          machineId: item.machineId,
          lineId: item.lineId,
          machineType: item.machineType,
          domain: item.domain,
          latestState: latest?.state ?? ('--' as const),
          latestLevel: latest?.level ?? '--',
          windowsCount: item.windowsCount,
          anomalousWindows: item.anomalousWindows,
          leadFailWindows: item.leadFailWindows,
          totalSamples: item.totalSamples,
          primaryMetricName: item.primaryMetricName,
          primaryMetricUnit: item.primaryMetricUnit,
          primaryMeanAvg: avgPrimary,
          primaryPeak: item.primaryPeak,
          tempMeanAvg: item.windowsCount > 0 ? item.tempSum / item.windowsCount : 0,
          tempPeak: item.tempPeak,
          faultSecTotal: item.faultSecTotal,
          missingHeartbeatsTotal: item.missingHeartbeatsTotal,
          availabilityPct,
          baOutputEstimate,
        };
      })
      .sort((a, b) => a.machineId.localeCompare(b.machineId));
  }, [activeFeatures, latestByMachine, liveRun?.config.windowMinutes]);

  const availableLines = useMemo(() => {
    const lines = Array.from(new Set(rollups.map((r) => r.lineId))).sort();
    return ['ALL', ...lines];
  }, [rollups]);

  const filteredRollups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return rollups.filter((row) => {
      if (lineFilter !== 'ALL' && row.lineId !== lineFilter) return false;
      if (q) {
        return (
          row.machineId.toLowerCase().includes(q) ||
          row.lineId.toLowerCase().includes(q) ||
          row.machineType.toLowerCase().includes(q) ||
          row.domain.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [rollups, lineFilter, searchQuery]);

  const { pageItems: pagedRollups, safePage } = paginateItems(
    filteredRollups,
    currentPage,
    DEFAULT_TABLE_PAGE_SIZE
  );

  const fleetSummary = useMemo(() => {
    const anomalousMachines = rollups.filter((r) => r.anomalousWindows > 0).length;
    const totalLeadAlerts = rollups.reduce((sum, r) => sum + r.leadFailWindows, 0);
    const peakTemp = rollups.reduce((max, r) => (r.tempPeak > max ? r.tempPeak : max), 0);
    const domainCount = new Set(rollups.map((r) => r.domain)).size;
    return {
      machinesTracked: rollups.length,
      anomalousMachines,
      totalLeadAlerts,
      peakTemp,
      domainCount,
    };
  }, [rollups]);

  const handleExportCsv = () => {
    if (filteredRollups.length === 0) return;
    const headers = Object.keys(filteredRollups[0]);
    const rows = [
      headers.join(','),
      ...filteredRollups.map((r) =>
        headers.map((h) => JSON.stringify((r as unknown as Record<string, unknown>)[h] ?? '')).join(',')
      ),
    ];
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'machine_fleet_evaluation.csv';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      <section className="bg-white border border-hairline rounded-[2px] overflow-hidden">
        <div className="px-5 py-4 border-b border-hairline flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div>
            <h1 className="text-[15px] font-semibold tracking-tight text-ink">
              {t('fleet.title')}
            </h1>
            <p className="text-xs text-slate-600 mt-0.5">
              {t('fleet.subtitle')}
            </p>
          </div>

          <button
            type="button"
            onClick={handleExportCsv}
            disabled={filteredRollups.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-hairline-strong hover:bg-[#f4f6f9] disabled:opacity-50 rounded-[2px] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            {t('fleet.exportCsv')}
          </button>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-hairline">
          <div className="px-5 py-4">
            <div className="text-[11px] font-medium text-slate-500">{t('fleet.kpi.activeMachines')}</div>
            <div className="mt-1 text-xl font-semibold tracking-tight text-ink font-mono tabular-nums">
              {fleetSummary.machinesTracked}{' '}
              <span className="text-xs font-normal text-slate-500 font-sans">
                (
                {fleetSummary.domainCount === 1
                  ? t('fleet.kpi.domainSingular', { count: fleetSummary.domainCount })
                  : t('fleet.kpi.domainPlural', { count: fleetSummary.domainCount })}
                )
              </span>
            </div>
          </div>
          <div className="px-5 py-4">
            <div className="text-[11px] font-medium text-slate-500">{t('fleet.kpi.anomalousMachines')}</div>
            <div className="mt-1 text-xl font-semibold tracking-tight text-red-700 font-mono tabular-nums">
              {fleetSummary.anomalousMachines}
            </div>
          </div>
          <div className="px-5 py-4">
            <div className="text-[11px] font-medium text-slate-500">{t('fleet.kpi.leadFailureSignals')}</div>
            <div className="mt-1 text-xl font-semibold tracking-tight text-amber-700 font-mono tabular-nums">
              {fleetSummary.totalLeadAlerts}
            </div>
          </div>
          <div className="px-5 py-4">
            <div className="text-[11px] font-medium text-slate-500">{t('fleet.kpi.thermalPeak')}</div>
            <div className="mt-1 text-xl font-semibold tracking-tight text-ink font-mono tabular-nums">
              {fleetSummary.peakTemp.toFixed(1)} °C
            </div>
          </div>
        </div>
      </section>

      <section className="bg-white overflow-hidden">
        <div className="px-5 py-3 bg-white flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className={`${ERP_SEGMENTED_GROUP_CLASS} w-fit flex-wrap`}>
            {availableLines.map((line) => (
              <button
                key={line}
                type="button"
                onClick={() => setLineFilter(line)}
                className={`px-2.5 py-1.5 text-[11px] font-mono font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  lineFilter === line
                    ? 'bg-brand text-white'
                    : 'text-slate-600 hover:bg-[#f4f6f9] hover:text-ink'
                }`}
              >
                {line === 'ALL' ? t('fleet.allLines') : line}
              </button>
            ))}
          </div>

          <div className="relative w-full sm:w-64">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('fleet.searchPlaceholder')}
              aria-label={t('fleet.searchAria')}
              className={`${ERP_INPUT_COMPACT_CLASS} pl-8`}
            />
          </div>
        </div>

        <div className="erp-table-scroll">
          <table className="w-full min-w-[1180px] text-left border-collapse text-xs">
            <thead>
              <tr className={ERP_TABLE_HEAD_ROW_CLASS}>
                <th className="py-2.5 px-4">{t('fleet.table.colMachine')}</th>
                <th className="py-2.5 px-3">{t('fleet.table.colLineProfile')}</th>
                <th className="py-2.5 px-3">{t('fleet.table.colLatestState')}</th>
                <th className="py-2.5 px-3 text-right">{t('fleet.table.colSamples')}</th>
                <th className="py-2.5 px-3 text-right">{t('fleet.table.colWindows')}</th>
                <th className="py-2.5 px-3 text-right">{t('fleet.table.colAnomalous')}</th>
                <th className="py-2.5 px-3 text-right">{t('fleet.table.colLeadFail')}</th>
                <th className="py-2.5 px-3 text-right">{t('fleet.table.colPrimary')}</th>
                <th className="py-2.5 px-3 text-right">{t('fleet.table.colUptime')}</th>
                <th className="py-2.5 px-3 text-right">{t('fleet.table.colVolume')}</th>
                <th className="py-2.5 px-3 text-right">{t('fleet.table.colTemp')}</th>
                <th className="py-2.5 px-3 text-right">{t('fleet.table.colFaultSec')}</th>
                <th className="py-2.5 px-4 text-right">{t('fleet.table.colMissedBeats')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {filteredRollups.length === 0 ? (
                <tr>
                  <td colSpan={13} className="py-8 text-center text-slate-500">
                    {t('fleet.table.empty')}
                  </td>
                </tr>
              ) : (
                pagedRollups.map((row) => {
                  const anomalyPct =
                    row.windowsCount > 0
                      ? ((row.anomalousWindows / row.windowsCount) * 100).toFixed(0)
                      : '0';
                  return (
                    <tr key={row.machineId} className="hover:bg-[#f8f9fb] transition-colors">
                      <td className="py-2 px-4 font-mono font-semibold text-slate-900">
                        {row.machineId}
                      </td>
                      <td className="py-2 px-3 text-slate-600 font-mono">
                        {row.lineId} · {row.machineType}{' '}
                        <span className="text-slate-400">({row.domain})</span>
                      </td>
                      <td
                        className={`py-2 px-3 font-mono font-medium ${
                          row.latestState === 'FAULT'
                            ? 'text-red-700'
                            : row.latestState === 'DEGRADED'
                            ? 'text-amber-700'
                            : row.latestState === 'RUNNING'
                            ? 'text-emerald-700'
                            : 'text-slate-600'
                        }`}
                      >
                        {row.latestState}
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-800">
                        {row.totalSamples.toLocaleString()}
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-800">
                        {row.windowsCount}
                      </td>
                      <td
                        className={`py-2 px-3 text-right font-mono tabular-nums font-medium ${
                          row.anomalousWindows > 0 ? 'text-red-700' : 'text-emerald-700'
                        }`}
                      >
                        {row.anomalousWindows} ({anomalyPct}%)
                      </td>
                      <td
                        className={`py-2 px-3 text-right font-mono tabular-nums font-medium ${
                          row.leadFailWindows > 0 ? 'text-amber-700' : 'text-slate-700'
                        }`}
                      >
                        {row.leadFailWindows}
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-800 whitespace-nowrap">
                        {row.primaryMeanAvg.toFixed(1)} / {row.primaryPeak.toFixed(1)}{' '}
                        <span className="text-slate-500">{row.primaryMetricUnit}</span>
                      </td>
                      <td
                        className={`py-2 px-3 text-right font-mono tabular-nums font-medium ${
                          row.availabilityPct < 95 ? 'text-amber-700' : 'text-emerald-700'
                        }`}
                      >
                        {row.availabilityPct.toFixed(1)}%
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-900 whitespace-nowrap">
                        {row.baOutputEstimate}
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-800 whitespace-nowrap">
                        {row.tempMeanAvg.toFixed(1)} / {row.tempPeak.toFixed(1)} C
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-800">
                        {row.faultSecTotal.toFixed(1)}
                      </td>
                      <td className="py-2 px-4 text-right font-mono tabular-nums text-slate-800">
                        {row.missingHeartbeatsTotal}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <TablePagination
          currentPage={safePage}
          totalItems={filteredRollups.length}
          pageSize={DEFAULT_TABLE_PAGE_SIZE}
          maxVisiblePages={3}
          onPageChange={setCurrentPage}
          itemLabel={t('fleet.pagination.machines')}
          hideWhenSinglePage
        />
      </section>
    </div>
  );
}
