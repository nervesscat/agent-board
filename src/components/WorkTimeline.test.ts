import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { DEFAULT_STAGES } from '#/lib/constants'
import { clock, stamp } from '#/lib/format'
import { buildTimeline, type TimelineEvent, type TimelineTicket } from '#/lib/workTimeline'

import { collapsedLabel, spanLabel, waitLabel, WorkTimelineBar } from './WorkTimeline'

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

describe('collapsed periods on the chart', () => {
  const day = (n: number) => `2026-11-${String(10 + n).padStart(2, '0')}`
  const moved = (time: string, d: number, from: string, to: string) => ({
    ...event('stage', time, { agent: 'board', by: 'board', fromStage: from, toStage: to }),
    at: at(time, day(d)),
  })
  const reviewed = () => {
    const opened = event('span_start', '09:00', { phase: 'build' })
    const evs = [
      { ...opened, at: at('09:00', day(0)) },
      { ...event('span_end', '10:00', { phase: 'build', refId: opened.id }), at: at('10:00', day(0)) },
      moved('10:00', 0, 'in_progress', 'review'),
      moved('09:30', 5, 'review', 'done'),
    ]
    return buildTimeline(evs, {
      now: Date.parse(at('12:00', day(6))),
      stages: DEFAULT_STAGES,
      ticket: ticket({ status: 'done', createdAt: at('08:00', day(0)) }),
      stallMinutes: 30,
    })
  }

  it('words a period with its real start, end and length, and that it is not to scale', () => {
    const t = reviewed()
    expect(t.reviewStretches).toHaveLength(1)
    const [r] = t.reviewStretches
    const label = collapsedLabel({
      label: 'In review',
      start: Date.parse(r!.start),
      end: Date.parse(r!.end),
      open: false,
    })
    expect(label).toBe(
      `In review, ${stamp(r!.start)} to ${stamp(r!.end)}, 4 d 23 h 30 min, not drawn to scale`,
    )
    expect(collapsedLabel({ label: 'Blocked', start: 0, end: 90 * 60_000, open: true })).toMatch(
      /^Blocked, .* to now, 1 h 30 min, not drawn to scale$/,
    )
  })

  it('draws an In review chip with that label, its real times in the name and a break mark', () => {
    const html = renderToStaticMarkup(createElement(WorkTimelineBar, { timeline: reviewed() }))
    expect(html).toContain('data-kind="review"')
    expect(html).toContain('aria-label="In review, ')
    expect(html).toContain('4 d 23 h 30 min, not drawn to scale')
    expect(html).toContain('>In review</span></button>')
    expect(html).toContain('data-kind="axis-break"')
    expect(html).toContain('Not to scale: in review 4 d 23 h 30 min.')
  })

  it('leaves a break mark out near the right end of a live axis, where the now label is', () => {
    // Ten hours of work, then a live review: the block's break mark is at 98% of the axis.
    const opened = event('span_start', '09:00', { phase: 'build' })
    const evs = [
      { ...opened, at: at('09:00', day(0)) },
      { ...event('span_end', '19:00', { phase: 'build', refId: opened.id }), at: at('19:00', day(0)) },
      moved('19:00', 0, 'in_progress', 'review'),
    ]
    const timeline = (live: boolean) =>
      buildTimeline(live ? evs : [...evs, moved('09:00', 3, 'review', 'done')], {
        now: Date.parse(at('12:00', day(3))),
        stages: DEFAULT_STAGES,
        ticket: ticket({ status: live ? 'review' : 'done', createdAt: at('08:00', day(0)) }),
        stallMinutes: 30,
      })
    const html = renderToStaticMarkup(createElement(WorkTimelineBar, { timeline: timeline(true) }))
    expect(html).toContain('>now<')
    expect(html).not.toContain('data-kind="axis-break"')
    // Not live: the same break is drawn.
    expect(renderToStaticMarkup(createElement(WorkTimelineBar, { timeline: timeline(false) }))).toContain(
      'data-kind="axis-break"',
    )
  })

  it('does not draw a tick label a break mark would overdraw, and keeps the others', () => {
    // Work 09:00-10:00, merged at 12:00: the axis ends at the merge, whose round-time tick sits at the gap.
    const opened = event('span_start', '09:00', { phase: 'build' })
    const evs = [
      opened,
      event('span_end', '10:00', { phase: 'build', refId: opened.id }),
      event('merge', '12:00'),
    ]
    const t = buildTimeline(evs, {
      now: Date.parse(at('12:00')),
      stages: DEFAULT_STAGES,
      ticket: ticket({ status: 'done', createdAt: at('08:00') }),
      stallMinutes: 30,
    })
    const html = renderToStaticMarkup(createElement(WorkTimelineBar, { timeline: t }))
    expect(html).toContain('data-kind="axis-break"')
    expect(html).toContain(`>${clock(at('09:00'))}<`)
    expect(html).not.toContain(`>${clock(at('12:00'))}<`)
    expect(html).not.toContain(`>${clock(at('10:00'))}<`)
  })
})

describe('the chart fits its track', () => {
  it('keeps a hand-off line, its arrow and every box inside the track at the very end of the axis', () => {
    // A hand-off at the last moment of the axis: its line would be drawn at the right edge, 1 px outside.
    const opened = event('span_start', '09:00', { phase: 'build' })
    const evs = [
      opened,
      event('span_end', '10:00', { phase: 'build', refId: opened.id }),
      event('handoff', '10:00', { agent: 'claude', fromAgent: 'claude', toAgent: 'builder' }),
    ]
    const t = buildTimeline(evs, {
      now: Date.parse(at('10:00')),
      stages: DEFAULT_STAGES,
      ticket: ticket({ status: 'done', createdAt: at('09:00') }),
      stallMinutes: 30,
    })
    const html = renderToStaticMarkup(createElement(WorkTimelineBar, { timeline: t }))
    const lines = [...html.matchAll(/data-kind="handoff-line"[^>]*style="left:([^;"]*)/g)].map((x) => x[1])
    expect(lines.length).toBeGreaterThan(0)
    for (const left of lines) expect(left).toBe('clamp(8px, 100%, calc(100% - 8px))')
    // No left in the markup is a bare percentage of 100% or more: each is clamped or kept inside by a min().
    for (const left of html.matchAll(/left:([^;"]*)/g))
      expect(left[1]).not.toMatch(/^(100|[1-9]\d\d+)(\.\d+)?%$/)
  })
})

describe('a ticket that only waits on the human', () => {
  it('draws its pending decision card as a block, not as no work', () => {
    const t = buildTimeline(
      [
        event('stage', '09:00', { agent: 'board', by: 'board', toStage: 'todo' }),
        event('stage', '09:05', { agent: 'board', by: 'board', fromStage: 'todo', toStage: 'in_progress' }),
      ],
      {
        now: Date.parse(at('12:00')),
        stages: DEFAULT_STAGES,
        ticket: ticket(),
        stallMinutes: 30,
        decisions: [{ at: at('09:10'), decidedAt: null }],
      },
    )
    const html = renderToStaticMarkup(createElement(WorkTimelineBar, { timeline: t }))
    expect(html).not.toContain('No work recorded yet')
    expect(html).toContain('data-kind="human"')
    expect(html).toContain('Waiting for a decision')
  })
})
