import { useInfiniteQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import {
  ArrowDownAZ,
  ArrowDownNarrowWide,
  ArrowDownWideNarrow,
  ArrowDownZA,
  ClockArrowDown,
  ClockArrowUp,
  Loader2,
  type LucideIcon,
  Shapes,
  X,
} from 'lucide-react'
import { useEffect, useRef } from 'react'
import { z } from 'zod'

import { ChipToggles } from '#/components/Chips'
import { DatePicker } from '#/components/DatePicker'
import { Empty } from '#/components/Empty'
import { FileGrid } from '#/components/FileGallery'
import { Button } from '#/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { Skeleton } from '#/components/ui/skeleton'
import { Switch } from '#/components/ui/switch'
import { Tip } from '#/components/ui/tooltip'
import { errorMessage, get, type Gallery } from '#/lib/api'
import {
  FILE_KINDS,
  FILE_KIND_LABEL,
  type FileKind,
  GALLERY_SORTS,
  GALLERY_SORT_LABEL,
  type GallerySort,
  parseKinds,
} from '#/lib/fileKinds'
import { isDay } from '#/lib/reports'

const Day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isDay)

// The filters live in the URL, so a filtered gallery reloads and shares as it is: ?type=image,pdf (the
// kinds), ?from=&to= (local days, inclusive, on the upload date), ?sort= (an order of GALLERY_SORTS; none
// for newest first), ?archived=include. A value that is not one of these is dropped: the gallery shows
// unfiltered, or newest first, on that count.
export const Route = createFileRoute('/projects/$id/gallery')({
  component: GalleryPage,
  validateSearch: z.object({
    type: z.string().optional().catch(undefined),
    from: Day.optional().catch(undefined),
    to: Day.optional().catch(undefined),
    sort: z.enum(GALLERY_SORTS).optional().catch(undefined),
    archived: z.enum(['include']).optional().catch(undefined),
  }),
})

const SORT_ICON: Record<GallerySort, LucideIcon> = {
  newest: ClockArrowDown,
  oldest: ClockArrowUp,
  name: ArrowDownAZ,
  'name-desc': ArrowDownZA,
  largest: ArrowDownWideNarrow,
  smallest: ArrowDownNarrowWide,
  type: Shapes,
}
const SORTS = GALLERY_SORTS.map((value) => ({ value, label: GALLERY_SORT_LABEL[value] }))
const KIND_CHIPS = FILE_KINDS.map((key) => ({ key, label: FILE_KIND_LABEL[key] }))

function SortLabel({ sort }: { sort: GallerySort }) {
  const Icon = SORT_ICON[sort]
  return (
    <>
      <Icon aria-hidden />
      {GALLERY_SORT_LABEL[sort]}
    </>
  )
}

function GalleryPage() {
  const { id } = Route.useParams()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const kinds = parseKinds(search.type)
  const sort = search.sort ?? 'newest'
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
  if (sort !== 'newest') params.set('sort', sort)
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
        <p className="text-sm text-muted-foreground">Every file on the project's tickets.</p>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-3" role="group" aria-label="Filters">
        <ChipToggles
          chips={KIND_CHIPS}
          value={kinds}
          onToggle={toggleKind}
          label="File type"
          // Five chips do not fit one row on a phone: there they wrap, and the page never scrolls sideways.
          className="max-w-full flex-nowrap justify-start overflow-x-auto"
        />
        <div className="flex flex-wrap items-center gap-2">
          <DatePicker
            value={search.from}
            onChange={(day?: string) => set({ from: day })}
            placeholder="From"
            max={search.to}
          />
          <DatePicker
            value={search.to}
            onChange={(day?: string) => set({ to: day })}
            placeholder="To"
            min={search.from}
          />
        </div>
        <Select
          value={sort}
          onValueChange={(v) => set({ sort: v && v !== 'newest' ? (v as GallerySort) : undefined })}
          items={SORTS}
        >
          <Tip content={`Sort: ${GALLERY_SORT_LABEL[sort]}`}>
            <SelectTrigger size="sm" aria-label="Sort" className="min-w-36">
              <SelectValue>{(v: GallerySort) => <SortLabel sort={v} />}</SelectValue>
            </SelectTrigger>
          </Tip>
          <SelectContent alignItemWithTrigger={false} align="start">
            {SORTS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                <SortLabel sort={o.value} />
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
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
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
