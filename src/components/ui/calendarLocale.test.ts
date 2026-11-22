import { format } from 'date-fns'
import { describe, expect, it } from 'vitest'

import { LANGUAGES } from '#/i18n/languages'

import { calendarLocale } from './calendarLocale'

describe("the day picker's locale follows the interface language", () => {
  it('has one for every language but English, whose names are the picker default', () => {
    expect(calendarLocale('en')).toBeUndefined()
    for (const language of LANGUAGES.filter((l) => l !== 'en'))
      expect(calendarLocale(language), language).toBeDefined()
  })

  it('writes month and weekday names in the language', () => {
    const day = new Date(2026, 10, 22)
    expect(format(day, 'LLLL', { locale: calendarLocale('de') })).toBe('November')
    expect(format(day, 'LLLL', { locale: calendarLocale('ru') })).toBe('ноябрь')
    expect(format(day, 'cccc', { locale: calendarLocale('ja') })).toBe('日曜日')
    expect(format(day, 'cccc', { locale: calendarLocale('zh') })).toBe('星期日')
  })

  it("draws Marathi's names from Intl, and no English ordinal in its dates", () => {
    const locale = calendarLocale('mr')!
    const day = new Date(2026, 10, 22)
    expect(format(day, 'LLLL', { locale })).toBe(day.toLocaleDateString('mr', { month: 'long' }))
    expect(format(day, 'cccc', { locale })).toBe(day.toLocaleDateString('mr', { weekday: 'long' }))
    expect(format(day, 'PPPP', { locale })).not.toMatch(/\d(st|nd|rd|th)\b/)
    expect(format(day, 'PPPP', { locale })).toContain(day.toLocaleDateString('mr', { month: 'long' }))
  })
})
