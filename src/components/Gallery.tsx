import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import {
  ChevronLeftIcon,
  MinusIcon,
  PlusIcon,
  ChevronRightIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileIcon,
  XIcon,
} from 'lucide-react'
import { type PointerEvent, type RefObject, useEffect, useRef, useState } from 'react'

import { Tip } from '#/components/ui/tooltip'

/**
 * Anything on the page marked with `data-gallery-src` opens in a full-screen viewer on click, and the
 * arrows step through every such item on the page in reading order. Items with a
 * `data-gallery-group` only step through their own group (files not posted yet stay apart from the
 * posted ones). Modified clicks (ctrl, middle) keep their normal browser behaviour.
 */
export interface GalleryItem {
  src: string
  name: string
  mime: string
}

/** Props that make an element open the gallery. */
export function galleryItem(item: GalleryItem, group?: string) {
  return {
    'data-gallery-src': item.src,
    'data-gallery-name': item.name,
    'data-gallery-mime': item.mime,
    'data-gallery-group': group,
  }
}

// Text is fetched and shown in the gallery's own panel: in an iframe, a dark-mode browser draws plain
// text light on a transparent page, which vanishes against a white frame.
const TEXT_MIMES = ['text/', 'application/json', 'application/xml', 'application/x-yaml', 'application/yaml']
// Browsers give some text files no type at all (.md, .log), so the name decides for those.
const TEXT_NAMES =
  /\.(txt|md|markdown|log|json|jsonl|csv|tsv|ya?ml|xml|toml|ini|env|diff|patch|sh|sql|[cm]?[jt]sx?|py|go|rs|java|css|html?)$/i

function kindOf(item: GalleryItem): 'image' | 'video' | 'pdf' | 'text' | 'file' {
  const { mime } = item
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime === 'application/pdf') return 'pdf'
  if (TEXT_MIMES.some((p) => mime.startsWith(p)) || TEXT_NAMES.test(item.name)) return 'text'
  return 'file'
}

function collect(group: string): GalleryItem[] {
  const seen = new Set<string>()
  const items: GalleryItem[] = []
  for (const el of document.querySelectorAll<HTMLElement>('[data-gallery-src]')) {
    if ((el.dataset.galleryGroup ?? '') !== group) continue
    const src = el.dataset.gallerySrc!
    if (seen.has(src)) continue
    seen.add(src)
    items.push({ src, name: el.dataset.galleryName || src, mime: el.dataset.galleryMime || 'image/*' })
  }
  return items
}

