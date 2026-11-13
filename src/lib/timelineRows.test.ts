import { describe, expect, it } from 'vitest'

import {
  type ChartWait,
  agentTree,
  axisFor,
  buildChart,
  NARROW_SHARE,
  packLanes,
  shortName,
  spokenDuration,
  ticksFor,
  tickStep,
} from './timelineRows'
import type { TimelineHandoff, TimelineSpan, WorkTimeline } from './workTimeline'

const iso = (hhmm: string) => `2026-10-20T${hhmm}:00.000Z`
const ms = (hhmm: string) => Date.parse(iso(hhmm))
const MIN = 60_000

const span = (
  id: number,
  agent: string,
  by: string,
  start: string,
  end: string,
  more: Partial<TimelineSpan> = {},
): TimelineSpan => ({
  id,
  phase: 'build',
  round: null,
  agent,
  by,
  start: iso(start),
  end: iso(end),
  open: false,
  ...more,
})

const wait = (
  id: number,
  agent: string,
  start: string,
  end: string,
  more: Partial<ChartWait> = {},
): ChartWait => ({
  id,
  reason: 'lock',
  agent,
  on: null,
  note: '',
  start: iso(start),
  end: iso(end),
  open: false,
  ...more,
})

const handoff = (id: number, from: string, to: string, at: string): TimelineHandoff => ({
  id,
  at: iso(at),
  from,
  to,
  note: '',
})

const timeline = (more: Partial<WorkTimeline> = {}): WorkTimeline => ({
  now: iso('11:00'),
  start: iso('10:00'),
  end: iso('11:00'),
  live: false,
  spans: [],
  waits: [],
  handoffs: [],
  marks: [],
  blockedStretches: [],
  totals: { workingMs: 0, waitingMs: 0, blockedOnHumanMs: 0 },
  lastSignalAt: iso('10:00'),
  lastWordAt: iso('10:00'),
  liveness: null,
  lastHeard: null,
  stalled: null,
  stage: { key: 'in_progress', kind: 'active', since: iso('10:00') },
  progressAt: iso('10:00'),
  waitingOnHuman: false,
  ...more,
})

describe('agent rows', () => {
  it('nests a sub-agent under the agent that recorded its span, parents first', () => {
    const t = timeline({
      spans: [
        span(1, 'builder-sub-1', 'orchestrator', '10:05', '10:30'),
        span(2, 'orchestrator', 'orchestrator', '10:00', '10:05'),
      ],
    })
    expect(agentTree(t)).toEqual([
      { agent: 'orchestrator', parent: null, depth: 0 },
      { agent: 'builder-sub-1', parent: 'orchestrator', depth: 1 },
    ])
  })

  it('nests by the hand-off when the sub-agent recorded its own span', () => {
    const t = timeline({
      spans: [span(1, 'builder', 'builder', '10:05', '10:30')],
      handoffs: [handoff(2, 'orchestrator', 'builder', '10:04')],
    })
    expect(agentTree(t)).toEqual([
      { agent: 'orchestrator', parent: null, depth: 0 },
      { agent: 'builder', parent: 'orchestrator', depth: 1 },
    ])
  })

  it('puts an agent whose recorder has no row at depth 0', () => {
    const t = timeline({ spans: [span(1, 'builder', 'claude', '10:05', '10:30')] })
    expect(agentTree(t)).toEqual([{ agent: 'builder', parent: null, depth: 0 }])
  })

  it('breaks a cycle where it closes, so every agent is listed once', () => {
    const t = timeline({
      spans: [span(1, 'a', 'b', '10:00', '10:10'), span(2, 'b', 'a', '10:02', '10:12')],
    })
    const tree = agentTree(t)
    expect(tree.map((r) => r.agent).sort()).toEqual(['a', 'b'])
    expect(tree.filter((r) => r.depth === 0)).toHaveLength(1)
    expect(tree[1]!.depth).toBe(1)
  })

  it('keeps an agent that only hangs off a cycle under its parent', () => {
    const t = timeline({
      spans: [span(1, 'a', 'b', '10:03', '10:10')],
      handoffs: [handoff(2, 'b', 'c', '10:01'), handoff(3, 'c', 'b', '10:02')],
    })
    const tree = agentTree(t)
    const depthOf = (name: string) => tree.find((r) => r.agent === name)!
    expect(depthOf('a').parent).toBe('b')
    expect(depthOf('a').depth).toBe(depthOf('b').depth + 1)
    expect(tree.map((r) => r.agent).sort()).toEqual(['a', 'b', 'c'])
  })

  it('orders siblings by their first event', () => {
    const t = timeline({
      spans: [
        span(1, 'lead', 'lead', '10:00', '10:01'),
        span(2, 'second', 'lead', '10:20', '10:30'),
        span(3, 'first', 'lead', '10:10', '10:15'),
      ],
    })
    expect(agentTree(t).map((r) => r.agent)).toEqual(['lead', 'first', 'second'])
  })

  it('shortens a long name to its last path part', () => {
    expect(shortName('orch/builder-with-a-long-sub-identity/importer')).toBe('importer')
    expect(shortName('a-very-long-agent-name-that-goes-on')).toMatch(/…$/)
    expect(shortName('builder')).toBe('builder')
  })
})

