import { describe, expect, it } from 'vitest'

import {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  languageCookie,
  languageFromCookie,
  languageOfRequest,
  languageOfTag,
  matchLanguage,
  parseAcceptLanguage,
} from './languages'

const request = (headers: Record<string, string>) => new Headers(headers)

describe('which language the interface is in', () => {
  it('has English and Spanish, English by default', () => {
    expect(LANGUAGES).toEqual(['en', 'es'])
    expect(DEFAULT_LANGUAGE).toBe('en')
  })

  it('reads a language tag by its primary language, whatever the region or the case', () => {
    expect(languageOfTag('es')).toBe('es')
    expect(languageOfTag('es-MX')).toBe('es')
    expect(languageOfTag('ES_ar')).toBe('es')
    expect(languageOfTag('en-GB')).toBe('en')
    expect(languageOfTag('fr-FR')).toBeUndefined()
    expect(languageOfTag('')).toBeUndefined()
  })

  it("takes the browser's first preferred language that is supported", () => {
    expect(matchLanguage(['fr-FR', 'es-ES', 'en'])).toBe('es')
    expect(matchLanguage(['de', 'fr'])).toBeUndefined()
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
    expect(languageFromCookie('lang=fr')).toBeUndefined()
    expect(languageFromCookie('language=es')).toBeUndefined()
    expect(languageFromCookie(null)).toBeUndefined()
    expect(languageCookie('es')).toMatch(/^lang=es; Path=\/;/)
  })

  it("a request is in its cookie's language, else its browser's, else English", () => {
    expect(languageOfRequest(request({ cookie: 'lang=en', 'accept-language': 'es' }))).toBe('en')
    expect(languageOfRequest(request({ 'accept-language': 'fr, es;q=0.7' }))).toBe('es')
    expect(languageOfRequest(request({ 'accept-language': 'fr' }))).toBe('en')
    expect(languageOfRequest(request({}))).toBe('en')
  })
})