export function Gallery() {
  const [items, setItems] = useState<GalleryItem[]>([])
  const [index, setIndex] = useState<number | null>(null)
  const swipeFrom = useRef<number | null>(null)

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-gallery-src]')
      if (!el) return
      e.preventDefault()
      const all = collect(el.dataset.galleryGroup ?? '')
      setItems(all)
      setIndex(
        Math.max(
          0,
          all.findIndex((i) => i.src === el.dataset.gallerySrc),
        ),
      )
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [])

  const open = index !== null
  const many = items.length > 1
  const step = (by: number) => setIndex((i) => (i === null ? i : (i + by + items.length) % items.length))

  // Set by the image viewer while it is shown: handles the zoom keys, true when it used the key.
  const zoomKeys = useRef<ZoomKeys | null>(null)

  const item = open ? items[index] : undefined

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && setIndex(null)}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/90 duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup
          // Keys are handled here rather than on the document: the dialog keeps focus inside, so the
          // popup always sees them first. Focusable itself, so clicking the image keeps focus inside.
          tabIndex={-1}
          onKeyDown={(e) => {
            // The video's own seek keys win while it has focus.
            if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest('video')) return
            if (e.key === 'ArrowLeft' && many) step(-1)
            else if (e.key === 'ArrowRight' && many) step(1)
            else if (!zoomKeys.current?.(e.key)) return
            e.preventDefault()
          }}
          className="fixed inset-0 z-50 flex flex-col text-white outline-none"
        >
          {item && (
            <>
              <header className="flex items-center gap-3 px-4 py-3 text-sm">
                <DialogPrimitive.Title className="min-w-0 truncate font-medium">
                  {item.name}
                </DialogPrimitive.Title>
                {many && (
                  <span className="shrink-0 text-white/60 tabular-nums">
                    {index! + 1} / {items.length}
                  </span>
                )}
                <div className="ml-auto flex shrink-0 items-center gap-1">
                  <Tip content="Open in new tab">
                    <a
                      href={item.src}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="Open in new tab"
                      className={chrome}
                    >
                      <ExternalLinkIcon className="size-4" />
                    </a>
                  </Tip>
                  <Tip content="Download">
                    <a href={item.src} download={item.name} aria-label="Download" className={chrome}>
                      <DownloadIcon className="size-4" />
                    </a>
                  </Tip>
                  <Tip content="Close (Esc)">
                    <DialogPrimitive.Close aria-label="Close (Esc)" className={chrome}>
                      <XIcon className="size-5" />
                    </DialogPrimitive.Close>
                  </Tip>
                </div>
              </header>
              <div
                className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-4 pb-4 sm:px-16"
                onClick={(e) => e.target === e.currentTarget && setIndex(null)}
                onPointerDown={(e) => {
                  if (e.pointerType === 'touch') swipeFrom.current = e.clientX
                }}
                onPointerUp={(e) => {
                  const from = swipeFrom.current
                  swipeFrom.current = null
                  if (from === null || !many) return
                  const dx = e.clientX - from
                  if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1)
                }}
              >
                <Viewer key={item.src} item={item} zoomKeys={zoomKeys} />
                {many && (
                  <>
                    <button
                      type="button"
                      aria-label="Previous"
                      onClick={() => step(-1)}
                      className={`${arrow} left-2 sm:left-4`}
                    >
                      <ChevronLeftIcon className="size-6" />
                    </button>
                    <button
                      type="button"
                      aria-label="Next"
                      onClick={() => step(1)}
                      className={`${arrow} right-2 sm:right-4`}
                    >
                      <ChevronRightIcon className="size-6" />
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

const chrome =
  'inline-flex size-8 items-center justify-center rounded-md text-white/80 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/50'

const arrow =
  'absolute top-1/2 inline-flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white/90 ring-1 ring-white/15 outline-none backdrop-blur hover:bg-black/70 hover:text-white focus-visible:ring-2 focus-visible:ring-white/60'

function Viewer({ item, zoomKeys }: { item: GalleryItem; zoomKeys: RefObject<ZoomKeys | null> }) {
  const kind = kindOf(item)
  if (kind === 'image') return <ZoomableImage src={item.src} name={item.name} zoomKeys={zoomKeys} />
  if (kind === 'video') return <video src={item.src} controls autoPlay className="max-h-full max-w-full" />
  if (kind === 'text') return <TextViewer item={item} />
  if (kind === 'pdf')
    return <iframe src={item.src} title={item.name} className="h-full w-full max-w-5xl rounded-md bg-white" />
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg bg-white/5 px-10 py-8 text-center ring-1 ring-white/10">
      <FileIcon className="size-10 text-white/60" />
      <div className="font-medium">{item.name}</div>
      <div className="text-sm text-white/60">No preview for this file type.</div>
      <a href={item.src} download={item.name} className="text-sm underline underline-offset-4">
        Download
      </a>
    </div>
  )
}

type ZoomKeys = (key: string) => boolean

const MAX_ZOOM = 8
const STEP = 1.5

interface View {
  s: number
  x: number
  y: number
}

/**
 * An image that zooms with the wheel, a pinch, a double click, the toolbar or + - 0, toward the
 * pointer, and pans by dragging once zoomed. It never zooms out below its fitted size, and the pan
 * stops at the image's edges.
 */
function ZoomableImage({
  src,
  name,
  zoomKeys,
}: {
  src: string
  name: string
  zoomKeys: RefObject<ZoomKeys | null>
}) {
  const img = useRef<HTMLImageElement>(null)
  const [view, setView] = useState<View>({ s: 1, x: 0, y: 0 })
  const [smooth, setSmooth] = useState(false)
  const [dragging, setDragging] = useState(false)
  const current = useRef(view)
  current.current = view
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  // Set by a pinch or a zoomed drag, so letting go does not count as a swipe to the next item.
  const gesture = useRef(false)

  function apply(next: View, animate: boolean) {
    const el = img.current
    if (!el) return
    const s = Math.min(MAX_ZOOM, Math.max(1, next.s))
    // Scaled around its centre, the image overhangs its box by (s - 1) / 2 on each side.
    const mx = ((s - 1) * el.offsetWidth) / 2
    const my = ((s - 1) * el.offsetHeight) / 2
    const v = {
      s,
      x: Math.min(mx, Math.max(-mx, next.x)),
      y: Math.min(my, Math.max(-my, next.y)),
    }
    current.current = v
    setSmooth(animate)
    setView(v)
  }

  /** Zoom to `s` keeping the screen point `at` (default: the image's visible centre) in place. */
  function zoomTo(s: number, at: { x: number; y: number } | null, animate: boolean) {
    const el = img.current
    if (!el) return
    const v = current.current
    // The untransformed centre, from the layout: the rendered box is mid-animation after a smooth zoom.
    const box = (el.offsetParent ?? document.body).getBoundingClientRect()
    const cx = box.left + el.offsetLeft + el.offsetWidth / 2
    const cy = box.top + el.offsetTop + el.offsetHeight / 2
    const px = (at?.x ?? cx + v.x) - cx
    const py = (at?.y ?? cy + v.y) - cy
    const k = Math.min(MAX_ZOOM, Math.max(1, s)) / v.s
    apply({ s, x: px - k * (px - v.x), y: py - k * (py - v.y) }, animate)
  }

  // React's wheel listener is passive, so it cannot stop the page from scrolling.
  useEffect(() => {
    const el = img.current
    if (!el) return
    function onWheel(e: WheelEvent) {
      e.preventDefault()
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
      zoomTo(current.current.s * Math.exp(-dy * 0.002), { x: e.clientX, y: e.clientY }, false)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  useEffect(() => {
    zoomKeys.current = (key) => {
      if (key === '+' || key === '=') zoomTo(current.current.s * STEP, null, true)
      else if (key === '-' || key === '_') zoomTo(current.current.s / STEP, null, true)
      else if (key === '0') apply({ s: 1, x: 0, y: 0 }, true)
      else return false
      return true
    }
    return () => {
      zoomKeys.current = null
    }
  })

  function onPointerDown(e: PointerEvent) {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size > 1 || current.current.s > 1) {
      gesture.current = true
      e.stopPropagation()
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(current.current.s > 1)
  }

  function onPointerMove(e: PointerEvent) {
    const last = pointers.current.get(e.pointerId)
    if (!last) return
    const others = [...pointers.current].filter(([id]) => id !== e.pointerId).map(([, p]) => p)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const other = others[0]
    if (other) {
      // Pinch: scale by the change in finger distance around their midpoint, and follow the midpoint.
      const before = Math.hypot(last.x - other.x, last.y - other.y)
      const after = Math.hypot(e.clientX - other.x, e.clientY - other.y)
      if (before > 0) {
        zoomTo(
          current.current.s * (after / before),
          {
            x: (e.clientX + other.x) / 2,
            y: (e.clientY + other.y) / 2,
          },
          false,
        )
      }
      const v = current.current
      apply({ ...v, x: v.x + (e.clientX - last.x) / 2, y: v.y + (e.clientY - last.y) / 2 }, false)
    } else if (current.current.s > 1) {
      const v = current.current
      apply({ ...v, x: v.x + e.clientX - last.x, y: v.y + e.clientY - last.y }, false)
    }
  }

  function onPointerUp(e: PointerEvent) {
    pointers.current.delete(e.pointerId)
    if (gesture.current) e.stopPropagation()
    if (pointers.current.size === 0) {
      gesture.current = false
      setDragging(false)
    }
  }

  const zoomed = view.s > 1
  return (
    <>
      <img
        ref={img}
        src={src}
        alt={name}
        draggable={false}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={(e) =>
          zoomed
            ? apply({ s: 1, x: 0, y: 0 }, true)
            : zoomTo(STEP * STEP, { x: e.clientX, y: e.clientY }, true)
        }
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }}
        className={`max-h-full max-w-full touch-none object-contain select-none ${
          smooth ? 'transition-transform duration-200 ease-out' : ''
        } ${dragging ? 'cursor-grabbing' : zoomed ? 'cursor-grab' : 'cursor-zoom-in'}`}
      />
      <div className="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-full bg-black/60 p-1 text-sm ring-1 ring-white/15 backdrop-blur">
        {/* Zoom out and in are on wrappers: at the end of the range they are disabled, and say so on hover. */}
        <Tip content="Zoom out (-)">
          <span className="inline-flex">
            <button
              type="button"
              aria-label="Zoom out (-)"
              disabled={!zoomed}
              onClick={() => zoomTo(view.s / STEP, null, true)}
              className={`${chrome} rounded-full disabled:pointer-events-none disabled:opacity-40`}
            >
              <MinusIcon className="size-4" />
            </button>
          </span>
        </Tip>
        <Tip content="Fit (0)">
          <button
            type="button"
            onClick={() => apply({ s: 1, x: 0, y: 0 }, true)}
            className="min-w-14 rounded-full px-2 py-1 text-white/80 tabular-nums outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/50"
          >
            {Math.round(view.s * 100)}%
          </button>
        </Tip>
        <Tip content="Zoom in (+)">
          <span className="inline-flex">
            <button
              type="button"
              aria-label="Zoom in (+)"
              disabled={view.s >= MAX_ZOOM}
              onClick={() => zoomTo(view.s * STEP, null, true)}
              className={`${chrome} rounded-full disabled:pointer-events-none disabled:opacity-40`}
            >
              <PlusIcon className="size-4" />
            </button>
          </span>
        </Tip>
      </div>
    </>
  )
}

const TEXT_LIMIT = 1_000_000 // characters; past that the panel only shows the start

function TextViewer({ item }: { item: GalleryItem }) {
  const [text, setText] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const ctrl = new AbortController()
    fetch(item.src, { signal: ctrl.signal })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status))
        return r.text()
      })
      .then(setText)
      .catch(() => !ctrl.signal.aborted && setFailed(true))
    return () => ctrl.abort()
  }, [item.src])

  if (failed || text === null)
    return <div className="text-sm text-white/60">{failed ? 'Could not load this file.' : 'Loading…'}</div>
  const cut = text.length > TEXT_LIMIT
  return (
    <pre className="h-full w-full max-w-5xl overflow-auto rounded-md bg-neutral-900 p-4 font-mono text-[13px] leading-relaxed break-words whitespace-pre-wrap text-neutral-100 ring-1 ring-white/10 select-text">
      {cut ? text.slice(0, TEXT_LIMIT) : text || '(empty file)'}
      {cut && (
        <span className="mt-4 block text-white/50">
          Showing the first {TEXT_LIMIT.toLocaleString()} characters. Download the file for the rest.
        </span>
      )}
    </pre>
  )
}
