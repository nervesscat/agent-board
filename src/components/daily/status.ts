import type { ReportStatus } from '#/lib/reports'

/** How a period's status reads and shows, the same on the report card and the calendar. */
export const REPORT_STATUS: Record<ReportStatus, { label: string; dot: string; text: string }> = {
  done: { label: 'done', dot: 'bg-emerald-500', text: 'text-emerald-700 dark:text-emerald-400' },
  missing: { label: 'missing', dot: 'bg-rose-500', text: 'text-rose-700 dark:text-rose-400' },
  upcoming: { label: 'upcoming', dot: 'bg-muted-foreground/30', text: 'text-muted-foreground' },
  off: { label: 'off', dot: 'bg-muted', text: 'text-muted-foreground' },
}
