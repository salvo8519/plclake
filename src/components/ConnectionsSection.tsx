import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  Copy,
  Download,
  Filter,
  KeyRound,
  Network,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Send,
  ShieldCheck,
  Trash2,
  Wifi,
} from 'lucide-react';
import type {
  ConnectionAuthMode,
  ConnectionProbeResult,
  ConnectionProtocol,
  ConnectionsStateResponse,
  DeploymentTopology,
  NetworkDeploymentSettings,
  OnPremDeployBundle,
  PlcCatalogListResponse,
  PlcCatalogProfile,
  PlcConnection,
  TagBinding,
} from '../types/pipeline';
import { normalizeLanguage } from '../i18n/types';
import { apiFetch, setSessionApiKey } from '../utils/apiAuth';
import { formatUtcTimestamp } from '../utils/formatters';
import {
  ERP_INPUT_COMPACT_CLASS,
  ERP_SEGMENTED_GROUP_CLASS,
  ERP_TABLE_HEAD_ROW_CLASS,
} from '../theme/tokens';
import {
  DEFAULT_TABLE_PAGE_SIZE,
  paginateItems,
  RowActionMenu,
  SlideOverDrawer,
  TablePagination,
} from './ui';

interface ConnectionsSectionProps {
  plcCatalog: PlcCatalogListResponse | null;
  onBatchDispatched?: () => void;
}

type ConnectionStatusFilter = 'all' | 'active' | 'idle' | 'error';

function classifyConnectionStatus(conn: PlcConnection): Exclude<ConnectionStatusFilter, 'all'> {
  if (!conn.enabled || conn.status === 'disabled') return 'idle';
  if (conn.status === 'unreachable') return 'error';
  if (conn.status === 'connected') return 'active';
  return 'idle';
}

const PROTOCOL_DEFAULTS: Record<
  ConnectionProtocol,
  { port: number; endpointExample: string; label: string }
> = {
  opcua: {
    port: 4840,
    endpointExample: 'opc.tcp://192.168.10.11:4840/UA/MachineServer',
    label: 'OPC-UA (Siemens / Beckhoff / B&R)',
  },
  'modbus-tcp': {
    port: 502,
    endpointExample: 'unit=1;hr=40001..40006',
    label: 'Modbus TCP (Flow / Power Meters)',
  },
  'mqtt-sparkplug': {
    port: 8883,
    endpointExample: 'spBv1.0/plant01/DDATA/line-01/M-01',
    label: 'MQTT Sparkplug B (Broker OT)',
  },
  'http-rest-meter': {
    port: 8080,
    endpointExample: '/api/v1/telemetry',
    label: 'HTTP/REST Smart Meter',
  },
};

const FALLBACK_MACHINE_TYPES: Array<{ id: string; label: string }> = [
  { id: 'plc-controller', label: 'plc-controller (Manufacturing)' },
  { id: 'siemens-s7-1500', label: 'siemens-s7-1500 (Manufacturing)' },
  { id: 'rockwell-controllogix', label: 'rockwell-controllogix (Manufacturing)' },
  { id: 'cnc-mill', label: 'cnc-mill (Manufacturing)' },
  { id: 'gas-flow-meter', label: 'gas-flow-meter (Gas Metering)' },
  { id: 'methane-compressor', label: 'methane-compressor (Gas Metering)' },
  { id: 'power-meter', label: 'power-meter (Power Generation)' },
  { id: 'turbine-generator', label: 'turbine-generator (Power Generation)' },
];

function buildDefaultTags(
  machineType: string,
  protocol: ConnectionProtocol,
  profile?: PlcCatalogProfile
): TagBinding[] {
  const unitMap: Record<string, { p: string; pu: string; s: string; su: string }> = {
    'plc-controller': { p: 'cycle_ms', pu: 'ms', s: 'vibration_mm_s', su: 'mm/s' },
    'siemens-s7-1500': { p: 'cycle_ms', pu: 'ms', s: 'vibration_mm_s', su: 'mm/s' },
    'rockwell-controllogix': { p: 'cycle_ms', pu: 'ms', s: 'vibration_mm_s', su: 'mm/s' },
    'cnc-mill': { p: 'vibration_mm_s', pu: 'mm/s', s: 'cycle_ms', su: 'ms' },
    'gas-flow-meter': { p: 'flow_nm3_h', pu: 'Nm3/h', s: 'pressure_bar', su: 'bar' },
    'methane-compressor': { p: 'pressure_bar', pu: 'bar', s: 'flow_nm3_h', su: 'Nm3/h' },
    'power-meter': { p: 'power_kw', pu: 'kW', s: 'frequency_hz', su: 'Hz' },
    'turbine-generator': { p: 'power_kw', pu: 'kW', s: 'voltage_v', su: 'V' },
  };
  const spec = profile
    ? {
        p: profile.primaryKey,
        pu: profile.primaryUnit,
        s: profile.secondaryKey,
        su: profile.secondaryUnit,
      }
    : unitMap[machineType] ?? unitMap['plc-controller'];

  const extra = profile?.extraChannels?.[0];
  if (protocol === 'modbus-tcp') {
    return [
      { sourceTag: 'HR:40001', targetMetric: spec.p, scaleFactor: 0.1, unit: spec.pu },
      { sourceTag: 'HR:40003', targetMetric: spec.s, scaleFactor: 0.01, unit: spec.su },
      { sourceTag: 'HR:40005', targetMetric: 'temp_c', scaleFactor: 0.1, unit: 'C' },
      ...(extra
        ? [{ sourceTag: 'HR:40007', targetMetric: extra.key, scaleFactor: 1, unit: extra.unit }]
        : []),
    ];
  }
  if (protocol === 'opcua') {
    return [
      { sourceTag: `ns=2;s=Machine.${spec.p}`, targetMetric: spec.p, scaleFactor: 1, unit: spec.pu },
      { sourceTag: `ns=2;s=Machine.${spec.s}`, targetMetric: spec.s, scaleFactor: 1, unit: spec.su },
      { sourceTag: 'ns=2;s=Machine.temp_c', targetMetric: 'temp_c', scaleFactor: 1, unit: 'C' },
      ...(extra
        ? [{ sourceTag: `ns=2;s=Machine.${extra.key}`, targetMetric: extra.key, scaleFactor: 1, unit: extra.unit }]
        : []),
    ];
  }
  return [
    { sourceTag: `metrics.${spec.p}`, targetMetric: spec.p, scaleFactor: 1, unit: spec.pu },
    { sourceTag: `metrics.${spec.s}`, targetMetric: spec.s, scaleFactor: 1, unit: spec.su },
    { sourceTag: 'metrics.temp_c', targetMetric: 'temp_c', scaleFactor: 1, unit: 'C' },
    ...(extra
      ? [{ sourceTag: `metrics.${extra.key}`, targetMetric: extra.key, scaleFactor: 1, unit: extra.unit }]
      : []),
  ];
}

