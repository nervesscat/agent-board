import { and, eq, ne } from 'drizzle-orm'

import { db, schema } from '#/db'
import { periodLabel, periodOf, reportDueOf } from '#/lib/reports'

/**
 * Which projects' reports the board is reminding about right now: from `alertMinutes` before the
 * shift's end on a day the report is due, while the current period has no report (`due`), and after
 * the shift's end until the period is over (`missing`). Synchronous and cheap (two indexed reads per
 * project), since the summary and the inbox poll ask on every read.
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

function dueOf(settings: schema.ReportSettings, project: string, now: Date): ReportDue | null {
  if (settings.cadence === 'off') return null
  const cadence = settings.cadence
  const period = periodOf(cadence, now)
  // Not asked for before tracking began.
  if (settings.since && period < settings.since) return null
  const report = db
    .select({ id: schema.reports.id })
    .from(schema.reports)
    .where(
      and(
        eq(schema.reports.projectId, settings.projectId),
        eq(schema.reports.cadence, cadence),
        eq(schema.reports.period, period),
      ),
    )
    .get()
  const state = reportDueOf(settings, period, Boolean(report), now)
  if (!state) return null
  return {
    projectId: settings.projectId,
    project,
    cadence,
    period,
    label: periodLabel(cadence, period),
    ...state,
  }
}

const withProject = () =>
  db
    .select({ settings: schema.reportSettings, project: schema.projects.name })
    .from(schema.reportSettings)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.reportSettings.projectId))

/** The project's, or null when the board is not reminding about it (or there is no such project). */
export function reportDueFor(projectId: number, now = new Date()): ReportDue | null {
  const row = withProject().where(eq(schema.reportSettings.projectId, projectId)).get()
  return row ? dueOf(row.settings, row.project, now) : null
}

/** Every project's, by project name. */
export function reportsDue(now = new Date()): ReportDue[] {
  return withProject()
    .where(ne(schema.reportSettings.cadence, 'off'))
    .all()
    .flatMap((r) => dueOf(r.settings, r.project, now) ?? [])
    .sort((a, b) => a.project.localeCompare(b.project) || a.projectId - b.projectId)
}
