import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  Cpu,
  Eye,
  FileCode2,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Search,
  Trash2,
} from 'lucide-react';
import type {
  ConnectionProtocol,
  MachineDomain,
  PlcBaFormula,
  PlcCatalogListResponse,
  PlcCatalogProfile,
  PlcExtraChannelSpec,
} from '../types/pipeline';
import { apiFetch } from '../utils/apiAuth';
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

interface PlcCatalogSectionProps {
  plcCatalog: PlcCatalogListResponse | null;
  onCatalogUpdated: (catalog: PlcCatalogListResponse) => void;
  onUseInSimulation: (typeId: string) => void;
}

interface PreviewOutputPayload {
  typeId: string;
  profile: PlcCatalogProfile;
  sampleEnvelope: Record<string, unknown>;
  projectedFeatureWindow: Record<string, unknown>;
  projectedBaKpi: Record<string, unknown>;
}

const DEFAULT_OUTPUT_FIELDS = [
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
];

function parseExtraChannelsText(text: string): PlcExtraChannelSpec[] {
  const specs: PlcExtraChannelSpec[] = [];
  for (const part of text.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [rawKey, rawUnit, rawNominal, rawStd] = trimmed.split(':').map((s) => s.trim());
    const key = rawKey.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (!key) continue;
    const nominal = Number(rawNominal);
    const std = Number(rawStd);
    specs.push({
      key,
      unit: rawUnit || 'unit',
      nominal: Number.isFinite(nominal) ? nominal : 0,
      std: Number.isFinite(std) && std > 0 ? std : 1,
    });
  }
  return specs;
}

function formatExtraChannelsText(channels: PlcExtraChannelSpec[]): string {
  return channels.map((c) => `${c.key}:${c.unit}:${c.nominal}:${c.std}`).join(', ');
}

