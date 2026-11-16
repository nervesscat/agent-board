import { PlayIcon } from 'lucide-react'

import { COPY_IMAGE_OVERLAY, CopyImageButton } from '#/components/CopyImage'
import { galleryItem } from '#/components/Gallery'
import { PdfThumb } from '#/components/PdfThumb'
import { Tip } from '#/components/ui/tooltip'
import { annotationNotes } from '#/lib/annotations'
import type { Attachment } from '#/lib/api'

/**
 * Image, video and PDF thumbnails, everything else a link; a click opens the gallery. A picture that
 * was drawn on before it was attached lists the notes that explain its marks, numbered the way the
 * picture numbers them.
 */
export function Attachments({ items }: { items: (Attachment & { url: string })[] }) {
  if (!items.length) return null
  return (
    <div className="mt-3 flex flex-wrap items-start gap-3">
      {items.map((a) => {
        const notes = annotationNotes(a.annotations)
        const gallery = galleryItem({ src: a.url, name: a.name, mime: a.mime, notes })
        return a.mime.startsWith('image/') ? (
          <div key={a.id} className="group/thumb relative max-w-72">
            <Tip content={a.name}>
              <a href={a.url} target="_blank" rel="noreferrer" {...gallery}>
                <img
                  src={a.url}
                  alt={a.name}
                  className="max-h-72 cursor-zoom-in rounded-md border object-contain"
                  loading="lazy"
                />
              </a>
            </Tip>
            <CopyImageButton src={a.url} mime={a.mime} name={a.name} className={COPY_IMAGE_OVERLAY} />
            {notes.length > 0 && (
              <ol
                aria-label={`Notes on ${a.name}`}
                className="mt-1 space-y-0.5 text-xs text-muted-foreground"
              >
                {notes.map((note, i) => (
                  <li key={i}>
                    <span className="tabular-nums">{i + 1}.</span> {note}
                  </li>
                ))}
              </ol>
            )}
          </div>
        ) : a.mime.startsWith('video/') ? (
          <Tip key={a.id} content={a.name}>
            <a
              href={a.url}
              target="_blank"
              rel="noreferrer"
              aria-label={a.name}
              className="group relative block overflow-hidden rounded-md border bg-black"
              {...gallery}
            >
              <video src={a.url} preload="metadata" muted className="max-h-72 max-w-xl" />
              <span className="absolute inset-0 flex items-center justify-center bg-black/20 transition-colors group-hover:bg-black/35">
                <span className="flex size-12 items-center justify-center rounded-full bg-black/60 text-white ring-1 ring-white/20">
                  <PlayIcon className="size-5 translate-x-px fill-current" />
                </span>
              </span>
            </a>
          </Tip>
        ) : a.mime === 'application/pdf' ? (
          <PdfThumb key={a.id} url={a.url} name={a.name} size={a.size} />
        ) : (
          <a
            key={a.id}
            href={a.url}
            target="_blank"
            rel="noreferrer"
            className="text-sm underline underline-offset-4"
            {...gallery}
          >
            {a.name} <span className="text-muted-foreground">({Math.round(a.size / 1024)} KB)</span>
          </a>
        )
      })}
    </div>
  )
}
