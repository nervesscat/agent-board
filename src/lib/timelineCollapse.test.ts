import { describe, expect, it } from 'vitest'

import { CHIP_PX, COLLAPSED_MS, GAP_MS, GAP_PX, fitPieces, planPieces, position } from './timelineCollapse'
import { axisFor, buildChart, longDuration, share, ticksFit } from './timelineRows'
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
  humanStretches: [],
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

  it('labels the wait before a merge that comes with no review in between, and ends the axis at the merge', () => {
    const t = timeline({
      spans: [span(1, m(0), m(60))],
      marks: [merge(2, m(60) + 3 * DAY)],
      end: iso(m(60) + 3 * DAY),
    })
    const chart = buildChart(t, m(0))
    expect(chart.bands.map((b) => [b.kind, b.label, b.start, b.end])).toEqual([
      ['merge', 'Waiting to merge', m(60), m(60) + 3 * DAY],
    ])
    expect(chart.axis.span).toBe(60 * MIN + COLLAPSED_MS)
    expect(chart.marks[0]!.left).toBeCloseTo(1, 6)
    expect(chart.breaks).toHaveLength(1)
  })

  it('leaves a short unlabelled gap when the merge follows the last work within a minute', () => {
    const t = timeline({
      spans: [span(1, m(0), m(60))],
      marks: [merge(2, m(60) + 20_000)],
      end: iso(m(60) + 20_000),
    })
    const chart = buildChart(t, m(0))
    expect(chart.bands).toHaveLength(0)
    expect(chart.axis.pieces.map((p) => p.kind)).toEqual(['gap'])
    expect(chart.marks[0]!.left).toBeCloseTo(1, 6)
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
    expect(chart.axis.end).toBe(m(60) + DAY)
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
    // In a window it ends at the merge too: now is not on the axis.
    expect(buildChart(t, now, { start: iso(m(0)), end: iso(now) }).live).toBe(false)
  })
})

describe('longDuration', () => {
  it('counts days past a day and leaves shorter times as they were', () => {
    expect(longDuration(5 * DAY - 30 * MIN)).toBe('4 d 23 h 30 min')
    expect(longDuration(2 * DAY + 3 * HOUR)).toBe('2 d 3 h')
    expect(longDuration(125 * MIN)).toBe('2 h 5 min')
  })
})

