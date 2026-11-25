import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bell,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Eye,
  Mail,
  MessageSquare,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Save,
  Send,
  Trash2,
  Webhook,
} from 'lucide-react';
import type {
  AlertChannelType,
  AlertDeliveryOutcome,
  AlertEvent,
  AlertMetric,
  AlertOperator,
  AlertRule,
  AlertSeverity,
  AlertsStateResponse,
  SmtpChannelConfig,
} from '../types/pipeline';
import { apiFetch } from '../utils/apiAuth';
import { formatUtcTimestamp } from '../utils/formatters';
import {
  ERP_INPUT_CLASS,
  ERP_INPUT_COMPACT_CLASS,
  ERP_SEGMENTED_GROUP_CLASS,
  ERP_TABLE_HEAD_ROW_CLASS,
} from '../theme/tokens';
import {
  Button,
  DEFAULT_TABLE_PAGE_SIZE,
  HIGH_VOLUME_PAGE_SIZE,
  paginateItems,
  RowActionMenu,
  SlideOverDrawer,
  TablePagination,
} from './ui';
import { SmtpDiagnosticsPanel } from './SmtpDiagnosticsPanel';

const METRIC_KEYS: AlertMetric[] = [
  'temp_max',
  'temp_mean',
  'primary_metric_mean',
  'primary_metric_p95',
  'fault_count',
  'availability_pct',
  'is_anomalous_window',
];

const OPERATOR_OPTIONS: Array<{ value: AlertOperator; label: string }> = [
  { value: 'gt', label: '>' },
  { value: 'gte', label: '>=' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '<=' },
];

const MAILPIT_DOCKER_CMD = 'docker compose -f docker-compose.mailpit.yml up -d';

