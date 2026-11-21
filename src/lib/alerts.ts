/** The groups the alert types are listed under (project settings) and the severities they carry. */
export const ALERT_GROUPS = ['setup', 'work', 'machine', 'housekeeping'] as const
export type AlertGroup = (typeof ALERT_GROUPS)[number]

export const ALERT_GROUP_LABELS: Record<AlertGroup, string> = {
  setup: 'Setup and versions',
  work: 'Work',
  machine: 'This machine',
  housekeeping: 'Housekeeping',
}

export const ALERT_SEVERITIES = ['info', 'warning', 'problem'] as const
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number]

/** The most severe of the given ones; info when there are none. */
export function worstSeverity(severities: AlertSeverity[]): AlertSeverity {
  if (severities.includes('problem')) return 'problem'
  return severities.includes('warning') ? 'warning' : 'info'
}

/** A snooze option as the menu words it: `1 hour`, `1 day`, `7 days`. */
export function snoozeLabel(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'}`
}
