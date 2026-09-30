import type { StageKind } from '#/lib/constants'

/** Finished lanes first, then the ones closest to finishing; cancelled ones last. */
const KIND_ORDER: StageKind[] = ['done', 'review', 'blocked', 'active', 'open', 'cancelled']

type Stage = { key: string; kind: StageKind }

/** A project's stages in lane order: by kind as above, later stages first within a kind. */
export const laneStageOrder = <S extends Stage>(stages: S[]): S[] =>
  stages
    .map((s, i) => ({ s, i }))
    .sort((a, b) => KIND_ORDER.indexOf(a.s.kind) - KIND_ORDER.indexOf(b.s.kind) || b.i - a.i)
    .map(({ s }) => s)

type Lane = {
  id: number
  status: string
  tags: string[]
  approvedAt: string | null
  disapprovedAt: string | null
}

/** The human's call on a lane, as the filter names it: `none` is no call yet. */
export const LANE_VERDICTS = ['approved', 'disapproved', 'none'] as const
export type LaneVerdict = (typeof LANE_VERDICTS)[number]
export const laneVerdict = (l: Pick<Lane, 'approvedAt' | 'disapprovedAt'>): LaneVerdict =>
  l.approvedAt ? 'approved' : l.disapprovedAt ? 'disapproved' : 'none'

/** Lanes in stage order (see `laneStageOrder`), then by id; a lane in no known stage goes last. */
export function sortLanes<L extends Lane>(lanes: L[], stages: Stage[]) {
  const order = laneStageOrder(stages).map((s) => s.key)
  const rank = (l: L) => (order.includes(l.status) ? order.indexOf(l.status) : order.length)
  return [...lanes].sort((a, b) => rank(a) - rank(b) || a.id - b.id)
}

/**
 * The lanes filter, kept in the URL (`?stage=todo,review&tag=high&verdict=none`) so the parent's
 * list and each lane's page (its previous / next) see the same one. Tags are compared lower-cased.
 */
export interface LaneFilter {
  /** Stage keys. */
  stages: string[]
  tags: string[]
  verdicts: LaneVerdict[]
}
export interface LaneSearch {
  stage?: string
  tag?: string
  verdict?: string
}

export const NO_FILTER: LaneFilter = { stages: [], tags: [], verdicts: [] }

const list = (v: unknown) =>
  v == null
    ? []
    : String(v)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

export function validateLaneSearch(s: Record<string, unknown>): LaneSearch {
  return {
    stage: s.stage == null ? undefined : String(s.stage),
    tag: s.tag == null ? undefined : String(s.tag),
    verdict: s.verdict == null ? undefined : String(s.verdict),
  }
}

export function laneFilter(search: LaneSearch): LaneFilter {
  return {
    stages: list(search.stage),
    tags: list(search.tag).map((t) => t.toLowerCase()),
    verdicts: list(search.verdict).filter((v): v is LaneVerdict => LANE_VERDICTS.includes(v as LaneVerdict)),
  }
}

export function laneSearch(f: LaneFilter): LaneSearch {
  return {
    stage: f.stages.length ? f.stages.join(',') : undefined,
    tag: f.tags.length ? f.tags.join(',') : undefined,
    verdict: f.verdicts.length ? f.verdicts.join(',') : undefined,
  }
}

/** Only picks that still match some lane count: a stage or tag nobody has any more stops filtering. */
export function effectiveFilter(lanes: Lane[], f: LaneFilter): LaneFilter {
  return {
    stages: f.stages.filter((s) => lanes.some((l) => l.status === s)),
    tags: f.tags.filter((k) => lanes.some((l) => l.tags.some((x) => x.toLowerCase() === k))),
    verdicts: f.verdicts.filter((v) => lanes.some((l) => laneVerdict(l) === v)),
  }
}

export const isFiltering = (f: LaneFilter) =>
  f.stages.length > 0 || f.tags.length > 0 || f.verdicts.length > 0

export const stageOk = (l: Lane, f: LaneFilter) => !f.stages.length || f.stages.includes(l.status)
export const tagOk = (l: Lane, f: LaneFilter) =>
  !f.tags.length || l.tags.some((tag) => f.tags.includes(tag.toLowerCase()))
export const verdictOk = (l: Lane, f: LaneFilter) => !f.verdicts.length || f.verdicts.includes(laneVerdict(l))

/**
 * The lanes before and after `id` in the filtered, sorted list. A lane the filter hides (say it was
 * just cancelled) still gets neighbours: the nearest shown lanes around its place in the full order.
 */
export function laneNeighbours<L extends Lane>(lanes: L[], stages: Stage[], id: number, filter: LaneFilter) {
  const f = effectiveFilter(lanes, filter)
  const all = sortLanes(lanes, stages)
  const at = all.findIndex((l) => l.id === id)
  const shown = all.filter((l) => stageOk(l, f) && tagOk(l, f) && verdictOk(l, f))
  const before = all.slice(0, Math.max(at, 0)).filter((l) => shown.includes(l))
  const after = all.slice(at + 1).filter((l) => shown.includes(l))
  const index = shown.findIndex((l) => l.id === id)
  return {
    prev: before.at(-1) ?? null,
    next: after[0] ?? null,
    index,
    count: shown.length,
    filtered: isFiltering(f),
  }
}
