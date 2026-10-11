import type { ReportStatus } from '#/lib/reports'
import type { ReportView } from './reports'

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

export function reportsOverview(date: string): ReportsOverview {
  return { date, projects: [] }
}
