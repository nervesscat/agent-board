import { AlertTriangle } from 'lucide-react'

import { Tip } from '#/components/ui/tooltip'
import { clock } from '#/lib/format'
import { formatDuration, type Stalled, type WorkTotals as Totals } from '#/lib/workTimeline'

/** Working, waiting and blocked-on-human time, as one line. */
export function WorkTotals({ totals, className = '' }: { totals: Totals; className?: string }) {
  return (
    <p aria-label="Totals" className={`text-xs text-muted-foreground tabular-nums ${className}`}>
      Working <b className="font-medium text-foreground">{formatDuration(totals.workingMs)}</b> · Waiting{' '}
      <b className="font-medium text-foreground">{formatDuration(totals.waitingMs)}</b> · Blocked on human{' '}
      <b className="font-medium text-foreground">{formatDuration(totals.blockedOnHumanMs)}</b>
    </p>
  )
}

/**
 * The amber warning on a ticket nobody was heard from on for longer than its project allows. It takes
 * the keyboard for its tooltip, unless it sits inside a link or a button (`focusable` false).
 */
export function StalledBadge({
  stalled,
  focusable = true,
  className = '',
}: {
  stalled: Stalled | null | undefined
  focusable?: boolean
  className?: string
}) {
  if (!stalled) return null
  const tip = `No heartbeat or event since ${clock(stalled.since)}${stalled.lastAgent ? ` (${stalled.lastAgent})` : ''}`
  return (
    <Tip content={tip}>
      <span
        tabIndex={focusable ? 0 : undefined}
        data-testid="stalled"
        className={`${className} inline-flex shrink-0 items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring dark:bg-amber-400/15 dark:text-amber-300`}
      >
        <AlertTriangle className="size-3" aria-hidden />
        Stalled {formatDuration(stalled.minutes * 60_000)}
      </span>
    </Tip>
  )
}
