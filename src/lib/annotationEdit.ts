import type { Annotation } from '#/lib/annotations'

/**
 * The edits the annotation canvas makes to the marks it holds: picking them, moving and turning
 * them, and the history their edits go through. Pure, so the canvas only paints and routes pointers.
 *
 * A mark turns about its own centre: `rotation` is the angle, in radians, its shape is drawn at
 * around the centre of its unturned box. Turning a group moves each mark's centre and adds to its
 * `rotation`, so a mark nobody turned keeps no `rotation` key at all.
 */

export type Point = [number, number]
export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Text is drawn at four times the stroke width, so one control sizes everything drawn. */
export const textSize = (a: Annotation) => Math.max(12, a.width * 4)

/** The box a mark covers before it turns: its own rect, its text's extent, or its points' bounds. */
export function localBox(a: Annotation): Box {
  if (a.rect) return a.rect
  if (a.kind === 'text' && a.from) {
    const size = textSize(a)
    return { x: a.from[0], y: a.from[1], w: (a.text?.length ?? 1) * size * 0.6, h: size * 1.2 }
  }
  const points = a.points ?? [a.from, a.to].filter((p): p is Point => Boolean(p))
  if (!points.length) return { x: 0, y: 0, w: 0, h: 0 }
  const xs = points.map(([x]) => x)
  const ys = points.map(([, y]) => y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

/** The centre of a mark's unturned box: what it turns about. */
export function pivotOf(a: Annotation): Point {
  const b = localBox(a)
  return [b.x + b.w / 2, b.y + b.h / 2]
}

/** A point turned about `centre` by `angle` radians, in the canvas's y-down frame (as `ctx.rotate`). */
export function turn([x, y]: Point, [cx, cy]: Point, angle: number): Point {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const dx = x - cx
  const dy = y - cy
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos]
}

const corners = ({ x, y, w, h }: Box): Point[] => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
]

/** The shape's own points, unturned: the corners of a box or text, the points of a stroke or a line's ends. */
function shapePoints(a: Annotation): Point[] {
  if (a.rect) return corners(a.rect)
  if (a.kind === 'text' && a.from) return corners(localBox(a))
  return a.points ?? [a.from, a.to].filter((p): p is Point => Boolean(p))
}

/** Where the mark's points are on the picture now, turned. */
export function markPoints(a: Annotation): Point[] {
  const points = shapePoints(a)
  if (!a.rotation) return points
  const centre = pivotOf(a)
  return points.map((p) => turn(p, centre, a.rotation!))
}

/** The mark's box on the picture now: its turned bounds, or its box when it is not turned. */
export function markBounds(a: Annotation): Box {
  if (!a.rotation) return localBox(a)
  const points = markPoints(a)
  if (!points.length) return { x: 0, y: 0, w: 0, h: 0 }
  const xs = points.map(([x]) => x)
  const ys = points.map(([, y]) => y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

function distanceToSegment(x: number, y: number, [x1, y1]: Point, [x2, y2]: Point) {
  const dx = x2 - x1
  const dy = y2 - y1
  const length = dx * dx + dy * dy
  const t = length ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / length)) : 0
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))
}

/** The mark under a point, the newest first, so a click picks the one on top. */
export function markAt(items: Annotation[], x: number, y: number): Annotation | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const a = items[i]!
    const reach = a.width + 6
    const points = markPoints(a)
    if (a.kind === 'pen' && points.some(([px, py]) => Math.hypot(px - x, py - y) <= reach)) return a
    if ((a.kind === 'line' || a.kind === 'arrow') && a.from && a.to) {
      const [start, end] = points
      if (start && end && distanceToSegment(x, y, start, end) <= reach) return a
      // A line or an arrow is picked by its segment only: its box would catch the empty corners of a diagonal.
      continue
    }
    const b = markBounds(a)
    const inside = x >= b.x - reach && x <= b.x + b.w + reach && y >= b.y - reach && y <= b.y + b.h + reach
    if (inside && a.kind !== 'pen') return a
  }
  return undefined
}

/** The box around a set of marks, or null when there are none. */
export function unionBounds(items: Annotation[]): Box | null {
  if (!items.length) return null
  const boxes = items.map(markBounds)
  const x = Math.min(...boxes.map((b) => b.x))
  const y = Math.min(...boxes.map((b) => b.y))
  const right = Math.max(...boxes.map((b) => b.x + b.w))
  const bottom = Math.max(...boxes.map((b) => b.y + b.h))
  return { x, y, w: right - x, h: bottom - y }
}