describe('delegation and hand-offs', () => {
  it("draws a wait with `on` on the waiting agent's row as delegated, and not as a plain wait", () => {
    const t = timeline({
      spans: [span(1, 'builder-sub-1', 'orchestrator', '10:00', '10:50')],
      waits: [wait(2, 'orchestrator', '10:00', '10:50', { reason: 'builder', on: 'builder-sub-1' })],
      end: iso('10:50'),
    })
    const chart = buildChart(t, ms('10:50'))
    const orch = chart.rows.find((r) => r.agent === 'orchestrator')!
    const builder = chart.rows.find((r) => r.agent === 'builder-sub-1')!
    expect(orch.items.map((i) => [i.kind, i.kind === 'wait' && i.delegated])).toEqual([['wait', true]])
    expect(builder.items.map((i) => i.kind)).toEqual(['span'])
  })

  it('keeps a plain wait (no `on`) undelegated, and a human wait too', () => {
    const t = timeline({
      waits: [wait(1, 'a', '10:00', '10:10'), wait(2, 'a', '10:20', '10:30', { reason: 'human', on: '' })],
    })
    const row = buildChart(t, ms('11:00')).rows[0]!
    expect(row.items.map((i) => i.kind === 'wait' && i.delegated)).toEqual([false, false])
  })

  it('puts a hand-off arrow on the row it lands on and a line from the row it leaves', () => {
    const t = timeline({
      spans: [span(1, 'builder', 'builder', '10:10', '10:30'), span(2, 'lead', 'lead', '10:00', '10:40')],
      handoffs: [handoff(3, 'lead', 'builder', '10:10')],
    })
    const chart = buildChart(t, ms('11:00'))
    const lead = chart.rows.findIndex((r) => r.agent === 'lead')
    const builder = chart.rows.findIndex((r) => r.agent === 'builder')
    expect(chart.rows[builder]!.arrows.map((a) => a.handoff.id)).toEqual([3])
    expect(chart.rows[lead]!.arrows).toEqual([])
    const [lo, hi] = [Math.min(lead, builder), Math.max(lead, builder)]
    expect(lo).not.toBe(hi)
    expect(chart.rows[lo]!.connectors).toHaveLength(1)
    expect(chart.rows[hi]!.connectors).toHaveLength(1)
  })

  it('runs a hand-off line through the rows between its ends', () => {
    // lead, with builder under it; q, with x under it. The hand-off from lead to x crosses builder and q.
    const t = timeline({
      spans: [
        span(1, 'lead', 'lead', '10:00', '10:10'),
        span(2, 'builder', 'lead', '10:02', '10:08'),
        span(3, 'q', 'q', '10:01', '10:10'),
        span(4, 'x', 'q', '10:03', '10:09'),
      ],
      handoffs: [handoff(5, 'lead', 'x', '10:05')],
    })
    const chart = buildChart(t, ms('11:00'))
    expect(chart.rows.map((r) => r.agent)).toEqual(['lead', 'builder', 'q', 'x'])
    expect(chart.rows.map((r) => r.connectors.length)).toEqual([1, 1, 1, 1])
    expect(chart.rows[3]!.arrows.map((a) => a.handoff.id)).toEqual([5])
  })
})

