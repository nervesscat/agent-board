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
    // A box, an ellipse or text is picked where its shape is: the point is turned back into the unturned
    // box it was drawn in, so the empty corners of a turned box's bounds do not catch the pointer.
    const b = localBox(a)
    const [ux, uy] = a.rotation ? turn([x, y], pivotOf(a), -a.rotation) : [x, y]
    const inside =
      ux >= b.x - reach && ux <= b.x + b.w + reach && uy >= b.y - reach && uy <= b.y + b.h + reach
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
 * The rotate handle: above the top edge of the box, at its middle, `gap` away. Where there is no room above
 * (the box is near the picture's top edge), it goes below the bottom edge; where there is none below either
 * (a box as tall as the picture), it sits on the picture's top edge. Its x is kept within the picture's width,
 * so a box dragged past the left or right edge still has its handle on the picture. It always stays on the picture.
 */
export function handleAt(box: Box, gap: number, picture: { width: number; height: number }): Point {
  const centre = Math.min(Math.max(box.x + box.w / 2, 0), picture.width)
  const above = box.y - gap
  if (above >= 0) return [centre, above]
  const below = box.y + box.h + gap
  return [centre, below <= picture.height ? below : 0]
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

/** The eight handles of a selection's box: its corners and the middles of its sides. */
export type ResizePart = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

/** What a pointer over the selection is on: a handle, the rotate tip, or the marks and the box's inside. */
export type Part = ResizePart | 'rotate' | 'move'

/** A side never goes under this many picture pixels when a handle resizes the box. */
export const MIN_SIDE = 4

/** Which way each handle moves a box's edges: -1 the left or top edge, 1 the right or bottom edge, 0 neither. */
const GRIP: Record<ResizePart, [number, number]> = {
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
}

export const RESIZE_PARTS = Object.keys(GRIP) as ResizePart[]

/** Where a handle sits: a corner of the box, or the middle of a side. */
export function handlePoint({ x, y, w, h }: Box, part: ResizePart): Point {
  const [dx, dy] = GRIP[part]
  return [x + ((dx + 1) / 2) * w, y + ((dy + 1) / 2) * h]
}

/**
 * The handle under a point, the nearest one within reach, or null. A box with no size at all has no handles, so a
 * press on a dot moves it. A side handle on an axis of zero size is no handle: a vertical line's east and west
 * handles would sit on its stroke, and a press there moves it. A side handle's reach is at most a third of the box
 * on its axis, so in the middle of a thin line or box a press moves it; the corners keep `reach`, but on a box
 * thinner than `reach` a corner counts only when the point is nearer it than the box's centre.
 */
export function resizeHandleAt(box: Box, point: Point, reach: number): ResizePart | null {
  if (!box.w && !box.h) return null
  const thin = box.w < reach || box.h < reach
  const centre = Math.hypot(point[0] - (box.x + box.w / 2), point[1] - (box.y + box.h / 2))
  let best: ResizePart | null = null
  let bestDistance = Infinity
  for (const part of RESIZE_PARTS) {
    const [dx, dy] = GRIP[part]
    if ((dx && !dy && !box.w) || (dy && !dx && !box.h)) continue
    const partReach = dx && dy ? reach : Math.min(reach, (dx ? box.w : box.h) / 3)
    const [hx, hy] = handlePoint(box, part)
    const distance = Math.hypot(point[0] - hx, point[1] - hy)
    if (dx && dy && thin && distance > centre) continue
    if (distance <= partReach && distance <= bestDistance) {
      best = part
      bestDistance = distance
    }
  }
  return best
}

/**
 * The anchor and the factors a handle resizes a box by when the pointer is at `to`: the edge the handle sits
 * on follows the pointer and the opposite edge stays where it is. A side never goes under `MIN_SIDE`, so a
 * pointer dragged past the anchor clamps rather than flipping the box; a zero-width or zero-height box does
 * not resize on that axis.
 */
export function resizeFactors(
  box: Box,
  part: ResizePart,
  to: Point,
): { anchor: Point; sx: number; sy: number } {
  const [dx, dy] = GRIP[part]
  const x = axisResize(box.x, box.w, dx, to[0])
  const y = axisResize(box.y, box.h, dy, to[1])
  return { anchor: [x.anchor, y.anchor], sx: x.factor, sy: y.factor }
}

function axisResize(start: number, size: number, dir: number, pointer: number) {
  // The anchor is the edge that stays: the left or top one when the handle moves the right or bottom one, else the other.
  const anchor = dir < 0 ? start + size : start
  if (!dir || !size) return { anchor, factor: 1 }
  const raw = dir > 0 ? pointer - start : anchor - pointer
  const side = Math.max(Math.min(MIN_SIDE, size), raw)
  return { anchor, factor: side / size }
}

/** Text's stroke width stays within the range the slider and the server take. */
const TEXT_WIDTH_MIN = 1
const TEXT_WIDTH_MAX = 200

/**
 * A mark scaled about `anchor` by `sx` and `sy`. A mark nobody turned is scaled exactly. A turned mark keeps
 * its angle and scales by the mean of the two factors, its centre moved as the group's centre is. Text scales
 * its stroke width by the mean, so its font and its box follow; its string is left alone.
 */
export function scaleMark(a: Annotation, anchor: Point, sx: number, sy: number): Annotation {
  if (sx === 1 && sy === 1) return a
  const k = (sx + sy) / 2
  const grow = ([x, y]: Point): Point => [anchor[0] + (x - anchor[0]) * sx, anchor[1] + (y - anchor[1]) * sy]
  const centre = pivotOf(a)
  // A turned mark's centre goes where the group sends it; each of its points then scales by k about that centre.
  const moved = a.rotation ? grow(centre) : null
  const place = (p: Point): Point =>
    moved ? [moved[0] + (p[0] - centre[0]) * k, moved[1] + (p[1] - centre[1]) * k] : grow(p)
  if (a.kind === 'text' && a.from) {
    const next = { ...a, width: Math.min(TEXT_WIDTH_MAX, Math.max(TEXT_WIDTH_MIN, a.width * k)) }
    const b = localBox(next)
    const from: Point = moved ? [moved[0] - b.w / 2, moved[1] - b.h / 2] : grow(a.from)
    return { ...next, from }
  }
  const out: Annotation = { ...a }
  if (a.rect) {
    const pts = corners(a.rect).map(place)
    const xs = pts.map(([x]) => x)
    const ys = pts.map(([, y]) => y)
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    out.rect = { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
  }
  if (a.points) out.points = a.points.map(place)
  if (a.from) out.from = place(a.from)
  if (a.to) out.to = place(a.to)
  return out
}

/** A box or an ellipse, the marks a fill can be set on. */
export const isFillable = (a: Annotation) => a.kind === 'rect' || a.kind === 'ellipse'

/** A mark filled or not: a mark that is not filled keeps no `fill` key at all. */
export function fillMark(a: Annotation, on: boolean): Annotation {
  if (on) return a.fill ? a : { ...a, fill: true }
  if (!('fill' in a)) return a
  const next = { ...a }
  delete next.fill
  return next
}

/** The CSS cursor each part shows on hover: the resize arrow of its side or corner, grab on the tip, move inside. */
export const PART_CURSOR: Record<Part, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  rotate: 'grab',
  move: 'move',
}

export const cursorOf = (part: Part | null) => (part ? PART_CURSOR[part] : 'default')

/**
 * Where the X that deletes a selection sits: beside its rotate tip, `offset` to the right, or to the left where
 * there is no room before the picture's edge. On a picture too narrow for either side the X's centre is held at
 * the left edge, so it stays on the picture.
 */
export function deleteAt([x, y]: Point, offset: number, picture: { width: number }): Point {
  return [x + offset <= picture.width ? x + offset : Math.max(0, x - offset), y]
}

/** What the canvas measures a pointer's reach with, in picture pixels, and where the rotate tip sits. */
export interface Layout {
  /** The rotate tip's distance above the box (the tip's `handleAt` gap). */
  gap: number
  /** How far from a handle's point a press still takes it. */
  handleReach: number
  /** How far from the rotate tip a press still turns the selection. */
  tipReach: number
  picture: { width: number; height: number }
}

/** Whether a point is inside a box, its edges included. */
export function insideBox(box: Box, [x, y]: Point): boolean {
  return x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h
}

/**
 * The part of the selection a pointer is over, in the order a press takes it: a resize handle; the rotate tip,
 * unless a mark lies under the pointer that is not selected (an unselected mark wins; a selected one, whose own
 * reach may cover the tip, does not); a mark, or the inside of the selection's box. Null elsewhere. With no
 * selection (`box` null) only the marks count.
 */
export function partAt(
  box: Box | null,
  items: Annotation[],
  point: Point,
  layout: Layout,
  selected: ReadonlySet<string> = new Set(),
): Part | null {
  if (box) {
    const handle = resizeHandleAt(box, point, layout.handleReach)
    if (handle) return handle
  }
  const mark = markAt(items, point[0], point[1])
  if (box && (!mark || selected.has(mark.id))) {
    const [tx, ty] = handleAt(box, layout.gap, layout.picture)
    if (Math.hypot(point[0] - tx, point[1] - ty) <= layout.tipReach) return 'rotate'
  }
  if (mark) return 'move'
  if (box && insideBox(box, point)) return 'move'
  return null
}

/** Whether a point is on a box's grips: one of its eight resize handles or its rotate tip. */
export function onGrip(box: Box, point: Point, layout: Layout): boolean {
  if (resizeHandleAt(box, point, layout.handleReach)) return true
  const [tx, ty] = handleAt(box, layout.gap, layout.picture)
  return Math.hypot(point[0] - tx, point[1] - ty) <= layout.tipReach
}

/**
 * The mark the pointer is hovering, whose selection chrome the Select tool then shows: the mark whose
 * grips (handles, rotate tip) the pointer is on, so the chrome stays while the pointer travels to a
 * handle that lies outside the mark; else the mark under the pointer, the newest first; else the
 * current mark while the pointer is still inside its box; else none. `current` is the id hovered so far.
 */
export function hoverTarget(
  items: Annotation[],
  current: string | null,
  point: Point,
  layout: Layout,
): string | null {
  const now = current ? items.find((a) => a.id === current) : undefined
  if (now && onGrip(markBounds(now), point, layout)) return now.id
  const hit = markAt(items, point[0], point[1])
  if (hit) return hit.id
  if (now && insideBox(markBounds(now), point)) return now.id
  return null
}

/**
 * The marks whose selection chrome (outline, handles, rotate tip) is on screen. Only the Select tool
 * shows any: the selected marks, always, as one group, and the hovered mark when it is not one of them.
 * With any other tool, or with no mark selected or hovered, there is none.
 */
export function chromeOf(
  tool: string,
  picked: Annotation[],
  hovered: Annotation | undefined,
): { group: Annotation[]; hovered: Annotation | null } {
  if (tool !== 'select') return { group: [], hovered: null }
  return {
    group: picked,
    hovered: hovered && !picked.some((a) => a.id === hovered.id) ? hovered : null,
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
