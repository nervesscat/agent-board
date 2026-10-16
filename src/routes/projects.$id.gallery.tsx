import { useInfiniteQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Loader2, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { z } from 'zod'

import { Empty } from '#/components/Empty'
import { FileGrid } from '#/components/FileGallery'
import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import { Input } from '#/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { Skeleton } from '#/components/ui/skeleton'
import { Switch } from '#/components/ui/switch'
import { Tip } from '#/components/ui/tooltip'
import { errorMessage, get, type Gallery } from '#/lib/api'
import { FILE_KINDS, FILE_KIND_LABEL, type FileKind, parseKinds } from '#/lib/fileKinds'
import { isDay } from '#/lib/reports'

const Day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isDay)

// The filters live in the URL, so a filtered gallery reloads and shares as it is: ?type=image,pdf (the
// kinds), ?from=&to= (local days, inclusive, on the upload date), ?sort=oldest, ?archived=include. A
// value that is not one of these is dropped: the gallery shows unfiltered on that count.
export const Route = createFileRoute('/projects/$id/gallery')({
  component: GalleryPage,
  validateSearch: z.object({
    type: z.string().optional().catch(undefined),
    from: Day.optional().catch(undefined),
    to: Day.optional().catch(undefined),
    sort: z.enum(['oldest']).optional().catch(undefined),
    archived: z.enum(['include']).optional().catch(undefined),
  }),
})

const SORTS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
]

function GalleryPage() {
  const { id } = Route.useParams()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const kinds = parseKinds(search.type)
  const set = (patch: Partial<typeof search>) =>
    navigate({ search: (s) => ({ ...s, ...patch }), replace: true })
  const toggleKind = (kind: FileKind, on: boolean) => {
    const next = FILE_KINDS.filter((k) => (k === kind ? on : kinds.includes(k)))
    set({ type: next.length ? next.join(',') : undefined })
  }

  const params = new URLSearchParams()
  if (kinds.length) params.set('type', kinds.join(','))
  if (search.from) params.set('from', search.from)
  if (search.to) params.set('to', search.to)
  if (search.sort) params.set('sort', search.sort)
  if (search.archived) params.set('archived', search.archived)
  const filters = params.toString()
  const filtered = Boolean(kinds.length || search.from || search.to)

  const { data, error, isPending, hasNextPage, fetchNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['gallery', id, filters],
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams(params)
      if (pageParam) q.set('cursor', pageParam)
      return get<Gallery>(`/api/projects/${id}/gallery?${q}`)
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.next ?? undefined,
  })
  const files = data?.pages.flatMap((p) => p.items) ?? []

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Gallery</h1>
        <p className="text-sm text-muted-foreground">
          Every file on the project's tickets: on their posts, on the replies under them and with their
          instructions. Click one to open it here.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-3" role="group" aria-label="Filters">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2" role="group" aria-label="File type">
          {FILE_KINDS.map((k) => (
            <label key={k} className="inline-flex items-center gap-1.5 text-sm">
              <Checkbox checked={kinds.includes(k)} onCheckedChange={(on) => toggleKind(k, on)} />
              {FILE_KIND_LABEL[k]}
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label className="inline-flex items-center gap-1.5">
            From
            <Input
              type="date"
              className="h-8 w-auto"
              value={search.from ?? ''}
              max={search.to}
              onChange={(e) => set({ from: e.target.value || undefined })}
            />
          </label>
          <label className="inline-flex items-center gap-1.5">
            To
            <Input
              type="date"
              className="h-8 w-auto"
              value={search.to ?? ''}
              min={search.from}
              onChange={(e) => set({ to: e.target.value || undefined })}
            />
          </label>
        </div>
        <Select
          value={search.sort ?? 'newest'}
          onValueChange={(v) => set({ sort: v === 'oldest' ? 'oldest' : undefined })}
          items={SORTS}
        >
          <SelectTrigger size="sm" aria-label="Sort" className="min-w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false} align="start">
            {SORTS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Tip content="Also the files of archived tickets">
          <label className="inline-flex items-center gap-2 text-sm">
            <Switch
              size="sm"
              checked={search.archived === 'include'}
              onCheckedChange={(on) => set({ archived: on ? 'include' : undefined })}
            />
            Include archived
          </label>
        </Tip>
        {filtered && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => set({ type: undefined, from: undefined, to: undefined })}
          >
            <X data-icon="inline-start" /> Clear filters
          </Button>
        )}
      </div>

      {error ? (
        <Empty>Could not load the files: {errorMessage(error)}</Empty>
      ) : isPending ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="aspect-[4/5]" />
          ))}
        </div>
      ) : files.length ? (
        <>
          <FileGrid projectId={id} files={files} />
          {hasNextPage && (
            <MoreFiles
              loading={isFetchingNextPage}
              onNear={() => {
                if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
              }}
            />
          )}
        </>
      ) : (
        <Empty>{filtered ? 'No files match these filters.' : 'No files on this project yet.'}</Empty>
      )}
    </div>
  )
}

/**
 * The end of the grid while more files are to come: the next page loads as it nears the screen, by a
 * scroll or by tabbing to the last tiles (focus scrolls them, and this, into view). Observed afresh
 * after each page, so a page too short to push it off the screen brings the one after it too.
 */
function MoreFiles({ loading, onNear }: { loading: boolean; onNear: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const near = useRef(onNear)
  useEffect(() => {
    near.current = onNear
  })
  useEffect(() => {
    const el = ref.current
    if (!el || loading) return
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && near.current(), {
      rootMargin: '0px 0px 600px 0px',
    })
    io.observe(el)
    return () => io.disconnect()
  }, [loading])
  return (
    <div ref={ref} data-slot="more-files" className="flex min-h-8 justify-center" role="status">
      {loading && (
        <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading more files…
        </span>
      )}
    </div>
  )
}
