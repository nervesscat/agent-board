import type {
  Liveness,
  LivenessState,
  Stalled,
  TimelineSpan,
  TimelineWait,
  WorkTimeline,
  WorkTotals,
} from './workTimeline'

/**
 * The short answers every place that shows a ticket's work gives: what is going on now, who was heard
 * from last and when, why a ticket is stalled, and how its time splits. Pure, so the components and
 * their tests read the same answers from the same timeline.
 */

/** What the answers read of a work timeline: its spans, waits, totals, stall and last agent event. */
export type WorkTimelineLike = Pick<
  WorkTimeline,
  'spans' | 'waits' | 'totals' | 'stalled' | 'live' | 'end' | 'start' | 'lastHeard'
> & {
  /** The server's time when the timeline was read (absent for one built from an activity: then no offset). */
  now?: string
  /** The ticket's state and per-agent facts, when the read carried one. */
  liveness?: Liveness | null
}

/**
 * The offset of the server's clock from the browser's, measured when a time the server stamped arrived:
 * the browser's clock runs behind or ahead of it by this much.
 */
export const measureOffset = (serverIso: string, browserAt: number): number =>
  Date.parse(serverIso) - browserAt

/** The browser's `now` moved onto the server's clock by the offset measured for the response. */
export const onServerClock = (browserNow: number, offset: number): number => browserNow + offset

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
  | { kind: 'waiting-human'; reason: string; since: string; ms: number }
  | { kind: 'nothing' }

/**
 * What is going on now, from the open spans and open waits of a live ticket. A human wait comes first
 * (the earliest one, the longest). A wait delegated to an agent reads as that agent building, not as a
 * wait; then the latest open span; then any other open wait. A ticket that is not live has nothing open.
 */
export function currentActivity(t: WorkTimelineLike, now: Date | number): CurrentActivity {
  if (!t.live) return { kind: 'nothing' }
  const n = +now
  // The clock here can run behind the server that stamped the spans: never show negative time.
  const since = (iso: string) => Math.max(0, n - ms(iso))
  const open = t.waits.filter((w) => w.open)
  // A human wait counts as waiting on you even when it names an agent: the totals count it so too.
  const human = open.filter((w) => w.reason === 'human')
  if (human.length) {
    const first = human.reduce((a, b) => (ms(b.start) < ms(a.start) ? b : a))
    return { kind: 'waiting-human', reason: first.reason, since: first.start, ms: since(first.start) }
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
      ms: since(w.start),
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
      ms: since(span.start),
    }
  const other = latestFirst(open)[0]
  if (other)
    return {
      kind: 'waiting-agent',
      agent: waitTarget(other),
      reason: other.reason,
      since: other.start,
      ms: since(other.start),
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

/** The ticket's last word: when the agent last spoke, who, and how many whole minutes ago. */
export type LastWord = { at: string; agent: string; minutes: number }

/**
 * `last word N min ago`: the latest agent event or agent post, counted on the clock the caller gives
 * (the server's, through `onServerClock`). Null when no agent has said anything on the ticket.
 */
export function lastWord(t: WorkTimelineLike, now: Date | number): LastWord | null {
  const at = t.liveness?.lastWordAt ?? t.lastHeard?.at ?? null
  if (!at) return null
  return {
    at,
    agent: t.liveness?.agent || t.lastHeard?.agent || '',
    minutes: Math.max(0, Math.floor((+now - Date.parse(at)) / 60_000)),
  }
}

/** The ticket's state, when the read carried one (rows may carry the activity's). */
export const livenessOf = (t: WorkTimelineLike): Liveness | null =>
  t.liveness ?? (t as { activity?: { liveness?: Liveness | null } }).activity?.liveness ?? null

/** The verb a phase's line opens with, as the Now line has always said it. */
export const PHASE_VERB: Record<string, string> = {
  spec: 'Specifying',
  build: 'Building',
  review: 'Reviewing',
  verify: 'Verifying',
  pr: 'Opening PR',
  preview: 'Previewing',
  merge: 'Merging',
}

/** Whole minutes between `from` and `now`, never negative. */
export const minutesBetween = (from: string, now: Date | number) =>
  Math.max(0, Math.floor((+now - Date.parse(from)) / 60_000))

/**
 * One line per open span, in the words every surface uses: `Lost contact · claude · build · 46 min ·
 * last word 26 min ago`, or a working span as today's `Building · claude · 43 min` plus its last word.
 */
export function livenessLines(l: Liveness | null | undefined, now: Date | number): string[] {
  if (!l) return []
  return l.spans.map((s) => {
    const word = s.lastWordAt ? `last word ${s.silentMinutes} min ago` : 'no word yet'
    const forSpan = minutesBetween(s.since, now)
    if (l.state === 'lost') return `Lost contact · ${s.agent} · ${s.phase} · ${forSpan} min · ${word}`
    return `${PHASE_VERB[s.phase] ?? 'Working'} · ${s.agent} · ${forSpan} min · ${word}`
  })
}

/** A lost-contact ticket as the notice reads it: the agent, its phase, since when and its last word. */
export type LostContactWhy = {
  agent: string
  phase: string
  since: string
  silentMinutes: number
  lastWordAt: string | null
}

/** Why an agent is lost: its lease expired with a span still open. Null for every other state. */
export function lostContact(t: WorkTimelineLike): LostContactWhy | null {
  const l = livenessOf(t)
  if (l?.state !== 'lost') return null
  return {
    agent: l.agent,
    phase: l.phase,
    since: l.since,
    silentMinutes: l.silentMinutes,
    lastWordAt: l.lastWordAt,
  }
}

/** A state word for the UI: what the ticket's own state is called. */
export const LIVENESS_LABEL: Record<LivenessState, string> = {
  waiting: 'Waiting on you',
  working: 'Working',
  lost: 'Lost contact',
  stalled: 'Stalled',
  idle: 'Nothing open',
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

/**
 * Why a stalled ticket is stalled, or null when it is not. An open wait is the answer when there is
 * one, else nothing is open and the last closed span says when the work stopped. A span is never open
 * on a stalled ticket any more: an expired lease with a span open reads as Lost contact (see
 * `lostContact`). `stage` is the name of the active stage when it is not the project's default one.
 */
export function stallReason(t: WorkTimelineLike, stage: string | null = null): StallReason | null {
  const s: Stalled | null = t.stalled
  if (!s) return null
  const since = s.since
  const open = latestFirst(t.waits.filter((w) => w.open))[0]
  if (open) return { kind: 'waiting', on: waitTarget(open), reason: open.reason, since, stage }
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