/** A drag this short in both directions is a click, not a box: it selects nothing. */
export function isTinyDrag([x0, y0]: Point, [x1, y1]: Point) {
  return Math.abs(x1 - x0) < 3 && Math.abs(y1 - y0) < 3
}

/** The ids of the marks whose box meets the box dragged out from `from` to `to`; a tiny drag selects none. */
export function marqueeIds(items: Annotation[], from: Point, to: Point): string[] {
  if (isTinyDrag(from, to)) return []
  const minX = Math.min(from[0], to[0])
  const maxX = Math.max(from[0], to[0])
  const minY = Math.min(from[1], to[1])
  const maxY = Math.max(from[1], to[1])
  return items
    .filter((a) => {
      const b = markBounds(a)
      return b.x <= maxX && b.x + b.w >= minX && b.y <= maxY && b.y + b.h >= minY
    })
    .map((a) => a.id)
}

/**
 * The rotate handle: above the top edge of the box, at its middle, `gap` away. Near the top edge of the
 * picture there is no room above, so the handle goes below the box instead, where it stays on the picture.
 */
export function handleAt(box: Box, gap: number): Point {
  const above = box.y - gap
  return [box.x + box.w / 2, above >= 0 ? above : box.y + box.h + gap]
}

/** The angle a point sits at, seen from `centre`. */
export function angleAt(centre: Point, [x, y]: Point) {
  return Math.atan2(y - centre[1], x - centre[0])
}

/** How far the pointer turned round `centre`, from `from` to `to`, in (-PI, PI]. */
export function turnBetween(centre: Point, from: Point, to: Point) {
  const d = angleAt(centre, to) - angleAt(centre, from)
  return Math.atan2(Math.sin(d), Math.cos(d))
}

/** A mark turned about `centre` by `angle`: its centre moves round it and its `rotation` grows by the angle. */
export function rotateMark(a: Annotation, centre: Point, angle: number): Annotation {
  if (!angle) return a
  const p = pivotOf(a)
  const next = turn(p, centre, angle)
  const moved = translateMark(a, next[0] - p[0], next[1] - p[1])
  return { ...moved, rotation: (a.rotation ?? 0) + angle }
}

/** A mark moved by (dx, dy) image pixels. Its ids, order, note and any rotation are kept as they are. */
export function translateMark(a: Annotation, dx: number, dy: number): Annotation {
  if (!dx && !dy) return a
  const move = ([x, y]: Point): Point => [x + dx, y + dy]
  return {
    ...a,
    ...(a.points ? { points: a.points.map(move) } : {}),
    ...(a.from ? { from: move(a.from) } : {}),
    ...(a.to ? { to: move(a.to) } : {}),
    ...(a.rect ? { rect: { ...a.rect, x: a.rect.x + dx, y: a.rect.y + dy } } : {}),
  }
}

/** Notes typed after a snapshot was taken stay when the snapshot comes back by undo or redo. */
export function carryNotes(restored: Annotation[], current: Annotation[]): Annotation[] {
  return restored.map((a) => {
    const now = current.find((c) => c.id === a.id)
    return now && now.note !== a.note ? { ...a, note: now.note } : a
  })
}

/**
 * The undo history of a list of marks: `present` is what is shown, `past` and `future` the steps
 * either side. An edit pushes the present onto `past` and clears `future`, so a redo never
 * reapplies a step that no longer follows.
 */
export interface History<T> {
  past: T[]
  present: T
  future: T[]
}

export const createHistory = <T>(present: T): History<T> => ({ past: [], present, future: [] })

export function edit<T>(h: History<T>, next: T): History<T> {
  if (Object.is(next, h.present)) return h
  return { past: [...h.past, h.present], present: next, future: [] }
}

export function undo<T>(h: History<T>): History<T> {
  const last = h.past[h.past.length - 1]
  if (last === undefined) return h
  return { past: h.past.slice(0, -1), present: last, future: [h.present, ...h.future] }
}

export function redo<T>(h: History<T>): History<T> {
  const [next, ...future] = h.future
  if (next === undefined) return h
  return { past: [...h.past, h.present], present: next, future }
}

/** A change to what is shown that is not a step of its own (a note typed in the field). */
export function replace<T>(h: History<T>, next: T): History<T> {
  return { ...h, present: next }
}
