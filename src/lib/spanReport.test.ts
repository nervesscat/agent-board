import { describe, expect, it } from 'vitest'

import type { RunReport } from './runReports'
import { reportsForSpans } from './spanReport'

const at = (hhmm: string) => `2026-05-01T${hhmm}:00.000Z`
const ms = (hhmm: string) => Date.parse(at(hhmm))

let next = 1
const span = (agent: string, round: number | null, start: string, end: string, open = false) => ({
  id: next++,
  agent,
  round,
  start: at(start),
  end: at(end),
  open,
})

const report = (over: Partial<RunReport>): RunReport => ({
  id: next++,
  projectId: 1,
  ticketId: 7,
  agent: 'hunt',
  round: null,
  branch: '',
  headSha: '',
  model: '',
  effort: '',
  briefedBy: '',
  startedAt: null,
  endedAt: null,
  durationMs: 0,
  durationSource: 'unknown',
  reportedDurationMs: null,
  time: { readingMs: 0, runningMs: 0, waitingMs: 0, writingMs: 0, otherMs: 0 },
  difficulty: null,
  confidence: null,
  steps: [],
  counts: {},
  sections: {},
  author: 'opencode/hunt-1',
  createdAt: at('12:00'),
  ...over,
})

describe('reportsForSpans: which report a span opens', () => {
  it('matches the kind of the span’s agent, whatever its parent or number', () => {
    const r = report({ agent: 'hunt', round: 2 })
    for (const agent of ['hunt', 'hunt-1', 'orch/hunt-1', 'OpenCode/Hunt-12']) {
      const s = span(agent, 2, '10:00', '11:00')
      expect(reportsForSpans([s], [r]).get(s.id)).toBe(r)
    }
  })

  it('matches the agent, not the phase: a build span by the builder', () => {
    const r = report({ agent: 'builder', author: 'opencode/builder-3' })
    const s = span('opencode/builder-3', null, '10:00', '11:00')
    expect(reportsForSpans([s], [r]).get(s.id)).toBe(r)
  })

  it('takes a trailing number off only when what is left is a known kind', () => {
    const own = report({ agent: 'auditor' })
    const s = span('auditor-2', null, '10:00', '11:00')
    expect(reportsForSpans([s], [own]).get(s.id)).toBe(own)
    const lone = span('reviewer-sub-1', null, '10:00', '11:00')
    expect(reportsForSpans([lone], [report({ agent: 'reviewer-sub' })]).get(lone.id)).toBeDefined()
    expect(reportsForSpans([lone], [report({ agent: 'hunt' })]).size).toBe(0)
  })

  it('does not match another round, another kind, or a round against none', () => {
    const r = report({ agent: 'hunt', round: 2 })
    const wrongRound = span('hunt-1', 3, '10:00', '11:00')
    const none = span('hunt-1', null, '10:00', '11:00')
    const wrongKind = span('verify', 2, '10:00', '11:00')
    expect(reportsForSpans([wrongRound, none, wrongKind], [r]).size).toBe(0)
  })

  it('matches no round to no round', () => {
    const r = report({ agent: 'spec', round: null })
    const s = span('spec', null, '10:00', '11:00')
    expect(reportsForSpans([s], [r]).get(s.id)).toBe(r)
  })

  it('gives a span without a report nothing', () => {
    const s = span('reviewer-sub-1', 2, '10:00', '11:00')
    expect(reportsForSpans([s], []).size).toBe(0)
  })
})

describe('reportsForSpans: several candidates', () => {
  it('picks the report whose times overlap the span the most', () => {
    const s = span('hunt-1', 1, '10:00', '11:00')
    const far = report({ round: 1, startedAt: at('08:00'), endedAt: at('09:00') })
    const part = report({ round: 1, startedAt: at('10:40'), endedAt: at('11:30') })
    const most = report({ round: 1, startedAt: at('10:05'), endedAt: at('10:55') })
    expect(reportsForSpans([s], [far, part, most]).get(s.id)).toBe(most)
  })

  it('counts one known time as a moment inside the span', () => {
    const s = span('hunt-1', 1, '10:00', '11:00')
    const out = report({ round: 1, endedAt: at('13:00'), createdAt: at('13:00') })
    const inside = report({ round: 1, startedAt: at('10:30'), createdAt: at('13:00') })
    expect(reportsForSpans([s], [out, inside]).get(s.id)).toBe(inside)
  })

  it('places a report with no times by when it was written: after the span ends, the nearest first', () => {
    const s = span('hunt-1', 1, '10:00', '11:00')
    const early = report({ round: 1, createdAt: at('09:00') })
    const late = report({ round: 1, createdAt: at('15:00') })
    const near = report({ round: 1, createdAt: at('11:05') })
    expect(reportsForSpans([s], [early, late, near]).get(s.id)).toBe(near)
    expect(reportsForSpans([s], [early, late]).get(s.id)).toBe(late)
  })

  it('ends an open span at now', () => {
    const s = span('hunt-1', 1, '10:00', '10:00', true)
    const before = report({ round: 1, startedAt: at('09:00'), endedAt: at('09:30') })
    const during = report({ round: 1, startedAt: at('10:10'), endedAt: at('10:20') })
    expect(reportsForSpans([s], [before, during], ms('10:30')).get(s.id)).toBe(during)
  })
})

describe('reportsForSpans: one report per span', () => {
  it('gives two hunts of one round each their own report, by overlap', () => {
    const first = span('opencode/hunt-1', 2, '10:00', '10:30')
    const second = span('opencode/hunt-2', 2, '10:00', '11:00')
    // Written in the opposite order of the spans.
    const b = report({ round: 2, startedAt: at('10:00'), endedAt: at('11:00'), author: 'x' })
    const a = report({ round: 2, startedAt: at('10:00'), endedAt: at('10:30'), author: 'x' })
    const got = reportsForSpans([first, second], [a, b])
    expect(got.get(first.id)).toBe(a)
    expect(got.get(second.id)).toBe(b)
  })

  it('breaks a tie by the author, then by order', () => {
    const first = span('opencode/hunt-1', 2, '10:00', '11:00')
    const second = span('opencode/hunt-2', 2, '10:00', '11:00')
    const by2 = report({ round: 2, author: 'opencode/hunt-2', createdAt: at('11:30') })
    const by1 = report({ round: 2, author: 'opencode/hunt-1', createdAt: at('11:30') })
    const got = reportsForSpans([first, second], [by2, by1])
    expect(got.get(first.id)).toBe(by1)
    expect(got.get(second.id)).toBe(by2)

    const x = report({ round: 2, author: 'orch', createdAt: at('11:10') })
    const y = report({ round: 2, author: 'orch', createdAt: at('11:20') })
    const early = span('hunt-1', 2, '10:00', '11:00')
    const late = span('hunt-1', 2, '11:00', '11:00')
    const order = reportsForSpans([late, early], [y, x])
    expect(order.get(early.id)).toBe(x)
    expect(order.get(late.id)).toBe(y)
  })

  it('leaves the span without a report when there are fewer reports than spans', () => {
    const first = span('hunt-1', 2, '10:00', '10:30')
    const second = span('hunt-2', 2, '10:30', '11:00')
    const only = report({ round: 2, startedAt: at('10:30'), endedAt: at('11:00') })
    const got = reportsForSpans([first, second], [only])
    expect(got.get(second.id)).toBe(only)
    expect(got.has(first.id)).toBe(false)
  })
})