describe('the axis and ticks', () => {
  it('starts at the first agent event, and a ticket created earlier marks its creation', () => {
    const t = timeline({
      start: iso('09:00'),
      spans: [span(1, 'builder', 'builder', '09:12', '09:40')],
      end: iso('09:40'),
    })
    const axis = axisFor(t, ms('09:40'))
    expect(axis.start).toBe(ms('09:12'))
    const chart = buildChart(t, ms('09:40'))
    expect(chart.created).toEqual({ minutes: 12, left: 0 })
  })

  it('has no creation mark for a lead under a minute, even one of 59 seconds', () => {
    const created = Date.parse(iso('09:00'))
    const t = timeline({
      start: new Date(created).toISOString(),
      spans: [span(1, 'builder', 'builder', new Date(created + 59_000).toISOString(), '09:30')],
      end: iso('09:30'),
    })
    expect(buildChart(t, ms('09:30')).created).toBeNull()
  })

  it('has no creation mark when the first event is the first work', () => {
    const t = timeline({ spans: [span(1, 'builder', 'builder', '10:00', '10:30')], end: iso('10:30') })
    expect(buildChart(t, ms('10:30')).created).toBeNull()
  })

  it('ends at now on a live ticket, and a window overrides the axis', () => {
    const t = timeline({
      spans: [span(1, 'builder', 'builder', '10:00', '10:30', { open: true })],
      live: true,
      end: iso('10:30'),
    })
    expect(axisFor(t, ms('10:45')).end).toBe(ms('10:45'))
    const win = axisFor(t, ms('10:45'), { start: iso('09:00'), end: iso('12:00') })
    expect(win.start).toBe(ms('09:00'))
    expect(win.end).toBe(ms('12:00'))
  })

  it('picks a step that gives about four to six ticks', () => {
    expect(tickStep(43 * MIN)).toBe(10 * MIN)
    expect(tickStep(10 * MIN)).toBe(2 * MIN)
    expect(tickStep(2 * 60 * MIN)).toBe(30 * MIN)
    expect(tickStep(3 * 24 * 60 * MIN)).toBe(24 * 60 * MIN)
    for (const span of [5, 17, 43, 90, 240, 600]) {
      const n = ticksFor(ms('10:00'), ms('10:00') + span * MIN).length
      expect(n).toBeGreaterThanOrEqual(3)
      expect(n).toBeLessThanOrEqual(6)
    }
  })

  it('draws ticks on round times within the axis', () => {
    const start = ms('10:03')
    const ticks = ticksFor(start, ms('10:50'))
    for (const t of ticks) {
      expect(t.at).toBeGreaterThanOrEqual(start)
      expect(t.at).toBeLessThanOrEqual(ms('10:50'))
    }
    expect(ticks.length).toBeGreaterThan(0)
  })
})

describe('segments', () => {
  it('marks a segment under the narrow share of the axis as narrow', () => {
    const t = timeline({
      spans: [span(1, 'a', 'a', '10:00', '11:00'), span(2, 'b', 'b', '10:00', '10:01')],
      end: iso('11:00'),
    })
    const chart = buildChart(t, ms('11:00'))
    const long = chart.rows[0]!.items[0]!
    const short = chart.rows[1]!.items[0]!
    expect(long.kind === 'span' && long.seg.narrow).toBe(false)
    expect(short.kind === 'span' && short.seg.narrow).toBe(true)
    expect(short.seg.width).toBeLessThan(NARROW_SHARE)
  })

  it("packs one agent's overlapping spans and waits into sub-lanes of its row", () => {
    const t = timeline({
      spans: [span(1, 'a', 'a', '10:00', '10:30'), span(2, 'a', 'a', '10:10', '10:20')],
      waits: [wait(3, 'a', '10:05', '10:15')],
      end: iso('10:30'),
    })
    const row = buildChart(t, ms('10:30')).rows[0]!
    expect(row.lanes).toBe(3)
    const lanes = row.items.map((i) => i.lane)
    expect(new Set(lanes).size).toBe(3)
  })

  it('packs intervals into the first free lane', () => {
    expect(
      packLanes([
        [0, 10],
        [10, 20],
        [5, 15],
      ]),
    ).toEqual({ lane: [0, 0, 1], count: 2 })
    expect(packLanes([])).toEqual({ lane: [], count: 0 })
  })

  it('draws the blocked stages as bands, and clips them to the axis', () => {
    const t = timeline({
      spans: [span(1, 'a', 'a', '10:00', '10:30')],
      blockedStretches: [{ start: iso('10:10'), end: iso('10:20') }],
      end: iso('10:30'),
    })
    const chart = buildChart(t, ms('10:30'))
    expect(chart.bands).toHaveLength(1)
    expect(chart.bands[0]!.seg.left).toBeCloseTo(1 / 3, 2)
  })
})

