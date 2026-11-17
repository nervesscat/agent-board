import { describe, expect, it } from 'vitest'

import {
  angleAt,
  carryNotes,
  createHistory,
  cursorOf,
  deleteAt,
  edit,
  fillMark,
  handleAt,
  handlePoint,
  isFillable,
  isTinyDrag,
  type Layout,
  markAt,
  markBounds,
  marqueeIds,
  partAt,
  pivotOf,
  RESIZE_PARTS,
  redo,
  replace,
  resizeFactors,
  resizeHandleAt,
  rotateMark,
  scaleMark,
  translateMark,
  turn,
  turnBetween,
  unionBounds,
  undo,
} from './annotationEdit'
import type { Annotation } from './annotations'

const base = { color: '#e11d48', width: 4 }
const rect = (
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  extra: Partial<Annotation> = {},
): Annotation => ({
  id,
  kind: 'rect',
  ...base,
  rect: { x, y, w, h },
  ...extra,
})
const pen = (id: string, points: [number, number][], extra: Partial<Annotation> = {}): Annotation => ({
  id,
  kind: 'pen',
  ...base,
  points,
  from: points[0],
  ...extra,
})
const line = (
  id: string,
  from: [number, number],
  to: [number, number],
  kind: 'line' | 'arrow' = 'line',
): Annotation => ({
  id,
  kind,
  ...base,
  from,
  to,
})
const ellipse = (id: string, x: number, y: number, w: number, h: number): Annotation => ({
  id,
  kind: 'ellipse',
  ...base,
  rect: { x, y, w, h },
})
const text = (id: string, at: [number, number], value: string): Annotation => ({
  id,
  kind: 'text',
  ...base,
  from: at,
  text: value,
})

/** Asserts two points match to a small tolerance (rotations are not exact in floating point). */
function near([x, y]: [number, number], [ex, ey]: [number, number]) {
  expect(x).toBeCloseTo(ex, 6)
  expect(y).toBeCloseTo(ey, 6)
}

describe('markAt', () => {
  it('picks the newest mark under the pointer', () => {
    const under = rect('under', 0, 0, 100, 100)
    const over = rect('over', 10, 10, 50, 50)
    expect(markAt([under, over], 30, 30)?.id).toBe('over')
    expect(markAt([over, under], 30, 30)?.id).toBe('under')
  })

  it('reaches a stroke by its width plus six pixels, and misses past that', () => {
    const stroke = pen('p', [
      [10, 10],
      [50, 10],
    ])
    expect(markAt([stroke], 50, 10 + 4 + 6)?.id).toBe('p')
    expect(markAt([stroke], 50, 10 + 4 + 6 + 1)).toBeUndefined()
  })

  it('does not pick a stroke by its box, only by its points', () => {
    const diagonal = pen('p', [
      [0, 0],
      [100, 100],
    ])
    expect(markAt([diagonal], 100, 0)).toBeUndefined()
  })

  it('reaches a line by its segment', () => {
    const arrow = line('a', [0, 0], [100, 0], 'arrow')
    expect(markAt([arrow], 50, 9)?.id).toBe('a')
    expect(markAt([arrow], 50, 11)).toBeUndefined()
  })

  it('does not pick a diagonal line or arrow by the empty corners of its box', () => {
    const under = rect('under', 100, 300, 100, 100)
    const arrow = line('a', [0, 0], [400, 400], 'arrow')
    // (150, 350) is inside the box of the arrow and about 141 px from its segment: the rect under it is picked.
    expect(markAt([under, arrow], 150, 350)?.id).toBe('under')
    expect(markAt([arrow], 150, 350)).toBeUndefined()
  })

  it('reaches a box or an ellipse by its bounds, with the reach around them', () => {
    expect(markAt([rect('r', 20, 20, 40, 40)], 15, 40)?.id).toBe('r')
    expect(markAt([ellipse('e', 20, 20, 40, 40)], 70, 40)?.id).toBe('e')
    expect(markAt([rect('r', 20, 20, 40, 40)], 0, 0)).toBeUndefined()
  })

  it('reaches text by the box its characters take', () => {
    const label = text('t', [10, 10], 'Hi')
    expect(markAt([label], 20, 15)?.id).toBe('t')
    expect(markAt([label], 200, 200)).toBeUndefined()
  })

  it('finds a rotated box where it is drawn, not where it was', () => {
    // A tall box turned a quarter turn lies wide: a point to its right is inside, one above is not.
    const tall = { ...rect('r', 40, 0, 20, 100), rotation: Math.PI / 2 }
    expect(markAt([tall], 105, 50)?.id).toBe('r')
    expect(markAt([rect('r', 40, 0, 20, 100)], 105, 50)).toBeUndefined()
    expect(markAt([tall], 50, -20)).toBeUndefined()
  })

  it('does not pick a turned box by the empty corners inside its turned bounds', () => {
    // A flat box turned 45 degrees: its turned bounds reach (88, -30), but that point is off the box itself.
    const flat = { ...rect('r', 0, 0, 100, 10), rotation: Math.PI / 4 }
    expect(markAt([flat], 88, -30)).toBeUndefined()
    // The box's own middle, and a point on its turned length, are still picked.
    expect(markAt([flat], 50, 5)?.id).toBe('r')
    expect(markAt([flat], 78, 33)?.id).toBe('r')
  })
})

