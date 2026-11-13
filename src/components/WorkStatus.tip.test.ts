import { createElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { clock } from '#/lib/format'
import type { WorkTimelineLike } from '#/lib/workStatus'
import type { Liveness, WorkTotals } from '#/lib/workTimeline'

import { WorkLine } from './WorkStatus'

/**
 * The tooltip's bubble is a portal a static render never draws, so these stand in a `Tip` that prints
 * what it would say: the test can then count the per-agent detail where a keyboard user reads it.
 */
vi.mock('#/components/ui/tooltip', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const Tip = ({ content, children }: { content: ReactNode; children: ReactElement }) =>
    createElement('span', { 'data-said': typeof content === 'string' ? content : '' }, children)
  return { ...original, Tip }
})

const at = (hhmm: string) => `2026-10-20T${hhmm}:00.000Z`
const LONG_AGO = '2026-10-19T11:30:00.000Z'
const NOW = Date.parse(at('12:30'))
const ZERO: WorkTotals = { workingMs: 0, waitingMs: 0, blockedOnHumanMs: 0 }
const DETAIL = 'claude · build · 43 min · last word 12 min ago'

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

const html = (more: Partial<WorkTimelineLike>, props: { detail?: boolean; focusable?: boolean } = {}) =>
  renderToStaticMarkup(createElement(WorkLine, { timeline: timeline(more), now: NOW, ...props }))
const said = (markup: string) => markup.match(/data-said="([^"]*)"/)?.[1] ?? ''
const occurrences = (markup: string, needle: string) => markup.split(needle).length - 1

describe('WorkLine’s tooltip', () => {
  it('carries the per-agent detail once on a working ticket, not twice', () => {
    const out = html({ liveness: liveness() })
    expect(said(out)).toBe(`Working now · last word 12m\n${DETAIL}`)
    expect(occurrences(out, DETAIL)).toBe(1)
  })

  it('carries it once on a lost run too', () => {
    const out = html({
      liveness: liveness({
        state: 'lost',
        since: at('11:44'),
        spans: [
          { phase: 'build', agent: 'claude', since: at('11:44'), lastWordAt: at('12:18'), silentMinutes: 12 },
        ],
      }),
    })
    expect(said(out)).toBe('Lost contact · 46m\nclaude · build · 46 min · last word 12 min ago')
    expect(occurrences(out, 'claude · build · 46 min · last word 12 min ago')).toBe(1)
  })

  it('keeps the detail beside a why that says something else, once', () => {
    // A quiet day: the why is the silence, the per-agent line says who is there.
    const out = html({ liveness: liveness(), progressAt: LONG_AGO })
    expect(said(out).split('\n')).toEqual(['Quiet 1d', `no progress post since ${clock(LONG_AGO)}`, DETAIL])
    expect(occurrences(out, DETAIL)).toBe(1)
  })

  it('adds nothing twice where the surface prints the detail under the line', () => {
    const out = html({ liveness: liveness() }, { detail: true })
    // Once in the tooltip and once under the line, never a third time in either.
    expect(occurrences(out, DETAIL)).toBe(2)
    expect(said(out)).toBe(`Working now · last word 12m\n${DETAIL}`)
  })
})

describe('WorkLine’s tooltip for each state', () => {
  // The tooltip is the full line, then the why and the per-agent detail, each once: nothing the text line said is lost.
  it.each([
    ['lost', { liveness: liveness({ state: 'lost', since: at('11:44') }) }],
    [
      'no-word',
      { liveness: liveness({ state: 'stalled', lastSignalAt: at('11:43') }), progressAt: at('12:18') },
    ],
    ['quiet', { liveness: liveness(), progressAt: LONG_AGO }],
    ['working', { liveness: liveness() }],
  ])('carries the line first, then its why and detail, for %s', (state, more) => {
    const out = html(more as Partial<WorkTimelineLike>)
    expect(out).toContain(`data-state="${state}"`)
    const lines = said(out).split('\n')
    expect(lines[0]).toBe(name(out))
    expect(lines.length).toBeGreaterThan(1)
  })

  it('has no tooltip where the line has no why and no detail: Waiting on you and Your turn', () => {
    expect(
      said(html({ stage: { key: 'blocked', kind: 'blocked', since: at('12:00') }, waitingOnHuman: true })),
    ).toBe('')
    expect(said(html({ stage: { key: 'review', kind: 'review', since: at('12:00') } }))).toBe('')
  })
})

const name = (markup: string) => markup.match(/aria-label="([^"]*)"/)?.[1] ?? ''

describe('WorkLine’s keyboard stop', () => {
  it('is not a tab stop when there is nothing to say: Nothing open', () => {
    const out = html({
      liveness: liveness({ state: 'idle', lastSignalAt: at('12:20'), lastWordAt: at('12:20'), spans: [] }),
      progressAt: at('12:20'),
    })
    expect(out).toContain('data-state="nothing"')
    expect(out).not.toContain('tabindex')
    expect(said(out)).toBe('')
  })

  it('is not a tab stop for a blocked stage’s Waiting on you, which has no why of its own', () => {
    const out = html({
      liveness: null,
      stage: { key: 'blocked', kind: 'blocked', since: at('12:00') },
    })
    expect(out).toContain('data-state="waiting"')
    expect(out).not.toContain('tabindex')
    expect(said(out)).toBe('')
  })

  it('is not a tab stop for a Working now with no open span', () => {
    const out = html({
      liveness: liveness({ state: 'working', lastSignalAt: at('12:28'), lastWordAt: at('12:28'), spans: [] }),
      progressAt: at('12:28'),
    })
    expect(out).toContain('data-state="working"')
    expect(out).not.toContain('tabindex')
    expect(said(out)).toBe('')
  })

  it('is a tab stop when a tooltip really opens, and never where the surface says not to', () => {
    expect(html({ liveness: liveness() })).toContain('tabindex="0"')
    expect(html({ liveness: liveness() }, { focusable: false })).not.toContain('tabindex')
  })
})
