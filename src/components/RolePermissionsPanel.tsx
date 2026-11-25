import { useMemo } from 'react';
import {
  AlertTriangle,
  CheckSquare,
  Lock,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  Undo2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  AppViewId,
  RolePermissionPolicy,
  RolePermissionsMatrix,
  UserAccountPublic,
  UserRole,
} from '../types/pipeline';
import { ERP_TABLE_HEAD_ROW_CLASS } from '../theme/tokens';
import { formatUtcTimestamp } from '../utils/formatters';
import { Button, ErpCheckbox, SectionCard, SectionHeader } from './ui';

export type CapabilityKey = Exclude<keyof RolePermissionPolicy, 'allowedViews'>;
export type EditableRole = 'operator' | 'viewer';
export type ViewGroupName = 'Operations' | 'Configuration' | 'Administration';

export const VIEW_CATALOG: Array<{
  id: AppViewId;
  group: ViewGroupName;
  label: string;
  summary: string;
}> = [
  {
    id: 'workbench',
    group: 'Operations',
    label: 'Live Simulation',
    summary: 'Real-time stream workbench, telemetry tail & anomaly feed',
  },
  {
    id: 'fleet',
    group: 'Operations',
    label: 'Fleet Evaluation',
    summary: 'KPI rollup, latency charts & quarantined packet review',
  },
  {
    id: 'connections',
    group: 'Operations',
    label: 'Plant Connections',
    summary: 'OT endpoints, OPC-UA / Modbus / MQTT gateway targets',
  },
  {
    id: 'plc_catalog',
    group: 'Configuration',
    label: 'PLC Catalog',
    summary: 'Machine schemas, register mappings & custom PLC profiles',
  },
  {
    id: 'job_config',
    group: 'Configuration',
    label: 'Job Configuration',
    summary: 'Windowing thresholds, watermark policies & storage retention',
  },
  {
    id: 'notifications',
    group: 'Configuration',
    label: 'Notifications & Alerts',
    summary: 'Alert queue, SMTP / Webhook channels & Mailpit diagnostics',
  },
  {
    id: 'users',
    group: 'Administration',
    label: 'Users',
    summary: 'Operator directory, credentials & account lifecycle management',
  },
  {
    id: 'roles',
    group: 'Administration',
    label: 'Roles & Permissions',
    summary: 'RBAC role policies, sidebar view visibility & operational capabilities',
  },
  {
    id: 'tokens',
    group: 'Administration',
    label: 'API Tokens',
    summary: 'Scoped X-API-Key lifecycle, AES-256-GCM encrypted hashes & Scalar test auth',
  },
  {
    id: 'audit',
    group: 'Administration',
    label: 'Audit Log',
    summary: 'Immutable access, configuration & operational event trail',
  },
];

export const CAPABILITY_CATALOG: Array<{
  key: CapabilityKey;
  label: string;
  description: string;
}> = [
  {
    key: 'canControlSimulation',
    label: 'Control Live Simulation',
    description: 'Start, pause, resume, and stop streaming runs',
  },
  {
    key: 'canWriteConfig',
    label: 'Modify Catalog, Connections & Job Policy',
    description: 'Create/edit PLC schemas, OT connections, and pipeline parameters',
  },
  {
    key: 'canManageAlerts',
    label: 'Manage Alerts & Diagnostics',
    description: 'Acknowledge alerts, edit SMTP/Webhook channels, run Mailpit diagnostics',
  },
  {
    key: 'canManageUsers',
    label: 'Manage Users & Role Matrix',
    description: 'Create accounts, change roles, and configure RBAC menu visibility',
  },
];

export const DEFAULT_ROLE_MATRIX: RolePermissionsMatrix = {
  admin: {
    allowedViews: VIEW_CATALOG.map((v) => v.id),
    canControlSimulation: true,
    canWriteConfig: true,
    canManageAlerts: true,
    canManageUsers: true,
  },
  operator: {
    allowedViews: ['workbench', 'fleet', 'connections', 'plc_catalog', 'notifications', 'audit'],
    canControlSimulation: true,
    canWriteConfig: false,
    canManageAlerts: true,
    canManageUsers: false,
  },
  viewer: {
    allowedViews: ['workbench', 'fleet', 'plc_catalog', 'audit'],
    canControlSimulation: false,
    canWriteConfig: false,
    canManageAlerts: false,
    canManageUsers: false,
  },
};

