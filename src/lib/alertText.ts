import { shared } from '#/i18n'
import type { AlertGroup } from '#/lib/alerts'

/** A group's name (`alerts.group.<group>`), in the current language. */
export const alertGroupLabel = (group: AlertGroup): string => shared.t(`alerts.group.${group}`)

/** A snooze option as the menu words it: `1 hour`, `1 day`, `7 days`. */
export function snoozeLabel(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return shared.t('alerts.snooze.minutes', { count: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return shared.t('alerts.snooze.hours', { count: hours })
  return shared.t('alerts.snooze.days', { count: Math.round(hours / 24) })
}
