import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { timelineFromActivity } from '#/lib/activityTimeline'
import { clock } from '#/lib/format'
import type { WorkTimelineLike } from '#/lib/workStatus'
import type { Liveness, Stalled, WorkTotals } from '#/lib/workTimeline'

import { LastHeard, WorkLine, WorkSummary } from './WorkStatus'

const at = (hhmm: string) => `2026-10-20T${hhmm}:00.000Z`
const NOW = Date.parse(at('12:30'))
const ZERO: WorkTotals = { workingMs: 0, waitingMs: 0, blockedOnHumanMs: 0 }

const timeline = (more: Partial<WorkTimelineLike> = {}): WorkTimelineLike => ({
  spans: [],
  waits: [],
  totals: ZERO,
  stalled: null,
  live: true,
  start: at('12:00'),
  end: at('12:30'),
  lastHeard: null,
  lastWordAt: null,
  stage: { key: 'in_progress', kind: 'active', since: at('11:00') },
  progressAt: at('12:18'),
  waitingOnHuman: false,
  ...more,
})

const liveness = (more: Partial<Liveness> = {}): Liveness => ({
  state: 'working',
  agent: 'claude',
  phase: 'build',
  since: at('11:47'),
  lastSignalAt: at('12:28'),
  lastWordAt: at('12:18'),
  silentMinutes: 12,
  spans: [
    { phase: 'build', agent: 'claude', since: at('11:47'), lastWordAt: at('12:18'), silentMinutes: 12 },
  ],
  ...more,
})

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el)
const text = (markup: string) => markup.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'")
/** The work-state icon's accessible name: the line's text, as a screen reader reads it. */
const name = (markup: string) => markup.match(/aria-label="([^"]*)"/)?.[1]?.replace(/&#x27;/g, "'") ?? ''

describe('WorkLine', () => {
  it('words a working ticket on its agent’s last word, with the per-agent detail under it', () => {
    const out = html(
      createElement(WorkLine, {
        timeline: timeline({ liveness: liveness(), progressAt: at('12:18') }),
        now: NOW,
        detail: true,
      }),
    )
    expect(name(out)).toContain('Working now · last word 12m')
    expect(text(out)).toContain('claude · build · 43 min · last word 12 min ago')
    expect(out).toContain('data-testid="work-line"')
    expect(out).toContain('data-state="working"')
    // The agent, phase and span age live in the detail, not in the line.
    expect(text(out)).not.toContain('Working now · claude')
  })

  it('words a human wait as Waiting on you, in amber, with no invented measure', () => {
    const out = html(
      createElement(WorkLine, {
        timeline: timeline({
          waits: [
            {
              id: 2,
              reason: 'human',
              agent: 'builder',
              on: null,
              note: '',
              start: at('12:09'),
              end: at('12:30'),
              open: true,
            },
          ],
          liveness: liveness({ state: 'waiting', since: at('12:09') }),
          waitingOnHuman: true,
        }),
        now: NOW,
      }),
    )
    expect(name(out)).toBe('Waiting on you')
    expect(out).toContain('text-amber-700')
    expect(out).toContain('dark:text-amber-400')
    expect(out).toContain('data-state="waiting"')
  })

  it('words a stall as No word and keeps its why, with the stage when it is not the default one', () => {
    const out = html(
      createElement(WorkLine, {
        timeline: timeline({
          liveness: liveness({ state: 'stalled', lastSignalAt: at('11:43'), spans: [] }),
          stalled: { since: at('11:43'), minutes: 47, lastAgent: 'claude', lastBy: '', lastFrom: 'event' },
          progressAt: at('10:00'),
        }),
        now: NOW,
        stage: 'Bug Found',
      }),
    )
    expect(name(out)).toBe('No word 47m')
    expect(out).toContain('data-state="no-word"')
    // The why is the tooltip's (asserted on the answer itself); the row's words are exact.
    expect(text(out)).not.toContain('Stalled')
  })

  it('words a lost run as Lost contact with its detail, and never as a stall', () => {
    const out = html(
      createElement(WorkLine, {
        timeline: timeline({
          liveness: liveness({
            state: 'lost',
            since: at('11:44'),
            spans: [
              {
                phase: 'build',
                agent: 'claude',
                since: at('11:44'),
                lastWordAt: at('12:18'),
                silentMinutes: 12,
              },
            ],
          }),
          progressAt: at('12:18'),
        }),
        now: NOW,
        detail: true,
      }),
    )
    expect(name(out)).toContain('Lost contact · 46m')
    expect(text(out)).toContain('claude · build · 46 min · last word 12 min ago')
    expect(out).toContain('data-state="lost"')
    expect(text(out)).not.toContain('No word')
  })

  it('words the neutral gap as Nothing open, and draws nothing for a row that is not live', () => {
    const out = html(
      createElement(WorkLine, {
        timeline: timeline({
          liveness: liveness({
            state: 'idle',
            lastSignalAt: at('12:20'),
            lastWordAt: at('12:20'),
            spans: [],
          }),
          progressAt: at('12:20'),
        }),
        now: NOW,
      }),
    )
    expect(name(out)).toBe('Nothing open')
    expect(out).toContain('data-state="nothing"')
    expect(html(createElement(WorkLine, { timeline: timeline({ live: false }), now: NOW }))).toBe('')
  })

  it('words a review ticket Your turn from its stage, never from the work', () => {
    const out = html(
      createElement(WorkLine, {
        timeline: timeline({ stage: { key: 'review', kind: 'review', since: at('10:30') } }),
        now: NOW,
      }),
    )
    expect(name(out)).toBe('Your turn · waiting 2h')
    expect(out).toContain('data-state="your-turn"')
  })

  describe('on the server clock', () => {
    afterEach(() => vi.useRealTimers())

    it('counts the elapsed time on the server clock when the browser clock runs behind it', () => {
      // The browser reads 12:20 while the server stamped 12:30 (the last word was 12:10): 20 minutes, not 10.
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.parse(at('12:20')))
      const t = timeline({ now: at('12:30'), liveness: liveness(), progressAt: at('12:18') })
      expect(name(html(createElement(WorkLine, { timeline: t })))).toBe('Working now · last word 12m')
    })

    it('counts the same time when the browser clock runs ahead of the server', () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.parse(at('12:40')))
      const t = timeline({ now: at('12:30'), liveness: liveness(), progressAt: at('12:18') })
      expect(name(html(createElement(WorkLine, { timeline: t })))).toBe('Working now · last word 12m')
    })

    it('corrects a lost contact line too, not only the working one', () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.parse(at('12:20')))
      const t = timeline({ now: at('12:30'), liveness: liveness({ state: 'lost', since: at('11:44') }) })
      expect(name(html(createElement(WorkLine, { timeline: t })))).toBe('Lost contact · 46m')
    })
  })
})

