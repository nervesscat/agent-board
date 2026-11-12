import { describe, expect, it } from 'vitest'

import { DEFAULT_STAGES, LEASE_TTL_MINUTES } from './constants'
import {
  activityOf,
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
        { interval: [ms('09:40'), ms('10:00')], reason: 'lock' },
        { interval: [ms('11:10'), ms('11:20')], reason: 'human' },
      ],
      [],
    )
    expect(t).toEqual({ workingMs: 80 * MIN, waitingMs: 20 * MIN, blockedOnHumanMs: 10 * MIN })
  })

  it('counts a delegated build as working: the wait on the builder runs under its span', () => {
    // An orchestrator waits on its builder over the same stretch as the builder's build span.
    const t = totals(
      [[Date.parse('2026-11-04T05:58:38Z'), Date.parse('2026-11-04T06:09:02Z')]],
      [
        {
          interval: [Date.parse('2026-11-04T05:58:58Z'), Date.parse('2026-11-04T06:09:02Z')],
          reason: 'builder',
        },
      ],
      [],
    )
    expect(t).toEqual({ workingMs: (10 * 60 + 24) * 1000, waitingMs: 0, blockedOnHumanMs: 0 })
  })

  it('counts a delegated wait with no span once, as working, never as waiting too', () => {
    // The caller passes a delegated wait's interval among the working spans; it must not also count as waiting.
    const t = totals(
      [[ms('10:00'), ms('10:10')]],
      [{ interval: [ms('10:00'), ms('10:10')], reason: 'builder' }],
      [],
    )
    expect(t).toEqual({ workingMs: 10 * MIN, waitingMs: 0, blockedOnHumanMs: 0 })
  })

  it('counts a wait as waiting only while no span is open', () => {
    expect(totals([], [{ interval: [ms('10:00'), ms('10:30')], reason: 'lock' }], [])).toEqual({
      workingMs: 0,
      waitingMs: 30 * MIN,
      blockedOnHumanMs: 0,
    })
    // A span that starts during the wait takes the rest of it.
    expect(
      totals([[ms('10:20'), ms('10:50')]], [{ interval: [ms('10:00'), ms('10:30')], reason: 'builder' }], []),
    ).toEqual({ workingMs: 30 * MIN, waitingMs: 20 * MIN, blockedOnHumanMs: 0 })
  })

  it('counts overlapping waits once', () => {
    const t = totals(
      [[ms('10:40'), ms('11:00')]],
      [
        { interval: [ms('10:00'), ms('10:30')], reason: 'lock' },
        { interval: [ms('10:15'), ms('10:45')], reason: 'builder' },
      ],
      [],
    )
    expect(t).toEqual({ workingMs: 20 * MIN, waitingMs: 40 * MIN, blockedOnHumanMs: 0 })
  })

  it('counts a wait on the human as blocked on human, over a span too', () => {
    const t = totals(
      [[ms('10:00'), ms('11:00')]],
      [{ interval: [ms('10:20'), ms('10:30')], reason: 'human' }],
      [],
    )
    expect(t).toEqual({ workingMs: 50 * MIN, waitingMs: 0, blockedOnHumanMs: 10 * MIN })
  })

  it('counts a wait that overlaps human time only once, as blocked on human', () => {
    const t = totals(
      [[ms('10:30'), ms('11:00')]],
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
    // The lock wait falls under the spans: work went on, so it is not waiting time.
    expect(t.totals).toEqual({ workingMs: 80 * MIN, waitingMs: 0, blockedOnHumanMs: 10 * MIN })
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
      [
        event('stage', '10:00', { agent: 'board', by: 'board', toStage: 'parked' }),
        event('heartbeat', '10:30'),
      ],
      '10:30',
    )
    expect(gone.blockedStretches).toEqual([])
  })

  it("reads a delegated build as working: the builder's span under the orchestrator's open wait", () => {
    const wait = event('wait_start', '10:00', { reason: 'builder', agent: 'orchestrator' })
    const span = event('span_start', '10:01', { phase: 'build', agent: 'builder' })
    const t = build([wait, event('handoff', '10:00', { toAgent: 'builder' }), span], '10:31')
    expect(t.totals).toEqual({ workingMs: 30 * MIN, waitingMs: MIN, blockedOnHumanMs: 0 })
    // Once the builder hands back and nothing runs, the open wait is waiting time again.
    const ended = build([wait, span, event('span_end', '10:31', { refId: span.id })], '10:41')
    expect(ended.totals).toEqual({ workingMs: 30 * MIN, waitingMs: 11 * MIN, blockedOnHumanMs: 0 })
  })

  it('reads a ticket with only an open wait as waiting', () => {
    const t = build([event('wait_start', '10:00', { reason: 'lock' })], '10:25')
    expect(t.totals).toEqual({ workingMs: 0, waitingMs: 25 * MIN, blockedOnHumanMs: 0 })
  })

  it('lists hand-offs and the board marks apart from stage moves', () => {
    const t = build(
      [
        event('handoff', '10:00', { fromAgent: 'orchestrator', toAgent: 'builder-sub-1' }),
        event('push', '10:05', { agent: 'board', by: 'board', note: 'pushed abc1234' }),
        event('stage', '10:06', { agent: 'board', by: 'board', toStage: 'review' }),
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

describe('delegated waits', () => {
  it('counts a wait with on as working, a wait without it as waiting, as before', () => {
    const delegated = build([event('wait_start', '10:00', { reason: 'builder', on: 'builder' })], '10:30')
    expect(delegated.totals).toEqual({ workingMs: 30 * MIN, waitingMs: 0, blockedOnHumanMs: 0 })
    expect(delegated.waits[0]).toMatchObject({ on: 'builder', reason: 'builder' })

    const plain = build([event('wait_start', '10:00', { reason: 'builder' })], '10:30')
    expect(plain.totals).toEqual({ workingMs: 0, waitingMs: 30 * MIN, blockedOnHumanMs: 0 })
    expect(plain.waits[0]).toMatchObject({ on: null })
  })

  it('still counts a delegated wait on the human as blocked on human', () => {
    const t = build([event('wait_start', '10:00', { reason: 'human', on: 'builder' })], '10:30')
    expect(t.totals).toEqual({ workingMs: 0, waitingMs: 0, blockedOnHumanMs: 30 * MIN })
  })
})

describe('lastHeard', () => {
  it('is the latest agent event, a heartbeat included, with its note', () => {
    const t = build(
      [
        event('span_start', '10:00', { agent: 'claude', phase: 'build' }),
        event('heartbeat', '10:20', { agent: 'builder', note: 'running the tests' }),
      ],
      '10:30',
    )
    expect(t.lastHeard).toEqual({
      at: at('10:20'),
      agent: 'builder',
      by: 'claude',
      kind: 'heartbeat',
      phase: '',
      reason: '',
      note: 'running the tests',
    })
  })

  it('picks the latest by time, whatever the order given, and skips the board', () => {
    const later = event('heartbeat', '10:40', { agent: 'builder', note: 'done' })
    const t = build(
      [
        later,
        event('push', '10:50', { agent: 'board', by: 'board' }),
        event('span_start', '10:05', { agent: 'claude', phase: 'build' }),
      ],
      '11:00',
    )
    expect(t.lastHeard).toMatchObject({ at: at('10:40'), kind: 'heartbeat', note: 'done' })
  })

  it('is none when there are no events, or only the board has recorded some', () => {
    expect(build([], '10:00').lastHeard).toBeNull()
    expect(
      build([event('stage', '09:30', { agent: 'board', by: 'board', toStage: 'in_progress' })], '10:00')
        .lastHeard,
    ).toBeNull()
  })
})

describe('activityOf', () => {
  it('lists the open spans and waits and lastHeard, in this shape', () => {
    const span = event('span_start', '10:00', { agent: 'claude', phase: 'build', round: 1 })
    const delegated = event('wait_start', '10:10', { agent: 'claude', reason: 'builder', on: 'builder' })
    const lock = event('wait_start', '10:12', { agent: 'claude', reason: 'lock' })
    const lockEnd = event('wait_end', '10:13', { agent: 'claude', reason: 'lock', refId: lock.id })
    const beat = event('heartbeat', '10:20', { agent: 'claude', note: 'waiting on the builder' })
    expect(activityOf(build([span, delegated, lock, lockEnd, beat], '10:30'))).toEqual({
      spans: [{ phase: 'build', agent: 'claude', since: at('10:00') }],
      waits: [{ reason: 'builder', agent: 'claude', on: 'builder', since: at('10:10') }],
      lastHeard: {
        at: at('10:20'),
        agent: 'claude',
        by: 'claude',
        kind: 'heartbeat',
        phase: '',
        reason: '',
        note: 'waiting on the builder',
      },
      lastClosedSpan: null,
      now: at('10:30'),
      liveness: {
        state: 'working',
        agent: 'claude',
        phase: 'build',
        since: at('10:00'),
        lastSignalAt: at('10:20'),
        lastWordAt: at('10:20'),
        silentMinutes: 10,
        spans: [
          {
            phase: 'build',
            agent: 'claude',
            since: at('10:00'),
            lastWordAt: at('10:20'),
            silentMinutes: 10,
          },
        ],
      },
    })
  })

  it('names the span that ended last, and the server time of the read', () => {
    const first = event('span_start', '10:00', { phase: 'spec' })
    const firstEnd = event('span_end', '10:05', { refId: first.id, phase: 'spec' })
    const second = event('span_start', '10:20', { phase: 'build' })
    const secondEnd = event('span_end', '10:40', { refId: second.id, phase: 'build' })
    expect(activityOf(build([first, firstEnd, second, secondEnd], '10:50')).lastClosedSpan).toEqual({
      phase: 'build',
      agent: 'claude',
      start: at('10:20'),
      end: at('10:40'),
    })
  })

  it('is empty for a ticket without events', () => {
    expect(activityOf(build([], '10:00'))).toEqual({
      spans: [],
      waits: [],
      lastHeard: null,
      lastClosedSpan: null,
      now: at('10:00'),
      liveness: {
        state: 'stalled',
        agent: 'claude',
        phase: '',
        since: at('09:00'),
        lastSignalAt: at('09:00'),
        lastWordAt: null,
        silentMinutes: 60,
        spans: [],
      },
    })
  })
})

describe('the stalled rule', () => {
  const hb = () => event('heartbeat', '10:00', { agent: 'builder' })

  it('flags an active ticket silent for more than the threshold, and only then', () => {
    expect(build([hb()], '10:31').stalled).toEqual({
      since: at('10:00'),
      minutes: 31,
      lastAgent: 'builder',
      lastBy: 'claude',
      lastFrom: 'event',
    })
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
    expect(build([event('push', '10:40', { agent: 'board', by: 'board' })], '11:00').stalled).toBeNull()
    expect(build([hb()], '11:00', { startedAt: at('10:45') }).stalled).toBeNull()
    expect(build([], '09:31', { createdAt: at('09:00') }).stalled).toMatchObject({ minutes: 31 })
    expect(build([hb()], '10:31', {}, 60).stalled).toBeNull()
    expect(build([hb()], '10:11', {}, 10).stalled).not.toBeNull()
  })

  it('names the last agent heard from, not the board', () => {
    const t = build([hb(), event('push', '10:05', { agent: 'board', by: 'board' })], '11:00')
    expect(t.stalled).toMatchObject({ since: at('10:05'), lastAgent: 'builder', lastBy: 'claude' })
  })

  it("counts a worker's event under the name 'board' as the worker's, not the board's", () => {
    // Recorded by a signed-in worker under the board's name: a claim, so it names the event.
    const claimed = event('heartbeat', '10:05', { agent: 'board', by: 'claude' })
    const t = build([hb(), claimed], '11:00')
    expect(t.stalled).toEqual({
      since: at('10:05'),
      minutes: 55,
      lastAgent: 'board',
      lastBy: 'claude',
      lastFrom: 'event',
    })
    // Its activity resets the clock like any other event's.
    expect(
      build([hb(), event('heartbeat', '10:40', { agent: 'board', by: 'claude' })], '11:00').stalled,
    ).toBeNull()
    // The only event, with an assignee: still the event, never the assignee.
    expect(build([claimed], '11:00', { assignee: 'someone' }).stalled).toMatchObject({
      lastAgent: 'board',
      lastBy: 'claude',
      lastFrom: 'event',
    })
    // The board's own, recorded by the board or by no one (older events): skipped.
    for (const by of ['board', ''])
      expect(build([hb(), event('push', '10:05', { agent: 'board', by })], '11:00').stalled).toMatchObject({
        lastAgent: 'builder',
        lastBy: 'claude',
        lastFrom: 'event',
      })
  })

  it('carries who recorded the last event beside the name it claims', () => {
    // A worker claims another's name: the claim and the signed-in recorder both come through.
    const claimed = event('heartbeat', '10:00', { agent: 'enrique', by: 'orch/builder-1' })
    expect(build([claimed], '11:00').stalled).toMatchObject({
      lastAgent: 'enrique',
      lastBy: 'orch/builder-1',
      lastFrom: 'event',
    })
    // An older event recorded no one: nothing to name, but the name still comes from an event.
    expect(build([event('heartbeat', '10:00', { by: '' })], '11:00').stalled).toMatchObject({
      lastAgent: 'claude',
      lastBy: '',
      lastFrom: 'event',
    })
    // No agent's event at all: the assignee, recorded by no one.
    expect(build([], '11:00', { assignee: 'someone', createdAt: at('09:00') }).stalled).toMatchObject({
      lastAgent: 'someone',
      lastBy: '',
      lastFrom: 'assignee',
    })
    // Only the board's own events: still the assignee's name, not an event's.
    expect(
      build([event('push', '10:00', { agent: 'board', by: 'board' })], '11:00', { assignee: 'someone' })
        .stalled,
    ).toMatchObject({ lastAgent: 'someone', lastBy: '', lastFrom: 'assignee' })
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

describe('liveness: the lease, the open spans and waiting on the human', () => {
  const TTL = LEASE_TTL_MINUTES * MIN
  const spanStart = (time: string, more: Partial<TimelineEvent> = {}) =>
    event('span_start', time, { phase: 'review', round: 4, ...more })
  const post = (time: string, agent = 'claude', human = false) => ({ at: at(time) + '', agent, human })
  const buildLiveness = (
    events: TimelineEvent[],
    now: string,
    opts: {
      posts?: { at: string; agent: string; human: boolean }[]
      waiting?: { decision?: boolean; blockedTask?: boolean }
    } = {},
    t: Partial<TimelineTicket> = {},
    stallMinutes = 30,
  ) =>
    buildTimeline(events, {
      now: ms(now),
      stages,
      ticket: ticket(t),
      stallMinutes,
      posts: opts.posts,
      waiting: opts.waiting,
    })

  it('the #861 case: a long review round kept alive by its posts reads working, not stalled', () => {
    // A review round-4 span opened at 17:15; the agent posted at 17:33, 17:41 and 17:58; read at 18:04
    // with stallMinutes 30. The span is much older than the threshold, the posts are the lease.
    const t = buildLiveness(
      [spanStart('17:15')],
      '18:04',
      {
        posts: [post('17:33'), post('17:41'), post('17:58')],
      },
      { createdAt: at('17:00') },
    )
    expect(t.liveness).toMatchObject({
      state: 'working',
      agent: 'claude',
      phase: 'review',
      since: at('17:15'),
      lastWordAt: at('17:58'),
      silentMinutes: 6,
      spans: [{ phase: 'review', agent: 'claude', since: at('17:15'), silentMinutes: 6 }],
    })
    expect(t.stalled).toBeNull()
    expect(t.lastSignalAt).toBe(at('17:58'))
    expect(t.lastWordAt).toBe(at('17:58'))
  })

  it('a run killed mid-span is lost from the TTL on, and never stalled', () => {
    const events = [spanStart('10:00')]
    const atTtl = buildLiveness(events, '10:10')
    expect(atTtl.liveness?.state).toBe('working')
    const lost = buildLiveness(events, '10:11')
    expect(lost.liveness).toMatchObject({ state: 'lost', phase: 'review', since: at('10:00') })
    expect(lost.stalled).toBeNull()
    // Silence grows: still lost, never working and never stalled, with the open span named.
    const later = buildLiveness(events, '11:31')
    expect(later.liveness).toMatchObject({ state: 'lost', phase: 'review' })
    expect(later.stalled).toBeNull()
  })

  it('the gap between the lease and stallMinutes is neutral: idle, not working, lost or stalled', () => {
    const t = buildLiveness([event('heartbeat', '10:00')], '10:11')
    expect(t.liveness?.state).toBe('idle')
    expect(t.stalled).toBeNull()
    // Both ends: the lease is live a minute inside it, and the stall starts a minute past the threshold.
    expect(buildLiveness([event('heartbeat', '10:00')], '10:09').liveness?.state).toBe('working')
    expect(buildLiveness([event('heartbeat', '10:00')], '10:31').liveness?.state).toBe('stalled')
  })

  it('heartbeat boundaries: working through TTL-1, lost at TTL+1 with an open span, stalled past stallMinutes without one', () => {
    expect(TTL).toBe(10 * MIN)
    const span = [spanStart('10:00'), event('heartbeat', '10:00')]
    expect(buildLiveness(span, '10:09').liveness?.state).toBe('working')
    expect(buildLiveness(span, '10:11').liveness?.state).toBe('lost')
    const noSpan = [event('heartbeat', '10:00')]
    expect(buildLiveness(noSpan, '10:09').liveness?.state).toBe('working')
    expect(buildLiveness(noSpan, '10:11').liveness?.state).toBe('idle')
    expect(buildLiveness(noSpan, '10:31').liveness?.state).toBe('stalled')
  })

  it('an agent post refreshes the lease; an old one leaves the state to the spans', () => {
    const live = buildLiveness([spanStart('10:00')], '10:09', { posts: [post('10:00')] })
    expect(live.liveness?.state).toBe('working')
    const expired = buildLiveness([spanStart('09:00')], '10:00', { posts: [post('09:49')] })
    expect(expired.liveness?.state).toBe('lost')
    // A human's post is not a signal: it proves a person spoke, not that the run is alive.
    const human = buildLiveness([spanStart('09:00')], '10:00', { posts: [post('09:59', 'human', true)] })
    expect(human.liveness?.state).toBe('lost')
    expect(human.lastSignalAt).toBe(at('09:00'))
  })

  it('waiting on the human outranks the rest, from each of its facts', () => {
    expect(buildLiveness([event('wait_start', '10:00', { reason: 'human' })], '10:01').liveness?.state).toBe(
      'waiting',
    )
    expect(
      buildLiveness([event('heartbeat', '10:00')], '10:01', { waiting: { decision: true } }).liveness?.state,
    ).toBe('waiting')
    expect(
      buildLiveness([event('heartbeat', '10:00')], '10:01', { waiting: { blockedTask: true } }).liveness
        ?.state,
    ).toBe('waiting')
    // Waiting is not a stall, and an open span does not change that.
    const waitAndSpan = buildLiveness(
      [spanStart('10:00'), event('wait_start', '10:05', { reason: 'human' })],
      '11:00',
    )
    expect(waitAndSpan.liveness?.state).toBe('waiting')
    expect(waitAndSpan.stalled).toBeNull()
  })

  it('an open span never reads stalled: with every signal older than the lease it is lost', () => {
    const t = buildLiveness([spanStart('10:00')], '11:00')
    expect(t.stalled).toBeNull()
    expect(t.liveness?.state).toBe('lost')
    expect(t.liveness?.spans).toEqual([
      { phase: 'review', agent: 'claude', since: at('10:00'), lastWordAt: at('10:00'), silentMinutes: 60 },
    ])
  })

  it('keeps a per-agent last word for every open span, falling back to the ticket last word', () => {
    const events = [
      spanStart('10:00', { agent: 'builder', by: 'orch' }),
      spanStart('10:10', { agent: 'claude', by: 'orch' }),
      event('heartbeat', '10:20', { agent: 'claude', by: 'orch' }),
      event('heartbeat', '10:30', { agent: 'claude', by: 'orch' }),
    ]
    const t = buildLiveness(events, '10:31')
    const spans = t.liveness!.spans
    expect(spans.map((s) => [s.agent, s.lastWordAt, s.silentMinutes])).toEqual([
      ['builder', at('10:00'), 31],
      ['claude', at('10:30'), 1],
    ])
    expect(t.liveness?.lastWordAt).toBe(at('10:30'))
  })

  it('gives no state to tickets outside an active stage, archived ones or a PR ticket', () => {
    for (const t of [
      { status: 'review' },
      { status: 'blocked' },
      { status: 'done' },
      { archivedAt: at('10:00') },
      { prId: 3 },
    ])
      expect(buildLiveness([spanStart('10:00')], '11:00', {}, t).liveness).toBeNull()
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
