import { describe, expect, it } from 'vitest'

import type { StageLike } from './stages'
import type { Activity, Stalled } from './workTimeline'
import { hasWork, rowWorkLine, stallStage, timelineFromActivity } from './activityTimeline'
import { lostContact, stallReason, workLine } from './workStatus'

const at = (hhmm: string) => `2026-10-20T${hhmm}:00.000Z`
const NOW = Date.parse(at('12:30'))
const stalled = (since: string, minutes = 40): Stalled => ({
  since,
  minutes,
  lastAgent: 'claude',
  lastBy: '',
  lastFrom: 'event',
})
const NONE: Activity = { spans: [], waits: [], lastHeard: null }

describe('timelineFromActivity', () => {
  it('carries the open spans and waits, the last heard and the stall; nothing is closed', () => {
    const t = timelineFromActivity(
      {
        spans: [{ phase: 'build', agent: 'claude', since: at('11:50') }],
        waits: [{ reason: 'human', agent: 'claude', on: null, since: at('12:00') }],
        lastHeard: {
          at: at('11:55'),
          agent: 'claude',
          by: '',
          kind: 'heartbeat',
          phase: '',
          reason: '',
          note: 'x',
        },
      },
      stalled(at('11:55')),
    )
    expect(t.live).toBe(true)
    expect(t.spans).toEqual([expect.objectContaining({ phase: 'build', agent: 'claude', open: true })])
    expect(t.waits).toEqual([expect.objectContaining({ reason: 'human', on: null, open: true })])
    expect(t.lastHeard?.note).toBe('x')
    expect(t.stalled?.minutes).toBe(40)
    expect(t.totals).toEqual({ workingMs: 0, waitingMs: 0, blockedOnHumanMs: 0 })
  })

  it('is empty without an activity or a stall', () => {
    const t = timelineFromActivity(undefined, null, false)
    expect(t).toMatchObject({ spans: [], waits: [], lastHeard: null, stalled: null, live: false })
  })
})

describe('the why of a stall comes from the activity', () => {
  it('an open human or agent wait is the why', () => {
    const t = timelineFromActivity(
      { ...NONE, waits: [{ reason: 'lock', agent: 'claude', on: 'builder-1', since: at('12:00') }] },
      stalled(at('12:00')),
    )
    expect(stallReason(t)).toMatchObject({ kind: 'waiting', on: 'builder-1', reason: 'lock' })
  })

  it('an open span is never a stall: with an expired lease it reads Lost contact', () => {
    const t = timelineFromActivity(
      { ...NONE, spans: [{ phase: 'build', agent: 'claude', since: at('11:00') }] },
      stalled(at('11:00')),
    )
    // A stalled activity has nothing open, so the why cannot name a working span.
    expect(stallReason(t)).toMatchObject({ kind: 'nothing-open' })
    const lost = timelineFromActivity(
      {
        ...NONE,
        spans: [{ phase: 'build', agent: 'claude', since: at('11:00') }],
        liveness: {
          state: 'lost',
          agent: 'claude',
          phase: 'build',
          since: at('11:00'),
          lastSignalAt: at('11:00'),
          lastWordAt: at('11:30'),
          silentMinutes: 26,
          spans: [
            {
              phase: 'build',
              agent: 'claude',
              since: at('11:00'),
              lastWordAt: at('11:30'),
              silentMinutes: 26,
            },
          ],
        },
      },
      null,
    )
    expect(lostContact(lost)).toMatchObject({ agent: 'claude', phase: 'build', silentMinutes: 26 })
  })

  it('with nothing open, the why says nothing is open since the last signal', () => {
    const t = timelineFromActivity(NONE, stalled(at('11:20')))
    expect(stallReason(t)).toMatchObject({ kind: 'nothing-open', since: at('11:20'), endedAt: null })
  })

  it('with nothing open, the why dates the span that ended last, when the activity names one', () => {
    const activity: Activity = {
      ...NONE,
      lastClosedSpan: { phase: 'build', agent: 'claude', start: at('11:50'), end: at('12:08') },
    }
    const t = timelineFromActivity(activity, stalled(at('12:08')))
    expect(stallReason(t)).toMatchObject({ kind: 'nothing-open', endedAt: at('12:08'), phase: 'build' })
  })

  it('a ticket that is not stalled has no why', () => {
    expect(stallReason(timelineFromActivity(NONE, null))).toBeNull()
  })
})

