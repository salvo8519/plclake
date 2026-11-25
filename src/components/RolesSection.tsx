import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  RolePermissionsMatrix,
  RolePermissionsResponse,
  SessionUserInfo,
  UserAccountPublic,
} from '../types/pipeline';
import { apiFetch } from '../utils/apiAuth';
import { extractErrorMessage } from '../utils/formatters';
import { DEFAULT_ROLE_MATRIX, RolePermissionsPanel } from './RolePermissionsPanel';
import { StatusBanner } from './ui';

interface RolesSectionProps {
  currentUser: SessionUserInfo | null;
  onPermissionsUpdated?: () => void;
}

function cloneMatrix(m: RolePermissionsMatrix): RolePermissionsMatrix {
  return {
    admin: { ...m.admin, allowedViews: [...m.admin.allowedViews] },
    operator: { ...m.operator, allowedViews: [...m.operator.allowedViews] },
    viewer: { ...m.viewer, allowedViews: [...m.viewer.allowedViews] },
  };
}

export function RolesSection({ currentUser, onPermissionsUpdated }: RolesSectionProps) {
  const { t } = useTranslation(['administration', 'common']);
  const [users, setUsers] = useState<UserAccountPublic[]>([]);
  const [matrix, setMatrix] = useState<RolePermissionsMatrix>(() => cloneMatrix(DEFAULT_ROLE_MATRIX));
  const [savedMatrix, setSavedMatrix] = useState<RolePermissionsMatrix>(() =>
    cloneMatrix(DEFAULT_ROLE_MATRIX)
  );
  const [matrixUpdatedAt, setMatrixUpdatedAt] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSavingMatrix, setIsSavingMatrix] = useState(false);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const isAdminSession = !currentUser || currentUser.role === 'admin';

  const loadAll = useCallback(async () => {
    setIsLoading(true);
    try {
      const [usersRes, permRes] = await Promise.all([
        apiFetch('/api/v1/users'),
        apiFetch('/api/v1/roles/permissions'),
      ]);
      if (usersRes.ok) {
        const uData = (await usersRes.json()) as { users: UserAccountPublic[] };
        setUsers(uData.users ?? []);
      }
      if (permRes.ok) {
        const pData = (await permRes.json()) as RolePermissionsResponse;
        if (pData.matrix) {
          setMatrix(cloneMatrix(pData.matrix));
          setSavedMatrix(cloneMatrix(pData.matrix));
          setMatrixUpdatedAt(pData.updatedAt ?? null);
        }
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const handleSaveMatrix = async () => {
    setIsSavingMatrix(true);
    setBanner(null);
    try {
      const resp = await apiFetch('/api/v1/roles/permissions', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matrix }),
      });
      const payload = (await resp.json().catch(() => ({}))) as RolePermissionsResponse & {
        error?: string;
      };
      if (!resp.ok) {
        throw new Error(
          payload.error ||
            t('administration:users.messages.errSaveMatrixStatus', { status: resp.status })
        );
      }
      setMatrix(cloneMatrix(payload.matrix));
      setSavedMatrix(cloneMatrix(payload.matrix));
      setMatrixUpdatedAt(payload.updatedAt);
      onPermissionsUpdated?.();
      setBanner({
        kind: 'ok',
        text: t('administration:users.messages.matrixSavedOk'),
      });
    } catch (err) {
      setBanner({
        kind: 'err',
        text: extractErrorMessage(err, t('administration:users.messages.errSaveMatrixGeneric')),
      });
    } finally {
      setIsSavingMatrix(false);
    }
  };

  return (
    <div className="space-y-5">
      {banner && (
        <StatusBanner
          kind={banner.kind}
          message={banner.text}
          onDismiss={() => setBanner(null)}
        />
      )}

      <RolePermissionsPanel
        users={users}
        matrix={matrix}
        savedMatrix={savedMatrix}
        matrixUpdatedAt={matrixUpdatedAt}
        isAdminSession={isAdminSession}
        isSavingMatrix={isSavingMatrix}
        isLoading={isLoading}
        headingAs="h1"
        onRefresh={() => void loadAll()}
        onChangeMatrix={setMatrix}
        onDiscardChanges={() => setMatrix(cloneMatrix(savedMatrix))}
        onResetDefaults={() => setMatrix(cloneMatrix(DEFAULT_ROLE_MATRIX))}
        onSaveMatrix={() => void handleSaveMatrix()}
      />
    </div>
  );
}
