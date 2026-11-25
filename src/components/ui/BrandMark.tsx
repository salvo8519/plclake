import { APP_NAME, APP_SHORT_MARK } from '../../config/appMeta';

interface BrandMarkProps {
  size?: 'sm' | 'md';
  showWordmark?: boolean;
  subtitle?: string;
}

export function BrandMark({
  size = 'md',
  showWordmark = false,
  subtitle,
}: BrandMarkProps) {
  if (!showWordmark) {
    const dim = size === 'sm' ? 'w-7 h-7 text-[11px]' : 'w-8 h-8 text-xs';
    return (
      <span
        role="img"
        aria-label={APP_NAME}
        className={`${dim} inline-flex items-center justify-center rounded-[2px] border border-[#24394f] bg-[#112132] font-mono font-bold tracking-wider text-accent select-none shrink-0`}
      >
        {APP_SHORT_MARK}
      </span>
    );
  }

  return (
    <span className="inline-flex flex-col min-w-0 leading-tight select-none">
      <span className="block text-sm font-semibold tracking-tight text-white whitespace-nowrap truncate">
        {APP_NAME}
      </span>
      {subtitle && (
        <span className="block text-[10px] font-mono uppercase tracking-[0.08em] text-accent whitespace-nowrap truncate">
          {subtitle}
        </span>
      )}
    </span>
  );
}
