import { afterEach, describe, expect, it, vi } from 'vitest'

import { shared } from '#/i18n'

import { ago, agoLong, formatNumber, stamp, clock, fileSize } from './format'

const NOW = new Date('2026-11-21T12:00:00Z')
const before = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  await shared.changeLanguage('en')
})

const at = async (language: 'en' | 'es', browser: string[] = ['en-US']) => {
  vi.stubGlobal('navigator', { languages: browser })
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  await shared.changeLanguage(language)
}

describe('times, dates and numbers follow the language', () => {
  it('writes relative times in English', async () => {
    await at('en')
    expect(ago(before(10_000))).toBe('just now')
    expect(ago(before(5 * MIN))).toBe('5 min ago')
    expect(ago(before(2 * HOUR))).toBe('2 h ago')
    expect(ago(before(3 * DAY))).toBe('3 d ago')
    expect(ago(null)).toBe('—')
    expect(agoLong(before(MIN))).toBe('1 minute ago')
    expect(agoLong(before(56 * MIN))).toBe('56 minutes ago')
    expect(agoLong(before(HOUR))).toBe('1 hour ago')
    expect(agoLong(before(5 * HOUR))).toBe('5 hours ago')
    expect(agoLong(before(DAY))).toBe('yesterday')
    expect(agoLong(before(3 * DAY))).toBe('3 days ago')
    expect(agoLong(before(14 * DAY))).toBe('2 weeks ago')
  })

  it('writes them in Spanish, with the plural of each count', async () => {
    await at('es')
    expect(ago(before(10_000))).toBe('ahora mismo')
    expect(ago(before(5 * MIN))).toBe('hace 5 min')
    expect(ago(before(2 * HOUR))).toBe('hace 2 h')
    expect(ago(before(3 * DAY))).toBe('hace 3 d')
    expect(agoLong(before(MIN))).toBe('hace 1 minuto')
    expect(agoLong(before(56 * MIN))).toBe('hace 56 minutos')
    expect(agoLong(before(HOUR))).toBe('hace 1 hora')
    expect(agoLong(before(5 * HOUR))).toBe('hace 5 horas')
    expect(agoLong(before(DAY))).toBe('ayer')
    expect(agoLong(before(3 * DAY))).toBe('hace 3 días')
    expect(agoLong(before(7 * 8 * DAY))).toBe('hace 8 semanas')
  })

  it("writes dates in the language's own order and words", async () => {
    await at('en')
    const iso = '2026-03-05T15:30:00'
    expect(stamp(iso)).toMatch(/Mar 5, 2026/)
    await at('es')
    expect(stamp(iso)).toMatch(/5 mar 2026/)
    expect(stamp(iso)).not.toMatch(/Mar 5/)
    // A date a fortnight old or more is a date, not a count of days.
    expect(ago(before(30 * DAY))).toMatch(/^\d{1,2}\/\d{1,2}\/\d{4}$/)
    await at('en')
    expect(clock(iso)).toMatch(/3:30\s?PM/)
    await at('es')
    expect(clock(iso)).toMatch(/15:30/)
  })

  it("keeps the browser's own regional format when it is in the interface's language", async () => {
    const iso = '2026-03-05T15:30:00'
    await at('en', ['en-GB'])
    expect(clock(iso)).toMatch(/15:30/)
    await at('es', ['en-GB', 'es-MX'])
    expect(formatNumber(1234.5)).toBe('1,234.5')
    await at('es', ['en-GB'])
    expect(formatNumber(1234.5)).toBe('1234,5')
  })

  it("keeps a browser's own formats when it speaks no language the board has", async () => {
    const iso = '2026-03-05T15:30:00'
    await at('en', ['nl-NL', 'sv'])
    expect(clock(iso)).toMatch(/15:30/)
    expect(formatNumber(1234.5)).toBe('1.234,5')
    // The Spanish interface keeps Spanish formats whatever the browser speaks.
    await at('es', ['nl-NL'])
    expect(formatNumber(1234.5)).toBe('1234,5')
    expect(stamp(iso)).toMatch(/5 mar 2026/)
    // A Spanish browser picks Spanish; a pick of English over it keeps English formats.
    await at('en', ['es-MX'])
    expect(formatNumber(1234.5)).toBe('1,234.5')
  })

  it("writes numbers with the language's separators", async () => {
    await at('en')
    expect(formatNumber(1234567.5)).toBe('1,234,567.5')
    expect(fileSize(3.2 * 1024 * 1024)).toBe('3.2 MB')
    await at('es')
    expect(formatNumber(1234567.5)).toBe('1.234.567,5')
    expect(formatNumber(1234)).toBe('1234')
    expect(fileSize(3.2 * 1024 * 1024)).toBe('3,2 MB')
  })
})
