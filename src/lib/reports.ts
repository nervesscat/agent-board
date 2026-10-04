// Report periods and when they are due. Pure and in local time (a day is a local calendar day, as on
// the Daily page), so the server and the UI agree on them.

import type { ReportCadence, ReportFormat } from './constants'
import { localDate, shiftDate } from './format'

export type ReportStatus = 'done' | 'missing' | 'upcoming'
export type TrackedCadence = Exclude<ReportCadence, 'off'>

export interface ReportSchedule {
  cadence: ReportCadence
  /** The day a weekly report is due, 1 (Monday) to 7 (Sunday). */
  weekday: number
  /** Local `HH:MM`; null means by the end of the day. */
  dueTime: string | null
}

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

export const DUE_TIME = /^([01]\d|2[0-3]):[0-5]\d$/
export const DAY = /^\d{4}-\d{2}-\d{2}$/

/** The period a moment or a day falls in: the day itself, or the Monday of its week. */
export function periodOf(cadence: TrackedCadence, at: Date | string): string {
  const day = typeof at === 'string' ? at : localDate(at)
  if (cadence === 'daily') return day
  const weekday = new Date(`${day}T00:00:00`).getDay() // 0 is Sunday
  return shiftDate(day, -((weekday + 6) % 7))
}

/** When a period's report is due: on its day (a weekly one on its weekday) at the due time, else by midnight. */
export function dueAt(s: ReportSchedule, period: string): Date {
  const day = s.cadence === 'weekly' ? shiftDate(period, s.weekday - 1) : period
  if (s.dueTime) return new Date(`${day}T${s.dueTime}:00`)
  return new Date(`${shiftDate(day, 1)}T00:00:00`)
}

/** Done once it has a report; missing once it is due without one; upcoming until then. */
export function reportStatus(
  s: ReportSchedule,
  period: string,
  hasReport: boolean,
  now = new Date(),
): ReportStatus {
  if (hasReport) return 'done'
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

/** "daily by 18:00, a file", "weekly on Fridays, text", "off". */
export function describeSchedule(s: ReportSchedule & { format: ReportFormat }): string {
  if (s.cadence === 'off') return 'off'
  const when = s.cadence === 'weekly' ? `weekly on ${WEEKDAYS[s.weekday - 1] ?? '?'}s` : 'daily'
  return `${when}${s.dueTime ? ` by ${s.dueTime}` : ''}, ${s.format === 'file' ? 'a file' : 'text'}`
}
