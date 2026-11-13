import { Hammer, Hourglass, UserRound } from 'lucide-react'

import { spokenDuration } from '#/components/WorkTimeline'
import { Tip } from '#/components/ui/tooltip'
import { clock } from '#/lib/format'
import { useNow, useServerOffset } from '#/lib/useNow'
import {
  lastHeard,
  onServerClock,
  workLine,
  workShares,
  type WorkLineState,
  type WorkTimelineLike,
} from '#/lib/workStatus'
import type { WorkTotals as Totals } from '#/lib/workTimeline'

/** A duration in words for the summary: `43 min`, `1 h 5 min`; `0` for none. */
const dur = (ms: number) => (ms > 0 ? spokenDuration(ms) : '0')

/** The colour and weight of a state's one line: the words carry the state, the tone agrees with it. */
const STATE_TONE: Record<WorkLineState, string> = {
  working: 'text-foreground',
  'no-word': 'text-amber-800 dark:text-amber-300',
  quiet: 'text-amber-800 dark:text-amber-300',
  'your-turn': 'text-amber-800 dark:text-amber-300',
  waiting: 'text-amber-800 dark:text-amber-300',
  lost: 'text-rose-800 dark:text-rose-300',
  nothing: 'text-muted-foreground',
}

/**
 * One ticket's work-state line: the one answer to what it is doing now, in the human's words. One element
 * per ticket row (`data-testid="work-line"`, `data-state` one of the seven), its tooltip the why, and the
 * per-agent detail under it where the surface has room. The clock correction to the server's happens once,
 * inside: a caller passes the server's own time or nothing, never a time already put on it.
 */
export function WorkLine({
  timeline,
  now,
  stage = null,
  variant = 'inline',
  detail = false,
  tooltip = true,
  focusable = true,
  className = '',
}: {
  timeline: WorkTimelineLike
  /** The server's clock, when the caller already put `now` on it; omitted, the browser's, corrected once. */
  now?: Date | number
  /** The active stage's name when it is not the project's default one: the why then names it. */
  stage?: string | null
  /** `badge` for a card or a list row, `inline` for a line. */
  variant?: 'inline' | 'badge'
  /** Draw the per-agent lines under the word: the ticket page, In progress and the Roadmap have room. */
  detail?: boolean
  tooltip?: boolean
  focusable?: boolean
  className?: string
}) {
  const tick = useNow(60_000)
  const offset = useServerOffset(timeline.now)
  const at = now === undefined ? onServerClock(tick, offset) : +now
  const line = workLine(timeline, at, stage)
  if (!line) return null
  const why = [line.why, ...line.detail].filter(Boolean).join('\n')
  const base =
    variant === 'badge'
      ? 'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] leading-none font-medium tabular-nums'
      : 'text-sm font-medium tabular-nums'
  const word = (
    <span
      data-testid="work-line"
      data-state={line.state}
      tabIndex={tooltip && focusable ? 0 : undefined}
      className={`${base} ${STATE_TONE[line.state]} ${variant === 'badge' ? 'outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring' : ''}`}
    >
      {line.text}
    </span>
  )
  const shown = tooltip && why ? <Tip content={why}>{word}</Tip> : word
  if (!detail || !line.detail.length) return <span className={className}>{shown}</span>
  return (
    <div className={`${className} grid gap-0.5`}>
      <div>{shown}</div>
      {line.detail.map((d) => (
        <p key={d} className="text-xs text-muted-foreground tabular-nums">
          {d}
        </p>
      ))}
    </div>
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