describe('fitting the chart to its width', () => {
  /** The pixel width a time range takes on a track `width` px wide. */
  const px = (t: WorkTimeline, width: number, from: number, to: number) => {
    const axis = axisFor(t, m(0), undefined, width)
    return (share(axis, to) - share(axis, from)) * width
  }

  it('gives the collapsed block the same pixels whatever its length, and the work the rest', () => {
    for (const width of [320, 640, 1200]) {
      for (const days of [1, 9, 90]) {
        const t = reviewed(days * DAY)
        const axis = axisFor(t, m(0), undefined, width)
        const review = axis.pieces.find((p) => p.kind === 'review')!
        const gap = axis.pieces.find((p) => p.kind === 'gap')!
        const shrink = Math.min(1, (0.5 * width) / (CHIP_PX + GAP_PX))
        expect(px(t, width, review.start, review.end)).toBeCloseTo(CHIP_PX * shrink, 6)
        expect(px(t, width, gap.start, gap.end)).toBeCloseTo(GAP_PX * shrink, 6)
        // The work 09:00-10:00 takes everything else: the whole track.
        expect(px(t, width, m(0), m(60))).toBeCloseTo(width - (CHIP_PX + GAP_PX) * shrink, 6)
        expect(share(axis, axis.end)).toBeCloseTo(1, 9)
      }
    }
  })

  it('shrinks the blocks together when they would take over half a narrow track', () => {
    const pieces = [
      {
        start: m(10),
        end: m(20),
        kind: 'blocked' as const,
        virtualMs: COLLAPSED_MS,
        stretch: null,
        skips: null,
      },
      {
        start: m(30),
        end: m(40),
        kind: 'review' as const,
        virtualMs: COLLAPSED_MS,
        stretch: null,
        skips: null,
      },
      { start: m(50), end: m(55), kind: 'gap' as const, virtualMs: GAP_MS, stretch: null, skips: null },
    ]
    const fitted = fitPieces(pieces, m(0), m(60), 200).pieces
    const total = fitted.reduce((n, p) => n + p.virtualMs, 0)
    const real = 60 * MIN - 25 * MIN
    // Fixed blocks 162 px nominal, held to 100 px (half of 200) and the real 35 min get the other 100 px.
    expect(total / (total + real)).toBeCloseTo(0.5, 6)
    expect(fitted[0]!.virtualMs / fitted[2]!.virtualMs).toBeCloseTo(CHIP_PX / GAP_PX, 6)
  })

  it('keeps a block at its pixels when the whole axis is collapsed, and leaves the rest of the track empty', () => {
    const t = timeline({
      live: true,
      start: iso(m(0)),
      end: iso(m(60)),
      blockedStretches: [stretch(m(0), m(60))],
    })
    for (const width of [320, 640, 1200]) {
      const axis = axisFor(t, m(60), undefined, width)
      const block = axis.pieces.find((p) => p.kind === 'blocked')!
      const chip = buildChart(t, m(60), undefined, width).bands[0]!
      expect(chip.seg.width * width).toBeCloseTo(Math.min(CHIP_PX, 0.5 * width), 6)
      expect(chip.seg.left).toBe(0)
      expect(block.virtualMs).toBeLessThan(axis.span)
    }
  })

  it('leaves a chart with nothing collapsed to scale, and the same at any width', () => {
    const t = timeline({ spans: [span(1, m(0), m(60))] })
    for (const width of [200, 700, 1400]) {
      const axis = axisFor(t, m(0), undefined, width)
      expect(axis.pieces).toEqual([])
      expect(axis.span).toBe(60 * MIN)
    }
  })

  it('keeps every segment inside the track at any width', () => {
    const t = timeline({
      spans: [span(1, m(0), m(60)), span(2, m(60) + 3 * DAY, m(60) + 3 * DAY + 30 * MIN)],
      blockedStretches: [stretch(m(60), m(60) + 3 * DAY)],
      reviewStretches: [stretch(m(60) + 3 * DAY + 30 * MIN, m(60) + 8 * DAY)],
      marks: [merge(9, m(60) + 8 * DAY)],
      end: iso(m(60) + 8 * DAY),
    })
    for (const width of [150, 320, 390, 800, 2000]) {
      const chart = buildChart(t, m(0), undefined, width)
      const shares = [
        ...chart.rows.flatMap((r) => r.items.map((i) => [i.seg.left, i.seg.left + i.seg.width])),
        ...chart.bands.map((b) => [b.seg.left, b.seg.left + b.seg.width]),
        ...chart.marks.map((k) => [k.left, k.left]),
      ]
      expect(chart.bands.length).toBe(2)
      for (const [a, b] of shares) {
        expect(a).toBeGreaterThanOrEqual(-1e-9)
        expect(b).toBeLessThanOrEqual(1 + 1e-9)
      }
    }
  })

  it('puts fewer ticks on a narrow track', () => {
    const t = timeline({ spans: [span(1, m(0), m(600))], end: iso(m(600)) })
    expect(axisFor(t, m(0), undefined, 1200).ticks.length).toBeGreaterThan(
      axisFor(t, m(0), undefined, 220).ticks.length,
    )
    expect(axisFor(t, m(0), undefined, 220).ticks.length).toBeLessThanOrEqual(ticksFit(220) + 1)
    expect(ticksFit(120)).toBe(2)
    expect(ticksFit(2000)).toBe(5)
  })
})

