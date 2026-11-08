import type { ReactNode } from 'react'

import { StalledBadge } from '#/components/WorkStatus'
import { clock } from '#/lib/format'
import { formatDuration, type Stalled } from '#/lib/workTimeline'

/**
 * The stall, worded once for every surface that shows it: the badge on a card, a list row or In progress
 * (`StallBadge` in WorkStatus) and the sentence on a Needs you row (`StallNotice`), with the same
 * "Stalled 40m" and "no heartbeat or event since" words as the ticket page.
 */

/** Whole minutes since `since`: the summary carries the moment, the page counts up to now. */
const silentMinutes = (since: string) => Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 60_000))

/** A stall from the summary's fields, with its minutes counted up to now. */
export function stallFor(s: {
  lastSignalAt: string
  lastAgent: string
  lastBy: string
  lastFrom: Stalled['lastFrom']
}): Stalled {
  return {
    since: s.lastSignalAt,
    minutes: silentMinutes(s.lastSignalAt),
    lastAgent: s.lastAgent,
    lastBy: s.lastBy,
    lastFrom: s.lastFrom,
  }
}

/** The stall in a sentence: what it is, since when, and who was last heard from (`who`, as the row names them). */
export function StallNotice({ stalled, who }: { stalled: Stalled; who?: ReactNode }) {
  return (
    <span data-testid="stall-notice" className="min-w-0">
      <span className="font-medium text-amber-800 dark:text-amber-300">
        Stalled {formatDuration(stalled.minutes * 60_000)}
      </span>
      : no heartbeat or event since {clock(stalled.since)}
      {who && (
        <>
          {' · last '}
          {who}
        </>
      )}
    </span>
  )
}

export { StalledBadge as StallBadge }
