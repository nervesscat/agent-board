import { LEASE_TTL_MINUTES, type EventKind, type StageKind } from './constants'
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
  /** On a wait_start: the agent the work was handed to; null or left out when none was named. */
  on?: string | null
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
  /** The agent the wait hands the work to (a delegated wait, counted as working); null when none. */
  on: string | null
  note: string
  start: string
  end: string
  open: boolean
}
export type TimelineHandoff = { id: number; at: string; from: string; to: string; note: string }
export type TimelineMark = { id: number; kind: EventKind; at: string; note: string }
export type WorkTotals = { workingMs: number; waitingMs: number; blockedOnHumanMs: number }
/** The latest agent event (heartbeats included): when, who, what it was and what it said. */
export type LastHeard = {
  at: string
  agent: string
  by: string
  kind: EventKind
  phase: string
  reason: string
  note: string
}
/** A span that has ended: its phase, who worked it, and when it started and ended. */
export type ClosedSpan = { phase: string; agent: string; start: string; end: string }
/**
 * What a ticket is doing now, for a list row or the Overview: its open spans (phase, agent, since), its
 * open waits (reason, agent, `on`, since) and who was last heard from. `lastClosedSpan` is the span that
 * ended last (null when none has), so a stall with nothing open says when the work stopped; `now` is the
 * server's time when the read was made, which the browser's clock is corrected by.
 */
export type Activity = {
  spans: { phase: string; agent: string; since: string }[]
  waits: { reason: string; agent: string; on: string | null; since: string }[]
  lastHeard: LastHeard | null
  lastClosedSpan?: ClosedSpan | null
  now?: string
  /** The ticket's state and per-agent facts, when it has one (see Liveness). */
  liveness?: Liveness | null
}
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

/**
 * What a ticket (or lane) is doing, from its lease, its open spans and why it waits on the human:
 * `waiting` (the human's turn), `working` (a live lease, or a span younger than the TTL), `lost` (the
 * lease expired with a span still open: the agent is gone), `stalled` (nothing open, silence past the
 * project's `stallMinutes`) and the neutral `idle` in the gap between the TTL and `stallMinutes`.
 */
export type LivenessState = 'waiting' | 'working' | 'lost' | 'stalled' | 'idle'
/** One open span as the state reports it: who works it, since when, and when that agent last spoke. */
export type LivenessSpan = {
  phase: string
  agent: string
  since: string
  /** That agent's latest event or post; the ticket's latest when that agent never spoke. */
  lastWordAt: string | null
  /** Whole minutes since `lastWordAt` (or the lease's clock when it is null). */
  silentMinutes: number
}
/**
 * A ticket's state and the per-agent facts behind it: the state word, the open span it reads from
 * (agent, phase, since), the lease's clock (`lastSignalAt`), the agent's last word and how long ago,
 * in whole minutes, and every open span with its own agent and last word.
 */
export type Liveness = {
  state: LivenessState
  agent: string
  phase: string
  since: string
  lastSignalAt: string
  lastWordAt: string | null
  silentMinutes: number
  spans: LivenessSpan[]
}

export type WorkTimeline = {
  /** The server's time when the timeline was read: the browser's clock is corrected by it (see useServerOffset). */
  now: string
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
  /** The latest agent event or agent post: when the agent last said something. */
  lastWordAt: string | null
  /** Null for a ticket that cannot have a state: not in an active stage, archived, or a PR's own ticket. */
  liveness: Liveness | null
  stalled: Stalled | null
  lastHeard: LastHeard | null
}

/** A post on the ticket as the lease reads it: when it was written, by whom, and whether a human wrote it. */
export type TimelinePost = { at: string; agent: string; human: boolean }

/** What the timeline needs of the ticket itself. */
export type TimelineTicket = {
  status: string
  archivedAt: string | null
  prId: number | null
  assignee: string
  createdAt: string
  startedAt: string | null
  /** The ticket it is a lane of; kept out of the timeline's own reads, the server uses it for waits. */
  parentId?: number | null
}

