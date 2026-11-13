import { Circle, MessageSquarePlus, MoveUpRight, Pencil, Square, Type, Undo2 } from 'lucide-react'
import { type PointerEvent, type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { TrashIcon } from '#/components/TrashIcon'
import { Button } from '#/components/ui/button'
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
import type { Annotation, AnnotationDoc, AnnotationKind } from '#/lib/annotations'
import { ANNOTATION_TEXT_MAX, annotatable, keepAnnotations } from '#/lib/annotations'
import { errorMessage } from '#/lib/api'
import { cn } from '#/lib/utils'

/**
 * The canvas an image passes through before it is attached: draw on the picture with a pencil, a
 * box, an arrow, an ellipse or text, write what each mark means beside it, and attach the flattened
 * picture, which carries the drawings and, as data next to it, the notes. Plain Canvas 2D: the repo
 * has no drawing library.
 */
export interface AnnotatedImage {
  /** The picture as it was drawn on, ready to attach. */
  file: File
  /** The shapes and their notes, to store beside it. */
  annotations: AnnotationDoc
}

type Tool = AnnotationKind | 'note'

const TOOLS: { tool: Tool; label: string; hint: string; Icon: typeof Pencil }[] = [
  { tool: 'pen', label: 'Pencil', hint: 'Draw freehand', Icon: Pencil },
  { tool: 'rect', label: 'Box', hint: 'Draw a box around something', Icon: Square },
  { tool: 'arrow', label: 'Arrow', hint: 'Point at something', Icon: MoveUpRight },
  { tool: 'ellipse', label: 'Ellipse', hint: 'Circle something', Icon: Circle },
  { tool: 'text', label: 'Text', hint: 'Write on the picture', Icon: Type },
  { tool: 'note', label: 'Note', hint: 'Click a mark to write its note', Icon: MessageSquarePlus },
]

const DEFAULT_COLOR = '#e11d48'
const DEFAULT_WIDTH = 4

/** Text is drawn at four times the stroke width, so one control sizes everything drawn. */
const textSize = (a: Annotation) => Math.max(12, a.width * 4)

function bounds(a: Annotation) {
  if (a.rect) return a.rect
  if (a.kind === 'text' && a.from) {
    const size = textSize(a)
    return { x: a.from[0], y: a.from[1], w: (a.text?.length ?? 1) * size * 0.6, h: size * 1.2 }
  }
  const points = a.points ?? [a.from, a.to].filter((p): p is [number, number] => Boolean(p))
  if (!points.length) return { x: 0, y: 0, w: 0, h: 0 }
  const xs = points.map(([x]) => x)
  const ys = points.map(([, y]) => y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

function distanceToSegment(x: number, y: number, [x1, y1]: [number, number], [x2, y2]: [number, number]) {
  const dx = x2 - x1
  const dy = y2 - y1
  const length = dx * dx + dy * dy
  const t = length ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / length)) : 0
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))
}

/** The mark under a point, the newest first, so a click with the Note tool picks the one on top. */
function markAt(items: Annotation[], x: number, y: number) {
  for (let i = items.length - 1; i >= 0; i--) {
    const a = items[i]!
    const reach = a.width + 6
    if (a.kind === 'pen' && a.points?.some(([px, py]) => Math.hypot(px - x, py - y) <= reach)) return a
    if ((a.kind === 'line' || a.kind === 'arrow') && a.from && a.to) {
      if (distanceToSegment(x, y, a.from, a.to) <= reach) return a
    }
    const b = bounds(a)
    const inside = x >= b.x - reach && x <= b.x + b.w + reach && y >= b.y - reach && y <= b.y + b.h + reach
    if (inside && a.kind !== 'pen') return a
  }
  return undefined
}

function drawMark(ctx: CanvasRenderingContext2D, a: Annotation) {
  ctx.save()
  ctx.strokeStyle = a.color
  ctx.fillStyle = a.color
  ctx.lineWidth = a.width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
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
    ctx.stroke()
  } else if (a.kind === 'text' && a.from) {
    const size = textSize(a)
    ctx.font = `600 ${size}px ui-sans-serif, system-ui, sans-serif`
    ctx.textBaseline = 'top'
    ctx.fillText(a.text ?? '', a.from[0], a.from[1])
  }
  ctx.restore()
}

