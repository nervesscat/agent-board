import { currentLocale, shared } from '#/i18n'

/**
 * Times, dates and numbers in the language the interface shows (src/i18n): the words come from the
 * translation files, the shapes from `Intl` for that language. Called while rendering, they are drawn again
 * when the language changes (the page remounts).
 */
const t = (...args: Parameters<typeof shared.t>) => shared.t(...args)

export function ago(iso: string | null | undefined): string {
  if (!iso) return t('time.never')
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return t('time.justNow')
  const m = s / 60
  if (m < 60) return t('time.minutesAgo', { count: Math.floor(m) })
  const h = m / 60
  if (h < 24) return t('time.hoursAgo', { count: Math.floor(h) })
  const d = h / 24
  if (d < 14) return t('time.daysAgo', { count: Math.floor(d) })
  return new Date(iso).toLocaleDateString(currentLocale())
}

/** `ago` spelled out, for timelines: "56 minutes ago", "5 hours ago", "yesterday". */
export function agoLong(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return t('time.justNow')
  const m = Math.floor(s / 60)
  if (m < 60) return t('time.minutesAgoLong', { count: m })
  const h = Math.floor(m / 60)
  if (h < 24) return t('time.hoursAgoLong', { count: h })
  const d = Math.floor(h / 24)
  if (d === 1) return t('time.yesterday')
  if (d < 14) return t('time.daysAgoLong', { count: d })
  if (d < 60) return t('time.weeksAgoLong', { count: Math.floor(d / 7) })
  return new Date(iso).toLocaleDateString(currentLocale(), { dateStyle: 'medium' })
}

export const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString(currentLocale(), { hour: '2-digit', minute: '2-digit' })

export const stamp = (iso: string) =>
  new Date(iso).toLocaleString(currentLocale(), { dateStyle: 'medium', timeStyle: 'short' })

/** A number as the language writes it: 1,234.5 in English, 1.234,5 in Spanish. */
export const formatNumber = (n: number, options?: Intl.NumberFormatOptions) =>
  new Intl.NumberFormat(currentLocale(), options).format(n)

export function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`)
  d.setDate(d.getDate() + days)
  return localDate(d)
}

/** A file's size: 512 B, 40 KB, 3.2 MB. */
export const fileSize = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${Math.round(n / 1024)} KB`
      : `${formatNumber(n / 1024 / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`

export const shortSha = (sha: string) => sha.slice(0, 7)

/** PR queue statuses. Ticket stages carry their own names (`#/lib/stages`). */
export const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  reviewed: 'Reviewed',
  on_hold: 'On hold',
  done: 'Done',
}
