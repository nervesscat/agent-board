import type { Stalled } from '#/lib/workTimeline'

/**
 * A stall from the summary's fields, with its minutes counted up to now on the server's clock: the
 * summary carries the moment, the page counts up to now. How the stall reads (its notice, its why) is
 * `StallNotice` in WorkStatus.
 */

/**
 * Whole minutes since `since`, counted on the server's clock: `now` is the browser's time corrected by
 * the offset measured from the summary's `generatedAt`, as the ticket page counts its stall. Never negative.
 */
const silentMinutes = (since: string, now: number) =>
  Math.max(0, Math.floor((now - Date.parse(since)) / 60_000))

export function stallFor(
  s: {
    lastSignalAt: string
    lastAgent: string
    lastBy: string
    lastFrom: Stalled['lastFrom']
  },
  now: number,
): Stalled {
  return {
    since: s.lastSignalAt,
    minutes: silentMinutes(s.lastSignalAt, now),
    lastAgent: s.lastAgent,
    lastBy: s.lastBy,
    lastFrom: s.lastFrom,
  }
}
