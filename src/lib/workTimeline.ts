import type { EventKind, StageKind } from './constants'
import { isBoardRecord } from './roles'

/**
 * A ticket's work timeline, from its events (src/server/workTimeline.ts): the spans its agents worked,
 * the waits and why, the hand-offs, the board's own marks (push, PR, preview, merge), the time it sat
 * in a blocked stage, and from those the working / waiting / blocked-on-human totals and the stalled
 * flag. Pure, so the server and the client draw and count it the same way.
 */

/** One event as the timeline reads it (a ticket_events row without its ticket and project). */
export type TimelineEvent = {
  id: number
  kind: EventKind
  agent: string
  by: string
  phase: string
  round: number | null
  refId: number | null
  fromAgent: string
  toAgent: string
  reason: string
  note: string
  fromStage: string
  toStage: string
  at: string
}

export type TimelineSpan = {
  id: number
  phase: string
  round: number | null
  agent: string
  by: string
  start: string
  end: string
  open: boolean
}
export type TimelineWait = {
  id: number
  reason: string
  agent: string
  note: string
  start: string
  end: string
  open: boolean
}
export type TimelineHandoff = { id: number; at: string; from: string; to: string; note: string }
export type TimelineMark = { id: number; kind: EventKind; at: string; note: string }
export type WorkTotals = { workingMs: number; waitingMs: number; blockedOnHumanMs: number }
/**
 * Since when an active ticket has been silent, for how many whole minutes, and who was heard from last:
 * `lastAgent` is the name the latest event claims (free text, or the assignee when no agent recorded
 * one), `lastBy` who recorded that event as it signed in ('' for an older event or the assignee), and
 * `lastFrom` where the name came from: 'event' when an event claims it, 'assignee' when none did and it
 * is the ticket's assignee (then nobody signed in recorded it).
 */
export type Stalled = {
  since: string
  minutes: number
  lastAgent: string
  lastBy: string
  lastFrom: 'event' | 'assignee'
}

export type WorkTimeline = {
  /** The first event's time; null while the ticket has none (then `end` is null too). */
  start: string | null
  /** Now while the ticket is live (worked, waiting or in review, not archived), else its last event. */
  end: string | null
  live: boolean
  spans: TimelineSpan[]
  waits: TimelineWait[]
  handoffs: TimelineHandoff[]
  marks: TimelineMark[]
  blockedStretches: { start: string; end: string }[]
  totals: WorkTotals
  lastSignalAt: string
  stalled: Stalled | null
}

/** What the timeline needs of the ticket itself. */
export type TimelineTicket = {
  status: string
  archivedAt: string | null
  prId: number | null
  assignee: string
  createdAt: string
  startedAt: string | null
}

export type TimelineOptions = {
  now: Date | number
  /** The project's stages (key and kind): what a status and a stage event's stage mean. */
  stages: { key: string; kind: StageKind }[]
  ticket: TimelineTicket
  stallMinutes: number
}

/** The kinds of stage a ticket is live in: its open spans and waits run to now there. */
const LIVE_KINDS: readonly StageKind[] = ['active', 'blocked', 'review']

export type Interval = [start: number, end: number]

/** The intervals merged into disjoint ones, in order; empty and inverted ones drop out. */
export function union(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
  const out: Interval[] = []
  for (const [a, b] of sorted) {
    const last = out.at(-1)
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

/** How long the intervals cover together, counting an overlap once. */
export const unionMs = (intervals: Interval[]) => union(intervals).reduce((n, [a, b]) => n + b - a, 0)

/** What of `from` is not covered by `minus`, as disjoint intervals. */
export function subtract(from: Interval[], minus: Interval[]): Interval[] {
  const cut = union(minus)
  const out: Interval[] = []
  for (const [a, b] of union(from)) {
    let at = a
    for (const [c, d] of cut) {
      if (d <= at || c >= b) continue
      if (c > at) out.push([at, c])
      at = Math.max(at, d)
      if (at >= b) break
    }
    if (at < b) out.push([at, b])
  }
  return out
}

/**
 * The three totals, disjoint: blocked-on-human is the human waits and the blocked stretches; working is
 * the spans outside that, whoever's (a sub-agent's span under its orchestrator's wait on it is work);
 * waiting is the other waits outside every span and outside that, the time nothing on the ticket moved.
 */
export function totals(
  spans: Interval[],
  waits: { interval: Interval; reason: string }[],
  blocked: Interval[],
): WorkTotals {
  const human = union([...waits.filter((w) => w.reason === 'human').map((w) => w.interval), ...blocked])
  const working = subtract(spans, human)
  const waiting = subtract(
    subtract(
      waits.filter((w) => w.reason !== 'human').map((w) => w.interval),
      spans,
    ),
    human,
  )
  return {
    workingMs: unionMs(working),
    waitingMs: unionMs(waiting),
    blockedOnHumanMs: unionMs(human),
  }
}

/**
 * The stalled rule: a ticket in an active stage (not archived, not a PR ticket), with no open wait on
 * the human, silent for more than `stallMinutes` since `lastSignalAt`. Exactly at the threshold is not.
 */
export function isStalled(p: {
  kind: StageKind
  archived: boolean
  prTicket: boolean
  waitingOnHuman: boolean
  lastSignalAt: string
  now: Date | number
  stallMinutes: number
}): boolean {
  if (p.kind !== 'active' || p.archived || p.prTicket || p.waitingOnHuman) return false
  return +p.now - Date.parse(p.lastSignalAt) > p.stallMinutes * 60_000
}

const iso = (ms: number) => new Date(ms).toISOString()
const latest = (...times: (string | null | undefined)[]) =>
  times.filter((t): t is string => !!t).reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a))

