import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileIcon,
  XIcon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

/**
 * Anything on the page marked with `data-gallery-src` opens in a full-screen viewer on click, and the
 * arrows step through every such item on the page in reading order. Modified clicks (ctrl, middle)
 * keep their normal browser behaviour.
 */
export interface GalleryItem {
  src: string
  name: string
  mime: string
}

/** Props that make an element open the gallery. */
export function galleryItem(item: GalleryItem) {
  return { 'data-gallery-src': item.src, 'data-gallery-name': item.name, 'data-gallery-mime': item.mime }
}

const PREVIEWABLE_DOCS = ['application/pdf', 'application/json', 'text/']

function kindOf(mime: string): 'image' | 'video' | 'doc' | 'file' {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (PREVIEWABLE_DOCS.some((p) => mime.startsWith(p))) return 'doc'
  return 'file'
}

function collect(): GalleryItem[] {
  const seen = new Set<string>()
  const items: GalleryItem[] = []
  for (const el of document.querySelectorAll<HTMLElement>('[data-gallery-src]')) {
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
      const all = collect()
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

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      // The video's own seek keys win while it has focus.
      if (e.defaultPrevented || (e.target as HTMLElement).closest('video')) return
      if (e.key === 'ArrowLeft') step(-1)
      else if (e.key === 'ArrowRight') step(1)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  const item = open ? items[index] : undefined

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && setIndex(null)}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/90 duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup className="fixed inset-0 z-50 flex flex-col text-white outline-none">
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
                  <a
                    href={item.src}
                    target="_blank"
                    rel="noreferrer"
                    title="Open in new tab"
                    className={chrome}
                  >
                    <ExternalLinkIcon className="size-4" />
                  </a>
                  <a href={item.src} download={item.name} title="Download" className={chrome}>
                    <DownloadIcon className="size-4" />
                  </a>
                  <DialogPrimitive.Close title="Close (Esc)" className={chrome}>
                    <XIcon className="size-5" />
                  </DialogPrimitive.Close>
                </div>
              </header>
              <div
                className="relative flex min-h-0 flex-1 items-center justify-center px-4 pb-4 sm:px-16"
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
                <Viewer key={item.src} item={item} />
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

function Viewer({ item }: { item: GalleryItem }) {
  const kind = kindOf(item.mime)
  if (kind === 'image')
    return <img src={item.src} alt={item.name} className="max-h-full max-w-full object-contain select-none" />
  if (kind === 'video') return <video src={item.src} controls autoPlay className="max-h-full max-w-full" />
  if (kind === 'doc')
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
