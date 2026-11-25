import { useState, type FormEvent } from 'react';
import { Eye, EyeOff, KeyRound, Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { APP_NAME, APP_VERSION_TAG } from '../config/appMeta';
import type {
  RolePermissionPolicy,
  SessionUserInfo,
  UserAccountPublic,
} from '../types/pipeline';
import { ERP_INPUT_CLASS } from '../theme/tokens';
import { apiFetch, setSessionApiKey } from '../utils/apiAuth';
import { extractErrorMessage } from '../utils/formatters';
import { BrandMark, Button } from './ui';

interface LoginScreenProps {
  authEnforced: boolean;
  onAuthenticated: (payload: {
    user: SessionUserInfo;
    permissions: RolePermissionPolicy;
  }) => void;
}

// Built-in role accounts for local quick-fill. Passwords are never shipped in the bundle:
// they come from the server environment (or are generated and printed at first boot).
const DEMO_ACCOUNTS = [
  { role: 'admin' as const, email: 'admin@plant.local' },
  { role: 'operator' as const, email: 'operator@plant.local' },
  { role: 'viewer' as const, email: 'controller@plant.local' },
] as const;

export function LoginScreen({ authEnforced, onAuthenticated }: LoginScreenProps) {
  const { t } = useTranslation('common');
  const [email, setEmail] = useState('admin@plant.local');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      const resp = await apiFetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const payload = (await resp.json().catch(() => ({}))) as {
        token?: string;
        user?: UserAccountPublic;
        permissions?: RolePermissionPolicy;
        error?: string;
      };
      if (!resp.ok || !payload.token || !payload.user) {
        throw new Error(
          payload.error || t('auth.errors.authFailed', { status: resp.status })
        );
      }

      setSessionApiKey(payload.token);
      onAuthenticated({
        user: {
          id: payload.user.id,
          email: payload.user.email,
          fullName: payload.user.fullName,
          role: payload.user.role,
          authSource: 'session',
        },
        permissions: payload.permissions ?? {
          allowedViews: ['workbench', 'fleet', 'plc_catalog', 'audit'],
          canControlSimulation: payload.user.role !== 'viewer',
          canWriteConfig: payload.user.role === 'admin',
          canManageAlerts: payload.user.role !== 'viewer',
          canManageUsers: payload.user.role === 'admin',
        },
      });
    } catch (err) {
      setError(extractErrorMessage(err, t('auth.errors.unableToAuth')));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-canvas flex flex-col justify-between">
      <header className="h-14 bg-chrome border-b-2 border-accent px-6 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5 text-white min-w-0">
          <BrandMark size="md" showWordmark />
          <span className="text-xs text-slate-400 hidden sm:inline truncate">
            · {t('app.brandTagline')}
          </span>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center p-4 sm:p-6">
        <div className="w-full max-w-md bg-white border border-hairline rounded-[2px] overflow-hidden">
          <div className="px-6 py-5 border-b border-hairline bg-[#f8f9fa]">
            <div className="flex items-center gap-2 text-ink">
              <Lock className="w-4 h-4 text-accent-ink" />
              <h1 className="text-base font-semibold">{t('auth.operatorSignIn')}</h1>
            </div>
            <p className="text-xs text-slate-600 mt-1">
              {t('auth.operatorSignInDesc')}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            {error && (
              <div className="px-3.5 py-2.5 bg-red-50 border border-red-200 rounded-[2px] text-xs text-red-900">
                {error}
              </div>
            )}

            <div>
              <label
                htmlFor="erp-login-email"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                {t('auth.workEmail')}
              </label>
              <input
                id="erp-login-email"
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="operator@plant.local"
                className={`${ERP_INPUT_CLASS} font-mono`}
              />
            </div>

            <div>
              <label
                htmlFor="erp-login-password"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                {t('auth.password')}
              </label>
              <div className="relative">
                <input
                  id="erp-login-password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={`${ERP_INPUT_CLASS} font-mono pr-9`}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  aria-label={showPassword ? t('auth.hidePassword') : t('auth.showPassword')}
                  title={showPassword ? t('auth.hidePassword') : t('auth.showPassword')}
                  className="absolute inset-y-0 right-0 px-2.5 flex items-center text-slate-500 hover:text-ink transition-colors cursor-pointer"
                >
                  {showPassword ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>

            <Button
              type="submit"
              variant="primary"
              size="md"
              disabled={isSubmitting}
              className="w-full font-semibold"
            >
              <KeyRound className="w-3.5 h-3.5" />
              {isSubmitting ? t('auth.verifying') : t('auth.signInButton')}
            </Button>

            {!authEnforced && (
              <div className="pt-4 border-t border-hairline space-y-2">
                <div className="text-[11px] font-medium text-slate-600">
                  {t('auth.quickFillTitle')}
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {DEMO_ACCOUNTS.map((acct) => (
                    <button
                      key={acct.role}
                      type="button"
                      onClick={() => {
                        setEmail(acct.email);
                        setPassword('');
                        setError(null);
                      }}
                      className="px-2 py-1.5 text-left bg-[#f8f9fa] hover:bg-[#eef1f4] border border-hairline-strong rounded-[2px] cursor-pointer transition-colors"
                    >
                      <div className="text-[11px] font-semibold text-ink">
                        {t(`auth.roles.${acct.role}`)}
                      </div>
                      <div className="text-[10px] font-mono text-slate-500 truncate">
                        {acct.role}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </form>
        </div>
      </main>

      <footer className="py-3 px-6 text-center text-[11px] text-slate-500 border-t border-hairline bg-white font-mono">
        {APP_NAME} {APP_VERSION_TAG} ·{' '}
        {t('auth.footerSummary', {
          policy: authEnforced ? t('auth.authPolicyStrict') : t('auth.authPolicyLocal'),
        })}
      </footer>
    </div>
  );
}
