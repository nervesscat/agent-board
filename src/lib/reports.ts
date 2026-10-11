// Report periods and when they are due. Pure and in local time (a day is a local calendar day, as on
// the Daily page), so the server and the UI agree on them.

import type { ReportCadence, ReportFormat } from './constants'
import { localDate, shiftDate } from './format'

/** `off`: not asked for (not a workday, or before tracking began). */
export type ReportStatus = 'done' | 'missing' | 'upcoming' | 'off'
export type TrackedCadence = Exclude<ReportCadence, 'off'>

export interface ReportSchedule {
  cadence: ReportCadence
  /** The day a weekly report is due, 1 (Monday) to 7 (Sunday). */
  weekday: number
  /** The project's working hours, local `HH:MM`; a report is due at the shift's end. */
  shiftStart: string
  shiftEnd: string
  /** The days a daily report is asked for, ISO weekdays 1 (Monday) to 7 (Sunday). */
  workdays: number[]
  /** How long before the shift's end the board starts saying the report is due. */
  alertMinutes: number
}

/** Where the current period's report stands while the board reminds about it: due soon, or overdue. */
export interface ReportDueState {
  dueAt: string
  alertAt: string
  state: 'due' | 'missing'
  /** Whole minutes to the due time; negative once it has passed. */
  minutesLeft: number
}

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/** A local time of day, `HH:MM` on a 24-hour clock. */
export const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
export const DAY = /^\d{4}-\d{2}-\d{2}$/

/**
 * Whether a string is a day of the calendar, `YYYY-MM-DD`. `Date` rolls an impossible day over (Feb 30
 * is Mar 2), so the day must read back as itself.
 */
export function isDay(day: string): boolean {
  if (!DAY.test(day)) return false
  const d = new Date(`${day}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day
}

/** The period a moment or a day falls in: the day itself, or the Monday of its week. */
export function periodOf(cadence: TrackedCadence, at: Date | string): string {
  const day = typeof at === 'string' ? at : localDate(at)
  if (cadence === 'daily') return day
  const weekday = new Date(`${day}T00:00:00`).getDay() // 0 is Sunday
  return shiftDate(day, -((weekday + 6) % 7))
}

/** When a period's report is due: at the shift's end on its day (a weekly one on its weekday). */
export function dueAt(s: Pick<ReportSchedule, 'cadence' | 'weekday' | 'shiftEnd'>, period: string): Date {
  const day = s.cadence === 'weekly' ? shiftDate(period, s.weekday - 1) : period
  return new Date(`${day}T${s.shiftEnd}:00`)
}

/** A day's ISO weekday, 1 (Monday) to 7 (Sunday). */
export function isoWeekday(day: string): number {
  return new Date(`${day}T00:00:00`).getDay() || 7
}

/** Whether a day (YYYY-MM-DD) is one of the project's workdays. */
export function isWorkday(s: Pick<ReportSchedule, 'workdays'>, day: string): boolean {
  return s.workdays.includes(isoWeekday(day))
}

/** Whether a period is asked for at all: a weekly one always, a daily one on a workday. */
export function isAskedFor(s: Pick<ReportSchedule, 'cadence' | 'workdays'>, period: string): boolean {
  return s.cadence === 'weekly' || (s.cadence === 'daily' && isWorkday(s, period))
}

/** The first day after a period (a day, or a week from its Monday). */
export function periodEnd(cadence: TrackedCadence, period: string): string {
  return shiftDate(period, cadence === 'daily' ? 1 : 7)
}

/**
 * Whether the board should be reminding about the report of `period` at `now`: from `alertMinutes`
 * before the shift's end (not before the period starts) while it has no report, `due` before the end
 * and `missing` after it, until the period is over. Null when there is nothing to remind about: no
 * cadence, a report already, a daily period on a day off, or outside that window. A weekly report is
 * due on its weekday whatever the workdays.
 */
export function reportDueOf(
  s: ReportSchedule,
  period: string,
  hasReport: boolean,
  now = new Date(),
): ReportDueState | null {
  if (s.cadence === 'off' || hasReport || !isAskedFor(s, period)) return null
  const due = dueAt(s, period).getTime()
  const alert = Math.max(due - s.alertMinutes * 60_000, new Date(`${period}T00:00:00`).getTime())
  const end = new Date(`${periodEnd(s.cadence, period)}T00:00:00`).getTime()
  const t = now.getTime()
  if (t < alert || t >= end) return null
  const left = due - t
  return {
    dueAt: new Date(due).toISOString(),
    alertAt: new Date(alert).toISOString(),
    state: left > 0 ? 'due' : 'missing',
    // Rounded away from the due time: 1 while any of the last minute is left, -1 once it has passed.
    minutesLeft: left > 0 ? Math.ceil(left / 60_000) : Math.min(-1, Math.floor(left / 60_000)),
  }
}

/**
 * Done once it has a report; off when it is not asked for (a daily period on a day off); missing once
 * it is due without one; upcoming until then.
 */
export function reportStatus(
  s: Pick<ReportSchedule, 'cadence' | 'weekday' | 'shiftEnd' | 'workdays'>,
  period: string,
  hasReport: boolean,
  now = new Date(),
): ReportStatus {
  if (hasReport) return 'done'
  if (!isAskedFor(s, period)) return 'off'
  return now.getTime() >= dueAt(s, period).getTime() ? 'missing' : 'upcoming'
}

/** Every period from the one holding `from` to the one holding `to` (days, YYYY-MM-DD), newest first. */
export function periodsBetween(cadence: TrackedCadence, from: string, to: string, max = 400): string[] {
  const step = cadence === 'daily' ? 1 : 7
  const first = periodOf(cadence, from)
  const out: string[] = []
  for (let p = periodOf(cadence, to); p >= first && out.length < max; p = shiftDate(p, -step)) out.push(p)
  return out
}

/** "Sun, Oct 4" for a day, "week of Sep 28" for a week. */
export function periodLabel(cadence: TrackedCadence, period: string): string {
  const d = new Date(`${period}T00:00:00`)
  if (cadence === 'weekly')
    return `week of ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

/** "daily by 18:00, a file", "weekly on Fridays by 17:00, text", "off". */
export function describeSchedule(
  s: Pick<ReportSchedule, 'cadence' | 'weekday' | 'shiftEnd'> & { format: ReportFormat },
): string {
  if (s.cadence === 'off') return 'off'
  const when = s.cadence === 'weekly' ? `weekly on ${WEEKDAYS[s.weekday - 1] ?? '?'}s` : 'daily'
  return `${when} by ${s.shiftEnd}, ${s.format === 'file' ? 'a file' : 'text'}`
}