describe('markBounds', () => {
  it('is the box of an unturned mark, as it was drawn', () => {
    expect(markBounds(rect('r', 5, 6, 30, 40))).toEqual({ x: 5, y: 6, w: 30, h: 40 })
    expect(
      markBounds(
        pen('p', [
          [3, 4],
          [9, 1],
        ]),
      ),
    ).toEqual({ x: 3, y: 1, w: 6, h: 3 })
    expect(markBounds(line('l', [10, 20], [0, 5]))).toEqual({ x: 0, y: 5, w: 10, h: 15 })
  })

  it('is the box of the turned corners when the mark is turned', () => {
    const b = markBounds({ ...rect('r', 0, 0, 20, 10), rotation: Math.PI / 2 })
    // Centre (10, 5); a quarter turn makes it 10 wide and 20 tall, around the same centre.
    expect(b.x).toBeCloseTo(5, 6)
    expect(b.y).toBeCloseTo(-5, 6)
    expect(b.w).toBeCloseTo(10, 6)
    expect(b.h).toBeCloseTo(20, 6)
  })

  it('takes a text box from its characters', () => {
    const b = markBounds(text('t', [10, 10], 'abcd'))
    expect(b.x).toBe(10)
    expect(b.y).toBe(10)
    expect(b.w).toBeGreaterThan(0)
    expect(b.h).toBeGreaterThan(0)
  })
})

describe('pivotOf', () => {
  it('is the centre of the unturned box', () => {
    expect(pivotOf(rect('r', 0, 0, 10, 20))).toEqual([5, 10])
    expect(pivotOf(line('l', [0, 0], [10, 20]))).toEqual([5, 10])
  })
})

describe('turn', () => {
  it('turns a point about a centre in the canvas frame', () => {
    near(turn([10, 0], [0, 0], Math.PI / 2), [0, 10])
    near(turn([10, 5], [5, 5], Math.PI), [0, 5])
    near(turn([3, 3], [3, 3], 1.2), [3, 3])
  })
})

describe('translateMark', () => {
  it('moves a stroke point by point and keeps its order, id, note and rotation', () => {
    const stroke = pen(
      'p',
      [
        [1, 2],
        [3, 4],
      ],
      { note: 'kept', rotation: 0.5 },
    )
    const moved = translateMark(stroke, 10, -2)
    expect(moved.points).toEqual([
      [11, 0],
      [13, 2],
    ])
    expect(moved.from).toEqual([11, 0])
    expect(moved).toMatchObject({ id: 'p', note: 'kept', rotation: 0.5 })
  })

  it('moves a line or an arrow by both ends', () => {
    expect(translateMark(line('a', [0, 0], [5, 5], 'arrow'), 2, 3)).toMatchObject({
      from: [2, 3],
      to: [7, 8],
    })
  })

  it('moves a box or an ellipse by its rect', () => {
    expect(translateMark(rect('r', 1, 1, 4, 4), 3, 0).rect).toEqual({ x: 4, y: 1, w: 4, h: 4 })
    expect(translateMark(ellipse('e', 1, 1, 4, 4), 0, -1).rect).toEqual({ x: 1, y: 0, w: 4, h: 4 })
  })

  it('moves text by its anchor and leaves its string alone', () => {
    expect(translateMark(text('t', [1, 1], 'hi'), 4, 4)).toMatchObject({ from: [5, 5], text: 'hi' })
  })

  it('returns the mark as it was for a zero move, and adds no keys', () => {
    const r = rect('r', 1, 1, 2, 2)
    expect(translateMark(r, 0, 0)).toBe(r)
    expect(Object.keys(translateMark(r, 3, 3)).sort()).toEqual(Object.keys(r).sort())
  })
})

