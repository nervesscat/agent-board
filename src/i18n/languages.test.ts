import { describe, expect, it } from 'vitest'

import {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  LANGUAGE_ENGLISH_NAME,
  LANGUAGE_LOCALE,
  LANGUAGE_NAME,
  languageCookie,
  languageFromCookie,
  languageOfRequest,
  languageOfTag,
  matchLanguage,
  parseAcceptLanguage,
} from './languages'

const request = (headers: Record<string, string>) => new Headers(headers)

describe('which language the interface is in', () => {
  it('has the twenty most spoken left-to-right languages, English by default', () => {
    expect(LANGUAGES).toEqual([
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
    ])
    expect(DEFAULT_LANGUAGE).toBe('en')
    expect(LANGUAGES.map((l) => LANGUAGE_NAME[l])).toEqual([
      'English',
      '中文（简体）',
      'हिन्दी',
      'Español',
      'Français',
      'বাংলা',
      'Português',
      'Русский',
      'Bahasa Indonesia',
      'Deutsch',
      '日本語',
      'मराठी',
      'Tiếng Việt',
      'తెలుగు',
      'Türkçe',
      '한국어',
      'தமிழ்',
      'Italiano',
      'Polski',
      'Українська',
    ])
    // Every one has an English name for the search and a locale `Intl` knows.
    for (const l of LANGUAGES) {
      expect(LANGUAGE_ENGLISH_NAME[l]).toBeTruthy()
      expect(Intl.DateTimeFormat.supportedLocalesOf(LANGUAGE_LOCALE[l])).toHaveLength(1)
    }
  })

  it('reads a language tag by its primary language, whatever the region or the case', () => {
    expect(languageOfTag('es')).toBe('es')
    expect(languageOfTag('es-MX')).toBe('es')
    expect(languageOfTag('ES_ar')).toBe('es')
    expect(languageOfTag('en-GB')).toBe('en')
    expect(languageOfTag('fr-FR')).toBe('fr')
    expect(languageOfTag('pt-BR')).toBe('pt')
    // Every Chinese tag reads the Simplified text; the old code of Indonesian is Indonesian.
    for (const tag of ['zh', 'zh-CN', 'zh-Hans', 'zh-TW', 'zh-Hant-HK'])
      expect(languageOfTag(tag), tag).toBe('zh')
    expect(languageOfTag('in')).toBe('id')
    expect(languageOfTag('id-ID')).toBe('id')
    // A language with no translation, and a right-to-left one, are none of the twenty.
    for (const tag of ['ar', 'ar-EG', 'he', 'fa', 'nl-NL', 'sv', ''])
      expect(languageOfTag(tag), tag).toBeUndefined()
  })

  it("takes the browser's first preferred language that is supported", () => {
    expect(matchLanguage(['ar-EG', 'es-ES', 'en'])).toBe('es')
    expect(matchLanguage(['ar', 'he', 'nl'])).toBeUndefined()
    expect(matchLanguage([])).toBeUndefined()
    expect(matchLanguage(undefined)).toBeUndefined()
  })

  it('orders an Accept-Language header by quality, and drops what is refused', () => {
    expect(parseAcceptLanguage('en;q=0.5, es-MX, fr;q=0.8')).toEqual(['es-MX', 'fr', 'en'])
    expect(parseAcceptLanguage('es;q=0, en')).toEqual(['en'])
    expect(parseAcceptLanguage('*')).toEqual([])
    expect(parseAcceptLanguage(null)).toEqual([])
  })

  it('reads the cookie, and only a supported value', () => {
    expect(languageFromCookie('a=1; lang=es; b=2')).toBe('es')
    expect(languageFromCookie('lang=fr')).toBe('fr')
    expect(languageFromCookie('lang=ar')).toBeUndefined()
    expect(languageFromCookie('language=es')).toBeUndefined()
    expect(languageFromCookie(null)).toBeUndefined()
    expect(languageCookie('es')).toMatch(/^lang=es; Path=\/;/)
  })

  it("a request is in its cookie's language, else its browser's, else English", () => {
    expect(languageOfRequest(request({ cookie: 'lang=en', 'accept-language': 'es' }))).toBe('en')
    expect(languageOfRequest(request({ 'accept-language': 'ar, es;q=0.7' }))).toBe('es')
    expect(languageOfRequest(request({ 'accept-language': 'ar' }))).toBe('en')
    expect(languageOfRequest(request({}))).toBe('en')
  })
})
