import type { TicketStatus } from '#/lib/constants'

export function ago(iso: string | null | undefined): string {
  if (!iso) return '—'
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  const m = s / 60
  if (m < 60) return `${Math.floor(m)} min ago`
  const h = m / 60
  if (h < 24) return `${Math.floor(h)} h ago`
  const d = h / 24
  if (d < 14) return `${Math.floor(d)} d ago`
  return new Date(iso).toLocaleDateString()
}

export const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export const stamp = (iso: string) =>
  new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })

export function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`)
  d.setDate(d.getDate() + days)
  return localDate(d)
}

export const shortSha = (sha: string) => sha.slice(0, 7)

export const STATUS_LABEL: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'To do',
  in_progress: 'In progress',
  blocked: 'Blocked',
  review: 'In review',
  done: 'Done',
  cancelled: 'Cancelled',
  pending: 'Pending',
  reviewed: 'Reviewed',
  on_hold: 'On hold',
}

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Badge colours per ticket status. */
export const STAGE_TAG: Record<TicketStatus, string> = {
  done: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  review: 'bg-violet-500/15 text-violet-700 dark:text-violet-400',
  in_progress: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  blocked: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  todo: 'bg-muted text-foreground/80',
  backlog: 'bg-muted text-muted-foreground',
  cancelled: 'bg-muted text-muted-foreground line-through',
}