describe('the summary sentence', () => {
  it('says who worked and waited, for how long, and on what', () => {
    const t = timeline({
      spans: [span(1, 'builder', 'orchestrator', '10:00', '10:43')],
      waits: [wait(2, 'orchestrator', '10:00', '10:44', { reason: 'builder', on: 'builder' })],
      end: iso('10:44'),
    })
    expect(buildChart(t, ms('10:44')).summary).toBe(
      'Work by 1 agent over 44 min: orchestrator waited 44 min on builder, delegated; builder worked 43 min.',
    )
  })

  it('names the human and says when the ticket is still going', () => {
    const t = timeline({
      spans: [span(1, 'builder', 'builder', '10:00', '10:20')],
      waits: [wait(2, 'builder', '10:20', '10:30', { reason: 'human' })],
      live: true,
      end: iso('10:30'),
    })
    expect(buildChart(t, ms('10:30')).summary).toBe(
      'Work by 1 agent over 30 min: builder worked 20 min, waited 10 min on the human. Still going.',
    )
  })

  it('reads a ticket with no agent work as such', () => {
    const t = timeline({ marks: [{ id: 1, kind: 'push', at: iso('10:05'), note: '' }] })
    expect(buildChart(t, ms('11:00')).summary).toBe('No agent work recorded.')
    expect(buildChart(timeline({ start: null, end: null }), ms('11:00')).summary).toBe(
      'No work recorded yet.',
    )
  })
})

describe('durations', () => {
  it('spells a duration in words', () => {
    expect(spokenDuration(0)).toBe('under a minute')
    expect(spokenDuration(38 * MIN)).toBe('38 min')
    expect(spokenDuration(125 * MIN)).toBe('2 h 5 min')
    expect(spokenDuration(120 * MIN)).toBe('2 h')
  })
})

describe('the creation mark', () => {
  it('measures from the creation to the first agent event, on a window that starts after the creation', () => {
    // Created three days before the window's end; the first agent event 71 hours after the creation.
    const created = Date.parse('2026-10-17T10:00:00.000Z')
    const firstWork = created + 71 * 60 * MIN
    const t = timeline({
      start: new Date(created).toISOString(),
      spans: [span(1, 'builder', 'builder', new Date(firstWork).toISOString().slice(11, 16), '23:00')],
      end: iso('23:00'),
    })
    // The window opens two days before the creation's first event: the creation is inside it.
    const win = { start: new Date(created - 2 * 24 * 60 * MIN).toISOString(), end: iso('23:00') }
    const chart = buildChart(t, ms('23:00'), win)
    expect(chart.created?.minutes).toBe(71 * 60)
    expect(chart.created?.left).toBeCloseTo(
      (created - Date.parse(win.start)) / (Date.parse(win.end) - Date.parse(win.start)),
      6,
    )
  })

  it('is pinned to the left edge when the creation is before the window', () => {
    const t = timeline({
      start: iso('08:00'),
      spans: [span(1, 'builder', 'builder', '10:00', '10:30')],
      end: iso('10:30'),
    })
    const chart = buildChart(t, ms('10:30'), { start: iso('09:30'), end: iso('10:30') })
    expect(chart.created).toEqual({ minutes: 120, left: 0 })
  })

  it('is at the creation on a window that starts before it', () => {
    const t = timeline({
      start: iso('09:50'),
      spans: [span(1, 'builder', 'builder', '10:00', '10:30')],
      end: iso('10:30'),
    })
    const chart = buildChart(t, ms('10:30'), { start: iso('09:00'), end: iso('10:30') })
    expect(chart.created?.minutes).toBe(10)
    expect(chart.created?.left).toBeCloseTo(50 / 90, 6)
  })
})
