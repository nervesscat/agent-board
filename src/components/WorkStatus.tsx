import { AlertTriangle, Hammer, Hourglass, UserRound } from 'lucide-react'

import { spokenDuration } from '#/components/WorkTimeline'
import { Tip } from '#/components/ui/tooltip'
import { clock } from '#/lib/format'
import { useNow } from '#/lib/useNow'
import {
  currentActivity,
  lastHeard,
  stallReason,
  workShares,
  type StallReason,
  type WorkTimelineLike,
} from '#/lib/workStatus'
import type { WorkTotals as Totals } from '#/lib/workTimeline'

/** A duration in words for the status lines: `43 min`, `1 h 5 min`; `0` for none. */
const dur = (ms: number) => (ms > 0 ? spokenDuration(ms) : '0')

/** What is going on now, as one line, from the open spans and waits. `now` defaults to a live clock. */
export function NowLine({
  timeline,
  now,
  className = '',
}: {
  timeline: WorkTimelineLike
  now?: Date | number
  className?: string
}) {
  const tick = useNow(60_000)
  const a = currentActivity(timeline, now ?? tick)
  const base = `${className} text-sm tabular-nums`
  if (a.kind === 'building')
    return (
      <p data-testid="now-line" className={`${base} text-foreground`}>
        <span className="font-medium">{a.verb}</span> · {a.agent} · {dur(a.ms)}
      </p>
    )
  if (a.kind === 'waiting-agent')
    return (
      <p data-testid="now-line" className={`${base} text-foreground`}>
        <Hourglass className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />
        <span className="font-medium">Waiting on {a.agent}</span> · {dur(a.ms)}
      </p>
    )
  if (a.kind === 'waiting-human')
    return (
      <p data-testid="now-line" className={`${base} font-medium text-amber-800 dark:text-amber-300`}>
        <UserRound className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />
        Waiting on you since {clock(a.since)}
      </p>
    )
  return (
    <p data-testid="now-line" className={`${base} text-muted-foreground`}>
      Nothing open
    </p>
  )
}

/** The last agent heard from and when, as one line; the time alone when the event named no agent. */
export function LastHeard({ timeline, className = '' }: { timeline: WorkTimelineLike; className?: string }) {
  const h = lastHeard(timeline)
  if (!h)
    return (
      <p data-testid="last-heard" className={`${className} text-xs text-muted-foreground`}>
        Nobody heard from yet
      </p>
    )
  const who = h.agent ? ` · ${h.agent}${h.summary ? `: ${h.summary}` : ''}` : ''
  return (
    <p data-testid="last-heard" className={`${className} text-xs text-muted-foreground tabular-nums`}>
      Last heard {clock(h.at)}
      {who}
    </p>
  )
}

/** The why of a stall, in words. The stage, when given, replaces the detail. */
function stallWhy(r: StallReason): string {
  if (r.stage) return `in ${r.stage}, no agent heard from since ${clock(r.since)}`
  if (r.kind === 'waiting') return `waiting on ${r.on}, nobody heard from since ${clock(r.since)}`
  if (r.kind === 'working')
    return `${r.agent} has a ${r.phase || 'span'} open, nobody heard from since ${clock(r.since)}`
  if (!r.endedAt) return `nothing open since ${clock(r.since)}`
  return `nothing open since the ${r.phase || 'work'} ended at ${clock(r.endedAt)}${r.quote ? ` ('${r.quote}')` : ''}`
}

/**
 * A stalled ticket's notice, the same words everywhere: `Stalled 33 min`, and why and since when. As a
 * `badge` for cards and lists (the why in its tooltip), or as an `inline` sentence for a page. `stage`
 * is the active stage's name when it is not the project's default stage; the why then says it.
 */
export function StallNotice({
  timeline,
  stage = null,
  variant = 'badge',
  focusable = true,
  className = '',
}: {
  timeline: WorkTimelineLike
  stage?: string | null
  variant?: 'badge' | 'inline'
  focusable?: boolean
  className?: string
}) {
  const r = stallReason(timeline, stage)
  if (!timeline.stalled || !r) return null
  const head = `Stalled ${spokenDuration(timeline.stalled.minutes * 60_000)}`
  const why = stallWhy(r)
  if (variant === 'inline')
    return (
      <p
        data-testid="stall-notice"
        className={`${className} flex items-start gap-1.5 text-sm font-medium text-amber-800 dark:text-amber-300`}
      >
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0">
          {head}: {why}
        </span>
      </p>
    )
  return (
    <Tip content={why}>
      <span
        tabIndex={focusable ? 0 : undefined}
        data-testid="stall-notice"
        className={`${className} inline-flex shrink-0 items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring dark:bg-amber-400/15 dark:text-amber-300`}
      >
        <AlertTriangle className="size-3" aria-hidden />
        {head}
      </span>
    </Tip>
  )
}

/** Worked, waited and on-you time as one line, with a proportion bar and a tooltip that defines them. */
export function WorkSummary({ totals, className = '' }: { totals: Totals; className?: string }) {
  const s = workShares(totals)
  const onYou = totals.blockedOnHumanMs > 0
  const defs = [
    'Worked: time an agent had work open, not waiting on a person.',
    'Waited: time nothing moved on the ticket and no person was waited on.',
    'On you: time waiting on a person (a human wait, or a blocked stage).',
  ].join('\n')
  return (
    <div className={`${className} grid gap-1`}>
      <Tip content={defs}>
        <span
          tabIndex={0}
          data-testid="work-summary"
          className="inline-flex w-fit flex-wrap items-center gap-x-2 gap-y-0.5 text-xs tabular-nums text-muted-foreground outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
        >
          <span className="inline-flex items-center gap-1">
            <Hammer className="size-3" aria-hidden />
            Worked <b className="font-medium text-foreground">{dur(totals.workingMs)}</b>
          </span>
          <span aria-hidden>·</span>
          <span className="inline-flex items-center gap-1">
            <Hourglass className="size-3" aria-hidden />
            Waited <b className="font-medium text-foreground">{dur(totals.waitingMs)}</b>
          </span>
          <span aria-hidden>·</span>
          <span
            className={`inline-flex items-center gap-1 ${onYou ? 'font-medium text-amber-800 dark:text-amber-300' : ''}`}
          >
            <UserRound className="size-3" aria-hidden />
            On you{' '}
            <b className={`font-medium ${onYou ? '' : 'text-muted-foreground'}`}>
              {dur(totals.blockedOnHumanMs)}
            </b>
          </span>
        </span>
      </Tip>
      <div aria-hidden className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-foreground/70 dark:bg-foreground/60" style={{ width: `${s.worked}%` }} />
        <div
          className="h-full bg-muted-foreground/40"
          style={{ width: `${s.waited}%`, backgroundImage: STRIPES }}
        />
        <div className="h-full bg-amber-600 dark:bg-amber-400" style={{ width: `${s.onYou}%` }} />
      </div>
    </div>
  )
}

/** Diagonal stripes for the waited share of the bar, so it reads apart from the worked share without colour. */
const STRIPES =
  'repeating-linear-gradient(135deg, color-mix(in oklab, currentColor 35%, transparent) 0 2px, transparent 2px 5px)'
