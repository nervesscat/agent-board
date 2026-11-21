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
  it('have the same keys in every language, none empty', () => {
    const en = Object.keys(STRINGS.en).sort()
    for (const language of LANGUAGES) {
      expect(Object.keys(STRINGS[language]).sort(), language).toEqual(en)
      for (const [key, text] of Object.entries(STRINGS[language])) expect(text.trim(), key).not.toBe('')
    }
  })

  it('use the same placeholders and tags as the English text', () => {
    for (const language of LANGUAGES)
      for (const [key, text] of Object.entries(STRINGS[language])) {
        expect(placeholders(text), `${language}.${key}`).toEqual(placeholders(STRINGS.en[key]))
        expect(tags(text), `${language}.${key}`).toEqual(tags(STRINGS.en[key]))
      }
  })

  it('translate with placeholders and plurals, English when the language is unknown', () => {
    expect(t('es', 'reasonCode', { code: 3 })).toBe('código de salida 3')
    expect(t('en', 'restartedTimes', { count: 1 })).toBe(' It was started again 1 time.')
    expect(t('es', 'restartedTimes', { count: 2 })).toBe(' Se inició de nuevo 2 veces.')
    expect(t('fr', 'quit')).toBe('Quit')
    expect(t('es', 'nothing')).toBe('nothing')
  })

  it('pick the board language first, then the system locale, then English', () => {
    expect(resolveLanguage('es', 'en-US')).toBe('es')
    expect(resolveLanguage(undefined, 'es-MX')).toBe('es')
    expect(resolveLanguage('xx', 'fr')).toBe(DEFAULT_LANGUAGE)
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