/** The picture, the marks, the numbered notes and the mark being drawn, at the picture's own size. */
function paint(canvas: HTMLCanvasElement, bitmap: ImageBitmap, items: Annotation[], selected: string | null) {
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
    const box = bounds(item)
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
  const picked = items.find((i) => i.id === selected)
  if (picked) {
    const box = bounds(picked)
    ctx.save()
    ctx.strokeStyle = '#0ea5e9'
    ctx.lineWidth = Math.max(2, picked.width / 2)
    ctx.setLineDash([8, 5])
    ctx.strokeRect(box.x - 6, box.y - 6, box.w + 12, box.h + 12)
    ctx.restore()
  }
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
  const [items, setItems] = useState<Annotation[]>([])
  const [tool, setTool] = useState<Tool>('pen')
  const [color, setColor] = useState(DEFAULT_COLOR)
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const [text, setText] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState<Annotation | null>(null)
  const [busy, setBusy] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const origin = useRef<[number, number] | null>(null)

  // The picture is decoded once, at its natural size: the marks and the flattened render are in its pixels.
  const decoded = useRef<ImageBitmap | null>(null)
  useEffect(() => {
    if (!file) return
    let dead = false
    setBitmap(null)
    setFailed('')
    setItems([])
    setSelected(null)
    setDraft(null)
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
    paint(canvas, bitmap, draft ? [...items, draft] : items, selected)
  }, [bitmap, items, draft, selected])

  const at = (e: PointerEvent<HTMLCanvasElement>): [number, number] => {
    const el = e.currentTarget
    const box = el.getBoundingClientRect()
    return [((e.clientX - box.left) * el.width) / box.width, ((e.clientY - box.top) * el.height) / box.height]
  }

  const fresh = (kind: AnnotationKind, [x, y]: [number, number]): Annotation => ({
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    color,
    width,
    ...(kind === 'rect' || kind === 'ellipse'
      ? { rect: { x, y, w: 0, h: 0 } }
      : {
          from: [x, y] as [number, number],
          ...(kind === 'pen' ? { points: [[x, y] as [number, number]] } : {}),
        }),
    ...(kind === 'text' ? { text } : {}),
  })

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!bitmap || busy) return
    const point = at(e)
    if (tool === 'note') {
      setSelected(markAt(items, point[0], point[1])?.id ?? null)
      return
    }
    if (tool === 'text' && !text.trim()) return
    e.currentTarget.setPointerCapture(e.pointerId)
    origin.current = point
    setDraft(fresh(tool, point))
  }

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!draft || !origin.current) return
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

  const onPointerUp = () => {
    if (!draft) return
    const box = draft.rect
    const line =
      draft.from && draft.to ? Math.hypot(draft.to[0] - draft.from[0], draft.to[1] - draft.from[1]) : 0
    const tiny = box
      ? box.w < 3 && box.h < 3
      : draft.kind === 'pen'
        ? (draft.points?.length ?? 0) < 2
        : (draft.kind === 'line' || draft.kind === 'arrow') && line < 3
    if (!tiny) {
      setItems((prev) => [...prev, draft])
      setSelected(draft.id)
    }
    setDraft(null)
    origin.current = null
  }

  const selectedItem = items.find((i) => i.id === selected)

  const setNote = (note: string) =>
    setItems((prev) =>
      prev.map((i) => (i.id === selected ? { ...i, note: note.slice(0, ANNOTATION_TEXT_MAX) } : i)),
    )

  const remove = (id: string) => {
    setItems((prev) => prev.filter((i) => i.id !== id))
    if (selected === id) setSelected(null)
  }

  const undo = () => {
    const last = items[items.length - 1]
    if (last) remove(last.id)
  }

  const attach = async () => {
    if (!bitmap || !file || busy) return
    // The picture this encode is for, and its size: the flattened image and the document go with it,
    // whichever picture the canvas is showing by the time the encode has finished.
    const shown = file
    const width = bitmap.width
    const height = bitmap.height
    setBusy(true)
    try {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('this browser cannot draw the picture')
      paint(canvas, bitmap, items, null)
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (png) => (png ? resolve(png) : reject(new Error('the picture could not be saved'))),
          'image/png',
        ),
      )
      // The attachment is the annotated render, under a name that says it is a PNG.
      const name = `${shown.name.replace(/\.[^./\\]+$/, '')}.png`
      onAttach(
        {
          file: new File([blob], name, { type: 'image/png', lastModified: Date.now() }),
          annotations: { version: 1, width, height, items },
        },
        shown,
      )
    } catch (err) {
      toast.error(errorMessage(err, 'the picture could not be saved'))
    } finally {
      setBusy(false)
    }
  }

  const notes = items.flatMap((item) => {
    const note = item.note?.trim()
    return note ? [{ id: item.id, note }] : []
  })

  const cursor = tool === 'note' ? 'cursor-pointer' : tool === 'text' ? 'cursor-text' : 'cursor-crosshair'

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
                  onClick={() => setTool(name)}
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
            <Button type="button" size="sm" variant="ghost" onClick={undo} disabled={!items.length || busy}>
              <Undo2 data-icon="inline-start" /> Undo
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setItems([])
                setSelected(null)
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
