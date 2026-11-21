import { describe, expect, it } from 'vitest'

import { COLLAPSED_MS, GAP_MS, planPieces, position } from './timelineCollapse'
import { axisFor, buildChart, longDuration } from './timelineRows'
import type { TimelineSpan, WorkTimeline } from './workTimeline'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const T0 = Date.parse('2026-10-20T09:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
/** A time as minutes after 09:00 on the first day. */
const m = (minutes: number) => T0 + minutes * MIN

const span = (id: number, start: number, end: number, open = false): TimelineSpan => ({
  id,
  phase: 'build',
  round: null,
  agent: 'a',
  by: 'a',
  start: iso(start),
  end: iso(end),
  open,
})

const timeline = (more: Partial<WorkTimeline> = {}): WorkTimeline => ({
  now: iso(m(60)),
  start: iso(m(0)),
  end: iso(m(60)),
  live: false,
  spans: [],
  waits: [],
  handoffs: [],
  marks: [],
  blockedStretches: [],
  reviewStretches: [],
  totals: { workingMs: 0, waitingMs: 0, blockedOnHumanMs: 0 },
  lastSignalAt: iso(m(0)),
  lastWordAt: iso(m(0)),
  liveness: null,
  lastHeard: null,
  stalled: null,
  stage: { key: 'in_progress', kind: 'active', since: iso(m(0)) },
  progressAt: iso(m(0)),
  waitingOnHuman: false,
  ...more,
})

const stretch = (a: number, b: number) => ({ start: iso(a), end: iso(b) })
const merge = (id: number, at: number) => ({ id, kind: 'merge' as const, at: iso(at), note: '' })
const blockOf = (t: WorkTimeline, now = m(0)) => buildChart(t, now).bands[0]!

/** Work 09:00-10:00, then `review` long in review, then the merge at the end of it. */
const reviewed = (reviewMs: number) => {
  const end = m(60) + reviewMs
  return timeline({
    spans: [span(1, m(0), m(60))],
    reviewStretches: [stretch(m(60), end)],
    marks: [merge(2, end)],
    end: iso(end),
  })
}

describe('the warp', () => {
  it('is the plain difference without pieces, and continuous and monotone with them', () => {
    expect(position(0, [], 500)).toBe(500)
    const pieces = [
      { start: 100, end: 1100, kind: 'review' as const, virtualMs: 50, stretch: null, skips: null },
    ]
    expect(position(0, pieces, 100)).toBe(100)
    expect(position(0, pieces, 600)).toBe(125)
    expect(position(0, pieces, 1100)).toBe(150)
    expect(position(0, pieces, 1200)).toBe(250)
    expect(position(0, pieces, -10)).toBe(-10)
  })
})

describe('collapsed periods', () => {
  it('draw a fixed block whatever their real length, with the work before it at scale', () => {
    const short = buildChart(reviewed(5 * HOUR), m(0))
    const long = buildChart(reviewed(5 * DAY), m(0))
    for (const chart of [short, long]) {
      expect(chart.axis.span).toBe(60 * MIN + COLLAPSED_MS + GAP_MS)
      expect(chart.bands).toHaveLength(1)
      expect(chart.bands[0]!.kind).toBe('review')
      expect(chart.bands[0]!.seg.width * chart.axis.span).toBeCloseTo(COLLAPSED_MS, 3)
      // The worker step keeps its real scale: 60 of the axis's minutes.
      const item = chart.rows[0]!.items[0]!
      expect(item.seg.left).toBe(0)
      expect(item.seg.width * chart.axis.span).toBeCloseTo(60 * MIN, 3)
    }
    expect(long.bands[0]!.end - long.bands[0]!.start).toBe(5 * DAY)
  })

  it('put the merge right after the block and the gap, where the axis ends', () => {
    const chart = buildChart(reviewed(5 * DAY), m(0))
    const block = chart.bands[0]!.seg
    const mark = chart.marks[0]!
    expect(mark.left).toBeCloseTo(1, 6)
    expect(mark.left - (block.left + block.width)).toBeCloseTo(GAP_MS / chart.axis.span, 6)
    expect(chart.axis.end).toBe(m(60) + 5 * DAY)
  })

  it('open the gap after the last work when the merge comes with no review in between', () => {
    const t = timeline({
      spans: [span(1, m(0), m(60))],
      marks: [merge(2, m(60) + 3 * DAY)],
      end: iso(m(60) + 3 * DAY),
    })
    const chart = buildChart(t, m(0))
    expect(chart.bands).toHaveLength(0)
    expect(chart.axis.span).toBe(60 * MIN + GAP_MS)
    expect(chart.marks[0]!.left).toBeCloseTo(1, 6)
    expect(chart.breaks).toHaveLength(1)
  })

  it('cut a review that ends at the merge and ignore one that starts after it', () => {
    const plan = planPieces({
      stretches: [
        { kind: 'review', start: m(60), end: m(60) + DAY },
        { kind: 'review', start: m(60) + 2 * DAY, end: m(60) + 3 * DAY },
      ],
      merge: m(60) + DAY,
      work: [{ start: m(0), end: m(60) }],
      carve: [{ start: m(0), end: m(60) }],
    })
    expect(plan.pinned).toBe(m(60) + DAY)
    expect(plan.pieces.map((p) => p.kind)).toEqual(['review', 'gap', 'tail'])
    expect(plan.pieces[1]!.end).toBe(m(60) + DAY)
  })

  it('keep a blocked period between two runs of work, the second resuming right after the block', () => {
    const t = timeline({
      spans: [span(1, m(0), m(30)), span(2, m(30) + 2 * DAY, m(60) + 2 * DAY)],
      blockedStretches: [stretch(m(30), m(30) + 2 * DAY)],
      end: iso(m(60) + 2 * DAY),
    })
    const chart = buildChart(t, m(0))
    const block = chart.bands[0]!
    expect(block.kind).toBe('blocked')
    const [first, second] = chart.rows[0]!.items
    expect(first!.seg.left + first!.seg.width).toBeCloseTo(block.seg.left, 6)
    expect(second!.seg.left).toBeCloseTo(block.seg.left + block.seg.width, 6)
    expect(chart.axis.span).toBe(60 * MIN + COLLAPSED_MS)
    expect(second!.seg.width * chart.axis.span).toBeCloseTo(30 * MIN, 3)
  })

  it('leave a merge followed by later work at its real time', () => {
    const t = timeline({
      spans: [span(1, m(0), m(60)), span(2, m(60) + DAY, m(120) + DAY)],
      reviewStretches: [stretch(m(60), m(60) + DAY)],
      marks: [merge(3, m(60) + 3 * HOUR)],
      end: iso(m(120) + DAY),
    })
    const axis = axisFor(t, m(0))
    expect(axis.pieces.map((p) => p.kind)).toEqual(['review'])
    expect(axis.end).toBe(m(120) + DAY)
  })

  it('map a mark on a block edge to the edge', () => {
    const t = timeline({
      spans: [span(1, m(0), m(100)), span(2, m(200), m(300))],
      reviewStretches: [stretch(m(100), m(200))],
      marks: [{ id: 9, kind: 'pr', at: iso(m(200)), note: '' }],
      end: iso(m(300)),
    })
    const chart = buildChart(t, m(0))
    const block = chart.bands[0]!.seg
    expect(chart.marks[0]!.left).toBeCloseTo(block.left + block.width, 6)
    expect(chart.axis.span).toBe(200 * MIN + COLLAPSED_MS)
  })

  it('clip to a window yet keep the whole fixed block of a period overlapping it', () => {
    const t = timeline({
      spans: [span(1, m(0), m(60))],
      reviewStretches: [stretch(m(60), m(60) + 5 * DAY)],
      end: iso(m(60) + 5 * DAY),
    })
    const win = { start: iso(m(0)), end: iso(m(60) + DAY) }
    const axis = axisFor(t, m(0), win)
    expect(axis.end).toBe(m(60) + DAY)
    expect(axis.pieces).toHaveLength(1)
    expect(axis.pieces[0]!.end).toBe(m(60) + DAY)
    expect(axis.span).toBe(60 * MIN + COLLAPSED_MS)
    // The chip still tells the period's own real end.
    expect(buildChart(t, m(0), win).bands[0]!.end).toBe(m(60) + 5 * DAY)
    // A window past the period has no block.
    expect(axisFor(t, m(0), { start: iso(m(60) + 6 * DAY), end: iso(m(60) + 7 * DAY) }).pieces).toEqual([])
  })

  it('end a live ticket in review with the open block, the now line at its edge', () => {
    const now = m(60) + 2 * DAY
    const t = timeline({
      spans: [span(1, m(0), m(60))],
      reviewStretches: [stretch(m(60), m(60) + DAY)],
      live: true,
      end: iso(m(60) + DAY),
      now: iso(now),
    })
    const chart = buildChart(t, now)
    const block = chart.bands[0]!
    expect(block.open).toBe(true)
    expect(block.end).toBe(now)
    expect(block.seg.left + block.seg.width).toBeCloseTo(1, 6)
    expect(chart.axis.end).toBe(now)
  })

  it('skip the axis ticks inside a block and date the first tick after it when the day changes', () => {
    const t = timeline({
      spans: [span(1, m(0), m(60))],
      blockedStretches: [stretch(m(60), m(60) + 3 * DAY)],
      end: iso(m(120) + 3 * DAY),
      marks: [],
    })
    const t2 = { ...t, spans: [...t.spans, span(2, m(60) + 3 * DAY, m(120) + 3 * DAY)] }
    const chart = buildChart(t2, m(0))
    const { pieces, ticks } = chart.axis
    expect(ticks.length).toBeGreaterThan(0)
    expect(ticks.some((k) => k.at > pieces[0]!.start && k.at < pieces[0]!.end)).toBe(false)
    const after = ticks.find((k) => k.at >= pieces[0]!.end)!
    expect(after.label).toMatch(/\d/)
    expect(after.label.length).toBeGreaterThan(ticks[0]!.label.length)
    expect(chart.breaks).toHaveLength(1)
    const block = chart.bands[0]!.seg
    expect(chart.breaks[0]!.left).toBeCloseTo(block.left + block.width / 2, 6)
  })

  it('lay out a ticket with no such periods and no merge exactly as before', () => {
    const t = timeline({ spans: [span(1, m(0), m(60))] })
    const axis = axisFor(t, m(0))
    expect(axis.pieces).toEqual([])
    expect(axis.span).toBe(axis.end - axis.start)
    expect(buildChart(t, m(0)).breaks).toEqual([])
  })

  it('say in the summary that the collapsed time is not to scale', () => {
    const chart = buildChart(reviewed(2 * DAY + 3 * HOUR), m(0))
    expect(chart.summary).toContain('Not to scale: in review 2 d 3 h.')
    expect(blockOf(reviewed(HOUR)).kind).toBe('review')
  })
})

describe('a pinned merge in a window and marks inside blocks', () => {
  it('ends the axis at the merge in a window, a live ticket included', () => {
    const now = m(60) + 3 * DAY
    const t = timeline({
      spans: [span(1, m(0), m(60))],
      reviewStretches: [stretch(m(60), m(60) + DAY)],
      marks: [merge(2, m(60) + DAY)],
      live: true,
      end: iso(now),
      now: iso(now),
    })
    const win = { start: iso(m(0)), end: iso(now) }
    const chart = buildChart(t, now, win)
    expect(chart.axis.span).toBe(60 * MIN + COLLAPSED_MS + GAP_MS)
    expect(chart.marks[0]!.left).toBeCloseTo(1, 6)
    expect(position(chart.axis.start, chart.axis.pieces, now) / chart.axis.span).toBeCloseTo(1, 6)
    // The skipped tail has no break mark, and no tick inside it.
    expect(chart.breaks).toHaveLength(2)
    expect(chart.axis.ticks.every((k) => k.at <= m(60) + DAY)).toBe(true)
    // Without a window nothing changes.
    expect(buildChart(t, now).axis.span).toBe(chart.axis.span)
  })

  it('lists a mark inside a block with the block and keeps the others on the rail', () => {
    const t = timeline({
      spans: [span(1, m(0), m(100)), span(3, m(200), m(300))],
      reviewStretches: [stretch(m(100), m(200))],
      marks: [
        { id: 9, kind: 'preview', at: iso(m(150)), note: '' },
        { id: 10, kind: 'push', at: iso(m(250)), note: '' },
      ],
      end: iso(m(300)),
    })
    const chart = buildChart(t, m(0))
    expect(chart.marks.map((k) => k.mark.id)).toEqual([10])
    expect(chart.bands[0]!.marks.map((k) => k.id)).toEqual([9])
  })

  it('never hides the pinned merge', () => {
    const chart = buildChart(reviewed(2 * DAY), m(0))
    expect(chart.marks.map((k) => k.mark.kind)).toEqual(['merge'])
  })
})

describe('worker steps inside a collapsed period', () => {
  const inReview = () =>
    timeline({
      spans: [span(1, m(0), m(60)), span(2, m(60) + DAY, m(60) + DAY + 4 * HOUR)],
      reviewStretches: [stretch(m(60), m(60) + 3 * DAY)],
      end: iso(m(60) + 3 * DAY),
    })

  it('keep their real width, with the block before them and a gap after', () => {
    const chart = buildChart(inReview(), m(0))
    const inside = chart.rows[0]!.items[1]!
    expect(inside.seg.width * chart.axis.span).toBeCloseTo(4 * HOUR, 3)
    expect(chart.axis.pieces.map((p) => p.kind)).toEqual(['review', 'gap'])
    expect(chart.axis.span).toBe(60 * MIN + COLLAPSED_MS + 4 * HOUR + GAP_MS)
    // The block comes before the step and the gap after it; the axis stays monotone.
    expect(chart.bands[0]!.seg.left + chart.bands[0]!.seg.width).toBeCloseTo(inside.seg.left, 6)
    expect(chart.breaks).toHaveLength(2)
  })

  it('leave the chip telling the whole stretch', () => {
    const [band] = buildChart(inReview(), m(0)).bands
    expect(band!.start).toBe(m(60))
    expect(band!.end).toBe(m(60) + 3 * DAY)
    expect(buildChart(inReview(), m(0)).bands).toHaveLength(1)
  })

  it('leave a period with no step inside as it was', () => {
    const t = timeline({
      spans: [span(1, m(0), m(60))],
      reviewStretches: [stretch(m(60), m(60) + DAY)],
      end: iso(m(60) + DAY),
    })
    expect(axisFor(t, m(0)).pieces.map((p) => [p.kind, p.start, p.end])).toEqual([
      ['review', m(60), m(60) + DAY],
    ])
  })

  it('drop what is left under a second', () => {
    const t = timeline({
      spans: [span(1, m(0), m(60)), span(2, m(60) + 500, m(120))],
      reviewStretches: [stretch(m(60), m(120))],
      end: iso(m(120)),
    })
    expect(axisFor(t, m(0)).pieces).toEqual([])
  })
})

describe('what does not carve a period', () => {
  it('leaves the chip when a never-closed span covers the whole review', () => {
    const t = timeline({
      spans: [span(1, m(0), m(60)), span(2, m(30), m(60) + 5 * DAY, true)],
      reviewStretches: [stretch(m(60), m(60) + 5 * DAY)],
      end: iso(m(60) + 5 * DAY),
    })
    const chart = buildChart(t, m(0))
    expect(chart.bands.map((b) => b.kind)).toEqual(['review'])
    expect(chart.axis.span).toBe(60 * MIN + COLLAPSED_MS)
  })

  it('leaves the chip when a wait on the human covers the whole blocked period', () => {
    const t = timeline({
      spans: [span(1, m(0), m(60))],
      waits: [
        {
          id: 5,
          reason: 'human',
          agent: 'a',
          on: null,
          note: '',
          start: iso(m(60)),
          end: iso(m(60) + 2 * DAY),
          open: false,
        },
      ],
      blockedStretches: [stretch(m(60), m(60) + 2 * DAY)],
      end: iso(m(60) + 2 * DAY),
    })
    expect(buildChart(t, m(0)).bands.map((b) => b.kind)).toEqual(['blocked'])
  })

  it('still carves a closed step, and counts open ones and human waits for the merge pin', () => {
    const t = timeline({
      spans: [span(1, m(0), m(60)), span(2, m(60) + DAY, m(60) + DAY + 4 * HOUR)],
      reviewStretches: [stretch(m(60), m(60) + 3 * DAY)],
      end: iso(m(60) + 3 * DAY),
    })
    const chart = buildChart(t, m(0))
    expect(chart.rows[0]!.items[1]!.seg.width * chart.axis.span).toBeCloseTo(4 * HOUR, 3)
    // An open span after the merge still means the merge is not pinned.
    const later = timeline({
      spans: [span(1, m(0), m(60)), span(2, m(60) + 2 * DAY, m(60) + 3 * DAY, true)],
      reviewStretches: [stretch(m(60), m(60) + DAY)],
      marks: [merge(3, m(60) + DAY)],
      end: iso(m(60) + 3 * DAY),
    })
    expect(axisFor(later, m(0)).pinned).toBeNull()
  })
})

describe('a merge inside a block, and a pinned merge on a live ticket', () => {
  it('is drawn at the block end, not hidden', () => {
    const h = HOUR
    const t = timeline({
      spans: [span(1, m(0), m(60)), span(2, m(60) + 60 * h, m(60) + 61 * h)],
      reviewStretches: [stretch(m(60), m(60) + 70 * h)],
      marks: [merge(3, m(60) + 50 * h)],
      end: iso(m(60) + 70 * h),
    })
    const chart = buildChart(t, m(0))
    const block = chart.bands[0]!
    expect(block.marks).toEqual([])
    expect(chart.marks.map((k) => k.mark.kind)).toEqual(['merge'])
    expect(chart.marks[0]!.left).toBeCloseTo(block.seg.left + block.seg.width, 6)
  })

  it('stops a live chart following the time once the axis ends at the merge', () => {
    const now = m(60) + 3 * DAY
    const t = timeline({
      spans: [span(1, m(0), m(60))],
      reviewStretches: [stretch(m(60), now)],
      marks: [merge(2, m(60) + DAY)],
      live: true,
      end: iso(now),
      now: iso(now),
    })
    const chart = buildChart(t, now)
    expect(chart.live).toBe(false)
    expect(chart.going).toBe(true)
    expect(chart.bands[0]!.open).toBe(true)
    // In a window now is still the window end, at the merge's place.
    expect(buildChart(t, now, { start: iso(m(0)), end: iso(now) }).live).toBe(true)
  })
})

describe('longDuration', () => {
  it('counts days past a day and leaves shorter times as they were', () => {
    expect(longDuration(5 * DAY - 30 * MIN)).toBe('4 d 23 h 30 min')
    expect(longDuration(2 * DAY + 3 * HOUR)).toBe('2 d 3 h')
    expect(longDuration(125 * MIN)).toBe('2 h 5 min')
  })
})
