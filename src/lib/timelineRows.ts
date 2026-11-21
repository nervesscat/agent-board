import { shortName } from '#/lib/actorName'
import { clock } from '#/lib/format'
import {
  clipPieces,
  fitPieces,
  planPieces,
  position,
  spanOf,
  type Piece,
  type Stretch,
} from '#/lib/timelineCollapse'
import {
  type Interval,
  type TimelineHandoff,
  type TimelineMark,
  type TimelineSpan,
  type TimelineWait,
  type WorkTimeline,
  unionMs,
} from '#/lib/workTimeline'

/**
 * The work timeline chart (src/components/WorkTimeline.tsx) as data: one row per agent, the axis and
 * its ticks, and each segment's place on it. Pure, so the layout is checked without the DOM.
 */

const MIN = 60_000
const DAY = 24 * 60 * MIN

/** A wait as the chart reads it: `on` names the agent it was delegated to (null for a plain wait). */
export type ChartWait = TimelineWait

export type Window = { start: string; end: string }
export type Tick = { at: number; label: string }
/**
 * The axis: real `start` and `end`, the `pieces` of real time drawn at a fixed length (blocked and review
 * periods, the gap before a merge), and `span`, its length in ms once they are. Without pieces the span is
 * `end - start`.
 */
export type Axis = {
  start: number
  end: number
  ticks: Tick[]
  span: number
  pieces: Piece[]
  /** The merge the axis ends at (no window only), null otherwise. */
  pinned: number | null
}

/** A segment narrower than this share of the axis is a cap: its label is in its tooltip and popover. */
export const NARROW_SHARE = 0.06
/** The most ticks on the axis, on a track wide enough for them: one per this many pixels of it, from 2 up to 5. */
const MAX_TICKS = 5
const TICK_PX = 100

/** A segment's place on the axis, as shares of the axis length. */
export type Seg = { left: number; width: number; narrow: boolean }
type Ms = { start: number; end: number }

export type SpanItem = { kind: 'span'; key: string; lane: number; span: TimelineSpan; ms: Ms; seg: Seg }
export type WaitItem = {
  kind: 'wait'
  key: string
  lane: number
  wait: ChartWait
  ms: Ms
  seg: Seg
  delegated: boolean
}
export type RowItem = SpanItem | WaitItem

/** A hand-off: its arrow sits on the row it lands on, `to`; `from` is the row it leaves. */
export type Handoff = { handoff: TimelineHandoff; left: number; from: number; to: number }
/** A hand-off's line through one row, as shares of its height: the top and bottom edges it runs between. */
export type Connector = { key: string; left: number; top: number; bottom: number }

export type AgentRow = {
  agent: string
  name: string
  depth: number
  parent: string | null
  lanes: number
  items: RowItem[]
  arrows: Handoff[]
  connectors: Connector[]
}
export type Mark = { mark: TimelineMark; left: number }
/** A blocked or review period: its real start and end, whether it is still going, and its fixed block. */
export type Band = {
  key: string
  kind: 'blocked' | 'review'
  start: number
  end: number
  open: boolean
  seg: Seg
  /** The board's events (push, preview, ...) that fall inside the period: not drawn on the rail, listed with it. */
  marks: TimelineMark[]
}
/** A break in the axis: where a piece of time was skipped, as a share of the axis. */
export type AxisBreak = { key: string; left: number }
export type Chart = {
  axis: Axis
  /** Whether the chart follows the time: the ticket is live and its axis runs to now. */
  live: boolean
  /** Whether the ticket itself is still going, for the words about its open segments. */
  going: boolean
  now: number
  rows: AgentRow[]
  marks: Mark[]
  bands: Band[]
  breaks: AxisBreak[]
  /**
   * The ticket was created this many whole minutes before its first agent event. `left` is the creation's
   * share of the axis: 0 when it is before the window (the mark then sits on the left edge).
   */
  created: { minutes: number; left: number } | null
  summary: string
}

/** A duration in words for names and tooltips: `38 min`, `2 h 5 min`, `under a minute`. */
export function spokenDuration(ms: number): string {
  const minutes = Math.round(ms / MIN)
  if (minutes < 1) return 'under a minute'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (!h) return `${m} min`
  return m ? `${h} h ${m} min` : `${h} h`
}

