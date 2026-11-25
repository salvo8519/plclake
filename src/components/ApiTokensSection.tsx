import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  AlertCircle,
  Check,
  Copy,
  ExternalLink,
  FileText,
  FlaskConical,
  KeyRound,
  Lock,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  ShieldOff,
  Terminal,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SupportedLanguage } from '../i18n/types';
import type {
  ApiTokenIssueResponse,
  ApiTokenListResponse,
  ApiTokenPublic,
  ApiTokenScope,
  SessionUserInfo,
  UserAccountPublic,
} from '../types/pipeline';
import {
  ERP_INPUT_CLASS,
  ERP_INPUT_COMPACT_CLASS,
  ERP_TABLE_HEAD_ROW_CLASS,
} from '../theme/tokens';
import { apiFetch } from '../utils/apiAuth';
import { extractErrorMessage, formatUtcTimestamp } from '../utils/formatters';
import {
  Button,
  DEFAULT_TABLE_PAGE_SIZE,
  ErpCheckbox,
  paginateItems,
  RowActionMenu,
  SectionCard,
  SectionHeader,
  SlideOverDrawer,
  StatusBanner,
  TablePagination,
} from './ui';

interface ApiTokensSectionProps {
  currentUser: SessionUserInfo | null;
  activeLang: SupportedLanguage;
  onInspectAuditTrail: (actionFilter: string) => void;
}

const ALL_SCOPES: ApiTokenScope[] = ['read', 'edge', 'admin'];

type StatusFilter = 'all' | 'active' | 'inactive';

