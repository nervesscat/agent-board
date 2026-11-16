import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { WorkTimelineLike } from '#/lib/workStatus'
import { WORK_LINE_STATES, WORK_STATE_NAME, workLine } from '#/lib/workStatus'
import type { Liveness, WorkTotals } from '#/lib/workTimeline'

import { WORK_STATE_ICON, WorkLine } from './WorkStatus'

const at = (hhmm: string) => `2026-10-20T${hhmm}:00.000Z`
const LONG_AGO = '2026-10-19T11:30:00.000Z'
const NOW = Date.parse(at('12:30'))
const ZERO: WorkTotals = { workingMs: 0, waitingMs: 0, blockedOnHumanMs: 0 }

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

/** One timeline per state of the table, each the smallest read that gives that state. */
const FIXTURES: Record<(typeof WORK_LINE_STATES)[number], WorkTimelineLike> = {
  waiting: timeline({ stage: { key: 'blocked', kind: 'blocked', since: at('12:00') }, waitingOnHuman: true }),
  'your-turn': timeline({ stage: { key: 'review', kind: 'review', since: at('12:00') } }),
  lost: timeline({ liveness: liveness({ state: 'lost', since: at('11:44') }) }),
  'no-word': timeline({
    liveness: liveness({ state: 'stalled', lastSignalAt: at('11:43') }),
    progressAt: at('12:18'),
  }),
  quiet: timeline({ liveness: liveness(), progressAt: LONG_AGO }),
  working: timeline({ liveness: liveness() }),
  nothing: timeline({
    liveness: liveness({ state: 'idle', lastSignalAt: at('12:20'), lastWordAt: at('12:20'), spans: [] }),
    progressAt: at('12:20'),
  }),
}

const render = (t: WorkTimelineLike) =>
  renderToStaticMarkup(createElement(WorkLine, { timeline: t, now: NOW, detail: true }))

describe('the state-to-icon mapping', () => {
  it('maps each of the seven states to exactly one icon and one tone', () => {
    expect(Object.keys(WORK_STATE_ICON).sort()).toEqual([...WORK_LINE_STATES].sort())
    for (const s of WORK_LINE_STATES) {
      expect(WORK_STATE_ICON[s].Icon).toBeTruthy()
      expect(WORK_STATE_ICON[s].tone).toMatch(/^text-/)
    }
  })

  it('gives every state its own shape, and lost and no-word apart', () => {
    const shapes = WORK_LINE_STATES.map((s) => WORK_STATE_ICON[s].Icon)
    expect(new Set(shapes).size).toBe(WORK_LINE_STATES.length)
    expect(WORK_STATE_ICON.lost.Icon).not.toBe(WORK_STATE_ICON['no-word'].Icon)
  })

  it('names each state as its line begins, so the filter and the line agree', () => {
    for (const s of WORK_LINE_STATES) {
      const line = workLine(FIXTURES[s], NOW)
      expect(line?.state).toBe(s)
      expect(line?.text.startsWith(WORK_STATE_NAME[s])).toBe(true)
    }
  })
})

describe('WorkLine as an icon', () => {
  it.each(WORK_LINE_STATES)(
    'draws one icon for %s, named by its line, and no sentence of the line as text',
    (s) => {
      const out = render(FIXTURES[s])
      const line = workLine(FIXTURES[s], NOW)!
      expect(out).toContain(`data-state="${s}"`)
      expect(out.match(/<svg/g)?.length).toBeGreaterThanOrEqual(1)
      expect(out).toContain(`aria-label="${line.text}"`)
      // The words of the line are its accessible name only; the text nodes hold at most its duration.
      const textNodes = out.replace(/<[^>]+>/g, '').replace(/aria-label="[^"]*"/g, '')
      expect(textNodes).not.toContain(WORK_STATE_NAME[s])
    },
  )

  it('keeps the state’s duration beside the icon where the surface has room', () => {
    const out = renderToStaticMarkup(
      createElement(WorkLine, { timeline: FIXTURES.lost, now: NOW, variant: 'inline' }),
    )
    expect(out.replace(/<[^>]+>/g, '')).toBe('46m')
  })
})