/** A duration that can run to days, for a collapsed period: `4 d 23 h 30 min`, `2 d 3 h`; hours and minutes as spokenDuration below a day. */
export function longDuration(ms: number): string {
  const minutes = Math.round(ms / MIN)
  if (minutes < 24 * 60) return spokenDuration(ms)
  const d = Math.floor(minutes / (24 * 60))
  const h = Math.floor((minutes % (24 * 60)) / 60)
  const m = minutes % 60
  return [`${d} d`, h ? `${h} h` : '', m ? `${m} min` : ''].filter(Boolean).join(' ')
}

/** A row's label: the name's leaf, shortened at a word boundary when long (`builder-832` for `opencode/builder-832`). */
export { shortName }

/** The axis tick steps: 1 to 30 minutes, 1 to 12 hours, a day. */
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].map((m) => m * MIN)

/** The smallest step that puts at most `most` ticks in the span. */
export function tickStep(span: number, most = MAX_TICKS): number {
  return STEPS.find((s) => span / s <= most) ?? STEPS[STEPS.length - 1]!
}

/** How many ticks a track `width` px wide has room for: none of the labels crowd on a phone. */
export const ticksFit = (width: number) => Math.max(2, Math.min(MAX_TICKS, Math.floor(width / TICK_PX)))

/**
 * Ticks on round times (local), at the step tickStep picks for the axis length, from the start to the end.
 * Time inside a piece is skipped; a tick after one carries its date when its day differs from the tick before.
 */
export function ticksFor(
  start: number,
  end: number,
  pieces: Piece[] = [],
  span = end - start,
  most = MAX_TICKS,
): Tick[] {
  const step = tickStep(span, most)
  const offset = -new Date(start).getTimezoneOffset() * MIN
  const ticks: Tick[] = []
  let dated = false
  for (let at = Math.ceil((start + offset) / step) * step - offset; at <= end; at += step) {
    if (at < start) continue
    if (pieces.some((p) => at > p.start && (at < p.end || p.kind === 'tail'))) {
      dated = true
      continue
    }
    const day = new Date(at)
    const prev = ticks.at(-1)
    const newDay = dated && prev !== undefined && new Date(prev.at).toDateString() !== day.toDateString()
    dated = false
    ticks.push({
      at,
      label:
        step >= DAY
          ? day.toLocaleDateString([], { month: 'short', day: 'numeric' })
          : newDay
            ? `${day.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock(day.toISOString())}`
            : clock(day.toISOString()),
    })
  }
  return ticks
}

/** When each agent event starts: a span, a wait or a hand-off (the board's own marks are not agent events). */
const agentStarts = (t: WorkTimeline): number[] => [
  ...t.spans.map((s) => Date.parse(s.start)),
  ...t.waits.map((w) => Date.parse(w.start)),
  ...t.handoffs.map((h) => Date.parse(h.at)),
]

/** The worker steps as real intervals: a span or wait from its start to its end (open ones to now while live), a hand-off a point. */
const agentWork = (t: WorkTimeline, now: number): Ms[] => {
  const endOf = (end: string, open: boolean) =>
    open && t.live ? Math.max(Date.parse(end), now) : Date.parse(end)
  return [
    ...t.spans.map((s) => ({ start: Date.parse(s.start), end: endOf(s.end, s.open) })),
    ...t.waits.map((w) => ({ start: Date.parse(w.start), end: endOf(w.end, w.open) })),
    ...t.handoffs.map((h) => ({ start: Date.parse(h.at), end: Date.parse(h.at) })),
  ]
}

/**
 * The steps that keep their real scale inside a blocked or review period: closed spans and closed waits
 * that are not on the human. An open one (it runs to the ticket's last event) or a wait on the human (it is
 * the very time the ticket is blocked) would erase the period, so it is stretched over the block instead.
 */
const agentCarve = (t: WorkTimeline): Ms[] => [
  ...t.spans.filter((s) => !s.open).map((s) => ({ start: Date.parse(s.start), end: Date.parse(s.end) })),
  ...t.waits
    .filter((w) => !w.open && w.reason !== 'human')
    .map((w) => ({ start: Date.parse(w.start), end: Date.parse(w.end) })),
]

/** The blocked and review periods as real times; one still going runs to now on a live ticket. */
function stretchesOf(t: WorkTimeline, now: number): Stretch[] {
  const open = t.end ? Date.parse(t.end) : null
  const make = (kind: Stretch['kind']) => (b: { start: string; end: string }) => {
    const end = Date.parse(b.end)
    return {
      kind,
      start: Date.parse(b.start),
      end: t.live && open !== null && end >= open ? Math.max(end, now) : end,
    }
  }
  return [...t.blockedStretches.map(make('blocked')), ...t.reviewStretches.map(make('review'))]
}

