import {
  Activity,
  CircleDashed,
  ClockAlert,
  Eye,
  Hammer,
  Hand,
  Hourglass,
  type LucideIcon,
  Moon,
  Unplug,
  UserRound,
} from 'lucide-react'
import { useState } from 'react'

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

/**
 * Each state's icon and its colour. The shape carries the state; the colour only agrees with it, so no state is told by colour
 * alone. `lost` (an unplugged cable) and `no-word` (a clock with an alert) are told apart by shape too.
 */
export const WORK_STATE_ICON: Record<WorkLineState, { Icon: LucideIcon; tone: string }> = {
  waiting: { Icon: Hand, tone: 'text-amber-700 dark:text-amber-400' },
  'your-turn': { Icon: Eye, tone: 'text-violet-700 dark:text-violet-400' },
  lost: { Icon: Unplug, tone: 'text-rose-700 dark:text-rose-400' },
  'no-word': { Icon: ClockAlert, tone: 'text-orange-700 dark:text-orange-400' },
  quiet: { Icon: Moon, tone: 'text-muted-foreground' },
  working: { Icon: Activity, tone: 'text-emerald-700 dark:text-emerald-400' },
  nothing: { Icon: CircleDashed, tone: 'text-muted-foreground' },
}

/** The duration a line ends with (`40m`, `2d`), which a surface with room keeps beside the icon. */
const measureOf = (text: string) => text.match(/(\d+[mhd])$/)?.[1] ?? ''

/**
 * One ticket's work-state line, as its state's icon: one element per ticket row (`data-testid="work-line"`,
 * `data-state` one of the seven). Its accessible name is the line's text, and its tooltip the full line,
 * the per-agent detail and the why, opened by focus, hover or a tap. A state with nothing to add to its
 * line has no tooltip and is not a keyboard stop. The clock correction to the server's happens once,
 * inside: a caller passes the server's own time or nothing, never a time already put on it.
 */
export function WorkLine({
  timeline,
  now,
  stage = null,
  variant = 'inline',
  detail = false,
  tooltip = true,
  className = '',
}: {
  timeline: WorkTimelineLike
  /** The server's clock, when the caller already put `now` on it; omitted, the browser's, corrected once. */
  now?: Date | number
  /** The active stage's name when it is not the project's default one: the why then names it. */
  stage?: string | null
  /** `badge` for a card or a list row (the icon alone), `inline` for a line (the icon and its duration). */
  variant?: 'inline' | 'badge'
  /** Draw the per-agent lines under the icon: the ticket page, In progress and the Roadmap have room. */
  detail?: boolean
  /** Off, the icon has no tooltip and is not a keyboard stop. */
  tooltip?: boolean
  className?: string
}) {
  const tick = useNow(60_000)
  const offset = useServerOffset(timeline.now)
  const [open, setOpen] = useState(false)
  const at = now === undefined ? onServerClock(tick, offset) : +now
  const line = workLine(timeline, at, stage)
  if (!line) return null
  // The line's why already carries the per-agent detail where it has nothing else to say (a working or
  // a lost run); a state whose why says something else (a stall, a quiet day) keeps the detail beside
  // it. Either way the detail is in the tooltip once, and on screen once where the surface has room.
  const why = [line.why, ...line.detail.filter((d) => !line.why.includes(d))].filter(Boolean).join('\n')
  const tipped = tooltip
  const { Icon, tone } = WORK_STATE_ICON[line.state]
  const measure = variant === 'inline' ? measureOf(line.text) : ''
  const icon = (
    <span
      role="img"
      aria-label={line.text}
      data-testid="work-line"
      data-state={line.state}
      // Every state's icon is a keyboard stop: focus opens its tooltip, the full line and what it adds.
      tabIndex={tipped ? 0 : undefined}
      // Hover does not exist on a touch screen: a tap opens the tooltip there.
      onPointerUp={(e) => {
        if (tipped && e.pointerType === 'touch') setOpen(true)
      }}
      className={`rounded-sm text-sm font-medium tabular-nums outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring ${tone}`}
    >
      <Icon
        aria-hidden
        className={`inline-block size-4 align-[-0.125em] ${line.state === 'working' ? 'motion-safe:animate-pulse' : ''}`}
      />
      {measure && <span className="ml-1">{measure}</span>}
    </span>
  )
  const shown = tipped ? (
    <Tip content={[line.text, why].filter(Boolean).join('\n')} open={open} onOpenChange={setOpen} keepOnClick>
      {icon}
    </Tip>
  ) : (
    icon
  )
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