describe('rotateMark', () => {
  it('turns a box about the group centre: its centre moves round it and it turns by the angle', () => {
    const r = rect('r', 0, 0, 20, 10)
    const centre: [number, number] = [0, 0]
    const turned = rotateMark(r, centre, Math.PI / 2)
    // The box's centre (10, 5) goes a quarter turn about the origin to (-5, 10).
    near(pivotOf(turned), [-5, 10])
    expect(turned.rotation).toBeCloseTo(Math.PI / 2, 9)
    expect(turned.rect).toEqual({ x: -15, y: 5, w: 20, h: 10 })
  })

  it('turns a stroke: its drawn points land where a turn of the whole picture puts them', () => {
    const stroke = pen('p', [
      [0, 0],
      [10, 0],
    ])
    const centre: [number, number] = [20, 0]
    const angle = 0.7
    const turned = rotateMark(stroke, centre, angle)
    // The drawn world position of each point after the turn, as the canvas renders it.
    const drawn = (a: Annotation, p: [number, number]) => turn(p, pivotOf(a), a.rotation ?? 0)
    near(drawn(turned, turned.points![0]!), turn([0, 0], centre, angle))
    near(drawn(turned, turned.points![1]!), turn([10, 0], centre, angle))
  })

  it('turns a line or an arrow the same way, from both ends', () => {
    const arrow = line('a', [0, 0], [10, 0], 'arrow')
    const centre: [number, number] = [5, 5]
    const angle = -1.1
    const turned = rotateMark(arrow, centre, angle)
    const drawn = (p: [number, number]) => turn(p, pivotOf(turned), turned.rotation ?? 0)
    near(drawn(turned.from!), turn([0, 0], centre, angle))
    near(drawn(turned.to!), turn([10, 0], centre, angle))
  })

  it('turns an ellipse and text about the group centre', () => {
    const e = ellipse('e', 0, 0, 10, 4)
    const centre: [number, number] = [-3, 2]
    const turned = rotateMark(e, centre, 0.4)
    near(pivotOf(turned), turn(pivotOf(e), centre, 0.4))
    expect(turned.rotation).toBeCloseTo(0.4, 9)

    const label = text('t', [0, 0], 'abc')
    const turnedLabel = rotateMark(label, centre, 0.4)
    near(pivotOf(turnedLabel), turn(pivotOf(label), centre, 0.4))
  })

  it('adds to an earlier rotation, and a zero turn returns the mark as it was', () => {
    const r = { ...rect('r', 0, 0, 2, 2), rotation: 0.3 }
    expect(rotateMark(r, [0, 0], 0.2).rotation).toBeCloseTo(0.5, 9)
    expect(rotateMark(r, [0, 0], 0)).toBe(r)
  })

  it('writes no rotation key on a mark a turn of zero leaves alone', () => {
    const r = rect('r', 0, 0, 2, 2)
    expect('rotation' in rotateMark(r, [0, 0], 0)).toBe(false)
  })
})

describe('unionBounds', () => {
  it('is the box around every mark, or null for none', () => {
    expect(unionBounds([])).toBeNull()
    expect(unionBounds([rect('a', 0, 0, 10, 10), rect('b', 20, 5, 10, 10)])).toEqual({
      x: 0,
      y: 0,
      w: 30,
      h: 15,
    })
  })
})

describe('marqueeIds', () => {
  const a = rect('a', 0, 0, 10, 10)
  const b = rect('b', 50, 50, 10, 10)
  const long = pen('long', [
    [0, 100],
    [200, 100],
  ])

  it('selects the marks whose box the marquee meets, partly covered ones included', () => {
    expect(marqueeIds([a, b, long], [-5, -5], [12, 12])).toEqual(['a'])
    expect(marqueeIds([a, b, long], [5, 90], [20, 110])).toEqual(['long'])
    expect(marqueeIds([a, b, long], [0, 0], [100, 100])).toEqual(['a', 'b', 'long'])
  })

  it('reads a marquee dragged up and left as the same box', () => {
    expect(marqueeIds([a, b], [12, 12], [-5, -5])).toEqual(['a'])
  })

  it('selects nothing for a marquee that misses every mark', () => {
    expect(marqueeIds([a, b], [200, 200], [300, 300])).toEqual([])
  })

  it('selects nothing for a drag under 3 image pixels in both directions', () => {
    expect(marqueeIds([a], [0, 0], [2, 2])).toEqual([])
    expect(marqueeIds([a], [0, 0], [2.9, -2.9])).toEqual([])
    // Three pixels in one direction is a box, not a click.
    expect(marqueeIds([a], [0, 0], [3, 0])).toEqual(['a'])
  })
})