/**
 * The axis: from the first agent event (a span, a wait or a hand-off) to the end, now while the ticket is
 * live, or the window given. Without agent events it starts at the timeline's first event. Blocked and
 * review periods are fixed blocks of it, and a merge after the last work sits right after it
 * (src/lib/timelineCollapse.ts); the axis then ends at the merge.
 */
export function axisFor(t: WorkTimeline, now: number, win?: Window, width?: number): Axis {
  let start: number
  let end: number
  const agentAt = agentStarts(t)
  if (win) {
    start = Date.parse(win.start)
    end = Date.parse(win.end)
  } else {
    start = agentAt.length ? Math.min(...agentAt) : t.start ? Date.parse(t.start) : now
    end = t.end ? Date.parse(t.end) : now
    if (t.live) end = Math.max(end, now)
  }
  const merges = t.marks.filter((m) => m.kind === 'merge').map((m) => Date.parse(m.at))
  const latest = merges.length ? Math.max(...merges) : null
  const plan = planPieces({
    stretches: stretchesOf(t, now),
    merge: latest !== null && latest > start && latest <= end ? latest : null,
    work: agentWork(t, now),
    carve: agentCarve(t),
  })
  if (plan.pinned !== null && !win) end = plan.pinned
  if (end <= start) end = start + MIN
  const clipped = clipPieces(plan.pieces, start, end)
  // With the track's width known, the blocks are a fixed number of pixels and the real time fills the rest.
  const fit = width === undefined ? { pieces: clipped, slackMs: 0 } : fitPieces(clipped, start, end, width)
  const pieces = fit.pieces
  const span = spanOf(start, end, pieces) + fit.slackMs
  return {
    start,
    end,
    ticks: ticksFor(start, end, pieces, span, width === undefined ? MAX_TICKS : ticksFit(width)),
    span,
    pieces,
    pinned: plan.pinned !== null && !win ? plan.pinned : null,
  }
}

/** A time's share of the axis, 0 at its start and 1 at its end; a piece's time is spread over its block. */
export const share = (axis: Axis, at: number) =>
  (axis.pieces.length ? position(axis.start, axis.pieces, at) : at - axis.start) / axis.span

/** Where an interval sits on the axis, or null when none of it does. */
export function place(ms: Ms, axis: Axis): Seg | null {
  const a = Math.max(ms.start, axis.start)
  const b = Math.min(ms.end, axis.end)
  if (a > b) return null
  const left = share(axis, a)
  const width = share(axis, b) - left
  return { left, width, narrow: width < NARROW_SHARE }
}

/** Lanes for intervals: each takes the first lane free at its start, so overlapping ones sit apart. */
export function packLanes(intervals: Interval[]): { lane: number[]; count: number } {
  const order = intervals.map((_, i) => i).sort((a, b) => intervals[a]![0] - intervals[b]![0] || a - b)
  const ends: number[] = []
  const lane: number[] = intervals.map(() => 0)
  for (const i of order) {
    const [s, e] = intervals[i]!
    let l = ends.findIndex((x) => x <= s)
    if (l < 0) {
      l = ends.length
      ends.push(e)
    } else ends[l] = e
    lane[i] = l
  }
  return { lane, count: ends.length }
}

/**
 * The agents in the order their rows show: a sub-agent right under the agent that recorded its span (`by`),
 * or else the agent a hand-off to it came from; the rest at depth 0. Parents come first, then children, by
 * first event. A cycle is broken where it closes, so every agent is listed once.
 */
