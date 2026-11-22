import { enUS } from 'date-fns/locale'
import type { Locale } from 'react-day-picker'
import {
  bn,
  de,
  es,
  fr,
  hi,
  id,
  it,
  ja,
  ko,
  pl,
  ptBR,
  ru,
  ta,
  te,
  tr,
  uk,
  vi,
  zhCN,
} from 'react-day-picker/locale'

import type { Language } from '#/i18n/languages'

/**
 * Marathi: neither date-fns nor react-day-picker ship it, so its month and weekday names come from `Intl`, and the
 * few labels the calendar reads out are written here.
 */
const marathi: Locale = {
  ...enUS,
  code: 'mr',
  localize: {
    ...enUS.localize,
    month: (n: number, options?: { width?: string }) =>
      new Date(2024, n, 1).toLocaleDateString('mr', { month: options?.width === 'wide' ? 'long' : 'short' }),
    day: (n: number, options?: { width?: string }) =>
      new Date(2024, 0, 7 + n).toLocaleDateString('mr', {
        weekday: options?.width === 'wide' ? 'long' : options?.width === 'abbreviated' ? 'short' : 'narrow',
      }),
  } as Locale['localize'],
  formatLong: {
    ...enUS.formatLong,
    // No "5th": the ordinal suffixes are English.
    date: ({ width }: { width?: 'full' | 'long' | 'medium' | 'short' } = {}) =>
      ({ full: 'EEEE, d MMMM y', long: 'd MMMM y', medium: 'd MMM y', short: 'dd/MM/y' })[width ?? 'full'],
  } as Locale['formatLong'],
  labels: {
    ...(enUS as Partial<Locale>).labels,
    labelMonthDropdown: 'महिना निवडा',
    labelYearDropdown: 'वर्ष निवडा',
    labelNext: 'पुढील महिन्याकडे',
    labelPrevious: 'मागील महिन्याकडे',
    labelNav: 'नेव्हिगेशन बार',
    labelWeekNumberHeader: 'आठवडा क्रमांक',
    labelWeekNumber: (weekNumber: number) => `आठवडा ${weekNumber}`,
  },
}

/** The day picker's locale for each interface language: its month and weekday names and the labels it reads out. */
const LOCALES: Partial<Record<Language, Locale>> = {
  zh: zhCN,
  hi,
  es,
  fr,
  bn,
  pt: ptBR,
  ru,
  id,
  de,
  ja,
  mr: marathi,
  vi,
  te,
  tr,
  ko,
  ta,
  it,
  pl,
  uk,
}

/** English is the day picker's own default. */
export const calendarLocale = (language: string): Locale | undefined => LOCALES[language as Language]
