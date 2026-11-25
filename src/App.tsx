import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Bell,
  BookOpen,
  Cpu,
  ExternalLink,
  FileText,
  KeyRound,
  Layers,
  LogIn,
  LogOut,
  Menu,
  Network,
  Pin,
  PinOff,
  Settings2,
  ShieldCheck,
  UserCircle2,
  Users,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { BrandMark, LanguageSwitcher } from './components/ui';
import { WorkbenchSection } from './components/WorkbenchSection';
import {
  APP_CHANNEL,
  APP_NAME,
  APP_VERSION_TAG,
  type RuntimeVersionInfo,
} from './config/appMeta';

const ApiTokensSection = lazy(() =>
  import('./components/ApiTokensSection').then((m) => ({ default: m.ApiTokensSection }))
);
const AuditLogSection = lazy(() =>
  import('./components/AuditLogSection').then((m) => ({ default: m.AuditLogSection }))
);
const ConnectionsSection = lazy(() =>
  import('./components/ConnectionsSection').then((m) => ({ default: m.ConnectionsSection }))
);
const FleetEvaluationSection = lazy(() =>
  import('./components/FleetEvaluationSection').then((m) => ({ default: m.FleetEvaluationSection }))
);
const JobConfigSection = lazy(() =>
  import('./components/JobConfigSection').then((m) => ({ default: m.JobConfigSection }))
);
const LoginScreen = lazy(() =>
  import('./components/LoginScreen').then((m) => ({ default: m.LoginScreen }))
);
const NotificationsSection = lazy(() =>
  import('./components/NotificationsSection').then((m) => ({ default: m.NotificationsSection }))
);
const PlcCatalogSection = lazy(() =>
  import('./components/PlcCatalogSection').then((m) => ({ default: m.PlcCatalogSection }))
);
const RolesSection = lazy(() =>
  import('./components/RolesSection').then((m) => ({ default: m.RolesSection }))
);
const UsersSection = lazy(() =>
  import('./components/UsersSection').then((m) => ({ default: m.UsersSection }))
);
import { normalizeLanguage } from './i18n/types';
import type {
  AppViewId,
  AuthMeResponse,
  JobConfig,
  JobConfigResponse,
  LiveRunConfig,
  LiveRunSnapshot,
  PlcCatalogListResponse,
  RolePermissionPolicy,
  SessionUserInfo,
} from './types/pipeline';
import { apiFetch, setSessionApiKey } from './utils/apiAuth';

interface NavGroup {
  key: 'operations' | 'configuration' | 'administration';
  items: Array<{ id: AppViewId; icon: typeof Activity }>;
}

const NAV_GROUPS: NavGroup[] = [
  {
    key: 'operations',
    items: [
      { id: 'workbench', icon: Activity },
      { id: 'fleet', icon: Cpu },
      { id: 'connections', icon: Network },
    ],
  },
  {
    key: 'configuration',
    items: [
      { id: 'plc_catalog', icon: Layers },
      { id: 'job_config', icon: Settings2 },
      { id: 'notifications', icon: Bell },
    ],
  },
  {
    key: 'administration',
    items: [
      { id: 'users', icon: Users },
      { id: 'roles', icon: ShieldCheck },
      { id: 'tokens', icon: KeyRound },
      { id: 'audit', icon: FileText },
    ],
  },
];

const ALL_NAV_ITEMS = NAV_GROUPS.flatMap((g) =>
  g.items.map((item) => ({ ...item, groupKey: g.key }))
);

const FULL_PERMISSIONS: RolePermissionPolicy = {
  allowedViews: ALL_NAV_ITEMS.map((n) => n.id),
  canControlSimulation: true,
  canWriteConfig: true,
  canManageAlerts: true,
  canManageUsers: true,
};

