import type { RunReport } from '#/lib/runReports'

/** How far back a report's run may be: any time, or since a point `now` fixes. */
export type ReportTime = 'any' | 'hour' | 'today' | 'week'
/** Whether the run's duration is known (measured, or given by the agent). */
export type ReportDuration = 'any' | 'reported' | 'unreported'
/** A 1..5 rating to match exactly, or `unrated` for a report that gave none; null for any. */
export type RatingFilter = number | 'unrated' | null
export type ReportSort = 'newest' | 'oldest' | 'longest' | 'difficulty' | 'confidence'

/** What the reports window narrows by; every filter set must match (AND). */
export interface ReportFilters {
  /** An agent name, matched whole and ignoring case; null for any. */
  agent: string | null
  /** A review round, `none` for the runs outside a review; null for any. */
  round: number | 'none' | null
  time: ReportTime
  difficulty: RatingFilter
  confidence: RatingFilter
  duration: ReportDuration
}

export const NO_REPORT_FILTERS: ReportFilters = {
  agent: null,
  round: null,
  time: 'any',
  difficulty: null,
  confidence: null,
  duration: 'any',
}

/** Whether any filter narrows the list. */
export const hasFilters = (f: ReportFilters) =>
  f.agent !== null ||
  f.round !== null ||
  f.time !== 'any' ||
  f.difficulty !== null ||
  f.confidence !== null ||
  f.duration !== 'any'

/** When the run happened: its end, else its start, else when the report was written (ms; NaN when unreadable). */
export const reportRanAt = (r: Pick<RunReport, 'endedAt' | 'startedAt' | 'createdAt'>) =>
  Date.parse(r.endedAt ?? r.startedAt ?? r.createdAt)

/** The earliest time a preset admits, at `now`; `today` starts at the local midnight. */
function since(time: Exclude<ReportTime, 'any'>, now: number): number {
  if (time === 'hour') return now - 3_600_000
  if (time === 'week') return now - 7 * 86_400_000
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const rated = (want: RatingFilter, have: number | null) =>
  want === null || (want === 'unrated' ? have === null : have === want)

/** The reports every filter admits, in their order. `now` is the clock the time presets count from. */
export function filterReports(reports: RunReport[], f: ReportFilters, now: number): RunReport[] {
  const agent = f.agent?.toLowerCase()
  const from = f.time === 'any' ? null : since(f.time, now)
  return reports.filter(
    (r) =>
      (agent === undefined || r.agent.toLowerCase() === agent) &&
      (f.round === null || (f.round === 'none' ? r.round === null : r.round === f.round)) &&
      (from === null || reportRanAt(r) >= from) &&
      rated(f.difficulty, r.difficulty) &&
      rated(f.confidence, r.confidence) &&
      (f.duration === 'any' || (f.duration === 'reported') === (r.durationSource !== 'unknown')),
  )
}

/** The newest first: the later run, then the later report id (an unreadable time counts as the earliest). */
const byNewest = (a: RunReport, b: RunReport) => (reportRanAt(b) || 0) - (reportRanAt(a) || 0) || b.id - a.id

/** A copy in the order asked. A missing rating sorts last; ties keep the newest first. */
export function sortReports(reports: RunReport[], sort: ReportSort): RunReport[] {
  const rank = (a: RunReport, b: RunReport): number => {
    switch (sort) {
      case 'oldest':
        return -byNewest(a, b)
      case 'longest':
        return b.durationMs - a.durationMs
      case 'difficulty':
        return (b.difficulty ?? 0) - (a.difficulty ?? 0)
      case 'confidence':
        return (b.confidence ?? 0) - (a.confidence ?? 0)
      default:
        return 0
    }
  }
  return [...reports].sort((a, b) => rank(a, b) || byNewest(a, b))
}

/** The agent names present, each once (first spelling), sorted. */
export function agentOptions(reports: RunReport[]): string[] {
  const seen = new Map<string, string>()
  for (const r of reports) if (!seen.has(r.agent.toLowerCase())) seen.set(r.agent.toLowerCase(), r.agent)
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}

/** The review rounds present, ascending. */
export const roundOptions = (reports: RunReport[]): number[] =>
  [...new Set(reports.flatMap((r) => (r.round === null ? [] : [r.round])))].sort((a, b) => a - b)

/** Whether some report belongs to no round, so `No round` is worth offering. */
export const hasUnroundedReport = (reports: RunReport[]) => reports.some((r) => r.round === null)
