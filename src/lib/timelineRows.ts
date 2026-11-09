import { clock } from '#/lib/format'
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
export type Axis = { start: number; end: number; ticks: Tick[] }

/** A segment narrower than this share of the axis is a cap: its label is in its tooltip and popover. */
export const NARROW_SHARE = 0.06
/** The track's width per minute of axis; a narrow screen's track scrolls sideways past the screen. */
export const PX_PER_MINUTE = 3

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
export type Band = { key: string; start: number; end: number; seg: Seg }
export type Chart = {
  axis: Axis
  live: boolean
  now: number
  rows: AgentRow[]
  marks: Mark[]
  bands: Band[]
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

/** A row's label: the name, or its last part when it is a path like `lead/builder`, shortened when long. */
export function shortName(name: string, max = 20): string {
  if (!name) return 'unnamed'
  const base = name.includes('/') && name.length > max ? name.slice(name.lastIndexOf('/') + 1) : name
  return base.length > max ? `${base.slice(0, max - 1)}…` : base
}

/** The axis tick steps: 1 to 30 minutes, 1 to 12 hours, a day. */
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].map((m) => m * MIN)

/** The smallest step that puts at most five ticks in the span. */
export function tickStep(span: number): number {
  return STEPS.find((s) => span / s <= 5) ?? STEPS[STEPS.length - 1]!
}

/** Ticks on round times (local), at the step tickStep picks, from the start to the end. */
export function ticksFor(start: number, end: number): Tick[] {
  const step = tickStep(end - start)
  const offset = -new Date(start).getTimezoneOffset() * MIN
  const ticks: Tick[] = []
  for (let at = Math.ceil((start + offset) / step) * step - offset; at <= end; at += step) {
    if (at < start) continue
    const day = new Date(at)
    ticks.push({
      at,
      label:
        step >= DAY
          ? day.toLocaleDateString([], { month: 'short', day: 'numeric' })
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

/**
 * The axis: from the first agent event (a span, a wait or a hand-off) to the end, now while the ticket is
 * live, or the window given. Without agent events it starts at the timeline's first event.
 */
export function axisFor(t: WorkTimeline, now: number, win?: Window): Axis {
  let start: number
  let end: number
  if (win) {
    start = Date.parse(win.start)
    end = Date.parse(win.end)
  } else {
    const agentAt = agentStarts(t)
    start = agentAt.length ? Math.min(...agentAt) : t.start ? Date.parse(t.start) : now
    end = t.end ? Date.parse(t.end) : now
    if (t.live) end = Math.max(end, now)
  }
  if (end <= start) end = start + MIN
  return { start, end, ticks: ticksFor(start, end) }
}

/** A time's share of the axis, 0 at its start and 1 at its end. */
export const share = (axis: Axis, at: number) => (at - axis.start) / (axis.end - axis.start)

/** Where an interval sits on the axis, or null when none of it does. */
export function place(ms: Ms, axis: Axis): Seg | null {
  const a = Math.max(ms.start, axis.start)
  const b = Math.min(ms.end, axis.end)
  if (a > b) return null
  const width = (b - a) / (axis.end - axis.start)
  return { left: share(axis, a), width, narrow: width < NARROW_SHARE }
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
  return `${who} ${n} agent${n === 1 ? '' : 's'} over ${over}: ${clauses.join('; ')}.${t.live ? ' Still going.' : ''}`
}

/** The whole chart as the view draws it: rows, marks, blocked bands, the creation mark and the summary. */
export function buildChart(t: WorkTimeline, now: number, win?: Window): Chart {
  const axis = axisFor(t, now, win)
  const live = t.live
  const endOf = (end: string, open: boolean) =>
    open && live ? Math.max(Date.parse(end), now) : Date.parse(end)

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

  const marks: Mark[] = []
  for (const m of t.marks) {
    const at = Date.parse(m.at)
    if (at >= axis.start && at <= axis.end) marks.push({ mark: m, left: share(axis, at) })
  }
  const bands: Band[] = []
  t.blockedStretches.forEach((b, i) => {
    const seg = place({ start: Date.parse(b.start), end: Date.parse(b.end) }, axis)
    if (seg) bands.push({ key: `blocked-${i}`, start: Date.parse(b.start), end: Date.parse(b.end), seg })
  })
  // The creation mark: from the ticket's first event (its creation) to its first agent event, drawn at the
  // creation's place on the axis, and on the left edge only when the creation is before the window.
  const agentAt = agentStarts(t)
  const createdAt = t.start ? Date.parse(t.start) : null
  const lead = createdAt !== null && agentAt.length ? Math.floor((Math.min(...agentAt) - createdAt) / MIN) : 0
  const createdShare = createdAt === null ? 0 : share(axis, createdAt)
  return {
    axis,
    live,
    now,
    rows,
    marks,
    bands,
    created:
      createdAt !== null && lead >= 1 && createdShare <= 1
        ? { minutes: lead, left: Math.max(0, createdShare) }
        : null,
    summary: summarize(t, rows, axis),
  }
}