const INITIAL_JOB_CONFIG: JobConfig = {
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

export default function App() {
  const { t, i18n } = useTranslation('common');
  const activeLang = normalizeLanguage(i18n.resolvedLanguage ?? i18n.language);
  const [activeView, setActiveView] = useState<AppViewId>('workbench');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [sidebarPinned, setSidebarPinned] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem('telemetry_erp_sidebar_pinned') === 'true';
    } catch {
      return false;
    }
  });
  const [sidebarHovered, setSidebarHovered] = useState(false);
  const [selectedCatalogPlc, setSelectedCatalogPlc] = useState<string | null>(null);
  const [auditActionFilter, setAuditActionFilter] = useState<string>('');

  const toggleSidebarPin = useCallback(() => {
    setSidebarPinned((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem('telemetry_erp_sidebar_pinned', String(next));
      } catch {
        // Ignore storage quota / privacy mode errors
      }
      if (!next) {
        setSidebarHovered(false);
      }
      return next;
    });
  }, []);

  // Auth & Role Permissions state
  const [authReady, setAuthReady] = useState(false);
  const [authEnforced, setAuthEnforced] = useState(false);
  const [currentUser, setCurrentUser] = useState<SessionUserInfo | null>(null);
  const [permissions, setPermissions] = useState<RolePermissionPolicy>(FULL_PERMISSIONS);
  const [showLoginModal, setShowLoginModal] = useState(false);

  const [jobConfig, setJobConfig] = useState<JobConfig>(INITIAL_JOB_CONFIG);
  const [jobConfigUpdatedAt, setJobConfigUpdatedAt] = useState<string | null>(null);
  const [isSavingJobConfig, setIsSavingJobConfig] = useState(false);

  const [plcCatalog, setPlcCatalog] = useState<PlcCatalogListResponse | null>(null);

  const [liveRun, setLiveRun] = useState<LiveRunSnapshot | null>(null);
  const [isSimulating, setIsSimulating] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [runtimeVersion, setRuntimeVersion] = useState<RuntimeVersionInfo | null>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/v1/version')
      .then((res) => (res.ok ? (res.json() as Promise<RuntimeVersionInfo>) : null))
      .then((data) => {
        if (active && data?.version) {
          setRuntimeVersion(data);
        }
      })
      .catch(() => {
        // Fallback silently to compile-time APP_META
      });
    return () => {
      active = false;
    };
  }, []);

  const eventSourceRef = useRef<EventSource | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const runRequestSeqRef = useRef<number>(0);

  const loadPlcCatalog = useCallback(async () => {
    try {
      const resp = await apiFetch('/api/v1/catalog/machines');
      if (resp.ok) {
        const data = (await resp.json()) as PlcCatalogListResponse;
        setPlcCatalog(data);
      }
    } catch {
      // Non-fatal fallback
    }
  }, []);

  const closeStream = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const startPollingFallback = useCallback(
    (runId: string) => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
      }
      pollTimerRef.current = setInterval(async () => {
        if (activeRunIdRef.current !== runId) {
          if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
          }
          return;
        }
        try {
          const resp = await apiFetch(`/api/v1/pipeline/runs/${encodeURIComponent(runId)}`);
          if (!resp.ok) return;
          const snap = (await resp.json()) as LiveRunSnapshot;
          if (activeRunIdRef.current !== runId || snap.runId !== runId) return;
          setLiveRun(snap);
          if (snap.status === 'completed' || snap.status === 'stopped') {
            closeStream();
          }
        } catch {
          // Ignore transient network errors
        }
      }, 1000);
    },
    [closeStream]
  );

  const attachStream = useCallback(
    (runId: string) => {
      closeStream();
      activeRunIdRef.current = runId;
      const es = new EventSource(`/api/v1/pipeline/runs/${encodeURIComponent(runId)}/stream`);
      eventSourceRef.current = es;

      es.onmessage = (event) => {
        if (activeRunIdRef.current !== runId || eventSourceRef.current !== es) {
          es.close();
          return;
        }
        try {
          const snapshot = JSON.parse(event.data) as LiveRunSnapshot;
          if (snapshot.runId !== runId) return;
          setLiveRun(snapshot);
          if (snapshot.status === 'completed' || snapshot.status === 'stopped') {
            closeStream();
          }
        } catch {
          // Ignore malformed keepalive frames
        }
      };

      es.onerror = () => {
        es.close();
        if (eventSourceRef.current === es) {
          eventSourceRef.current = null;
        }
        if (activeRunIdRef.current !== runId) return;
        // Fallback to authenticated apiFetch polling (handles API_ENFORCE_AUTH=true where EventSource cannot pass headers)
        startPollingFallback(runId);
      };
    },
    [closeStream, startPollingFallback]
  );

  useEffect(() => () => {
      closeStream();
    }, [closeStream]);

  const startLiveRun = useCallback(
    async (config: LiveRunConfig) => {
      const reqSeq = ++runRequestSeqRef.current;
      closeStream();
      activeRunIdRef.current = null;
      setLiveRun(null);
      setIsSimulating(true);
      setErrorMsg(null);
      try {
        const resp = await apiFetch('/api/v1/pipeline/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config),
        });
        if (!resp.ok) {
          const payload = (await resp.json().catch(() => ({}))) as { error?: string };
          throw new Error(payload.error || t('errors.startStreamStatus', { status: resp.status }));
        }
        const snap = (await resp.json()) as LiveRunSnapshot;
        if (runRequestSeqRef.current !== reqSeq) return;
        activeRunIdRef.current = snap.runId;
        setLiveRun(snap);
        attachStream(snap.runId);
      } catch (err) {
        if (runRequestSeqRef.current !== reqSeq) return;
        setErrorMsg(err instanceof Error ? err.message : t('errors.startStream'));
      } finally {
        if (runRequestSeqRef.current === reqSeq) {
          setIsSimulating(false);
        }
      }
    },
    [attachStream, closeStream, t]
  );

  const controlLiveRun = useCallback(
    async (action: 'pause' | 'resume' | 'stop') => {
      if (!liveRun) return;
      try {
        const resp = await apiFetch(
          `/api/v1/pipeline/runs/${encodeURIComponent(liveRun.runId)}/${action}`,
          { method: 'POST' }
        );
        if (!resp.ok) {
          throw new Error(t('errors.controlRunStatus', { action, status: resp.status }));
        }
        const snap = (await resp.json()) as LiveRunSnapshot;
        setLiveRun(snap);
        if (action === 'resume') {
          attachStream(snap.runId);
        } else if (action === 'stop') {
          closeStream();
        }
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : t('errors.controlRun', { action }));
      }
    },
    [liveRun, attachStream, closeStream, t]
  );

  const saveJobConfig = useCallback(async (nextConfig: JobConfig): Promise<boolean> => {
    setIsSavingJobConfig(true);
    setErrorMsg(null);
    try {
      const resp = await apiFetch('/api/v1/job/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nextConfig),
      });
      if (!resp.ok) {
        const payload = (await resp.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || t('errors.saveJobConfigStatus', { status: resp.status }));
      }
      const data = (await resp.json()) as JobConfigResponse;
      setJobConfig(data.config);
      setJobConfigUpdatedAt(data.updatedAt);
      return true;
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : t('errors.saveJobConfig'));
      return false;
    } finally {
      setIsSavingJobConfig(false);
    }
  }, [t]);

  const refreshLatestRun = useCallback(async () => {
    try {
      const latestResp = await apiFetch('/api/v1/pipeline/runs/latest');
      if (latestResp.ok) {
        const latestData = (await latestResp.json()) as { run: LiveRunSnapshot | null };
        if (latestData.run) {
          activeRunIdRef.current = latestData.run.runId;
          setLiveRun(latestData.run);
        }
      }
    } catch {
      // Non-fatal background refresh
    }
  }, []);

  const refreshAuthState = useCallback(async (): Promise<AuthMeResponse | null> => {
    try {
      const resp = await apiFetch('/api/v1/auth/me');
      if (!resp.ok) return null;
      const data = (await resp.json()) as AuthMeResponse;
      setCurrentUser(data.user ?? null);
      setAuthEnforced(Boolean(data.authEnforced));
      if (data.permissions) {
        setPermissions(data.permissions);
      }
      return data;
    } catch {
      return null;
    }
  }, []);

  const loadWorkspaceData = useCallback(
    async (allowAutoStart: boolean) => {
      try {
        void loadPlcCatalog();

        let resolvedJobConfig = INITIAL_JOB_CONFIG;
        const jobResp = await apiFetch('/api/v1/job/config');
        if (jobResp.ok) {
          const jobData = (await jobResp.json()) as JobConfigResponse;
          resolvedJobConfig = jobData.config;
          setJobConfig(jobData.config);
          setJobConfigUpdatedAt(jobData.updatedAt);
        }

        const latestResp = await apiFetch('/api/v1/pipeline/runs/latest');
        if (latestResp.ok) {
          const latestData = (await latestResp.json()) as { run: LiveRunSnapshot | null };
          if (latestData.run) {
            activeRunIdRef.current = latestData.run.runId;
            setLiveRun(latestData.run);
            if (latestData.run.status === 'running') {
              attachStream(latestData.run.runId);
            }
            return;
          }
        }

        if (allowAutoStart) {
          await startLiveRun({
            durationMinutes: 15,
            eventsPerSec: 10,
            speedMultiplier: 10,
            windowMinutes: resolvedJobConfig.windowMinutes,
            machineCount: 4,
            machinesPerLine: resolvedJobConfig.machinesPerLine,
            machineProfileMode: resolvedJobConfig.machineProfileMode,
            faultProbabilityPct: 5,
            malformedRatePct: 7,
            outOfOrderRatePct: 8,
            rotateMaxLines: resolvedJobConfig.rotateMaxLines,
            seed: 42,
            customMachineTopology: resolvedJobConfig.customMachineTopology,
            ignoredErrorCodes: resolvedJobConfig.ignoredErrorCodes,
            horizonWindows: resolvedJobConfig.horizonWindows,
            tempAnomalyThresholdC: resolvedJobConfig.tempAnomalyThresholdC,
            vibrationP95Threshold: resolvedJobConfig.vibrationP95Threshold,
            minValidSampleRatio: resolvedJobConfig.minValidSampleRatio,
            dedupStrategy: resolvedJobConfig.dedupStrategy,
            malformedPolicy: resolvedJobConfig.malformedPolicy,
            parquetCompression: resolvedJobConfig.parquetCompression,
            datasetVersion: resolvedJobConfig.datasetVersion,
            partitionLayout: resolvedJobConfig.partitionLayout,
            lakehouseFormat: resolvedJobConfig.lakehouseFormat,
            hotRetentionDays: resolvedJobConfig.hotRetentionDays,
            coldRetentionDays: resolvedJobConfig.coldRetentionDays,
            coldStorageEndpoint: resolvedJobConfig.coldStorageEndpoint,
            compactionSchedule: resolvedJobConfig.compactionSchedule,
            ingestTransport: resolvedJobConfig.ingestTransport,
          });
        }
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : t('errors.initWorkspace'));
      }
    },
    [attachStream, loadPlcCatalog, startLiveRun, t]
  );

  useEffect(() => {
    const boot = async () => {
      const auth = await refreshAuthState();
      setAuthReady(true);
      if (auth && auth.authEnforced && !auth.user) {
        return;
      }
      await loadWorkspaceData(Boolean(auth?.permissions.canControlSimulation ?? true));
    };
    void boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleNavGroups = useMemo(() => {
    const allowed = new Set<AppViewId>(permissions.allowedViews);
    return NAV_GROUPS.map((group) => ({
      ...group,
      items: group.items.filter((item) => allowed.has(item.id)),
    })).filter((group) => group.items.length > 0);
  }, [permissions.allowedViews]);

  useEffect(() => {
    if (permissions.allowedViews.length > 0 && !permissions.allowedViews.includes(activeView)) {
      setActiveView(permissions.allowedViews[0]);
    }
  }, [permissions.allowedViews, activeView]);

  const handleAuthenticated = async (payload: {
    user: SessionUserInfo;
    permissions: RolePermissionPolicy;
  }) => {
    setCurrentUser(payload.user);
    setPermissions(payload.permissions);
    setShowLoginModal(false);
    setErrorMsg(null);
    if (
      payload.permissions.allowedViews.length > 0 &&
      !payload.permissions.allowedViews.includes(activeView)
    ) {
      setActiveView(payload.permissions.allowedViews[0]);
    }
    await loadWorkspaceData(false);
  };

  const handleSignOut = async () => {
    try {
      await apiFetch('/api/v1/auth/logout', { method: 'POST' });
    } catch {
      // Ignore logout network error
    }
    setSessionApiKey(null);
    closeStream();
    const nextAuth = await refreshAuthState();
    if (nextAuth && nextAuth.authEnforced) {
      setShowLoginModal(true);
    }
  };

  if (!authReady) {
    return (
      <div className="min-h-screen bg-canvas flex items-center justify-center text-xs text-slate-600 font-mono">
        {t('app.initializing')}
      </div>
    );
  }

  if (showLoginModal || (authEnforced && !currentUser)) {
    return (
      <Suspense
        fallback={
          <div className="min-h-screen bg-canvas flex items-center justify-center text-xs text-slate-600 font-mono">
            {t('app.loadingModule')}
          </div>
        }
      >
        <LoginScreen
          authEnforced={authEnforced}
          onAuthenticated={(payload) => {
            void handleAuthenticated(payload);
          }}
        />
      </Suspense>
    );
  }

  const activeNavMeta = ALL_NAV_ITEMS.find((n) => n.id === activeView) ?? ALL_NAV_ITEMS[0];
  const isDesktopExpanded = sidebarPinned || sidebarHovered;
  const scalarDocsUrl = `/api/v1/docs?lang=${activeLang}`;

  const renderSidebarNav = (expanded: boolean, onSelect?: () => void) => (
    <nav
      aria-label={t('nav.ariaLabel')}
      className={`flex-1 py-3 overflow-y-auto overflow-x-hidden ${
        expanded ? 'px-2.5 space-y-5' : 'px-2 space-y-2.5'
      }`}
    >
      {visibleNavGroups.map((group, groupIdx) => {
        const groupLabel = t(`nav.groups.${group.key}`);
        return (
          <div
            key={group.key}
            className={
              expanded
                ? 'space-y-0.5'
                : `space-y-1 ${groupIdx > 0 ? 'pt-2.5 border-t border-chrome-border' : ''}`
            }
          >
            {expanded && (
              <div className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.09em] text-[#7c90a6] whitespace-nowrap">
                {groupLabel}
              </div>
            )}
            {group.items.map((item) => {
              const Icon = item.icon;
              const itemLabel = t(`nav.views.${item.id}`);
              const active = activeView === item.id;
              const isStreamingNav = item.id === 'workbench' && liveRun?.status === 'running';
              return (
                <button
                  key={item.id}
                  type="button"
                  title={!expanded ? `${groupLabel} — ${itemLabel}` : undefined}
                  aria-label={itemLabel}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => {
                    setActiveView(item.id);
                    onSelect?.();
                  }}
                  className={`relative w-full flex items-center rounded-[2px] text-[12.5px] font-medium transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
                    expanded ? 'justify-between gap-2 px-2.5 py-2' : 'justify-center px-0 py-2.5'
                  } ${
                    active
                      ? 'bg-chrome-active text-white font-semibold'
                      : 'text-slate-300 hover:bg-chrome-elevated hover:text-white'
                  }`}
                >
                  {active && (
                    <span
                      aria-hidden="true"
                      className="absolute left-0 top-1.5 bottom-1.5 w-[2px] bg-accent rounded-r-[1px]"
                    />
                  )}
                  <span className={`flex items-center min-w-0 ${expanded ? 'gap-2.5' : ''}`}>
                    <Icon
                      className={`w-4 h-4 shrink-0 transition-colors ${
                        active ? 'text-accent' : 'text-[#8ea1b5]'
                      }`}
                    />
                    {expanded && <span className="truncate tracking-[0.005em]">{itemLabel}</span>}
                  </span>
                  {expanded && isStreamingNav && (
                    <span className="text-[10px] font-mono font-semibold tracking-wider text-accent shrink-0">
                      {t('nav.liveBadge')}
                    </span>
                  )}
                  {!expanded && isStreamingNav && (
                    <span
                      className="w-1.5 h-1.5 rounded-[1px] bg-accent absolute top-1.5 right-1.5"
                      aria-hidden="true"
                      title={t('nav.liveStreamRunning')}
                    />
                  )}
                </button>
              );
            })}
          </div>
        );
      })}

      {/* Direct synchronized bilingual Scalar API Documentation link */}
      <div className={expanded ? 'pt-3 border-t border-chrome-border space-y-0.5' : 'pt-2.5 border-t border-chrome-border'}>
        {expanded && (
          <div className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.09em] text-[#7c90a6] whitespace-nowrap">
            {t('nav.groups.developer')}
          </div>
        )}
        <a
          href={scalarDocsUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={t('nav.scalarDocsTitle')}
          className={`w-full flex items-center rounded-[2px] text-[12.5px] font-medium text-slate-300 hover:bg-chrome-elevated hover:text-white transition-colors duration-150 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
            expanded ? 'justify-between gap-2 px-2.5 py-2' : 'justify-center px-0 py-2.5'
          }`}
        >
          <span className={`flex items-center min-w-0 ${expanded ? 'gap-2.5' : ''}`}>
            <BookOpen className="w-4 h-4 shrink-0 text-accent" />
            {expanded && <span className="truncate">{t('nav.scalarDocs')}</span>}
          </span>
          {expanded && <ExternalLink className="w-3 h-3 text-[#7c90a6] shrink-0" />}
        </a>
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen bg-canvas text-ink flex flex-col md:flex-row overflow-x-clip">
      {/* Desktop ERP Collapsible Icon-Rail / Pinned Left Sidebar */}
      <aside
        onMouseEnter={() => {
          if (!sidebarPinned) setSidebarHovered(true);
        }}
        onMouseLeave={() => {
          if (!sidebarPinned) setSidebarHovered(false);
        }}
        className={`hidden md:flex md:flex-col md:fixed md:inset-y-0 md:left-0 z-40 bg-chrome text-slate-200 border-r border-chrome-border transition-[width,box-shadow] duration-200 ease-out motion-reduce:transition-none ${
          isDesktopExpanded
            ? `w-60 ${!sidebarPinned ? 'shadow-2xl' : ''}`
            : 'w-14'
        }`}
      >
        <div
          className={`h-14 flex items-center border-b border-chrome-border shrink-0 overflow-hidden ${
            isDesktopExpanded ? 'px-4 gap-2.5' : 'justify-center px-1'
          }`}
        >
          <BrandMark
            size={isDesktopExpanded ? 'md' : 'sm'}
            showWordmark={isDesktopExpanded}
          />
        </div>

        {renderSidebarNav(isDesktopExpanded)}

        {isDesktopExpanded && (
          <div className="px-2.5 pb-2.5 shrink-0 overflow-hidden">
            <div className="px-3 py-2.5 rounded-[2px] bg-[#0f1d2c] border border-chrome-border text-[11px] space-y-1">
              <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-accent whitespace-nowrap truncate">
                {t('nav.activeJobPolicy')}
              </div>
              <div className="whitespace-nowrap truncate font-mono text-[11px] text-slate-200">
                {jobConfig.environment} · {t('nav.windowSuffix', { minutes: jobConfig.windowMinutes })}
              </div>
              <div className="whitespace-nowrap truncate font-mono text-[10px] text-[#8ea1b5]">
                {jobConfig.storageTarget} · {jobConfig.featureMartSink}
              </div>
            </div>
          </div>
        )}

        {/* Bottom Pin / Unpin Control & Centralized Release Version */}
        <div className={`border-t border-chrome-border shrink-0 ${isDesktopExpanded ? 'p-2.5 space-y-2' : 'p-2 space-y-1.5'}`}>
          <div
            title={`${runtimeVersion?.fullName ?? APP_NAME} · ${runtimeVersion?.tag ?? APP_VERSION_TAG} (${runtimeVersion?.channel ?? APP_CHANNEL})${runtimeVersion?.buildSha ? ` · ${runtimeVersion.buildSha.slice(0, 8)}` : ''}`}
            className={`flex items-center font-mono text-[10px] text-[#8ea1b5] select-none ${
              isDesktopExpanded ? 'justify-between px-2.5 pt-0.5' : 'justify-center'
            }`}
          >
            {isDesktopExpanded ? (
              <>
                <span className="uppercase tracking-[0.08em] text-[#7c90a6]">
                  {t('nav.versionLabel')}
                </span>
                <span className="text-slate-300 font-semibold">
                  {runtimeVersion?.tag ?? APP_VERSION_TAG}
                  {runtimeVersion?.buildSha ? ` · ${runtimeVersion.buildSha.slice(0, 7)}` : ''}
                </span>
              </>
            ) : (
              <span className="text-[9.5px] text-[#8ea1b5] tracking-tight">
                {runtimeVersion?.tag ?? APP_VERSION_TAG}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={toggleSidebarPin}
            aria-pressed={sidebarPinned}
            aria-label={sidebarPinned ? t('nav.unpinSidebarAria') : t('nav.pinSidebarAria')}
            title={sidebarPinned ? t('nav.unpinSidebarAria') : t('nav.pinSidebarAria')}
            className={`w-full flex items-center rounded-[2px] text-xs font-medium transition-colors duration-150 cursor-pointer whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
              isDesktopExpanded ? 'justify-between px-2.5 py-2' : 'justify-center py-2'
            } ${
              sidebarPinned
                ? 'bg-chrome-active text-white hover:bg-[#1c354f]'
                : 'text-[#8ea1b5] hover:bg-chrome-elevated hover:text-white'
            }`}
          >
            <span className={`flex items-center ${isDesktopExpanded ? 'gap-2.5' : ''}`}>
              {sidebarPinned ? (
                <PinOff className="w-4 h-4 shrink-0 text-accent" />
              ) : (
                <Pin className="w-4 h-4 shrink-0" />
              )}
              {isDesktopExpanded && (
                <span>{sidebarPinned ? t('nav.unpinSidebar') : t('nav.pinSidebar')}</span>
              )}
            </span>
            {isDesktopExpanded && (
              <span className="font-mono text-[10px] text-[#8ea1b5] uppercase tracking-wider">
                {sidebarPinned ? t('nav.pinned') : t('nav.auto')}
              </span>
            )}
          </button>
        </div>
      </aside>

      {/* Mobile Navigation Drawer (< 768px only) */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 md:hidden flex">
          <div
            className="fixed inset-0 bg-chrome/60"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative w-64 max-w-full bg-chrome text-slate-200 h-full border-r border-chrome-border flex flex-col z-50">
            <div className="h-14 px-4 flex items-center justify-between border-b border-chrome-border">
              <BrandMark size="md" showWordmark />
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                aria-label={t('nav.closeMenu')}
                className="p-1.5 text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {renderSidebarNav(true, () => setMobileMenuOpen(false))}
            <div className="px-4 py-2.5 border-t border-chrome-border flex items-center justify-between font-mono text-[10px] text-[#8ea1b5]">
              <span className="uppercase tracking-[0.08em] text-[#7c90a6]">{t('nav.versionLabel')}</span>
              <span className="text-slate-300 font-semibold">
                {runtimeVersion?.tag ?? APP_VERSION_TAG}
                {runtimeVersion?.buildSha ? ` · ${runtimeVersion.buildSha.slice(0, 7)}` : ''}
              </span>
            </div>
          </aside>
        </div>
      )}

      {/* Main ERP Workspace */}
      <div
        className={`flex-1 flex flex-col min-w-0 transition-[padding] duration-200 ease-out motion-reduce:transition-none ${
          sidebarPinned ? 'md:pl-60' : 'md:pl-14'
        }`}
      >
        <header className="h-14 bg-white border-t-2 border-t-accent border-b border-b-hairline px-4 sm:px-6 flex items-center justify-between gap-4 sticky top-0 z-30">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label={t('nav.openMenu')}
              className="md:hidden p-2 -ml-2 text-slate-600 hover:text-ink cursor-pointer"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 min-w-0 truncate">
              <span className="text-xs font-medium text-slate-500 whitespace-nowrap">
                {t(`nav.groups.${activeNavMeta.groupKey}`)}
              </span>
              <span aria-hidden="true" className="text-accent text-xs font-semibold select-none">
                /
              </span>
              <span className="text-[13px] font-semibold tracking-tight text-ink truncate">
                {t(`nav.views.${activeNavMeta.id}`)}
              </span>
            </div>
          </div>

          {/* Connected Operator Identity, Language Switcher & Session Controls */}
          <div className="flex items-center gap-3 shrink-0">
            <span className="hidden xl:inline-flex items-center gap-1.5 text-[11px] font-mono text-slate-500 whitespace-nowrap">
              <span>{t('header.env')}:</span>
              <strong className="font-semibold text-ink">{jobConfig.environment}</strong>
            </span>

            <div className="h-4 w-px bg-hairline hidden xl:block" />

            <LanguageSwitcher tone="light" />

            <div className="h-4 w-px bg-hairline hidden sm:block" />

            {currentUser ? (
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-2 text-xs mr-1">
                  <UserCircle2 className="w-4 h-4 text-brand shrink-0" />
                  <div className="leading-tight hidden sm:block">
                    <div className="font-semibold text-ink">{currentUser.fullName}</div>
                    <div className="text-[11px] font-mono text-slate-500">
                      {currentUser.email} · <span className="uppercase text-slate-700">{currentUser.role}</span>
                    </div>
                  </div>
                  <span className="sm:hidden font-mono text-[11px] font-medium text-ink">
                    {currentUser.role.toUpperCase()}
                  </span>
                </div>

                <button
                  type="button"
                  onClick={() => setShowLoginModal(true)}
                  className="px-2.5 py-1.5 text-[11px] font-medium text-slate-700 bg-white hover:bg-[#f4f6f9] border border-hairline-strong rounded-[2px] cursor-pointer whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand"
                >
                  {t('header.switchUser')}
                </button>
                <button
                  type="button"
                  onClick={() => void handleSignOut()}
                  aria-label={t('header.signOut')}
                  title={t('header.signOut')}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium text-slate-700 bg-white hover:bg-[#f4f6f9] border border-hairline-strong rounded-[2px] cursor-pointer whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span className="hidden md:inline">{t('header.signOut')}</span>
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2.5">
                <span className="text-[11px] font-mono text-slate-500 hidden sm:inline">
                  {t('header.localDevUnauth')}
                </span>
                <button
                  type="button"
                  onClick={() => setShowLoginModal(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-brand hover:bg-brand-hover rounded-[2px] cursor-pointer whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand"
                >
                  <LogIn className="w-3.5 h-3.5" />
                  {t('header.signIn')}
                </button>
              </div>
            )}
          </div>
        </header>

        <main className="flex-1 min-w-0 p-4 sm:p-6 max-w-[1600px] w-full mx-auto">
          {errorMsg && (
            <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-[2px] text-xs text-red-900 flex items-center justify-between gap-4">
              <span>{errorMsg}</span>
              <button
                type="button"
                onClick={() => setErrorMsg(null)}
                className="text-xs font-medium underline cursor-pointer shrink-0"
              >
                {t('actions.dismiss')}
              </button>
            </div>
          )}

          <Suspense
            fallback={
              <div className="bg-white border border-hairline rounded-[2px] px-5 py-8 text-xs text-slate-600 font-mono">
                {t('app.loadingModule')}
              </div>
            }
          >
            {activeView === 'workbench' && (
              <WorkbenchSection
                liveRun={liveRun}
                jobConfig={jobConfig}
                plcCatalog={plcCatalog}
                isSimulating={isSimulating}
                canControlSimulation={permissions.canControlSimulation}
                initialSelectedPlcType={selectedCatalogPlc}
                onStartLiveRun={(cfg) => startLiveRun(cfg)}
                onControlLiveRun={controlLiveRun}
                onOpenJobConfig={() => setActiveView('job_config')}
                onOpenPlcCatalog={() => setActiveView('plc_catalog')}
              />
            )}

            {activeView === 'fleet' && <FleetEvaluationSection liveRun={liveRun} />}

            {activeView === 'connections' && (
              <ConnectionsSection
                plcCatalog={plcCatalog}
                onBatchDispatched={refreshLatestRun}
              />
            )}

            {activeView === 'plc_catalog' && (
              <PlcCatalogSection
                plcCatalog={plcCatalog}
                onCatalogUpdated={(nextCatalog) => setPlcCatalog(nextCatalog)}
                onUseInSimulation={(typeId) => {
                  setSelectedCatalogPlc(typeId);
                  setActiveView('workbench');
                  if (permissions.canControlSimulation) {
                    void startLiveRun({
                      durationMinutes: 15,
                      eventsPerSec: 10,
                      speedMultiplier: 10,
                      windowMinutes: jobConfig.windowMinutes,
                      machineCount: 4,
                      machinesPerLine: jobConfig.machinesPerLine,
                      machineProfileMode: typeId,
                      selectedPlcTypes: [typeId],
                      faultProbabilityPct: 5,
                      malformedRatePct: 7,
                      outOfOrderRatePct: 8,
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
                    });
                  }
                }}
              />
            )}

            {activeView === 'job_config' && (
              <JobConfigSection
                jobConfig={jobConfig}
                plcCatalog={plcCatalog}
                updatedAt={jobConfigUpdatedAt}
                isSaving={isSavingJobConfig}
                onSaveJobConfig={saveJobConfig}
              />
            )}

            {activeView === 'notifications' && <NotificationsSection />}

            {activeView === 'users' && <UsersSection currentUser={currentUser} />}

            {activeView === 'roles' && (
              <RolesSection
                currentUser={currentUser}
                onPermissionsUpdated={() => {
                  void refreshAuthState();
                }}
              />
            )}

            {activeView === 'tokens' && (
              <ApiTokensSection
                currentUser={currentUser}
                activeLang={activeLang}
                onInspectAuditTrail={(actionFilter) => {
                  setAuditActionFilter(actionFilter);
                  setActiveView('audit');
                }}
              />
            )}

            {activeView === 'audit' && (
              <AuditLogSection initialActionFilter={auditActionFilter} />
            )}
          </Suspense>
        </main>
      </div>
    </div>
  );
}
