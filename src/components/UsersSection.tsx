import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  AlertCircle,
  Pencil,
  Power,
  RefreshCw,
  Search,
  UserPlus,
  Users,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  SessionUserInfo,
  UserAccountPublic,
  UserRole,
} from '../types/pipeline';
import { ERP_INPUT_CLASS, ERP_TABLE_HEAD_ROW_CLASS } from '../theme/tokens';
import { apiFetch } from '../utils/apiAuth';
import { extractErrorMessage, formatUtcTimestamp } from '../utils/formatters';
import {
  Button,
  DEFAULT_TABLE_PAGE_SIZE,
  paginateItems,
  RowActionMenu,
  SectionCard,
  SectionHeader,
  SlideOverDrawer,
  StatusBanner,
  TablePagination,
} from './ui';

interface UsersSectionProps {
  currentUser: SessionUserInfo | null;
}

export function UsersSection({ currentUser }: UsersSectionProps) {
  const { t } = useTranslation(['administration', 'common']);
  const [users, setUsers] = useState<UserAccountPublic[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [usersPage, setUsersPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | UserRole>('all');

  // Slide-over drawer state (Create or Edit user)
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<UserAccountPublic | null>(null);
  const [formEmail, setFormEmail] = useState('');
  const [formFullName, setFormFullName] = useState('');
  const [formRole, setFormRole] = useState<UserRole>('operator');
  const [formPassword, setFormPassword] = useState('');
  const [formActive, setFormActive] = useState(true);
  const [isSavingUser, setIsSavingUser] = useState(false);
  const [drawerError, setDrawerError] = useState<string | null>(null);

  const isAdminSession = !currentUser || currentUser.role === 'admin';

  const loadUsers = useCallback(async () => {
    setIsLoading(true);
    try {
      const usersRes = await apiFetch('/api/v1/users');
      if (usersRes.ok) {
        const uData = (await usersRes.json()) as { users: UserAccountPublic[] };
        setUsers(uData.users ?? []);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const filteredUsers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return users.filter((u) => {
      if (roleFilter !== 'all' && u.role !== roleFilter) return false;
      if (!q) return true;
      return (
        u.email.toLowerCase().includes(q) ||
        u.fullName.toLowerCase().includes(q) ||
        u.role.toLowerCase().includes(q)
      );
    });
  }, [users, searchQuery, roleFilter]);

  const closeUserDrawer = () => {
    setDrawerOpen(false);
    setDrawerError(null);
  };

  const openNewUserDrawer = () => {
    setEditingUser(null);
    setFormEmail('');
    setFormFullName('');
    setFormRole('operator');
    setFormPassword('');
    setFormActive(true);
    setDrawerError(null);
    setDrawerOpen(true);
  };

  const openEditUserDrawer = (user: UserAccountPublic) => {
    setEditingUser(user);
    setFormEmail(user.email);
    setFormFullName(user.fullName);
    setFormRole(user.role);
    setFormPassword('');
    setFormActive(user.active);
    setDrawerError(null);
    setDrawerOpen(true);
  };

  const handleSaveUser = async (e: FormEvent) => {
    e.preventDefault();
    setDrawerError(null);

    const trimmedEmail = formEmail.trim();
    const trimmedName = formFullName.trim();
    const trimmedPassword = formPassword.trim();

    if (!trimmedName) {
      setDrawerError(t('administration:users.messages.errFullNameRequired'));
      return;
    }

    if (editingUser) {
      if (trimmedPassword.length > 0 && trimmedPassword.length < 8) {
        setDrawerError(t('administration:users.messages.errResetPasswordMin'));
        return;
      }
    } else {
      if (!trimmedEmail) {
        setDrawerError(t('administration:users.messages.errEmailRequired'));
        return;
      }
      if (trimmedPassword.length < 8) {
        setDrawerError(t('administration:users.messages.errInitialPasswordMin'));
        return;
      }
    }

    setIsSavingUser(true);
    setBanner(null);
    try {
      if (editingUser) {
        const resp = await apiFetch(`/api/v1/users/${encodeURIComponent(editingUser.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fullName: trimmedName,
            role: formRole,
            active: formActive,
            ...(trimmedPassword.length >= 8 ? { password: formPassword } : {}),
          }),
        });
        const payload = (await resp.json().catch(() => ({}))) as {
          users?: UserAccountPublic[];
          error?: string;
        };
        if (!resp.ok) {
          throw new Error(
            payload.error || t('administration:users.messages.errUpdateStatus', { status: resp.status })
          );
        }
        setUsers(payload.users ?? users);
        closeUserDrawer();
        setBanner({
          kind: 'ok',
          text: t('administration:users.messages.updatedOk', { email: editingUser.email }),
        });
      } else {
        const resp = await apiFetch('/api/v1/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: trimmedEmail,
            fullName: trimmedName,
            role: formRole,
            password: formPassword,
          }),
        });
        const payload = (await resp.json().catch(() => ({}))) as {
          users?: UserAccountPublic[];
          error?: string;
        };
        if (!resp.ok) {
          throw new Error(
            payload.error || t('administration:users.messages.errCreateStatus', { status: resp.status })
          );
        }
        setUsers(payload.users ?? users);
        closeUserDrawer();
        setBanner({
          kind: 'ok',
          text: t('administration:users.messages.createdOk', { email: trimmedEmail.toLowerCase() }),
        });
      }
    } catch (err) {
      setDrawerError(extractErrorMessage(err, t('administration:users.messages.errSaveGeneric')));
    } finally {
      setIsSavingUser(false);
    }
  };

  const handleQuickToggleStatus = async (user: UserAccountPublic) => {
    setBanner(null);
    const resp = await apiFetch(`/api/v1/users/${encodeURIComponent(user.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: !user.active }),
    });
    const payload = (await resp.json().catch(() => ({}))) as {
      users?: UserAccountPublic[];
      error?: string;
    };
    if (!resp.ok) {
      setBanner({
        kind: 'err',
        text: payload.error || t('administration:users.messages.errStatusToggle'),
      });
      return;
    }
    setUsers(payload.users ?? users);
    setBanner({
      kind: 'ok',
      text: !user.active
        ? t('administration:users.messages.statusActiveOk', { email: user.email })
        : t('administration:users.messages.statusDisabledOk', { email: user.email }),
    });
  };

  const { pageItems: pagedUsers, safePage: safeUsersPage } = paginateItems(
    filteredUsers,
    usersPage,
    DEFAULT_TABLE_PAGE_SIZE
  );

  return (
    <div className="space-y-5">
      {banner && (
        <StatusBanner
          kind={banner.kind}
          message={banner.text}
          onDismiss={() => setBanner(null)}
        />
      )}

      {/* User Directory Table */}
      <SectionCard borderless>
        <SectionHeader
          as="h1"
          icon={<Users className="w-4 h-4" />}
          title={`${t('administration:users.title')} (${filteredUsers.length})`}
          subtitle={t('administration:users.subtitle')}
          className="border-b-0"
          actions={
            <>
              <Button variant="secondary" size="sm" onClick={() => void loadUsers()}>
                <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
                {t('common:actions.refresh')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={!isAdminSession}
                onClick={openNewUserDrawer}
              >
                <UserPlus className="w-3.5 h-3.5" />
                {t('administration:users.addUser')}
              </Button>
            </>
          }
        />

        {/* Scalable Search & Role Filter Strip */}
        <div className="px-5 py-2.5 bg-white border-t border-hairline flex flex-wrap items-center gap-2.5">
          <div className="relative flex-1 min-w-[220px] max-w-sm">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setUsersPage(1);
              }}
              placeholder={t('administration:users.searchPlaceholder')}
              aria-label={t('administration:users.searchPlaceholder')}
              className={`${ERP_INPUT_CLASS} pl-8 py-1.5 text-xs`}
            />
          </div>
          <select
            value={roleFilter}
            onChange={(e) => {
              setRoleFilter(e.target.value as 'all' | UserRole);
              setUsersPage(1);
            }}
            aria-label={t('administration:users.table.colRole')}
            className={`${ERP_INPUT_CLASS} w-auto min-w-[150px] py-1.5 text-xs`}
          >
            <option value="all">{t('administration:users.filterAllRoles')}</option>
            <option value="admin">{t('administration:roleMatrix.roles.admin')}</option>
            <option value="operator">{t('administration:roleMatrix.roles.operator')}</option>
            <option value="viewer">{t('administration:roleMatrix.roles.viewer')}</option>
          </select>
        </div>

        <div className="erp-table-scroll">
          <table className="w-full min-w-[780px] text-left border-collapse text-xs">
            <thead>
              <tr className={ERP_TABLE_HEAD_ROW_CLASS}>
                <th className="py-2.5 px-5">{t('administration:users.table.colEmail')}</th>
                <th className="py-2.5 px-3">{t('administration:users.table.colFullName')}</th>
                <th className="py-2.5 px-3">{t('administration:users.table.colRole')}</th>
                <th className="py-2.5 px-3">{t('administration:users.table.colLastLogin')}</th>
                <th className="py-2.5 px-3">{t('administration:users.table.colStatus')}</th>
                <th className="py-2.5 px-5 text-right w-16">{t('administration:users.table.colActions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {isLoading && users.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 px-5 text-center text-xs text-slate-500">
                    {t('administration:users.loading')}
                  </td>
                </tr>
              ) : filteredUsers.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 px-5 text-center text-xs text-slate-600">
                    <p>{t('administration:users.empty')}</p>
                    {isAdminSession && users.length === 0 && (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={openNewUserDrawer}
                        className="mt-2"
                      >
                        <UserPlus className="w-3.5 h-3.5" />
                        {t('administration:users.addFirstUser')}
                      </Button>
                    )}
                  </td>
                </tr>
              ) : (
                pagedUsers.map((u) => (
                  <tr
                    key={u.id}
                    className={!u.active ? 'opacity-60 bg-slate-50/50' : 'hover:bg-[#f8f9fb] transition-colors'}
                  >
                    <td className="py-2.5 px-5 font-mono font-medium text-ink">
                      {u.email}
                      {currentUser?.id === u.id && (
                        <span className="ml-2 text-[10px] font-sans font-semibold uppercase text-brand">
                          {t('administration:users.youBadge')}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-slate-800">{u.fullName}</td>
                    <td className="py-2.5 px-3 font-mono text-slate-700 uppercase text-[11px]">
                      {t(`administration:roleMatrix.roles.${u.role}`)}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[11px] text-slate-600 tabular-nums">
                      {formatUtcTimestamp(u.lastLoginAt, t('administration:users.never'))}
                    </td>
                    <td className="py-2.5 px-3">
                      <span
                        className={`font-mono text-[11px] font-semibold uppercase ${
                          u.active ? 'text-emerald-700' : 'text-slate-500'
                        }`}
                      >
                        {u.active ? t('administration:users.active') : t('administration:users.disabled')}
                      </span>
                    </td>
                    <td className="py-2.5 px-5 text-right whitespace-nowrap">
                      <RowActionMenu
                        ariaLabel={t('administration:users.table.actionsAria', { email: u.email })}
                        disabled={!isAdminSession}
                        items={[
                          {
                            id: 'edit',
                            label: t('administration:users.table.editUser'),
                            icon: <Pencil className="w-3.5 h-3.5" />,
                            onClick: () => openEditUserDrawer(u),
                            disabled: !isAdminSession,
                          },
                          {
                            id: 'toggle-status',
                            label: u.active
                              ? t('administration:users.table.disableAccount')
                              : t('administration:users.table.enableAccount'),
                            icon: <Power className="w-3.5 h-3.5" />,
                            tone: u.active ? 'danger' : 'default',
                            dividerBefore: true,
                            onClick: () => void handleQuickToggleStatus(u),
                            disabled: !isAdminSession,
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
          currentPage={safeUsersPage}
          totalItems={filteredUsers.length}
          pageSize={DEFAULT_TABLE_PAGE_SIZE}
          maxVisiblePages={3}
          onPageChange={setUsersPage}
          itemLabel={t('administration:users.pagination.accounts')}
          hideWhenSinglePage
        />
      </SectionCard>

      {/* Right-Side Slide-Over Drawer for Create / Edit User */}
      <SlideOverDrawer
        open={drawerOpen}
        onClose={closeUserDrawer}
        title={
          editingUser
            ? t('administration:users.drawer.titleEdit', { email: editingUser.email })
            : t('administration:users.drawer.titleNew')
        }
        subtitle={
          editingUser
            ? t('administration:users.drawer.subtitleEdit')
            : t('administration:users.drawer.subtitleNew')
        }
        size="md"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={closeUserDrawer}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              type="submit"
              form="erp-user-drawer-form"
              variant="primary"
              size="sm"
              disabled={isSavingUser}
            >
              {isSavingUser
                ? t('common:actions.saving')
                : editingUser
                  ? t('administration:users.drawer.saveChanges')
                  : t('administration:users.drawer.createAccount')}
            </Button>
          </>
        }
      >
        <form id="erp-user-drawer-form" onSubmit={handleSaveUser} className="space-y-4">
          {drawerError && (
            <div
              role="alert"
              className="px-3 py-2.5 rounded-[2px] border border-red-200 bg-red-50 text-red-900 text-xs flex items-start gap-2"
            >
              <AlertCircle className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
              <span>{drawerError}</span>
            </div>
          )}

          <div>
            <label htmlFor="erp-user-email" className="block text-xs font-medium text-slate-700 mb-1">
              {t('administration:users.drawer.workEmail')}
            </label>
            <input
              id="erp-user-email"
              type="email"
              required
              disabled={Boolean(editingUser)}
              value={formEmail}
              onChange={(e) => setFormEmail(e.target.value)}
              placeholder="name@plant.local"
              className={`${ERP_INPUT_CLASS} font-mono`}
            />
          </div>

          <div>
            <label htmlFor="erp-user-fullname" className="block text-xs font-medium text-slate-700 mb-1">
              {t('administration:users.drawer.fullName')}
            </label>
            <input
              id="erp-user-fullname"
              type="text"
              required
              value={formFullName}
              onChange={(e) => setFormFullName(e.target.value)}
              placeholder="Mario Rossi"
              className={ERP_INPUT_CLASS}
            />
          </div>

          <div>
            <label htmlFor="erp-user-role" className="block text-xs font-medium text-slate-700 mb-1">
              {t('administration:users.drawer.assignedRole')}
            </label>
            <select
              id="erp-user-role"
              value={formRole}
              onChange={(e) => setFormRole(e.target.value as UserRole)}
              className={ERP_INPUT_CLASS}
            >
              <option value="admin">{t('administration:users.drawer.roleAdminDesc')}</option>
              <option value="operator">{t('administration:users.drawer.roleOperatorDesc')}</option>
              <option value="viewer">{t('administration:users.drawer.roleViewerDesc')}</option>
            </select>
          </div>

          <div>
            <label htmlFor="erp-user-password" className="block text-xs font-medium text-slate-700 mb-1">
              {editingUser
                ? t('administration:users.drawer.resetPasswordLabel')
                : t('administration:users.drawer.initialPasswordLabel')}
            </label>
            <input
              id="erp-user-password"
              type="password"
              required={!editingUser}
              minLength={editingUser ? undefined : 8}
              value={formPassword}
              onChange={(e) => setFormPassword(e.target.value)}
              placeholder={
                editingUser
                  ? t('administration:users.drawer.resetPasswordPlaceholder')
                  : t('administration:users.drawer.initialPasswordPlaceholder')
              }
              className={`${ERP_INPUT_CLASS} font-mono`}
            />
          </div>

          {editingUser && (
            <div className="pt-2 border-t border-hairline">
              <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formActive}
                  onChange={(e) => setFormActive(e.target.checked)}
                  className="rounded-[2px] border-hairline-strong accent-brand"
                />
                {t('administration:users.drawer.accountActive')}
              </label>
            </div>
          )}
        </form>
      </SlideOverDrawer>
    </div>
  );
}