export function PlcCatalogSection({
  plcCatalog,
  onCatalogUpdated,
  onUseInSimulation,
}: PlcCatalogSectionProps) {
  const { t } = useTranslation(['configuration', 'common']);
  const [searchQuery, setSearchQuery] = useState('');
  const [domainFilter, setDomainFilter] = useState<'all' | MachineDomain>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Slide-over drawer for Create / Edit PLC Profile
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingBuiltIn, setEditingBuiltIn] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [drawerError, setDrawerError] = useState<string | null>(null);

  const [formTypeId, setFormTypeId] = useState('');
  const [formLabel, setFormLabel] = useState('');
  const [formVendor, setFormVendor] = useState('');
  const [formDomain, setFormDomain] = useState<MachineDomain>('manufacturing');
  const [formProtocol, setFormProtocol] = useState<ConnectionProtocol>('opcua');
  const [formPort, setFormPort] = useState<number>(4840);
  const [formPrimaryKey, setFormPrimaryKey] = useState('cycle_ms');
  const [formPrimaryUnit, setFormPrimaryUnit] = useState('ms');
  const [formPrimaryNominal, setFormPrimaryNominal] = useState<number>(800);
  const [formPrimaryFault, setFormPrimaryFault] = useState<number>(1200);
  const [formSecondaryKey, setFormSecondaryKey] = useState('vibration_mm_s');
  const [formSecondaryUnit, setFormSecondaryUnit] = useState('mm/s');
  const [formSecondaryNominal, setFormSecondaryNominal] = useState<number>(1.2);
  const [formTempNominal, setFormTempNominal] = useState<number>(48);
  const [formTempFault, setFormTempFault] = useState<number>(82);
  const [formBaFormula, setFormBaFormula] = useState<PlcBaFormula>('oee_cycle_count');
  const [formExtraChannels, setFormExtraChannels] = useState('');
  const [formOutputFields, setFormOutputFields] = useState<string[]>(DEFAULT_OUTPUT_FIELDS);

  // Output Contract Preview Drawer
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewState, setPreviewState] = useState<'RUNNING' | 'DEGRADED' | 'FAULT'>('RUNNING');
  const [previewData, setPreviewData] = useState<PreviewOutputPayload | null>(null);
  const [previewTypeId, setPreviewTypeId] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const profiles = useMemo(() => plcCatalog?.profiles ?? [], [plcCatalog]);
  const availableFields = useMemo(
    () => plcCatalog?.availableOutputFields ?? DEFAULT_OUTPUT_FIELDS,
    [plcCatalog]
  );

  const filteredProfiles = useMemo(() => profiles.filter((p) => {
      if (domainFilter !== 'all' && p.domain !== domainFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        return (
          p.typeId.toLowerCase().includes(q) ||
          p.label.toLowerCase().includes(q) ||
          p.vendorFamily.toLowerCase().includes(q) ||
          p.primaryKey.toLowerCase().includes(q)
        );
      }
      return true;
    }), [profiles, domainFilter, searchQuery]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, domainFilter]);

  const { pageItems: pagedProfiles, safePage } = paginateItems(
    filteredProfiles,
    currentPage,
    DEFAULT_TABLE_PAGE_SIZE
  );

  const refreshCatalog = async () => {
    const resp = await apiFetch('/api/v1/catalog/machines');
    if (resp.ok) {
      const data = (await resp.json()) as PlcCatalogListResponse;
      onCatalogUpdated(data);
    }
  };

  const closeProfileDrawer = () => {
    setDrawerOpen(false);
    setDrawerError(null);
  };

  const applySampleTemplate = () => {
    setFormTypeId('abb-robotics-irb');
    setFormLabel('ABB IRC5 Robot Cell');
    setFormVendor('ABB Automation');
    setFormDomain('manufacturing');
    setFormProtocol('opcua');
    setFormPort(4840);
    setFormPrimaryKey('cycle_ms');
    setFormPrimaryUnit('ms');
    setFormPrimaryNominal(840);
    setFormPrimaryFault(1250);
    setFormSecondaryKey('vibration_mm_s');
    setFormSecondaryUnit('mm/s');
    setFormSecondaryNominal(1.35);
    setFormTempNominal(48);
    setFormTempFault(82);
    setFormBaFormula('oee_cycle_count');
    setFormExtraChannels('axis_torque_nm:Nm:42.5:3.8, servo_current_a:A:14.2:1.4');
    setFormOutputFields(DEFAULT_OUTPUT_FIELDS);
    setDrawerError(null);
  };

  const openNewProfileDrawer = () => {
    setIsEditing(false);
    setEditingBuiltIn(false);
    setDrawerError(null);
    setFormTypeId('');
    setFormLabel('');
    setFormVendor('');
    setFormDomain('manufacturing');
    setFormProtocol('opcua');
    setFormPort(4840);
    setFormPrimaryKey('cycle_ms');
    setFormPrimaryUnit('ms');
    setFormPrimaryNominal(800);
    setFormPrimaryFault(1200);
    setFormSecondaryKey('vibration_mm_s');
    setFormSecondaryUnit('mm/s');
    setFormSecondaryNominal(1.2);
    setFormTempNominal(48);
    setFormTempFault(82);
    setFormBaFormula('oee_cycle_count');
    setFormExtraChannels('');
    setFormOutputFields(DEFAULT_OUTPUT_FIELDS);
    setDrawerOpen(true);
  };

  const openEditProfileDrawer = (p: PlcCatalogProfile) => {
    setIsEditing(true);
    setEditingBuiltIn(Boolean(p.isBuiltIn));
    setDrawerError(null);
    setFormTypeId(p.typeId);
    setFormLabel(p.label);
    setFormVendor(p.vendorFamily);
    setFormDomain(p.domain);
    setFormProtocol(p.defaultProtocol);
    setFormPort(p.defaultPort);
    setFormPrimaryKey(p.primaryKey);
    setFormPrimaryUnit(p.primaryUnit);
    setFormPrimaryNominal(p.primaryNominal);
    setFormPrimaryFault(p.primaryFaultThreshold);
    setFormSecondaryKey(p.secondaryKey);
    setFormSecondaryUnit(p.secondaryUnit);
    setFormSecondaryNominal(p.secondaryNominal);
    setFormTempNominal(p.tempNominalC);
    setFormTempFault(p.tempFaultThresholdC);
    setFormBaFormula(p.baFormula);
    setFormExtraChannels(formatExtraChannelsText(p.extraChannels));
    setFormOutputFields(
      p.defaultOutputFields.length > 0 ? p.defaultOutputFields : DEFAULT_OUTPUT_FIELDS
    );
    setDrawerOpen(true);
  };

  const toggleFormOutputField = (field: string) => {
    setFormOutputFields((prev) => {
      if (prev.includes(field)) {
        return prev.length > 1 ? prev.filter((f) => f !== field) : prev;
      }
      return [...prev, field];
    });
  };

  const normalizedTypeId = formTypeId
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-_]/g, '');

  const handleSaveProfile = async (e: FormEvent) => {
    e.preventDefault();
    setDrawerError(null);

    if (!normalizedTypeId) {
      setDrawerError(t('configuration:plcCatalog.messages.errTypeIdRequired'));
      return;
    }
    if (!formLabel.trim()) {
      setDrawerError(t('configuration:plcCatalog.messages.errLabelRequired'));
      return;
    }
    if (!formPrimaryKey.trim() || !formSecondaryKey.trim()) {
      setDrawerError(t('configuration:plcCatalog.messages.errChannelsRequired'));
      return;
    }

    setSaving(true);
    setBanner(null);
    try {
      const payload = {
        typeId: normalizedTypeId,
        label: formLabel.trim(),
        vendorFamily: formVendor.trim() || 'Generic OT',
        domain: formDomain,
        defaultProtocol: formProtocol,
        defaultPort: Number(formPort),
        primaryKey: formPrimaryKey.trim(),
        primaryUnit: formPrimaryUnit.trim() || 'unit',
        primaryNominal: Number(formPrimaryNominal),
        primaryStd: Math.max(0.1, Number((Math.abs(formPrimaryNominal) * 0.05).toFixed(2))),
        primaryFaultThreshold: Number(formPrimaryFault),
        secondaryKey: formSecondaryKey.trim(),
        secondaryUnit: formSecondaryUnit.trim() || 'unit',
        secondaryNominal: Number(formSecondaryNominal),
        secondaryStd: Math.max(0.05, Number((Math.abs(formSecondaryNominal) * 0.08).toFixed(2))),
        tempNominalC: Number(formTempNominal),
        tempStdC: 2.2,
        tempFaultThresholdC: Number(formTempFault),
        extraChannels: parseExtraChannelsText(formExtraChannels),
        defaultOutputFields: formOutputFields,
        baFormula: formBaFormula,
      };
      const resp = await apiFetch('/api/v1/catalog/machines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = (await resp.json().catch(() => ({}))) as {
        error?: string;
        profile?: PlcCatalogProfile;
      };
      if (!resp.ok) {
        throw new Error(
          body.error || t('configuration:plcCatalog.messages.errSaveStatus', { status: resp.status })
        );
      }
      await refreshCatalog();
      closeProfileDrawer();
      setBanner({
        kind: 'ok',
        text: t('configuration:plcCatalog.messages.savedOk', {
          typeId: body.profile?.typeId ?? payload.typeId,
          count: payload.extraChannels.length,
        }),
      });
    } catch (err) {
      setDrawerError(
        err instanceof Error ? err.message : t('configuration:plcCatalog.messages.errSaveGeneric')
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteOrReset = async (profile: PlcCatalogProfile) => {
    setBanner(null);
    try {
      const resp = await apiFetch(`/api/v1/catalog/machines/${encodeURIComponent(profile.typeId)}`, {
        method: 'DELETE',
      });
      if (!resp.ok) {
        const body = (await resp.json().catch(() => ({}))) as { error?: string };
        throw new Error(
          body.error || t('configuration:plcCatalog.messages.errDeleteStatus', { status: resp.status })
        );
      }
      const res = (await resp.json()) as { deleted: boolean; resetToBuiltIn: boolean };
      await refreshCatalog();
      setBanner({
        kind: 'ok',
        text: res.resetToBuiltIn
          ? t('configuration:plcCatalog.messages.resetOk', { typeId: profile.typeId })
          : t('configuration:plcCatalog.messages.deletedOk', { typeId: profile.typeId }),
      });
    } catch (err) {
      setBanner({
        kind: 'err',
        text:
          err instanceof Error ? err.message : t('configuration:plcCatalog.messages.errDeleteGeneric'),
      });
    }
  };

  const fetchPreview = async (
    typeId: string,
    state: 'RUNNING' | 'DEGRADED' | 'FAULT' = previewState
  ) => {
    setPreviewError(null);
    setPreviewData(null);
    setPreviewTypeId(typeId);
    setPreviewOpen(true);
    try {
      const resp = await apiFetch(
        `/api/v1/catalog/machines/${encodeURIComponent(typeId)}/preview-output`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            machineId: `${typeId.toUpperCase().slice(0, 10)}-01`,
            lineId: 'line-01',
            state,
          }),
        }
      );
      if (!resp.ok) {
        throw new Error(t('configuration:plcCatalog.messages.errPreviewStatus', { status: resp.status }));
      }
      const data = (await resp.json()) as PreviewOutputPayload;
      setPreviewData(data);
    } catch (err) {
      setPreviewError(
        err instanceof Error ? err.message : t('configuration:plcCatalog.messages.errPreviewGeneric')
      );
    }
  };

  return (
    <div className="space-y-5">
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

      <section className="bg-white overflow-hidden">
        <div className="px-5 py-4 border-b border-hairline flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-[15px] font-semibold tracking-tight text-ink flex items-center gap-2">
              <Cpu className="w-4 h-4 text-brand" />
              {t('configuration:plcCatalog.title')} ({profiles.length})
            </h1>
            <p className="text-xs text-slate-600 mt-0.5">
              {t('configuration:plcCatalog.subtitle')}
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <a
              href="/api/v1/ba/kpi?format=csv"
              target="_blank"
              rel="noreferrer"
              className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-[#f4f6f9] border border-hairline-strong rounded-[2px] transition-colors whitespace-nowrap"
            >
              {t('configuration:plcCatalog.exportBaKpiCsv')}
            </a>
            <button
              type="button"
              onClick={openNewProfileDrawer}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-brand hover:bg-brand-hover rounded-[2px] transition-colors cursor-pointer whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              {t('configuration:plcCatalog.newProfile')}
            </button>
          </div>
        </div>

        {/* Filter Bar */}
        <div className="px-5 py-3 bg-white flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="relative w-full sm:w-64">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('configuration:plcCatalog.searchPlaceholder')}
                aria-label={t('configuration:plcCatalog.searchAria')}
                className={`${ERP_INPUT_COMPACT_CLASS} pl-8`}
              />
            </div>

            <div className={ERP_SEGMENTED_GROUP_CLASS}>
              {(
                [
                  { id: 'all', label: t('configuration:plcCatalog.domains.all') },
                  { id: 'manufacturing', label: t('configuration:plcCatalog.domains.manufacturing') },
                  { id: 'gas-metering', label: t('configuration:plcCatalog.domains.gas-metering') },
                  { id: 'power-generation', label: t('configuration:plcCatalog.domains.power-generation') },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setDomainFilter(tab.id)}
                  className={`px-2.5 py-1.5 text-[11px] font-medium transition-colors whitespace-nowrap cursor-pointer ${
                    domainFilter === tab.id
                      ? 'bg-brand text-white'
                      : 'text-slate-600 hover:bg-[#f4f6f9] hover:text-ink'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <div className="text-[11px] font-mono text-slate-600 tabular-nums">
            {t('configuration:plcCatalog.showingCount', {
              shown: filteredProfiles.length,
              total: profiles.length,
            })}
          </div>
        </div>

        {/* High-Density Catalog Table */}
        <div className="erp-table-scroll">
          <table className="w-full min-w-[980px] text-left border-collapse text-xs">
            <thead>
              <tr className={ERP_TABLE_HEAD_ROW_CLASS}>
                <th className="py-2.5 px-4">{t('configuration:plcCatalog.table.colType')}</th>
                <th className="py-2.5 px-3">{t('configuration:plcCatalog.table.colVendor')}</th>
                <th className="py-2.5 px-3">{t('configuration:plcCatalog.table.colProtocol')}</th>
                <th className="py-2.5 px-3">{t('configuration:plcCatalog.table.colPrimary')}</th>
                <th className="py-2.5 px-3">{t('configuration:plcCatalog.table.colTemp')}</th>
                <th className="py-2.5 px-3">{t('configuration:plcCatalog.table.colExtra')}</th>
                <th className="py-2.5 px-4 text-right w-16">{t('configuration:plcCatalog.table.colActions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {filteredProfiles.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-10 px-4 text-center text-xs text-slate-600">
                    <p>
                      {profiles.length === 0
                        ? t('configuration:plcCatalog.table.emptyCatalog')
                        : t('configuration:plcCatalog.table.emptyFiltered')}
                    </p>
                    <div className="mt-3 flex items-center justify-center gap-2">
                      {(searchQuery || domainFilter !== 'all') && (
                        <button
                          type="button"
                          onClick={() => {
                            setSearchQuery('');
                            setDomainFilter('all');
                          }}
                          className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-[#f4f6f9] border border-hairline-strong rounded-[2px] cursor-pointer whitespace-nowrap"
                        >
                          {t('configuration:plcCatalog.table.resetFilters')}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={openNewProfileDrawer}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-brand hover:bg-brand-hover rounded-[2px] cursor-pointer whitespace-nowrap"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        {t('configuration:plcCatalog.newProfile')}
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                pagedProfiles.map((p) => (
                  <tr key={p.typeId} className="hover:bg-[#f8f9fb] transition-colors">
                    <td className="py-2.5 px-4">
                      <div className="font-mono font-semibold text-slate-900">
                        {p.typeId}
                        {!p.isBuiltIn && (
                          <span className="ml-2 font-sans text-[10px] font-semibold uppercase text-brand">
                            {t('configuration:plcCatalog.customBadge')}
                          </span>
                        )}
                      </div>
                      <div className="text-slate-600">{p.label}</div>
                    </td>
                    <td className="py-2.5 px-3">
                      <div className="text-slate-800">{p.vendorFamily}</div>
                      <div className="font-mono text-[11px] text-slate-500">{p.domain}</div>
                    </td>
                    <td className="py-2.5 px-3 font-mono text-slate-700 whitespace-nowrap">
                      {p.defaultProtocol}:{p.defaultPort}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-slate-800 whitespace-nowrap tabular-nums">
                      <div>
                        {p.primaryKey} ({p.primaryNominal} {p.primaryUnit})
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {t('configuration:plcCatalog.table.faultThreshold', {
                          threshold: p.primaryFaultThreshold,
                          unit: p.primaryUnit,
                        })}
                      </div>
                    </td>
                    <td className="py-2.5 px-3 font-mono text-slate-700 whitespace-nowrap tabular-nums">
                      {p.tempNominalC}°C / <span className="text-red-700">{p.tempFaultThresholdC}°C</span>
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[11px] text-slate-600">
                      <div>
                        {p.extraChannels.length > 0
                          ? p.extraChannels.map((c) => c.key).join(', ')
                          : '—'}
                      </div>
                      <div className="text-slate-500">{p.baFormula}</div>
                    </td>
                    <td className="py-2.5 px-4 text-right whitespace-nowrap">
                      <RowActionMenu
                        ariaLabel={t('configuration:plcCatalog.table.actionsAria', { typeId: p.typeId })}
                        items={[
                          {
                            id: 'simulate',
                            label: t('configuration:plcCatalog.useInSimulation'),
                            icon: <Play className="w-3.5 h-3.5" />,
                            tone: 'primary',
                            title: t('configuration:plcCatalog.useInSimulationTitle'),
                            onClick: () => onUseInSimulation(p.typeId),
                          },
                          {
                            id: 'preview',
                            label: t('configuration:plcCatalog.previewOutput'),
                            icon: <Eye className="w-3.5 h-3.5" />,
                            title: t('configuration:plcCatalog.previewOutputTitle'),
                            onClick: () => void fetchPreview(p.typeId),
                          },
                          {
                            id: 'edit',
                            label: t('configuration:plcCatalog.editProfile'),
                            icon: <Pencil className="w-3.5 h-3.5" />,
                            onClick: () => openEditProfileDrawer(p),
                          },
                          {
                            id: 'delete-or-reset',
                            label: p.isBuiltIn
                              ? t('configuration:plcCatalog.resetBuiltIn')
                              : t('configuration:plcCatalog.deleteCustom'),
                            icon: p.isBuiltIn ? (
                              <RotateCcw className="w-3.5 h-3.5" />
                            ) : (
                              <Trash2 className="w-3.5 h-3.5" />
                            ),
                            tone: 'danger',
                            dividerBefore: true,
                            onClick: () => void handleDeleteOrReset(p),
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
          currentPage={safePage}
          totalItems={filteredProfiles.length}
          pageSize={DEFAULT_TABLE_PAGE_SIZE}
          maxVisiblePages={3}
          onPageChange={setCurrentPage}
          itemLabel={t('configuration:plcCatalog.pagination.profiles')}
          hideWhenSinglePage
        />
      </section>

      {/* Right-Side Drawer: Create / Edit PLC Profile */}
      <SlideOverDrawer
        open={drawerOpen}
        onClose={closeProfileDrawer}
        title={
          isEditing
            ? t('configuration:plcCatalog.drawer.titleEdit', { typeId: formTypeId })
            : t('configuration:plcCatalog.drawer.titleNew')
        }
        subtitle={
          editingBuiltIn
            ? t('configuration:plcCatalog.drawer.subtitleBuiltIn')
            : t('configuration:plcCatalog.drawer.subtitleCustom')
        }
        size="xl"
        headerActions={
          !isEditing ? (
            <button
              type="button"
              onClick={applySampleTemplate}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-slate-700 bg-white hover:bg-[#f4f6f9] border border-hairline-strong rounded-[2px] transition-colors cursor-pointer whitespace-nowrap"
            >
              <FileCode2 className="w-3 h-3 text-brand" />
              {t('configuration:plcCatalog.drawer.loadSample')}
            </button>
          ) : undefined
        }
        footer={
          <>
            <button
              type="button"
              onClick={closeProfileDrawer}
              className="px-3.5 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-[#f4f6f9] border border-hairline-strong rounded-[2px] transition-colors cursor-pointer whitespace-nowrap"
            >
              {t('common:actions.cancel')}
            </button>
            <button
              type="submit"
              form="erp-plc-profile-form"
              disabled={saving}
              className="px-4 py-1.5 text-xs font-medium text-white bg-brand hover:bg-brand-hover disabled:opacity-50 rounded-[2px] transition-colors cursor-pointer whitespace-nowrap"
            >
              {saving
                ? t('common:actions.saving')
                : isEditing
                  ? t('configuration:plcCatalog.drawer.saveBtn')
                  : t('configuration:plcCatalog.drawer.createBtn')}
            </button>
          </>
        }
      >
        <form id="erp-plc-profile-form" onSubmit={handleSaveProfile} className="space-y-4 text-xs">
          {drawerError && (
            <div
              role="alert"
              className="px-3 py-2.5 rounded-[2px] border border-red-300 bg-red-50 text-red-900 text-xs flex items-start gap-2"
            >
              <AlertCircle className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
              <span>{drawerError}</span>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="plc-type-id" className="block text-[11px] font-medium text-slate-700 mb-1">
                {t('configuration:plcCatalog.drawer.typeId')}
              </label>
              <input
                id="plc-type-id"
                type="text"
                required
                disabled={isEditing}
                value={formTypeId}
                onChange={(e) => setFormTypeId(e.target.value)}
                placeholder={t('configuration:plcCatalog.drawer.typeIdPlaceholder')}
                className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
              />
              {!isEditing && formTypeId.trim() !== '' && normalizedTypeId !== formTypeId.trim() && (
                <p className="mt-1 text-[10px] font-mono text-slate-500">
                  {t('configuration:plcCatalog.drawer.savedAs')}{' '}
                  <span className="text-slate-800">
                    {normalizedTypeId || t('configuration:plcCatalog.drawer.invalidSlug')}
                  </span>
                </p>
              )}
            </div>
            <div>
              <label htmlFor="plc-display-label" className="block text-[11px] font-medium text-slate-700 mb-1">
                {t('configuration:plcCatalog.drawer.displayLabel')}
              </label>
              <input
                id="plc-display-label"
                type="text"
                required
                value={formLabel}
                onChange={(e) => setFormLabel(e.target.value)}
                placeholder={t('configuration:plcCatalog.drawer.displayLabelPlaceholder')}
                className={ERP_INPUT_COMPACT_CLASS}
              />
            </div>
            <div>
              <label htmlFor="plc-vendor" className="block text-[11px] font-medium text-slate-700 mb-1">
                {t('configuration:plcCatalog.drawer.vendorFamily')}
              </label>
              <input
                id="plc-vendor"
                type="text"
                value={formVendor}
                onChange={(e) => setFormVendor(e.target.value)}
                placeholder={t('configuration:plcCatalog.drawer.vendorPlaceholder')}
                className={ERP_INPUT_COMPACT_CLASS}
              />
            </div>
            <div>
              <label htmlFor="plc-domain" className="block text-[11px] font-medium text-slate-700 mb-1">
                {t('configuration:plcCatalog.drawer.domain')}
              </label>
              <select
                id="plc-domain"
                value={formDomain}
                onChange={(e) => setFormDomain(e.target.value as MachineDomain)}
                className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
              >
                <option value="manufacturing">{t('configuration:plcCatalog.domains.manufacturing')}</option>
                <option value="gas-metering">{t('configuration:plcCatalog.domains.gas-metering')}</option>
                <option value="power-generation">{t('configuration:plcCatalog.domains.power-generation')}</option>
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-700 mb-1">
                {t('configuration:plcCatalog.drawer.protocolPort')}
              </label>
              <div className="flex gap-1.5">
                <select
                  value={formProtocol}
                  onChange={(e) => setFormProtocol(e.target.value as ConnectionProtocol)}
                  className={`${ERP_INPUT_COMPACT_CLASS} w-2/3 font-mono`}
                >
                  <option value="opcua">opcua</option>
                  <option value="modbus-tcp">modbus-tcp</option>
                  <option value="mqtt-sparkplug">mqtt-sparkplug</option>
                  <option value="http-rest-meter">http-rest-meter</option>
                </select>
                <input
                  type="number"
                  value={formPort}
                  onChange={(e) => setFormPort(Number(e.target.value))}
                  className={`${ERP_INPUT_COMPACT_CLASS} w-1/3 font-mono`}
                />
              </div>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-700 mb-1">
                {t('configuration:plcCatalog.drawer.baFormula')}
              </label>
              <select
                value={formBaFormula}
                onChange={(e) => setFormBaFormula(e.target.value as PlcBaFormula)}
                className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
              >
                <option value="oee_cycle_count">oee_cycle_count</option>
                <option value="gas_nm3_integration">gas_nm3_integration</option>
                <option value="energy_kwh_integration">energy_kwh_integration</option>
                <option value="custom_throughput">custom_throughput</option>
              </select>
            </div>
          </div>

          <div className="pt-3 border-t border-hairline grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-slate-700 mb-1">
                {t('configuration:plcCatalog.drawer.primaryKeyUnit')}
              </label>
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={formPrimaryKey}
                  onChange={(e) => setFormPrimaryKey(e.target.value)}
                  className={`${ERP_INPUT_COMPACT_CLASS} w-2/3 font-mono`}
                />
                <input
                  type="text"
                  value={formPrimaryUnit}
                  onChange={(e) => setFormPrimaryUnit(e.target.value)}
                  className={`${ERP_INPUT_COMPACT_CLASS} w-1/3 font-mono`}
                />
              </div>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-700 mb-1">
                {t('configuration:plcCatalog.drawer.primaryNomFault')}
              </label>
              <div className="flex gap-1.5">
                <input
                  type="number"
                  step="0.1"
                  value={formPrimaryNominal}
                  onChange={(e) => setFormPrimaryNominal(Number(e.target.value))}
                  className={`${ERP_INPUT_COMPACT_CLASS} w-1/2 font-mono`}
                />
                <input
                  type="number"
                  step="0.1"
                  value={formPrimaryFault}
                  onChange={(e) => setFormPrimaryFault(Number(e.target.value))}
                  className={`${ERP_INPUT_COMPACT_CLASS} w-1/2 font-mono`}
                />
              </div>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-700 mb-1">
                {t('configuration:plcCatalog.drawer.secondaryKeyUnit')}
              </label>
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={formSecondaryKey}
                  onChange={(e) => setFormSecondaryKey(e.target.value)}
                  className={`${ERP_INPUT_COMPACT_CLASS} w-2/3 font-mono`}
                />
                <input
                  type="text"
                  value={formSecondaryUnit}
                  onChange={(e) => setFormSecondaryUnit(e.target.value)}
                  className={`${ERP_INPUT_COMPACT_CLASS} w-1/3 font-mono`}
                />
              </div>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-700 mb-1">
                {t('configuration:plcCatalog.drawer.secondaryTemp')}
              </label>
              <div className="grid grid-cols-3 gap-1.5">
                <input
                  type="number"
                  step="0.1"
                  value={formSecondaryNominal}
                  onChange={(e) => setFormSecondaryNominal(Number(e.target.value))}
                  title={t('configuration:plcCatalog.drawer.secondaryNominalTitle')}
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                />
                <input
                  type="number"
                  step="1"
                  value={formTempNominal}
                  onChange={(e) => setFormTempNominal(Number(e.target.value))}
                  title={t('configuration:plcCatalog.drawer.tempNominalTitle')}
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                />
                <input
                  type="number"
                  step="1"
                  value={formTempFault}
                  onChange={(e) => setFormTempFault(Number(e.target.value))}
                  title={t('configuration:plcCatalog.drawer.tempFaultTitle')}
                  className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
                />
              </div>
            </div>
          </div>

          <div className="pt-3 border-t border-hairline">
            <label className="block text-[11px] font-medium text-slate-700 mb-1">
              {t('configuration:plcCatalog.drawer.extraChannels')} (
              <code className="font-mono">key:unit:nominal:std, ...</code>)
            </label>
            <input
              type="text"
              value={formExtraChannels}
              onChange={(e) => setFormExtraChannels(e.target.value)}
              className={`${ERP_INPUT_COMPACT_CLASS} font-mono`}
            />
          </div>

          <div className="pt-3 border-t border-hairline space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-slate-700">
                {t('configuration:plcCatalog.drawer.outputFields', {
                  selected: formOutputFields.length,
                  total: availableFields.length,
                })}
              </span>
              <button
                type="button"
                onClick={() => setFormOutputFields(availableFields)}
                className="text-[11px] text-brand hover:underline cursor-pointer"
              >
                {t('configuration:plcCatalog.drawer.selectAll')}
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {availableFields.map((field) => {
                const active = formOutputFields.includes(field);
                return (
                  <button
                    key={field}
                    type="button"
                    onClick={() => toggleFormOutputField(field)}
                    className={`px-2 py-1 text-[11px] font-mono border rounded-[2px] transition-colors cursor-pointer ${
                      active
                        ? 'bg-brand text-white border-brand'
                        : 'bg-white text-slate-700 border-hairline-strong hover:bg-[#f4f6f9]'
                    }`}
                  >
                    {field}
                  </button>
                );
              })}
            </div>
          </div>
        </form>
      </SlideOverDrawer>

      {/* Right-Side Drawer: Contract Output Preview */}
      <SlideOverDrawer
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title={t('configuration:plcCatalog.preview.title', { typeId: previewTypeId ?? '' })}
        subtitle={t('configuration:plcCatalog.preview.subtitle')}
        size="xl"
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 bg-[#f8f9fb] border border-hairline rounded-[2px] p-3">
            <span className="text-xs font-medium text-slate-700">
              {t('configuration:plcCatalog.preview.simulatedState')}
            </span>
            <div className={ERP_SEGMENTED_GROUP_CLASS}>
              {(['RUNNING', 'DEGRADED', 'FAULT'] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => {
                    setPreviewState(st);
                    if (previewTypeId) void fetchPreview(previewTypeId, st);
                  }}
                  className={`px-2.5 py-1 text-[11px] font-mono font-medium transition-colors cursor-pointer ${
                    previewState === st
                      ? 'bg-brand text-white'
                      : 'text-slate-700 hover:bg-[#f4f6f9]'
                  }`}
                >
                  {st}
                </button>
              ))}
            </div>
          </div>

          {previewError ? (
            <div
              role="alert"
              className="px-3 py-2.5 rounded-[2px] border border-red-300 bg-red-50 text-red-900 text-xs flex items-center justify-between gap-3"
            >
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
                <span>{previewError}</span>
              </div>
              {previewTypeId && (
                <button
                  type="button"
                  onClick={() => void fetchPreview(previewTypeId, previewState)}
                  className="px-2.5 py-1 text-[11px] font-medium text-red-900 bg-white border border-red-300 hover:bg-red-100 rounded-[2px] cursor-pointer shrink-0 whitespace-nowrap"
                >
                  {t('configuration:plcCatalog.preview.retry')}
                </button>
              )}
            </div>
          ) : !previewData ? (
            <div className="text-xs text-slate-500 py-6 text-center">
              {t('configuration:plcCatalog.preview.generating')}
            </div>
          ) : (
            <div className="space-y-3 text-[11px] font-mono">
              <div className="bg-[#f8f9fb] border border-hairline rounded-[2px] p-3 overflow-x-auto">
                <div className="font-semibold text-ink mb-1.5">
                  {t('configuration:plcCatalog.preview.section1')}
                </div>
                <pre className="text-slate-800 whitespace-pre-wrap break-all">
                  {JSON.stringify(previewData.sampleEnvelope, null, 2)}
                </pre>
              </div>
              <div className="bg-[#f8f9fb] border border-hairline rounded-[2px] p-3 overflow-x-auto">
                <div className="font-semibold text-ink mb-1.5">
                  {t('configuration:plcCatalog.preview.section2')}
                </div>
                <pre className="text-slate-800 whitespace-pre-wrap break-all">
                  {JSON.stringify(previewData.projectedFeatureWindow, null, 2)}
                </pre>
              </div>
              <div className="bg-[#f8f9fb] border border-hairline rounded-[2px] p-3 overflow-x-auto">
                <div className="font-semibold text-ink mb-1.5">
                  {t('configuration:plcCatalog.preview.section3')}
                </div>
                <pre className="text-slate-800 whitespace-pre-wrap break-all">
                  {JSON.stringify(previewData.projectedBaKpi, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </div>
      </SlideOverDrawer>
    </div>
  );
}
