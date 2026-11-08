import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { clock } from '#/lib/format'
import type { WorkTimelineLike } from '#/lib/workStatus'
import type { WorkTotals } from '#/lib/workTimeline'

import { LastHeard, NowLine, StallNotice, WorkSummary } from './WorkStatus'

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
  ...more,
})

const span = (more: Record<string, unknown> = {}) => ({
  id: 1,
  phase: 'build',
  round: null,
  agent: 'builder',
  by: 'builder',
  start: at('11:47'),
  end: at('12:30'),
  open: true,
  ...more,
})

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el)
const text = (markup: string) => markup.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'")

describe('NowLine', () => {
  it('reads a delegated build as building, with the agent and the time', () => {
    const t = timeline({
      spans: [span()],
      waits: [
        {
          id: 2,
          reason: 'delegate',
          agent: 'orch',
          note: '',
          start: at('11:47'),
          end: at('12:30'),
          open: true,
          on: 'builder',
        },
      ],
    })
    const out = html(createElement(NowLine, { timeline: t, now: NOW }))
    expect(text(out)).toContain('Building · builder · 43 min')
    expect(out).not.toContain('Waiting')
  })

  it('reads an open human wait as waiting on you since, in amber, with an icon and words', () => {
    const t = timeline({
      waits: [
        {
          id: 2,
          reason: 'human',
          agent: 'builder',
          note: '',
          start: at('12:09'),
          end: at('12:30'),
          open: true,
        },
      ],
    })
    const out = html(createElement(NowLine, { timeline: t, now: NOW }))
    expect(text(out)).toBe(`Waiting on you since ${clock(at('12:09'))}`)
    expect(out).toContain('text-amber-800')
    expect(out).toContain('dark:text-amber-300')
    expect(out).toContain('<svg')
  })

  it('reads nothing open in words, muted', () => {
    const out = html(createElement(NowLine, { timeline: timeline(), now: NOW }))
    expect(text(out)).toBe('Nothing open')
    expect(out).toContain('text-muted-foreground')
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

describe('StallNotice', () => {
  const closed = timeline({
    stalled: { since: at('12:08'), minutes: 33, lastAgent: 'builder', lastBy: 'builder', lastFrom: 'event' },
    spans: [span({ start: at('11:50'), end: at('12:08'), open: false })],
    lastHeard: {
      at: at('12:08'),
      agent: 'builder',
      by: 'builder',
      kind: 'span_end',
      phase: 'build',
      reason: 'run returned before the builder reported',
      note: '',
    },
  })

  it('gives a badge with the same head as the sentence, the why in its tooltip, and the why in the sentence', () => {
    const badge = html(createElement(StallNotice, { timeline: closed }))
    expect(text(badge)).toBe('Stalled 33 min')
    expect(badge).toContain('data-testid="stall-notice"')
    expect(badge).toContain('dark:text-amber-300')
    const inline = html(createElement(StallNotice, { timeline: closed, variant: 'inline' }))
    expect(text(inline)).toBe(
      `Stalled 33 min: nothing open since the build ended at ${clock(at('12:08'))} ('run returned before the builder reported')`,
    )
  })

  it('says the stage in the why when the stage is not the default one', () => {
    const inline = html(
      createElement(StallNotice, { timeline: closed, variant: 'inline', stage: 'Bug Found' }),
    )
    expect(text(inline)).toBe(`Stalled 33 min: in Bug Found, no agent heard from since ${clock(at('12:08'))}`)
  })

  it('renders nothing when the ticket is not stalled', () => {
    expect(html(createElement(StallNotice, { timeline: timeline() }))).toBe('')
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