describe('LastHeard', () => {
  it('gives the time, the agent and what it said', () => {
    const t = timeline({
      lastHeard: {
        at: at('12:23'),
        agent: 'claude/builder-1',
        by: 'claude',
        kind: 'heartbeat',
        phase: 'build',
        reason: '',
        note: 'builder adding paged tags endpoint',
      },
    })
    expect(text(html(createElement(LastHeard, { timeline: t })))).toBe(
      `Last heard ${clock(at('12:23'))} · claude/builder-1: builder adding paged tags endpoint`,
    )
  })

  it('gives the time alone when the event named no agent', () => {
    const t = timeline({
      lastHeard: { at: at('12:23'), agent: '', by: '', kind: 'heartbeat', phase: '', reason: '', note: 'x' },
    })
    expect(text(html(createElement(LastHeard, { timeline: t })))).toBe(`Last heard ${clock(at('12:23'))}`)
  })

  it('says nobody was heard from when there is no agent event', () => {
    expect(text(html(createElement(LastHeard, { timeline: timeline() })))).toBe('Nobody heard from yet')
  })
})

describe('WorkLine from an activity', () => {
  it('dates a stall with nothing open by the span that ended last, when the activity names it', () => {
    const t = timelineFromActivity(
      {
        spans: [],
        waits: [],
        lastHeard: null,
        lastClosedSpan: { phase: 'build', agent: 'builder', start: at('11:50'), end: at('12:08') },
        stage: { key: 'in_progress', kind: 'active', since: at('10:00') },
        liveness: {
          state: 'stalled',
          agent: 'builder',
          phase: 'build',
          since: at('12:08'),
          lastSignalAt: at('12:08'),
          lastWordAt: at('12:08'),
          silentMinutes: 22,
          spans: [],
        },
        progressAt: at('12:08'),
      },
      { since: at('12:08'), minutes: 22, lastAgent: 'builder', lastBy: '', lastFrom: 'event' } as Stalled,
    )
    expect(name(html(createElement(WorkLine, { timeline: t, now: NOW })))).toBe('No word 22m')
  })
})

describe('WorkSummary', () => {
  it('states worked, waited and on-you time, with a bar and a tooltip defining each', () => {
    const out = html(
      createElement(WorkSummary, {
        totals: { workingMs: 43 * 60_000, waitingMs: 2 * 60_000, blockedOnHumanMs: 0 },
      }),
    )
    expect(text(out)).toContain('Worked 43 min')
    expect(text(out)).toContain('Waited 2 min')
    expect(text(out)).toContain('On you 0')
    expect(out).toContain('width:')
    expect(out).toContain('bg-amber-600')
    expect(out).toContain('dark:bg-amber-400')
    expect(out).toContain('<svg')
  })

  it('mutes on-you when it is zero, and marks it amber when not', () => {
    const zero = html(createElement(WorkSummary, { totals: ZERO }))
    expect(zero).toContain('text-muted-foreground">0</b>')
    expect(zero).not.toContain('text-amber-800')
    const some = html(
      createElement(WorkSummary, { totals: { workingMs: 0, waitingMs: 0, blockedOnHumanMs: 5 * 60_000 } }),
    )
    expect(text(some)).toContain('On you 5 min')
    expect(some).toContain('text-amber-800')
  })
})