describe('a merged ticket on the Roadmap window', () => {
  // The shape of a ticket that was worked for a few hours, sat blocked for ten minutes and in review for
  // two days (In review, then Release), and was merged two days later while the window is the last 24 h.
  const worked = (id: number, a: number, b: number) => span(id, m(a), m(b))
  const merged = () => {
    const reviewAt = m(180)
    const releaseAt = reviewAt + 2 * DAY
    const mergedAt = releaseAt + 4 * MIN
    const now = mergedAt + 3 * HOUR
    return {
      now,
      mergedAt,
      t: timeline({
        start: iso(m(-5)),
        spans: [worked(1, 0, 60), worked(2, 70, 100), worked(3, 110, 180)],
        blockedStretches: [stretch(m(60), m(70))],
        reviewStretches: [
          { ...stretch(reviewAt, releaseAt), name: 'In review' },
          { ...stretch(releaseAt, now), name: 'Release' },
        ],
        marks: [merge(9, mergedAt)],
        live: true,
        end: iso(now),
        now: iso(now),
      }),
    }
  }

  it('draws its work to scale in the 24 h window, which only counts agent time', () => {
    const { t, now, mergedAt } = merged()
    const win = { start: iso(now - DAY), end: iso(now) }
    const chart = buildChart(t, now, win, 700)
    // The window reaches back past the review stretches to the ticket's first event.
    expect(chart.axis.start).toBe(m(-5))
    expect(chart.axis.end).toBe(mergedAt)
    expect(chart.rows.flatMap((r) => r.items)).toHaveLength(3)
    expect(chart.bands.map((b) => b.label)).toEqual(['Waiting to start', 'Blocked', 'In review', 'Release'])
    expect(chart.live).toBe(false)
    expect(chart.marks[0]!.left).toBeCloseTo(1, 6)
  })

  it('does not move a window that holds no collapsed time', () => {
    const t = timeline({ spans: [span(1, m(0), m(600))], end: iso(m(600)), live: true, now: iso(m(600)) })
    const win = { start: iso(m(300)), end: iso(m(600)) }
    expect(axisFor(t, m(600), win).start).toBe(m(300))
  })

  it('keeps the window where the ticket began when it was created inside it', () => {
    const t = timeline({ spans: [span(1, m(30), m(600))], end: iso(m(600)), live: true, now: iso(m(600)) })
    expect(axisFor(t, m(600), { start: iso(m(-60)), end: iso(m(600)) }).start).toBe(m(-60))
  })

  it('draws work done inside a review stretch to scale and splits the block around it', () => {
    const t = timeline({
      spans: [span(1, m(0), m(60)), span(2, m(60) + DAY, m(90) + DAY)],
      reviewStretches: [stretch(m(60), m(120) + DAY)],
      marks: [merge(9, m(120) + DAY)],
      end: iso(m(120) + DAY),
    })
    const chart = buildChart(t, m(0), undefined, 700)
    expect(chart.rows[0]!.items).toHaveLength(2)
    expect(chart.bands.filter((b) => b.kind === 'review')).toHaveLength(1)
    const second = chart.rows[0]!.items[1]!
    // The second run of work is a real 30 minutes among the fixed blocks, not squeezed into one.
    expect(second.seg.width).toBeGreaterThan(0.05)
  })
})

