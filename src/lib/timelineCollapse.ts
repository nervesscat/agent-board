/**
 * The work timeline's time warp, pure: time the ticket waits on the human is not drawn to scale (before
 * work starts, blocked, a wait or a decision card, a review stage, the wait for the merge). Each such
 * period is a fixed-width labelled block on the axis whatever its real length, and a merge sits right
 * after the last recorded work. Real time elsewhere, the agents' work, keeps its scale. The chart's layout (timelineRows.ts) maps
 * every time to its place through `position`, so segments, marks and hand-offs follow the blocks.
 */
import { shared } from '#/i18n'

const MIN = 60_000

/** The axis a collapsed period takes before the chart knows its width: 72 px at 3 px per minute (`fitPieces` replaces it). */
export const COLLAPSED_MS = 24 * MIN
/** The axis the stretch between the last work (or the last collapsed period) and the merge takes. */
export const GAP_MS = 6 * MIN

/** What a ticket waited for: to be started, a blocked stage, the human's answer, a review stage, the merge. */
export type StretchKind = 'start' | 'blocked' | 'human' | 'review' | 'merge'
/** `gap` is a short unlabelled break; `tail` is everything after a pinned merge: it takes no axis at all (virtualMs 0). */
export type PieceKind = StretchKind | 'gap' | 'tail'
type Ms = { start: number; end: number }

/** A block's label when its stretch names none (a review stage names itself). */
export const stretchLabel = (kind: StretchKind): string => shared.t(`workTimeline.stretch.${kind}`)

/**
 * A stretch of real time drawn as `virtualMs` of axis. `start`/`end` are the real times, clipped to the
 * axis; `stretch` is the period's own real start and end (null for a gap), as the chip tells them.
 */
export type Piece = {
  start: number
  end: number
  kind: PieceKind
  virtualMs: number
  stretch: (Ms & { label: string }) | null
  /** The kind of period this time was skipped from (a gap between worker steps inside one too), else null. */
  skips: StretchKind | null
}

/** A period of waiting in real time; `label` is what its block says (the kind's own words when left out). */
export type Stretch = { kind: StretchKind; start: number; end: number; label?: string }

/** The earliest the last worker step's end can be a gap start: a gap is never empty in real time. */
const MIN_GAP_REAL = 1

export type PlanInput = {
  /** The periods the ticket waited, in real time (the open one already runs to now); none overlap. */
  stretches: Stretch[]
  /** The latest merge, null when there is none. */
  merge: number | null
  /** The worker steps (spans and waits; a hand-off is a point) in real time, open ones already run to now. */
  work: Ms[]
  /** The ones that keep their real scale inside a period: closed spans and closed waits not on the human. */
  carve: Ms[]
}

/** Shorter than this, what is left of a period around worker steps is not drawn. */
const MIN_REMAINDER = 1000

/** What is left of [start, end] once the intervals are taken out, in order. */
function carve(start: number, end: number, out: Ms[]): Ms[] {
  const left: Ms[] = []
  let cursor = start
  for (const w of [...out].filter((x) => x.end > x.start).sort((a, b) => a.start - b.start)) {
    if (w.end <= cursor) continue
    if (w.start >= end) break
    if (w.start > cursor) left.push({ start: cursor, end: w.start })
    cursor = Math.max(cursor, w.end)
  }
  if (cursor < end) left.push({ start: cursor, end })
  return left.filter((x) => x.end - x.start >= MIN_REMAINDER)
}

/**
 * The pieces before clipping. A merge is pinned (drawn right after the last work) only when a worker step
 * exists and none starts after it: periods starting after it are ignored, one running past it is cut at it,
 * and the time from the last work (or the end of the last period after it) to the merge is a gap.
 */
