import { describe, expect, it } from 'vitest'

import {
  angleAt,
  carryNotes,
  createHistory,
  edit,
  handleAt,
  isTinyDrag,
  markAt,
  markBounds,
  marqueeIds,
  pivotOf,
  redo,
  replace,
  rotateMark,
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
    expect(handleAt({ x: 0, y: 100, w: 100, h: 40 }, 20)).toEqual([50, 80])
  })

  it('keeps the rotate handle on the picture when there is no room above the box', () => {
    // Above the box would be y = -20, off the picture: the handle goes below the bottom edge instead.
    expect(handleAt({ x: 0, y: 0, w: 100, h: 40 }, 20)).toEqual([50, 60])
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