export type TimelineOptions = {
  now: Date | number
  /** The project's stages (key and kind): what a status and a stage event's stage mean. */
  stages: { key: string; kind: StageKind }[]
  ticket: TimelineTicket
  stallMinutes: number
  /** Its posts: an agent's refreshes the lease, a human's proves a person spoke, not that the run is alive. */
  posts?: TimelinePost[]
  /** Why it waits on the human outside its events: an undecided decision card, or a blocked next step. */
  waiting?: { decision?: boolean; blockedTask?: boolean }
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
      waits.push({
        id: e.id,
        reason: e.reason,
        agent: e.agent,
        on: e.on ?? null,
        note: e.note,
        start: e.at,
        ...endOf(e),
      })
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
  // A delegated wait (`on` named) is work handed to another agent: it counts as working, like a span.
  const delegated = waits.filter((w) => w.on).map(interval)
  const sums = totals(
    [...spans.map(interval), ...delegated],
    waits.map((w) => ({ interval: interval(w), reason: w.reason })),
    blockedStretches.map(interval),
  )

  // Who was last heard from: any event but the board's own. A worker's event under the name 'board'
  // counts (it is a claim, shown with who recorded it), as it counts for the lease clock below.
  const lastEvent = [...sorted].reverse().find((e) => e.agent && !isBoardRecord(e.agent, e.by))
  const lastAgent = lastEvent?.agent ?? o.ticket.assignee
  const lastBy = lastEvent?.by ?? ''
  const lastFrom: Stalled['lastFrom'] = lastEvent ? 'event' : 'assignee'
  const lastHeard: LastHeard | null = lastEvent
    ? {
        at: lastEvent.at,
        agent: lastEvent.agent,
        by: lastEvent.by,
        kind: lastEvent.kind,
        phase: lastEvent.phase,
        reason: lastEvent.reason,
        note: lastEvent.note,
      }
    : null

  // The lease's clock: the latest event of any kind, an agent's post, the ticket's start or creation.
  // A human's post is not a signal: it proves a person spoke, not that the run is alive.
  const posts = o.posts ?? []
  const agentPosts = posts.filter((p) => !p.human)
  const lastPostAt = agentPosts.length ? latest(...agentPosts.map((p) => p.at)) : null
  const lastSignalAt = latest(o.ticket.createdAt, o.ticket.startedAt, last?.at, lastPostAt)
  const lastWordAt = lastEvent || lastPostAt ? latest(lastEvent?.at, lastPostAt) : null
  const silence = (signal: string | null) =>
    signal ? Math.max(0, Math.floor((now - Date.parse(signal)) / 60_000)) : 0

  const waitingOnHuman = waits.some((w) => w.open && w.reason === 'human')
  const waitingByFacts = waitingOnHuman || !!o.waiting?.decision || !!o.waiting?.blockedTask
  const stateful = ticketKind === 'active' && !o.ticket.archivedAt && o.ticket.prId === null
  const openSpans = spans.filter((s) => s.open)
  const ttlMs = LEASE_TTL_MINUTES * 60_000
  const leaseLive = now - Date.parse(lastSignalAt) <= ttlMs
  const spanYounger = openSpans.some((s) => now - Date.parse(s.start) <= ttlMs)
  // With nothing open the silence rule decides first: a stall threshold under the lease is the human's
  // dial, and the lease must not hide it. An open span keeps reading working (a live lease or a young
  // one) or lost (the lease ran out while it ran), never stalled.
  const state: LivenessState = waitingByFacts
    ? 'waiting'
    : openSpans.length
      ? leaseLive || spanYounger
        ? 'working'
        : 'lost'
      : now - Date.parse(lastSignalAt) > o.stallMinutes * 60_000
        ? 'stalled'
        : leaseLive
          ? 'working'
          : 'idle'
  const latestSpan = openSpans.reduce<TimelineSpan | null>(
    (a, b) => (!a || Date.parse(b.start) >= Date.parse(a.start) ? b : a),
    null,
  )
  const wordOf = (agent: string): string | null => {
    const ownEvent = [...sorted].reverse().find((e) => e.agent === agent && !isBoardRecord(e.agent, e.by))
    const ownPost = agentPosts.filter((p) => p.agent === agent).at(-1)
    if (!ownEvent && !ownPost) return lastWordAt
    return latest(ownEvent?.at, ownPost?.at)
  }
  const liveness: Liveness | null = stateful
    ? {
        state,
        agent: latestSpan?.agent ?? lastAgent,
        phase: latestSpan?.phase ?? lastEvent?.phase ?? '',
        since:
          state === 'waiting'
            ? (waits.find((w) => w.open && w.reason === 'human')?.start ?? lastSignalAt)
            : (latestSpan?.start ?? lastSignalAt),
        lastSignalAt,
        lastWordAt,
        silentMinutes: silence(lastWordAt ?? lastSignalAt),
        spans: openSpans.map((s) => {
          const word = wordOf(s.agent)
          return {
            phase: s.phase,
            agent: s.agent,
            since: s.start,
            lastWordAt: word,
            silentMinutes: silence(word),
          }
        }),
      }
    : null
  const stalledNow = stateful && state === 'stalled'
  return {
    now: iso(now),
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
    lastWordAt,
    liveness,
    stalled: stalledNow
      ? {
          since: lastSignalAt,
          minutes: silence(lastSignalAt),
          lastAgent,
          lastBy,
          lastFrom,
        }
      : null,
    lastHeard,
  }
}

/** A timeline's activity: its open spans and waits, who was last heard from, and the span that ended last. */
export function activityOf(timeline: WorkTimeline): Activity {
  const closed = timeline.spans
    .filter((s) => !s.open)
    .sort((a, b) => Date.parse(b.end) - Date.parse(a.end))[0]
  return {
    spans: timeline.spans
      .filter((s) => s.open)
      .map((s) => ({ phase: s.phase, agent: s.agent, since: s.start })),
    waits: timeline.waits
      .filter((w) => w.open)
      .map((w) => ({ reason: w.reason, agent: w.agent, on: w.on, since: w.start })),
    lastHeard: timeline.lastHeard,
    lastClosedSpan: closed
      ? { phase: closed.phase, agent: closed.agent, start: closed.start, end: closed.end }
      : null,
    now: timeline.now,
    liveness: timeline.liveness,
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
