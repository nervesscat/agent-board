import {
  Circle,
  MessageSquarePlus,
  MousePointer2,
  MoveUpRight,
  Pencil,
  Redo2,
  Square,
  Type,
  Undo2,
} from 'lucide-react'
import { type PointerEvent, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { TrashIcon } from '#/components/TrashIcon'
import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { Tip } from '#/components/ui/tooltip'
import {
  type Box,
  type History,
  type Layout,
  type Point,
  type ResizePart,
  RESIZE_PARTS,
  carryNotes,
  createHistory,
  cursorOf,
  deleteAt,
  edit,
  fillMark,
  handleAt,
  handlePoint,
  insideBox,
  isFillable,
  isTinyDrag,
  markAt,
  markBounds,
  marqueeIds,
  partAt,
  pivotOf,
  redo,
  replace,
  resizeFactors,
  resizeHandleAt,
  rotateMark,
  scaleMark,
  textSize,
  translateMark,
  turnBetween,
  unionBounds,
  undo,
} from '#/lib/annotationEdit'
import type { Annotation, AnnotationDoc, AnnotationKind } from '#/lib/annotations'
import { ANNOTATION_TEXT_MAX, annotatable, keepAnnotations } from '#/lib/annotations'
import { errorMessage } from '#/lib/api'
import { cn } from '#/lib/utils'

/**
 * The canvas an image passes through before it is attached: draw on the picture with a pencil, a
 * box, an arrow, an ellipse or text, select marks to move, turn or delete them, write what each mark
 * means beside it, and attach the flattened picture, which carries the drawings and, as data next to
 * it, the notes. Plain Canvas 2D: the repo has no drawing library.
 */
export interface AnnotatedImage {
  /** The picture as it was drawn on, ready to attach. */
  file: File
  /** The shapes and their notes, to store beside it. */
  annotations: AnnotationDoc
}

type Tool = AnnotationKind | 'note' | 'select'

const TOOLS: { tool: Tool; label: string; hint: string; Icon: typeof Pencil }[] = [
  { tool: 'select', label: 'Select', hint: 'Pick marks to move, turn or delete them', Icon: MousePointer2 },
  { tool: 'pen', label: 'Pencil', hint: 'Draw freehand', Icon: Pencil },
  { tool: 'rect', label: 'Box', hint: 'Draw a box around something', Icon: Square },
  { tool: 'arrow', label: 'Arrow', hint: 'Point at something', Icon: MoveUpRight },
  { tool: 'ellipse', label: 'Ellipse', hint: 'Circle something', Icon: Circle },
  { tool: 'text', label: 'Text', hint: 'Write on the picture', Icon: Type },
  { tool: 'note', label: 'Note', hint: 'Click a mark to write its note', Icon: MessageSquarePlus },
]

const DEFAULT_COLOR = '#e11d48'
const DEFAULT_WIDTH = 4

/** The rotate handle sits this far above the selection's box, and is this big, in css pixels. */
const HANDLE_GAP = 26
const HANDLE_RADIUS = 7
/** How far a press may be from the rotate tip and still turn the selection, in css pixels. */
const TIP_REACH = HANDLE_RADIUS * 3
/** The resize handles are squares this wide, and a press within this many css pixels of one takes it. */
const HANDLE_SIZE = 8
const HANDLE_REACH = 8
/** The X that deletes the selection sits this far right of the rotate tip, with a radius of this many css pixels. */
const X_OFFSET = 16
const X_RADIUS = 6
const X_REACH = 9

/** What the canvas paints over the picture while marks are selected: the group box, its handles and its tip. */
interface Overlay {
  picked: Annotation[]
  marquee: Box | null
  /** The pointer is near the rotate tip, so the X that deletes the selection is shown beside it. */
  hover: boolean
}

/** How far a point is from another, in picture pixels, and whether it is within `reach` of it. */
const within = (p: Point, q: Point, reach: number) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= reach

/**
 * A pointer gesture on the picture in Select mode. `next` is the picture the gesture would leave,
 * painted as a preview and committed as one history step when the pointer lets go.
 */
interface Gesture {
  mode: 'move' | 'turn' | 'marquee' | 'resize'
  /** The pointer that began the gesture: a second pointer's moves and release do not drive it. */
  pointer: number
  start: Point
  /** The marks the gesture moves or turns. */
  ids: Set<string>
  /** The picture when the gesture began. */
  base: Annotation[]
  /** What a turn turns about: the centre of the selection's box. */
  centre: Point
  /** A marquee added to the selection (Shift held) rather than replacing it. */
  additive: boolean
  /** A press on a mark that was part of several: a click without a drag picks it alone. */
  pick?: string
  /** A resize: the selection's box when the gesture began, and the handle it grabbed. */
  grip?: { box: Box; part: ResizePart }
  next: Annotation[] | null
}

function drawMark(ctx: CanvasRenderingContext2D, a: Annotation) {
  ctx.save()
  ctx.strokeStyle = a.color
  ctx.fillStyle = a.color
  ctx.lineWidth = a.width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (a.rotation) {
    const [cx, cy] = pivotOf(a)
    ctx.translate(cx, cy)
    ctx.rotate(a.rotation)
    ctx.translate(-cx, -cy)
  }
  if (a.kind === 'pen' && a.points?.length) {
    const [[x0, y0], ...rest] = a.points
    if (!rest.length) {
      ctx.beginPath()
      ctx.arc(x0!, y0!, a.width / 2, 0, Math.PI * 2)
      ctx.fill()
    } else {
      ctx.beginPath()
      ctx.moveTo(x0!, y0!)
      for (const [x, y] of rest) ctx.lineTo(x, y)
      ctx.stroke()
    }
  } else if ((a.kind === 'line' || a.kind === 'arrow') && a.from && a.to) {
    const [x1, y1] = a.from
    const [x2, y2] = a.to
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()
    if (a.kind === 'arrow') {
      const angle = Math.atan2(y2 - y1, x2 - x1)
      const size = Math.max(10, a.width * 4)
      for (const turn of [Math.PI / 7, -Math.PI / 7]) {
        ctx.beginPath()
        ctx.moveTo(x2, y2)
        ctx.lineTo(x2 - size * Math.cos(angle - turn), y2 - size * Math.sin(angle - turn))
        ctx.stroke()
      }
    }
  } else if (a.kind === 'rect' && a.rect) {
    if (a.fill) ctx.fillRect(a.rect.x, a.rect.y, a.rect.w, a.rect.h)
    ctx.strokeRect(a.rect.x, a.rect.y, a.rect.w, a.rect.h)
  } else if (a.kind === 'ellipse' && a.rect) {
    ctx.beginPath()
    ctx.ellipse(
      a.rect.x + a.rect.w / 2,
      a.rect.y + a.rect.h / 2,
      Math.abs(a.rect.w / 2),
      Math.abs(a.rect.h / 2),
      0,
      0,
      Math.PI * 2,
    )
    if (a.fill) ctx.fill()
    ctx.stroke()
  } else if (a.kind === 'text' && a.from) {
    const size = textSize(a)
    ctx.font = `600 ${size}px ui-sans-serif, system-ui, sans-serif`
    ctx.textBaseline = 'top'
    ctx.fillText(a.text ?? '', a.from[0], a.from[1])
  }
  ctx.restore()
}

/**
 * The picture, the marks, the numbered notes and, when an overlay is given, the selection's box with
 * its rotate handle and the marquee being dragged, at the picture's own size. The overlay is on
 * screen only: the attached render is painted without one.
 */
function paint(canvas: HTMLCanvasElement, bitmap: ImageBitmap, items: Annotation[], overlay: Overlay | null) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(bitmap, 0, 0)
  for (const item of items) drawMark(ctx, item)
  // The number each note is listed under, on top of everything, in the order the notes are listed.
  let n = 0
  for (const item of items) {
    if (!item.note?.trim()) continue
    n++
    const box = markBounds(item)
    const r = Math.max(9, item.width * 2.5)
    const x = Math.min(canvas.width - r, Math.max(r, box.x))
    const y = Math.min(canvas.height - r, Math.max(r, box.y))
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fillStyle = item.color
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.font = `bold ${Math.round(r * 1.2)}px ui-sans-serif, system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(n), x, y + 0.5)
  }
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  if (!overlay) return
  // Image pixels per css pixel: the overlay keeps the same size on screen whatever the picture's size.
  const css = canvas.getBoundingClientRect().width
  const k = css > 0 ? canvas.width / css : 1
  ctx.save()
  ctx.strokeStyle = '#0ea5e9'
  ctx.fillStyle = '#ffffff'
  ctx.lineWidth = 2 * k
  ctx.setLineDash([8 * k, 5 * k])
  if (overlay.marquee) {
    const m = overlay.marquee
    ctx.strokeRect(m.x, m.y, m.w, m.h)
  }
  const box = unionBounds(overlay.picked)
  if (box) {
    ctx.strokeRect(box.x - 6 * k, box.y - 6 * k, box.w + 12 * k, box.h + 12 * k)
    const [hx, hy] = handleAt(box, HANDLE_GAP * k, bitmap)
    ctx.setLineDash([])
    ctx.beginPath()
    ctx.moveTo(box.x + box.w / 2, box.y - 6 * k)
    ctx.lineTo(hx, hy)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(hx, hy, HANDLE_RADIUS * k, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    // The eight resize handles: squares on the box's corners and the middles of its sides.
    const size = HANDLE_SIZE * k
    for (const part of RESIZE_PARTS) {
      const [px, py] = handlePoint(box, part)
      ctx.fillRect(px - size / 2, py - size / 2, size, size)
      ctx.strokeRect(px - size / 2, py - size / 2, size, size)
    }
    // The X beside the rotate tip, only while the pointer is near the tip.
    if (overlay.hover) {
      const [cx, cy] = deleteAt([hx, hy], X_OFFSET * k, bitmap)
      const r = X_RADIUS * k
      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(cx - r / 2, cy - r / 2)
      ctx.lineTo(cx + r / 2, cy + r / 2)
      ctx.moveTo(cx + r / 2, cy - r / 2)
      ctx.lineTo(cx - r / 2, cy + r / 2)
      ctx.stroke()
    }
  }
  ctx.restore()
}

/**
 * The canvas dialog. `file` is the picture to annotate; closing without attaching calls `onCancel`, and
 * `onAttachOriginal` keeps the file exactly as it was picked. `onAttach` gets the picture the canvas was
 * showing along with the flattened one: the step belongs to that picture, not to whoever is at the
 * front of the queue by the time the encode has finished.
 */
export function AnnotateImage({
  file,
  onAttach,
  onAttachOriginal,
  onCancel,
  finalFocus,
}: {
  file: File | null
  onAttach: (annotated: AnnotatedImage, source: File) => void
  onAttachOriginal: () => void
  onCancel: () => void
  /** What the focus goes back to when the canvas closes: whatever opened it. */
  finalFocus?: RefObject<HTMLElement | null>
}) {
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null)
  const [failed, setFailed] = useState('')
  // The marks and their undo history: `history.present` is the picture as it stands.
  const [history, setHistory] = useState<History<Annotation[]>>(() => createHistory<Annotation[]>([]))
  const items = history.present
  // The picture while a select gesture is under way; the committed one otherwise.
  const [preview, setPreview] = useState<Annotation[] | null>(null)
  const shown = preview ?? items
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [marquee, setMarquee] = useState<[Point, Point] | null>(null)
  const [tool, setTool] = useState<Tool>('pen')
  const [color, setColor] = useState(DEFAULT_COLOR)
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  // Whether new boxes and ellipses are drawn filled (the Fill checkbox), and whether the pointer is near the rotate tip.
  const [fill, setFill] = useState(false)
  const [tipHover, setTipHover] = useState(false)
  const [text, setText] = useState('')
  const [draft, setDraft] = useState<Annotation | null>(null)
  const [busy, setBusy] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const origin = useRef<Point | null>(null)
  // The pointer whose press began the drawing, so no other pointer draws or commits its box.
  const originPointer = useRef<number | null>(null)
  // The pointers whose button is down on the canvas, whatever the tool: Escape waits for them to lift.
  const held = useRef(new Set<number>())
  const gesture = useRef<Gesture | null>(null)

  // The marks selected that are still on the picture (an undo can take one away).
  const picked = useMemo(() => shown.filter((a) => selected.has(a.id)), [shown, selected])
  // The X and the tip's hover were set by the pointer over the selection they were for: a new selection (Ctrl+A,
  // a pick, a delete) hides them until the pointer moves near its tip again.
  useEffect(() => {
    setTipHover(false)
  }, [selected])
  const selectedItem = picked.length === 1 ? picked[0] : undefined
  const canUndo = history.past.length > 0 && !busy
  const canRedo = history.future.length > 0 && !busy

  // The picture is decoded once, at its natural size: the marks and the flattened render are in its pixels.
  const decoded = useRef<ImageBitmap | null>(null)
  useEffect(() => {
    // A picture going or coming ends the drawing press of the old one: its release may never reach the canvas.
    origin.current = null
    originPointer.current = null
    held.current.clear()
    if (!file) return
    let dead = false
    setBitmap(null)
    setFailed('')
    setHistory(createHistory<Annotation[]>([]))
    setSelected(new Set())
    setPreview(null)
    setMarquee(null)
    setDraft(null)
    gesture.current = null
    createImageBitmap(file).then(
      (made) => {
        if (dead) return made.close()
        decoded.current?.close()
        decoded.current = made
        setBitmap(made)
      },
      () => !dead && setFailed('This picture cannot be opened in the canvas.'),
    )
    return () => {
      dead = true
    }
  }, [file])
  useEffect(() => () => decoded.current?.close(), [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !bitmap) return
    const drawn = draft ? [...shown, draft] : shown
    const box = marquee && {
      x: Math.min(marquee[0][0], marquee[1][0]),
      y: Math.min(marquee[0][1], marquee[1][1]),
      w: Math.abs(marquee[1][0] - marquee[0][0]),
      h: Math.abs(marquee[1][1] - marquee[0][1]),
    }
    paint(canvas, bitmap, drawn, { picked, marquee: box || null, hover: tipHover })
  }, [bitmap, shown, draft, picked, marquee, tipHover])

  // Image pixels for a css pixel of the canvas as it is shown, and where a pointer is in the picture.
  const scale = (e: PointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    return box.width ? e.currentTarget.width / box.width : 1
  }
  const at = (e: PointerEvent<HTMLCanvasElement>): Point => {
    const el = e.currentTarget
    const box = el.getBoundingClientRect()
    return [((e.clientX - box.left) * el.width) / box.width, ((e.clientY - box.top) * el.height) / box.height]
  }

  const fresh = (kind: AnnotationKind, [x, y]: Point): Annotation => ({
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    color,
    width,
    ...(kind === 'rect' || kind === 'ellipse'
      ? { rect: { x, y, w: 0, h: 0 } }
      : {
          from: [x, y] as Point,
          ...(kind === 'pen' ? { points: [[x, y] as Point] } : {}),
        }),
    ...(kind === 'text' ? { text } : {}),
    ...(fill && (kind === 'rect' || kind === 'ellipse') ? { fill: true } : {}),
  })

  // The layout the pointer is measured with: css pixels turned into picture pixels by `k`.
  const layoutAt = (k: number): Layout => ({
    gap: HANDLE_GAP * k,
    handleReach: HANDLE_REACH * k,
    tipReach: TIP_REACH * k,
    picture: bitmap ?? { width: 0, height: 0 },
  })
  // The X beside the rotate tip of a selection's box, in picture pixels.
  const deleteXAt = (box: Box, k: number): Point =>
    deleteAt(handleAt(box, HANDLE_GAP * k, layoutAt(k).picture), X_OFFSET * k, layoutAt(k).picture)
  // Whether a point is near the rotate tip or the X beside it: the X shows then, and a press on it deletes.
  const nearTip = (box: Box | null, point: Point, k: number) =>
    box !== null &&
    (within(point, deleteXAt(box, k), X_REACH * k) ||
      within(point, handleAt(box, HANDLE_GAP * k, bitmap ?? { width: 0, height: 0 }), TIP_REACH * k))

  const startSelect = (e: PointerEvent<HTMLCanvasElement>, point: Point) => {
    const k = scale(e)
    const hit = markAt(items, point[0], point[1])
    const box = unionBounds(picked)
    // A touch sends no move before its press, so the press itself shows the X when it lands near the tip. The X
    // is tested only while it shows: a mark under its spot is picked by a tap that did not show it.
    const shown = tipHover
    setTipHover(nearTip(box, point, k))
    if (box) {
      // The X beside the rotate tip deletes the selection, as one step.
      if (shown && within(point, deleteXAt(box, k), X_REACH * k)) {
        deleteSelected()
        return
      }
      // A handle on the box's sides or corners resizes it, even where a mark lies under the edge.
      const handle = resizeHandleAt(box, point, HANDLE_REACH * k)
      if (handle) {
        gesture.current = {
          mode: 'resize',
          pointer: e.pointerId,
          start: point,
          ids: new Set(picked.map((a) => a.id)),
          base: items,
          centre: point,
          additive: false,
          grip: { box, part: handle },
          next: null,
        }
        return
      }
    }
    // Shift-click adds one mark to the selection or takes it away, with no drag. It comes before the rotate handle,
    // so a Shift-press on a selected mark in the handle's band removes it rather than turning the selection.
    if (hit && e.shiftKey) {
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(hit.id)) next.delete(hit.id)
        else next.add(hit.id)
        return next
      })
      return
    }
    // The rotate handle of the selection sits above its box, in a band that can hold a mark: a mark under the
    // pointer is picked first, and the handle takes a press that lands on no mark or on one of the selected
    // marks (a selected mark's reach can cover the handle).
    if (box && (!hit || picked.some((a) => a.id === hit.id))) {
      const handle = handleAt(box, HANDLE_GAP * k, bitmap ?? { width: 0, height: 0 })
      if (within(point, handle, TIP_REACH * k)) {
        gesture.current = {
          mode: 'turn',
          pointer: e.pointerId,
          start: point,
          ids: new Set(picked.map((a) => a.id)),
          base: items,
          centre: [box.x + box.w / 2, box.y + box.h / 2],
          additive: false,
          next: null,
        }
        return
      }
    }
    // A press on a mark, or on empty picture inside the selection's box, moves the picked marks; a mark outside
    // the picked group is picked alone first.
    if (hit || (box && insideBox(box, point))) {
      const inGroup = !hit || picked.some((a) => a.id === hit.id)
      const group = hit && !inGroup ? [hit] : picked
      if (hit && !inGroup) setSelected(new Set([hit.id]))
      gesture.current = {
        mode: 'move',
        pointer: e.pointerId,
        start: point,
        ids: new Set(group.map((a) => a.id)),
        base: items,
        centre: point,
        additive: false,
        pick: hit?.id,
        next: null,
      }
      return
    }
    gesture.current = {
      mode: 'marquee',
      pointer: e.pointerId,
      start: point,
      ids: new Set(),
      base: items,
      centre: point,
      additive: e.shiftKey,
      next: null,
    }
    setMarquee([point, point])
  }

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    // Every press is captured, so its release reaches the canvas wherever the pointer is let go.
    e.currentTarget.setPointerCapture(e.pointerId)
    held.current.add(e.pointerId)
    // A second pointer during a gesture or a drawing press (a second finger) is ignored: the first owns the picture.
    if (!bitmap || busy || gesture.current || origin.current) return
    const point = at(e)
    if (tool === 'select') return startSelect(e, point)
    if (tool === 'note') {
      const hit = markAt(items, point[0], point[1])
      setSelected(new Set(hit ? [hit.id] : []))
      return
    }
    if (tool === 'text' && !text.trim()) return
    originPointer.current = e.pointerId
    origin.current = point
    setDraft(fresh(tool, point))
  }

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const g = gesture.current
    if (g && e.pointerId !== g.pointer) return
    if (g) {
      const p = at(e)
      if (g.mode === 'marquee') {
        setMarquee([g.start, p])
        return
      }
      // A press that has not moved past the click reach is a pick on release: it changes nothing.
      if (isTinyDrag(g.start, p)) g.next = null
      else if (g.mode === 'move') {
        const dx = p[0] - g.start[0]
        const dy = p[1] - g.start[1]
        g.next = g.base.map((a) => (g.ids.has(a.id) ? translateMark(a, dx, dy) : a))
      } else if (g.mode === 'resize' && g.grip) {
        // The handle's edge follows the pointer from the box as it was when the gesture began.
        const f = resizeFactors(g.grip.box, g.grip.part, p)
        g.next = g.base.map((a) => (g.ids.has(a.id) ? scaleMark(a, f.anchor, f.sx, f.sy) : a))
      } else {
        const angle = turnBetween(g.centre, g.start, p)
        g.next = g.base.map((a) => (g.ids.has(a.id) ? rotateMark(a, g.centre, angle) : a))
      }
      setPreview(g.next)
      return
    }
    // With no gesture and the Select tool, the pointer's position sets the cursor and whether the X shows.
    if (tool === 'select') return hover(e, at(e))
    if (!draft || !origin.current || e.pointerId !== originPointer.current) return
    const [x, y] = at(e)
    const [x0, y0] = origin.current
    setDraft(
      draft.kind === 'pen'
        ? { ...draft, points: [...(draft.points ?? []), [x, y]] }
        : draft.kind === 'rect' || draft.kind === 'ellipse'
          ? {
              ...draft,
              rect: { x: Math.min(x0, x), y: Math.min(y0, y), w: Math.abs(x - x0), h: Math.abs(y - y0) },
            }
          : draft.kind === 'line' || draft.kind === 'arrow'
            ? { ...draft, to: [x, y] }
            : draft,
    )
  }

  const hover = (e: PointerEvent<HTMLCanvasElement>, point: Point) => {
    const box = unionBounds(picked)
    const k = scale(e)
    const onX = box !== null && within(point, deleteXAt(box, k), X_REACH * k)
    setTipHover(nearTip(box, point, k))
    // Set on the element, not through state: a move over the canvas does not re-render the dialog.
    e.currentTarget.style.cursor = onX ? 'grab' : cursorOf(partAt(box, items, point, layoutAt(k), selected))
  }

  const onPointerLeave = (e: PointerEvent<HTMLCanvasElement>) => {
    if (gesture.current) return
    e.currentTarget.style.cursor = ''
    // A touch leaves the picture as it lifts, after the press that showed the X: the X stays until the next press.
    if (e.pointerType !== 'touch') setTipHover(false)
  }

  // The drawing press ends on the release of the pointer that began it, whatever gesture another pointer has.
  const finishDraw = (pointer: number) => {
    if (!draft || pointer !== originPointer.current) return
    const box = draft.rect
    const line =
      draft.from && draft.to ? Math.hypot(draft.to[0] - draft.from[0], draft.to[1] - draft.from[1]) : 0
    const tiny = box
      ? box.w < 3 && box.h < 3
      : draft.kind === 'pen'
        ? (draft.points?.length ?? 0) < 2
        : (draft.kind === 'line' || draft.kind === 'arrow') && line < 3
    if (!tiny) {
      setHistory((h) => edit(h, [...h.present, draft]))
      setSelected(new Set([draft.id]))
    }
    setDraft(null)
    origin.current = null
    originPointer.current = null
  }

  const onPointerUp = (e: PointerEvent<HTMLCanvasElement>) => {
    held.current.delete(e.pointerId)
    const g = gesture.current
    if (g && e.pointerId !== g.pointer) {
      finishDraw(e.pointerId)
      return
    }
    if (g) {
      gesture.current = null
      if (g.mode === 'marquee') {
        setMarquee(null)
        const end = at(e)
        if (isTinyDrag(g.start, end)) {
          // A click on empty picture: it clears the selection, unless Shift was held.
          if (!g.additive) setSelected(new Set())
          return
        }
        const hits = marqueeIds(items, g.start, end)
        setSelected((prev) => (g.additive ? new Set([...prev, ...hits]) : new Set(hits)))
        return
      }
      setPreview(null)
      if (g.next && g.next.some((a, i) => a !== g.base[i])) {
        const next = g.next
        setHistory((h) => edit(h, next))
      } else if (g.pick) {
        setSelected(new Set([g.pick]))
      }
      return
    }
    finishDraw(e.pointerId)
  }

  // Changing tool drops the cursor the Select tool set on the canvas, and the X.
  const pickTool = (next: Tool) => {
    // A pointer press in progress keeps the tool it started with until it is released: a tap on a tool waits.
    if (origin.current || gesture.current) return
    setTool(next)
    setTipHover(false)
    if (canvasRef.current) canvasRef.current.style.cursor = ''
  }

  // The Fill checkbox shows the fill of a single selected box or ellipse, and otherwise the fill the next one gets.
  const fillShown = selectedItem && isFillable(selectedItem) ? Boolean(selectedItem.fill) : fill
  // Fill is set for the next box or ellipse drawn, and on the selected boxes and ellipses as one step.
  const chooseFill = (on: boolean) => {
    setFill(on)
    if (busy || gesture.current) return
    const ids = new Set(picked.filter((a) => isFillable(a) && Boolean(a.fill) !== on).map((a) => a.id))
    if (!ids.size) return
    setHistory((h) =>
      edit(
        h,
        h.present.map((a) => (ids.has(a.id) ? fillMark(a, on) : a)),
      ),
    )
  }

  const setNote = (note: string) => {
    // A pointer gesture in progress owns the picture until it is released: the note waits for it.
    if (!selectedItem || gesture.current) return
    const id = selectedItem.id
    // A note is written into the picture as it stands, without a step of its own.
    setHistory((h) =>
      replace(
        h,
        h.present.map((i) => (i.id === id ? { ...i, note: note.slice(0, ANNOTATION_TEXT_MAX) } : i)),
      ),
    )
  }

  // Deletes the selection: the Delete key and the X beside the rotate tip.
  const deleteSelected = () => {
    if (!picked.length || busy || gesture.current) return
    const gone = new Set(picked.map((a) => a.id))
    setHistory((h) =>
      edit(
        h,
        h.present.filter((a) => !gone.has(a.id)),
      ),
    )
    setSelected(new Set())
  }

  const travel = (step: 'undo' | 'redo') => {
    if (busy || gesture.current) return
    setHistory((h) => {
      const moved = step === 'undo' ? undo(h) : redo(h)
      return moved === h ? h : { ...moved, present: carryNotes(moved.present, h.present) }
    })
  }

  // The keys the canvas takes, read at the window (see the effect below): Escape clears a selection
  // before the dialog would close, and the other keys act unless a field has the focus, which keeps
  // its own typing and undo.
  const onKeyDown = (e: globalThis.KeyboardEvent) => {
    // A key pressed during a pointer gesture waits: the gesture commits its own step on release. A drawing
    // tool's press is a gesture too (its origin is set until release). Escape is still taken here, so the
    // dialog does not close on the picture while a button is held on the canvas, whatever the tool.
    if (busy || gesture.current || origin.current || held.current.size) {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
      }
      return
    }
    if (e.key === 'Escape') {
      if (!picked.length) return
      e.preventDefault()
      e.stopPropagation()
      setSelected(new Set())
      return
    }
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
    const mod = e.ctrlKey || e.metaKey
    const key = e.key.toLowerCase()
    if (mod && key === 'z') {
      e.preventDefault()
      travel(e.shiftKey ? 'redo' : 'undo')
    } else if (mod && key === 'y') {
      e.preventDefault()
      travel('redo')
    } else if (mod && key === 'a') {
      e.preventDefault()
      setSelected(new Set(items.map((a) => a.id)))
    } else if (!mod && (e.key === 'Delete' || e.key === 'Backspace') && picked.length) {
      e.preventDefault()
      deleteSelected()
    }
  }

  // Read at the window, in the capture phase: the keys reach the canvas whatever has the focus (a
  // button that becomes disabled drops it), and Escape is taken before the dialog closes on it.
  const keys = useRef(onKeyDown)
  keys.current = onKeyDown
  useEffect(() => {
    if (!file) return
    const listener = (e: globalThis.KeyboardEvent) => keys.current(e)
    window.addEventListener('keydown', listener, true)
    return () => window.removeEventListener('keydown', listener, true)
  }, [file])

  const attach = async () => {
    if (!bitmap || !file || busy) return
    // The picture this encode is for, and its size: the flattened image and the document go with it,
    // whichever picture the canvas is showing by the time the encode has finished.
    const shownFile = file
    const width = bitmap.width
    const height = bitmap.height
    // A pointer gesture still in progress is dropped, not committed: the attached picture is the committed
    // state, and the canvas ignores its pointers while the picture is being attached.
    gesture.current = null
    setPreview(null)
    setMarquee(null)
    setBusy(true)
    try {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('this browser cannot draw the picture')
      // No overlay: the selection is a tool on screen, never part of the picture.
      paint(canvas, bitmap, items, null)
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (png) => (png ? resolve(png) : reject(new Error('the picture could not be saved'))),
          'image/png',
        ),
      )
      // The attachment is the annotated render, under a name that says it is a PNG.
      const name = `${shownFile.name.replace(/\.[^./\\]+$/, '')}.png`
      onAttach(
        {
          file: new File([blob], name, { type: 'image/png', lastModified: Date.now() }),
          annotations: { version: 1, width, height, items },
        },
        shownFile,
      )
    } catch (err) {
      toast.error(errorMessage(err, 'the picture could not be saved'))
    } finally {
      setBusy(false)
    }
  }

  const notes = shown.flatMap((item) => {
    const note = item.note?.trim()
    return note ? [{ id: item.id, note }] : []
  })

  const cursor =
    tool === 'select'
      ? 'cursor-default'
      : tool === 'note'
        ? 'cursor-pointer'
        : tool === 'text'
          ? 'cursor-text'
          : 'cursor-crosshair'

  // Nothing to annotate: the dialog leaves the page rather than sitting closed in it with a stale
  // picture, so a form's next step never finds it.
  if (!file) return null

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        // While the encode runs the picture is on its way out: a close request would leave it behind
        // and take whatever is queued after it with it, so Escape, the X and the backdrop wait.
        if (!next && !busy) onCancel()
      }}
    >
      <DialogContent className="sm:max-w-4xl" finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>Annotate image</DialogTitle>
          <DialogDescription>
            {file.name}: draw on it and write what each mark means. The picture is attached as it looks here,
            and the notes go with it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div role="toolbar" aria-label="Drawing tools" className="flex flex-wrap items-center gap-1">
            {TOOLS.map(({ tool: name, label, hint, Icon }) => (
              <Tip key={name} content={hint}>
                <Button
                  type="button"
                  size="sm"
                  variant={tool === name ? 'secondary' : 'ghost'}
                  aria-pressed={tool === name}
                  onClick={() => pickTool(name)}
                  disabled={busy}
                >
                  <Icon data-icon="inline-start" /> {label}
                </Button>
              </Tip>
            ))}
            <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
            <Tip content="Colour">
              <input
                type="color"
                aria-label="Colour"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                disabled={busy}
                className="h-7 w-8 cursor-pointer rounded-md border bg-background p-0.5"
              />
            </Tip>
            <Tip content="Stroke width">
              <input
                type="range"
                aria-label="Stroke width"
                min={1}
                max={20}
                step={1}
                value={width}
                onChange={(e) => setWidth(Number(e.target.value))}
                disabled={busy}
                className="w-24 accent-primary"
              />
            </Tip>
            <label className="flex items-center gap-1.5 text-xs">
              <Checkbox checked={fillShown} onCheckedChange={chooseFill} disabled={busy} />
              Fill
            </label>
            {tool === 'text' && (
              <Input
                aria-label="Text"
                value={text}
                maxLength={ANNOTATION_TEXT_MAX}
                onChange={(e) => setText(e.target.value.slice(0, ANNOTATION_TEXT_MAX))}
                disabled={busy}
                placeholder="Text to place"
                className="h-7 w-48"
              />
            )}
            <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => travel('undo')}
              disabled={!canUndo}
            >
              <Undo2 data-icon="inline-start" /> Undo
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => travel('redo')}
              disabled={!canRedo}
            >
              <Redo2 data-icon="inline-start" /> Redo
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                if (gesture.current) return
                setHistory((h) => edit(h, []))
                setSelected(new Set())
              }}
              disabled={!items.length || busy}
            >
              <TrashIcon data-icon="inline-start" /> Clear
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="annotation-note" className="text-xs">
              Note
            </Label>
            <Input
              id="annotation-note"
              aria-label="Note"
              value={selectedItem?.note ?? ''}
              maxLength={ANNOTATION_TEXT_MAX}
              onChange={(e) => setNote(e.target.value)}
              disabled={!selectedItem || busy}
              placeholder={
                selectedItem ? 'What does this mark mean?' : 'Draw a mark, or pick Note and click one'
              }
              className="h-8"
            />
          </div>
          <div className="flex max-h-[60vh] items-center justify-center overflow-auto rounded-md border bg-muted/40 p-2">
            {bitmap ? (
              <canvas
                ref={canvasRef}
                width={bitmap.width}
                height={bitmap.height}
                role="img"
                aria-label="Picture to annotate"
                className={cn('max-h-[calc(60vh-1rem)] w-auto max-w-full touch-none border bg-white', cursor)}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onPointerLeave={onPointerLeave}
              />
            ) : (
              <p className="p-6 text-sm text-muted-foreground">{failed || 'Opening the picture…'}</p>
            )}
          </div>
          {notes.length > 0 && (
            // A long note (the field takes thousands of characters) scrolls here rather than growing
            // the dialog past the window, which would put the buttons below the edge.
            <div
              aria-label="Notes"
              className="max-h-24 overflow-y-auto text-xs wrap-anywhere text-muted-foreground"
            >
              <span className="font-medium text-foreground">Notes</span>
              <ol className="mt-1 space-y-0.5">
                {notes.map((item, i) => (
                  <li key={item.id}>
                    <span className="tabular-nums">{i + 1}.</span> {item.note}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
        <DialogFooter>
          {busy && (
            // Said outright, not only through greyed controls: what is drawn here goes into the
            // picture being encoded now, so edits made meanwhile would be silently left out.
            <p role="status" className="text-xs text-muted-foreground sm:mr-auto">
              The marks are locked until the picture is attached.
            </p>
          )}
          <Button type="button" variant="outline" onClick={onAttachOriginal} disabled={busy}>
            Attach original
          </Button>
          <Button type="button" onClick={attach} disabled={!bitmap || busy}>
            {busy ? 'Attaching…' : 'Attach'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The canvas step every attach point shares. A picture waits for `AnnotateImage` and joins the form
 * through `accept` once it is attached (or as it came, with Attach original); every other file joins
 * it as soon as the files picked before it have, so a batch keeps its pick order whichever of its
 * members opens the canvas. `annotationsOf` finds the document drawn on a pending file.
 */
export function useAnnotations(accept: (files: File[]) => void) {
  // The files waiting their turn, in pick order: `queue[0]` is the picture the canvas is open on,
  // when there is one, and the files picked after it wait behind it.
  const [queue, setQueue] = useState<File[]>([])
  // The same list, read and written between renders: two batches arriving together must not both
  // start from the list React has yet to update.
  const pending = useRef<File[]>([])
  // What had the focus when a picture came in: the canvas gives it back when it closes, so a form
  // driven from the keyboard carries on where it was.
  const finalFocus = useRef<HTMLElement | null>(null)
  const latest = useRef(accept)
  latest.current = accept
  const send = useCallback((files: File[]) => {
    if (files.length) latest.current(files)
  }, [])
  // Hands `accept` the files at the head that need no canvas, up to the next picture: a file with
  // nothing picked before it still waiting goes in at once.
  const drain = useCallback(() => {
    const ready: File[] = []
    while (pending.current.length && !annotatable(pending.current[0]!)) ready.push(pending.current.shift()!)
    send(ready)
    setQueue([...pending.current])
  }, [send])
  // Takes one picture out of the queue, by its own identity: a step that arrives for a picture the
  // canvas has already left finds nothing to take, so it can never stand in for the one behind it.
  const drop = (file: File) => {
    const at = pending.current.indexOf(file)
    if (at < 0) return false
    pending.current.splice(at, 1)
    return true
  }
  const next = (shown: File) => {
    if (!drop(shown)) return
    drain()
    // Nothing left to annotate: the focus goes back to whatever opened the canvas (the attach
    // button, the editor a picture was pasted into), so a form driven from the keyboard carries on.
    if (!pending.current.length) {
      const el = finalFocus.current
      if (el?.isConnected) requestAnimationFrame(() => el.focus())
    }
  }

  return {
    add: useCallback(
      (files: File[]) => {
        if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement)
          finalFocus.current = document.activeElement
        pending.current = [...pending.current, ...files]
        drain()
      },
      [drain],
    ),
    /** Where the focus goes when the canvas closes. */
    finalFocus,
    /** The picture the canvas is open on, if any. */
    current: queue[0] ?? null,
    /** The flattened picture and the notes drawn on it, for the picture the canvas was showing. */
    attach: (annotated: AnnotatedImage, shown: File) => {
      // A cancelled picture (or one the canvas left some other way) keeps the queue as it is, and the
      // picture behind it still gets its turn.
      if (!pending.current.includes(shown)) return
      keepAnnotations(annotated.file, annotated.annotations)
      send([annotated.file])
      next(shown)
    },
    /** The picture as it was picked, with nothing on it. */
    attachOriginal: () => {
      const picked = pending.current[0]
      if (!picked) return
      send([picked])
      next(picked)
    },
    /** The picture left out of the form. */
    cancel: () => {
      const shown = pending.current[0]
      if (shown) next(shown)
    },
  }
}