describe('isTinyDrag', () => {
  it('is true only when both directions are under 3 image pixels', () => {
    expect(isTinyDrag([0, 0], [2, 2])).toBe(true)
    expect(isTinyDrag([0, 0], [0, 0])).toBe(true)
    expect(isTinyDrag([0, 0], [3, 0])).toBe(false)
    expect(isTinyDrag([0, 0], [0, -3])).toBe(false)
  })
})

describe('handleAt and turnBetween', () => {
  it('puts the rotate handle above the top edge, at its middle', () => {
    expect(handleAt({ x: 0, y: 100, w: 100, h: 40 }, 20, { width: 300, height: 300 })).toEqual([50, 80])
  })

  it('keeps the rotate handle on the picture when there is no room above the box', () => {
    // Above the box would be y = -20, off the picture: the handle goes below the bottom edge instead.
    expect(handleAt({ x: 0, y: 0, w: 100, h: 40 }, 20, { width: 300, height: 300 })).toEqual([50, 60])
  })

  it('keeps the rotate handle on the picture when a box is as tall as the picture allows', () => {
    // Above (y = -16) and below (y = 416 on a 400 px picture) both miss the picture: the handle sits on its top edge.
    expect(handleAt({ x: 0, y: 10, w: 100, h: 380 }, 26, { width: 300, height: 400 })).toEqual([50, 0])
  })

  it('keeps the rotate handle within the picture width when the box centre is past the right or left edge', () => {
    // A box whose centre is at x = 315 on a 300 px picture: the handle stays at the right edge.
    expect(handleAt({ x: 285, y: 100, w: 60, h: 50 }, 20, { width: 300, height: 300 })).toEqual([300, 80])
    expect(handleAt({ x: -80, y: 100, w: 60, h: 50 }, 20, { width: 300, height: 300 })).toEqual([0, 80])
  })

  it('reads the angle a pointer turns through, seen from the centre', () => {
    const centre: [number, number] = [50, 50]
    expect(angleAt(centre, [100, 50])).toBeCloseTo(0, 9)
    // From the handle (straight up) to the right of the centre is a quarter turn clockwise.
    expect(turnBetween(centre, [50, 0], [100, 50])).toBeCloseTo(Math.PI / 2, 9)
    // Back the other way is a quarter turn back.
    expect(turnBetween(centre, [100, 50], [50, 0])).toBeCloseTo(-Math.PI / 2, 9)
  })

  it('wraps a turn that crosses the half circle into (-PI, PI]', () => {
    // From just above the negative x-axis to just below it: a small turn, not a near full circle.
    const centre: [number, number] = [0, 0]
    const turned = turnBetween(centre, [-1, 0.001], [-1, -0.001])
    expect(turned).toBeGreaterThan(0)
    expect(turned).toBeLessThan(0.01)
    const back = turnBetween(centre, [-1, -0.001], [-1, 0.001])
    expect(back).toBeLessThan(0)
    expect(back).toBeGreaterThan(-0.01)
  })
})

describe('history', () => {
  it('undoes and redoes one step at a time', () => {
    let h = createHistory(['a'])
    h = edit(h, ['a', 'b'])
    h = edit(h, ['a', 'b', 'c'])
    h = undo(h)
    expect(h.present).toEqual(['a', 'b'])
    h = undo(h)
    expect(h.present).toEqual(['a'])
    h = redo(h)
    expect(h.present).toEqual(['a', 'b'])
    h = redo(h)
    expect(h.present).toEqual(['a', 'b', 'c'])
  })

  it('does nothing when there is no step to undo or redo', () => {
    const h = createHistory([1])
    expect(undo(h)).toBe(h)
    expect(redo(h)).toBe(h)
  })

  it('clears the redo stack on a new edit', () => {
    let h = createHistory(['a'])
    h = edit(h, ['b'])
    h = undo(h)
    expect(h.future).toHaveLength(1)
    h = edit(h, ['c'])
    expect(h.future).toEqual([])
    expect(redo(h).present).toEqual(['c'])
    expect(h.present).toEqual(['c'])
  })

  it('does not record an edit that leaves the picture as it was', () => {
    const list = ['a']
    const h = createHistory(list)
    expect(edit(h, list)).toBe(h)
  })

  it('replaces the present without a step of its own', () => {
    let h = createHistory(['a'])
    h = replace(h, ['a*'])
    expect(h.present).toEqual(['a*'])
    expect(h.past).toEqual([])
  })
})

