import { describe, expect, it } from 'vitest'

import {
  describeSchedule,
  dueAt,
  periodLabel,
  periodOf,
  periodsBetween,
  reportStatus,
  type ReportSchedule,
} from './reports'

// Every date here is local time, like the board's days.
const at = (day: string, time = '00:00') => new Date(`${day}T${time}:00`)
const shift = { shiftStart: '09:00', workdays: [1, 2, 3, 4, 5], alertMinutes: 30 }

describe('periodOf', () => {
  it('is the day itself for a daily cadence', () => {
    expect(periodOf('daily', '2026-10-04')).toBe('2026-10-04')
    expect(periodOf('daily', at('2026-10-04', '23:59'))).toBe('2026-10-04')
    expect(periodOf('daily', at('2026-10-05', '00:00'))).toBe('2026-10-05')
  })

  it('is the Monday of the week for a weekly cadence, Sunday included in the week before', () => {
    expect(periodOf('weekly', '2026-09-28')).toBe('2026-09-28') // Monday
    expect(periodOf('weekly', '2026-10-02')).toBe('2026-09-28') // Friday
    expect(periodOf('weekly', '2026-10-04')).toBe('2026-09-28') // Sunday
    expect(periodOf('weekly', at('2026-10-04', '23:59'))).toBe('2026-09-28')
    expect(periodOf('weekly', '2026-10-05')).toBe('2026-10-05') // the next Monday
    // across a month and a year
    expect(periodOf('weekly', '2026-11-01')).toBe('2026-10-26')
    expect(periodOf('weekly', '2027-01-01')).toBe('2026-12-28')
  })
})

describe('dueAt', () => {
  it("is the shift's end on the day", () => {
    const daily: ReportSchedule = { cadence: 'daily', weekday: 5, shiftEnd: '18:00', ...shift }
    expect(dueAt(daily, '2026-10-04')).toEqual(at('2026-10-04', '18:00'))
    expect(dueAt({ ...daily, shiftEnd: '23:59' }, '2026-10-04')).toEqual(at('2026-10-04', '23:59'))
  })

  it('falls on the weekday of the week for a weekly cadence', () => {
    const weekly: ReportSchedule = { cadence: 'weekly', weekday: 5, shiftEnd: '17:30', ...shift }
    expect(dueAt(weekly, '2026-09-28')).toEqual(at('2026-10-02', '17:30'))
    expect(dueAt({ ...weekly, weekday: 1 }, '2026-09-28')).toEqual(at('2026-09-28', '17:30'))
    expect(dueAt({ ...weekly, weekday: 7 }, '2026-09-28')).toEqual(at('2026-10-04', '17:30'))
  })
})

describe('reportStatus', () => {
  const daily: ReportSchedule = { cadence: 'daily', weekday: 5, shiftEnd: '18:00', ...shift }
  it('is done with a report, missing from the due time on, upcoming before it', () => {
    expect(reportStatus(daily, '2026-10-04', false, at('2026-10-04', '17:59'))).toBe('upcoming')
    expect(reportStatus(daily, '2026-10-04', false, at('2026-10-04', '18:00'))).toBe('missing')
    expect(reportStatus(daily, '2026-10-04', true, at('2026-10-04', '19:00'))).toBe('done')
    expect(reportStatus(daily, '2026-10-05', false, at('2026-10-04', '19:00'))).toBe('upcoming')
  })

  it('counts a weekly report as missing only after its weekday', () => {
    const weekly: ReportSchedule = { cadence: 'weekly', weekday: 5, shiftEnd: '17:00', ...shift }
    expect(reportStatus(weekly, '2026-09-28', false, at('2026-10-02', '16:59'))).toBe('upcoming')
    expect(reportStatus(weekly, '2026-09-28', false, at('2026-10-02', '17:00'))).toBe('missing')
  })
})

describe('periodsBetween', () => {
  it('lists the periods newest first, both ends included', () => {
    expect(periodsBetween('daily', '2026-10-01', '2026-10-04')).toEqual([
      '2026-10-04',
      '2026-10-03',
      '2026-10-02',
      '2026-10-01',
    ])
    expect(periodsBetween('weekly', '2026-09-15', '2026-10-04')).toEqual([
      '2026-09-28',
      '2026-09-21',
      '2026-09-14',
    ])
    expect(periodsBetween('daily', '2026-10-05', '2026-10-04')).toEqual([])
  })

  it('names them for people', () => {
    expect(periodLabel('daily', '2026-10-04')).toBe('Sun, Oct 4')
    expect(periodLabel('weekly', '2026-09-28')).toBe('week of Sep 28')
  })
})

describe('describeSchedule', () => {
  it("says how often, by when (the shift's end) and as what", () => {
    expect(describeSchedule({ cadence: 'daily', weekday: 5, shiftEnd: '18:00', format: 'file' })).toBe(
      'daily by 18:00, a file',
    )
    expect(describeSchedule({ cadence: 'weekly', weekday: 5, shiftEnd: '17:00', format: 'text' })).toBe(
      'weekly on Fridays by 17:00, text',
    )
    expect(describeSchedule({ cadence: 'off', weekday: 5, shiftEnd: '17:00', format: 'text' })).toBe('off')
  })
})
