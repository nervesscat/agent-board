import { FileText, X } from 'lucide-react'
import { type ClipboardEvent, type DragEvent, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '#/lib/utils'

/** Files picked for an update or comment but not posted yet: a chip each, with a way to drop it. */
export function PendingFiles({ files, onChange }: { files: File[]; onChange: (files: File[]) => void }) {
  // Image previews as object URLs, released when the list changes or the form goes away.
  const previews = useMemo(
    () => files.map((f) => (f.type.startsWith('image/') ? URL.createObjectURL(f) : null)),
    [files],
  )
  useEffect(() => () => previews.forEach((u) => u && URL.revokeObjectURL(u)), [previews])

  return (
    <>
      {files.map((f, i) => (
        <span
          key={`${f.name}-${f.size}-${f.lastModified}-${i}`}
          className="inline-flex max-w-56 items-center gap-1.5 rounded-md border bg-muted/60 py-0.5 pr-0.5 pl-1 text-xs"
          title={f.name}
        >
          {previews[i] ? (
            <img src={previews[i]!} alt="" className="size-5 shrink-0 rounded-sm object-cover" />
          ) : (
            <FileText className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{f.name}</span>
          <span className="shrink-0 text-muted-foreground">{formatSize(f.size)}</span>
          <button
            type="button"
            onClick={() => onChange(files.filter((_, j) => j !== i))}
            className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
            aria-label={`Remove ${f.name}`}
            title="Remove"
          >
            <X className="size-3.5" />
          </button>
        </span>
      ))}
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
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setDragging(false)
      add(Array.from(e.dataTransfer.files))
    },
  }
  return { props, className: cn(dragging && 'ring-2 ring-primary/50 ring-offset-2 ring-offset-background') }
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
