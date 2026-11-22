// The desktop app's own texts, one file per language in strings/ (the same twenty as the board's interface,
// src/i18n/languages.ts; en.mjs is the model). This file is packaged with the app and cannot import from src/,
// so it has its own small copy of the idea (src/i18n, docs/translating.md: same glossary and same
// {{placeholders}}). Texts from the board's pages come from the board; these are the tray, the window's menu, the
// dialogs, the notifications and the page shown while a remote board is away.
//
// The language is the board's: its page sets the `lang` cookie in the window's session (main.mjs reads
// it), and the system's locale decides until there is one.

import en from './strings/en.mjs'
import zh from './strings/zh.mjs'
import hi from './strings/hi.mjs'
import es from './strings/es.mjs'
import fr from './strings/fr.mjs'
import bn from './strings/bn.mjs'
import pt from './strings/pt.mjs'
import ru from './strings/ru.mjs'
import id from './strings/id.mjs'
import de from './strings/de.mjs'
import ja from './strings/ja.mjs'
import mr from './strings/mr.mjs'
import vi from './strings/vi.mjs'
import te from './strings/te.mjs'
import tr from './strings/tr.mjs'
import ko from './strings/ko.mjs'
import ta from './strings/ta.mjs'
import it from './strings/it.mjs'
import pl from './strings/pl.mjs'
import uk from './strings/uk.mjs'

export const LANGUAGES = [
  'en',
  'zh',
  'hi',
  'es',
  'fr',
  'bn',
  'pt',
  'ru',
  'id',
  'de',
  'ja',
  'mr',
  'vi',
  'te',
  'tr',
  'ko',
  'ta',
  'it',
  'pl',
  'uk',
]
export const DEFAULT_LANGUAGE = 'en'

/** @type {Record<string, Record<string, string>>} */
export const STRINGS = { en, zh, hi, es, fr, bn, pt, ru, id, de, ja, mr, vi, te, tr, ko, ta, it, pl, uk }

/**
 * The supported language a tag or locale asks for (`es-MX`, `es_ES` and `es` are Spanish), if any.
 * @param {string | null | undefined} tag
 */
export function languageOfTag(tag) {
  const primary = String(tag ?? '')
    .trim()
    .toLowerCase()
    .split(/[-_]/)[0]
  // The old code of Indonesian (`in`); every Chinese locale (zh-CN, zh-TW) reads the Simplified text.
  return LANGUAGES.find((l) => l === (primary === 'in' ? 'id' : primary))
}

/**
 * The language to show: the board's (its `lang` cookie) when it is one we have, else the system's locale,
 * else English.
 * @param {string | null | undefined} cookie
 * @param {string | null | undefined} locale
 */
export const resolveLanguage = (cookie, locale) =>
  (LANGUAGES.includes(String(cookie)) ? String(cookie) : undefined) ??
  languageOfTag(locale) ??
  DEFAULT_LANGUAGE

/**
 * The text of `key` in `language` (English when that language lacks it), its {{placeholders}} filled from
 * `params`. A `count` picks `key_one` or `key_other` by the language's plural rules.
 * @param {string} language
 * @param {string} key
 * @param {Record<string, string | number>} [params]
 */
export function t(language, key, params = {}) {
  const table = STRINGS[language] ?? STRINGS[DEFAULT_LANGUAGE]
  const english = /** @type {Record<string, string>} */ (STRINGS[DEFAULT_LANGUAGE])
  let name = key
  if (typeof params.count === 'number') {
    const form = `${key}_${new Intl.PluralRules(language in STRINGS ? language : DEFAULT_LANGUAGE).select(params.count)}`
    if (form in (table ?? {}) || form in english) name = form
  }
  const text = table?.[name] ?? english[name] ?? key
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, p) => (p in params ? String(params[p]) : ''))
}