const ROLE_COLUMNS: Array<{
  id: UserRole;
  locked: boolean;
}> = [
  { id: 'admin', locked: true },
  { id: 'operator', locked: false },
  { id: 'viewer', locked: false },
];

const VIEW_GROUPS: ViewGroupName[] = ['Operations', 'Configuration', 'Administration'];

function countEnabledCapabilities(policy: RolePermissionPolicy): number {
  return CAPABILITY_CATALOG.reduce((acc, cap) => acc + (policy[cap.key] ? 1 : 0), 0);
}

function policiesEqual(a: RolePermissionPolicy, b: RolePermissionPolicy): boolean {
  if (a.allowedViews.length !== b.allowedViews.length) return false;
  const aSorted = [...a.allowedViews].sort();
  const bSorted = [...b.allowedViews].sort();
  for (let i = 0; i < aSorted.length; i += 1) {
    if (aSorted[i] !== bSorted[i]) return false;
  }
  return (
    a.canControlSimulation === b.canControlSimulation &&
    a.canWriteConfig === b.canWriteConfig &&
    a.canManageAlerts === b.canManageAlerts &&
    a.canManageUsers === b.canManageUsers
  );
}

interface RolePermissionsPanelProps {
  users: UserAccountPublic[];
  matrix: RolePermissionsMatrix;
  savedMatrix: RolePermissionsMatrix;
  matrixUpdatedAt: string | null;
  isAdminSession: boolean;
  isSavingMatrix: boolean;
  isLoading?: boolean;
  headingAs?: 'h1' | 'h2';
  onRefresh?: () => void;
  onChangeMatrix: (updater: (prev: RolePermissionsMatrix) => RolePermissionsMatrix) => void;
  onDiscardChanges: () => void;
  onResetDefaults: () => void;
  onSaveMatrix: () => void;
}

