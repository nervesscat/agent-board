import type { Stalled } from '#/lib/workTimeline'

/**
 * A stall from the summary's fields, with its minutes counted up to now: the summary carries the moment,
 * the page counts up to now. How the stall reads (its notice, its why) is `StallNotice` in WorkStatus.
 */

/** Whole minutes since `since`. */
const silentMinutes = (since: string) => Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 60_000))

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