describe('carryNotes', () => {
  it('keeps a note written after the snapshot on the mark it belongs to', () => {
    const restored = [rect('a', 0, 0, 1, 1, { note: 'old' }), rect('b', 0, 0, 1, 1)]
    const current = [rect('a', 0, 0, 1, 1, { note: 'new' })]
    const merged = carryNotes(restored, current)
    expect(merged[0]!.note).toBe('new')
    // A mark gone from the picture keeps its snapshot note.
    expect(merged[1]!.note).toBeUndefined()
  })

  it('returns the restored marks as they were when no note changed', () => {
    const restored = [rect('a', 0, 0, 1, 1, { note: 'same' })]
    expect(carryNotes(restored, [rect('a', 0, 0, 1, 1, { note: 'same' })])[0]).toBe(restored[0])
  })
})

describe('scaleMark', () => {
  it('scales an unturned box exactly about its anchor, each axis by its own factor', () => {
    const r = scaleMark(rect('a', 10, 10, 20, 40), [0, 0], 2, 0.5)
    expect(r.rect).toEqual({ x: 20, y: 5, w: 40, h: 20 })
    expect(r.rotation).toBeUndefined()
    expect('rotation' in r).toBe(false)
  })

  it('keeps the anchor where it is when the anchor is not the origin', () => {
    expect(scaleMark(rect('a', 20, 20, 10, 10), [10, 10], 2, 2).rect).toEqual({ x: 30, y: 30, w: 20, h: 20 })
  })

  it('returns the mark itself for factors of one', () => {
    const a = rect('a', 1, 2, 3, 4)
    expect(scaleMark(a, [0, 0], 1, 1)).toBe(a)
  })

  it('scales a stroke point by point, keeping its order, id, colour and width', () => {
    const a = pen('p', [
      [0, 0],
      [10, 0],
      [10, 10],
    ])
    const r = scaleMark(a, [0, 0], 2, 1)
    expect(r.points).toEqual([
      [0, 0],
      [20, 0],
      [20, 10],
    ])
    expect(r.from).toEqual([0, 0])
    expect(r).toMatchObject({ id: 'p', color: a.color, width: a.width })
  })

  it('scales both ends of a line or an arrow', () => {
    const r = scaleMark(line('l', [0, 0], [10, 20], 'arrow'), [0, 0], 0.5, 2)
    expect(r.from).toEqual([0, 0])
    expect(r.to).toEqual([5, 40])
    expect(r.kind).toBe('arrow')
  })

  it('scales a turned box by the mean of the factors, keeps its angle and moves its centre with the group', () => {
    const turned = rect('a', 0, 0, 100, 50, { rotation: 0.5 })
    const r = scaleMark(turned, [0, 0], 2, 1)
    expect(r.rotation).toBe(0.5)
    expect(r.rect!.w).toBeCloseTo(150)
    expect(r.rect!.h).toBeCloseTo(75)
    // The centre (50, 25) goes to (100, 25) under the group's scale, and the box is centred there.
    expect(pivotOf(r)[0]).toBeCloseTo(100)
    expect(pivotOf(r)[1]).toBeCloseTo(25)
  })

  it('scales a turned line about where its centre goes, and keeps its angle', () => {
    const turned = line('l', [0, 0], [100, 0])
    const r = scaleMark({ ...turned, rotation: 1 }, [0, 0], 2, 1)
    expect(r.rotation).toBe(1)
    expect(r.from![0]).toBeCloseTo(25)
    expect(r.from![1]).toBeCloseTo(0)
    expect(r.to![0]).toBeCloseTo(175)
    expect(r.to![1]).toBeCloseTo(0)
  })

  it('scales text through its stroke width by the mean, so its box follows, and leaves its string alone', () => {
    const t: Annotation = { id: 't', kind: 'text', color: '#000', width: 4, from: [10, 10], text: 'ab' }
    const r = scaleMark(t, [0, 0], 2, 2)
    expect(r.width).toBe(8)
    expect(r.from).toEqual([20, 20])
    expect(r.text).toBe('ab')
    const unevenly = scaleMark(t, [0, 0], 2, 1)
    expect(unevenly.width).toBe(6)
    expect(unevenly.from).toEqual([20, 10])
  })

  it('keeps a turned text centred where the group sends its centre', () => {
    const t: Annotation = {
      id: 't',
      kind: 'text',
      color: '#000',
      width: 4,
      from: [10, 10],
      text: 'ab',
      rotation: 0.3,
    }
    // Its box is 19.2 by 19.2 with its centre at (19.6, 19.6); scaled by 2 about the origin, the centre is (39.2, 39.2).
    const r = scaleMark(t, [0, 0], 2, 2)
    expect(r.rotation).toBe(0.3)
    expect(r.width).toBe(8)
    expect(r.from![0]).toBeCloseTo(20)
    expect(r.from![1]).toBeCloseTo(20)
    expect(pivotOf(r)[0]).toBeCloseTo(39.2)
    expect(pivotOf(r)[1]).toBeCloseTo(39.2)
  })

  it('caps the width of text so the document stays one the server takes', () => {
    const t: Annotation = { id: 't', kind: 'text', color: '#000', width: 150, from: [0, 0], text: 'x' }
    expect(scaleMark(t, [0, 0], 2, 2).width).toBe(200)
  })
})

