import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export type BannerKind = 'ok' | 'err' | 'warn' | 'info';

const KIND_CLASSES: Record<BannerKind, string> = {
  ok: 'bg-emerald-50 border-emerald-200 text-emerald-950',
  err: 'bg-red-50 border-red-200 text-red-900',
  warn: 'bg-amber-50 border-amber-200 text-amber-950',
  info: 'bg-brand-subtle border-brand-border text-ink',
};

export interface StatusBannerProps {
  kind: BannerKind;
  message: ReactNode;
  onDismiss?: () => void;
  className?: string;
}

export function StatusBanner({
  kind,
  message,
  onDismiss,
  className = '',
}: StatusBannerProps) {
  const { t } = useTranslation('common');
  return (
    <div
      role={kind === 'err' ? 'alert' : 'status'}
      className={`px-4 py-2.5 rounded-[2px] border text-xs flex items-center justify-between gap-4 ${KIND_CLASSES[kind]} ${className}`}
    >
      <div className="min-w-0 flex-1">{message}</div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="text-xs font-medium underline cursor-pointer shrink-0 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand rounded-[2px]"
        >
          {t('actions.dismiss')}
        </button>
      )}
    </div>
  );
}
