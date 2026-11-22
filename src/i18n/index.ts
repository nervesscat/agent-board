import i18next, { type i18n as I18n } from 'i18next'
import { initReactI18next } from 'react-i18next'

import { browserLanguage } from './browser'
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_COOKIE,
  LANGUAGE_LOCALE,
  LANGUAGES,
  languageCookie,
  languageOfTag,
  matchLanguage,
  type Language,
} from './languages'
import { loadTranslation, translationOf, type Translation } from './locales'

export * from './languages'

// The browser starts in the language the server drew the page in, loaded before anything renders (a
// language's texts are one file each, `locales/`; `en.json` is the model the others follow).
const startLanguage: Language = typeof window === 'undefined' ? DEFAULT_LANGUAGE : browserLanguage()
await loadTranslation(startLanguage)

// Keys are checked by the typecheck against the English file: a key that is not there does not compile.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation'
    resources: { translation: Translation }
  }
}

/** A new instance in `language`, ready when this returns: `language` must be loaded (the server has them all, the browser its own). */
export function createI18n(language: Language = DEFAULT_LANGUAGE): I18n {
  const instance = i18next.createInstance()
  const resources: Record<string, { translation: Translation }> = {}
  // Every one loaded (the server's: all twenty, by reference; the browser's: the one it starts in).
  for (const l of LANGUAGES) {
    const translation = translationOf(l)
    if (translation) resources[l] = { translation }
  }
  void instance.use(initReactI18next).init({
    resources,
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
export const shared = createI18n(startLanguage)

/** The language the helpers outside React format in. */
export const currentLanguage = (): Language => (shared.language as Language | undefined) ?? DEFAULT_LANGUAGE

/**
 * The tag `Intl` and `toLocale…String` take: the browser's own locale when it is one of the current language
 * (en-GB keeps its 24-hour clock in English, es-MX its separators in Spanish), and also when the browser speaks
 * no supported language at all (a German browser on the English interface keeps German formats, as it did
 * before the interface had languages); else the language's own locale (Chinese is zh-CN).
 */
export const currentLocale = (): string => {
  const language = currentLanguage()
  if (typeof navigator === 'undefined') return LANGUAGE_LOCALE[language]
  const tags = navigator.languages ?? []
  const own = tags.find((tag) => languageOfTag(tag) === language)
  if (own) return own
  // Only on the default (English) interface: a Spanish interface a German browser picked keeps Spanish formats.
  return language === DEFAULT_LANGUAGE && matchLanguage(tags) === undefined && tags[0]
    ? tags[0]
    : LANGUAGE_LOCALE[language]
}

let latest: Language | undefined

/** Shows `language` in `instance`, once its texts are loaded. */
export async function showLanguage(instance: I18n, language: Language): Promise<void> {
  const translation = await loadTranslation(language)
  if (!instance.hasResourceBundle(language, 'translation'))
    instance.addResourceBundle(language, 'translation', translation)
  if (instance.language !== language) await instance.changeLanguage(language)
}

/**
 * Switches the browser's language now, with no reload: the page's `lang` and what the next load starts
 * from (the cookie the server's first render reads, and this browser's own copy) at once, the texts as
 * soon as that language's file is in (one small request, the first time).
 */
export async function setLanguage(language: Language): Promise<void> {
  latest = language
  if (typeof document !== 'undefined') {
    document.documentElement.lang = language
    document.cookie = languageCookie(language)
  }
  try {
    localStorage.setItem(LANGUAGE_COOKIE, language)
  } catch {}
  // Two quick picks: only the last one is shown, whichever file arrives first.
  await loadTranslation(language)
  if (latest === language) await showLanguage(shared, language)
}
