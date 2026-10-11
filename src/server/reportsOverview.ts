import { eq, ne } from 'drizzle-orm'

import { db, schema } from '#/db'
import { DAY, dueAt, periodLabel, periodOf, reportStatus, type ReportStatus } from '#/lib/reports'
import { HttpError } from './http'
import { reportVersions, type ReportView } from './reports'

/** Every project's report for the period holding a day, for the all-projects Daily page (read-only). */

export interface ReportsOverview {
  date: string
  projects: {
    id: number
    name: string
    cadence: 'daily' | 'weekly'
    period: string
    label: string
    status: ReportStatus
    due: string
    report: ReportView | null
    versions: number
  }[]
}

/**
 * For each project that tracks reports (its cadence is not off), by name: the period holding `date`
 * (the day, or its week), when it is due, its status, and its latest report with how many versions it
 * has. A period from before the project began tracking is off unless it has a report: it was never
 * asked for.
 */
export function reportsOverview(date: string, now = new Date()): ReportsOverview {
  if (!DAY.test(date) || Number.isNaN(new Date(`${date}T00:00:00`).getTime()))
    throw new HttpError(400, 'date must be a date, YYYY-MM-DD')
  const rows = db
    .select({ settings: schema.reportSettings, name: schema.projects.name })
    .from(schema.reportSettings)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.reportSettings.projectId))
    .where(ne(schema.reportSettings.cadence, 'off'))
    .all()
    .sort((a, b) => a.name.localeCompare(b.name) || a.settings.projectId - b.settings.projectId)

  return {
    date,
    projects: rows.flatMap(({ settings, name }) => {
      if (settings.cadence === 'off') return []
      const cadence = settings.cadence
      const period = periodOf(cadence, date)
      const versions = reportVersions(settings.projectId, period)
      const report = versions[0] ?? null
      const status: ReportStatus =
        !report && settings.since && period < settings.since
          ? 'off'
          : reportStatus(settings, period, Boolean(report), now)
      return [
        {
          id: settings.projectId,
          name,
          cadence,
          period,
          label: periodLabel(cadence, period),
          status,
          due: dueAt(settings, period).toISOString(),
          report,
          versions: versions.length,
        },
      ]
    }),
  }
}
