import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import enCommon from './locales/en/common.json';
import enOperations from './locales/en/operations.json';
import enConfiguration from './locales/en/configuration.json';
import enAdministration from './locales/en/administration.json';
import itCommon from './locales/it/common.json';
import itOperations from './locales/it/operations.json';
import itConfiguration from './locales/it/configuration.json';
import itAdministration from './locales/it/administration.json';
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_COOKIE_NAME,
  LANGUAGE_STORAGE_KEY,
  normalizeLanguage,
  type SupportedLanguage,
} from './types';

function readCookieLanguage(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${LANGUAGE_COOKIE_NAME}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function detectInitialLanguage(): SupportedLanguage {
  if (typeof window === 'undefined') return DEFAULT_LANGUAGE;
  try {
    const queryLang = new URLSearchParams(window.location.search).get('lang');
    if (queryLang) return normalizeLanguage(queryLang);
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (stored) return normalizeLanguage(stored);
    const cookieLang = readCookieLanguage();
    if (cookieLang) return normalizeLanguage(cookieLang);
    if (navigator.language) return normalizeLanguage(navigator.language);
  } catch {
    // Fallback to default language
  }
  return DEFAULT_LANGUAGE;
}

export function persistLanguagePreference(lang: SupportedLanguage): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  } catch {
    // Ignore storage privacy restrictions
  }
  if (typeof document !== 'undefined') {
    document.documentElement.lang = lang;
    // biome-ignore lint/suspicious/noDocumentCookie: the server reads this cookie for the API docs language; the Cookie Store API is not available in every supported browser.
    document.cookie = `${LANGUAGE_COOKIE_NAME}=${encodeURIComponent(lang)}; path=/; max-age=31536000; SameSite=Lax`;
  }
}

const initialLanguage = detectInitialLanguage();
persistLanguagePreference(initialLanguage);

void i18n.use(initReactI18next).init({
  resources: {
    en: {
      common: enCommon,
      operations: enOperations,
      configuration: enConfiguration,
      administration: enAdministration,
    },
    it: {
      common: itCommon,
      operations: itOperations,
      configuration: itConfiguration,
      administration: itAdministration,
    },
  },
  lng: initialLanguage,
  fallbackLng: DEFAULT_LANGUAGE,
  defaultNS: 'common',
  ns: ['common', 'operations', 'configuration', 'administration'],
  interpolation: {
    escapeValue: false,
  },
});

i18n.on('languageChanged', (lng) => {
  persistLanguagePreference(normalizeLanguage(lng));
});

export function setAppLanguage(lang: SupportedLanguage): void {
  const normalized = normalizeLanguage(lang);
  persistLanguagePreference(normalized);
  void i18n.changeLanguage(normalized);
}

export { i18n };
export default i18n;
