import { FileText, Loader2, X } from 'lucide-react'
import { type ClipboardEvent, type DragEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { galleryItem } from '#/components/Gallery'
import { errorMessage, upload } from '#/lib/api'
import { cn } from '#/lib/utils'

/**
 * Files picked for an update or comment but not posted yet: a chip each, which opens the file in
 * the gallery (stepping through this form's files only), with a way to drop it. `uploading` marks
 * the ones still on their way to the server. With `thumbnails`, images show as a picture you can
 * see rather than a chip, the way they will look once attached.
 */
export function PendingFiles({
  files,
  onChange,
  uploading,
  thumbnails = false,
}: {
  files: File[]
  onChange: (files: File[]) => void
  uploading?: (file: File) => boolean
  thumbnails?: boolean
}) {
  // Object URLs for the thumbnails and the gallery, released when the list changes or the form goes away.
  const urls = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files])
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls])
  const group = `pending-${useId()}`

  const remove = (i: number) => onChange(files.filter((_, j) => j !== i))

  return (
    <>
      {files.map((f, i) =>
        thumbnails && f.type.startsWith('image/') ? (
          <span
            key={`${f.name}-${f.size}-${f.lastModified}-${i}`}
            className="relative inline-block"
            title={f.name}
          >
            <button
              type="button"
              className="block cursor-zoom-in"
              aria-label={`Preview ${f.name}`}
              {...galleryItem({ src: urls[i]!, name: f.name, mime: f.type }, group)}
            >
              <img
                src={urls[i]}
                alt={f.name}
                className={cn('h-28 max-w-56 rounded-md border object-cover', uploading?.(f) && 'opacity-60')}
              />
            </button>
            {uploading?.(f) && (
              <Loader2
                className="pointer-events-none absolute top-1/2 left-1/2 size-5 -translate-1/2 animate-spin text-foreground"
                aria-label="uploading"
              />
            )}
            <button
              type="button"
              onClick={() => remove(i)}
              className="absolute -top-2 -right-2 inline-flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground hover:text-foreground"
              aria-label={`Remove ${f.name}`}
              title="Remove"
            >
              <X className="size-3" />
            </button>
          </span>
        ) : (
          <span
            key={`${f.name}-${f.size}-${f.lastModified}-${i}`}
            className="inline-flex max-w-56 items-center gap-1.5 rounded-md border bg-muted/60 py-0.5 pr-0.5 pl-1 text-xs"
            title={f.name}
          >
            <button
              type="button"
              className="inline-flex min-w-0 cursor-zoom-in items-center gap-1.5 rounded-sm hover:underline"
              aria-label={`Preview ${f.name}`}
              {...galleryItem(
                { src: urls[i]!, name: f.name, mime: f.type || 'application/octet-stream' },
                group,
              )}
            >
              {f.type.startsWith('image/') ? (
                <img src={urls[i]} alt="" className="size-5 shrink-0 rounded-sm object-cover" />
              ) : (
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{f.name}</span>
              {uploading?.(f) ? (
                <Loader2
                  className="size-3.5 shrink-0 animate-spin text-muted-foreground"
                  aria-label="uploading"
                />
              ) : (
                <span className="shrink-0 text-muted-foreground">{formatSize(f.size)}</span>
              )}
            </button>
            <button
              type="button"
              onClick={() => remove(i)}
              className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
              aria-label={`Remove ${f.name}`}
              title="Remove"
            >
              <X className="size-3.5" />
            </button>
          </span>
        ),
      )}
    </>
  )
}

const formatSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`

/**
 * Paste and drag-and-drop for an attachment form: spread `props` on the form and give
 * `className` to it for the drop highlight. Pasting files (a screenshot, files copied in the
 * file manager) adds them; a paste that also carries text is left to the textarea.
 */
export function useFileDrop(add: (files: File[]) => void) {
  const [dragging, setDragging] = useState(false)
  // dragenter/dragleave fire for every child crossed, so count them.
  const depth = useRef(0)
  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files')

  const props = {
    onPaste: (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData.files)
      if (!files.length || e.clipboardData.types.includes('text/plain')) return
      e.preventDefault()
      add(files.map(named))
    },
    onDragEnter: (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current++
      setDragging(true)
    },
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    },
    onDragLeave: (e: DragEvent) => {
      if (!hasFiles(e)) return
      if (--depth.current <= 0) {
        depth.current = 0
        setDragging(false)
      }
    },
    // Cleared on the way down: a drop the rich text editor takes for itself never bubbles back up.
    onDropCapture: () => {
      depth.current = 0
      setDragging(false)
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      add(Array.from(e.dataTransfer.files))
    },
  }
  return { props, className: cn(dragging && 'ring-2 ring-primary/50 ring-offset-2 ring-offset-background') }
}

/**
 * Files uploaded as soon as they are added, for a form whose owner does not exist yet (a new
 * ticket): `ids` are the uploads to send along with it, `uploading` is true until every one has
 * arrived. A file that fails to upload is dropped with a toast. Uploads that are removed or never
 * sent stay on the server unattached.
 */
export function useUploads() {
  // Kept apart, so the list (and its thumbnails) changes only when files are added or removed.
  const [files, setFiles] = useState<File[]>([])
  const [ids, setIds] = useState<ReadonlyMap<File, number>>(new Map())
  const add = (added: File[]) => {
    const picked = added.map(named)
    setFiles((prev) => [...prev, ...picked])
    for (const file of picked)
      upload(file).then(
        (a) => setIds((prev) => new Map(prev).set(file, a.id)),
        (err) => {
          toast.error(`${file.name}: ${errorMessage(err)}`)
          setFiles((prev) => prev.filter((f) => f !== file))
        },
      )
  }
  return {
    add,
    files,
    /** For PendingFiles: the files left in the list. */
    setFiles,
    isUploading: (file: File) => !ids.has(file),
    uploading: files.some((f) => !ids.has(f)),
    ids: files.flatMap((f) => ids.get(f) ?? []),
    clear: () => {
      setFiles([])
      setIds(new Map())
    },
  }
}

/** Pasted screenshots all arrive as "image.png": give them a name that tells them apart. */
function named(f: File) {
  if (!/^image\.\w+$/.test(f.name)) return f
  const stamp = new Date().toISOString().slice(0, 19).replace('T', '-').replaceAll(':', '')
  return new File([f], `pasted-${stamp}.${f.name.split('.').pop()}`, {
    type: f.type,
    lastModified: f.lastModified,
  })
}
