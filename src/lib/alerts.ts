/** The groups the alert types are listed under (project settings) and the severities they carry. */
export const ALERT_GROUPS = ['setup', 'work', 'machine', 'housekeeping'] as const
export type AlertGroup = (typeof ALERT_GROUPS)[number]

// i18n-ignore: the English names the server and the e2e specs use; the interface says them through alertGroupLabel (alertText.ts)
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

/**
 * Time constants every alert type file uses. They live here, not in the registry: the registry imports
 * the type files, so a value the files read from it would still be undefined while they load.
 */
export const HOUR_MS = 60 * 60_000
export const DAY_MS = 24 * HOUR_MS