export function ConnectionsSection({ plcCatalog, onBatchDispatched }: ConnectionsSectionProps) {
  const { t, i18n } = useTranslation(['operations', 'common']);
  const activeLang = normalizeLanguage(i18n.resolvedLanguage ?? i18n.language);
  const [state, setState] = useState<ConnectionsStateResponse | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<NetworkDeploymentSettings | null>(null);
  const [bundle, setBundle] = useState<OnPremDeployBundle | null>(null);
  const [activeBundleTab, setActiveBundleTab] = useState<'connections' | 'compose' | 'env' | 'script'>('compose');

  const [isLoading, setIsLoading] = useState(true);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [probingId, setProbingId] = useState<string | null>(null);
  const [testingBatchId, setTestingBatchId] = useState<string | null>(null);
  const [lastProbe, setLastProbe] = useState<ConnectionProbeResult | null>(null);
  const [actionBanner, setActionBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [connectionsPage, setConnectionsPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<ConnectionStatusFilter>('all');

  const [showEditor, setShowEditor] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [connName, setConnName] = useState('');
  const [machineId, setMachineId] = useState('M-05');
  const [lineId, setLineId] = useState('line-01');
  const [machineType, setMachineType] = useState('plc-controller');
  const [protocol, setProtocol] = useState<ConnectionProtocol>('opcua');
  const [deploymentTopology, setDeploymentTopology] = useState<DeploymentTopology>('on-premise-lan');
  const [host, setHost] = useState('192.168.10.15');
  const [port, setPort] = useState<number>(4840);
  const [endpointOrTopic, setEndpointOrTopic] = useState(PROTOCOL_DEFAULTS.opcua.endpointExample);
  const [pollIntervalSec, setPollIntervalSec] = useState<1 | 2 | 5 | 10 | 30>(2);
  const [authMode, setAuthMode] = useState<ConnectionAuthMode>('x509-cert');
  const [tagBindings, setTagBindings] = useState<TagBinding[]>(() =>
    buildDefaultTags('plc-controller', 'opcua')
  );

  const loadAll = useCallback(async () => {
    setIsLoading(true);
    try {
      const [connRes, bundleRes] = await Promise.all([
        apiFetch('/api/v1/connections'),
        apiFetch('/api/v1/connections/deploy-bundle'),
      ]);
      if (connRes.ok) {
        const data = (await connRes.json()) as ConnectionsStateResponse;
        setState(data);
        setSettingsDraft(data.settings);
      }
      if (bundleRes.ok) {
        const bundleData = (await bundleRes.json()) as OnPremDeployBundle;
        setBundle(bundleData);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const refreshBundle = useCallback(async () => {
    const resp = await apiFetch('/api/v1/connections/deploy-bundle');
    if (resp.ok) {
      setBundle((await resp.json()) as OnPremDeployBundle);
    }
  }, []);

  const handleSaveSettings = async (e: FormEvent) => {
    e.preventDefault();
    if (!settingsDraft) return;
    setIsSavingSettings(true);
    setActionBanner(null);
    try {
      const resp = await apiFetch('/api/v1/connections/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settingsDraft),
      });
      if (!resp.ok) throw new Error(t('operations:connections.policySaveStatusError', { status: resp.status }));
      const updated = (await resp.json()) as ConnectionsStateResponse;
      setState(updated);
      setSettingsDraft(updated.settings);
      await refreshBundle();
      setActionBanner({ kind: 'ok', text: t('operations:connections.policySaved') });
    } catch (err) {
      setActionBanner({
        kind: 'err',
        text: err instanceof Error ? err.message : t('operations:connections.policySaveError'),
      });
    } finally {
      setIsSavingSettings(false);
    }
  };

  const handleRotateScopedKey = async (scope: 'edge' | 'read' | 'admin') => {
    setActionBanner(null);
    const resp = await apiFetch('/api/v1/connections/api-keys/rotate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope }),
    });
    if (!resp.ok) {
      setActionBanner({ kind: 'err', text: t('operations:connections.keys.rotateError', { scope }) });
      return;
    }
    const payload = (await resp.json()) as {
      scope: 'edge' | 'read' | 'admin';
      token: string;
      state: ConnectionsStateResponse;
    };
    if (scope === 'admin') {
      setSessionApiKey(payload.token);
    }
    setIssuedToken(payload.token);
    setState(payload.state);
    setSettingsDraft(payload.state.settings);
    await refreshBundle();
    const hint =
      scope === 'edge'
        ? t('operations:connections.keys.hintEdge')
        : scope === 'read'
        ? t('operations:connections.keys.hintRead')
        : t('operations:connections.keys.hintAdmin');
    setActionBanner({
      kind: 'ok',
      text: t('operations:connections.keys.issuedBanner', { scope: scope.toUpperCase(), hint }),
    });
  };

  const openNewConnection = () => {
    setEditingId(null);
    setConnName('');
    setMachineId(`M-0${(state?.connections.length ?? 3) + 2}`);
    setLineId('line-01');
    setMachineType('plc-controller');
    setProtocol('opcua');
    setDeploymentTopology(settingsDraft?.topologyMode ?? 'on-premise-lan');
    setHost('192.168.10.20');
    setPort(4840);
    setEndpointOrTopic(PROTOCOL_DEFAULTS.opcua.endpointExample);
    setPollIntervalSec(2);
    setAuthMode('x509-cert');
    setTagBindings(buildDefaultTags('plc-controller', 'opcua'));
    setShowEditor(true);
  };

  const openEditConnection = (conn: PlcConnection) => {
    setEditingId(conn.id);
    setConnName(conn.name);
    setMachineId(conn.machineId);
    setLineId(conn.lineId);
    setMachineType(conn.machineType);
    setProtocol(conn.protocol);
    setDeploymentTopology(conn.deploymentTopology);
    setHost(conn.host);
    setPort(conn.port);
    setEndpointOrTopic(conn.endpointOrTopic);
    setPollIntervalSec(conn.pollIntervalSec);
    setAuthMode(conn.authMode);
    setTagBindings(conn.tagBindings.map((b) => ({ ...b })));
    setShowEditor(true);
  };

  const handleProtocolChange = (nextProto: ConnectionProtocol) => {
    const catalogProfile = plcCatalog?.profiles.find((p) => p.typeId === machineType);
    setProtocol(nextProto);
    setPort(PROTOCOL_DEFAULTS[nextProto].port);
    setEndpointOrTopic(PROTOCOL_DEFAULTS[nextProto].endpointExample);
    setTagBindings(buildDefaultTags(machineType, nextProto, catalogProfile));
  };

  const handleMachineTypeChange = (nextType: string) => {
    const catalogProfile = plcCatalog?.profiles.find((p) => p.typeId === nextType);
    const nextProto = catalogProfile?.defaultProtocol ?? protocol;
    setMachineType(nextType);
    if (catalogProfile) {
      setProtocol(nextProto);
      setPort(catalogProfile.defaultPort);
      setEndpointOrTopic(PROTOCOL_DEFAULTS[nextProto].endpointExample);
    }
    setTagBindings(buildDefaultTags(nextType, nextProto, catalogProfile));
  };

  const handleSaveConnection = async (e: FormEvent) => {
    e.preventDefault();
    setActionBanner(null);
    const resp = await apiFetch('/api/v1/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(editingId ? { id: editingId } : {}),
        name: connName.trim() || `${machineId} (${protocol.toUpperCase()})`,
        machineId: machineId.trim(),
        lineId: lineId.trim(),
        machineType,
        protocol,
        deploymentTopology,
        host: host.trim(),
        port,
        endpointOrTopic: endpointOrTopic.trim(),
        pollIntervalSec,
        authMode,
        enabled: true,
        tagBindings,
      }),
    });
    if (!resp.ok) {
      setActionBanner({ kind: 'err', text: t('operations:connections.registry.saveConnectionError') });
      return;
    }
    const payload = (await resp.json()) as { state: ConnectionsStateResponse };
    setState(payload.state);
    setShowEditor(false);
    await refreshBundle();
    setActionBanner({
      kind: 'ok',
      text: t('operations:connections.registry.saveConnectionOk', { machineId, host, port }),
    });
  };

  const handleToggleEnabled = async (conn: PlcConnection) => {
    const resp = await apiFetch('/api/v1/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: conn.id, enabled: !conn.enabled }),
    });
    if (resp.ok) {
      const payload = (await resp.json()) as { state: ConnectionsStateResponse };
      setState(payload.state);
      await refreshBundle();
    }
  };

  const handleDeleteConnection = async (id: string) => {
    const resp = await apiFetch(`/api/v1/connections/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (resp.ok) {
      const payload = (await resp.json()) as { state: ConnectionsStateResponse };
      setState(payload.state);
      await refreshBundle();
    }
  };

  const handleProbe = async (conn: PlcConnection) => {
    setProbingId(conn.id);
    setActionBanner(null);
    try {
      const resp = await apiFetch(`/api/v1/connections/${encodeURIComponent(conn.id)}/probe`, {
        method: 'POST',
      });
      if (!resp.ok) throw new Error(t('operations:connections.registry.probeRequestFailed'));
      const data = (await resp.json()) as {
        probe: ConnectionProbeResult;
        state: ConnectionsStateResponse;
      };
      setLastProbe(data.probe);
      setState(data.state);
      if (data.probe.reachable) {
        setActionBanner({
          kind: 'ok',
          text: t('operations:connections.registry.probeReachableBanner', {
            host: conn.host,
            port: conn.port,
            protocol: conn.protocol.toUpperCase(),
            ms: data.probe.latencyMs,
          }),
        });
      } else {
        setActionBanner({
          kind: 'err',
          text: t('operations:connections.registry.probeUnreachableBanner', {
            host: conn.host,
            port: conn.port,
            code: data.probe.errorCode,
            message: data.probe.errorMessage,
          }),
        });
      }
    } catch (err) {
      setActionBanner({
        kind: 'err',
        text: err instanceof Error ? err.message : t('operations:connections.registry.probeError'),
      });
    } finally {
      setProbingId(null);
    }
  };

  const handleSendTestBatch = async (conn: PlcConnection) => {
    setTestingBatchId(conn.id);
    setActionBanner(null);
    try {
      const resp = await apiFetch(`/api/v1/connections/${encodeURIComponent(conn.id)}/send-test-batch`, {
        method: 'POST',
      });
      if (!resp.ok) {
        throw new Error(t('operations:connections.registry.batchFailedStatus', { status: resp.status }));
      }
      const data = (await resp.json()) as {
        result: { runId: string; accepted: number; deduplicated: number; quarantined: number };
        state: ConnectionsStateResponse;
      };
      setState(data.state);
      onBatchDispatched?.();
      setActionBanner({
        kind: 'ok',
        text: t('operations:connections.registry.batchDispatchedBanner', {
          machineId: conn.machineId,
          accepted: data.result.accepted,
          runId: data.result.runId,
        }),
      });
    } catch (err) {
      setActionBanner({
        kind: 'err',
        text: err instanceof Error ? err.message : t('operations:connections.registry.batchFailedError'),
      });
    } finally {
      setTestingBatchId(null);
    }
  };

  const handleCopy = async (key: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const handleDownloadFile = (filename: string, content: string) => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const activeBundleText =
    activeBundleTab === 'connections'
      ? bundle?.edgeConnectionsJson ?? ''
      : activeBundleTab === 'compose'
      ? bundle?.onPremComposeYml ?? ''
      : activeBundleTab === 'env'
      ? bundle?.edgeEnvFile ?? ''
      : bundle?.installScriptSh ?? '';

  const activeBundleFilename =
    activeBundleTab === 'connections'
      ? 'connections.json'
      : activeBundleTab === 'compose'
      ? 'docker-compose.onprem.yml'
      : activeBundleTab === 'env'
      ? 'edge-gateway.env'
      : 'install-onprem.sh';

  if (isLoading || !settingsDraft) {
    return (
      <div className="bg-white border border-hairline rounded-[2px] p-6 text-xs text-slate-600">
        {t('operations:connections.loading')}
      </div>
    );
  }

  const connections = state?.connections ?? [];
  const statusCounts = connections.reduce(
    (acc, conn) => {
      const bucket = classifyConnectionStatus(conn);
      acc[bucket] += 1;
      return acc;
    },
    { active: 0, idle: 0, error: 0 }
  );
  const filteredConnections =
    statusFilter === 'all'
      ? connections
      : connections.filter((conn) => classifyConnectionStatus(conn) === statusFilter);
  const { pageItems: pagedConnections, safePage: safeConnectionsPage } = paginateItems(
    filteredConnections,
    connectionsPage,
    DEFAULT_TABLE_PAGE_SIZE
  );

  return (
    <div className="space-y-5">
      {actionBanner && (
        <div
          className={`px-4 py-2.5 rounded-[2px] border text-xs flex items-center justify-between gap-3 ${
            actionBanner.kind === 'ok'
              ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
              : 'bg-amber-50 border-amber-300 text-amber-950'
          }`}
        >
          <span className="font-mono">{actionBanner.text}</span>
          <button
            type="button"
            onClick={() => setActionBanner(null)}
            className="underline cursor-pointer shrink-0"
          >
            {t('common:actions.dismiss')}
          </button>
        </div>
      )}

      {/* 1. Corporate Network & On-Premise Deployment Settings */}
      <form onSubmit={handleSaveSettings} className="bg-white border border-hairline rounded-[2px] overflow-hidden">
        <div className="px-5 py-4 border-b border-hairline flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <Network className="w-4 h-4 text-brand mt-0.5 shrink-0" />
            <div>
              <h1 className="text-[15px] font-semibold tracking-tight text-ink">
                {t('operations:connections.title')}
              </h1>
              <p className="text-xs text-slate-600 mt-0.5">
                {t('operations:connections.subtitle')}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <a
              href={`/api/docs?lang=${activeLang}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-hairline-strong hover:bg-[#f4f6f9] rounded-[2px] transition-colors whitespace-nowrap"
            >
              {t('operations:connections.apiDocsScalar')}
            </a>
            <a
              href={`/api/v1/openapi.json?lang=${activeLang}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono text-slate-700 bg-white border border-hairline-strong hover:bg-[#f4f6f9] rounded-[2px] transition-colors whitespace-nowrap"
            >
              {t('operations:connections.openApiJson')}
            </a>
            <button
              type="submit"
              disabled={isSavingSettings}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-white bg-brand hover:bg-brand-hover disabled:opacity-50 rounded-[2px] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              {isSavingSettings
                ? t('operations:connections.savingPolicy')
                : t('operations:connections.savePolicy')}
            </button>
          </div>
        </div>

        <div className="p-5 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 border-b border-hairline">
          <div>
            <label htmlFor="net-topology" className="block text-[11px] font-medium text-slate-600 mb-1">
              {t('operations:connections.fields.topologyMode')}
            </label>
            <select
              id="net-topology"
              value={settingsDraft.topologyMode}
              onChange={(e) =>
                setSettingsDraft({
                  ...settingsDraft,
                  topologyMode: e.target.value as DeploymentTopology,
                })
              }
              className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
            >
              <option value="on-premise-lan">{t('operations:connections.fields.topologyOnPrem')}</option>
              <option value="edge-gateway-push">{t('operations:connections.fields.topologyEdgePush')}</option>
              <option value="site-to-site-vpn">{t('operations:connections.fields.topologyVpn')}</option>
            </select>
          </div>

          <div>
            <label htmlFor="net-site" className="block text-[11px] font-medium text-slate-600 mb-1">
              {t('operations:connections.fields.siteName')}
            </label>
            <input
              id="net-site"
              type="text"
              value={settingsDraft.siteName}
              onChange={(e) => setSettingsDraft({ ...settingsDraft, siteName: e.target.value })}
              className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
            />
          </div>

          <div>
            <label htmlFor="net-cidr" className="block text-[11px] font-medium text-slate-600 mb-1">
              {t('operations:connections.fields.vlanCidr')}
            </label>
            <input
              id="net-cidr"
              type="text"
              value={settingsDraft.plantVlanCidr}
              onChange={(e) => setSettingsDraft({ ...settingsDraft, plantVlanCidr: e.target.value })}
              className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
            />
          </div>

          <div>
            <label htmlFor="net-ingest" className="block text-[11px] font-medium text-slate-600 mb-1">
              {t('operations:connections.fields.ingestTarget')}
            </label>
            <input
              id="net-ingest"
              type="text"
              value={settingsDraft.ingestApiUrl}
              onChange={(e) => setSettingsDraft({ ...settingsDraft, ingestApiUrl: e.target.value })}
              className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
            />
          </div>

          <div>
            <label htmlFor="net-auth-policy" className="block text-[11px] font-medium text-slate-600 mb-1">
              {t('operations:connections.fields.tokenEnforcement')}
            </label>
            <select
              id="net-auth-policy"
              value={settingsDraft.requireGatewayToken ? 'strict' : 'trusted-lan'}
              onChange={(e) =>
                setSettingsDraft({
                  ...settingsDraft,
                  requireGatewayToken: e.target.value === 'strict',
                })
              }
              className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
            >
              <option value="trusted-lan">{t('operations:connections.fields.authTrustedLan')}</option>
              <option value="strict">{t('operations:connections.fields.authStrict')}</option>
            </select>
          </div>

          <div>
            <label htmlFor="net-spool" className="block text-[11px] font-medium text-slate-600 mb-1">
              {t('operations:connections.fields.spoolBuffer')}
            </label>
            <select
              id="net-spool"
              value={settingsDraft.spoolMaxMb}
              onChange={(e) =>
                setSettingsDraft({
                  ...settingsDraft,
                  spoolMaxMb: Number(e.target.value) as NetworkDeploymentSettings['spoolMaxMb'],
                })
              }
              className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
            >
              <option value={256}>{t('operations:connections.fields.spool256')}</option>
              <option value={1024}>{t('operations:connections.fields.spool1024')}</option>
              <option value={4096}>{t('operations:connections.fields.spool4096')}</option>
            </select>
          </div>
        </div>

        {/* Multi-Scope API Keys (Testable in Scalar) & Firewall Port Matrix */}
        <div className="px-5 py-3.5 bg-[#f8f9fb] flex flex-col gap-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void handleRotateScopedKey('edge')}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-800 bg-white border border-hairline-strong hover:bg-[#f4f6f9] rounded-[2px] transition-colors whitespace-nowrap cursor-pointer"
              >
                <KeyRound className="w-3.5 h-3.5" />
                {t('operations:connections.keys.rotateEdge')}
              </button>
              <button
                type="button"
                onClick={() => void handleRotateScopedKey('read')}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-800 bg-white border border-hairline-strong hover:bg-[#f4f6f9] rounded-[2px] transition-colors whitespace-nowrap cursor-pointer"
              >
                <KeyRound className="w-3.5 h-3.5 text-brand" />
                {t('operations:connections.keys.rotateRead')}
              </button>
              <button
                type="button"
                onClick={() => void handleRotateScopedKey('admin')}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-800 bg-white border border-hairline-strong hover:bg-[#f4f6f9] rounded-[2px] transition-colors whitespace-nowrap cursor-pointer"
              >
                <KeyRound className="w-3.5 h-3.5 text-accent" />
                {t('operations:connections.keys.rotateAdmin')}
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-4 font-mono text-[11px] text-slate-600">
              <span>
                {t('operations:connections.keys.labelEdge')}{' '}
                <strong className="text-ink">
                  {settingsDraft.tokenFingerprint ?? t('operations:connections.keys.none')}
                </strong>
              </span>
              <span>
                {t('operations:connections.keys.labelRead')}{' '}
                <strong className="text-ink">
                  {settingsDraft.readTokenFingerprint ?? t('operations:connections.keys.none')}
                </strong>
              </span>
              <span>
                {t('operations:connections.keys.labelAdmin')}{' '}
                <strong className="text-ink">
                  {settingsDraft.adminTokenFingerprint ?? t('operations:connections.keys.none')}
                </strong>
              </span>
            </div>
          </div>

          {issuedToken && (
            <div className="inline-flex items-center justify-between gap-2 px-3 py-1.5 bg-amber-50 border border-amber-300 rounded-[2px] font-mono text-[11px] text-amber-950">
              <span className="truncate">
                {t('operations:connections.keys.issuedOnce')} <strong>{issuedToken}</strong>
              </span>
              <button
                type="button"
                onClick={() => handleCopy('token', issuedToken)}
                className="text-amber-900 hover:text-black cursor-pointer shrink-0"
                aria-label={t('operations:connections.keys.copyTokenAria')}
              >
                {copiedKey === 'token' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
          )}

          <div className="font-mono text-[11px] text-slate-600">
            {t('operations:connections.keys.firewallPorts')}{' '}
            <strong className="text-ink">4840/tcp</strong> (OPC-UA) ·{' '}
            <strong className="text-ink">502/tcp</strong> (Modbus) ·{' '}
            <strong className="text-ink">8883/tcp</strong> (MQTTS) → Ingest{' '}
            <strong className="text-ink">3000/443</strong>
          </div>
        </div>
      </form>

      {/* 2. PLC & Meter Endpoint Registry */}
      <section className="bg-white overflow-hidden">
        <div className="px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white">
          <div>
            <h2 className="text-[13px] font-semibold text-ink tracking-tight">
              {statusFilter === 'all'
                ? t('operations:connections.registry.heading', { count: connections.length })
                : t('operations:connections.registry.headingFiltered', {
                    shown: filteredConnections.length,
                    total: connections.length,
                  })}
            </h2>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {t('operations:connections.registry.subtitle')}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <div className="inline-flex items-center gap-1.5">
              <Filter className="w-3.5 h-3.5 text-slate-500 shrink-0" aria-hidden="true" />
              <label htmlFor="connections-status-filter" className="sr-only">
                {t('operations:connections.registry.filterStatusLabel')}
              </label>
              <select
                id="connections-status-filter"
                aria-label={t('operations:connections.registry.filterStatusAria')}
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value as ConnectionStatusFilter);
                  setConnectionsPage(1);
                }}
                className={`${ERP_INPUT_COMPACT_CLASS} w-auto min-w-[170px] font-mono text-xs`}
              >
                <option value="all">
                  {t('operations:connections.registry.filterAll', { count: connections.length })}
                </option>
                <option value="active">
                  {t('operations:connections.registry.filterActive', { count: statusCounts.active })}
                </option>
                <option value="idle">
                  {t('operations:connections.registry.filterIdle', { count: statusCounts.idle })}
                </option>
                <option value="error">
                  {t('operations:connections.registry.filterError', { count: statusCounts.error })}
                </option>
              </select>
            </div>

            <button
              type="button"
              onClick={openNewConnection}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-brand hover:bg-brand-hover rounded-[2px] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              {t('operations:connections.registry.addEndpoint')}
            </button>
          </div>
        </div>

        {/* Right-Side Slide-Over Drawer for Create / Edit PLC Connection */}
        <SlideOverDrawer
          open={showEditor}
          onClose={() => setShowEditor(false)}
          title={
            editingId
              ? t('operations:connections.drawer.titleEdit', { machineId })
              : t('operations:connections.drawer.titleNew')
          }
          subtitle={t('operations:connections.drawer.subtitle')}
          size="xl"
          footer={
            <>
              <button
                type="button"
                onClick={() => setShowEditor(false)}
                className="px-3.5 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-[#f4f6f9] border border-hairline-strong rounded-[2px] transition-colors cursor-pointer"
              >
                {t('common:actions.cancel')}
              </button>
              <button
                type="submit"
                form="erp-connection-drawer-form"
                className="px-4 py-1.5 text-xs font-medium text-white bg-brand hover:bg-brand-hover rounded-[2px] transition-colors cursor-pointer"
              >
                {editingId
                  ? t('operations:connections.drawer.updateBtn')
                  : t('operations:connections.drawer.saveBtn')}
              </button>
            </>
          }
        >
          <form id="erp-connection-drawer-form" onSubmit={handleSaveConnection} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-700 mb-1">
                  {t('operations:connections.drawer.displayName')}
                </label>
                <input
                  type="text"
                  value={connName}
                  onChange={(e) => setConnName(e.target.value)}
                  placeholder={t('operations:connections.drawer.displayNamePlaceholder')}
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700 mb-1">
                  {t('operations:connections.drawer.catalogProfile')}
                </label>
                <select
                  value={machineType}
                  onChange={(e) => handleMachineTypeChange(e.target.value)}
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                >
                  {(plcCatalog?.profiles.map((p) => ({
                    id: p.typeId,
                    label: `${p.typeId} — ${p.label} (${p.domain})`,
                  })) ?? FALLBACK_MACHINE_TYPES).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700 mb-1">
                  {t('operations:connections.drawer.machineId')}
                </label>
                <input
                  type="text"
                  required
                  value={machineId}
                  onChange={(e) => setMachineId(e.target.value)}
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700 mb-1">
                  {t('operations:connections.drawer.lineId')}
                </label>
                <input
                  type="text"
                  required
                  value={lineId}
                  onChange={(e) => setLineId(e.target.value)}
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700 mb-1">
                  {t('operations:connections.drawer.protocol')}
                </label>
                <select
                  value={protocol}
                  onChange={(e) => handleProtocolChange(e.target.value as ConnectionProtocol)}
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                >
                  {(Object.keys(PROTOCOL_DEFAULTS) as ConnectionProtocol[]).map((p) => (
                    <option key={p} value={p}>
                      {t(`operations:connections.protocols.${p}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700 mb-1">
                  {t('operations:connections.drawer.pollInterval')}
                </label>
                <select
                  value={pollIntervalSec}
                  onChange={(e) => setPollIntervalSec(Number(e.target.value) as PlcConnection['pollIntervalSec'])}
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                >
                  <option value={1}>{t('operations:connections.drawer.pollSec', { sec: 1 })}</option>
                  <option value={2}>{t('operations:connections.drawer.pollSec', { sec: 2 })}</option>
                  <option value={5}>{t('operations:connections.drawer.pollSec', { sec: 5 })}</option>
                  <option value={10}>{t('operations:connections.drawer.pollSec', { sec: 10 })}</option>
                  <option value={30}>{t('operations:connections.drawer.pollSec', { sec: 30 })}</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700 mb-1">
                  {t('operations:connections.drawer.host')}
                </label>
                <input
                  type="text"
                  required
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700 mb-1">
                  {t('operations:connections.drawer.port')}
                </label>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  required
                  value={port}
                  onChange={(e) => setPort(Number(e.target.value))}
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-[11px] font-medium text-slate-700 mb-1">
                  {t('operations:connections.drawer.endpointOrTopic')}
                </label>
                <input
                  type="text"
                  required
                  value={endpointOrTopic}
                  onChange={(e) => setEndpointOrTopic(e.target.value)}
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700 mb-1">
                  {t('operations:connections.drawer.transportPath')}
                </label>
                <select
                  value={deploymentTopology}
                  onChange={(e) => setDeploymentTopology(e.target.value as DeploymentTopology)}
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                >
                  <option value="on-premise-lan">{t('operations:connections.drawer.transportOnPrem')}</option>
                  <option value="edge-gateway-push">{t('operations:connections.drawer.transportEdge')}</option>
                  <option value="site-to-site-vpn">{t('operations:connections.drawer.transportVpn')}</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700 mb-1">
                  {t('operations:connections.drawer.authMode')}
                </label>
                <select
                  value={authMode}
                  onChange={(e) => setAuthMode(e.target.value as ConnectionAuthMode)}
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                >
                  <option value="anonymous">{t('operations:connections.drawer.authAnonymous')}</option>
                  <option value="x509-cert">{t('operations:connections.drawer.authX509')}</option>
                  <option value="username-password">{t('operations:connections.drawer.authUserPass')}</option>
                  <option value="bearer-token">{t('operations:connections.drawer.authBearer')}</option>
                </select>
              </div>
            </div>

            <div className="pt-3 border-t border-hairline space-y-2">
              <div className="text-[11px] font-semibold text-slate-700">
                {t('operations:connections.drawer.tagMappingTitle')}
              </div>
              <div className="grid grid-cols-1 gap-2">
                {tagBindings.map((binding, idx) => (
                  <div key={idx} className="p-2.5 bg-[#f8f9fb] border border-hairline rounded-[2px] text-xs font-mono space-y-1">
                    <div className="text-[10px] text-slate-500">
                      {t('operations:connections.drawer.tagEnvelope', {
                        metric: binding.targetMetric,
                        unit: binding.unit,
                        scale: binding.scaleFactor,
                      })}
                    </div>
                    <input
                      type="text"
                      value={binding.sourceTag}
                      onChange={(e) => {
                        const next = [...tagBindings];
                        next[idx] = { ...next[idx], sourceTag: e.target.value };
                        setTagBindings(next);
                      }}
                      className={`${ERP_INPUT_COMPACT_CLASS} font-mono text-[11px]`}
                    />
                  </div>
                ))}
              </div>
            </div>
          </form>
        </SlideOverDrawer>

        <div className="erp-table-scroll">
          <table className="w-full min-w-[980px] text-left border-collapse text-xs">
            <thead>
              <tr className={ERP_TABLE_HEAD_ROW_CLASS}>
                <th className="py-2.5 px-4">{t('operations:connections.registry.colEndpoint')}</th>
                <th className="py-2.5 px-3">{t('operations:connections.registry.colProtocol')}</th>
                <th className="py-2.5 px-3">{t('operations:connections.registry.colHostPort')}</th>
                <th className="py-2.5 px-3">{t('operations:connections.registry.colTags')}</th>
                <th className="py-2.5 px-3">{t('operations:connections.registry.colStatus')}</th>
                <th className="py-2.5 px-3 text-right">{t('operations:connections.registry.colIngested')}</th>
                <th className="py-2.5 px-4 text-right w-16">{t('operations:connections.registry.colActions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {filteredConnections.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 px-4 text-center text-xs text-slate-500">
                    <div className="space-y-2">
                      <div>
                        {t('operations:connections.registry.emptyFiltered', {
                          status: statusFilter.toUpperCase(),
                        })}
                      </div>
                      {statusFilter !== 'all' && (
                        <button
                          type="button"
                          onClick={() => {
                            setStatusFilter('all');
                            setConnectionsPage(1);
                          }}
                          className="text-brand font-medium hover:underline cursor-pointer"
                        >
                          {t('operations:connections.registry.resetStatusFilter')}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ) : (
                pagedConnections.map((conn) => (
                <tr key={conn.id} className="hover:bg-[#f8f9fb] transition-colors">
                  <td className="py-2.5 px-4">
                    <div className="font-semibold text-slate-900">{conn.name}</div>
                    <div className="font-mono text-[11px] text-slate-600">
                      {conn.machineId} · {conn.lineId} · {conn.machineType}
                    </div>
                  </td>
                  <td className="py-2.5 px-3 font-mono">
                    <div className="font-semibold text-slate-800">{conn.protocol.toUpperCase()}</div>
                    <div className="text-[11px] text-slate-500">
                      {conn.deploymentTopology} · {conn.pollIntervalSec}s
                    </div>
                  </td>
                  <td className="py-2.5 px-3 font-mono text-slate-700">
                    <div>
                      {conn.host}:{conn.port}
                    </div>
                    <div className="text-[11px] text-slate-500 max-w-xs truncate">{conn.endpointOrTopic}</div>
                  </td>
                  <td className="py-2.5 px-3 font-mono text-[11px] text-slate-600">
                    {conn.tagBindings.map((b) => `${b.targetMetric}←${b.sourceTag}`).slice(0, 2).join(', ')}
                    {conn.tagBindings.length > 2 ? ` (+${conn.tagBindings.length - 2})` : ''}
                  </td>
                  <td className="py-2.5 px-3 font-mono">
                    <span
                      className={`font-semibold ${
                        conn.status === 'connected'
                          ? 'text-emerald-700'
                          : conn.status === 'unreachable'
                          ? 'text-red-700'
                          : conn.status === 'disabled'
                          ? 'text-slate-400'
                          : 'text-slate-700'
                      }`}
                    >
                      {conn.status.toUpperCase()}
                    </span>
                    {conn.lastLatencyMs !== null && (
                      <div className="text-[11px] text-slate-500">{conn.lastLatencyMs} ms RTT</div>
                    )}
                    {conn.lastError && (
                      <div className="text-[10px] text-red-700 max-w-[200px] truncate" title={conn.lastError}>
                        {conn.lastError}
                      </div>
                    )}
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-800">
                    {conn.samplesIngested.toLocaleString()}
                  </td>
                  <td className="py-2.5 px-4 text-right whitespace-nowrap">
                    <RowActionMenu
                      ariaLabel={t('operations:connections.registry.actionsAria', { name: conn.name })}
                      items={[
                        {
                          id: 'probe',
                          label:
                            probingId === conn.id
                              ? t('operations:connections.registry.probingSocket')
                              : t('operations:connections.registry.probeSocket'),
                          icon: <Wifi className="w-3.5 h-3.5" />,
                          title: t('operations:connections.registry.probeTitle'),
                          disabled: !conn.enabled || probingId === conn.id,
                          onClick: () => void handleProbe(conn),
                        },
                        {
                          id: 'test-push',
                          label:
                            testingBatchId === conn.id
                              ? t('operations:connections.registry.sendingBatch')
                              : t('operations:connections.registry.testPush'),
                          icon: <Send className="w-3.5 h-3.5" />,
                          tone: 'primary',
                          title: t('operations:connections.registry.testPushTitle'),
                          disabled: !conn.enabled || testingBatchId === conn.id,
                          onClick: () => void handleSendTestBatch(conn),
                        },
                        {
                          id: 'edit',
                          label: t('operations:connections.registry.editConnection'),
                          icon: <Pencil className="w-3.5 h-3.5" />,
                          dividerBefore: true,
                          onClick: () => openEditConnection(conn),
                        },
                        {
                          id: 'toggle',
                          label: conn.enabled
                            ? t('operations:connections.registry.disableConnection')
                            : t('operations:connections.registry.enableConnection'),
                          icon: <Power className="w-3.5 h-3.5" />,
                          onClick: () => void handleToggleEnabled(conn),
                        },
                        {
                          id: 'delete',
                          label: t('operations:connections.registry.deleteConnection'),
                          icon: <Trash2 className="w-3.5 h-3.5" />,
                          tone: 'danger',
                          dividerBefore: true,
                          onClick: () => void handleDeleteConnection(conn.id),
                        },
                      ]}
                    />
                  </td>
                </tr>
              ))
              )}
            </tbody>
          </table>
        </div>

        <TablePagination
          currentPage={safeConnectionsPage}
          totalItems={filteredConnections.length}
          pageSize={DEFAULT_TABLE_PAGE_SIZE}
          maxVisiblePages={3}
          onPageChange={setConnectionsPage}
          itemLabel={t('operations:connections.pagination.endpoints')}
          hideWhenSinglePage
        />

        {lastProbe && (
          <div className="px-5 py-2.5 border-t border-hairline bg-[#f8f9fb] font-mono text-[11px] text-slate-600">
            {t('operations:connections.registry.lastProbe', {
              time: formatUtcTimestamp(lastProbe.checkedAt),
            })}{' '}
            {lastProbe.host}:{lastProbe.port} →{' '}
            {lastProbe.reachable
              ? t('operations:connections.registry.probeConnected', { ms: lastProbe.latencyMs })
              : `${lastProbe.errorCode}: ${lastProbe.errorMessage}`}
          </div>
        )}
      </section>

      {/* 3. On-Premise Corporate LAN Installation Kit */}
      <section className="bg-white border border-hairline rounded-[2px] overflow-hidden">
        <div className="px-5 py-3.5 border-b border-hairline bg-[#f8f9fb] flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div>
            <h2 className="text-[13px] font-semibold text-ink tracking-tight">
              {t('operations:connections.installKit.heading')}
            </h2>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {t('operations:connections.installKit.subtitle')}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className={ERP_SEGMENTED_GROUP_CLASS}>
              {(
                [
                  { id: 'compose', label: 'docker-compose.onprem.yml' },
                  { id: 'connections', label: 'connections.json' },
                  { id: 'env', label: 'edge-gateway.env' },
                  { id: 'script', label: 'install-onprem.sh' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveBundleTab(tab.id)}
                  className={`px-2.5 py-1.5 text-[11px] font-mono font-medium transition-colors cursor-pointer ${
                    activeBundleTab === tab.id
                      ? 'bg-brand text-white'
                      : 'text-slate-600 hover:bg-[#f4f6f9] hover:text-ink'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => handleCopy('bundle', activeBundleText)}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-hairline-strong hover:bg-[#f4f6f9] rounded-[2px] transition-colors cursor-pointer"
            >
              {copiedKey === 'bundle' ? <Check className="w-3.5 h-3.5 text-emerald-700" /> : <Copy className="w-3.5 h-3.5" />}
              {t('operations:connections.installKit.copy')}
            </button>
            <button
              type="button"
              onClick={() => handleDownloadFile(activeBundleFilename, activeBundleText)}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-hairline-strong hover:bg-[#f4f6f9] rounded-[2px] transition-colors cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              {t('operations:connections.installKit.download')}
            </button>
            <button
              type="button"
              onClick={refreshBundle}
              className="inline-flex items-center gap-1 px-2 py-1.5 text-xs font-medium text-slate-600 hover:text-ink cursor-pointer"
              aria-label={t('operations:connections.installKit.refreshAria')}
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <pre className="p-4 bg-chrome text-slate-200 font-mono text-[11px] leading-relaxed overflow-x-auto max-h-80">
          {activeBundleText}
        </pre>
      </section>

      {/* 4. Grafana & Power BI Ready Connectors */}
      <section className="bg-white border border-hairline rounded-[2px] overflow-hidden">
        <div className="px-5 py-3.5 border-b border-hairline bg-[#f8f9fb] flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h2 className="text-[13px] font-semibold text-ink tracking-tight">
              {t('operations:connections.connectors.heading')}
            </h2>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {t('operations:connections.connectors.subtitle')}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <a
              href="/api/v1/ba/kpi?format=csv"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-hairline-strong hover:bg-[#f4f6f9] rounded-[2px] transition-colors whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              {t('operations:connections.connectors.downloadPowerBiCsv')}
            </a>
            <a
              href="/api/v1/ba/kpi"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono text-brand bg-brand-subtle border border-brand-border hover:bg-[#e3ecf7] rounded-[2px] transition-colors whitespace-nowrap"
            >
              {t('operations:connections.connectors.openBaJson')}
            </a>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-hairline text-xs">
          <div className="p-5 space-y-2">
            <div className="font-semibold text-ink">
              {t('operations:connections.connectors.grafanaTitle')}
            </div>
            <div className="text-slate-600">
              {t('operations:connections.connectors.grafanaDescPrefix')}{' '}
              <span className="font-mono">docker-compose.onprem.yml</span>{' '}
              {t('operations:connections.connectors.grafanaDescMiddle')}{' '}
              <span className="font-mono text-ink">PostgreSQL-ML</span>.
            </div>
            <div className="font-mono text-[11px] bg-[#f8f9fb] border border-hairline rounded-[2px] p-2.5 text-slate-700 space-y-1">
              <div>
                {t('operations:connections.connectors.grafanaTablesLabel')}{' '}
                <span className="text-ink font-semibold">ml_machine_features</span> ·{' '}
                <span className="text-ink font-semibold">vw_ba_controllo_gestione_daily</span>
              </div>
              <div>
                {t('operations:connections.connectors.grafanaDashboardsLabel')}{' '}
                <span className="text-ink">ML Feature Store Overview</span> &amp;{' '}
                <span className="text-ink">BA / OEE Daily Rollup</span>
              </div>
            </div>
          </div>

          <div className="p-5 space-y-2">
            <div className="font-semibold text-ink">
              {t('operations:connections.connectors.powerBiTitle')}
            </div>
            <div className="text-slate-600">
              {t('operations:connections.connectors.powerBiDesc')}
            </div>
            <div className="font-mono text-[11px] bg-[#f8f9fb] border border-hairline rounded-[2px] p-2.5 text-slate-700 flex items-center justify-between gap-2">
              <span className="truncate">/api/v1/ba/kpi?format=csv&amp;fields=dt,machine_id,machine_type,availability_oee_pct,primary_metric_avg</span>
              <button
                type="button"
                onClick={() =>
                  handleCopy(
                    'powerbi-url',
                    `${window.location.origin}/api/v1/ba/kpi?format=csv`
                  )
                }
                className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] bg-white border border-hairline-strong rounded-[2px] hover:bg-[#f4f6f9] shrink-0 cursor-pointer"
              >
                {copiedKey === 'powerbi-url' ? <Check className="w-3 h-3 text-emerald-700" /> : <Copy className="w-3 h-3" />}
                {t('operations:connections.connectors.copyUrl')}
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
