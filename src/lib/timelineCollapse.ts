/**
 * The work timeline's time warp, pure: time spent in a blocked or review stage is not drawn to scale. Each
 * such period is a fixed-width block on the axis whatever its real length, and a merge sits right after
 * the last recorded work. Real time elsewhere keeps its scale. The chart's layout (timelineRows.ts) maps
 * every time to its place through `position`, so segments, marks and hand-offs follow the blocks.
 */

const MIN = 60_000

/** The axis a collapsed period takes: 72 px at the chart's 3 px per minute. */
export const COLLAPSED_MS = 24 * MIN
/** The axis the stretch between the last work (or the last collapsed period) and the merge takes. */
export const GAP_MS = 6 * MIN

export type PieceKind = 'blocked' | 'review' | 'gap'
type Ms = { start: number; end: number }

/**
 * A stretch of real time drawn as `virtualMs` of axis. `start`/`end` are the real times, clipped to the
 * axis; `stretch` is the period's own real start and end (null for a gap), as the chip tells them.
 */
export type Piece = { start: number; end: number; kind: PieceKind; virtualMs: number; stretch: Ms | null }

export type Stretch = { kind: 'blocked' | 'review'; start: number; end: number }

/** The earliest the last worker step's end can be a gap start: a gap is never empty in real time. */
const MIN_GAP_REAL = 1

export type PlanInput = {
  /** Periods in blocked and review stages, in real time (the open one already runs to now). */
  stretches: Stretch[]
  /** The latest merge, null when there is none. */
  merge: number | null
  /** When each worker step (span, wait, hand-off) starts, and the latest time one ends. */
  workStarts: number[]
  lastWorkEnd: number
}

/**
 * The pieces before clipping. A merge is pinned (drawn right after the last work) only when a worker step
 * exists and none starts after it: periods starting after it are ignored, one running past it is cut at it,
 * and the time from the last work (or the end of the last period after it) to the merge is a gap.
 */
export function planPieces(input: PlanInput): { pieces: Piece[]; pinned: number | null } {
  const all = input.stretches.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start)
  const { merge } = input
  const pin = merge !== null && input.workStarts.length > 0 && input.workStarts.every((at) => at <= merge)
  // Each period with the end it is drawn to: cut at the merge when one is pinned, which ignores later periods.
  let drawn = all.map((s) => ({ s, end: s.end }))
  let gap: Piece | null = null
  if (pin) {
    drawn = drawn.filter((d) => d.s.start < merge).map((d) => ({ s: d.s, end: Math.min(d.s.end, merge) }))
    const lastWork = Math.min(input.lastWorkEnd, merge)
    let from = Math.max(lastWork, ...drawn.filter((d) => d.end > lastWork).map((d) => d.end))
    if (from > merge - MIN_GAP_REAL) from = merge - MIN_GAP_REAL
    gap = { start: from, end: merge, kind: 'gap', virtualMs: GAP_MS, stretch: null }
  }
  const pieces: Piece[] = []
  let cursor = -Infinity
  for (const { s, end: cut } of drawn) {
    const start = Math.max(s.start, cursor)
    const end = gap ? Math.min(cut, gap.start) : cut
    if (end <= start) continue
    pieces.push({
      start,
      end,
      kind: s.kind,
      virtualMs: COLLAPSED_MS,
      stretch: { start: s.start, end: s.end },
    })
    cursor = end
  }
  if (gap) pieces.push(gap)
  return { pieces, pinned: pin ? merge : null }
}

/** The pieces that overlap the window, clipped to it; each still takes its whole fixed block. */
export function clipPieces(pieces: Piece[], start: number, end: number): Piece[] {
  return pieces.flatMap((p) => {
    const a = Math.max(p.start, start)
    const b = Math.min(p.end, end)
    return b > a ? [{ ...p, start: a, end: b }] : []
  })
}

/** The axis length in ms: real time outside the pieces plus each piece's fixed length. */
export function spanOf(start: number, end: number, pieces: Piece[]): number {
  return pieces.reduce((n, p) => n - (p.end - p.start) + p.virtualMs, end - start)
}

/**
 * A time's distance from the axis start on the warped axis, in ms: real elapsed time outside the pieces,
 * and inside a piece its fixed length in proportion to how far the time is through it. Continuous and
 * monotone, and linear (the plain difference) outside [start, end].
 */
export function position(start: number, pieces: Piece[], at: number): number {
  let virtual = 0
  let cursor = start
  for (const p of pieces) {
    if (at < p.start) break
    virtual += p.start - cursor
    cursor = p.end
    if (at < p.end) return virtual + (p.virtualMs * (at - p.start)) / (p.end - p.start)
    virtual += p.virtualMs
  }
  return virtual + (at - cursor)
}
