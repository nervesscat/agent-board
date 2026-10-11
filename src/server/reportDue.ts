/**
 * Which projects' reports the board is reminding about right now: from `alertMinutes` before the
 * shift's end on a day the report is due, while the current period has no report (`due`), and after
 * the shift's end until the period is over (`missing`).
 */

export interface ReportDue {
  projectId: number
  project: string
  cadence: 'daily' | 'weekly'
  period: string
  label: string
  dueAt: string
  alertAt: string
  state: 'due' | 'missing'
  /** Whole minutes to the due time; negative once it has passed. */
  minutesLeft: number
}

export function reportDueFor(_projectId: number, _now = new Date()): ReportDue | null {
  return null
}

/** Every project's, by project name. */
export function reportsDue(_now = new Date()): ReportDue[] {
  return []
}
