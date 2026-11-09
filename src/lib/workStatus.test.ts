import { describe, expect, it } from 'vitest'

import type { LastHeard, TimelineSpan, TimelineWait, WorkTotals } from '#/lib/workTimeline'

import { currentActivity, lastHeard, stallReason, workShares, type WorkTimelineLike } from './workStatus'

const at = (hhmm: string) => `2026-10-20T${hhmm}:00.000Z`
const NOW = Date.parse(at('12:30'))
const ZERO: WorkTotals = { workingMs: 0, waitingMs: 0, blockedOnHumanMs: 0 }

const span = (more: Partial<TimelineSpan>): TimelineSpan => ({
  id: 1,
  phase: 'build',
  round: null,
  agent: 'builder',
  by: 'builder',
  start: at('12:00'),
  end: at('12:30'),
  open: true,
  ...more,
})

const wait = (more: Partial<TimelineWait>): TimelineWait => ({
  id: 2,
  reason: 'lock',
  agent: '',
  on: null,
  note: '',
  start: at('12:10'),
  end: at('12:30'),
  open: true,
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
  ...more,
})

const heard = (more: Partial<LastHeard> = {}): LastHeard => ({
  at: at('12:23'),
  agent: 'claude/builder-1',
  by: 'claude',
  kind: 'heartbeat',
  phase: 'build',
  reason: '',
  note: 'builder adding paged tags endpoint',
  ...more,
})

const stall = (since: string, minutes = 33) => ({
  since,
  minutes,
  lastAgent: 'builder',
  lastBy: 'builder',
  lastFrom: 'event' as const,
})

describe('currentActivity', () => {
  it('reads a wait delegated to an agent, inside an open build span, as building', () => {
    const t = timeline({
      spans: [span({ start: at('11:47') })],
      waits: [wait({ on: 'builder', reason: 'delegate', agent: 'orch', start: at('11:47') })],
    })
    expect(currentActivity(t, NOW)).toEqual({
      kind: 'building',
      verb: 'Building',
      phase: 'build',
      agent: 'builder',
      since: at('11:47'),
      ms: 43 * 60_000,
    })
  })

  it('names an open human wait as waiting on you, since when', () => {
    const t = timeline({ waits: [wait({ reason: 'human', start: at('12:09') })] })
    expect(currentActivity(t, NOW)).toEqual({ kind: 'waiting-human', reason: 'human', since: at('12:09') })
  })

  it('gives the earliest open human wait, the longest one', () => {
    const t = timeline({
      waits: [
        wait({ id: 3, reason: 'human', start: at('12:20') }),
        wait({ id: 4, reason: 'human', start: at('12:09') }),
      ],
    })
    expect(currentActivity(t, NOW)).toMatchObject({ kind: 'waiting-human', since: at('12:09') })
  })

  it('says nothing is open when no span or wait is', () => {
    expect(currentActivity(timeline(), NOW)).toEqual({ kind: 'nothing' })
  })

  it('says nothing is open on a ticket that is not live, even with a span left open', () => {
    expect(currentActivity(timeline({ live: false, spans: [span({})] }), NOW)).toEqual({ kind: 'nothing' })
  })

  it('reads an open wait with no span as waiting on its agent', () => {
    const t = timeline({ waits: [wait({ agent: 'builder', reason: 'lock', start: at('12:00') })] })
    expect(currentActivity(t, NOW)).toEqual({
      kind: 'waiting-agent',
      agent: 'builder',
      reason: 'lock',
      since: at('12:00'),
      ms: 30 * 60_000,
    })
  })

  it('reads the latest open span as building, and a non-build phase by its verb', () => {
    const t = timeline({
      spans: [
        span({ id: 5, phase: 'review', agent: 'old', start: at('12:00') }),
        span({ id: 6, phase: 'verify', agent: 'new', start: at('12:20') }),
      ],
    })
    expect(currentActivity(t, NOW)).toMatchObject({ kind: 'building', verb: 'Verifying', agent: 'new' })
  })

  it('reads no events at all as nothing open', () => {
    expect(currentActivity(timeline({ start: null, end: null }), NOW)).toEqual({ kind: 'nothing' })
  })
})

