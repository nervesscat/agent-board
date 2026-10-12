import { describe, expect, it } from 'vitest'

import {
  describeSchedule,
  dueAt,
  isDay,
  isWorkday,
  isoWeekday,
  periodLabel,
  periodOf,
  periodsBetween,
  reportDueOf,
  reportStatus,
  type ReportSchedule,
} from './reports'

// Every date here is local time, like the board's days.
const at = (day: string, time = '00:00') => new Date(`${day}T${time}:00`)
const shift = { shiftStart: '09:00', workdays: [1, 2, 3, 4, 5], alertMinutes: 30 }
const ALL = [1, 2, 3, 4, 5, 6, 7]

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

describe('isDay', () => {
  it('takes a day of the calendar only, not one Date rolls over into the next month', () => {
    for (const day of ['2026-10-04', '2026-02-28', '2028-02-29', '2026-12-31', '2026-04-30'])
      expect(isDay(day), day).toBe(true)
    for (const day of [
      '2026-02-30',
      '2026-04-31',
      '2025-02-29',
      '2026-13-01',
      '2026-00-10',
      '2026-10-00',
      '2026-1-5',
      'soon',
      '',
    ])
      expect(isDay(day), day).toBe(false)
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
  // Every day a workday (Oct 4 is a Sunday): this is about the due time.
  const daily: ReportSchedule = { cadence: 'daily', weekday: 5, shiftEnd: '18:00', ...shift, workdays: ALL }
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

describe('workdays', () => {
  it('reads a day as its ISO weekday, Monday 1 to Sunday 7', () => {
    expect(['2026-10-05', '2026-10-09', '2026-10-10', '2026-10-11'].map(isoWeekday)).toEqual([1, 5, 6, 7])
  })

  it('are the days a daily report is asked for, Monday to Friday by default', () => {
    expect(isWorkday(shift, '2026-10-09')).toBe(true) // Friday
    expect(isWorkday(shift, '2026-10-10')).toBe(false) // Saturday
    expect(isWorkday({ workdays: [6] }, '2026-10-10')).toBe(true)
  })

  it('make a daily period off on a day off, never missing; a report still makes it done', () => {
    const daily: ReportSchedule = { cadence: 'daily', weekday: 5, shiftEnd: '17:00', ...shift }
    // Saturday, long after its shift would have ended: off.
    expect(reportStatus(daily, '2026-10-10', false, at('2026-10-12', '09:00'))).toBe('off')
    expect(reportStatus(daily, '2026-10-10', true, at('2026-10-12', '09:00'))).toBe('done')
    // Friday, after its end: missing; before it: upcoming.
    expect(reportStatus(daily, '2026-10-09', false, at('2026-10-09', '17:00'))).toBe('missing')
    expect(reportStatus(daily, '2026-10-09', false, at('2026-10-09', '16:59'))).toBe('upcoming')
    // A day off by the project's own week.
    expect(reportStatus({ ...daily, workdays: [1, 2, 3, 4] }, '2026-10-09', false, at('2026-10-10'))).toBe(
      'off',
    )
  })

  it('do not touch a weekly report: it is due on its weekday whatever the workdays', () => {
    const weekly: ReportSchedule = { cadence: 'weekly', weekday: 6, shiftEnd: '12:00', ...shift }
    expect(reportStatus(weekly, '2026-10-05', false, at('2026-10-10', '12:00'))).toBe('missing')
    expect(reportStatus(weekly, '2026-10-05', false, at('2026-10-10', '11:59'))).toBe('upcoming')
  })
})

describe('reportDueOf', () => {
  // A 17:00 end with a 30 minute lead: the board reminds from 16:30.
  const daily: ReportSchedule = { cadence: 'daily', weekday: 5, shiftEnd: '17:00', ...shift }
  const due = (period: string, now: Date, hasReport = false, s = daily) =>
    reportDueOf(s, period, hasReport, now)

  it('opens alertMinutes before the end on a workday without a report: due, with the minutes left', () => {
    // Monday Oct 5.
    expect(due('2026-10-05', at('2026-10-05', '16:29'))).toBeNull()
    expect(due('2026-10-05', at('2026-10-05', '16:30'))).toEqual({
      dueAt: at('2026-10-05', '17:00').toISOString(),
      alertAt: at('2026-10-05', '16:30').toISOString(),
      state: 'due',
      minutesLeft: 30,
    })
    expect(due('2026-10-05', at('2026-10-05', '16:45'))).toMatchObject({ state: 'due', minutesLeft: 15 })
    expect(due('2026-10-05', new Date(at('2026-10-05', '16:59').getTime() + 30_000))).toMatchObject({
      state: 'due',
      minutesLeft: 1,
    })
  })

  it('says missing from the end on, with negative minutes, until the day is over', () => {
    expect(due('2026-10-05', at('2026-10-05', '17:00'))).toMatchObject({ state: 'missing', minutesLeft: -1 })
    expect(due('2026-10-05', at('2026-10-05', '17:05'))).toMatchObject({ state: 'missing', minutesLeft: -5 })
    expect(due('2026-10-05', at('2026-10-05', '23:59'))).toMatchObject({
      state: 'missing',
      minutesLeft: -419,
    })
    // The next day is another period: this one is left to the calendar.
    expect(due('2026-10-05', at('2026-10-06', '00:00'))).toBeNull()
  })

  it('has nothing to say once a report exists, on a day off, or while reports are off', () => {
    expect(due('2026-10-05', at('2026-10-05', '16:45'), true)).toBeNull()
    expect(due('2026-10-05', at('2026-10-05', '17:30'), true)).toBeNull()
    // Saturday Oct 10.
    expect(due('2026-10-10', at('2026-10-10', '16:45'))).toBeNull()
    expect(due('2026-10-10', at('2026-10-10', '17:30'))).toBeNull()
    expect(due('2026-10-05', at('2026-10-05', '16:45'), false, { ...daily, cadence: 'off' })).toBeNull()
  })

  it('takes the lead from the settings, and never opens before the period starts', () => {
    expect(due('2026-10-05', at('2026-10-05', '16:00'), false, { ...daily, alertMinutes: 60 })).toMatchObject(
      {
        state: 'due',
        minutesLeft: 60,
      },
    )
    expect(due('2026-10-05', at('2026-10-05', '16:59'), false, { ...daily, alertMinutes: 0 })).toBeNull()
    const early: ReportSchedule = { ...daily, shiftEnd: '02:00', alertMinutes: 720 }
    expect(due('2026-10-05', at('2026-10-05', '00:00'), false, early)).toMatchObject({
      alertAt: at('2026-10-05', '00:00').toISOString(),
      minutesLeft: 120,
    })
  })

  it('reminds about a weekly report on its weekday, a day off or not, until the week is over', () => {
    // Due Saturday 12:00 for the week of Monday Oct 5.
    const weekly: ReportSchedule = { ...daily, cadence: 'weekly', weekday: 6, shiftEnd: '12:00' }
    expect(due('2026-10-05', at('2026-10-09', '12:00'), false, weekly)).toBeNull()
    expect(due('2026-10-05', at('2026-10-10', '11:30'), false, weekly)).toMatchObject({
      state: 'due',
      dueAt: at('2026-10-10', '12:00').toISOString(),
      minutesLeft: 30,
    })
    expect(due('2026-10-05', at('2026-10-11', '23:00'), false, weekly)).toMatchObject({ state: 'missing' })
    expect(due('2026-10-05', at('2026-10-12', '00:00'), false, weekly)).toBeNull()
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
