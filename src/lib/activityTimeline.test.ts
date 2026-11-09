import { describe, expect, it } from 'vitest'

import type { StageLike } from './stages'
import type { Activity, Stalled } from './workTimeline'
import { hasWork, nowBrief, nowWords, stallStage, timelineFromActivity } from './activityTimeline'
import { stallReason } from './workStatus'

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

  it('an open span with its agent silent is the why when nothing waits', () => {
    const t = timelineFromActivity(
      { ...NONE, spans: [{ phase: 'build', agent: 'claude', since: at('11:00') }] },
      stalled(at('11:00')),
    )
    expect(stallReason(t)).toMatchObject({ kind: 'working', agent: 'claude', phase: 'build' })
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

describe('nowWords and nowBrief', () => {
  it('a building span reads as the verb, the agent and how long', () => {
    const t = timelineFromActivity(
      { ...NONE, spans: [{ phase: 'build', agent: 'claude', since: at('11:47') }] },
      null,
    )
    expect(nowWords(t, NOW)).toBe('Building · claude · 43 min')
    expect(nowBrief(t, NOW)).toEqual({ kind: 'building', text: '43 min' })
  })

  it('a human wait reads as waiting on you since its start, timed as how long it has run', () => {
    const t = timelineFromActivity(
      { ...NONE, waits: [{ reason: 'human', agent: 'claude', on: null, since: at('12:00') }] },
      null,
    )
    expect(nowWords(t, NOW)).toMatch(/^Waiting on you for 30 min since /)
    expect(nowBrief(t, NOW)).toEqual({ kind: 'waiting-human', text: '30 min' })
  })

  it('nothing open reads as nothing, with no compact mark', () => {
    const t = timelineFromActivity(NONE, null)
    expect(nowWords(t, NOW)).toBe('Nothing open')
    expect(nowBrief(t, NOW)).toBeNull()
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