describe('waits on the human', () => {
  it('collapses a wait or a decision card inside the work into a labelled block, and carves work out of it', () => {
    const t = timeline({
      spans: [span(1, m(0), m(60)), span(2, m(60 + 600), m(60 + 660))],
      humanStretches: [{ start: iso(m(60)), end: iso(m(60 + 600)), card: true }],
      end: iso(m(60 + 660)),
    })
    const chart = buildChart(t, m(0))
    expect(chart.bands.map((b) => [b.kind, b.label])).toEqual([['human', 'Waiting for a decision']])
    expect(chart.axis.span).toBe(60 * MIN + COLLAPSED_MS + 60 * MIN)
    const plain = buildChart(
      timeline({
        spans: [span(1, m(0), m(60)), span(2, m(60 + 600), m(60 + 660))],
        humanStretches: [{ start: iso(m(60)), end: iso(m(60 + 600)), card: false }],
        end: iso(m(60 + 660)),
      }),
      m(0),
    )
    expect(plain.bands[0]!.label).toBe('Waiting on human')
  })

  it('leaves out of a human wait what a blocked or review stage already covers', () => {
    const t = timeline({
      spans: [span(1, m(0), m(60))],
      blockedStretches: [stretch(m(60), m(160))],
      humanStretches: [{ start: iso(m(100)), end: iso(m(200)), card: false }],
      end: iso(m(200)),
    })
    const chart = buildChart(t, m(0))
    expect(chart.bands.map((b) => [b.kind, b.start, b.end])).toEqual([
      ['blocked', m(60), m(160)],
      ['human', m(160), m(200)],
    ])
  })
})

describe('what a review round found', () => {
  it('ends a merged ticket at its merge in a window that starts after the merge, as in a wider one', () => {
    const mergedAt = m(180) + 2 * DAY
    const build = (ageMs: number) => {
      const now = mergedAt + ageMs
      return {
        now,
        t: timeline({
          spans: [span(1, m(0), m(60)), span(2, m(100), m(180))],
          reviewStretches: [{ ...stretch(m(180), now), name: 'Release' }],
          marks: [merge(9, mergedAt)],
          live: true,
          end: iso(now),
          now: iso(now),
        }),
      }
    }
    for (const age of [10 * HOUR, 30 * HOUR, 60 * HOUR, 10 * DAY]) {
      const { t, now } = build(age)
      const chart = buildChart(t, now, { start: iso(now - DAY), end: iso(now) }, 700)
      expect(chart.axis.end, `${age / HOUR} h after the merge`).toBe(mergedAt)
      expect(chart.live).toBe(false)
      expect(chart.marks[0]!.left).toBeCloseTo(1, 6)
      expect(chart.rows.flatMap((r) => r.items)).toHaveLength(2)
    }
  })

  it('draws a ticket that sat blocked from its creation until its first work as a block', () => {
    const t = timeline({
      start: iso(m(0)),
      spans: [span(1, m(0) + 2 * DAY, m(60) + 2 * DAY)],
      blockedStretches: [stretch(m(0), m(0) + 2 * DAY)],
      end: iso(m(60) + 2 * DAY),
    })
    const chart = buildChart(t, m(0), undefined, 700)
    expect(chart.axis.start).toBe(m(0))
    expect(chart.bands.map((b) => b.label)).toEqual(['Blocked'])
    expect(chart.created).toBeNull()
    expect(chart.rows[0]!.items).toHaveLength(1)
  })

  it('puts a merge inside a wait on the human at the end of its block, as in a stage', () => {
    const at = (k: 'human' | 'blocked' | 'review') =>
      timeline({
        spans: [span(1, m(0), m(60)), span(2, m(90 * 60), m(91 * 60))],
        ...(k === 'human'
          ? { humanStretches: [{ start: iso(m(60 * 60)), end: iso(m(80 * 60)), card: false }] }
          : k === 'blocked'
            ? { blockedStretches: [stretch(m(60 * 60), m(80 * 60))] }
            : { reviewStretches: [stretch(m(60 * 60), m(80 * 60))] }),
        marks: [merge(9, m(70 * 60))],
        end: iso(m(91 * 60)),
      })
    const ends = (['human', 'blocked', 'review'] as const).map((k) => {
      const chart = buildChart(at(k), m(0))
      const band = chart.bands.find((b) => b.kind === k)!
      expect(chart.marks[0]!.left, k).toBeCloseTo(band.seg.left + band.seg.width, 6)
      return band.seg.left + band.seg.width
    })
    expect(ends[0]).toBeCloseTo(ends[1]!, 6)
  })
})
