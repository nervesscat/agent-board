import { PlayIcon } from 'lucide-react'

import { galleryItem } from '#/components/Gallery'
import type { Attachment } from '#/lib/api'

/** Image and video thumbnails, everything else a link; a click opens the gallery. */
export function Attachments({ items }: { items: (Attachment & { url: string })[] }) {
  if (!items.length) return null
  return (
    <div className="mt-3 flex flex-wrap items-start gap-3">
      {items.map((a) => {
        const gallery = galleryItem({ src: a.url, name: a.name, mime: a.mime })
        return a.mime.startsWith('image/') ? (
          <a key={a.id} href={a.url} target="_blank" rel="noreferrer" title={a.name} {...gallery}>
            <img
              src={a.url}
              alt={a.name}
              className="max-h-72 cursor-zoom-in rounded-md border object-contain"
              loading="lazy"
            />
          </a>
        ) : a.mime.startsWith('video/') ? (
          <a
            key={a.id}
            href={a.url}
            target="_blank"
            rel="noreferrer"
            title={a.name}
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
