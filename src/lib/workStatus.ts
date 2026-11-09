import type { Stalled, TimelineSpan, TimelineWait, WorkTimeline, WorkTotals } from './workTimeline'

/**
 * The short answers every place that shows a ticket's work gives: what is going on now, who was heard
 * from last and when, why a ticket is stalled, and how its time splits. Pure, so the components and
 * their tests read the same answers from the same timeline.
 */

/** What the answers read of a work timeline: its spans, waits, totals, stall and last agent event. */
export type WorkTimelineLike = Pick<
  WorkTimeline,
  'spans' | 'waits' | 'totals' | 'stalled' | 'live' | 'end' | 'start' | 'lastHeard'
>

/** The agent a wait is delegated to ('' when none). */
const waitOn = (w: TimelineWait): string => w.on ?? ''

const GERUND: Record<string, string> = {
  spec: 'Specifying',
  build: 'Building',
  review: 'Reviewing',
  verify: 'Verifying',
  pr: 'Opening PR',
  preview: 'Previewing',
  merge: 'Merging',
}

const ms = (iso: string) => Date.parse(iso)
const latestFirst = <T extends { start: string }>(xs: T[]) =>
  [...xs].sort((a, b) => ms(b.start) - ms(a.start))

export type CurrentActivity =
  | { kind: 'building'; verb: string; phase: string; agent: string; since: string; ms: number }
  | { kind: 'waiting-agent'; agent: string; reason: string; since: string; ms: number }
  | { kind: 'waiting-human'; reason: string; since: string }
  | { kind: 'nothing' }

/**
 * What is going on now, from the open spans and open waits of a live ticket. A human wait comes first
 * (the earliest one, the longest). A wait delegated to an agent reads as that agent building, not as a
 * wait; then the latest open span; then any other open wait. A ticket that is not live has nothing open.
 */
export function currentActivity(t: WorkTimelineLike, now: Date | number): CurrentActivity {
  if (!t.live) return { kind: 'nothing' }
  const n = +now
  const open = t.waits.filter((w) => w.open)
  const human = open.filter((w) => w.reason === 'human' && !waitOn(w))
  if (human.length) {
    const first = human.reduce((a, b) => (ms(b.start) < ms(a.start) ? b : a))
    return { kind: 'waiting-human', reason: first.reason, since: first.start }
  }
  const openSpans = t.spans.filter((s) => s.open)
  const delegated = latestFirst(open.filter((w) => waitOn(w)))
  if (delegated.length) {
    const w = delegated[0]!
    const enclosing = latestFirst(openSpans.filter((s) => ms(s.start) <= ms(w.start)))[0]
    const phase = enclosing?.phase ?? ''
    return {
      kind: 'building',
      verb: GERUND[phase] ?? 'Working',
      phase,
      agent: waitOn(w),
      since: w.start,
      ms: n - ms(w.start),
    }
  }
  const span = latestFirst(openSpans)[0]
  if (span)
    return {
      kind: 'building',
      verb: GERUND[span.phase] ?? 'Working',
      phase: span.phase,
      agent: span.agent,
      since: span.start,
      ms: n - ms(span.start),
    }
  const other = latestFirst(open)[0]
  if (other)
    return {
      kind: 'waiting-agent',
      agent: waitTarget(other),
      reason: other.reason,
      since: other.start,
      ms: n - ms(other.start),
    }
  return { kind: 'nothing' }
}

/** Who a wait is on: its delegate when it has one, else the agent it names. */
const waitTarget = (w: TimelineWait) => waitOn(w) || w.agent

export type LastHeardLine = {
  at: string
  /** The agent heard from ('' when the event named none: the line then gives the time only). */
  agent: string
  by: string
  /** What it said: its note, else its reason, else its phase. */
  summary: string
}

/** The last agent event as a line, or null when no agent has been heard from on the ticket. */
export function lastHeard(t: WorkTimelineLike): LastHeardLine | null {
  const h = t.lastHeard
  if (!h) return null
  return { at: h.at, agent: h.agent, by: h.by, summary: h.note || h.reason || h.phase }
}

export type StallReason =
  /** Nothing is open; the last closed span (if any) ended at `endedAt`. `quote` is what that event said. */
  | {
      kind: 'nothing-open'
      since: string
      endedAt: string | null
      phase: string
      quote: string
      stage: string | null
    }
  /** A wait is open on an agent (`on`) and nobody has been heard from since. */
  | { kind: 'waiting'; on: string; reason: string; since: string; stage: string | null }
  /** A span is open, its agent silent since `since`. */
  | { kind: 'working'; agent: string; phase: string; since: string; stage: string | null }

/**
 * Why a stalled ticket is stalled, or null when it is not. An open wait is the answer when there is
 * one, else an open span, else nothing is open and the last closed span says when the work stopped.
 * `stage` is the name of the active stage when it is not the project's default one (else null).
 */
export function stallReason(t: WorkTimelineLike, stage: string | null = null): StallReason | null {
  const s: Stalled | null = t.stalled
  if (!s) return null
  const since = s.since
  const open = latestFirst(t.waits.filter((w) => w.open))[0]
  if (open) return { kind: 'waiting', on: waitTarget(open), reason: open.reason, since, stage }
  const span = latestFirst(t.spans.filter((x) => x.open))[0]
  if (span) return { kind: 'working', agent: span.agent, phase: span.phase, since, stage }
  const closed = t.spans.filter((x: TimelineSpan) => !x.open).sort((a, b) => ms(b.end) - ms(a.end))[0]
  const h = t.lastHeard
  const quote = closed && h && h.at === closed.end ? h.reason : ''
  return {
    kind: 'nothing-open',
    since,
    endedAt: closed?.end ?? null,
    phase: closed?.phase ?? '',
    quote,
    stage,
  }
}

export type WorkShares = {
  total: number
  /** Each part as a whole percentage of the total, 0 when the total is 0. */
  worked: number
  waited: number
  onYou: number
}

/** The three totals as shares of their sum, for a proportion bar. */
export function workShares(totals: WorkTotals): WorkShares {
  const total = totals.workingMs + totals.waitingMs + totals.blockedOnHumanMs
  const pct = (v: number) => (total > 0 ? (v / total) * 100 : 0)
  return {
    total,
    worked: pct(totals.workingMs),
    waited: pct(totals.waitingMs),
    onYou: pct(totals.blockedOnHumanMs),
  }
}