/** The ticket's timeline from its events, in any order. */
export function buildTimeline(events: TimelineEvent[], o: TimelineOptions): WorkTimeline {
  const now = +o.now
  const sorted = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id - b.id)
  const kindOfKey = (key: string) => o.stages.find((s) => s.key === key)?.kind
  // A status no stage has any more reads as the first stage, as everywhere on the board.
  const ticketKind = kindOfKey(o.ticket.status) ?? o.stages[0]?.kind ?? 'open'
  const live = !o.ticket.archivedAt && LIVE_KINDS.includes(ticketKind)
  const first = sorted[0]
  const last = sorted.at(-1)
  const startMs = first ? Date.parse(first.at) : null
  const endMs = last ? (live ? Math.max(now, Date.parse(last.at)) : Date.parse(last.at)) : null
  const clip = (a: number, b: number): Interval => [Math.max(a, startMs ?? a), Math.min(b, endMs ?? b)]

  const ends = new Map<number, TimelineEvent>()
  for (const e of sorted)
    if ((e.kind === 'span_end' || e.kind === 'wait_end') && e.refId !== null && !ends.has(e.refId))
      ends.set(e.refId, e)
  const endOf = (e: TimelineEvent) => {
    const closed = ends.get(e.id)
    return { end: closed ? closed.at : iso(endMs ?? Date.parse(e.at)), open: !closed }
  }

  const spans: TimelineSpan[] = []
  const waits: TimelineWait[] = []
  const handoffs: TimelineHandoff[] = []
  const marks: TimelineMark[] = []
  const stageMoves: TimelineEvent[] = []
  for (const e of sorted) {
    if (e.kind === 'span_start')
      spans.push({
        id: e.id,
        phase: e.phase,
        round: e.round,
        agent: e.agent,
        by: e.by,
        start: e.at,
        ...endOf(e),
      })
    else if (e.kind === 'wait_start')
      waits.push({ id: e.id, reason: e.reason, agent: e.agent, note: e.note, start: e.at, ...endOf(e) })
    else if (e.kind === 'handoff')
      handoffs.push({ id: e.id, at: e.at, from: e.fromAgent, to: e.toAgent, note: e.note })
    else if (e.kind === 'stage') stageMoves.push(e)
    else if (e.kind === 'push' || e.kind === 'pr' || e.kind === 'preview' || e.kind === 'merge')
      marks.push({ id: e.id, kind: e.kind, at: e.at, note: e.note })
  }

  // In a blocked-kind stage from the move into it to the next move (or the end); a stage the project
  // no longer has is not blocked, and nothing before the first recorded move counts.
  const blockedStretches = stageMoves.flatMap((e, i) => {
    if (kindOfKey(e.toStage) !== 'blocked' || endMs === null) return []
    const next = stageMoves[i + 1]
    const b = next ? Date.parse(next.at) : endMs
    return b > Date.parse(e.at) ? [{ start: e.at, end: iso(b) }] : []
  })

  const interval = (s: { start: string; end: string }) => clip(Date.parse(s.start), Date.parse(s.end))
  const sums = totals(
    spans.map(interval),
    waits.map((w) => ({ interval: interval(w), reason: w.reason })),
    blockedStretches.map(interval),
  )

  const lastSignalAt = latest(o.ticket.createdAt, o.ticket.startedAt, last?.at)
  const stalledNow = isStalled({
    kind: ticketKind,
    archived: !!o.ticket.archivedAt,
    prTicket: o.ticket.prId !== null,
    waitingOnHuman: waits.some((w) => w.open && w.reason === 'human'),
    lastSignalAt,
    now,
    stallMinutes: o.stallMinutes,
  })
  // Who was last heard from: any event but the board's own. A worker's event under the name 'board'
  // counts (it is a claim, shown with who recorded it), as it counts for the stall clock above.
  const lastEvent = [...sorted].reverse().find((e) => e.agent && !isBoardRecord(e.agent, e.by))
  const lastAgent = lastEvent?.agent ?? o.ticket.assignee
  const lastBy = lastEvent?.by ?? ''
  const lastFrom: Stalled['lastFrom'] = lastEvent ? 'event' : 'assignee'
  return {
    start: startMs === null ? null : iso(startMs),
    end: endMs === null ? null : iso(endMs),
    live,
    spans,
    waits,
    handoffs,
    marks,
    blockedStretches,
    totals: sums,
    lastSignalAt,
    stalled: stalledNow
      ? {
          since: lastSignalAt,
          minutes: Math.floor((now - Date.parse(lastSignalAt)) / 60_000),
          lastAgent,
          lastBy,
          lastFrom,
        }
      : null,
  }
}

/** The totals of many timelines added up. */
export const sumTotals = (all: WorkTotals[]): WorkTotals =>
  all.reduce(
    (s, t) => ({
      workingMs: s.workingMs + t.workingMs,
      waitingMs: s.waitingMs + t.waitingMs,
      blockedOnHumanMs: s.blockedOnHumanMs + t.blockedOnHumanMs,
    }),
    { workingMs: 0, waitingMs: 0, blockedOnHumanMs: 0 },
  )

/** A duration for people: `3h 10m`, `25m`, `40s` under a minute, `0m` for none. */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '0m'
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`
  const minutes = Math.round(ms / 60_000)
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (!h) return `${m}m`
  return m ? `${h}h ${m}m` : `${h}h`
}