export function ApiTokensSection({
  currentUser,
  activeLang,
  onInspectAuditTrail,
}: ApiTokensSectionProps) {
  const { t } = useTranslation(['administration', 'common']);

  const [tokens, setTokens] = useState<ApiTokenPublic[]>([]);
  const [summary, setSummary] = useState<ApiTokenListResponse['summary']>({
    total: 0,
    active: 0,
    expiringSoon: 0,
    revokedOrExpired: 0,
    totalUsageCount: 0,
  });
  const [users, setUsers] = useState<UserAccountPublic[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Newly issued plaintext key (shown once in secure reveal banner)
  const [revealedSecret, setRevealedSecret] = useState<{
    token: string;
    record: ApiTokenPublic;
  } | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [copiedCurl, setCopiedCurl] = useState(false);

  // Filter & pagination state
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [currentPage, setCurrentPage] = useState(1);

  // Issue drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formOwnerId, setFormOwnerId] = useState('');
  const [formScopes, setFormScopes] = useState<ApiTokenScope[]>(['read']);
  const [formTtlHours, setFormTtlHours] = useState<string>('2160'); // 90d default
  const [isIssuing, setIsIssuing] = useState(false);
  const [isMintingSandbox, setIsMintingSandbox] = useState(false);
  const [drawerError, setDrawerError] = useState<string | null>(null);

  const isAdminSession = !currentUser || currentUser.role === 'admin';

  const loadAll = useCallback(async () => {
    setIsLoading(true);
    try {
      const [tokensRes, usersRes] = await Promise.all([
        apiFetch('/api/v1/tokens'),
        apiFetch('/api/v1/users'),
      ]);
      if (tokensRes.ok) {
        const data = (await tokensRes.json()) as ApiTokenListResponse;
        setTokens(data.tokens ?? []);
        if (data.summary) setSummary(data.summary);
      } else {
        setBanner({
          kind: 'err',
          text: t('administration:tokens.messages.errLoad', { status: tokensRes.status }),
        });
      }
      if (usersRes.ok) {
        const uData = (await usersRes.json()) as { users: UserAccountPublic[] };
        const activeUsers = (uData.users ?? []).filter((u) => u.active);
        setUsers(activeUsers);
      }
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const filteredTokens = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return tokens.filter((item) => {
      if (statusFilter === 'active' && item.status !== 'active') return false;
      if (statusFilter === 'inactive' && item.status === 'active') return false;
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        item.tokenPrefix.toLowerCase().includes(q) ||
        item.ownerEmail.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        item.scopes.some((s) => s.toLowerCase().includes(q))
      );
    });
  }, [tokens, searchQuery, statusFilter]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, statusFilter]);

  const { pageItems: pagedTokens, safePage } = paginateItems(
    filteredTokens,
    currentPage,
    DEFAULT_TABLE_PAGE_SIZE
  );

  const openIssueDrawer = () => {
    setFormName('');
    setFormDescription('');
    const defaultOwner =
      users.find((u) => currentUser && u.id === currentUser.id)?.id ??
      users.find((u) => u.role === 'admin')?.id ??
      users[0]?.id ??
      '';
    setFormOwnerId(defaultOwner);
    setFormScopes(['read']);
    setFormTtlHours('2160');
    setDrawerError(null);
    setDrawerOpen(true);
  };

  const toggleFormScope = (scope: ApiTokenScope) => {
    setFormScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]
    );
  };

  const handleIssueKey = async (e: FormEvent) => {
    e.preventDefault();
    setDrawerError(null);
    const trimmedName = formName.trim();
    if (trimmedName.length < 2) {
      setDrawerError(t('administration:tokens.messages.errNameRequired'));
      return;
    }
    if (formScopes.length === 0) {
      setDrawerError(t('administration:tokens.messages.errScopeRequired'));
      return;
    }

    setIsIssuing(true);
    setBanner(null);
    try {
      const ttlHours = formTtlHours === 'never' ? null : Number(formTtlHours);
      const resp = await apiFetch('/api/v1/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmedName,
          description: formDescription.trim(),
          scopes: formScopes,
          ownerUserId: formOwnerId || undefined,
          ttlHours,
        }),
      });
      const payload = (await resp.json().catch(() => ({}))) as Partial<ApiTokenIssueResponse> & {
        error?: string;
      };
      if (!resp.ok || !payload.token || !payload.record) {
        throw new Error(
          payload.error || t('administration:tokens.messages.errIssue', { status: resp.status })
        );
      }

      setRevealedSecret({ token: payload.token, record: payload.record });
      setCopiedKey(false);
      setCopiedCurl(false);
      setDrawerOpen(false);
      setBanner({
        kind: 'ok',
        text: t('administration:tokens.messages.issuedOk', { name: payload.record.name }),
      });
      await loadAll();
    } catch (err) {
      setDrawerError(extractErrorMessage(err, t('administration:tokens.messages.errIssue', { status: 400 })));
    } finally {
      setIsIssuing(false);
    }
  };

  const handleMintSandbox = async () => {
    setIsMintingSandbox(true);
    setBanner(null);
    try {
      const resp = await apiFetch('/api/v1/tokens/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role: currentUser?.role ?? 'admin',
          name: `Scalar Sandbox (${currentUser?.role ?? 'admin'})`,
        }),
      });
      const payload = (await resp.json().catch(() => ({}))) as Partial<ApiTokenIssueResponse> & {
        error?: string;
      };
      if (!resp.ok || !payload.token || !payload.record) {
        throw new Error(
          payload.error || t('administration:tokens.messages.errSandbox', { status: resp.status })
        );
      }
      setRevealedSecret({ token: payload.token, record: payload.record });
      setCopiedKey(false);
      setCopiedCurl(false);
      setBanner({
        kind: 'ok',
        text: t('administration:tokens.messages.sandboxOk', { name: payload.record.name }),
      });
      await loadAll();
    } catch (err) {
      setBanner({
        kind: 'err',
        text: extractErrorMessage(err, t('administration:tokens.messages.errSandbox', { status: 400 })),
      });
    } finally {
      setIsMintingSandbox(false);
    }
  };

  const handleRotateKey = async (item: ApiTokenPublic) => {
    setBanner(null);
    try {
      const resp = await apiFetch(`/api/v1/tokens/${encodeURIComponent(item.id)}/rotate`, {
        method: 'POST',
      });
      const payload = (await resp.json().catch(() => ({}))) as Partial<ApiTokenIssueResponse> & {
        error?: string;
      };
      if (!resp.ok || !payload.token || !payload.record) {
        throw new Error(
          payload.error || t('administration:tokens.messages.errRotate', { status: resp.status })
        );
      }
      setRevealedSecret({ token: payload.token, record: payload.record });
      setCopiedKey(false);
      setCopiedCurl(false);
      setBanner({
        kind: 'ok',
        text: t('administration:tokens.messages.rotatedOk', { name: payload.record.name }),
      });
      await loadAll();
    } catch (err) {
      setBanner({
        kind: 'err',
        text: extractErrorMessage(err, t('administration:tokens.messages.errRotate', { status: 400 })),
      });
    }
  };

  const handleRevokeKey = async (item: ApiTokenPublic) => {
    setBanner(null);
    try {
      const resp = await apiFetch(`/api/v1/tokens/${encodeURIComponent(item.id)}`, {
        method: 'DELETE',
      });
      const payload = (await resp.json().catch(() => ({}))) as { error?: string };
      if (!resp.ok) {
        throw new Error(
          payload.error || t('administration:tokens.messages.errRevoke', { status: resp.status })
        );
      }
      if (revealedSecret?.record.id === item.id) {
        setRevealedSecret(null);
      }
      setBanner({
        kind: 'ok',
        text: t('administration:tokens.messages.revokedOk', { name: item.name }),
      });
      await loadAll();
    } catch (err) {
      setBanner({
        kind: 'err',
        text: extractErrorMessage(err, t('administration:tokens.messages.errRevoke', { status: 400 })),
      });
    }
  };

  const copyToClipboard = async (text: string, onDone: () => void) => {
    try {
      await navigator.clipboard.writeText(text);
      onDone();
    } catch {
      // Fallback for restricted clipboard contexts
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      onDone();
    }
  };

  const scalarOrigin = typeof window !== 'undefined' ? window.location.origin : '';
  const revealedScalarHref = revealedSecret
    ? `/api/v1/docs?lang=${activeLang}#token=${encodeURIComponent(revealedSecret.token)}`
    : `/api/v1/docs?lang=${activeLang}`;

  return (
    <div className="space-y-5">
      {/* 4-Column Architectural KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-px bg-hairline border border-hairline rounded-[2px] overflow-hidden">
        <div className="bg-white px-5 py-4">
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-500">
            {t('administration:tokens.kpi.activeKeys')}
          </div>
          <div className="mt-1.5 text-2xl font-mono font-semibold text-ink tabular-nums">
            {summary.active}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            {t('administration:tokens.kpi.activeSub')}
          </div>
        </div>

        <div className="bg-white px-5 py-4">
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-500">
            {t('administration:tokens.kpi.totalCalls')}
          </div>
          <div className="mt-1.5 text-2xl font-mono font-semibold text-brand tabular-nums">
            {summary.totalUsageCount.toLocaleString()}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            {t('administration:tokens.kpi.totalCallsSub')}
          </div>
        </div>

        <div className="bg-white px-5 py-4">
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-500">
            {t('administration:tokens.kpi.expiringSoon')}
          </div>
          <div
            className={`mt-1.5 text-2xl font-mono font-semibold tabular-nums ${
              summary.expiringSoon > 0 ? 'text-accent-text' : 'text-ink'
            }`}
          >
            {summary.expiringSoon}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            {t('administration:tokens.kpi.expiringSoonSub')}
          </div>
        </div>

        <div className="bg-white px-5 py-4">
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-500">
            {t('administration:tokens.kpi.revokedExpired')}
          </div>
          <div className="mt-1.5 text-2xl font-mono font-semibold text-slate-600 tabular-nums">
            {summary.revokedOrExpired}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            {t('administration:tokens.kpi.revokedExpiredSub')}
          </div>
        </div>
      </div>

      {/* Show-Once Newly Issued Plaintext Key Banner */}
      {revealedSecret && (
        <div
          role="region"
          aria-label={t('administration:tokens.reveal.title')}
          className="bg-chrome text-slate-100 border-l-[3px] border-accent rounded-[2px] px-5 py-4 space-y-3"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.06em] text-accent">
                <KeyRound className="w-3.5 h-3.5 shrink-0" />
                <span>{t('administration:tokens.reveal.title')}</span>
                <span className="font-mono text-slate-400 font-normal normal-case tracking-normal">
                  · {revealedSecret.record.name}
                </span>
              </div>
              <p className="text-xs text-slate-300 mt-1">
                {t('administration:tokens.reveal.warning')}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setRevealedSecret(null)}
              aria-label={t('administration:tokens.reveal.dismiss')}
              className="p-1 text-slate-400 hover:text-white rounded-[2px] cursor-pointer shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="bg-[#071019] border border-slate-700/80 rounded-[2px] px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-3">
            <code className="font-mono text-xs text-[#e5c886] break-all select-all">
              {revealedSecret.token}
            </code>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() =>
                  void copyToClipboard(revealedSecret.token, () => {
                    setCopiedKey(true);
                    window.setTimeout(() => setCopiedKey(false), 2000);
                  })
                }
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium bg-accent text-chrome hover:bg-[#d4b36d] rounded-[2px] cursor-pointer transition-colors"
              >
                {copiedKey ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedKey
                  ? t('administration:tokens.reveal.copiedKey')
                  : t('administration:tokens.reveal.copyKey')}
              </button>

              <button
                type="button"
                onClick={() => {
                  const curlCmd = `curl -sS -H "X-API-Key: ${revealedSecret.token}" "${scalarOrigin}/api/v1/auth/whoami"`;
                  void copyToClipboard(curlCmd, () => {
                    setCopiedCurl(true);
                    window.setTimeout(() => setCopiedCurl(false), 2000);
                  });
                }}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-600 rounded-[2px] cursor-pointer transition-colors"
              >
                {copiedCurl ? <Check className="w-3.5 h-3.5" /> : <Terminal className="w-3.5 h-3.5" />}
                {copiedCurl
                  ? t('administration:tokens.reveal.copiedCurl')
                  : t('administration:tokens.reveal.copyCurl')}
              </button>

              <a
                href={revealedScalarHref}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-white bg-brand hover:bg-brand-hover border border-brand-hover rounded-[2px] transition-colors"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                {t('administration:tokens.reveal.testInScalar')}
              </a>
            </div>
          </div>
        </div>
      )}

      {banner && (
        <StatusBanner
          kind={banner.kind}
          message={banner.text}
          onDismiss={() => setBanner(null)}
        />
      )}

      {/* Main Borderless Editorial Table Card */}
      <SectionCard borderless>
        <SectionHeader
          as="h1"
          icon={<KeyRound className="w-4 h-4" />}
          title={t('administration:tokens.title')}
          subtitle={t('administration:tokens.subtitle')}
          actions={
            <>
              {!isAdminSession && (
                <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-600 mr-1 whitespace-nowrap">
                  <Lock className="w-3.5 h-3.5 text-slate-500" />
                  {t('administration:tokens.readOnlyHint')}
                </span>
              )}

              <Button variant="secondary" size="sm" onClick={() => void loadAll()}>
                <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
                {t('common:actions.refresh')}
              </Button>

              <a
                href={`/api/v1/docs?lang=${activeLang}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-ink bg-white hover:bg-[#f4f6f9] border border-hairline-strong rounded-[2px] whitespace-nowrap transition-colors"
              >
                <ExternalLink className="w-3.5 h-3.5 text-slate-500" />
                {t('administration:tokens.openScalar')}
              </a>

              <Button
                variant="secondary"
                size="sm"
                disabled={isMintingSandbox}
                onClick={() => void handleMintSandbox()}
              >
                <FlaskConical className="w-3.5 h-3.5 text-accent-text" />
                {isMintingSandbox
                  ? t('administration:tokens.mintingSandbox')
                  : t('administration:tokens.mintSandbox')}
              </Button>

              <Button
                variant="primary"
                size="sm"
                disabled={!isAdminSession}
                onClick={openIssueDrawer}
              >
                <Plus className="w-3.5 h-3.5" />
                {t('administration:tokens.issueKey')}
              </Button>
            </>
          }
        />

        {/* Filter & Status Bar */}
        <div className="px-5 py-3 bg-white flex flex-wrap items-center justify-between gap-3">
          <div className="relative w-full sm:w-80">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('administration:tokens.filters.searchPlaceholder')}
              aria-label={t('administration:tokens.filters.searchAria')}
              className={`${ERP_INPUT_COMPACT_CLASS} pl-8`}
            />
          </div>

          <div className="inline-flex border border-hairline-strong rounded-[2px] overflow-hidden bg-white">
            {(['all', 'active', 'inactive'] as StatusFilter[]).map((key) => {
              const selected = statusFilter === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setStatusFilter(key)}
                  className={`px-3 py-1.5 text-xs font-medium cursor-pointer transition-colors ${
                    selected
                      ? 'bg-brand text-white'
                      : 'text-slate-600 hover:bg-[#f8f9fa] hover:text-ink'
                  }`}
                >
                  {t(`administration:tokens.filters.${key}`)}
                </button>
              );
            })}
          </div>
        </div>

        {/* Borderless Editorial Table */}
        <div className="erp-table-scroll">
          <table className="w-full min-w-[960px] text-left border-collapse text-xs">
            <thead>
              <tr className={ERP_TABLE_HEAD_ROW_CLASS}>
                <th className="py-2.5 px-5">{t('administration:tokens.table.colName')}</th>
                <th className="py-2.5 px-3">{t('administration:tokens.table.colOwner')}</th>
                <th className="py-2.5 px-3">{t('administration:tokens.table.colScopes')}</th>
                <th className="py-2.5 px-3">{t('administration:tokens.table.colStatus')}</th>
                <th className="py-2.5 px-3">{t('administration:tokens.table.colUsage')}</th>
                <th className="py-2.5 px-3">{t('administration:tokens.table.colExpiry')}</th>
                <th className="py-2.5 px-5 text-right">{t('administration:tokens.table.colActions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {filteredTokens.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-slate-500">
                    {isLoading
                      ? t('administration:tokens.table.loading')
                      : tokens.length === 0
                      ? t('administration:tokens.table.emptyInitial')
                      : t('administration:tokens.table.empty')}
                  </td>
                </tr>
              ) : (
                pagedTokens.map((item) => {
                  const isActive = item.status === 'active';
                  return (
                    <tr key={item.id} className="hover:bg-[#f8f9fb] transition-colors">
                      <td className="py-3 px-5">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-ink">{item.name}</span>
                          {item.isSandbox && (
                            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-accent-text border border-accent/50 bg-[#faf6ec] px-1.5 py-0.5 rounded-[2px]">
                              {t('administration:tokens.table.sandboxTag')}
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-[11px]">
                          <code className="font-mono text-slate-600">{item.tokenPrefix}••••</code>
                          {item.description && (
                            <span className="text-slate-500 truncate max-w-[260px]">
                              · {item.description}
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="py-3 px-3 whitespace-nowrap">
                        <div className="font-mono text-ink">{item.ownerEmail}</div>
                        <div className="text-[11px] font-mono text-slate-500">
                          {item.ownerRole}
                        </div>
                      </td>

                      <td className="py-3 px-3 whitespace-nowrap">
                        <div className="flex flex-wrap gap-1.5">
                          {item.scopes.map((scope) => (
                            <span
                              key={scope}
                              className={`font-mono text-[10px] font-semibold uppercase tracking-[0.04em] px-1.5 py-0.5 rounded-[2px] border ${
                                scope === 'admin'
                                  ? 'text-brand border-brand/30 bg-[#eef3f8]'
                                  : scope === 'edge'
                                  ? 'text-accent-text border-accent/50 bg-[#faf6ec]'
                                  : 'text-slate-700 border-hairline-strong bg-[#f8f9fa]'
                              }`}
                            >
                              {scope}
                            </span>
                          ))}
                        </div>
                      </td>

                      <td className="py-3 px-3 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase ${
                            item.status === 'active'
                              ? 'text-emerald-700'
                              : item.status === 'expired'
                              ? 'text-amber-700'
                              : 'text-slate-500'
                          }`}
                        >
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${
                              item.status === 'active'
                                ? 'bg-emerald-600'
                                : item.status === 'expired'
                                ? 'bg-amber-500'
                                : 'bg-slate-400'
                            }`}
                          />
                          {t(`administration:tokens.status.${item.status}`)}
                        </span>
                      </td>

                      <td className="py-3 px-3 whitespace-nowrap tabular-nums">
                        <div className="font-mono text-ink">
                          {t('administration:tokens.table.callsCount', {
                            count: item.usageCount,
                          })}
                        </div>
                        <div className="text-[11px] font-mono text-slate-500">
                          {item.lastUsedAt
                            ? `${formatUtcTimestamp(item.lastUsedAt)}${
                                item.lastUsedIp ? ` · ${item.lastUsedIp}` : ''
                              }`
                            : t('administration:tokens.table.neverUsed')}
                        </div>
                      </td>

                      <td className="py-3 px-3 font-mono text-[11px] text-slate-600 whitespace-nowrap tabular-nums">
                        {item.expiresAt
                          ? formatUtcTimestamp(item.expiresAt)
                          : t('administration:tokens.table.noExpiry')}
                      </td>

                      <td className="py-3 px-5 text-right whitespace-nowrap">
                        <RowActionMenu
                          ariaLabel={t('administration:tokens.table.actionsAria', {
                            name: item.name,
                          })}
                          items={[
                            {
                              id: 'rotate',
                              label: t('administration:tokens.table.rotateKey'),
                              icon: <RotateCw className="w-3.5 h-3.5" />,
                              disabled: !isAdminSession || !isActive,
                              onClick: () => void handleRotateKey(item),
                            },
                            {
                              id: 'copy-prefix',
                              label: t('administration:tokens.table.copyPrefix'),
                              icon: <Copy className="w-3.5 h-3.5" />,
                              onClick: () =>
                                void copyToClipboard(item.tokenPrefix, () => {
                                  setBanner({
                                    kind: 'ok',
                                    text: t('administration:tokens.messages.prefixCopied', {
                                      prefix: item.tokenPrefix,
                                    }),
                                  });
                                }),
                            },
                            {
                              id: 'inspect-audit',
                              label: t('administration:tokens.table.inspectAudit'),
                              icon: <FileText className="w-3.5 h-3.5" />,
                              onClick: () => onInspectAuditTrail('token'),
                            },
                            {
                              id: 'revoke',
                              label: t('administration:tokens.table.revokeKey'),
                              icon: <ShieldOff className="w-3.5 h-3.5" />,
                              tone: 'danger',
                              dividerBefore: true,
                              disabled: !isAdminSession || !isActive,
                              onClick: () => void handleRevokeKey(item),
                            },
                          ]}
                        />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {filteredTokens.length > 0 && (
          <TablePagination
            currentPage={safePage}
            totalItems={filteredTokens.length}
            pageSize={DEFAULT_TABLE_PAGE_SIZE}
            maxVisiblePages={3}
            onPageChange={setCurrentPage}
            itemLabel={t('administration:tokens.pagination.keys')}
          />
        )}
      </SectionCard>

      {/* Slide-Over Drawer: Issue New Managed X-API-Key */}
      <SlideOverDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={t('administration:tokens.drawer.title')}
        subtitle={t('administration:tokens.drawer.subtitle')}
        size="md"
        footer={
          <>
            <Button
              variant="secondary"
              size="md"
              onClick={() => setDrawerOpen(false)}
              disabled={isIssuing}
            >
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="primary"
              size="md"
              type="submit"
              form="issue-api-key-form"
              disabled={isIssuing}
            >
              <KeyRound className="w-3.5 h-3.5" />
              {isIssuing
                ? t('administration:tokens.drawer.submitting')
                : t('administration:tokens.drawer.submit')}
            </Button>
          </>
        }
      >
        <form id="issue-api-key-form" onSubmit={(e) => void handleIssueKey(e)} className="space-y-5">
          {drawerError && (
            <div className="px-3.5 py-2.5 bg-red-50 border border-red-200 rounded-[2px] text-xs text-red-900 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 text-red-600" />
              <span>{drawerError}</span>
            </div>
          )}

          <div>
            <label
              htmlFor="api-key-name"
              className="block text-xs font-medium text-ink mb-1.5"
            >
              {t('administration:tokens.drawer.keyName')}
            </label>
            <input
              id="api-key-name"
              type="text"
              required
              minLength={2}
              maxLength={80}
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder={t('administration:tokens.drawer.keyNamePlaceholder')}
              className={ERP_INPUT_CLASS}
            />
          </div>

          <div>
            <label
              htmlFor="api-key-description"
              className="block text-xs font-medium text-ink mb-1.5"
            >
              {t('administration:tokens.drawer.description')}
            </label>
            <input
              id="api-key-description"
              type="text"
              maxLength={240}
              value={formDescription}
              onChange={(e) => setFormDescription(e.target.value)}
              placeholder={t('administration:tokens.drawer.descriptionPlaceholder')}
              className={ERP_INPUT_CLASS}
            />
          </div>

          <div>
            <label
              htmlFor="api-key-owner"
              className="block text-xs font-medium text-ink mb-1.5"
            >
              {t('administration:tokens.drawer.owner')}
            </label>
            <select
              id="api-key-owner"
              value={formOwnerId}
              onChange={(e) => setFormOwnerId(e.target.value)}
              className={ERP_INPUT_CLASS}
            >
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.fullName} — {u.email} ({u.role})
                </option>
              ))}
            </select>
          </div>

          <div>
            <div className="text-xs font-medium text-ink mb-2">
              {t('administration:tokens.drawer.scopesLabel')}
            </div>
            <div className="divide-y divide-hairline border border-hairline rounded-[2px]">
              {ALL_SCOPES.map((scope) => {
                const checked = formScopes.includes(scope);
                return (
                  <label
                    key={scope}
                    className="flex items-start gap-3 px-3.5 py-2.5 hover:bg-[#f8f9fa] cursor-pointer"
                  >
                    <div className="pt-0.5">
                      <ErpCheckbox
                        checked={checked}
                        ariaLabel={scope}
                        onChange={() => toggleFormScope(scope)}
                      />
                    </div>
                    <div className="min-w-0">
                      <div className="font-mono text-xs font-semibold uppercase text-ink">
                        {t(`administration:tokens.scopes.${scope}`)}
                      </div>
                      <div className="text-[11px] text-slate-600 mt-0.5">
                        {t(`administration:tokens.scopes.${scope}Desc`)}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          <div>
            <label
              htmlFor="api-key-ttl"
              className="block text-xs font-medium text-ink mb-1.5"
            >
              {t('administration:tokens.drawer.ttlLabel')}
            </label>
            <select
              id="api-key-ttl"
              value={formTtlHours}
              onChange={(e) => setFormTtlHours(e.target.value)}
              className={ERP_INPUT_CLASS}
            >
              <option value="1">{t('administration:tokens.drawer.ttl1h')}</option>
              <option value="24">{t('administration:tokens.drawer.ttl24h')}</option>
              <option value="168">{t('administration:tokens.drawer.ttl7d')}</option>
              <option value="720">{t('administration:tokens.drawer.ttl30d')}</option>
              <option value="2160">{t('administration:tokens.drawer.ttl90d')}</option>
              <option value="8760">{t('administration:tokens.drawer.ttl365d')}</option>
              <option value="never">{t('administration:tokens.drawer.ttlNever')}</option>
            </select>
          </div>
        </form>
      </SlideOverDrawer>
    </div>
  );
}
