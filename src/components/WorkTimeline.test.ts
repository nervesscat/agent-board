import { describe, expect, it } from 'vitest'

import { DEFAULT_STAGES } from '#/lib/constants'
import { clock } from '#/lib/format'
import { buildTimeline, type TimelineEvent, type TimelineTicket } from '#/lib/workTimeline'

import { spanLabel, waitLabel } from './WorkTimeline'

const at = (hhmm: string, day = '2026-10-20') => `${day}T${hhmm}:00.000Z`

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

// A build span and a lock wait started and never closed, then the ticket moved to done at 12:00.
const events = () => [
  event('span_start', '10:00', { phase: 'build' }),
  event('wait_start', '10:30', { reason: 'lock' }),
  event('stage', '12:00', { agent: 'board', by: 'board', fromStage: 'in_progress', toStage: 'done' }),
]

describe('segment labels', () => {
  it('give an open segment its end time, not "now", once the ticket is no longer live', () => {
    // Viewed days later: the bar and its footer end at the last event, 12:00.
    const t = buildTimeline(events(), {
      now: Date.parse(at('12:00', '2026-10-24')),
      stages: DEFAULT_STAGES,
      ticket: ticket({ status: 'done' }),
      stallMinutes: 30,
    })
    expect(t.live).toBe(false)
    const [span] = t.spans
    const [wait] = t.waits
    expect(span!.open).toBe(true)
    expect(span!.end).toBe(at('12:00'))
    expect(spanLabel(span!, t.live)).toBe(
      `build by claude, ${clock(at('10:00'))} to ${clock(at('12:00'))}, 2 h, open`,
    )
    expect(waitLabel(wait!, t.live)).toBe(
      `wait: lock (claude), ${clock(at('10:30'))} to ${clock(at('12:00'))}, 1 h 30 min, open`,
    )
  })

  it('say "now" for an open segment while the ticket is live', () => {
    const t = buildTimeline(events().slice(0, 2), {
      now: Date.parse(at('11:00')),
      stages: DEFAULT_STAGES,
      ticket: ticket(),
      stallMinutes: 30,
    })
    expect(t.live).toBe(true)
    expect(spanLabel(t.spans[0]!, t.live)).toBe(`build by claude, ${clock(at('10:00'))} to now, 1 h, open`)
    expect(waitLabel(t.waits[0]!, t.live)).toBe(
      `wait: lock (claude), ${clock(at('10:30'))} to now, 30 min, open`,
    )
  })
})
