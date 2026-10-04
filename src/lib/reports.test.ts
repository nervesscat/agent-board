import { describe, expect, it } from 'vitest'

import { dueAt, periodLabel, periodOf, periodsBetween, reportStatus, type ReportSchedule } from './reports'

// Every date here is local time, like the board's days.
const at = (day: string, time = '00:00') => new Date(`${day}T${time}:00`)

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
  it('is the due time of the day, or the end of it', () => {
    const daily: ReportSchedule = { cadence: 'daily', weekday: 5, dueTime: '18:00' }
    expect(dueAt(daily, '2026-10-04')).toEqual(at('2026-10-04', '18:00'))
    expect(dueAt({ ...daily, dueTime: null }, '2026-10-04')).toEqual(at('2026-10-05'))
  })

  it('falls on the weekday of the week for a weekly cadence', () => {
    const weekly: ReportSchedule = { cadence: 'weekly', weekday: 5, dueTime: '17:30' }
    expect(dueAt(weekly, '2026-09-28')).toEqual(at('2026-10-02', '17:30'))
    expect(dueAt({ ...weekly, weekday: 1 }, '2026-09-28')).toEqual(at('2026-09-28', '17:30'))
    // Sunday with no time: due by the end of Sunday, which is Monday's midnight
    expect(dueAt({ ...weekly, weekday: 7, dueTime: null }, '2026-09-28')).toEqual(at('2026-10-05'))
  })
})

describe('reportStatus', () => {
  const daily: ReportSchedule = { cadence: 'daily', weekday: 5, dueTime: '18:00' }
  it('is done with a report, missing from the due time on, upcoming before it', () => {
    expect(reportStatus(daily, '2026-10-04', false, at('2026-10-04', '17:59'))).toBe('upcoming')
    expect(reportStatus(daily, '2026-10-04', false, at('2026-10-04', '18:00'))).toBe('missing')
    expect(reportStatus(daily, '2026-10-04', true, at('2026-10-04', '19:00'))).toBe('done')
    expect(reportStatus(daily, '2026-10-05', false, at('2026-10-04', '19:00'))).toBe('upcoming')
  })

  it('counts a weekly report as missing only after its weekday', () => {
    const weekly: ReportSchedule = { cadence: 'weekly', weekday: 5, dueTime: null }
    expect(reportStatus(weekly, '2026-09-28', false, at('2026-10-02', '23:00'))).toBe('upcoming')
    expect(reportStatus(weekly, '2026-09-28', false, at('2026-10-03', '00:00'))).toBe('missing')
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