describe('lastHeard', () => {
  it('gives the agent, what it said and when', () => {
    expect(lastHeard(timeline({ lastHeard: heard() }))).toEqual({
      at: at('12:23'),
      agent: 'claude/builder-1',
      by: 'claude',
      summary: 'builder adding paged tags endpoint',
    })
  })

  it('falls back to the reason, then the phase, when there is no note', () => {
    expect(lastHeard(timeline({ lastHeard: heard({ note: '', reason: 'run returned' }) }))?.summary).toBe(
      'run returned',
    )
    expect(lastHeard(timeline({ lastHeard: heard({ note: '', reason: '' }) }))?.summary).toBe('build')
  })

  it('keeps an empty agent empty, so the line gives the time only', () => {
    expect(lastHeard(timeline({ lastHeard: heard({ agent: '' }) }))?.agent).toBe('')
  })

  it('is null when no agent event exists, even while a delegated build is open', () => {
    expect(lastHeard(timeline({ lastHeard: null }))).toBeNull()
    expect(lastHeard(timeline({ spans: [span({})], waits: [wait({ on: 'builder' })] }))).toBeNull()
  })
})

describe('stallReason', () => {
  it('is null when the ticket is not stalled', () => {
    expect(stallReason(timeline())).toBeNull()
  })

  it('says nothing is open since the last closed span ended, quoting its event when it is the last one', () => {
    const t = timeline({
      stalled: stall(at('12:08')),
      spans: [span({ start: at('11:50'), end: at('12:08'), open: false })],
      lastHeard: heard({ at: at('12:08'), reason: 'run returned before the builder reported', note: '' }),
    })
    expect(stallReason(t)).toEqual({
      kind: 'nothing-open',
      since: at('12:08'),
      endedAt: at('12:08'),
      phase: 'build',
      quote: 'run returned before the builder reported',
      stage: null,
    })
  })

  it('does not quote an event that is not the closing one', () => {
    const t = timeline({
      stalled: stall(at('12:08')),
      spans: [span({ end: at('12:08'), open: false })],
      lastHeard: heard({ at: at('12:05'), reason: 'other' }),
    })
    expect(stallReason(t)).toMatchObject({ kind: 'nothing-open', quote: '' })
  })

  it('says who a stalled open wait is on, since when', () => {
    const t = timeline({
      stalled: stall(at('12:02')),
      waits: [wait({ on: 'builder', reason: 'delegate', start: at('12:00') })],
    })
    expect(stallReason(t)).toEqual({
      kind: 'waiting',
      on: 'builder',
      reason: 'delegate',
      since: at('12:02'),
      stage: null,
    })
  })

  it('says the stage when the active stage is not the default one', () => {
    const t = timeline({ stalled: stall(at('12:08')), spans: [span({ end: at('12:08'), open: false })] })
    expect(stallReason(t, 'Bug Found')).toMatchObject({ kind: 'nothing-open', stage: 'Bug Found' })
  })

  it('says an open span with a silent agent is still working, but silent', () => {
    const t = timeline({ stalled: stall(at('12:02')), spans: [span({ agent: 'builder' })] })
    expect(stallReason(t)).toEqual({
      kind: 'working',
      agent: 'builder',
      phase: 'build',
      since: at('12:02'),
      stage: null,
    })
  })

  it('reads a stall on a ticket with no events as nothing open since its last signal', () => {
    const t = timeline({ stalled: stall(at('09:00')), start: null, end: null })
    expect(stallReason(t)).toEqual({
      kind: 'nothing-open',
      since: at('09:00'),
      endedAt: null,
      phase: '',
      quote: '',
      stage: null,
    })
  })
})

describe('workShares', () => {
  it('gives each total its share of the sum', () => {
    const s = workShares({ workingMs: 3, waitingMs: 1, blockedOnHumanMs: 0 })
    expect(s).toEqual({ total: 4, worked: 75, waited: 25, onYou: 0 })
  })

  it('gives no shares for no time', () => {
    expect(workShares(ZERO)).toEqual({ total: 0, worked: 0, waited: 0, onYou: 0 })
  })
})