export function agentTree(t: WorkTimeline): { agent: string; parent: string | null; depth: number }[] {
  const firstAt = new Map<string, number>()
  const note = (a: string, at: number) => {
    if (!firstAt.has(a) || at < firstAt.get(a)!) firstAt.set(a, at)
  }
  for (const s of t.spans) note(s.agent, Date.parse(s.start))
  for (const w of t.waits) note(w.agent, Date.parse(w.start))
  for (const h of t.handoffs) {
    note(h.from, Date.parse(h.at))
    note(h.to, Date.parse(h.at))
  }
  const agents = [...firstAt.keys()]
  const known = new Set(agents)
  const parent = new Map<string, string | null>()
  for (const a of agents) {
    const by = t.spans.find((s) => s.agent === a && s.by !== a && known.has(s.by))?.by
    const from = t.handoffs.find((h) => h.to === a && h.from !== a && known.has(h.from))?.from
    parent.set(a, by ?? from ?? null)
  }
  // Break each cycle where it closes: the node whose parent is already on the walk becomes a root. An
  // agent that only hangs off a cycle keeps its parent.
  for (const a of agents) {
    const path = [a]
    for (let p = parent.get(a) ?? null; p !== null; p = parent.get(p) ?? null) {
      if (path.includes(p)) {
        parent.set(path.at(-1)!, null)
        break
      }
      path.push(p)
    }
  }
  const byTime = (x: string, y: string) => firstAt.get(x)! - firstAt.get(y)! || (x < y ? -1 : x > y ? 1 : 0)
  const kids = new Map<string, string[]>()
  const roots: string[] = []
  for (const a of agents) {
    const p = parent.get(a) ?? null
    if (p === null) roots.push(a)
    else kids.set(p, [...(kids.get(p) ?? []), a])
  }
  const out: { agent: string; parent: string | null; depth: number }[] = []
  const visit = (a: string, depth: number) => {
    out.push({ agent: a, parent: parent.get(a) ?? null, depth })
    for (const k of (kids.get(a) ?? []).sort(byTime)) visit(k, depth + 1)
  }
  for (const r of roots.sort(byTime)) visit(r, 0)
  return out
}

/** The chart's one-sentence summary for screen readers. */
export function summarize(t: WorkTimeline, rows: AgentRow[], axis: Axis): string {
  if (!t.start) return 'No work recorded yet.'
  const working = rows.filter((r) => r.items.length > 0)
  if (!working.length) return 'No agent work recorded.'
  const clauses = working.map((r) => {
    const parts: string[] = []
    const spans = r.items.flatMap((i) => (i.kind === 'span' ? [[i.ms.start, i.ms.end] as Interval] : []))
    if (spans.length) parts.push(`worked ${spokenDuration(unionMs(spans))}`)
    const byTarget = new Map<string, Interval[]>()
    for (const i of r.items) {
      if (i.kind !== 'wait') continue
      const target = i.delegated
        ? `${i.wait.on}, delegated`
        : i.wait.reason === 'human'
          ? 'the human'
          : i.wait.reason
      byTarget.set(target, [...(byTarget.get(target) ?? []), [i.ms.start, i.ms.end]])
    }
    for (const [target, ms] of byTarget) parts.push(`waited ${spokenDuration(unionMs(ms))} on ${target}`)
    return `${r.agent || 'unnamed'} ${parts.join(', ')}`
  })
  const doers = working.filter((r) => r.items.some((i) => i.kind === 'span')).length
  const n = doers || working.length
  const over = spokenDuration(axis.end - axis.start)
  const who = doers ? 'Work by' : 'Activity by'
  const skipped = (['blocked', 'review'] as const).flatMap((k) => {
    const ms = axis.pieces.filter((p) => p.skips === k).reduce((n, p) => n + p.end - p.start, 0)
    return ms > 0 ? [`${k === 'review' ? 'in review' : 'blocked'} ${longDuration(ms)}`] : []
  })
  const scale = skipped.length ? ` Not to scale: ${skipped.join(', ')}.` : ''
  return `${who} ${n} agent${n === 1 ? '' : 's'} over ${over}: ${clauses.join('; ')}.${t.live ? ' Still going.' : ''}${scale}`
}

