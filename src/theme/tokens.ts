/**
 * Centralized Design Tokens for PLCLake Console (Institutional Finance Editorial).
 *
 * All CSS / Tailwind utility tokens are defined in `src/index.css` (@theme) so
 * changing a color or font stack updates the entire application in one place.
 */

export const ERP_FONTS = {
  display: 'var(--font-display)',
  sans: 'var(--font-sans)',
  mono: 'var(--font-mono)',
} as const;

export const ERP_COLORS = {
  brand: '#16324f',
  brandHover: '#0f243b',
  brandSubtle: '#eef3f7',
  brandBorder: '#c7d5e2',
  accent: '#c9a45c',
  accentHover: '#b38e46',
  accentInk: '#8f6d2c',
  accentSubtle: '#f8f4ea',
  accentBorder: '#e2d4b3',
  chrome: '#0b1622',
  chromeElevated: '#122334',
  chromeActive: '#162b41',
  chromeBorder: '#1a2c3f',
  canvas: '#f4f5f6',
  surface: '#ffffff',
  ink: '#101b26',
  hairline: '#e5e7eb',
  hairlineStrong: '#cbd2da',
  tableHead: '#f8f9fa',
  statusOk: '#0f6b54',
  statusWarn: '#b45309',
  statusDanger: '#b4232c',
} as const;

export const ERP_INPUT_CLASS =
  'w-full px-3 py-2 text-xs bg-white border border-hairline-strong hover:border-[#9aa7b5] rounded-[2px] text-ink placeholder:text-slate-400 transition-colors focus:border-brand focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-brand/25 disabled:bg-slate-100 disabled:text-slate-500 disabled:hover:border-hairline-strong';

export const ERP_INPUT_COMPACT_CLASS =
  'w-full px-2.5 py-1.5 text-xs bg-white border border-hairline-strong hover:border-[#9aa7b5] rounded-[2px] text-ink placeholder:text-slate-400 transition-colors focus:border-brand focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-brand/25 disabled:bg-slate-100 disabled:text-slate-500 disabled:hover:border-hairline-strong';

export const ERP_TABLE_HEAD_ROW_CLASS =
  'bg-[#f8f9fa] border-y border-hairline text-[11px] font-semibold text-slate-500 tracking-[0.02em] whitespace-nowrap';

export const ERP_SEGMENTED_GROUP_CLASS =
  'inline-flex items-center rounded-[2px] border border-hairline-strong bg-surface overflow-hidden divide-x divide-hairline';
