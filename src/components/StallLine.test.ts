import { afterEach, describe, expect, it, vi } from 'vitest'

import { measureOffset, onServerClock } from '#/lib/workStatus'
import { buildTimeline } from '#/lib/workTimeline'

import { stallFor } from './StallLine'

const SINCE = '2026-11-09T11:00:00.000Z'
/** The server's clock when the summary was taken: the ticket has been silent for 43 minutes. */
const SERVER_NOW = Date.parse(SINCE) + 43 * 60_000
/** The browser's clock runs 10 minutes behind the server's. */
const BROWSER_BEHIND = 10 * 60_000

/** The ticket page's stall: the server builds the timeline on its own clock. */
const ticketPageMinutes = () =>
  buildTimeline([], {
    now: SERVER_NOW,
    stages: [{ key: 'in_progress', kind: 'active' }],
    ticket: {
      status: 'in_progress',
      archivedAt: null,
      prId: null,
      assignee: 'builder',
      createdAt: SINCE,
      startedAt: null,
    },
    stallMinutes: 30,
  }).stalled!.minutes

const summaryStall = {
  lastSignalAt: SINCE,
  lastAgent: 'builder',
  lastBy: 'builder',
  lastFrom: 'event' as const,
}

describe('stallFor', () => {
  afterEach(() => vi.restoreAllMocks())

  it("counts the minutes on the server's clock, as the ticket page does, when the browser clock is behind", () => {
    vi.spyOn(Date, 'now').mockReturnValue(SERVER_NOW - BROWSER_BEHIND)
    const now = onServerClock(Date.now(), measureOffset(new Date(SERVER_NOW).toISOString(), Date.now()))

    expect(stallFor(summaryStall, now).minutes).toBe(ticketPageMinutes())
    expect(stallFor(summaryStall, now).minutes).toBe(43)
    // The browser's own clock would read the same silence ten minutes short.
    expect(stallFor(summaryStall, Date.now()).minutes).toBe(33)
  })

  it('never counts negative minutes when the browser clock is ahead', () => {
    vi.spyOn(Date, 'now').mockReturnValue(SERVER_NOW + 10 * 60_000)
    const now = onServerClock(Date.now(), measureOffset(new Date(SERVER_NOW).toISOString(), Date.now()))

    expect(stallFor(summaryStall, now).minutes).toBe(ticketPageMinutes())
    expect(stallFor(summaryStall, now).minutes).toBe(43)
  })
})