export function planPieces(input: PlanInput): { pieces: Piece[]; pinned: number | null } {
  const all = input.stretches.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start)
  const { merge } = input
  const pin = merge !== null && input.work.length > 0 && input.work.every((w) => w.start <= merge)
  const lastWorkEnd = Math.max(...input.work.map((w) => w.end))
  // Each period with the end it is drawn to: cut at the merge when one is pinned, which ignores later periods.
  let drawn = all.map((s) => ({ s, end: s.end }))
  let gap: Piece | null = null
  if (pin) {
    drawn = drawn.filter((d) => d.s.start < merge).map((d) => ({ s: d.s, end: Math.min(d.s.end, merge) }))
    const lastWork = Math.min(lastWorkEnd, merge)
    let from = Math.max(lastWork, ...drawn.filter((d) => d.end > lastWork).map((d) => d.end))
    if (from > merge - MIN_GAP_REAL) from = merge - MIN_GAP_REAL
    // A real wait before the merge (the ticket was in no waiting stage) is a labelled block; none is a short gap.
    gap =
      merge - from >= MIN
        ? {
            start: from,
            end: merge,
            kind: 'merge',
            virtualMs: COLLAPSED_MS,
            stretch: { start: from, end: merge, label: stretchLabel('merge') },
            skips: 'merge',
          }
        : { start: from, end: merge, kind: 'gap', virtualMs: GAP_MS, stretch: null, skips: null }
  }
  // Worker steps keep their real scale, so they are carved out of a period: its first remainder is the
  // labelled block, each later one a short unlabelled gap (a break on the axis).
  const pieces: Piece[] = []
  let cursor = -Infinity
  for (const { s, end: cut } of drawn) {
    const stop = gap ? Math.min(cut, gap.start) : cut
    const first = pieces.length
    for (const part of carve(Math.max(s.start, cursor), stop, input.carve)) {
      const labelled = pieces.length === first
      pieces.push({
        start: part.start,
        end: part.end,
        kind: labelled ? s.kind : 'gap',
        virtualMs: labelled ? COLLAPSED_MS : GAP_MS,
        stretch: labelled ? { start: s.start, end: s.end, label: s.label ?? stretchLabel(s.kind) } : null,
        skips: s.kind,
      })
      cursor = part.end
    }
  }
  if (gap) {
    pieces.push(gap)
    pieces.push({ start: gap.end, end: Infinity, kind: 'tail', virtualMs: 0, stretch: null, skips: null })
  }
  return { pieces, pinned: pin ? merge : null }
}

/** A collapsed block's width in pixels, and the short gap's, on a track wide enough for them. */
export const CHIP_PX = 72
export const GAP_PX = 18
/** The share of the track the fixed blocks and gaps may take together; on a narrow track they shrink to it. */
const FIXED_SHARE = 0.5

/**
 * The pieces with their length set for a track `width` px wide: each collapsed block and gap is a fixed
 * number of pixels (CHIP_PX and GAP_PX, shrunk together when they would take more than half the track),
 * and the rest of the width is the real time at one scale. `start` and `end` are the axis's real ends.
 * `slackMs` is the empty axis to add after them when there is no real time to fill the rest.
 */
export function fitPieces(
  pieces: Piece[],
  start: number,
  end: number,
  width: number,
): { pieces: Piece[]; slackMs: number } {
  const px = (p: Piece) => (p.kind === 'gap' ? GAP_PX : p.kind === 'tail' ? 0 : CHIP_PX)
  const fixed = pieces.reduce((n, p) => n + px(p), 0)
  if (!fixed || width <= 0) return { pieces, slackMs: 0 }
  const shrink = Math.min(1, (FIXED_SHARE * width) / fixed)
  const real = pieces.reduce((n, p) => n - (p.end - p.start), end - start)
  // The width left for real time; with no real time at all, 3 px per minute, and that width is left empty
  // (`slackMs`, added to the axis) so that the blocks keep their pixels instead of filling the track.
  const msPerPx = real > 0 ? real / (width - fixed * shrink) : MIN / 3
  return {
    pieces: pieces.map((p) => (px(p) ? { ...p, virtualMs: px(p) * shrink * msPerPx } : p)),
    slackMs: real > 0 ? 0 : (width - fixed * shrink) * msPerPx,
  }
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

/**
 * Where a window of `end - start` ms of agent time begins, going back from `end`: the time in the pieces
 * (the human's waits, the gaps, what follows a merge) takes no part of it, so the window reaches back
 * past them. Never earlier than `floor` (the ticket's first event), never later than `start`. With no
 * pieces inside the window it is `start` itself.
 */
export function windowStart(pieces: Piece[], start: number, end: number, floor: number | null): number {
  let cursor = end
  let left = end - start
  for (const p of [...pieces].sort((a, b) => b.start - a.start)) {
    if (p.start >= cursor) continue
    const free = cursor - Math.min(p.end, cursor)
    if (free >= left) break
    left -= free
    cursor = p.start
  }
  const at = cursor - left
  return Math.min(start, floor === null ? at : Math.max(at, floor))
}
