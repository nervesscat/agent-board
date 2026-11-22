import { DEFAULT_LANGUAGE, LANGUAGES, type Language } from './languages'
import en from './locales/en.json' with { type: 'json' }

/** The texts of one language: the shape of `locales/en.json`, the model every file follows. */
export type Translation = typeof en

// One JSON file per language, each its own chunk: a browser fetches only the language it shows.
const files: Record<Exclude<Language, 'en'>, () => Promise<{ default: unknown }>> = {
  zh: () => import('./locales/zh.json', { with: { type: 'json' } }),
  hi: () => import('./locales/hi.json', { with: { type: 'json' } }),
  es: () => import('./locales/es.json', { with: { type: 'json' } }),
  fr: () => import('./locales/fr.json', { with: { type: 'json' } }),
  bn: () => import('./locales/bn.json', { with: { type: 'json' } }),
  pt: () => import('./locales/pt.json', { with: { type: 'json' } }),
  ru: () => import('./locales/ru.json', { with: { type: 'json' } }),
  id: () => import('./locales/id.json', { with: { type: 'json' } }),
  de: () => import('./locales/de.json', { with: { type: 'json' } }),
  ja: () => import('./locales/ja.json', { with: { type: 'json' } }),
  mr: () => import('./locales/mr.json', { with: { type: 'json' } }),
  vi: () => import('./locales/vi.json', { with: { type: 'json' } }),
  te: () => import('./locales/te.json', { with: { type: 'json' } }),
  tr: () => import('./locales/tr.json', { with: { type: 'json' } }),
  ko: () => import('./locales/ko.json', { with: { type: 'json' } }),
  ta: () => import('./locales/ta.json', { with: { type: 'json' } }),
  it: () => import('./locales/it.json', { with: { type: 'json' } }),
  pl: () => import('./locales/pl.json', { with: { type: 'json' } }),
  uk: () => import('./locales/uk.json', { with: { type: 'json' } }),
}

const loaded = new Map<Language, Translation>([[DEFAULT_LANGUAGE, en]])

/** The texts of a language, once loaded (English always is). */
export const translationOf = (language: Language): Translation | undefined => loaded.get(language)

/** Loads the texts of `language`; the same answer again once they are in. */
export async function loadTranslation(language: Language): Promise<Translation> {
  const have = loaded.get(language)
  if (have) return have
  const file = language === 'en' ? undefined : files[language]
  if (!file) throw new Error(`no translation file for ${language}`)
  // The files follow en.json's keys; their plural forms differ by language, which the type does not tell apart.
  const tree = (await file()).default as Translation
  loaded.set(language, tree)
  return tree
}

// The server draws any request in any language, so it has them all before it serves one; the browser loads
// the language it starts in (src/i18n/index.ts) and the next one when it is picked.
if (typeof window === 'undefined') await Promise.all(LANGUAGES.map(loadTranslation))
