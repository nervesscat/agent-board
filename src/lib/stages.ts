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

type Card = { id: number; status: string; updatedAt: string }

/** The tickets in one stage's board column, in the column's order: last updated first. */
export const stageColumn = <T extends Card>(items: T[], status: string): T[] =>
  items.filter((t) => t.status === status).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

/** The tickets before and after `id` in its board column, and where it sits there (null if absent). */
export function columnNeighbours<T extends Card>(items: T[], id: number) {
  const self = items.find((t) => t.id === id)
  if (!self) return null
  const column = stageColumn(items, self.status)
  const index = column.indexOf(self)
  return { prev: column[index - 1] ?? null, next: column[index + 1] ?? null, index, count: column.length }
}
