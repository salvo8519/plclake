import type { ReactNode } from 'react';

export interface SectionCardProps {
  children: ReactNode;
  className?: string;
  ariaLabelledBy?: string;
  borderless?: boolean;
}

export function SectionCard({
  children,
  className = '',
  ariaLabelledBy,
  borderless = false,
}: SectionCardProps) {
  return (
    <section
      aria-labelledby={ariaLabelledBy}
      className={`bg-surface overflow-hidden ${
        borderless ? '' : 'border border-hairline rounded-[2px]'
      } ${className}`}
    >
      {children}
    </section>
  );
}

export interface SectionHeaderProps {
  id?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  as?: 'h1' | 'h2' | 'h3';
  muted?: boolean;
  className?: string;
}

export function SectionHeader({
  id,
  title,
  subtitle,
  icon,
  actions,
  as = 'h2',
  muted = false,
  className = '',
}: SectionHeaderProps) {
  const HeadingTag = as;
  const headingSize =
    as === 'h1'
      ? 'text-[15px] font-semibold tracking-tight text-ink'
      : 'text-[13px] font-semibold tracking-tight text-ink';

  return (
    <div
      className={`px-5 py-4 border-b border-hairline flex flex-col lg:flex-row lg:items-center justify-between gap-3 ${
        muted ? 'bg-[#f8f9fb]' : 'bg-surface'
      } ${className}`}
    >
      <div className="min-w-0">
        <HeadingTag id={id} className={`${headingSize} flex items-center gap-2`}>
          {icon && <span className="shrink-0 text-brand">{icon}</span>}
          <span className="truncate">{title}</span>
        </HeadingTag>
        {subtitle && (
          <div className="text-xs text-slate-600 mt-0.5 leading-relaxed">{subtitle}</div>
        )}
      </div>

      {actions && (
        <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>
      )}
    </div>
  );
}