describe('the facts the one work-state line reads', () => {
  it('a building activity words Working now on its own agent’s last word', () => {
    const t = timelineFromActivity(
      {
        ...NONE,
        spans: [{ phase: 'build', agent: 'claude', since: at('11:47') }],
        liveness: {
          state: 'working',
          agent: 'claude',
          phase: 'build',
          since: at('11:47'),
          lastSignalAt: at('12:28'),
          lastWordAt: at('12:18'),
          silentMinutes: 12,
          spans: [
            {
              phase: 'build',
              agent: 'claude',
              since: at('11:47'),
              lastWordAt: at('12:18'),
              silentMinutes: 12,
            },
          ],
        },
        stage: { key: 'in_progress', kind: 'active', since: at('11:00') },
        progressAt: at('12:18'),
        waitingOnHuman: false,
      },
      null,
    )
    expect(workLine(t, NOW)).toMatchObject({ state: 'working', text: 'Working now · last word 12m' })
    expect(workLine(t, NOW)?.detail).toEqual(['claude · build · 43 min · last word 12 min ago'])
  })

  it('an open human wait carried on the activity words Waiting on you', () => {
    const t = timelineFromActivity(
      {
        ...NONE,
        waits: [{ reason: 'human', agent: 'claude', on: null, since: at('12:00') }],
        liveness: {
          state: 'waiting',
          agent: 'claude',
          phase: 'spec',
          since: at('12:00'),
          lastSignalAt: at('12:00'),
          lastWordAt: at('12:00'),
          silentMinutes: 30,
          spans: [],
        },
        stage: { key: 'in_progress', kind: 'active', since: at('11:00') },
        progressAt: at('12:00'),
        waitingOnHuman: true,
      },
      null,
    )
    expect(workLine(t, NOW)).toMatchObject({ state: 'waiting', text: 'Waiting on you' })
  })

  it('carries a review stage into Your turn, and says nothing open for an idle activity', () => {
    const review = timelineFromActivity(
      { ...NONE, stage: { key: 'review', kind: 'review', since: at('10:30') } },
      null,
    )
    expect(workLine(review, NOW)).toMatchObject({ state: 'your-turn', text: 'Your turn · waiting 2h' })
    const idle = timelineFromActivity(
      {
        ...NONE,
        stage: { key: 'in_progress', kind: 'active', since: at('11:00') },
        liveness: {
          state: 'idle',
          agent: 'claude',
          phase: '',
          since: at('12:20'),
          lastSignalAt: at('12:20'),
          lastWordAt: at('12:20'),
          silentMinutes: 10,
          spans: [],
        },
        progressAt: at('12:20'),
      },
      null,
    )
    expect(workLine(idle, NOW)).toMatchObject({ state: 'nothing', text: 'Nothing open' })
  })
})

describe('stallStage and hasWork', () => {
  const stage = (key: string, kind: StageLike['kind'], name = key): StageLike => ({
    key,
    name,
    kind,
    color: 'gray',
  })
  const stages = [
    stage('todo', 'open'),
    stage('doing', 'active', 'Doing'),
    stage('review', 'review', 'Review'),
  ]

  it('names the stage of a stall only when it is not the first active one', () => {
    expect(stallStage(stages, 'doing')).toBeNull()
    expect(stallStage(stages, 'review')).toBe('Review')
    expect(stallStage(stages, 'gone')).toBeNull()
  })

  it('has work in active, blocked and review stages only', () => {
    expect(hasWork('active')).toBe(true)
    expect(hasWork('blocked')).toBe(true)
    expect(hasWork('review')).toBe(true)
    expect(hasWork('open')).toBe(false)
    expect(hasWork('done')).toBe(false)
  })
})

describe('rowWorkLine', () => {
  const stages: StageLike[] = [
    { key: 'todo', name: 'To do', kind: 'open', color: 'gray' },
    { key: 'in_progress', name: 'In progress', kind: 'active', color: 'gray' },
    { key: 'done', name: 'Done', kind: 'done', color: 'gray' },
  ]
  it('has no line for a row whose stage is not open work, and a line for one in progress', () => {
    const row = { activity: null, stalled: null }
    expect(rowWorkLine({ ...row, status: 'done' }, stages)).toBeNull()
    expect(rowWorkLine({ ...row, status: 'todo' }, stages)).toBeNull()
    expect(rowWorkLine({ ...row, status: 'in_progress' }, stages)?.state).toBe('nothing')
  })
})