describe('resizeFactors', () => {
  const box = { x: 20, y: 20, w: 80, h: 80 }

  it('moves one side and keeps the other: the anchor is the opposite edge and the other axis is untouched', () => {
    const r = resizeFactors(box, 'e', [130, 50])
    expect(r.anchor).toEqual([20, 20])
    expect(r.sx).toBeCloseTo(110 / 80)
    expect(r.sy).toBe(1)
  })

  it('moves a corner on both axes, with the opposite corner as the anchor', () => {
    const r = resizeFactors(box, 'se', [140, 130])
    expect(r.anchor).toEqual([20, 20])
    expect(r.sx).toBeCloseTo(120 / 80)
    expect(r.sy).toBeCloseTo(110 / 80)
  })

  it('takes the top-left corner as the anchor when it is the far corner that moves', () => {
    const r = resizeFactors(box, 'nw', [40, 40])
    expect(r.anchor).toEqual([100, 100])
    expect(r.sx).toBeCloseTo(0.75)
    expect(r.sy).toBeCloseTo(0.75)
  })

  it('keeps a side at least 4 px when the pointer is dragged past the opposite edge, so the box never flips', () => {
    const west = resizeFactors(box, 'w', [150, 50])
    expect(west.anchor[0]).toBe(100)
    expect(west.sx * 80).toBeCloseTo(4)
    expect(west.sx).toBeGreaterThan(0)
    const north = resizeFactors(box, 'n', [50, 120])
    expect(north.sy * 80).toBeCloseTo(4)
  })

  it('does not resize on an axis of zero width or height', () => {
    const vertical = { x: 50, y: 0, w: 0, h: 100 }
    expect(resizeFactors(vertical, 'e', [200, 50]).sx).toBe(1)
    expect(resizeFactors(vertical, 'w', [0, 50]).sx).toBe(1)
    const sy = resizeFactors(vertical, 's', [50, 150]).sy
    expect(sy).toBeCloseTo(1.5)
  })
})