/** The whole chart as the view draws it: rows, marks, blocked bands, the creation mark and the summary. */
export function buildChart(t: WorkTimeline, now: number, win?: Window, width?: number): Chart {
  const axis = axisFor(t, now, win, width)
  const going = t.live
  // Not live for drawing once the axis ends at a pinned merge: now is days past its right edge.
  const live = going && axis.pinned === null
  const endOf = (end: string, open: boolean) =>
    open && going ? Math.max(Date.parse(end), now) : Date.parse(end)

  const tree = agentTree(t)
  const index = new Map(tree.map((r, i) => [r.agent, i]))
  const rows: AgentRow[] = tree.map((r) => ({
    agent: r.agent,
    name: shortName(r.agent),
    depth: r.depth,
    parent: r.parent,
    lanes: 1,
    items: [],
    arrows: [],
    connectors: [],
  }))

  type Placed = { row: number; ms: Ms; seg: Seg; make: (lane: number) => RowItem }
  const placed: Placed[] = []
  const add = (agent: string, ms: Ms, make: (lane: number, seg: Seg) => RowItem) => {
    const seg = place(ms, axis)
    const row = index.get(agent)
    if (seg && row !== undefined) placed.push({ row, ms, seg, make: (lane) => make(lane, seg) })
  }
  for (const span of t.spans) {
    const ms = { start: Date.parse(span.start), end: endOf(span.end, span.open) }
    add(span.agent, ms, (lane, seg) => ({ kind: 'span', key: `span-${span.id}`, lane, span, ms, seg }))
  }
  for (const w of t.waits as ChartWait[]) {
    const ms = { start: Date.parse(w.start), end: endOf(w.end, w.open) }
    const delegated = !!w.on
    add(w.agent, ms, (lane, seg) => ({
      kind: 'wait',
      key: `wait-${w.id}`,
      lane,
      wait: w,
      ms,
      seg,
      delegated,
    }))
  }
  rows.forEach((row, i) => {
    const mine = placed
      .filter((p) => p.row === i)
      .sort((a, b) => a.ms.start - b.ms.start || a.ms.end - b.ms.end)
    const { lane, count } = packLanes(mine.map((p) => [p.ms.start, p.ms.end]))
    row.items = mine.map((p, j) => p.make(lane[j]!))
    row.lanes = Math.max(1, count)
  })

  for (const h of t.handoffs) {
    const at = Date.parse(h.at)
    const to = index.get(h.to)
    const from = index.get(h.from)
    if (to === undefined || at < axis.start || at > axis.end) continue
    const left = share(axis, at)
    rows[to]!.arrows.push({ handoff: h, left, from: from ?? to, to })
    if (from === undefined || from === to) continue
    const [lo, hi] = from < to ? [from, to] : [to, from]
    for (let i = lo; i <= hi; i++)
      rows[i]!.connectors.push({
        key: `handoff-${h.id}`,
        left,
        top: i === lo ? 50 : 0,
        bottom: i === hi ? 50 : 0,
      })
  }

  // A block per blocked or review period (its fixed place on the axis), with the period's own real times.
  const bands: Band[] = []
  const breaks: AxisBreak[] = []
  const openAt = t.end ? Date.parse(t.end) : null
  axis.pieces.forEach((p, i) => {
    const mid = (position(axis.start, axis.pieces, p.start) + p.virtualMs / 2) / axis.span
    if (p.kind !== 'tail') breaks.push({ key: `break-${i}`, left: mid })
    if (p.kind === 'gap' || p.kind === 'tail' || !p.stretch) return
    const seg = place({ start: p.start, end: p.end }, axis)
    if (seg)
      bands.push({
        key: `${p.kind}-${i}`,
        kind: p.kind,
        start: p.stretch.start,
        end: p.stretch.end,
        open: going && openAt !== null && p.stretch.end >= openAt,
        marks: t.marks.filter(
          (m) => m.kind !== 'merge' && Date.parse(m.at) > p.start && Date.parse(m.at) < p.end,
        ),
        seg,
      })
  })
  // A board event strictly inside a block is listed with the block, not drawn over its chip.
  const hidden = new Set(bands.flatMap((b) => b.marks.map((m) => m.id)))
  const marks: Mark[] = []
  for (const m of t.marks) {
    const at = Date.parse(m.at)
    if (at < axis.start || at > axis.end || hidden.has(m.id)) continue
    // A merge is never hidden: inside a block it is drawn at the block's end edge, not on its chip.
    const block =
      m.kind === 'merge'
        ? axis.pieces.find((p) => (p.kind === 'blocked' || p.kind === 'review') && at > p.start && at < p.end)
        : undefined
    marks.push({ mark: m, left: share(axis, block ? block.end : at) })
  }
  // The creation mark: from the ticket's first event (its creation) to its first agent event, drawn at the
  // creation's place on the axis, and on the left edge only when the creation is before the window.
  const agentAt = agentStarts(t)
  const createdAt = t.start ? Date.parse(t.start) : null
  const lead = createdAt !== null && agentAt.length ? Math.floor((Math.min(...agentAt) - createdAt) / MIN) : 0
  const createdShare = createdAt === null ? 0 : share(axis, createdAt)
  return {
    axis,
    live,
    going,
    now,
    rows,
    marks,
    bands,
    breaks,
    created:
      createdAt !== null && lead >= 1 && createdShare <= 1
        ? { minutes: lead, left: Math.max(0, createdShare) }
        : null,
    summary: summarize(t, rows, axis),
  }
}
