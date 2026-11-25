export const SUPPORTED_LANGUAGES = ['en', 'it'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: SupportedLanguage = 'en';
export const LANGUAGE_STORAGE_KEY = 'telemetry_erp_lang';
export const LANGUAGE_COOKIE_NAME = 'telemetry_erp_lang';

export function normalizeLanguage(raw?: string | null): SupportedLanguage {
  if (!raw) return DEFAULT_LANGUAGE;
  const base = raw.trim().toLowerCase().split(/[-_;,]/)[0];
  return base === 'it' ? 'it' : 'en';
}
