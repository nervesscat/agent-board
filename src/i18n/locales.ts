import { DEFAULT_LANGUAGE, LANGUAGES, type Language } from './languages'
import en from './locales/en.json' with { type: 'json' }

/** The texts of one language: the shape of `locales/en.json`, the model every file follows. */
export type Translation = typeof en

// One JSON file per language, each its own chunk: a browser fetches only the language it shows.
const files = import.meta.glob<{ default: Translation }>('./locales/*.json')

const loaded = new Map<Language, Translation>([[DEFAULT_LANGUAGE, en]])

/** The texts of a language, once loaded (English always is). */
export const translationOf = (language: Language): Translation | undefined => loaded.get(language)

/** Loads the texts of `language`; the same answer again once they are in. */
export async function loadTranslation(language: Language): Promise<Translation> {
  const have = loaded.get(language)
  if (have) return have
  const file = files[`./locales/${language}.json`]
  if (!file) throw new Error(`no translation file for ${language}`)
  const { default: tree } = await file()
  loaded.set(language, tree)
  return tree
}

// The server draws any request in any language, so it has them all before it serves one; the browser loads
// the language it starts in (src/i18n/index.ts) and the next one when it is picked.
if (typeof window === 'undefined') await Promise.all(LANGUAGES.map(loadTranslation))
