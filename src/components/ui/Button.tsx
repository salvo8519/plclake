import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'subtle' | 'danger' | 'ghost';
export type ButtonSize = 'xs' | 'sm' | 'md';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'text-white bg-brand hover:bg-brand-hover border border-transparent',
  secondary:
    'text-slate-700 bg-white hover:bg-[#f4f5f6] border border-hairline-strong',
  subtle:
    'text-brand bg-brand-subtle hover:bg-[#e2eaf2] border border-brand-border',
  danger:
    'text-red-700 bg-white hover:bg-red-50 border border-red-200',
  ghost:
    'text-slate-600 bg-transparent hover:bg-slate-100 hover:text-ink border border-transparent',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  xs: 'px-2.5 py-1 text-[11px]',
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2 text-xs',
};

export function buttonStyles(
  variant: ButtonVariant = 'secondary',
  size: ButtonSize = 'sm',
  extraClass = ''
): string {
  return [
    'inline-flex items-center justify-center gap-1.5 font-medium rounded-[2px] transition-colors cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand',
    VARIANT_CLASSES[variant],
    SIZE_CLASSES[size],
    extraClass,
  ]
    .filter(Boolean)
    .join(' ');
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'sm',
  type = 'button',
  className = '',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonStyles(variant, size, className)}
      {...rest}
    >
      {children}
    </button>
  );
}