describe('resizeHandleAt', () => {
  const box = { x: 100, y: 100, w: 100, h: 100 }

  it('places the eight handles on the corners and the middles of the sides', () => {
    expect(RESIZE_PARTS).toHaveLength(8)
    expect(handlePoint(box, 'nw')).toEqual([100, 100])
    expect(handlePoint(box, 'n')).toEqual([150, 100])
    expect(handlePoint(box, 'ne')).toEqual([200, 100])
    expect(handlePoint(box, 'e')).toEqual([200, 150])
    expect(handlePoint(box, 'se')).toEqual([200, 200])
    expect(handlePoint(box, 's')).toEqual([150, 200])
    expect(handlePoint(box, 'sw')).toEqual([100, 200])
    expect(handlePoint(box, 'w')).toEqual([100, 150])
  })

  it('finds each handle at its own point, within the reach', () => {
    for (const part of RESIZE_PARTS) {
      const [x, y] = handlePoint(box, part)
      expect(resizeHandleAt(box, [x + 2, y - 2], 8), part).toBe(part)
    }
  })

  it('finds nothing beyond the reach, or away from the box', () => {
    expect(resizeHandleAt(box, [150, 130], 8)).toBeNull()
    expect(resizeHandleAt(box, [100, 80], 8)).toBeNull()
  })

  it('takes the nearest handle when several are within reach', () => {
    const tiny = { x: 0, y: 0, w: 4, h: 4 }
    expect(resizeHandleAt(tiny, [0.2, 0.1], 10)).toBe('nw')
  })

  it('has no east or west handle on a box of zero width, so the middle of a vertical line is no handle', () => {
    const line = { x: 100, y: 20, w: 0, h: 100 }
    expect(resizeHandleAt(line, [100, 70], 8)).toBeNull()
    expect(resizeHandleAt(line, [140, 70], 8)).toBeNull()
    // Its ends still take the corner handles, which resize its height.
    const end = resizeHandleAt(line, [100, 20], 8)
    expect(end === 'nw' || end === 'n' || end === 'ne').toBe(true)
  })

  it('has no north or south handle on a box of zero height, so the middle of a horizontal line is no handle', () => {
    const line = { x: 20, y: 100, w: 100, h: 0 }
    expect(resizeHandleAt(line, [70, 100], 8)).toBeNull()
    expect(resizeHandleAt(line, [70, 60], 8)).toBeNull()
    expect(resizeHandleAt(line, [20, 100], 8)).not.toBeNull()
  })

  it('has no corner handle in the middle of a short horizontal line, so a press there moves it', () => {
    const line = { x: 100, y: 100, w: 12, h: 0 }
    expect(resizeHandleAt(line, [106, 100], 8)).toBeNull()
    // Its ends still take the handles that resize its width: a corner or the side at that end.
    expect(resizeHandleAt(line, [101, 100], 8)).toMatch(/^(nw|w|sw)$/)
    expect(resizeHandleAt(line, [111, 100], 8)).toMatch(/^(ne|e|se)$/)
    // A box 10 px across keeps its corners at full reach, so a press at its middle still resizes it.
    expect(resizeHandleAt({ x: 100, y: 100, w: 10, h: 10 }, [105, 105], 8)).toMatch(/^(nw|ne|se|sw)$/)
  })

  it('is no side handle in the middle of a box 10 px across, so a press there moves it', () => {
    const narrow = { x: 100, y: 100, w: 10, h: 100 }
    expect(resizeHandleAt(narrow, [105, 150], 8)).toBeNull()
    // Its corners keep the full reach, so they still resize it.
    expect(resizeHandleAt(narrow, [100, 100], 8)).toBe('nw')
  })

  it('keeps a side handle on a wide box, at its full reach from the edge', () => {
    const wide = { x: 100, y: 100, w: 300, h: 300 }
    expect(resizeHandleAt(wide, [104, 250], 8)).toBe('w')
    expect(resizeHandleAt(wide, [250, 104], 8)).toBe('n')
  })

  it("takes a thin line's side handle at its edge, and not in its middle, so a press in the middle moves it", () => {
    const line = { x: 100, y: 60, w: 10, h: 180 }
    expect(resizeHandleAt(line, [105, 150], 8)).toBeNull()
    expect(resizeHandleAt(line, [101, 150], 8)).toBe('w')
  })

  it('has no handles on a box with no size at all, so a press on a dot moves it', () => {
    expect(resizeHandleAt({ x: 100, y: 100, w: 0, h: 0 }, [100, 100], 8)).toBeNull()
    expect(resizeHandleAt({ x: 100, y: 100, w: 0, h: 0 }, [102, 101], 8)).toBeNull()
  })
})