export function NotificationsSection() {
  const { t } = useTranslation(['configuration', 'common']);
  const [activeSubSection, setActiveSubSection] = useState<'channels' | 'smtp-diagnostics'>('channels');
  const [state, setState] = useState<AlertsStateResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSavingChannels, setIsSavingChannels] = useState(false);
  const [testingChannel, setTestingChannel] = useState<AlertChannelType | null>(null);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [copiedCmd, setCopiedCmd] = useState(false);

  // SMTP / Mailpit form state
  const [smtpEnabled, setSmtpEnabled] = useState(false);
  const [smtpHost, setSmtpHost] = useState('127.0.0.1');
  const [smtpPort, setSmtpPort] = useState(1025);
  const [smtpSecure, setSmtpSecure] = useState(false);
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [smtpFrom, setSmtpFrom] = useState('alerts@telemetry.plant.local');
  const [smtpRecipientsText, setSmtpRecipientsText] = useState('maintenance@plant.local');
  const [mailpitUiUrl, setMailpitUiUrl] = useState('http://localhost:8025');

  // Webhook form state
  const [webhookEnabled, setWebhookEnabled] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [webhookTimeoutMs, setWebhookTimeoutMs] = useState(4000);

  // New rule SlideOverDrawer state
  const [ruleDrawerOpen, setRuleDrawerOpen] = useState(false);
  const [ruleName, setRuleName] = useState('');
  const [ruleMetric, setRuleMetric] = useState<AlertMetric>('temp_max');
  const [ruleOperator, setRuleOperator] = useState<AlertOperator>('gt');
  const [ruleThreshold, setRuleThreshold] = useState(85);
  const [ruleSeverity, setRuleSeverity] = useState<AlertSeverity>('critical');
  const [ruleCooldownSec, setRuleCooldownSec] = useState(180);
  const [ruleUseEmail, setRuleUseEmail] = useState(true);
  const [ruleUseWebhook, setRuleUseWebhook] = useState(true);

  // Alert Rules & Triggered Alert History pagination + status filter
  const [rulesPage, setRulesPage] = useState(1);
  const [historyFilter, setHistoryFilter] = useState<'all' | 'pending' | 'ack'>('all');
  const [historyPage, setHistoryPage] = useState(1);
  const [historyPageSize, setHistoryPageSize] = useState<number>(HIGH_VOLUME_PAGE_SIZE);

  // Alert Event Detail Drawer state (inspection, notes, acknowledge, reopen)
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [eventNoteDraft, setEventNoteDraft] = useState('');
  const [isUpdatingEvent, setIsUpdatingEvent] = useState(false);

  const syncFormFromState = useCallback((data: AlertsStateResponse) => {
    setState(data);
    setSmtpEnabled(data.smtp.enabled);
    setSmtpHost(data.smtp.host);
    setSmtpPort(data.smtp.port);
    setSmtpSecure(data.smtp.secure);
    setSmtpUser(data.smtp.username);
    setSmtpFrom(data.smtp.fromAddress);
    setSmtpRecipientsText(data.smtp.recipients.join(', '));
    setMailpitUiUrl(data.smtp.mailpitUiUrl);

    setWebhookEnabled(data.webhook.enabled);
    setWebhookUrl(data.webhook.url);
    setWebhookTimeoutMs(data.webhook.timeoutMs);
  }, []);

  const loadAlerts = useCallback(async () => {
    setIsLoading(true);
    try {
      const resp = await apiFetch('/api/v1/alerts');
      if (resp.ok) {
        const data = (await resp.json()) as AlertsStateResponse;
        syncFormFromState(data);
      }
    } finally {
      setIsLoading(false);
    }
  }, [syncFormFromState]);

  useEffect(() => {
    void loadAlerts();
  }, [loadAlerts]);

  const applyMailpitPreset = (mode: 'local' | 'docker') => {
    setSmtpEnabled(true);
    setSmtpHost(mode === 'local' ? '127.0.0.1' : 'mailpit');
    setSmtpPort(1025);
    setSmtpSecure(false);
    setSmtpUser('');
    setSmtpPass('');
    setSmtpFrom('alerts@telemetry.plant.local');
    setMailpitUiUrl('http://localhost:8025');
    setBanner({
      kind: 'ok',
      text:
        mode === 'local'
          ? t('configuration:notifications.messages.presetLocalApplied')
          : t('configuration:notifications.messages.presetDockerApplied'),
    });
  };

  const handleSaveChannels = async (e: FormEvent) => {
    e.preventDefault();
    setIsSavingChannels(true);
    setBanner(null);
    try {
      const recipients = smtpRecipientsText
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean);

      const resp = await apiFetch('/api/v1/alerts/channels', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          smtp: {
            enabled: smtpEnabled,
            host: smtpHost,
            port: Number(smtpPort),
            secure: smtpSecure,
            username: smtpUser,
            ...(smtpPass ? { password: smtpPass } : {}),
            fromAddress: smtpFrom,
            recipients,
            mailpitUiUrl,
          },
          webhook: {
            enabled: webhookEnabled,
            url: webhookUrl,
            ...(webhookSecret ? { signingSecret: webhookSecret } : {}),
            timeoutMs: Number(webhookTimeoutMs),
          },
        }),
      });
      if (!resp.ok) {
        const err = (await resp.json().catch(() => ({}))) as { error?: string };
        throw new Error(
          err.error ||
            t('configuration:notifications.messages.channelsSaveStatusErr', { status: resp.status })
        );
      }
      const updated = (await resp.json()) as AlertsStateResponse;
      setSmtpPass('');
      setWebhookSecret('');
      syncFormFromState(updated);
      setBanner({ kind: 'ok', text: t('configuration:notifications.messages.channelsSaved') });
    } catch (err) {
      setBanner({
        kind: 'err',
        text: err instanceof Error ? err.message : t('configuration:notifications.messages.channelsSaveErr'),
      });
    } finally {
      setIsSavingChannels(false);
    }
  };

  const syncCurrentChannelsToServer = useCallback(async (): Promise<boolean> => {
    const recipients = smtpRecipientsText
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
    const resp = await apiFetch('/api/v1/alerts/channels', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        smtp: {
          enabled: smtpEnabled,
          host: smtpHost,
          port: Number(smtpPort),
          secure: smtpSecure,
          username: smtpUser,
          ...(smtpPass ? { password: smtpPass } : {}),
          fromAddress: smtpFrom,
          recipients,
          mailpitUiUrl,
        },
        webhook: {
          enabled: webhookEnabled,
          url: webhookUrl,
          ...(webhookSecret ? { signingSecret: webhookSecret } : {}),
          timeoutMs: Number(webhookTimeoutMs),
        },
      }),
    });
    if (resp.ok) {
      const updated = (await resp.json()) as AlertsStateResponse;
      setSmtpPass('');
      setWebhookSecret('');
      syncFormFromState(updated);
      return true;
    }
    return false;
  }, [
    mailpitUiUrl,
    smtpEnabled,
    smtpFrom,
    smtpHost,
    smtpPass,
    smtpPort,
    smtpRecipientsText,
    smtpSecure,
    smtpUser,
    syncFormFromState,
    webhookEnabled,
    webhookSecret,
    webhookTimeoutMs,
    webhookUrl,
  ]);

  const handleTestChannel = async (channel: AlertChannelType) => {
    setTestingChannel(channel);
    setBanner(null);
    try {
      await syncCurrentChannelsToServer();

      const resp = await apiFetch('/api/v1/alerts/test-channel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel }),
      });
      const payload = (await resp.json().catch(() => ({}))) as {
        outcome?: AlertDeliveryOutcome;
        error?: string;
      };
      const outcome = payload.outcome;
      if (resp.ok && outcome?.status === 'sent') {
        setBanner({
          kind: 'ok',
          text:
            channel === 'email'
              ? t('configuration:notifications.messages.testEmailOk', {
                  target: outcome.target,
                  messageId: outcome.messageId ?? 'ok',
                  url: mailpitUiUrl,
                })
              : t('configuration:notifications.messages.testWebhookOk', {
                  target: outcome.target,
                  status: outcome.httpStatus ?? 200,
                }),
        });
      } else {
        setBanner({
          kind: 'err',
          text: t('configuration:notifications.messages.testChannelErr', {
            channel: channel.toUpperCase(),
            error: outcome?.error || payload.error || `HTTP ${resp.status}`,
          }),
        });
      }
    } catch (err) {
      setBanner({
        kind: 'err',
        text:
          err instanceof Error ? err.message : t('configuration:notifications.messages.testDeliveryErr'),
      });
    } finally {
      setTestingChannel(null);
    }
  };

  const handleCreateRule = async (e: FormEvent) => {
    e.preventDefault();
    setBanner(null);
    const channels: AlertChannelType[] = [];
    if (ruleUseEmail) channels.push('email');
    if (ruleUseWebhook) channels.push('webhook');
    if (channels.length === 0) {
      setBanner({ kind: 'err', text: t('configuration:notifications.messages.selectChannelErr') });
      return;
    }

    const resp = await apiFetch('/api/v1/alerts/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: ruleName.trim() || `${ruleMetric} ${ruleOperator} ${ruleThreshold}`,
        metric: ruleMetric,
        operator: ruleOperator,
        threshold: Number(ruleThreshold),
        severity: ruleSeverity,
        cooldownSec: Number(ruleCooldownSec),
        channels,
        enabled: true,
      }),
    });
    if (!resp.ok) {
      setBanner({ kind: 'err', text: t('configuration:notifications.messages.createRuleErr') });
      return;
    }
    const payload = (await resp.json()) as { state: AlertsStateResponse };
    syncFormFromState(payload.state);
    setRuleName('');
    setRuleDrawerOpen(false);
    setBanner({ kind: 'ok', text: t('configuration:notifications.messages.createRuleOk') });
  };

  const handleToggleRule = async (rule: AlertRule) => {
    const resp = await apiFetch('/api/v1/alerts/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: rule.id, enabled: !rule.enabled }),
    });
    if (resp.ok) {
      const payload = (await resp.json()) as { state: AlertsStateResponse };
      syncFormFromState(payload.state);
    }
  };

  const handleDeleteRule = async (ruleId: string) => {
    const resp = await apiFetch(`/api/v1/alerts/rules/${encodeURIComponent(ruleId)}`, {
      method: 'DELETE',
    });
    if (resp.ok) {
      const payload = (await resp.json()) as { state: AlertsStateResponse };
      syncFormFromState(payload.state);
    }
  };

  const openEventDetails = (ev: AlertEvent) => {
    setSelectedEventId(ev.id);
    setEventNoteDraft(ev.acknowledgementNote ?? '');
  };

  const handleAcknowledge = async (eventId: string, note?: string) => {
    setIsUpdatingEvent(true);
    try {
      const resp = await apiFetch(`/api/v1/alerts/events/${encodeURIComponent(eventId)}/ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(note !== undefined ? { note } : {}),
      });
      if (resp.ok) {
        const payload = (await resp.json()) as { event: AlertEvent; state: AlertsStateResponse };
        syncFormFromState(payload.state);
        if (selectedEventId === eventId) {
          setEventNoteDraft(payload.event.acknowledgementNote ?? '');
        }
        setBanner({
          kind: 'ok',
          text: t('configuration:notifications.messages.ackOk', {
            machineId: payload.event.machineId,
            ruleName: payload.event.ruleName,
            actor: payload.event.acknowledgedBy ?? 'operator',
          }),
        });
      }
    } finally {
      setIsUpdatingEvent(false);
    }
  };

  const handleReopenEvent = async (eventId: string, reason?: string) => {
    setIsUpdatingEvent(true);
    try {
      const resp = await apiFetch(`/api/v1/alerts/events/${encodeURIComponent(eventId)}/unack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reason !== undefined ? { reason } : {}),
      });
      if (resp.ok) {
        const payload = (await resp.json()) as { event: AlertEvent; state: AlertsStateResponse };
        syncFormFromState(payload.state);
        setBanner({
          kind: 'ok',
          text: t('configuration:notifications.messages.reopenOk', {
            machineId: payload.event.machineId,
            ruleName: payload.event.ruleName,
          }),
        });
      }
    } finally {
      setIsUpdatingEvent(false);
    }
  };

  const handleSaveEventNote = async (eventId: string, note: string) => {
    setIsUpdatingEvent(true);
    try {
      const resp = await apiFetch(`/api/v1/alerts/events/${encodeURIComponent(eventId)}/note`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note }),
      });
      if (resp.ok) {
        const payload = (await resp.json()) as { event: AlertEvent; state: AlertsStateResponse };
        syncFormFromState(payload.state);
        setEventNoteDraft(payload.event.acknowledgementNote ?? '');
        setBanner({
          kind: 'ok',
          text: t('configuration:notifications.messages.noteSavedOk', { id: payload.event.id }),
        });
      }
    } finally {
      setIsUpdatingEvent(false);
    }
  };

  const copyMailpitCmd = () => {
    void navigator.clipboard?.writeText(MAILPIT_DOCKER_CMD);
    setCopiedCmd(true);
    setTimeout(() => setCopiedCmd(false), 1800);
  };

  if (isLoading && !state) {
    return (
      <div className="bg-white border border-hairline rounded-[2px] p-6 text-xs text-slate-600">
        {t('configuration:notifications.loading')}
      </div>
    );
  }

  const liveSmtpConfig: SmtpChannelConfig = {
    enabled: smtpEnabled,
    host: smtpHost,
    port: Number(smtpPort) || 1025,
    secure: smtpSecure,
    username: smtpUser,
    passwordSet: Boolean(smtpPass || state?.smtp.passwordSet),
    fromAddress: smtpFrom,
    recipients: smtpRecipientsText
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean),
    mailpitUiUrl,
  };

  return (
    <div className="space-y-5">
      {/* Header Bar & Sub-section Navigation */}
      <div className="bg-white border border-hairline rounded-[2px] px-5 py-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-[15px] font-semibold tracking-tight text-ink flex items-center gap-2">
            <Bell className="w-4 h-4 text-brand" />
            {t('configuration:notifications.title')}
          </h1>
          <p className="text-xs text-slate-600 mt-0.5">
            {t('configuration:notifications.subtitle')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <div
            role="tablist"
            aria-label={t('configuration:notifications.subSectionsAria')}
            className={ERP_SEGMENTED_GROUP_CLASS}
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeSubSection === 'channels'}
              onClick={() => setActiveSubSection('channels')}
              className={`px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                activeSubSection === 'channels'
                  ? 'bg-brand text-white'
                  : 'text-slate-600 hover:bg-[#f4f6f9] hover:text-ink'
              }`}
            >
              {t('configuration:notifications.tabs.channels')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeSubSection === 'smtp-diagnostics'}
              onClick={() => setActiveSubSection('smtp-diagnostics')}
              className={`px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                activeSubSection === 'smtp-diagnostics'
                  ? 'bg-brand text-white'
                  : 'text-slate-600 hover:bg-[#f4f6f9] hover:text-ink'
              }`}
            >
              {t('configuration:notifications.tabs.smtpDiagnostics')}
            </button>
          </div>

          <button
            type="button"
            onClick={() => void loadAlerts()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-[#f4f6f9] border border-hairline-strong rounded-[2px] transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            {t('common:actions.refresh')}
          </button>
        </div>
      </div>

      {banner && (
        <div
          className={`px-4 py-2.5 rounded-[2px] border text-xs flex items-center justify-between gap-4 ${
            banner.kind === 'ok'
              ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
              : 'bg-red-50 border-red-300 text-red-900'
          }`}
        >
          <span>{banner.text}</span>
          <button
            type="button"
            onClick={() => setBanner(null)}
            className="text-xs font-medium underline cursor-pointer shrink-0"
          >
            {t('common:actions.dismiss')}
          </button>
        </div>
      )}

      {activeSubSection === 'smtp-diagnostics' ? (
        <SmtpDiagnosticsPanel
          smtpConfig={liveSmtpConfig}
          onSyncSmtpBeforeAction={syncCurrentChannelsToServer}
          onNavigateToConfig={() => setActiveSubSection('channels')}
        />
      ) : (
        <>
          {/* Restrained Architectural Mailpit Utility Strip */}
          <div className="bg-[#f8f9fb] border border-hairline rounded-[2px] px-5 py-3 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <div className="space-y-0.5 min-w-0">
              <div className="text-xs font-semibold text-ink">
                {t('configuration:notifications.mailpitStrip.title')}
              </div>
              <p className="text-[11px] text-slate-600">
                {t('configuration:notifications.mailpitStrip.descPrefix')}{' '}
                <span className="font-mono font-medium text-brand">
                  {t('configuration:notifications.mailpitStrip.portLabel')}
                </span>
                {t('configuration:notifications.mailpitStrip.webUiLabel')}{' '}
                <span className="font-mono font-medium text-brand">{mailpitUiUrl}</span>.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <code className="px-2.5 py-1.5 bg-white border border-hairline-strong rounded-[2px] text-[11px] font-mono text-ink">
                {MAILPIT_DOCKER_CMD}
              </code>
              <button
                type="button"
                onClick={copyMailpitCmd}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium bg-white hover:bg-[#f4f6f9] border border-hairline-strong rounded-[2px] text-slate-700 transition-colors cursor-pointer"
              >
                {copiedCmd ? <Check className="w-3.5 h-3.5 text-emerald-700" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedCmd
                  ? t('configuration:notifications.mailpitStrip.copied')
                  : t('configuration:notifications.mailpitStrip.copy')}
              </button>
            </div>
          </div>

          {/* Channels Configuration Form (SMTP + Webhook) */}
          <form onSubmit={handleSaveChannels} className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            {/* Email / SMTP / Mailpit Card */}
            <section className="bg-white border border-hairline rounded-[2px] p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline pb-3">
                <div className="flex items-center gap-2">
                  <Mail className="w-4 h-4 text-brand" />
                  <h2 className="text-[13px] font-semibold tracking-tight text-ink">
                    {t('configuration:notifications.smtpCard.title')}
                  </h2>
                </div>
                <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={smtpEnabled}
                    onChange={(e) => setSmtpEnabled(e.target.checked)}
                    className="rounded-[2px] border-hairline-strong accent-brand"
                  />
                  {t('configuration:notifications.smtpCard.enabled')}
                </label>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => applyMailpitPreset('local')}
                  className="px-2.5 py-1 text-[11px] font-medium bg-[#f8f9fb] hover:bg-[#eef1f6] border border-hairline-strong rounded-[2px] text-slate-700 transition-colors cursor-pointer"
                >
                  {t('configuration:notifications.smtpCard.presetLocal')}
                </button>
                <button
                  type="button"
                  onClick={() => applyMailpitPreset('docker')}
                  className="px-2.5 py-1 text-[11px] font-medium bg-[#f8f9fb] hover:bg-[#eef1f6] border border-hairline-strong rounded-[2px] text-slate-700 transition-colors cursor-pointer"
                >
                  {t('configuration:notifications.smtpCard.presetDocker')}
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">
                    {t('configuration:notifications.smtpCard.host')}
                  </label>
                  <input
                    type="text"
                    value={smtpHost}
                    onChange={(e) => setSmtpHost(e.target.value)}
                    placeholder={t('configuration:notifications.smtpCard.hostPlaceholder')}
                    className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">
                    {t('configuration:notifications.smtpCard.port')}
                  </label>
                  <input
                    type="number"
                    value={smtpPort}
                    onChange={(e) => setSmtpPort(Number(e.target.value))}
                    className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">
                    {t('configuration:notifications.smtpCard.fromAddress')}
                  </label>
                  <input
                    type="email"
                    value={smtpFrom}
                    onChange={(e) => setSmtpFrom(e.target.value)}
                    className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">
                    {t('configuration:notifications.smtpCard.mailpitUrl')}
                  </label>
                  <input
                    type="text"
                    value={mailpitUiUrl}
                    onChange={(e) => setMailpitUiUrl(e.target.value)}
                    className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  {t('configuration:notifications.smtpCard.recipients')}
                </label>
                <input
                  type="text"
                  value={smtpRecipientsText}
                  onChange={(e) => setSmtpRecipientsText(e.target.value)}
                  placeholder="maintenance@plant.local, shiftlead@plant.local"
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">
                    {t('configuration:notifications.smtpCard.username')}
                  </label>
                  <input
                    type="text"
                    value={smtpUser}
                    onChange={(e) => setSmtpUser(e.target.value)}
                    className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">
                    {t('configuration:notifications.smtpCard.password')}{' '}
                    {state?.smtp.passwordSet
                      ? t('configuration:notifications.smtpCard.configured')
                      : t('configuration:notifications.smtpCard.optional')}
                  </label>
                  <input
                    type="password"
                    value={smtpPass}
                    onChange={(e) => setSmtpPass(e.target.value)}
                    placeholder={state?.smtp.passwordSet ? '••••••••' : ''}
                    className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-hairline">
                <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={smtpSecure}
                    onChange={(e) => setSmtpSecure(e.target.checked)}
                    className="rounded-[2px] border-hairline-strong accent-brand"
                  />
                  {t('configuration:notifications.smtpCard.implicitTls')}
                </label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setActiveSubSection('smtp-diagnostics')}
                    className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-[#f4f6f9] border border-hairline-strong rounded-[2px] transition-colors cursor-pointer whitespace-nowrap shrink-0"
                  >
                    {t('configuration:notifications.tabs.smtpDiagnostics')}
                  </button>
                  <button
                    type="button"
                    disabled={testingChannel === 'email'}
                    onClick={() => void handleTestChannel('email')}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-chrome hover:bg-brand-hover rounded-[2px] transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    <Send className="w-3.5 h-3.5" />
                    {testingChannel === 'email'
                      ? t('configuration:notifications.smtpCard.sending')
                      : t('configuration:notifications.smtpCard.sendTest')}
                  </button>
                </div>
              </div>
            </section>

            {/* Webhook Card */}
            <section className="bg-white border border-hairline rounded-[2px] p-5 flex flex-col justify-between space-y-4">
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline pb-3">
                  <div className="flex items-center gap-2">
                    <Webhook className="w-4 h-4 text-brand" />
                    <h2 className="text-[13px] font-semibold tracking-tight text-ink">
                      {t('configuration:notifications.webhookCard.title')}
                    </h2>
                  </div>
                  <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={webhookEnabled}
                      onChange={(e) => setWebhookEnabled(e.target.checked)}
                      className="rounded-[2px] border-hairline-strong accent-brand"
                    />
                    {t('configuration:notifications.webhookCard.enabled')}
                  </label>
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">
                    {t('configuration:notifications.webhookCard.endpointUrl')}
                  </label>
                  <input
                    type="url"
                    value={webhookUrl}
                    onChange={(e) => setWebhookUrl(e.target.value)}
                    placeholder="https://erp.company.local/api/hooks/telemetry-alerts"
                    className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                  />
                  <p className="text-[11px] text-slate-500 mt-1">
                    {t('configuration:notifications.webhookCard.ssrfHint')}{' '}
                    <code className="font-mono">X-Telemetry-Signature: sha256=...</code>.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      {t('configuration:notifications.webhookCard.secret')}{' '}
                      {state?.webhook.signingSecretSet
                        ? t('configuration:notifications.smtpCard.configured')
                        : t('configuration:notifications.smtpCard.optional')}
                    </label>
                    <input
                      type="password"
                      value={webhookSecret}
                      onChange={(e) => setWebhookSecret(e.target.value)}
                      placeholder={state?.webhook.signingSecretSet ? '••••••••' : 'whsec_...'}
                      className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      {t('configuration:notifications.webhookCard.timeout')}
                    </label>
                    <input
                      type="number"
                      min={1000}
                      max={15000}
                      value={webhookTimeoutMs}
                      onChange={(e) => setWebhookTimeoutMs(Number(e.target.value))}
                      className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                    />
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-hairline">
                <button
                  type="button"
                  disabled={testingChannel === 'webhook'}
                  onClick={() => void handleTestChannel('webhook')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-[#f4f6f9] border border-hairline-strong rounded-[2px] transition-colors cursor-pointer disabled:opacity-50"
                >
                  <Send className="w-3.5 h-3.5" />
                  {testingChannel === 'webhook'
                    ? t('configuration:notifications.smtpCard.sending')
                    : t('configuration:notifications.webhookCard.testWebhook')}
                </button>

                <button
                  type="submit"
                  disabled={isSavingChannels}
                  className="px-4 py-1.5 text-xs font-medium text-white bg-brand hover:bg-brand-hover rounded-[2px] transition-colors cursor-pointer disabled:opacity-50"
                >
                  {isSavingChannels
                    ? t('common:actions.saving')
                    : t('configuration:notifications.webhookCard.saveChannels')}
                </button>
              </div>
            </section>
          </form>

          {/* Alert Rules Section */}
          {(() => {
            const allRules = state?.rules ?? [];
            const { pageItems: pagedRules, safePage: safeRulesPage } = paginateItems(
              allRules,
              rulesPage,
              DEFAULT_TABLE_PAGE_SIZE
            );

            return (
              <section className="bg-white overflow-hidden">
                <div className="px-5 py-4 bg-white flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-[13px] font-semibold text-ink tracking-tight">
                      {t('configuration:notifications.rulesSection.heading', { count: allRules.length })}
                    </h2>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      {t('configuration:notifications.rulesSection.subtitle')}
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => setRuleDrawerOpen(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-brand hover:bg-brand-hover rounded-[2px] transition-colors cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    {t('configuration:notifications.rulesSection.newRule')}
                  </button>
                </div>

                <div className="erp-table-scroll">
                  <table className="w-full min-w-[760px] text-left border-collapse text-xs">
                    <thead>
                      <tr className={ERP_TABLE_HEAD_ROW_CLASS}>
                        <th className="py-2.5 px-4">{t('configuration:notifications.rulesSection.colName')}</th>
                        <th className="py-2.5 px-3">{t('configuration:notifications.rulesSection.colCondition')}</th>
                        <th className="py-2.5 px-3">{t('configuration:notifications.rulesSection.colSeverity')}</th>
                        <th className="py-2.5 px-3">{t('configuration:notifications.rulesSection.colChannels')}</th>
                        <th className="py-2.5 px-3">{t('configuration:notifications.rulesSection.colCooldown')}</th>
                        <th className="py-2.5 px-4 text-right w-16">{t('configuration:notifications.rulesSection.colActions')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-hairline">
                      {pagedRules.map((rule) => (
                        <tr key={rule.id} className={!rule.enabled ? 'opacity-50' : 'hover:bg-[#f8f9fb] transition-colors'}>
                          <td className="py-2.5 px-4 font-medium text-slate-900">{rule.name}</td>
                          <td className="py-2.5 px-3 font-mono text-slate-700">
                            {rule.metric} {rule.operator} {rule.threshold}
                          </td>
                          <td className="py-2.5 px-3">
                            <span
                              className={`font-mono text-[11px] font-semibold uppercase ${
                                rule.severity === 'critical'
                                  ? 'text-red-700'
                                  : rule.severity === 'warning'
                                  ? 'text-amber-700'
                                  : 'text-slate-600'
                              }`}
                            >
                              {rule.severity}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 font-mono text-slate-700">{rule.channels.join(', ')}</td>
                          <td className="py-2.5 px-3 font-mono text-slate-600 tabular-nums">{rule.cooldownSec}s</td>
                          <td className="py-2.5 px-4 text-right whitespace-nowrap">
                            <RowActionMenu
                              ariaLabel={t('configuration:notifications.rulesSection.actionsAria', { name: rule.name })}
                              items={[
                                {
                                  id: 'toggle',
                                  label: rule.enabled
                                    ? t('configuration:notifications.rulesSection.disableRule')
                                    : t('configuration:notifications.rulesSection.enableRule'),
                                  icon: <Power className="w-3.5 h-3.5" />,
                                  onClick: () => void handleToggleRule(rule),
                                },
                                {
                                  id: 'delete',
                                  label: t('configuration:notifications.rulesSection.deleteRule'),
                                  icon: <Trash2 className="w-3.5 h-3.5" />,
                                  tone: 'danger',
                                  dividerBefore: true,
                                  onClick: () => void handleDeleteRule(rule.id),
                                },
                              ]}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <TablePagination
                  currentPage={safeRulesPage}
                  totalItems={allRules.length}
                  pageSize={DEFAULT_TABLE_PAGE_SIZE}
                  maxVisiblePages={3}
                  onPageChange={setRulesPage}
                  itemLabel={t('configuration:notifications.pagination.rules')}
                  hideWhenSinglePage
                />
              </section>
            );
          })()}

          {/* Recent Triggered Alerts & Delivery Outcomes */}
          {(() => {
            const allEvents = state?.recentEvents ?? [];
            const filteredEvents =
              historyFilter === 'pending'
                ? allEvents.filter((ev) => !ev.acknowledgedAt)
                : historyFilter === 'ack'
                ? allEvents.filter((ev) => Boolean(ev.acknowledgedAt))
                : allEvents;
            const { pageItems: pagedEvents, safePage: safeHistoryPage } = paginateItems(
              filteredEvents,
              historyPage,
              historyPageSize
            );

            return (
              <section className="bg-white overflow-hidden">
                <div className="px-5 py-4 bg-white flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className="text-[13px] font-semibold text-ink tracking-tight">
                      {t('configuration:notifications.historySection.heading', { count: allEvents.length })}
                    </h2>
                    <div
                      role="group"
                      aria-label={t('configuration:notifications.historySection.filterAria')}
                      className={ERP_SEGMENTED_GROUP_CLASS}
                    >
                      {(
                        [
                          { id: 'all', label: t('configuration:notifications.historySection.filterAll') },
                          { id: 'pending', label: t('configuration:notifications.historySection.filterPending') },
                          { id: 'ack', label: t('configuration:notifications.historySection.filterAck') },
                        ] as const
                      ).map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => {
                            setHistoryFilter(opt.id);
                            setHistoryPage(1);
                          }}
                          className={`px-2.5 py-1 text-[11px] font-medium transition-colors whitespace-nowrap cursor-pointer ${
                            historyFilter === opt.id
                              ? 'bg-brand text-white'
                              : 'text-slate-600 hover:bg-[#f4f6f9] hover:text-ink'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <span className="text-[11px] font-mono text-slate-500 tabular-nums">
                    {t('configuration:notifications.historySection.updatedAt', {
                      time: formatUtcTimestamp(state?.updatedAt),
                    })}
                  </span>
                </div>

                {allEvents.length === 0 ? (
                  <p className="text-xs text-slate-500 py-6 text-center">
                    {t('configuration:notifications.historySection.emptyAll')}
                  </p>
                ) : filteredEvents.length === 0 ? (
                  <p className="text-xs text-slate-500 py-6 text-center">
                    {t('configuration:notifications.historySection.emptyFiltered')}
                  </p>
                ) : (
                  <>
                    <div className="erp-table-scroll max-h-[580px] overflow-y-auto">
                      <table className="w-full min-w-[880px] text-left border-collapse text-xs">
                        <thead className={`sticky top-0 z-10 ${ERP_TABLE_HEAD_ROW_CLASS}`}>
                          <tr>
                            <th className="py-2.5 px-4">{t('configuration:notifications.historySection.colTimestamp')}</th>
                            <th className="py-2.5 px-3">{t('configuration:notifications.historySection.colAsset')}</th>
                            <th className="py-2.5 px-3">{t('configuration:notifications.historySection.colRuleValue')}</th>
                            <th className="py-2.5 px-3">{t('configuration:notifications.historySection.colDelivery')}</th>
                            <th className="py-2.5 px-3 text-right">{t('configuration:notifications.historySection.colStatus')}</th>
                            <th className="py-2.5 px-4 text-right w-14">{t('configuration:notifications.historySection.colActions')}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-hairline">
                          {pagedEvents.map((ev) => (
                            <tr
                              key={ev.id}
                              onClick={() => openEventDetails(ev)}
                              className="hover:bg-[#f8f9fb] cursor-pointer transition-colors"
                            >
                              <td className="py-2 px-4 font-mono text-[11px] text-slate-600 tabular-nums whitespace-nowrap">
                                {formatUtcTimestamp(ev.triggeredAt)}
                              </td>
                              <td className="py-2 px-3 font-mono text-slate-900 whitespace-nowrap">
                                {ev.machineId} <span className="text-slate-500">({ev.lineId})</span>
                              </td>
                              <td className="py-2 px-3 text-slate-800">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="font-medium">{ev.ruleName}</span>
                                  <span className="font-mono text-[11px] text-slate-600 tabular-nums">
                                    {ev.metric}={ev.observedValue}
                                  </span>
                                  {ev.acknowledgementNote && (
                                    <span
                                      title={ev.acknowledgementNote}
                                      className="inline-flex items-center gap-0.5 text-[10px] font-mono text-brand"
                                    >
                                      <MessageSquare className="w-3 h-3" />
                                      {t('configuration:notifications.historySection.noteTag')}
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="py-2 px-3 font-mono text-[11px] space-y-0.5">
                                {ev.deliveries.map((d, i) => (
                                  <div key={`${ev.id}-${i}`} className="text-slate-700">
                                    <span className="uppercase font-semibold">{d.channel}:</span>{' '}
                                    <span
                                      className={
                                        d.status === 'sent'
                                          ? 'text-emerald-700'
                                          : d.status === 'failed'
                                          ? 'text-red-700'
                                          : 'text-slate-500'
                                      }
                                    >
                                      {d.status}
                                    </span>
                                    {d.error ? <span className="text-slate-500"> ({d.error})</span> : null}
                                  </div>
                                ))}
                              </td>
                              <td className="py-2 px-3 text-right whitespace-nowrap">
                                {ev.acknowledgedAt ? (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      openEventDetails(ev);
                                    }}
                                    title={t('configuration:notifications.historySection.ackTooltip', {
                                      time: formatUtcTimestamp(ev.acknowledgedAt),
                                    })}
                                    className="inline-flex flex-col items-end text-right group cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand rounded"
                                  >
                                    <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 font-medium group-hover:underline">
                                      <CheckCircle2 className="w-3.5 h-3.5" />
                                      {t('configuration:notifications.historySection.ackBadge', {
                                        actor: ev.acknowledgedBy,
                                      })}
                                    </span>
                                    <span className="text-[10px] font-mono text-slate-500 tabular-nums">
                                      {formatUtcTimestamp(ev.acknowledgedAt)}
                                    </span>
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void handleAcknowledge(ev.id);
                                    }}
                                    className="px-2.5 py-1 text-[11px] font-medium bg-white hover:bg-[#f4f6f9] border border-hairline-strong rounded-[2px] text-slate-800 transition-colors cursor-pointer"
                                  >
                                    {t('configuration:notifications.historySection.ackButton')}
                                  </button>
                                )}
                              </td>
                              <td
                                className="py-2 px-4 text-right whitespace-nowrap"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <RowActionMenu
                                  ariaLabel={t('configuration:notifications.historySection.actionsAria', { id: ev.id })}
                                  items={[
                                    {
                                      id: 'details',
                                      label: t('configuration:notifications.historySection.viewDetails'),
                                      icon: <Eye className="w-3.5 h-3.5" />,
                                      onClick: () => openEventDetails(ev),
                                    },
                                    ev.acknowledgedAt
                                      ? {
                                          id: 'reopen',
                                          label: t('configuration:notifications.historySection.reopenPending'),
                                          icon: <RotateCcw className="w-3.5 h-3.5" />,
                                          tone: 'danger',
                                          dividerBefore: true,
                                          onClick: () => void handleReopenEvent(ev.id),
                                        }
                                      : {
                                          id: 'ack',
                                          label: t('configuration:notifications.historySection.ackAlert'),
                                          icon: <CheckCircle2 className="w-3.5 h-3.5" />,
                                          tone: 'primary',
                                          dividerBefore: true,
                                          onClick: () => void handleAcknowledge(ev.id),
                                        },
                                  ]}
                                />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <TablePagination
                      currentPage={safeHistoryPage}
                      totalItems={filteredEvents.length}
                      pageSize={historyPageSize}
                      maxVisiblePages={3}
                      onPageChange={setHistoryPage}
                      onPageSizeChange={setHistoryPageSize}
                      itemLabel={t('configuration:notifications.pagination.alerts')}
                    />
                  </>
                )}
              </section>
            );
          })()}
        </>
      )}

      {/* Right-Side Drawer: New Alert Rule */}
      <SlideOverDrawer
        open={ruleDrawerOpen}
        onClose={() => setRuleDrawerOpen(false)}
        title={t('configuration:notifications.ruleDrawer.title')}
        subtitle={t('configuration:notifications.ruleDrawer.subtitle')}
        size="md"
        footer={
          <>
            <button
              type="button"
              onClick={() => setRuleDrawerOpen(false)}
              className="px-3.5 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-[#f4f6f9] border border-hairline-strong rounded-[2px] transition-colors cursor-pointer"
            >
              {t('common:actions.cancel')}
            </button>
            <button
              type="submit"
              form="erp-alert-rule-form"
              className="px-4 py-1.5 text-xs font-medium text-white bg-brand hover:bg-brand-hover rounded-[2px] transition-colors cursor-pointer"
            >
              {t('configuration:notifications.ruleDrawer.createBtn')}
            </button>
          </>
        }
      >
        <form id="erp-alert-rule-form" onSubmit={handleCreateRule} className="space-y-4 text-xs">
          <div>
            <label className="block text-[11px] font-medium text-slate-700 mb-1">
              {t('configuration:notifications.ruleDrawer.name')}
            </label>
            <input
              type="text"
              value={ruleName}
              onChange={(e) => setRuleName(e.target.value)}
              placeholder={t('configuration:notifications.ruleDrawer.namePlaceholder')}
              className={ERP_INPUT_COMPACT_CLASS}
            />
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-700 mb-1">
              {t('configuration:notifications.ruleDrawer.metric')}
            </label>
            <select
              value={ruleMetric}
              onChange={(e) => setRuleMetric(e.target.value as AlertMetric)}
              className={ERP_INPUT_COMPACT_CLASS}
            >
              {METRIC_KEYS.map((metricKey) => (
                <option key={metricKey} value={metricKey}>
                  {t(`configuration:notifications.metrics.${metricKey}`)}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-slate-700 mb-1">
                {t('configuration:notifications.ruleDrawer.operator')}
              </label>
              <select
                value={ruleOperator}
                onChange={(e) => setRuleOperator(e.target.value as AlertOperator)}
                className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
              >
                {OPERATOR_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-700 mb-1">
                {t('configuration:notifications.ruleDrawer.threshold')}
              </label>
              <input
                type="number"
                step="any"
                value={ruleThreshold}
                onChange={(e) => setRuleThreshold(Number(e.target.value))}
                className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-slate-700 mb-1">
                {t('configuration:notifications.ruleDrawer.severity')}
              </label>
              <select
                value={ruleSeverity}
                onChange={(e) => setRuleSeverity(e.target.value as AlertSeverity)}
                className={ERP_INPUT_COMPACT_CLASS}
              >
                <option value="critical">{t('configuration:notifications.ruleDrawer.severityCritical')}</option>
                <option value="warning">{t('configuration:notifications.ruleDrawer.severityWarning')}</option>
                <option value="info">{t('configuration:notifications.ruleDrawer.severityInfo')}</option>
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-700 mb-1">
                {t('configuration:notifications.ruleDrawer.cooldown')}
              </label>
              <input
                type="number"
                min={10}
                max={3600}
                value={ruleCooldownSec}
                onChange={(e) => setRuleCooldownSec(Number(e.target.value))}
                className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
              />
            </div>
          </div>

          <div className="pt-2 border-t border-hairline space-y-2">
            <div className="text-[11px] font-medium text-slate-700">
              {t('configuration:notifications.ruleDrawer.dispatchChannels')}
            </div>
            <div className="flex items-center gap-5">
              <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={ruleUseEmail}
                  onChange={(e) => setRuleUseEmail(e.target.checked)}
                  className="rounded-[2px] border-hairline-strong accent-brand"
                />
                {t('configuration:notifications.ruleDrawer.channelEmail')}
              </label>
              <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={ruleUseWebhook}
                  onChange={(e) => setRuleUseWebhook(e.target.checked)}
                  className="rounded-[2px] border-hairline-strong accent-brand"
                />
                {t('configuration:notifications.ruleDrawer.channelWebhook')}
              </label>
            </div>
          </div>
        </form>
      </SlideOverDrawer>

      {/* Right-Side Drawer: Alert Event Details, Notes & Reopen */}
      {(() => {
        const selectedEvent =
          selectedEventId
            ? (state?.recentEvents ?? []).find((ev) => ev.id === selectedEventId) ?? null
            : null;
        const noteDirty =
          selectedEvent !== null &&
          eventNoteDraft.trim() !== (selectedEvent.acknowledgementNote ?? '').trim();

        return (
          <SlideOverDrawer
            open={Boolean(selectedEvent)}
            onClose={() => setSelectedEventId(null)}
            title={
              selectedEvent
                ? t('configuration:notifications.eventDrawer.title', {
                    machineId: selectedEvent.machineId,
                  })
                : t('configuration:notifications.eventDrawer.titleFallback')
            }
            subtitle={selectedEvent ? `${selectedEvent.ruleName} · ${selectedEvent.id}` : undefined}
            size="lg"
            footer={
              selectedEvent ? (
                <>
                  {selectedEvent.acknowledgedAt ? (
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={isUpdatingEvent}
                      onClick={() => void handleReopenEvent(selectedEvent.id, eventNoteDraft)}
                      className="mr-auto"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      {t('configuration:notifications.eventDrawer.reopenBtn')}
                    </Button>
                  ) : null}

                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={isUpdatingEvent || !noteDirty}
                    onClick={() => void handleSaveEventNote(selectedEvent.id, eventNoteDraft)}
                  >
                    <Save className="w-3.5 h-3.5" />
                    {t('configuration:notifications.eventDrawer.saveNoteBtn')}
                  </Button>

                  {!selectedEvent.acknowledgedAt ? (
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={isUpdatingEvent}
                      onClick={() => void handleAcknowledge(selectedEvent.id, eventNoteDraft)}
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      {t('configuration:notifications.eventDrawer.ackBtn')}
                    </Button>
                  ) : (
                    <Button variant="secondary" size="sm" onClick={() => setSelectedEventId(null)}>
                      {t('common:actions.close')}
                    </Button>
                  )}
                </>
              ) : null
            }
          >
            {selectedEvent && (
              <div className="space-y-4 text-xs">
                {/* Status Banner */}
                <div
                  className={`p-3 rounded-[2px] border ${
                    selectedEvent.acknowledgedAt
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-950'
                      : 'bg-amber-50 border-amber-200 text-amber-950'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-semibold flex items-center gap-1.5">
                      {selectedEvent.acknowledgedAt ? (
                        <>
                          <CheckCircle2 className="w-4 h-4 text-emerald-700" />
                          {t('configuration:notifications.eventDrawer.ackBy', {
                            actor: selectedEvent.acknowledgedBy,
                          })}
                        </>
                      ) : (
                        <>
                          <Clock className="w-4 h-4 text-amber-700" />
                          {t('configuration:notifications.eventDrawer.pendingAck')}
                        </>
                      )}
                    </div>
                    <span className="font-mono text-[11px] tabular-nums">
                      {selectedEvent.acknowledgedAt
                        ? `${formatUtcTimestamp(selectedEvent.acknowledgedAt)} UTC`
                        : t('configuration:notifications.eventDrawer.triggeredAtBanner', {
                            time: formatUtcTimestamp(selectedEvent.triggeredAt),
                          })}
                    </span>
                  </div>
                  {!selectedEvent.acknowledgedAt && selectedEvent.reopenedAt && (
                    <p className="mt-1 text-[11px] font-mono text-amber-900">
                      {t('configuration:notifications.eventDrawer.reopenedBanner', {
                        actor: selectedEvent.reopenedBy ?? 'operator',
                        time: formatUtcTimestamp(selectedEvent.reopenedAt),
                      })}
                    </p>
                  )}
                </div>

                {/* Telemetry & Rule Context */}
                <div className="border border-hairline rounded-[2px] overflow-hidden">
                  <div className="px-3 py-2 bg-[#f8f9fb] border-b border-hairline text-[11px] font-semibold uppercase tracking-wider text-slate-600">
                    {t('configuration:notifications.eventDrawer.triggerSummary')}
                  </div>
                  <dl className="divide-y divide-hairline text-xs">
                    <div className="px-3 py-2 grid grid-cols-3 gap-2">
                      <dt className="text-slate-500">
                        {t('configuration:notifications.eventDrawer.severity')}
                      </dt>
                      <dd
                        className={`col-span-2 font-mono font-semibold uppercase ${
                          selectedEvent.severity === 'critical'
                            ? 'text-red-700'
                            : selectedEvent.severity === 'warning'
                            ? 'text-amber-700'
                            : 'text-slate-700'
                        }`}
                      >
                        {selectedEvent.severity}
                      </dd>
                    </div>
                    <div className="px-3 py-2 grid grid-cols-3 gap-2">
                      <dt className="text-slate-500">
                        {t('configuration:notifications.eventDrawer.assetLine')}
                      </dt>
                      <dd className="col-span-2 font-mono text-ink">
                        {selectedEvent.machineId} · {selectedEvent.lineId} ({selectedEvent.machineType} / {selectedEvent.domain})
                      </dd>
                    </div>
                    <div className="px-3 py-2 grid grid-cols-3 gap-2">
                      <dt className="text-slate-500">
                        {t('configuration:notifications.eventDrawer.observedVsThreshold')}
                      </dt>
                      <dd className="col-span-2 font-mono tabular-nums text-ink">
                        <strong>{selectedEvent.metric} = {selectedEvent.observedValue}</strong>{' '}
                        <span className="text-slate-500">
                          {t('configuration:notifications.eventDrawer.thresholdLabel', {
                            threshold: selectedEvent.threshold,
                          })}
                        </span>
                      </dd>
                    </div>
                    <div className="px-3 py-2 grid grid-cols-3 gap-2">
                      <dt className="text-slate-500">
                        {t('configuration:notifications.eventDrawer.triggeredAt')}
                      </dt>
                      <dd className="col-span-2 font-mono tabular-nums text-slate-700">
                        {formatUtcTimestamp(selectedEvent.triggeredAt)} UTC
                      </dd>
                    </div>
                    <div className="px-3 py-2 grid grid-cols-3 gap-2">
                      <dt className="text-slate-500">
                        {t('configuration:notifications.eventDrawer.alertMessage')}
                      </dt>
                      <dd className="col-span-2 font-mono text-[11px] text-slate-800 break-words">
                        {selectedEvent.message}
                      </dd>
                    </div>
                  </dl>
                </div>

                {/* Operator Notes */}
                <div className="space-y-1.5">
                  <label
                    htmlFor="alert-event-note"
                    className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600"
                  >
                    {t('configuration:notifications.eventDrawer.operatorNotes')}
                  </label>
                  <textarea
                    id="alert-event-note"
                    rows={3}
                    value={eventNoteDraft}
                    onChange={(e) => setEventNoteDraft(e.target.value)}
                    placeholder={t('configuration:notifications.eventDrawer.operatorNotesPlaceholder')}
                    className={ERP_INPUT_CLASS}
                  />
                  <p className="text-[11px] text-slate-500">
                    {t('configuration:notifications.eventDrawer.operatorNotesHint')}
                  </p>
                </div>

                {/* Delivery Outcomes */}
                <div className="border border-hairline rounded-[2px] overflow-hidden">
                  <div className="px-3 py-2 bg-[#f8f9fb] border-b border-hairline text-[11px] font-semibold uppercase tracking-wider text-slate-600">
                    {t('configuration:notifications.eventDrawer.deliveriesHeading', {
                      count: selectedEvent.deliveries.length,
                    })}
                  </div>
                  <div className="divide-y divide-hairline">
                    {selectedEvent.deliveries.map((d, idx) => (
                      <div key={`${selectedEvent.id}-del-${idx}`} className="px-3 py-2 space-y-0.5 font-mono text-[11px]">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold uppercase text-slate-800">
                            {d.channel} ·{' '}
                            <span
                              className={
                                d.status === 'sent'
                                  ? 'text-emerald-700'
                                  : d.status === 'failed'
                                  ? 'text-red-700'
                                  : 'text-slate-500'
                              }
                            >
                              {d.status}
                            </span>
                          </span>
                          <span className="text-slate-500 tabular-nums">{formatUtcTimestamp(d.sentAt)} UTC</span>
                        </div>
                        <div className="text-slate-600 break-all">
                          {t('configuration:notifications.eventDrawer.targetLabel')} {d.target}
                        </div>
                        {d.messageId && (
                          <div className="text-slate-500 break-all">
                            {t('configuration:notifications.eventDrawer.messageIdLabel')} {d.messageId}
                          </div>
                        )}
                        {d.httpStatus != null && (
                          <div className="text-slate-500">
                            {t('configuration:notifications.eventDrawer.httpStatusLabel')} {d.httpStatus}
                          </div>
                        )}
                        {d.error && (
                          <div className="text-red-700 break-words">
                            {t('configuration:notifications.eventDrawer.errorLabel')} {d.error}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Action History Timeline */}
                {selectedEvent.actionHistory && selectedEvent.actionHistory.length > 0 && (
                  <div className="border border-hairline rounded-[2px] overflow-hidden">
                    <div className="px-3 py-2 bg-[#f8f9fb] border-b border-hairline text-[11px] font-semibold uppercase tracking-wider text-slate-600">
                      {t('configuration:notifications.eventDrawer.timelineHeading', {
                        count: selectedEvent.actionHistory.length,
                      })}
                    </div>
                    <ul className="divide-y divide-hairline">
                      {[...selectedEvent.actionHistory].reverse().map((item, idx) => (
                        <li key={`${item.at}-${idx}`} className="px-3 py-2 space-y-0.5">
                          <div className="flex items-center justify-between gap-2 text-[11px]">
                            <span className="font-mono font-semibold text-slate-800">
                              {item.action === 'acknowledged'
                                ? t('configuration:notifications.eventDrawer.actionAcknowledged')
                                : item.action === 'reopened'
                                ? t('configuration:notifications.eventDrawer.actionReopened')
                                : t('configuration:notifications.eventDrawer.actionNoteUpdated')}{' '}
                              <span className="font-normal text-slate-600">
                                {t('configuration:notifications.eventDrawer.byActor', { actor: item.actor })}
                              </span>
                            </span>
                            <span className="font-mono text-slate-500 tabular-nums">
                              {formatUtcTimestamp(item.at)} UTC
                            </span>
                          </div>
                          {item.note && <p className="text-xs text-slate-700">{item.note}</p>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </SlideOverDrawer>
        );
      })()}
    </div>
  );
}
