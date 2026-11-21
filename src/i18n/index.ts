import i18next, { type i18n as I18n } from 'i18next'
import { initReactI18next } from 'react-i18next'

import {
  DEFAULT_LANGUAGE,
  LANGUAGE_COOKIE,
  LANGUAGES,
  languageCookie,
  languageOfTag,
  matchLanguage,
  type Language,
} from './languages'
import en from './locales/en.json' with { type: 'json' }
import es from './locales/es.json' with { type: 'json' }

export * from './languages'

/** The texts of each language, one JSON file each (`locales/`); `en.json` is the model the others follow. */
export const RESOURCES = { en: { translation: en }, es: { translation: es } } as const

// Keys are checked by the typecheck against the English file: a key that is not there does not compile.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation'
    resources: { translation: typeof en }
  }
}

/** A new instance in `language`, texts bundled: nothing to load, so it is ready when this returns. */
export function createI18n(language: Language = DEFAULT_LANGUAGE): I18n {
  const instance = i18next.createInstance()
  void instance.use(initReactI18next).init({
    resources: RESOURCES,
    lng: language,
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: [...LANGUAGES],
    initAsync: false,
    interpolation: { escapeValue: false },
    returnNull: false,
  })
  return instance
}

/**
 * The browser's one instance, which the helpers outside React (dates, relative times, numbers) read. On
 * the server each request renders with an instance of its own (src/router.tsx) and this one stays English:
 * no page draws a date before the browser has its data.
 */
export const shared = createI18n(DEFAULT_LANGUAGE)

/** The language the helpers outside React format in. */
export const currentLanguage = (): Language => (shared.language as Language | undefined) ?? DEFAULT_LANGUAGE

/**
 * The tag `Intl` and `toLocale…String` take: the browser's own locale when it is one of the current language
 * (en-GB keeps its 24-hour clock in English, es-MX its separators in Spanish), and also when the browser speaks
 * no supported language at all (a German browser on the English interface keeps German formats, as it did
 * before the interface had languages); else the language itself.
 */
export const currentLocale = (): string => {
  const language = currentLanguage()
  if (typeof navigator === 'undefined') return language
  const tags = navigator.languages ?? []
  const own = tags.find((tag) => languageOfTag(tag) === language)
  if (own) return own
  // Only on the default (English) interface: a Spanish interface a German browser picked keeps Spanish formats.
  return language === DEFAULT_LANGUAGE && matchLanguage(tags) === undefined && tags[0] ? tags[0] : language
}

/**
 * Switches the browser's language now, with no reload: the instance, the page's `lang`, and what the
 * next load starts from (the cookie the server's first render reads, and this browser's own copy).
 */
export function setLanguage(language: Language): void {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = language
    document.cookie = languageCookie(language)
  }
  try {
    localStorage.setItem(LANGUAGE_COOKIE, language)
  } catch {}
  if (shared.language !== language) void shared.changeLanguage(language)
}
