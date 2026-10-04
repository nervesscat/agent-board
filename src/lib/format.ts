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

/** `ago` spelled out, for timelines: "56 minutes ago", "5 hours ago", "yesterday". */
export function agoLong(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  const n = (v: number, unit: string) => `${v} ${unit}${v === 1 ? '' : 's'} ago`
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return n(m, 'minute')
  const h = Math.floor(m / 60)
  if (h < 24) return n(h, 'hour')
  const d = Math.floor(h / 24)
  if (d === 1) return 'yesterday'
  if (d < 14) return n(d, 'day')
  if (d < 60) return n(Math.floor(d / 7), 'week')
  return new Date(iso).toLocaleDateString([], { dateStyle: 'medium' })
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

/** PR queue statuses. Ticket stages carry their own names (`#/lib/stages`). */
export const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  reviewed: 'Reviewed',
  on_hold: 'On hold',
}
