import type { Attachment } from '#/lib/api'

/** Images inline, videos playable, everything else a download link. */
export function Attachments({ items }: { items: (Attachment & { url: string })[] }) {
  if (!items.length) return null
  return (
    <div className="mt-3 flex flex-wrap gap-3">
      {items.map((a) =>
        a.mime.startsWith('image/') ? (
          <a key={a.id} href={a.url} target="_blank" rel="noreferrer" title={a.name}>
            <img
              src={a.url}
              alt={a.name}
              className="max-h-72 rounded-md border object-contain"
              loading="lazy"
            />
          </a>
        ) : a.mime.startsWith('video/') ? (
          <video
            key={a.id}
            src={a.url}
            controls
            preload="metadata"
            className="max-h-80 w-full max-w-xl rounded-md border"
          />
        ) : (
          <a
            key={a.id}
            href={a.url}
            target="_blank"
            rel="noreferrer"
            className="text-sm underline underline-offset-4"
          >
            {a.name} <span className="text-muted-foreground">({Math.round(a.size / 1024)} KB)</span>
          </a>
        ),
      )}
    </div>
  )
}
