import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Mail,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Trash2,
  XCircle,
} from 'lucide-react';
import type {
  MailpitMessageDetail,
  MailpitMessageDetailResponse,
  MailpitMessagesResponse,
  MailpitStatusResponse,
  SmtpChannelConfig,
  SmtpDiagnosticSendResult,
  SmtpVerifyResult,
} from '../types/pipeline';
import { apiFetch } from '../utils/apiAuth';
import { formatBytes } from '../utils/formatters';
import {
  ERP_INPUT_COMPACT_CLASS,
  ERP_SEGMENTED_GROUP_CLASS,
  ERP_TABLE_HEAD_ROW_CLASS,
} from '../theme/tokens';
import { DEFAULT_TABLE_PAGE_SIZE, paginateItems, TablePagination } from './ui';

const MAILPIT_DOCKER_CMD = 'docker compose -f docker-compose.mailpit.yml up -d';

interface SmtpDiagnosticsPanelProps {
  smtpConfig: SmtpChannelConfig;
  onSyncSmtpBeforeAction: () => Promise<boolean>;
  onNavigateToConfig: () => void;
}

export function SmtpDiagnosticsPanel({
  smtpConfig,
  onSyncSmtpBeforeAction,
  onNavigateToConfig,
}: SmtpDiagnosticsPanelProps) {
  const { t } = useTranslation('configuration');
  // Handshake verification state
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<SmtpVerifyResult | null>(null);

  // Test email composer state
  const [testRecipient, setTestRecipient] = useState(smtpConfig.recipients.join(', '));
  const [testSubject, setTestSubject] = useState('[Industrial Telemetry] SMTP Diagnostic Test');
  const [testBody, setTestBody] = useState(
    'Diagnostic verification email from Industrial Telemetry Platform.\nVerify delivery, sender identity, and Mailpit capture.'
  );
  const [isSending, setIsSending] = useState(false);
  const [lastSendResult, setLastSendResult] = useState<SmtpDiagnosticSendResult | null>(null);

  // Mailpit API state
  const [apiBaseUrl, setApiBaseUrl] = useState(smtpConfig.mailpitUiUrl || 'http://localhost:8025');
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoadingStatus, setIsLoadingStatus] = useState(false);
  const [mailpitStatus, setMailpitStatus] = useState<MailpitStatusResponse | null>(null);
  const [autoPollStatus, setAutoPollStatus] = useState(false);
  const [isLoadingInbox, setIsLoadingInbox] = useState(false);
  const [isClearingInbox, setIsClearingInbox] = useState(false);
  const [inbox, setInbox] = useState<MailpitMessagesResponse | null>(null);
  const [inboxPage, setInboxPage] = useState(1);

  // Selected Mailpit message inspector state
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [selectedDetail, setSelectedDetail] = useState<MailpitMessageDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<'text' | 'html' | 'headers'>('text');
  const [copiedCmd, setCopiedCmd] = useState(false);

  useEffect(() => {
    if (!testRecipient.trim() && smtpConfig.recipients.length > 0) {
      setTestRecipient(smtpConfig.recipients.join(', '));
    }
  }, [smtpConfig.recipients, testRecipient]);

  useEffect(() => {
    if (smtpConfig.mailpitUiUrl) {
      setApiBaseUrl(smtpConfig.mailpitUiUrl);
    }
  }, [smtpConfig.mailpitUiUrl]);

  const fetchMailpitStatus = useCallback(
    async (overrideUrl?: string) => {
      setIsLoadingStatus(true);
      const url = (overrideUrl !== undefined ? overrideUrl : apiBaseUrl).trim();
      try {
        const params = new URLSearchParams();
        if (url) params.set('apiBaseUrl', url);
        const resp = await apiFetch(`/api/v1/alerts/mailpit/status?${params.toString()}`);
        const data = (await resp.json().catch(() => null)) as MailpitStatusResponse | null;
        if (data) {
          setMailpitStatus(data);
        } else {
          setMailpitStatus({
            connected: false,
            apiBaseUrl: url,
            latencyMs: 0,
            checkedAt: new Date().toISOString(),
            queueDepth: 0,
            unreadCount: 0,
            version: null,
            databaseSizeBytes: null,
            uptimeSec: null,
            smtpAccepted: null,
            smtpRejected: null,
            error: t('smtpDiagnostics.errors.statusHttp', { status: resp.status }),
          });
        }
      } catch (err) {
        setMailpitStatus({
          connected: false,
          apiBaseUrl: url,
          latencyMs: 0,
          checkedAt: new Date().toISOString(),
          queueDepth: 0,
          unreadCount: 0,
          version: null,
          databaseSizeBytes: null,
          uptimeSec: null,
          smtpAccepted: null,
          smtpRejected: null,
          error: err instanceof Error ? err.message : t('smtpDiagnostics.errors.statusQuery'),
        });
      } finally {
        setIsLoadingStatus(false);
      }
    },
    [apiBaseUrl, t]
  );

  const fetchInbox = useCallback(
    async (overrideQuery?: string, overrideUrl?: string) => {
      setIsLoadingInbox(true);
      try {
        const params = new URLSearchParams({ limit: '25' });
        const q = (overrideQuery !== undefined ? overrideQuery : searchQuery).trim();
        const url = (overrideUrl !== undefined ? overrideUrl : apiBaseUrl).trim();
        if (q) params.set('query', q);
        if (url) params.set('apiBaseUrl', url);

        const resp = await apiFetch(`/api/v1/alerts/mailpit/messages?${params.toString()}`);
        const data = (await resp.json().catch(() => null)) as MailpitMessagesResponse | null;
        if (data) {
          setInbox(data);
        } else {
          setInbox({
            reachable: false,
            apiBaseUrl: url,
            latencyMs: 0,
            checkedAt: new Date().toISOString(),
            total: 0,
            unread: 0,
            messagesCount: 0,
            messages: [],
            error: t('smtpDiagnostics.errors.inboxHttp', { status: resp.status }),
          });
        }
      } catch (err) {
        setInbox({
          reachable: false,
          apiBaseUrl,
          latencyMs: 0,
          checkedAt: new Date().toISOString(),
          total: 0,
          unread: 0,
          messagesCount: 0,
          messages: [],
          error: err instanceof Error ? err.message : t('smtpDiagnostics.errors.inboxQuery'),
        });
      } finally {
        setIsLoadingInbox(false);
      }
    },
    [apiBaseUrl, searchQuery, t]
  );

  useEffect(() => {
    void fetchMailpitStatus();
    void fetchInbox();
  }, [fetchInbox, fetchMailpitStatus]);

  useEffect(() => {
    if (!autoPollStatus) return;
    const timer = window.setInterval(() => {
      void fetchMailpitStatus();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [autoPollStatus, fetchMailpitStatus]);

  const handleVerifySmtp = async () => {
    setIsVerifying(true);
    try {
      await onSyncSmtpBeforeAction();
      const resp = await apiFetch('/api/v1/alerts/smtp/verify', { method: 'POST' });
      const data = (await resp.json().catch(() => null)) as SmtpVerifyResult | null;
      if (data) {
        setVerifyResult(data);
      }
    } catch (err) {
      setVerifyResult({
        reachable: false,
        host: smtpConfig.host,
        port: smtpConfig.port,
        secure: smtpConfig.secure,
        authConfigured: Boolean(smtpConfig.username),
        latencyMs: 0,
        checkedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : t('smtpDiagnostics.errors.verifyFailed'),
      });
    } finally {
      setIsVerifying(false);
    }
  };

  const handleSendTestEmail = async (e: FormEvent) => {
    e.preventDefault();
    setIsSending(true);
    setLastSendResult(null);
    try {
      await onSyncSmtpBeforeAction();
      const resp = await apiFetch('/api/v1/alerts/smtp/send-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: testRecipient.trim() || undefined,
          subject: testSubject.trim() || undefined,
          body: testBody.trim() || undefined,
        }),
      });
      const data = (await resp.json().catch(() => null)) as SmtpDiagnosticSendResult | null;
      if (data && data.outcome) {
        setLastSendResult(data);
        if (data.outcome.status === 'sent') {
          // Allow Mailpit a brief moment to index the newly delivered email before refreshing status & inbox
          setTimeout(() => {
            void fetchMailpitStatus();
            void fetchInbox();
          }, 250);
        }
      }
    } catch (err) {
      setLastSendResult({
        outcome: {
          channel: 'email',
          status: 'failed',
          target: `${smtpConfig.host}:${smtpConfig.port}`,
          error: err instanceof Error ? err.message : t('smtpDiagnostics.errors.sendFailed'),
          sentAt: new Date().toISOString(),
        },
        latencyMs: 0,
        smtpResponse: null,
        subject: testSubject,
        recipients: testRecipient
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean),
      });
    } finally {
      setIsSending(false);
    }
  };

  const handleSelectMessage = async (id: string) => {
    setSelectedId(id);
    setIsLoadingDetail(true);
    setDetailError(null);
    try {
      const params = new URLSearchParams();
      if (apiBaseUrl.trim()) params.set('apiBaseUrl', apiBaseUrl.trim());
      const resp = await apiFetch(
        `/api/v1/alerts/mailpit/messages/${encodeURIComponent(id)}?${params.toString()}`
      );
      const data = (await resp.json().catch(() => null)) as MailpitMessageDetailResponse | null;
      if (data?.reachable && data.message) {
        setSelectedDetail(data.message);
      } else {
        setSelectedDetail(null);
        setDetailError(data?.error || t('smtpDiagnostics.errors.detailHttp', { status: resp.status }));
      }
    } catch (err) {
      setSelectedDetail(null);
      setDetailError(err instanceof Error ? err.message : t('smtpDiagnostics.errors.detailFailed'));
    } finally {
      setIsLoadingDetail(false);
    }
  };

  const handleClearInbox = async () => {
    setIsClearingInbox(true);
    try {
      const params = new URLSearchParams();
      if (apiBaseUrl.trim()) params.set('apiBaseUrl', apiBaseUrl.trim());
      await apiFetch(`/api/v1/alerts/mailpit/messages?${params.toString()}`, {
        method: 'DELETE',
      });
      setSelectedId(null);
      setSelectedDetail(null);
      await Promise.all([fetchMailpitStatus(), fetchInbox()]);
    } finally {
      setIsClearingInbox(false);
    }
  };

  const handleSearchSubmit = (e: FormEvent) => {
    e.preventDefault();
    setInboxPage(1);
    void fetchMailpitStatus(apiBaseUrl);
    void fetchInbox(searchQuery, apiBaseUrl);
  };

  const copyMailpitCmd = () => {
    void navigator.clipboard?.writeText(MAILPIT_DOCKER_CMD);
    setCopiedCmd(true);
    setTimeout(() => setCopiedCmd(false), 1800);
  };

  return (
    <div className="space-y-5">
      {/* Embedded Mailpit API Status Indicator Card (Queue Depth & Connection Status) */}
      <section
        aria-label={t('smtpDiagnostics.statusCardAria')}
        className="bg-white border border-hairline rounded-[2px] p-5 space-y-3.5"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Activity className="w-4 h-4 text-brand shrink-0" />
            <div>
              <h2 className="text-[13px] font-semibold tracking-tight text-ink">
                {t('smtpDiagnostics.statusTitle')}
              </h2>
              <p className="text-[11px] text-slate-500">
                {t('smtpDiagnostics.statusSubtitle')} (
                <span className="font-mono">{mailpitStatus?.apiBaseUrl || apiBaseUrl}</span>)
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer whitespace-nowrap">
              <input
                type="checkbox"
                checked={autoPollStatus}
                onChange={(e) => setAutoPollStatus(e.target.checked)}
                className="rounded-[2px] border-hairline-strong accent-brand"
              />
              {t('smtpDiagnostics.autoRefresh')}
            </label>
            <button
              type="button"
              disabled={isLoadingStatus}
              onClick={() => void fetchMailpitStatus()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-[#f4f6f9] border border-hairline-strong rounded-[2px] transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoadingStatus ? 'animate-spin' : ''}`} />
              {isLoadingStatus ? t('smtpDiagnostics.checking') : t('smtpDiagnostics.checkStatus')}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-hairline border-t border-hairline pt-3.5">
          {/* Metric 1: Connection Status */}
          <div className="py-2 sm:py-0 sm:pr-4 space-y-1">
            <div className="text-[11px] font-medium text-slate-500">
              {t('smtpDiagnostics.connectionStatus')}
            </div>
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                  isLoadingStatus && !mailpitStatus
                    ? 'bg-slate-400'
                    : mailpitStatus?.connected
                    ? 'bg-emerald-600'
                    : 'bg-red-600'
                }`}
              />
              <span
                className={`text-base font-semibold tracking-tight ${
                  isLoadingStatus && !mailpitStatus
                    ? 'text-slate-600'
                    : mailpitStatus?.connected
                    ? 'text-emerald-700'
                    : 'text-red-700'
                }`}
              >
                {isLoadingStatus && !mailpitStatus
                  ? t('smtpDiagnostics.checking')
                  : mailpitStatus?.connected
                  ? t('smtpDiagnostics.connected')
                  : t('smtpDiagnostics.disconnected')}
              </span>
            </div>
            <div className="text-[11px] text-slate-500 font-mono truncate">
              {mailpitStatus?.connected
                ? `HTTP 200 · ${mailpitStatus.latencyMs} ms`
                : mailpitStatus?.error || t('smtpDiagnostics.awaitingResponse')}
            </div>
          </div>

          {/* Metric 2: Queue Depth */}
          <div className="py-2 sm:py-0 sm:px-4 space-y-1">
            <div className="text-[11px] font-medium text-slate-500">
              {t('smtpDiagnostics.queueDepth')}
            </div>
            <div className="text-xl font-semibold tracking-tight font-mono tabular-nums text-ink leading-tight">
              {mailpitStatus?.connected ? mailpitStatus.queueDepth : '—'}
              {mailpitStatus?.connected && (
                <span className="ml-1.5 text-xs font-normal text-slate-500 font-sans">
                  {mailpitStatus.queueDepth === 1
                    ? t('smtpDiagnostics.messageSingular')
                    : t('smtpDiagnostics.messagePlural')}
                </span>
              )}
            </div>
            <div className="text-[11px] text-slate-500 font-mono tabular-nums">
              {mailpitStatus?.connected
                ? t('smtpDiagnostics.unreadCount', { count: mailpitStatus.unreadCount })
                : t('smtpDiagnostics.inboxUnavailable')}
            </div>
          </div>

          {/* Metric 3: SMTP Counters */}
          <div className="py-2 sm:py-0 sm:px-4 space-y-1">
            <div className="text-[11px] font-medium text-slate-500">
              {t('smtpDiagnostics.smtpCounters')}
            </div>
            <div className="text-base font-semibold tracking-tight font-mono tabular-nums text-ink">
              {mailpitStatus?.connected && mailpitStatus.smtpAccepted !== null
                ? `${mailpitStatus.smtpAccepted} / ${mailpitStatus.smtpRejected ?? 0}`
                : '—'}
            </div>
            <div className="text-[11px] text-slate-500 font-mono tabular-nums">
              {mailpitStatus?.connected && mailpitStatus.databaseSizeBytes !== null
                ? t('smtpDiagnostics.storeSize', { size: formatBytes(mailpitStatus.databaseSizeBytes) })
                : t('smtpDiagnostics.runtimeCounters')}
            </div>
          </div>

          {/* Metric 4: Version & Last Check */}
          <div className="py-2 sm:py-0 sm:pl-4 space-y-1">
            <div className="text-[11px] font-medium text-slate-500">
              {t('smtpDiagnostics.mailpitEngine')}
            </div>
            <div className="text-base font-semibold tracking-tight font-mono tabular-nums text-ink">
              {mailpitStatus?.connected
                ? mailpitStatus.version || 'Mailpit API'
                : t('smtpDiagnostics.offline')}
            </div>
            <div className="text-[11px] text-slate-500 font-mono tabular-nums">
              {mailpitStatus?.checkedAt
                ? t('smtpDiagnostics.checkedAt', {
                    time: new Date(mailpitStatus.checkedAt).toLocaleTimeString(),
                  })
                : t('smtpDiagnostics.notCheckedYet')}
            </div>
          </div>
        </div>
      </section>

      {/* SMTP Target Summary & Handshake Verification Strip */}
      <section className="bg-white border border-hairline rounded-[2px] p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-[13px] font-semibold tracking-tight text-ink">
              {t('smtpDiagnostics.relayTitle')}
            </h2>
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600 font-mono tabular-nums">
              <span className="text-ink font-medium">
                {smtpConfig.host}:{smtpConfig.port}
              </span>
              <span aria-hidden="true" className="text-slate-400">
                &middot;
              </span>
              <span>
                {smtpConfig.secure ? t('smtpDiagnostics.implicitTls') : t('smtpDiagnostics.plainStartTls')}
              </span>
              <span aria-hidden="true" className="text-slate-400">
                &middot;
              </span>
              <span>
                {smtpConfig.username
                  ? t('smtpDiagnostics.authUser', { user: smtpConfig.username })
                  : t('smtpDiagnostics.authNone')}
              </span>
              <span aria-hidden="true" className="text-slate-400">
                &middot;
              </span>
              <span>{t('smtpDiagnostics.fromLabel', { from: smtpConfig.fromAddress })}</span>
              <span aria-hidden="true" className="text-slate-400">
                &middot;
              </span>
              <span className={smtpConfig.enabled ? 'text-emerald-700 font-medium' : 'text-amber-700 font-medium'}>
                {smtpConfig.enabled
                  ? t('smtpDiagnostics.channelActive')
                  : t('smtpDiagnostics.channelDisabled')}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onNavigateToConfig}
              className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-[#f4f6f9] border border-hairline-strong rounded-[2px] transition-colors cursor-pointer whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              {t('smtpDiagnostics.editSmtpSettings')}
            </button>
            <button
              type="button"
              disabled={isVerifying}
              onClick={() => void handleVerifySmtp()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-chrome hover:bg-[#13294b] rounded-[2px] transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              {isVerifying ? t('smtpDiagnostics.verifying') : t('smtpDiagnostics.verifyHandshake')}
            </button>
          </div>
        </div>

        {verifyResult && (
          <div
            className={`pt-3 border-t border-hairline flex flex-wrap items-center justify-between gap-2 text-xs ${
              verifyResult.reachable ? 'text-emerald-800' : 'text-red-800'
            }`}
          >
            <div className="flex items-center gap-2">
              {verifyResult.reachable ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
              ) : (
                <XCircle className="w-4 h-4 text-red-700 shrink-0" />
              )}
              <span className="font-medium">
                {verifyResult.reachable
                  ? t('smtpDiagnostics.handshakeOk', {
                      host: verifyResult.host,
                      port: verifyResult.port,
                    })
                  : t('smtpDiagnostics.handshakeErr', {
                      error: verifyResult.error || t('smtpDiagnostics.connectionRefused'),
                    })}
              </span>
            </div>
            <div className="font-mono text-[11px] text-slate-600 tabular-nums">
              {t('smtpDiagnostics.latencyChecked', {
                ms: verifyResult.latencyMs,
                time: new Date(verifyResult.checkedAt).toLocaleTimeString(),
              })}
            </div>
          </div>
        )}
      </section>

      {/* Main 2-Column Diagnostics Split: Test Email Composer (Left) + Mailpit API Results (Right) */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
        {/* Left: Test Email Composer */}
        <section className="xl:col-span-5 bg-white border border-hairline rounded-[2px] p-5 space-y-4">
          <div className="border-b border-hairline pb-3">
            <h2 className="text-[13px] font-semibold tracking-tight text-ink flex items-center gap-2">
              <Send className="w-4 h-4 text-brand" />
              {t('smtpDiagnostics.composerTitle')}
            </h2>
            <p className="text-xs text-slate-600 mt-0.5">
              {t('smtpDiagnostics.composerSubtitle')}
            </p>
          </div>

          <form onSubmit={handleSendTestEmail} className="space-y-3">
            <div>
              <label htmlFor="diag-recipient" className="block text-[11px] font-medium text-slate-600 mb-1">
                {t('smtpDiagnostics.recipientsLabel')}
              </label>
              <input
                id="diag-recipient"
                type="text"
                value={testRecipient}
                onChange={(e) => setTestRecipient(e.target.value)}
                placeholder="maintenance@plant.local"
                className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
              />
            </div>

            <div>
              <label htmlFor="diag-subject" className="block text-[11px] font-medium text-slate-600 mb-1">
                {t('smtpDiagnostics.subjectLabel')}
              </label>
              <input
                id="diag-subject"
                type="text"
                value={testSubject}
                onChange={(e) => setTestSubject(e.target.value)}
                className={ERP_INPUT_COMPACT_CLASS}
              />
            </div>

            <div>
              <label htmlFor="diag-body" className="block text-[11px] font-medium text-slate-600 mb-1">
                {t('smtpDiagnostics.bodyLabel')}
              </label>
              <textarea
                id="diag-body"
                rows={4}
                value={testBody}
                onChange={(e) => setTestBody(e.target.value)}
                className={`${ERP_INPUT_COMPACT_CLASS} font-mono resize-y`}
              />
            </div>

            <div className="flex items-center justify-between gap-3 pt-3 border-t border-hairline">
              <span className="text-[11px] text-slate-500 font-mono truncate">
                {t('smtpDiagnostics.viaHost', { host: smtpConfig.host, port: smtpConfig.port })}
              </span>
              <button
                type="submit"
                disabled={isSending}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-white bg-brand hover:bg-brand-hover rounded-[2px] transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                <Send className="w-3.5 h-3.5" />
                {isSending ? t('smtpDiagnostics.sending') : t('smtpDiagnostics.sendTestEmail')}
              </button>
            </div>
          </form>

          {/* SMTP Delivery Receipt */}
          {lastSendResult && (
            <div className="pt-3 border-t border-hairline space-y-2">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span
                  className={`inline-flex items-center gap-1.5 font-semibold ${
                    lastSendResult.outcome.status === 'sent' ? 'text-emerald-700' : 'text-red-700'
                  }`}
                >
                  {lastSendResult.outcome.status === 'sent' ? (
                    <CheckCircle2 className="w-4 h-4" />
                  ) : (
                    <XCircle className="w-4 h-4" />
                  )}
                  {lastSendResult.outcome.status === 'sent'
                    ? t('smtpDiagnostics.acceptedBySmtp')
                    : t('smtpDiagnostics.deliveryFailed')}
                </span>
                <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                  {lastSendResult.latencyMs} ms
                </span>
              </div>

              <dl className="grid grid-cols-3 gap-x-2 gap-y-1 text-[11px]">
                <dt className="text-slate-500">{t('smtpDiagnostics.receiptTarget')}</dt>
                <dd className="col-span-2 font-mono text-slate-800 break-all">{lastSendResult.outcome.target}</dd>

                {lastSendResult.smtpResponse && (
                  <>
                    <dt className="text-slate-500">{t('smtpDiagnostics.receiptReply')}</dt>
                    <dd className="col-span-2 font-mono text-emerald-800 break-all">
                      {lastSendResult.smtpResponse}
                    </dd>
                  </>
                )}

                {lastSendResult.outcome.messageId && (
                  <>
                    <dt className="text-slate-500">{t('smtpDiagnostics.receiptMessageId')}</dt>
                    <dd className="col-span-2 font-mono text-slate-700 break-all">
                      {lastSendResult.outcome.messageId}
                    </dd>
                  </>
                )}

                {lastSendResult.outcome.error && (
                  <>
                    <dt className="text-slate-500">{t('smtpDiagnostics.receiptError')}</dt>
                    <dd className="col-span-2 font-mono text-red-700 break-all">
                      {lastSendResult.outcome.error}
                    </dd>
                  </>
                )}
              </dl>
            </div>
          )}
        </section>

        {/* Right: Live Mailpit API Inbox Inspector */}
        <section className="xl:col-span-7 bg-white border border-hairline rounded-[2px] p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline pb-3">
            <div>
              <h2 className="text-[13px] font-semibold tracking-tight text-ink flex items-center gap-2">
                <Mail className="w-4 h-4 text-brand" />
                {t('smtpDiagnostics.inboxTitle')}
              </h2>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-600 mt-0.5 font-mono tabular-nums">
                <span>
                  {t('smtpDiagnostics.statusLabel')}{' '}
                  <strong className={inbox?.reachable ? 'text-emerald-700' : 'text-red-700'}>
                    {isLoadingInbox && !inbox
                      ? t('smtpDiagnostics.checking')
                      : inbox?.reachable
                      ? t('smtpDiagnostics.connected')
                      : t('smtpDiagnostics.unreachable')}
                  </strong>
                </span>
                <span aria-hidden="true" className="text-slate-400">
                  &middot;
                </span>
                <span>{t('smtpDiagnostics.totalLabel', { count: inbox?.total ?? 0 })}</span>
                <span aria-hidden="true" className="text-slate-400">
                  &middot;
                </span>
                <span>{t('smtpDiagnostics.unreadLabel', { count: inbox?.unread ?? 0 })}</span>
                {inbox?.reachable && (
                  <>
                    <span aria-hidden="true" className="text-slate-400">
                      &middot;
                    </span>
                    <span>{t('smtpDiagnostics.apiLatency', { ms: inbox.latencyMs })}</span>
                  </>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {apiBaseUrl && (
                <a
                  href={apiBaseUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-[#f4f6f9] border border-hairline-strong rounded-[2px] transition-colors whitespace-nowrap shrink-0"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  {t('smtpDiagnostics.mailpitUi')}
                </a>
              )}
              <button
                type="button"
                disabled={isLoadingInbox}
                onClick={() => void fetchInbox()}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-[#f4f6f9] border border-hairline-strong rounded-[2px] transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isLoadingInbox ? 'animate-spin' : ''}`} />
                {t('smtpDiagnostics.refresh')}
              </button>
              <button
                type="button"
                disabled={isClearingInbox || !inbox?.reachable || (inbox?.total ?? 0) === 0}
                onClick={() => void handleClearInbox()}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-red-700 bg-white hover:bg-red-50 border border-hairline-strong rounded-[2px] transition-colors cursor-pointer disabled:opacity-40 whitespace-nowrap shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5" />
                {t('smtpDiagnostics.clearInbox')}
              </button>
            </div>
          </div>

          {/* Mailpit API Endpoint & Search Bar */}
          <form onSubmit={handleSearchSubmit} className="grid grid-cols-1 md:grid-cols-12 gap-2 items-end">
            <div className="md:col-span-5">
              <label htmlFor="mailpit-api-url" className="block text-[11px] font-medium text-slate-600 mb-1">
                {t('smtpDiagnostics.apiBaseUrlLabel')}
              </label>
              <input
                id="mailpit-api-url"
                type="url"
                value={apiBaseUrl}
                onChange={(e) => setApiBaseUrl(e.target.value)}
                placeholder="http://localhost:8025"
                className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
              />
            </div>
            <div className="md:col-span-5">
              <label htmlFor="mailpit-search" className="block text-[11px] font-medium text-slate-600 mb-1">
                {t('smtpDiagnostics.searchLabel')}
              </label>
              <input
                id="mailpit-search"
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('smtpDiagnostics.searchPlaceholder')}
                className={ERP_INPUT_COMPACT_CLASS}
              />
            </div>
            <div className="md:col-span-2">
              <button
                type="submit"
                disabled={isLoadingInbox}
                className="w-full inline-flex items-center justify-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-[#f4f6f9] border border-hairline-strong rounded-[2px] transition-colors cursor-pointer whitespace-nowrap"
              >
                <Search className="w-3.5 h-3.5" />
                {t('smtpDiagnostics.queryBtn')}
              </button>
            </div>
          </form>

          {/* Inbox States: Loading / Unreachable / Empty / Populated */}
          {isLoadingInbox && !inbox ? (
            <div className="py-8 text-center text-xs text-slate-500">
              {t('smtpDiagnostics.loadingInbox', { url: apiBaseUrl })}
            </div>
          ) : inbox && !inbox.reachable ? (
            <div className="border-t border-hairline pt-4 space-y-3">
              <div className="flex items-start gap-2 text-xs text-red-800">
                <XCircle className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold">
                    {t('smtpDiagnostics.unreachableTitle')}{' '}
                    <span className="font-mono">{inbox.apiBaseUrl}</span>
                  </div>
                  <p className="text-slate-600 mt-0.5">
                    {inbox.error || t('smtpDiagnostics.connectionFailed')}{' '}
                    {t('smtpDiagnostics.unreachableHint')}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <code className="px-2.5 py-1.5 bg-[#f8f9fb] border border-hairline-strong rounded-[2px] text-[11px] font-mono text-ink">
                  {MAILPIT_DOCKER_CMD}
                </code>
                <button
                  type="button"
                  onClick={copyMailpitCmd}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium bg-white hover:bg-[#f4f6f9] border border-hairline-strong rounded-[2px] text-slate-700 transition-colors cursor-pointer"
                >
                  {copiedCmd ? <Check className="w-3.5 h-3.5 text-emerald-700" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedCmd ? t('smtpDiagnostics.copied') : t('smtpDiagnostics.copyCommand')}
                </button>
              </div>
            </div>
          ) : inbox && inbox.messages.length === 0 ? (
            <div className="border-t border-hairline py-8 text-center space-y-2">
              <p className="text-xs text-slate-600">{t('smtpDiagnostics.emptyTitle')}</p>
              <p className="text-[11px] text-slate-500">{t('smtpDiagnostics.emptyHint')}</p>
            </div>
          ) : (
            (() => {
              const allMessages = inbox?.messages ?? [];
              const { pageItems: pagedMessages, safePage: safeInboxPage } = paginateItems(
                allMessages,
                inboxPage,
                DEFAULT_TABLE_PAGE_SIZE
              );

              return (
                <div className="overflow-hidden">
                  <div className="erp-table-scroll">
                    <table className="w-full min-w-[520px] text-left border-collapse text-xs">
                      <thead>
                        <tr className={ERP_TABLE_HEAD_ROW_CLASS}>
                          <th className="py-2.5 px-3">{t('smtpDiagnostics.colReceived')}</th>
                          <th className="py-2.5 px-3">{t('smtpDiagnostics.colSubjectRecipients')}</th>
                          <th className="py-2.5 px-3 text-right">{t('smtpDiagnostics.colSize')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-hairline">
                        {pagedMessages.map((msg) => {
                          const isSelected = msg.id === selectedId;
                          return (
                            <tr
                              key={msg.id}
                              onClick={() => void handleSelectMessage(msg.id)}
                              className={`cursor-pointer transition-colors ${
                                isSelected ? 'bg-brand-subtle' : 'hover:bg-[#f8f9fb]'
                              }`}
                            >
                              <td className="py-2 px-3 font-mono text-[11px] text-slate-600 whitespace-nowrap tabular-nums align-top">
                                {new Date(msg.createdAt).toLocaleTimeString()}
                              </td>
                              <td className="py-2 px-3 align-top">
                                <div className="font-medium text-ink">{msg.subject}</div>
                                <div className="text-[11px] text-slate-500 font-mono truncate max-w-md">
                                  {msg.from} &rarr; {msg.to.join(', ')}
                                </div>
                                {msg.snippet && (
                                  <div className="text-[11px] text-slate-500 truncate max-w-md mt-0.5">
                                    {msg.snippet}
                                  </div>
                                )}
                              </td>
                              <td className="py-2 px-3 font-mono text-[11px] text-slate-600 text-right whitespace-nowrap tabular-nums align-top">
                                {formatBytes(msg.sizeBytes)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <TablePagination
                    currentPage={safeInboxPage}
                    totalItems={allMessages.length}
                    pageSize={DEFAULT_TABLE_PAGE_SIZE}
                    maxVisiblePages={3}
                    onPageChange={setInboxPage}
                    itemLabel={t('smtpDiagnostics.paginationMessages')}
                    hideWhenSinglePage
                  />
                </div>
              );
            })()
          )}
        </section>
      </div>

      {/* Selected Mailpit Message Detail Inspector */}
      {(selectedId || detailError) && (
        <section className="bg-white border border-hairline rounded-[2px] p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline pb-3">
            <div>
              <h3 className="text-[13px] font-semibold tracking-tight text-ink">
                {selectedDetail ? selectedDetail.subject : t('smtpDiagnostics.inspectorFallbackTitle')}
              </h3>
              {selectedDetail && (
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-600 font-mono mt-0.5 tabular-nums">
                  <span>
                    {t('smtpDiagnostics.fromPrefix')} {selectedDetail.from}
                  </span>
                  <span aria-hidden="true" className="text-slate-400">
                    &middot;
                  </span>
                  <span>
                    {t('smtpDiagnostics.toPrefix')} {selectedDetail.to.join(', ')}
                  </span>
                  <span aria-hidden="true" className="text-slate-400">
                    &middot;
                  </span>
                  <span>{formatBytes(selectedDetail.sizeBytes)}</span>
                  {selectedDetail.messageId && (
                    <>
                      <span aria-hidden="true" className="text-slate-400">
                        &middot;
                      </span>
                      <span className="truncate max-w-xs">ID: {selectedDetail.messageId}</span>
                    </>
                  )}
                </div>
              )}
            </div>

            <div className={`${ERP_SEGMENTED_GROUP_CLASS} shrink-0`}>
              {(['text', 'html', 'headers'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setInspectorTab(tab)}
                  className={`px-2.5 py-1.5 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                    inspectorTab === tab
                      ? 'bg-brand text-white'
                      : 'text-slate-600 hover:bg-[#f4f6f9] hover:text-ink'
                  }`}
                >
                  {tab === 'text'
                    ? t('smtpDiagnostics.tabPlainText')
                    : tab === 'html'
                    ? t('smtpDiagnostics.tabHtml')
                    : t('smtpDiagnostics.tabHeaders')}
                </button>
              ))}
            </div>
          </div>

          {isLoadingDetail ? (
            <div className="py-6 text-center text-xs text-slate-500">
              {t('smtpDiagnostics.loadingDetail')}
            </div>
          ) : detailError ? (
            <div className="text-xs text-red-700">{detailError}</div>
          ) : selectedDetail ? (
            inspectorTab === 'text' ? (
              <pre className="p-3.5 bg-[#f8f9fb] border border-hairline rounded-[2px] text-xs font-mono text-slate-800 whitespace-pre-wrap overflow-x-auto max-h-80">
                {selectedDetail.text || t('smtpDiagnostics.noPlainText')}
              </pre>
            ) : inspectorTab === 'html' ? (
              selectedDetail.html ? (
                <iframe
                  title={t('smtpDiagnostics.htmlPreviewTitle')}
                  sandbox=""
                  srcDoc={selectedDetail.html}
                  className="w-full h-72 border border-hairline rounded-[2px] bg-white"
                />
              ) : (
                <div className="py-4 text-xs text-slate-500">
                  {t('smtpDiagnostics.noHtmlBody')}
                </div>
              )
            ) : (
              <div className="overflow-x-auto max-h-80">
                <table className="w-full text-left border-collapse text-xs font-mono">
                  <tbody className="divide-y divide-hairline border-y border-hairline">
                    {Object.entries(selectedDetail.headers).length === 0 ? (
                      <tr>
                        <td className="py-3 px-3 text-slate-500">{t('smtpDiagnostics.noHeaders')}</td>
                      </tr>
                    ) : (
                      Object.entries(selectedDetail.headers).map(([hdrName, values]) => (
                        <tr key={hdrName}>
                          <td className="py-1.5 px-3 text-slate-600 font-semibold whitespace-nowrap align-top bg-[#f8f9fa] w-44">
                            {hdrName}
                          </td>
                          <td className="py-1.5 px-3 text-slate-800 break-all">
                            {Array.isArray(values) ? values.join('; ') : String(values)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )
          ) : null}
        </section>
      )}
    </div>
  );
}
