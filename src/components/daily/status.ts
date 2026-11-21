import type { TFunction } from 'i18next'

import type { ReportStatus } from '#/lib/reports'

/** How a period's status reads and shows, the same on the report card and the calendar. */
export const REPORT_STATUS: Record<ReportStatus, { dot: string; text: string }> = {
  done: { dot: 'bg-emerald-500', text: 'text-emerald-700 dark:text-emerald-400' },
  missing: { dot: 'bg-rose-500', text: 'text-rose-700 dark:text-rose-400' },
  upcoming: { dot: 'bg-muted-foreground/30', text: 'text-muted-foreground' },
  off: { dot: 'bg-muted', text: 'text-muted-foreground' },
}

/** A status in words, in the language shown. */
export const statusLabel = (s: ReportStatus, t: TFunction) => t(`reports.status.${s}`)
