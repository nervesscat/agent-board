import { describe, expect, it } from 'vitest'

import { DEFAULT_STAGES } from './constants'
import {
  buildTimeline,
  formatDuration,
  isStalled,
  subtract,
  sumTotals,
  type TimelineEvent,
  type TimelineTicket,
  totals,
  union,
  unionMs,
} from './workTimeline'

const MIN = 60_000
const day = '2026-10-20'
const at = (hhmm: string) => `${day}T${hhmm}:00.000Z`
const ms = (hhmm: string) => Date.parse(at(hhmm))

let next = 1
const event = (kind: TimelineEvent['kind'], time: string, more: Partial<TimelineEvent> = {}) =>
  ({
    id: next++,
    kind,
    agent: 'claude',
    by: 'claude',
    phase: '',
    round: null,
    refId: null,
    fromAgent: '',
    toAgent: '',
    reason: '',
    note: '',
    fromStage: '',
    toStage: '',
    at: at(time),
    ...more,
  }) satisfies TimelineEvent

const ticket = (more: Partial<TimelineTicket> = {}): TimelineTicket => ({
  status: 'in_progress',
  archivedAt: null,
  prId: null,
  assignee: 'claude',
  createdAt: at('09:00'),
  startedAt: null,
  ...more,
})
const stages = DEFAULT_STAGES
const build = (events: TimelineEvent[], now: string, t: Partial<TimelineTicket> = {}, stallMinutes = 30) =>
  buildTimeline(events, { now: ms(now), stages, ticket: ticket(t), stallMinutes })

describe('interval maths', () => {
  it('merges overlaps, drops empty intervals and counts an overlap once', () => {
    expect(
      union([
        [5, 8],
        [1, 3],
        [2, 4],
        [6, 6],
      ]),
    ).toEqual([
      [1, 4],
      [5, 8],
    ])
    expect(
      unionMs([
        [0, 10],
        [5, 15],
      ]),
    ).toBe(15)
  })

  it('subtracts one set from another', () => {
    expect(
      subtract(
        [[0, 100]],
        [
          [10, 20],
          [15, 30],
          [90, 120],
        ],
      ),
    ).toEqual([
      [0, 10],
      [30, 90],
    ])
    expect(subtract([[0, 10]], [[0, 10]])).toEqual([])
  })
})

describe('totals', () => {
  it('keeps working, waiting and blocked on human disjoint, overlapping spans counted once', () => {
    const t = totals(
      [
        [ms('10:00'), ms('11:00')],
        [ms('10:30'), ms('11:30')],
      ],
      [
        { interval: [ms('10:40'), ms('10:50')], reason: 'lock' },
        { interval: [ms('11:10'), ms('11:20')], reason: 'human' },
      ],
      [],
    )
    expect(t).toEqual({ workingMs: 70 * MIN, waitingMs: 10 * MIN, blockedOnHumanMs: 10 * MIN })
  })

  it('counts a wait that overlaps human time only once, as blocked on human', () => {
    const t = totals(
      [[ms('10:00'), ms('11:00')]],
      [{ interval: [ms('10:00'), ms('10:30')], reason: 'builder' }],
      [[ms('10:20'), ms('10:40')]],
    )
    expect(t).toEqual({ workingMs: 20 * MIN, waitingMs: 20 * MIN, blockedOnHumanMs: 20 * MIN })
  })

  it('adds up many tickets', () => {
    const a = { workingMs: 1, waitingMs: 2, blockedOnHumanMs: 3 }
    expect(sumTotals([a, a])).toEqual({ workingMs: 2, waitingMs: 4, blockedOnHumanMs: 6 })
  })
})

