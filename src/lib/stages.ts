import type { StageColor, StageKind } from './constants'

/** What the UI needs of a stage; the project read (`useProject`) carries them in board order. */
export type StageLike = { key: string; name: string; kind: StageKind; color: StageColor }

/** The stage a ticket is in; a key no stage has any more shows as itself. */
export const stageOf = (stages: StageLike[], key: string): StageLike =>
  stages.find((s) => s.key === key) ?? { key, name: key, kind: 'open', color: 'gray' }

/**
 * The stage the New ticket dialog starts on: the first open stage (Backlog rather than To do), else the
 * first stage; none until the stages have loaded.
 */
export const newTicketStage = (stages: StageLike[]): StageLike | undefined =>
  stages.find((s) => s.kind === 'open') ?? stages[0]

export const isClosed = (kind: StageKind) => kind === 'done' || kind === 'cancelled'

export const STAGE_KIND_LABEL: Record<StageKind, string> = {
  open: 'Open',
  active: 'Active',
  blocked: 'Blocked',
  review: 'Review',
  done: 'Done',
  cancelled: 'Cancelled',
}

/** Badge colours; spelled out so Tailwind sees every class. */
const BADGE: Record<StageColor, string> = {
  gray: 'bg-muted text-foreground/80',
  slate: 'bg-muted text-muted-foreground',
  sky: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  blue: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  teal: 'bg-teal-500/15 text-teal-700 dark:text-teal-400',
  emerald: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  lime: 'bg-lime-500/15 text-lime-700 dark:text-lime-400',
  amber: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  orange: 'bg-orange-500/15 text-orange-700 dark:text-orange-400',
  rose: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
  pink: 'bg-pink-500/15 text-pink-700 dark:text-pink-400',
  violet: 'bg-violet-500/15 text-violet-700 dark:text-violet-400',
}

/** A swatch of each colour, for the picker. */
export const STAGE_DOT: Record<StageColor, string> = {
  gray: 'bg-zinc-400',
  slate: 'bg-slate-300 dark:bg-slate-600',
  sky: 'bg-sky-500',
  blue: 'bg-blue-500',
  teal: 'bg-teal-500',
  emerald: 'bg-emerald-500',
  lime: 'bg-lime-500',
  amber: 'bg-amber-500',
  orange: 'bg-orange-500',
  rose: 'bg-rose-500',
  pink: 'bg-pink-500',
  violet: 'bg-violet-500',
}

/** Badge classes for a stage; a cancelled stage is struck through. */
export const stageBadge = (s: Pick<StageLike, 'color' | 'kind'>) =>
  `${BADGE[s.color] ?? BADGE.gray}${s.kind === 'cancelled' ? ' line-through' : ''}`

type Card = { id: number; status: string; updatedAt: string; rank?: number | null }

const placed = (t: Card) => t.rank !== null && t.rank !== undefined

/**
 * The order of a board column: the tickets placed in it first, lowest rank first, then the rest last
 * updated first. Ties keep the order they were given in.
 */
export const columnOrder = (a: Card, b: Card) =>
  placed(a) && placed(b)
    ? a.rank! - b.rank!
    : placed(a) !== placed(b)
      ? placed(a)
        ? -1
        : 1
      : b.updatedAt.localeCompare(a.updatedAt)

/** The tickets in one stage's board column, in the column's order (`columnOrder`). */
export const stageColumn = <T extends Card>(items: T[], status: string): T[] =>
  items.filter((t) => t.status === status).sort(columnOrder)

/** A list of tickets to step through: a board column, by its stage, and the tickets in it, in order. */
export type StepList = { stage: string; ids: number[] }

/**
 * `list`'s stage's column as it is now, with the tickets of `list` that have left the stage since kept
 * in it: each right after the one before it in `list` (first if none is), so a ticket keeps its place.
 * Tickets no longer in `items` drop out.
 */
function carriedColumn<T extends Card>(items: T[], list: StepList): T[] {
  const column = stageColumn(items, list.stage)
  let at = 0
  for (const id of list.ids) {
    const i = column.findIndex((t) => t.id === id)
    if (i >= 0) {
      at = i + 1
      continue
    }
    const left = items.find((t) => t.id === id)
    if (left) column.splice(at++, 0, left)
  }
  return column
}

/**
 * The tickets before and after `id` in the list being stepped through, where it sits there (null if
 * absent from `items`), and the list itself, to carry on to the next step. That list is `id`'s board
 * column, unless `carried` (the list the reader stepped here with) holds it: then that list as it is
 * now, which keeps a ticket that has moved to another stage since.
 */
export function columnNeighbours<T extends Card>(items: T[], id: number, carried?: StepList) {
  const self = items.find((t) => t.id === id)
  if (!self) return null
  let stage = carried?.stage ?? self.status
  let column = carried ? carriedColumn(items, carried) : []
  if (!column.includes(self)) {
    stage = self.status
    column = stageColumn(items, stage)
  }
  const index = column.indexOf(self)
  return {
    prev: column[index - 1] ?? null,
    next: column[index + 1] ?? null,
    index,
    count: column.length,
    list: { stage, ids: column.map((t) => t.id) },
  }
}

/**
 * The ranks that put ticket `id` at `position` (1-based; past the end is last) in its column of `items`,
 * the tickets of one column's siblings: it and every ticket above it are placed, numbered from 1 down
 * the column, and the placed ones below it follow. The column then reads back with it at `position`
 * and every other ticket in the order it had; the unplaced ones below stay unplaced. Empty when `id`
 * is not in `items`.
 */
export function placeInColumn<T extends Card>(items: T[], id: number, position: number) {
  const self = items.find((t) => t.id === id)
  if (!self) return []
  const rest = stageColumn(items, self.status).filter((t) => t !== self)
  const at = Math.min(Math.max(1, Math.floor(position)), rest.length + 1) - 1
  return [...rest.slice(0, at), self, ...rest.slice(at)]
    .filter((t, i) => i <= at || placed(t))
    .map((t, i) => ({ id: t.id, rank: i + 1 }))
}

/** `items` with the ranks `placeInColumn` gives, for showing a placement before the server answers. */
export function withPlacement<T extends Card>(items: T[], id: number, position: number): T[] {
  const ranks = new Map(placeInColumn(items, id, position).map((r) => [r.id, r.rank]))
  return items.map((t) => (ranks.has(t.id) ? { ...t, rank: ranks.get(t.id)! } : t))
}

/**
 * The 1-based position in `column` (one stage's column in order, `id` in it) that puts `id` right above
 * or below the ticket `anchor`, counted without `id` itself: what a drop asks for when
 * some of the column is hidden by a filter. Null when `anchor` is not in the column.
 */
export function positionBy(column: Card[], id: number, anchor: number, side: 'above' | 'below') {
  const rest = column.filter((t) => t.id !== id)
  const i = rest.findIndex((t) => t.id === anchor)
  return i < 0 ? null : side === 'above' ? i + 1 : i + 2
}

/**
 * In one column in order, the tickets each card sits above while it needs them merged first: the
 * "merge after #N" a review column shows where its order and the needs disagree.
 */
export function mergeAfter<T extends Card & { needs: { id: number; merged: boolean }[] }>(column: T[]) {
  const out = new Map<number, number[]>()
  column.forEach((t, i) => {
    const below = new Set(column.slice(i + 1).map((x) => x.id))
    const ids = t.needs.filter((n) => !n.merged && below.has(n.id)).map((n) => n.id)
    if (ids.length) out.set(t.id, ids)
  })
  return out
}
