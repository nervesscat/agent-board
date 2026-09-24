import { FileText } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { galleryItem } from '#/components/Gallery'

// pdf.js is big: load it (and its worker) the first time a PDF scrolls into view, then share it.
let pdfjs: Promise<typeof import('pdfjs-dist')> | null = null
function loadPdfjs() {
  pdfjs ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(
    ([lib, worker]) => {
      lib.GlobalWorkerOptions.workerSrc = worker.default
      return lib
    },
  )
  return pdfjs
}

const HEIGHT = 288 // the same box as image thumbnails (max-h-72)

/** The first page of a PDF as a thumbnail, with its name and page count; a click opens the gallery. */
export function PdfThumb({ url, name, size }: { url: string; name: string; size: number }) {
  const box = useRef<HTMLAnchorElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(false)
  const [pages, setPages] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)
  const [drawn, setDrawn] = useState(false)

  useEffect(() => {
    const el = box.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && setVisible(true), {
      rootMargin: '200px',
    })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let destroy = () => {}
    loadPdfjs()
      .then(async (lib) => {
        const task = lib.getDocument({ url })
        destroy = () => void task.destroy()
        const doc = await task.promise
        if (cancelled) return
        setPages(doc.numPages)
        const page = await doc.getPage(1)
        const scale = (HEIGHT * window.devicePixelRatio) / page.getViewport({ scale: 1 }).height
        const viewport = page.getViewport({ scale })
        const c = canvas.current
        if (!c || cancelled) return
        c.width = viewport.width
        c.height = viewport.height
        await page.render({ canvas: c, viewport }).promise
        if (!cancelled) setDrawn(true)
      })
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
      destroy()
    }
  }, [visible, url])

  const caption = (
    <span className="flex items-center gap-1.5 text-xs">
      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{name}</span>
      <span className="shrink-0 text-muted-foreground">
        {pages ? `${pages} page${pages === 1 ? '' : 's'}` : `${Math.round(size / 1024)} KB`}
      </span>
    </span>
  )

  return (
    <a
      ref={box}
      href={url}
      target="_blank"
      rel="noreferrer"
      title={name}
      className="group flex w-56 flex-col overflow-hidden rounded-md border bg-card"
      {...galleryItem({ src: url, name, mime: 'application/pdf' })}
    >
      <span className="flex h-72 cursor-zoom-in items-start justify-center overflow-hidden bg-muted">
        {failed ? (
          <FileText className="mt-24 size-10 text-muted-foreground" />
        ) : (
          // max sizes with auto width/height keep the page's proportions inside the box
          <canvas
            ref={canvas}
            style={{ maxHeight: HEIGHT }}
            className={`h-auto max-w-full bg-white transition-opacity group-hover:opacity-90 ${
              drawn ? '' : 'invisible'
            }`}
          />
        )}
      </span>
      <span className="border-t px-2 py-1.5">{caption}</span>
    </a>
  )
}
