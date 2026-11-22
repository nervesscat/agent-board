import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { DEFAULT_LANGUAGE, LANGUAGES, resolveLanguage, STRINGS, t } from './app/strings.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const placeholders = (/** @type {string} */ text) =>
  [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort()
const tags = (/** @type {string} */ text) => [...text.matchAll(/<\/?(\w+)[^>]*>/g)].map((m) => m[1]).sort()

describe('the desktop app strings', () => {
  // A language writes the plural forms it has (`_one`/`_other` in English, `_other` alone in Japanese, four in
  // Russian), so keys compare without the suffix; scripts/i18n-check.mjs checks the forms themselves.
  const base = (/** @type {string} */ key) => key.replace(/_(zero|one|two|few|many|other)$/, '')
  const bases = (/** @type {Record<string, string>} */ table) =>
    [...new Set(Object.keys(table).map(base))].sort()

  it('have the same keys in every language, none empty', () => {
    expect(LANGUAGES).toHaveLength(20)
    for (const language of LANGUAGES) {
      expect(bases(STRINGS[language]), language).toEqual(bases(STRINGS.en))
      for (const [key, text] of Object.entries(STRINGS[language])) expect(text.trim(), key).not.toBe('')
    }
  })

  it('use the same placeholders and tags as the English text', () => {
    const english = (/** @type {string} */ key) =>
      STRINGS.en[key] ?? STRINGS.en[`${base(key)}_other`] ?? STRINGS.en[base(key)]
    for (const language of LANGUAGES)
      for (const [key, text] of Object.entries(STRINGS[language])) {
        expect(placeholders(text), `${language}.${key}`).toEqual(placeholders(english(key)))
        expect(tags(text), `${language}.${key}`).toEqual(tags(english(key)))
      }
  })

  it('translate with placeholders and plurals, English when the language is unknown', () => {
    expect(t('es', 'reasonCode', { code: 3 })).toBe('código de salida 3')
    expect(t('en', 'restartedTimes', { count: 1 })).toBe(' It was started again 1 time.')
    expect(t('es', 'restartedTimes', { count: 2 })).toBe(' Se inició de nuevo 2 veces.')
    expect(t('ar', 'quit')).toBe('Quit')
    expect(t('es', 'nothing')).toBe('nothing')
  })

  it('pick the board language first, then the system locale, then English', () => {
    expect(resolveLanguage('es', 'en-US')).toBe('es')
    expect(resolveLanguage(undefined, 'es-MX')).toBe('es')
    expect(resolveLanguage('xx', 'ar')).toBe(DEFAULT_LANGUAGE)
    expect(resolveLanguage(undefined, 'zh-TW')).toBe('zh')
    expect(resolveLanguage(undefined, 'pt-BR')).toBe('pt')
    expect(resolveLanguage('ja', 'es')).toBe('ja')
    expect(resolveLanguage(undefined, undefined)).toBe('en')
  })

  it('leave no label literal in main.mjs', () => {
    const source = fs.readFileSync(path.join(here, 'app', 'main.mjs'), 'utf8')
    const literals = [
      ...source.matchAll(/(?:label|title|message|detail|body):\s*(['"`])((?:(?!\1).)*)\1/g),
    ].filter((m) => /\p{L}{3,}/u.test(m[2] ?? '') && !(m[2] ?? '').startsWith('${'))
    // The window's title is the app's name, not a sentence.
    expect(literals.map((m) => m[0])).toEqual([])
    for (const text of ['Quit', 'Open in browser', 'Retry now', 'Start at login', 'cannot be reached'])
      expect(source.includes(`'${text}`), text).toBe(false)
  })
})