describe('partAt', () => {
  const box = { x: 100, y: 100, w: 100, h: 100 }
  // The rotate tip sits 26 above the top middle, at (150, 74).
  const layout: Layout = { gap: 26, handleReach: 8, tipReach: 21, picture: { width: 300, height: 300 } }

  it('is a resize handle first, wherever the handle is on the box', () => {
    expect(partAt(box, [], [200, 150], layout)).toBe('e')
    expect(partAt(box, [], [101, 99], layout)).toBe('nw')
  })

  it('is the rotate tip when no mark lies under it', () => {
    expect(partAt(box, [], [150, 74], layout)).toBe('rotate')
  })

  it('is a move on a mark under the rotate tip, so the mark wins over the tip', () => {
    expect(partAt(box, [rect('m', 140, 60, 20, 20)], [150, 74], layout)).toBe('move')
  })

  it('is a move in the middle of a box 10 px across, where its side handle would have been', () => {
    const narrow = { x: 100, y: 100, w: 10, h: 100 }
    expect(partAt(narrow, [], [105, 150], layout)).toBe('move')
  })

  it('is the rotate tip on a selected mark under it, whose own reach covers the tip', () => {
    const thick = { ...rect('m', 100, 100, 100, 100), width: 20 }
    expect(partAt(box, [thick], [150, 74], layout, new Set(['m']))).toBe('rotate')
  })

  it('is a move on an unselected mark under the rotate tip, even one whose reach covers the tip', () => {
    const thick = { ...rect('m', 100, 100, 100, 100), width: 20 }
    expect(partAt(box, [thick], [150, 74], layout, new Set())).toBe('move')
  })

  it('is a move on a selected mark away from the tip, and inside the box', () => {
    const thick = { ...rect('m', 100, 100, 100, 100), width: 20 }
    expect(partAt(box, [thick], [150, 150], layout, new Set(['m']))).toBe('move')
  })

  it('is a move inside the box, and on a mark outside it', () => {
    expect(partAt(box, [], [150, 150], layout)).toBe('move')
    expect(partAt(box, [rect('m', 20, 20, 20, 20)], [30, 30], layout)).toBe('move')
  })

  it('is a move on the middle of a zero-width line, where a side handle would have been', () => {
    const line = { x: 100, y: 20, w: 0, h: 100 }
    expect(partAt(line, [], [100, 70], layout)).toBe('move')
  })

  it('is a move on a pen stroke whose points all coincide, and a drag moves it from its point', () => {
    const dot: Annotation = {
      id: 'dot',
      kind: 'pen',
      color: '#000',
      width: 4,
      points: [
        [100, 100],
        [100, 100],
      ],
    }
    expect(partAt(markBounds(dot), [dot], [100, 100], layout)).toBe('move')
    expect(translateMark(dot, 40, 0).points).toEqual([
      [140, 100],
      [140, 100],
    ])
  })

  it('is null elsewhere, and the tip only exists with a selection', () => {
    expect(partAt(box, [], [20, 20], layout)).toBeNull()
    expect(partAt(null, [], [150, 74], layout)).toBeNull()
  })
})

describe('cursorOf', () => {
  it('shows the resize arrow of each side and corner, grab on the tip, move inside, default elsewhere', () => {
    expect(cursorOf('n')).toBe('ns-resize')
    expect(cursorOf('s')).toBe('ns-resize')
    expect(cursorOf('e')).toBe('ew-resize')
    expect(cursorOf('w')).toBe('ew-resize')
    expect(cursorOf('nw')).toBe('nwse-resize')
    expect(cursorOf('se')).toBe('nwse-resize')
    expect(cursorOf('ne')).toBe('nesw-resize')
    expect(cursorOf('sw')).toBe('nesw-resize')
    expect(cursorOf('rotate')).toBe('grab')
    expect(cursorOf('move')).toBe('move')
    expect(cursorOf(null)).toBe('default')
  })
})

describe('deleteAt', () => {
  it('puts the X to the right of the rotate tip, or to the left at the picture edge', () => {
    expect(deleteAt([50, 40], 16, { width: 300 })).toEqual([66, 40])
    expect(deleteAt([290, 40], 16, { width: 300 })).toEqual([274, 40])
  })

  it('keeps the X on the picture when neither side has room for it, as on a picture 24 px wide', () => {
    expect(deleteAt([12, 0], 16, { width: 24 })).toEqual([0, 0])
  })
})

describe('fillMark and isFillable', () => {
  it('fills a box or an ellipse, and keeps the same mark when it is already filled', () => {
    const box = rect('a', 1, 2, 3, 4)
    const filled = fillMark(box, true)
    expect(filled.fill).toBe(true)
    expect(box.fill).toBeUndefined()
    expect(fillMark(filled, true)).toBe(filled)
  })

  it('takes the fill away with the key, and returns an unfilled mark as it was', () => {
    const filled = fillMark(rect('a', 1, 2, 3, 4), true)
    const plain = fillMark(filled, false)
    expect('fill' in plain).toBe(false)
    expect(plain.rect).toEqual({ x: 1, y: 2, w: 3, h: 4 })
    const untouched = rect('b', 1, 2, 3, 4)
    expect(fillMark(untouched, false)).toBe(untouched)
  })

  it('is true for a box and an ellipse only', () => {
    expect(isFillable(rect('a', 0, 0, 1, 1))).toBe(true)
    expect(isFillable(ellipse('e', 0, 0, 1, 1))).toBe(true)
    expect(isFillable(pen('p', [[0, 0]]))).toBe(false)
    expect(isFillable(line('l', [0, 0], [1, 1]))).toBe(false)
  })
})
