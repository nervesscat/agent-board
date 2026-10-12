import type { QueryClient } from '@tanstack/react-query'

/**
 * After anything that changes a project's reports or their settings: every view of them reads again
 * (the report card and calendar, the settings and their history, the alert, the all-projects
 * overview, and the day's activity, which logs the change). Every project's without `projectId`.
 */
export function refreshReports(qc: QueryClient, projectId?: number) {
  const of = (key: string) => (projectId === undefined ? [key] : [key, projectId])
  for (const queryKey of [
    of('report-settings'),
    of('reports'),
    of('report-settings-changes'),
    ['report-due'],
    ['reports-overview'],
    ['daily'],
  ])
    void qc.invalidateQueries({ queryKey })
}
