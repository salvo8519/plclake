import { useCallback, useEffect, useState } from 'react';
import { Download, FileText, RefreshCw, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AuditLogEntry } from '../types/pipeline';
import { ERP_INPUT_COMPACT_CLASS, ERP_TABLE_HEAD_ROW_CLASS } from '../theme/tokens';
import { apiFetch } from '../utils/apiAuth';
import { formatUtcTimestamp } from '../utils/formatters';
import { Button, HIGH_VOLUME_PAGE_SIZE, paginateItems, SectionCard, SectionHeader, TablePagination } from './ui';

interface AuditLogSectionProps {
  initialActionFilter?: string;
}

export function AuditLogSection({ initialActionFilter = '' }: AuditLogSectionProps) {
  const { t } = useTranslation('administration');
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [actorFilter, setActorFilter] = useState('');
  const [actionFilter, setActionFilter] = useState(initialActionFilter);
  const [statusFilter, setStatusFilter] = useState<'' | 'ok' | 'denied' | 'error'>('');
  const [limit, setLimit] = useState<number>(100);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(HIGH_VOLUME_PAGE_SIZE);

  useEffect(() => {
    if (initialActionFilter) {
      setActionFilter(initialActionFilter);
    }
  }, [initialActionFilter]);

  const loadLogs = useCallback(async () => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('limit', String(limit));
      if (actorFilter.trim()) params.set('actor', actorFilter.trim());
      if (actionFilter.trim()) params.set('action', actionFilter.trim());
      if (statusFilter) params.set('status', statusFilter);

      const resp = await apiFetch(`/api/v1/audit/logs?${params.toString()}`);
      if (resp.ok) {
        const data = (await resp.json()) as { logs: AuditLogEntry[] };
        setLogs(data.logs ?? []);
      }
    } finally {
      setIsLoading(false);
    }
  }, [actorFilter, actionFilter, statusFilter, limit]);

  useEffect(() => {
    setCurrentPage(1);
    void loadLogs();
  }, [loadLogs]);

  const { pageItems: pagedLogs, safePage } = paginateItems(logs, currentPage, pageSize);

  const handleDownloadCsv = async () => {
    const params = new URLSearchParams();
    params.set('limit', '500');
    params.set('format', 'csv');
    if (actorFilter.trim()) params.set('actor', actorFilter.trim());
    if (actionFilter.trim()) params.set('action', actionFilter.trim());
    if (statusFilter) params.set('status', statusFilter);

    const resp = await apiFetch(`/api/v1/audit/logs?${params.toString()}`);
    if (!resp.ok) return;
    const csvText = await resp.text();
    const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit_log_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      <SectionCard borderless>
        <SectionHeader
          as="h1"
          icon={<FileText className="w-4 h-4" />}
          title={t('audit.title')}
          subtitle={t('audit.subtitle')}
          actions={
            <>
              <Button variant="secondary" size="sm" onClick={() => void loadLogs()}>
                <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
                {t('audit.refresh')}
              </Button>
              <Button variant="primary" size="sm" onClick={() => void handleDownloadCsv()}>
                <Download className="w-3.5 h-3.5" />
                {t('audit.exportCsv')}
              </Button>
            </>
          }
        />

        {/* Filter Bar */}
        <div className="px-5 py-3 bg-white grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={actorFilter}
              onChange={(e) => setActorFilter(e.target.value)}
              placeholder={t('audit.filters.actorPlaceholder')}
              aria-label={t('audit.filters.actorAria')}
              className={`${ERP_INPUT_COMPACT_CLASS} pl-8`}
            />
          </div>

          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              placeholder={t('audit.filters.actionPlaceholder')}
              aria-label={t('audit.filters.actionAria')}
              className={`${ERP_INPUT_COMPACT_CLASS} pl-8`}
            />
          </div>

          <div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as '' | 'ok' | 'denied' | 'error')}
              aria-label={t('audit.filters.outcomeAria')}
              className={ERP_INPUT_COMPACT_CLASS}
            >
              <option value="">{t('audit.filters.outcomeAll')}</option>
              <option value="ok">{t('audit.filters.outcomeOk')}</option>
              <option value="denied">{t('audit.filters.outcomeDenied')}</option>
              <option value="error">{t('audit.filters.outcomeError')}</option>
            </select>
          </div>

          <div>
            <select
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              aria-label={t('audit.filters.limitAria')}
              className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
            >
              <option value={50}>{t('audit.filters.limitOption', { count: 50 })}</option>
              <option value={100}>{t('audit.filters.limitOption', { count: 100 })}</option>
              <option value={250}>{t('audit.filters.limitOption', { count: 250 })}</option>
              <option value={500}>{t('audit.filters.limitOption', { count: 500 })}</option>
            </select>
          </div>

          <div className="flex items-center justify-end text-xs font-mono text-slate-600 tabular-nums">
            {t('audit.filters.showingEvents', { count: logs.length })}
          </div>
        </div>

        {/* Audit Table */}
        <div className="erp-table-scroll max-h-[600px] overflow-y-auto">
          <table className="w-full min-w-[860px] text-left border-collapse text-xs">
            <thead className="sticky top-0 z-10">
              <tr className={ERP_TABLE_HEAD_ROW_CLASS}>
                <th className="py-2.5 px-5">{t('audit.table.colTimestamp')}</th>
                <th className="py-2.5 px-3">{t('audit.table.colActor')}</th>
                <th className="py-2.5 px-3">{t('audit.table.colAction')}</th>
                <th className="py-2.5 px-3">{t('audit.table.colResource')}</th>
                <th className="py-2.5 px-3">{t('audit.table.colOutcome')}</th>
                <th className="py-2.5 px-5 text-right">{t('audit.table.colRequestId')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-slate-500">
                    {isLoading ? t('audit.table.loading') : t('audit.table.empty')}
                  </td>
                </tr>
              ) : (
                pagedLogs.map((entry) => (
                  <tr key={entry.id} className="hover:bg-[#f8f9fb] transition-colors">
                    <td className="py-2.5 px-5 font-mono text-[11px] text-slate-600 tabular-nums whitespace-nowrap">
                      {formatUtcTimestamp(entry.timestamp)}
                    </td>
                    <td className="py-2.5 px-3 font-mono whitespace-nowrap">
                      <span className="text-ink font-medium">{entry.actor}</span>
                      <span className="text-slate-500 ml-1.5">({entry.actorRole})</span>
                    </td>
                    <td className="py-2.5 px-3 font-mono text-slate-800 whitespace-nowrap">
                      {entry.action}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[11px] text-slate-600 max-w-xs truncate">
                      {entry.resource}
                    </td>
                    <td className="py-2.5 px-3 whitespace-nowrap">
                      <span
                        className={`font-mono text-[11px] font-semibold uppercase ${
                          entry.status === 'ok'
                            ? 'text-emerald-700'
                            : entry.status === 'denied'
                            ? 'text-amber-700'
                            : 'text-red-700'
                        }`}
                      >
                        {entry.status}
                      </span>
                    </td>
                    <td className="py-2.5 px-5 text-right font-mono text-[11px] text-slate-500 whitespace-nowrap">
                      {entry.requestId.slice(0, 12)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {logs.length > 0 && (
          <TablePagination
            currentPage={safePage}
            totalItems={logs.length}
            pageSize={pageSize}
            maxVisiblePages={3}
            onPageChange={setCurrentPage}
            onPageSizeChange={setPageSize}
            itemLabel={t('audit.pagination.events')}
          />
        )}
      </SectionCard>
    </div>
  );
}
