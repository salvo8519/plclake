import { useMemo, useState } from 'react';
import { Check, Copy, Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { LiveLogFeedEntry, LiveRunSnapshot } from '../types/pipeline';

interface LogStreamViewerProps {
  liveRun: LiveRunSnapshot | null;
  onSelectEntry?: (entry: LiveLogFeedEntry) => void;
}

interface DisplayLogLine {
  key: string;
  seqLabel: string;
  level: LiveLogFeedEntry['level'];
  machineId: string;
  machineType: string;
  primaryReading: string;
  raw: string;
  entry: LiveLogFeedEntry;
}

export function LogStreamViewer({ liveRun, onSelectEntry }: LogStreamViewerProps) {
  const { t } = useTranslation('operations');
  const [copied, setCopied] = useState(false);

  const lastTenLines: DisplayLogLine[] = useMemo(() => {
    if (!liveRun || liveRun.recentLogs.length === 0) return [];
    return liveRun.recentLogs
      .slice(0, 10)
      .reverse()
      .map((entry) => ({
        key: `live-${entry.seq}-${entry.timestamp}`,
        seqLabel: `#${String(entry.seq).padStart(5, '0')}`,
        level: entry.level,
        machineId: entry.machine_id,
        machineType: entry.machine_type,
        primaryReading:
          entry.primary_metric_value !== null
            ? `${entry.primary_metric_value} ${entry.primary_metric_unit ?? ''}`.trim()
            : '--',
        raw: entry.raw,
        entry,
      }));
  }, [liveRun]);

  const handleCopy = async () => {
    if (lastTenLines.length === 0) return;
    try {
      await navigator.clipboard.writeText(lastTenLines.map((l) => l.raw).join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard API unavailable
    }
  };

  const status = liveRun?.status;
  const isProducing = status === 'running';

  return (
    <section
      aria-label={t('logStream.ariaLabel')}
      className="bg-white border border-hairline rounded-[2px] overflow-hidden"
    >
      <div className="px-5 py-2.5 border-b border-hairline bg-[#f8f9fb] flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <Terminal className="w-4 h-4 text-brand shrink-0" />
          <h2 className="text-xs font-semibold text-ink whitespace-nowrap">
            {t('logStream.title')}
          </h2>
          <span className="text-xs text-slate-500 whitespace-nowrap">
            · {t('logStream.subtitle')}
          </span>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-2 text-xs font-mono">
            {isProducing && (
              <span
                aria-hidden="true"
                className="w-2 h-2 rounded-full bg-emerald-600 animate-pulse motion-reduce:animate-none shrink-0"
              />
            )}
            <span
              className={
                isProducing
                  ? 'font-semibold text-emerald-700'
                  : status === 'paused'
                  ? 'font-semibold text-amber-700'
                  : status === 'completed'
                  ? 'font-semibold text-slate-800'
                  : 'text-slate-600'
              }
            >
              {isProducing
                ? t('logStream.producing', {
                    rate: liveRun?.effectiveRatePerSec ?? 0,
                    count: liveRun?.totalCallsEmitted.toLocaleString() ?? 0,
                  })
                : status === 'paused'
                ? t('logStream.paused', {
                    count: liveRun?.totalCallsEmitted.toLocaleString() ?? 0,
                  })
                : status === 'completed'
                ? t('logStream.completed', {
                    count: liveRun?.totalCallsEmitted.toLocaleString() ?? 0,
                  })
                : liveRun
                ? t('logStream.stopped', {
                    count: liveRun.totalCallsEmitted.toLocaleString(),
                  })
                : t('logStream.idle')}
            </span>
          </div>

          <button
            type="button"
            onClick={handleCopy}
            disabled={lastTenLines.length === 0}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-slate-700 bg-white border border-hairline-strong hover:bg-slate-100 disabled:opacity-40 rounded-[2px] whitespace-nowrap shrink-0 cursor-pointer"
          >
            {copied ? (
              <>
                <Check className="w-3 h-3 text-emerald-700" />
                <span>{t('logStream.copied')}</span>
              </>
            ) : (
              <>
                <Copy className="w-3 h-3" />
                <span>{t('logStream.copyTail')}</span>
              </>
            )}
          </button>
        </div>
      </div>

      <div className="bg-chrome text-slate-200 px-5 py-3 font-mono text-xs leading-6 overflow-x-auto">
        {lastTenLines.length === 0 ? (
          <div className="py-4 text-center text-slate-400">
            {t('logStream.empty')}
          </div>
        ) : (
          <div className="divide-y divide-chrome-border">
            {lastTenLines.map((line) => {
              const levelColor =
                line.level === 'ERROR'
                  ? 'text-red-400'
                  : line.level === 'WARN' || line.level === 'QUARANTINE'
                  ? 'text-amber-400'
                  : 'text-emerald-400';

              return (
                <button
                  key={line.key}
                  type="button"
                  onClick={() => onSelectEntry?.(line.entry)}
                  title={onSelectEntry ? t('logStream.clickLineHint') : undefined}
                  className={`w-full text-left py-1 px-1.5 -mx-1.5 flex items-center gap-3 whitespace-nowrap rounded-[2px] transition-colors ${
                    onSelectEntry ? 'hover:bg-white/10 cursor-pointer' : ''
                  }`}
                >
                  <span className="text-slate-500 tabular-nums select-none shrink-0">
                    {line.seqLabel}
                  </span>
                  <span className={`font-semibold w-24 shrink-0 ${levelColor}`}>
                    {line.level}
                  </span>
                  <span className="text-sky-300 w-12 shrink-0">{line.machineId}</span>
                  <span className="text-slate-400 w-36 truncate shrink-0">{line.machineType}</span>
                  <span className="text-amber-200 w-28 text-right tabular-nums shrink-0">
                    {line.primaryReading}
                  </span>
                  <span className="text-slate-200 truncate">{line.raw}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