export function RolePermissionsPanel({
  users,
  matrix,
  savedMatrix,
  matrixUpdatedAt,
  isAdminSession,
  isSavingMatrix,
  isLoading = false,
  headingAs = 'h1',
  onRefresh,
  onChangeMatrix,
  onDiscardChanges,
  onResetDefaults,
  onSaveMatrix,
}: RolePermissionsPanelProps) {
  const { t } = useTranslation(['administration', 'common']);
  const roleUserCounts = useMemo(() => {
    const counts: Record<UserRole, number> = {
      admin: 0,
      operator: 0,
      viewer: 0,
    };
    for (const u of users) {
      counts[u.role] += 1;
    }
    return counts;
  }, [users]);

  const dirtyRoles = useMemo(() => ({
      admin: false,
      operator: !policiesEqual(matrix.operator, savedMatrix.operator),
      viewer: !policiesEqual(matrix.viewer, savedMatrix.viewer),
    }), [matrix, savedMatrix]);

  const hasUnsavedChanges = dirtyRoles.operator || dirtyRoles.viewer;

  const toggleRoleView = (role: EditableRole, viewId: AppViewId) => {
    onChangeMatrix((prev) => {
      const current = prev[role].allowedViews;
      const exists = current.includes(viewId);
      if (exists && current.length <= 1) {
        return prev;
      }
      const nextViews = exists
        ? current.filter((v) => v !== viewId)
        : [...current, viewId];
      return {
        ...prev,
        [role]: {
          ...prev[role],
          allowedViews: nextViews,
        },
      };
    });
  };

  const toggleGroupViews = (role: EditableRole, groupName: ViewGroupName) => {
    const groupIds = VIEW_CATALOG.filter((v) => v.group === groupName).map((v) => v.id);
    onChangeMatrix((prev) => {
      const current = prev[role].allowedViews;
      const allSelected = groupIds.every((id) => current.includes(id));

      let nextViews: AppViewId[];
      if (allSelected) {
        const remaining = current.filter((id) => !groupIds.includes(id));
        nextViews = remaining.length > 0 ? remaining : [groupIds[0]];
      } else {
        const merged = new Set<AppViewId>(current);
        for (const id of groupIds) merged.add(id);
        nextViews = Array.from(merged);
      }

      return {
        ...prev,
        [role]: {
          ...prev[role],
          allowedViews: nextViews,
        },
      };
    });
  };

  const toggleRoleCapability = (role: EditableRole, key: CapabilityKey) => {
    onChangeMatrix((prev) => ({
      ...prev,
      [role]: {
        ...prev[role],
        [key]: !prev[role][key],
      },
    }));
  };

  const toggleAllCapabilities = (role: EditableRole) => {
    onChangeMatrix((prev) => {
      const allEnabled = CAPABILITY_CATALOG.every((cap) => prev[role][cap.key]);
      const nextValue = !allEnabled;
      return {
        ...prev,
        [role]: {
          ...prev[role],
          canControlSimulation: nextValue,
          canWriteConfig: nextValue,
          canManageAlerts: nextValue,
          canManageUsers: nextValue,
        },
      };
    });
  };

  const accountWord =
    users.length === 1 ? t('roleMatrix.accountSingular') : t('roleMatrix.accountPlural');

  return (
    <SectionCard borderless ariaLabelledBy="role-access-panel-heading">
      <SectionHeader
        as={headingAs}
        id="role-access-panel-heading"
        icon={<ShieldCheck className="w-4 h-4" />}
        title={t('roleMatrix.title')}
        subtitle={
          <>
            {t('roleMatrix.subtitle')}
            {matrixUpdatedAt && (
              <span className="ml-2 font-mono text-[11px] text-slate-500 whitespace-nowrap tabular-nums">
                · {t('roleMatrix.savedAt', { timestamp: `${formatUtcTimestamp(matrixUpdatedAt)} UTC` })}
              </span>
            )}
          </>
        }
        actions={
          <>
            {onRefresh && (
              <Button variant="secondary" size="sm" onClick={onRefresh}>
                <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
                {t('common:actions.refresh')}
              </Button>
            )}
            {!isAdminSession && (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-600 mr-1 whitespace-nowrap">
                <Lock className="w-3.5 h-3.5 text-slate-500" />
                {t('roleMatrix.readOnlyHint')}
              </span>
            )}

            {hasUnsavedChanges && (
              <span
                role="status"
                className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-800 mr-1 whitespace-nowrap"
              >
                <AlertTriangle className="w-3.5 h-3.5 text-amber-700 shrink-0" />
                {t('roleMatrix.unsavedChanges')}
              </span>
            )}

            {hasUnsavedChanges && (
              <Button
                variant="secondary"
                size="sm"
                disabled={!isAdminSession || isSavingMatrix}
                onClick={onDiscardChanges}
              >
                <Undo2 className="w-3.5 h-3.5" />
                {t('roleMatrix.discard')}
              </Button>
            )}

            <Button
              variant="secondary"
              size="sm"
              disabled={!isAdminSession || isSavingMatrix}
              onClick={onResetDefaults}
            >
              <RotateCcw className="w-3.5 h-3.5" />
              {t('roleMatrix.resetDefaults')}
            </Button>

            <Button
              variant="primary"
              size="sm"
              disabled={!isAdminSession || isSavingMatrix || !hasUnsavedChanges}
              onClick={onSaveMatrix}
            >
              <Save className="w-3.5 h-3.5" />
              {isSavingMatrix ? t('roleMatrix.saving') : t('roleMatrix.savePermissions')}
            </Button>
          </>
        }
      />

      {/* Helper Strip */}
      <div className="px-5 py-2.5 bg-white flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600">
        <div className="flex items-center gap-2">
          <CheckSquare className="w-3.5 h-3.5 text-brand shrink-0" />
          <span>{t('roleMatrix.helperHint')}</span>
        </div>
        <span className="font-mono text-slate-500 tabular-nums whitespace-nowrap">
          {t('roleMatrix.accountsAcrossRoles', {
            count: users.length,
            accountWord,
            roles: ROLE_COLUMNS.length,
          })}
        </span>
      </div>

      {/* Full-Width Permissions Matrix */}
      <div className="erp-table-scroll">
        <table className="w-full min-w-[680px] text-left border-collapse text-xs">
          <thead>
            <tr className={ERP_TABLE_HEAD_ROW_CLASS}>
              <th className="py-2.5 px-5">{t('roleMatrix.columnHeader')}</th>
              {ROLE_COLUMNS.map((col) => {
                const viewsCount = matrix[col.id].allowedViews.length;
                const userCount = roleUserCounts[col.id];
                const isDirty = dirtyRoles[col.id];
                const roleLabel = t(`roleMatrix.roles.${col.id}`);
                const userWord =
                  userCount === 1 ? t('roleMatrix.userSingular') : t('roleMatrix.userPlural');
                return (
                  <th key={col.id} className="py-2.5 px-3 text-center w-40 tabular-nums">
                    <div className="inline-flex items-center justify-center gap-1 text-ink">
                      {col.locked && <Lock className="w-3 h-3 text-slate-400" />}
                      <span>{roleLabel}</span>
                      {isDirty && (
                        <span className="text-[10px] font-mono font-semibold text-amber-700">
                          *
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] font-mono font-normal text-slate-500 mt-0.5">
                      {t('roleMatrix.roleMeta', {
                        users: userCount,
                        userWord,
                        views: viewsCount,
                        total: VIEW_CATALOG.length,
                      })}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody className="divide-y divide-hairline">
            {VIEW_GROUPS.map((groupName) => {
              const groupViews = VIEW_CATALOG.filter((v) => v.group === groupName);
              const groupIds = groupViews.map((v) => v.id);
              const groupLabel = t(`roleMatrix.groups.${groupName}`);

              return [
                <tr
                  key={`group-${groupName}`}
                  className="bg-[#f8f9fa]"
                >
                  <td className="py-2 px-5 text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-600">
                    {t('roleMatrix.groupMenuViews', { group: groupLabel })}
                  </td>
                  {ROLE_COLUMNS.map(({ id: roleId }) => {
                    const roleLabel = t(`roleMatrix.roles.${roleId}`);
                    if (roleId === 'admin') {
                      return (
                        <td key={`grp-${groupName}-admin`} className="py-2 px-3 text-center align-middle">
                          <ErpCheckbox
                            checked
                            locked
                            ariaLabel={t('roleMatrix.ariaAdminGroup', { group: groupLabel })}
                          />
                        </td>
                      );
                    }
                    const selectedInGroup = groupIds.filter((id) =>
                      matrix[roleId].allowedViews.includes(id)
                    ).length;
                    const allChecked = selectedInGroup === groupIds.length;
                    const isIndeterminate = selectedInGroup > 0 && !allChecked;

                    return (
                      <td
                        key={`grp-${groupName}-${roleId}`}
                        className="py-2 px-3 text-center align-middle"
                      >
                        <ErpCheckbox
                          checked={allChecked}
                          indeterminate={isIndeterminate}
                          disabled={!isAdminSession}
                          ariaLabel={t('roleMatrix.ariaToggleGroup', {
                            group: groupLabel,
                            role: roleLabel,
                          })}
                          title={t('roleMatrix.ariaToggleGroup', {
                            group: groupLabel,
                            role: roleLabel,
                          })}
                          onChange={() => toggleGroupViews(roleId, groupName)}
                        />
                      </td>
                    );
                  })}
                </tr>,

                ...groupViews.map((view) => {
                  const viewLabel = t(`roleMatrix.views.${view.id}.label`);
                  const viewSummary = t(`roleMatrix.views.${view.id}.summary`);
                  return (
                    <tr key={view.id} className="hover:bg-[#f8f9fb] transition-colors">
                      <td className="py-2.5 px-5">
                        <div className="font-medium text-ink whitespace-nowrap">
                          {viewLabel}
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5">{viewSummary}</div>
                      </td>

                      {ROLE_COLUMNS.map(({ id: roleId }) => {
                        const roleLabel = t(`roleMatrix.roles.${roleId}`);
                        if (roleId === 'admin') {
                          return (
                            <td
                              key={`${view.id}-admin`}
                              className="py-2.5 px-3 text-center align-middle"
                            >
                              <ErpCheckbox
                                checked
                                locked
                                ariaLabel={t('roleMatrix.ariaAdminView', { view: viewLabel })}
                              />
                            </td>
                          );
                        }

                        const isChecked = matrix[roleId].allowedViews.includes(view.id);
                        const isLastRemaining =
                          isChecked && matrix[roleId].allowedViews.length === 1;

                        return (
                          <td
                            key={`${view.id}-${roleId}`}
                            className="py-2.5 px-3 text-center align-middle"
                          >
                            <ErpCheckbox
                              checked={isChecked}
                              disabled={!isAdminSession || isLastRemaining}
                              ariaLabel={t('roleMatrix.ariaRoleView', {
                                role: roleLabel,
                                view: viewLabel,
                              })}
                              title={isLastRemaining ? t('roleMatrix.minViewTitle') : undefined}
                              onChange={() => toggleRoleView(roleId, view.id)}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  );
                }),
              ];
            })}

            {/* Action Capabilities Section Header with Bulk Toggle */}
            <tr className="bg-[#f8f9fa]">
              <td className="py-2.5 px-5 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink">
                {t('roleMatrix.capabilitiesHeader')}
              </td>
              {ROLE_COLUMNS.map(({ id: roleId }) => {
                const roleLabel = t(`roleMatrix.roles.${roleId}`);
                if (roleId === 'admin') {
                  return (
                    <td key="caps-admin" className="py-2.5 px-3 text-center align-middle">
                      <ErpCheckbox
                        checked
                        locked
                        ariaLabel={t('roleMatrix.ariaAdminCaps')}
                      />
                    </td>
                  );
                }
                const enabledCount = countEnabledCapabilities(matrix[roleId]);
                const allChecked = enabledCount === CAPABILITY_CATALOG.length;
                const isIndeterminate = enabledCount > 0 && !allChecked;

                return (
                  <td key={`caps-${roleId}`} className="py-2.5 px-3 text-center align-middle">
                    <ErpCheckbox
                      checked={allChecked}
                      indeterminate={isIndeterminate}
                      disabled={!isAdminSession}
                      ariaLabel={t('roleMatrix.ariaToggleCaps', { role: roleLabel })}
                      title={t('roleMatrix.ariaToggleCaps', { role: roleLabel })}
                      onChange={() => toggleAllCapabilities(roleId)}
                    />
                  </td>
                );
              })}
            </tr>

            {CAPABILITY_CATALOG.map((cap) => {
              const capLabel = t(`roleMatrix.capabilities.${cap.key}.label`);
              const capDesc = t(`roleMatrix.capabilities.${cap.key}.description`);
              return (
                <tr key={cap.key} className="hover:bg-[#f8f9fb] transition-colors">
                  <td className="py-2.5 px-5">
                    <div className="font-medium text-ink">{capLabel}</div>
                    <div className="text-[11px] text-slate-500 mt-0.5">{capDesc}</div>
                  </td>

                  {ROLE_COLUMNS.map(({ id: roleId }) => {
                    const roleLabel = t(`roleMatrix.roles.${roleId}`);
                    if (roleId === 'admin') {
                      return (
                        <td
                          key={`${cap.key}-admin`}
                          className="py-2.5 px-3 text-center align-middle"
                        >
                          <ErpCheckbox
                            checked
                            locked
                            ariaLabel={t('roleMatrix.ariaAdminCap', { cap: capLabel })}
                          />
                        </td>
                      );
                    }

                    return (
                      <td
                        key={`${cap.key}-${roleId}`}
                        className="py-2.5 px-3 text-center align-middle"
                      >
                        <ErpCheckbox
                          checked={matrix[roleId][cap.key]}
                          disabled={!isAdminSession}
                          ariaLabel={t('roleMatrix.ariaRoleCap', {
                            role: roleLabel,
                            cap: capLabel,
                          })}
                          onChange={() => toggleRoleCapability(roleId, cap.key)}
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}
