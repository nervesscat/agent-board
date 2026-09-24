import { FileText, X } from 'lucide-react'
import { useEffect, useMemo } from 'react'

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
