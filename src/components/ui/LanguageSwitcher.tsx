import { useTranslation } from 'react-i18next';
import { setAppLanguage } from '../../i18n';
import { normalizeLanguage, SUPPORTED_LANGUAGES, type SupportedLanguage } from '../../i18n/types';

interface LanguageSwitcherProps {
  tone?: 'light' | 'dark';
}

export function LanguageSwitcher({ tone = 'light' }: LanguageSwitcherProps) {
  const { i18n, t } = useTranslation('common');
  const active: SupportedLanguage = normalizeLanguage(i18n.resolvedLanguage ?? i18n.language);

  const containerClass =
    tone === 'dark'
      ? 'inline-flex items-center border border-chrome-border bg-chrome-elevated rounded-[2px] p-0.5'
      : 'inline-flex items-center border border-hairline-strong bg-[#f8f9fa] rounded-[2px] p-0.5';

  return (
    <div
      role="group"
      aria-label={t('header.language')}
      className={containerClass}
    >
      {SUPPORTED_LANGUAGES.map((lang) => {
        const isSelected = active === lang;
        const btnClass = isSelected
          ? tone === 'dark'
            ? 'bg-accent text-chrome font-semibold'
            : 'bg-brand text-white font-semibold'
          : tone === 'dark'
            ? 'text-slate-300 hover:text-white'
            : 'text-slate-600 hover:text-ink';
        return (
          <button
            key={lang}
            type="button"
            onClick={() => setAppLanguage(lang)}
            aria-pressed={isSelected}
            className={`px-2 py-0.5 text-[11px] font-mono uppercase tracking-wider rounded-[1px] transition-colors cursor-pointer ${btnClass}`}
          >
            {lang}
          </button>
        );
      })}
    </div>
  );
}
