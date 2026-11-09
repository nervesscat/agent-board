/**
 * The time axis the Roadmap draws every row on: one window for all of them, picked by the `window`
 * search param. Pure, so the route and its tests agree on what each choice means.
 */

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** The choices the window control offers, in the order it shows them. */
export const WINDOW_CHOICES = ['today', '24h', '7d', 'fit'] as const
export type WindowChoice = (typeof WINDOW_CHOICES)[number]
/** No `window` param: the default window (see `windowFor`). */
export type WindowKey = WindowChoice | 'default'

export type RoadmapWindow = { start: number; end: number }

/** A row as the window needs it: only the start of its work (null while it has none). */
export type WindowRow = { work: { start: string | null } }

/** The choice a raw search value names; anything unknown (or absent) is the default. */
export function parseWindowChoice(raw: unknown): WindowKey {
  return (WINDOW_CHOICES as readonly unknown[]).includes(raw) ? (raw as WindowChoice) : 'default'
}

/** Midnight at the start of the local day `now` falls on. */
function startOfToday(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * The window every row shares, ending now:
 * - `today`: from local midnight;
 * - `24h` and `7d`: that long back;
 * - `fit`: from the earliest start among the rows, however far back;
 * - default: from the earliest start, but no further back than 24 h (a day back when no row has work).
 */
export function windowFor(choice: WindowKey, rows: readonly WindowRow[], now: number): RoadmapWindow {
  const starts = rows.flatMap((r) => (r.work.start ? [Date.parse(r.work.start)] : []))
  const earliest = starts.length ? Math.min(...starts) : null
  let start: number
  switch (choice) {
    case 'today':
      start = startOfToday(now)
      break
    case '24h':
      start = now - DAY
      break
    case '7d':
      start = now - 7 * DAY
      break
    case 'fit':
      start = earliest ?? now - DAY
      break
    default:
      start = earliest === null ? now - DAY : Math.max(earliest, now - DAY)
  }
  return { start: Math.min(start, now), end: now }
}

/** The label of each choice in the control. */
export const WINDOW_LABELS: Record<WindowChoice, string> = {
  today: 'Today',
  '24h': '24 h',
  '7d': '7 d',
  fit: 'Fit all rows',
}