describe('buildTimeline', () => {
  it('builds the fixture from events, closing spans and waits by their start', () => {
    const a = event('span_start', '10:00', { phase: 'build' })
    const b = event('span_start', '10:30', { phase: 'review', round: 2, agent: 'reviewer' })
    const lock = event('wait_start', '10:40', { reason: 'lock' })
    const human = event('wait_start', '11:10', { reason: 'human' })
    const events = [
      a,
      b,
      lock,
      event('wait_end', '10:50', { refId: lock.id }),
      event('span_end', '11:00', { refId: a.id }),
      human,
      event('wait_end', '11:20', { refId: human.id }),
      event('span_end', '11:30', { refId: b.id, agent: 'reviewer' }),
    ]
    const t = build(events, '11:30', { status: 'done' })
    expect(t.totals).toEqual({ workingMs: 70 * MIN, waitingMs: 10 * MIN, blockedOnHumanMs: 10 * MIN })
    expect(t.spans.map((s) => [s.phase, s.round, s.agent, s.open])).toEqual([
      ['build', null, 'claude', false],
      ['review', 2, 'reviewer', false],
    ])
    expect(t.waits.map((w) => [w.reason, w.open])).toEqual([
      ['lock', false],
      ['human', false],
    ])
    expect(t.start).toBe(at('10:00'))
    expect(t.end).toBe(at('11:30'))
    expect(t.live).toBe(false)
  })

  it('runs open spans and waits to now while live, and to the last event otherwise', () => {
    const span = event('span_start', '10:00', { phase: 'build' })
    const hb = event('heartbeat', '10:20')
    const live = build([span, hb], '10:40')
    expect(live.live).toBe(true)
    expect(live.end).toBe(at('10:40'))
    expect(live.spans[0]).toMatchObject({ open: true, end: at('10:40') })
    expect(live.totals.workingMs).toBe(40 * MIN)
    expect(build([span, hb], '10:50').totals.workingMs).toBe(50 * MIN)

    for (const status of ['done', 'todo', 'cancelled']) {
      const closed = build([span, hb], '12:00', { status })
      expect(closed.live).toBe(false)
      expect(closed.end).toBe(at('10:20'))
      expect(closed.totals.workingMs).toBe(20 * MIN)
    }
    const archived = build([span, hb], '12:00', { archivedAt: at('11:00') })
    expect(archived.live).toBe(false)
    expect(archived.totals.workingMs).toBe(20 * MIN)
    // Blocked and review stages are live too.
    expect(build([span, hb], '11:00', { status: 'review' }).totals.workingMs).toBe(60 * MIN)
  })

  it('counts time in a blocked stage as blocked on human, until the next stage move', () => {
    const events = [
      event('span_start', '09:30', { phase: 'build' }),
      event('stage', '10:00', { agent: 'board', by: 'board', fromStage: 'in_progress', toStage: 'blocked' }),
      event('stage', '10:30', { agent: 'board', by: 'board', fromStage: 'blocked', toStage: 'in_progress' }),
    ]
    const t = build(events, '11:00')
    expect(t.blockedStretches).toEqual([{ start: at('10:00'), end: at('10:30') }])
    expect(t.totals).toEqual({ workingMs: 60 * MIN, waitingMs: 0, blockedOnHumanMs: 30 * MIN })

    // Still blocked: it runs to the end.
    const still = build(events.slice(0, 2), '10:45', { status: 'blocked' })
    expect(still.totals.blockedOnHumanMs).toBe(45 * MIN)
    // A stage the project no longer has is not blocked.
    const gone = build(
      [event('stage', '10:00', { agent: 'board', toStage: 'parked' }), event('heartbeat', '10:30')],
      '10:30',
    )
    expect(gone.blockedStretches).toEqual([])
  })

  it('lists hand-offs and the board marks apart from stage moves', () => {
    const t = build(
      [
        event('handoff', '10:00', { fromAgent: 'orchestrator', toAgent: 'builder-sub-1' }),
        event('push', '10:05', { agent: 'board', note: 'pushed abc1234' }),
        event('stage', '10:06', { agent: 'board', toStage: 'review' }),
      ],
      '10:10',
    )
    expect(t.handoffs).toEqual([expect.objectContaining({ from: 'orchestrator', to: 'builder-sub-1' })])
    expect(t.marks.map((m) => [m.kind, m.note])).toEqual([['push', 'pushed abc1234']])
  })

  it('is empty for a ticket without events', () => {
    const t = build([], '10:00')
    expect(t).toMatchObject({ start: null, end: null, spans: [], waits: [], lastSignalAt: at('09:00') })
    expect(t.totals).toEqual({ workingMs: 0, waitingMs: 0, blockedOnHumanMs: 0 })
  })
})

describe('the stalled rule', () => {
  const hb = () => event('heartbeat', '10:00', { agent: 'builder' })

  it('flags an active ticket silent for more than the threshold, and only then', () => {
    expect(build([hb()], '10:31').stalled).toEqual({ since: at('10:00'), minutes: 31, lastAgent: 'builder' })
    expect(build([hb()], '10:29').stalled).toBeNull()
    expect(build([hb()], '10:30').stalled).toBeNull()
  })

  it('does not flag blocked, review, open, done, archived or PR tickets', () => {
    for (const status of ['blocked', 'review', 'todo', 'done'])
      expect(build([hb()], '12:00', { status }).stalled).toBeNull()
    expect(build([hb()], '12:00', { archivedAt: at('11:00') }).stalled).toBeNull()
    expect(build([hb()], '12:00', { prId: 3 }).stalled).toBeNull()
  })

  it('does not flag a ticket waiting on the human, and does once the wait is over', () => {
    const wait = event('wait_start', '10:00', { reason: 'human' })
    expect(build([wait], '12:00').stalled).toBeNull()
    expect(build([wait, event('wait_end', '10:10', { refId: wait.id })], '12:00').stalled).not.toBeNull()
    // Another reason does not exempt it.
    expect(build([event('wait_start', '10:00', { reason: 'lock' })], '12:00').stalled).not.toBeNull()
  })

  it('takes the latest of any event, startedAt and createdAt as the last signal', () => {
    expect(build([hb(), event('heartbeat', '10:40')], '11:00').stalled).toBeNull()
    expect(build([event('push', '10:40', { agent: 'board' })], '11:00').stalled).toBeNull()
    expect(build([hb()], '11:00', { startedAt: at('10:45') }).stalled).toBeNull()
    expect(build([], '09:31', { createdAt: at('09:00') }).stalled).toMatchObject({ minutes: 31 })
    expect(build([hb()], '10:31', {}, 60).stalled).toBeNull()
    expect(build([hb()], '10:11', {}, 10).stalled).not.toBeNull()
  })

  it('names the last agent heard from, not the board', () => {
    const t = build([hb(), event('push', '10:05', { agent: 'board' })], '11:00')
    expect(t.stalled).toMatchObject({ since: at('10:05'), lastAgent: 'builder' })
  })

  it('isStalled is strict at the threshold', () => {
    const base = {
      kind: 'active' as const,
      archived: false,
      prTicket: false,
      waitingOnHuman: false,
      lastSignalAt: at('10:00'),
      stallMinutes: 30,
    }
    expect(isStalled({ ...base, now: ms('10:30') })).toBe(false)
    expect(isStalled({ ...base, now: ms('10:30') + 1 })).toBe(true)
  })
})

describe('formatDuration', () => {
  it('reads as hours and minutes', () => {
    expect(formatDuration(0)).toBe('0m')
    expect(formatDuration(40_000)).toBe('40s')
    expect(formatDuration(25 * MIN)).toBe('25m')
    expect(formatDuration(190 * MIN)).toBe('3h 10m')
    expect(formatDuration(60 * MIN)).toBe('1h')
  })
})
