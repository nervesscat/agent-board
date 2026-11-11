import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { cn } from 'cn'
import { Archive, Columns3, List, Loader2, Search, Tags, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'

import { NewTicket } from '#/components/NewTicket'
import { toastRefusal } from '#/components/Needs'
import { useProjectPush } from '#/components/PushDot'
import { tagTextClass } from '#/components/Tag'
import { ArchivedList, type Placement, TicketBoard, TicketList } from '#/components/TicketBoard'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxScroller,
  ComboboxTrigger,
  ComboboxValue,
} from '#/components/ui/combobox'
import { Tabs, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { Skeleton } from '#/components/ui/skeleton'
import { Tip } from '#/components/ui/tooltip'
import { errorMessage, get, patch, post, type TicketRow } from '#/lib/api'
import { useProject } from '#/lib/project'
import { remember, useRestoreRemembered } from '#/lib/remembered'
import { positionBy, stageColumn, withPlacement } from '#/lib/stages'
import { MAX_TAG_LENGTH, matchTags, tagChoices } from '#/lib/tags'
import { type TicketsScope, keepSearchRows, ticketsKey, ticketsQuery } from '#/lib/tickets'

const VIEWS = ['board', 'list', 'archived'] as const
type View = (typeof VIEWS)[number]

// ?view= is the view picked (none: the one this browser remembers, else board). ?q= searches the List
// and the Archived tickets; the Board shows them all. A query that reads as a number (`?q=84`) comes in
// as one. ?tag= keeps the Board and the List to the tickets carrying that tag, in any casing.
export const Route = createFileRoute('/projects/$id/features/')({
  component: Features,
  validateSearch: z.object({
    view: z.enum(VIEWS).optional().catch(undefined),
    q: z.union([z.string(), z.number()]).transform(String).optional().catch(undefined),
    tag: z.union([z.string(), z.number()]).transform(String).optional().catch(undefined),
  }),
})

// The last of board and list picked is remembered in this browser, for a visit whose URL names none
// (the archive is a visit, not a view to come back to).
const VIEW_KEY = 'features.view'
const REMEMBERED_VIEWS = ['board', 'list'] as const

function Features() {
  const { id } = Route.useParams()
  const { view: picked, q = '', tag = '' } = Route.useSearch()
  const navigate = Route.useNavigate()
  const qc = useQueryClient()
  // The tabs and the page both follow the URL, so the server's render and the browser's agree.
  const view = picked ?? 'board'
  const showView = (v: View) => navigate({ search: (s) => ({ ...s, view: v }), replace: true })
  useRestoreRemembered(VIEW_KEY, picked, REMEMBERED_VIEWS, showView)
  const pickView = (v: View) => {
    showView(v)
    if (v !== 'archived') remember(VIEW_KEY, v)
  }
  // The board's list. Both lists sit under `ticketsKey(id)`, so whatever refreshes the board
  // refreshes the archive and its count too.
  const key = ticketsKey(id, 'root')
  const { data, isLoading } = useQuery({ ...ticketsQuery(id, 'root'), refetchInterval: 10_000 })
  const { data: archived, isLoading: archiveLoading } = useQuery({
    ...ticketsQuery(id, 'archived'),
    refetchInterval: 30_000,
  })
  const archiveAll = useMutation({
    mutationFn: (status: string) =>
      post<{ ids: number[] }>(`/api/projects/${id}/tickets/archive`, { status }),
    onSuccess: (res) => toast.success(`Archived ${res.ids.length} ticket${res.ids.length === 1 ? '' : 's'}`),
    onError: (err) => toast.error(errorMessage(err)),
    onSettled: () => qc.invalidateQueries({ queryKey: ticketsKey(id) }),
  })
  const restore = useMutation({
    mutationFn: (ticketId: number) => post(`/api/tickets/${ticketId}/restore`),
    onSuccess: (_d, ticketId) => {
      toast.success(`Restored #${ticketId} to the board`)
      qc.invalidateQueries({ queryKey: ['ticket', String(ticketId)] })
    },
    onError: (err) => toast.error(errorMessage(err)),
    onSettled: () => qc.invalidateQueries({ queryKey: ticketsKey(id) }),
  })
  // Moves and placements on the board are saved one at a time, in the order they were made: each
  // placement's position is worked out on the order the ones before it left.
  const boardScope = { id: `board-${id}` }
  // The card moves at once, unplaced in its new column; a failed save puts it back. A move to done
  // refused for a need not merged yet offers to make it anyway.
  const move = useMutation({
    scope: boardScope,
    mutationFn: (v: { ticketId: number; status: string; force?: boolean }) =>
      patch(`/api/tickets/${v.ticketId}`, { status: v.status, force: v.force }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: key })
      const before = qc.getQueryData<TicketRow[]>(key)
      qc.setQueryData<TicketRow[]>(key, (rows) =>
        rows?.map((t) => (t.id === v.ticketId ? { ...t, status: v.status, rank: null } : t)),
      )
      return { before }
    },
    onError: (err, v, ctx) => {
      qc.setQueryData(key, ctx?.before)
      toastRefusal(err, () => move.mutate({ ...v, force: true }))
    },
    onSettled: (_d, _e, v) => {
      qc.invalidateQueries({ queryKey: ticketsKey(id) })
      qc.invalidateQueries({ queryKey: ['ticket', String(v.ticketId)] })
    },
  })
  // A card's place in its column (dragged within it): shown at once, then the list
  // is read again once the last placement in a row is saved; a failed one puts the order back. A
  // placement ranks every ticket above the moved one too, so their cached pages are read again then.
  const placing = ['place', id]
  const place = useMutation({
    mutationKey: placing,
    scope: boardScope,
    mutationFn: (v: { ticketId: number; position: number }) =>
      patch(`/api/tickets/${v.ticketId}`, { position: v.position }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: key })
      const before = qc.getQueryData<TicketRow[]>(key)
      qc.setQueryData<TicketRow[]>(key, (rows) => rows && withPlacement(rows, v.ticketId, v.position))
      return { before }
    },
    onError: (err, _v, ctx) => {
      qc.setQueryData(key, ctx?.before)
      toast.error(errorMessage(err))
    },
    onSettled: () => {
      if (qc.isMutating({ mutationKey: placing }) <= 1) {
        qc.invalidateQueries({ queryKey: ticketsKey(id) })
        qc.invalidateQueries({ queryKey: ['ticket'] })
      }
    },
  })
  // Right above or below a card of its column, counted in the whole column: a filter may hide some of it.
  const placeBy = (ticketId: number, to: Placement) => {
    const rows = qc.getQueryData<TicketRow[]>(key) ?? []
    const self = rows.find((t) => t.id === ticketId)
    const position = self && positionBy(stageColumn(rows, self.status), ticketId, to.anchor, to.side)
    if (position) place.mutate({ ticketId, position })
  }
  // The search of the List or the Archived tickets: the server finds them, those found by name first.
  const searching = view === 'board' ? '' : q.trim()
  const scope: TicketsScope = view === 'archived' ? 'archived' : 'root'
  const found = useQuery({
    ...ticketsQuery(id, scope, searching),
    enabled: searching !== '',
    // While the next search loads, the rows the last one found stay, if it searched the same list of
    // the same project (the page stays mounted from one project to the next).
    placeholderData: keepSearchRows(id, scope),
    refetchInterval: view === 'archived' ? 30_000 : 10_000,
  })
  const search = (next: string) =>
    navigate({ search: (s) => ({ ...s, q: next || undefined }), replace: true })
  const { data: pushData } = useProjectPush(id)
  const push = useMemo(() => new Map(pushData?.tickets.map((t) => [t.id, t.push])), [pushData])
  // The tag picked narrows the Board and the List, searched or not; the archive shows them all.
  const tagged = (t: TicketRow) =>
    !tag || view === 'archived' || t.tags.some((x) => x.toLowerCase() === tag.toLowerCase())
  const shown = (data ?? []).filter(tagged)
  const filterTag = (next: string) =>
    navigate({ search: (s) => ({ ...s, tag: next || undefined }), replace: true })
  // The search narrows the List and the Archived tickets: the archive shows every ticket it finds.
  const listed = searching ? (found.data ?? []).filter(tagged) : shown
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="sm:min-w-32 sm:flex-1">
          <h1 className="text-xl font-semibold tracking-tight">Ongoing features</h1>
          <p className="text-sm text-muted-foreground">Tickets in flight, by stage.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto sm:shrink-0">
          {view !== 'archived' && (
            <TagFilter
              projectId={id}
              // The rows on screen: those the search found, else the board's or the list's.
              count={searching ? (found.data === undefined ? undefined : listed.length) : shown.length}
              value={tag}
              onChange={filterTag}
            />
          )}
          <Tabs value={view} onValueChange={(v) => pickView(v as View)}>
            <TabsList>
              <TabsTrigger value="board" aria-label="Board">
                <Columns3 /> Board
              </TabsTrigger>
              <TabsTrigger value="list" aria-label="List">
                <List /> List
              </TabsTrigger>
              <TabsTrigger value="archived" aria-label="Archived">
                <Archive /> Archived
                {archived && archived.length > 0 && (
                  <span className="tabular-nums text-muted-foreground">({archived.length})</span>
                )}
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <NewTicket projectId={id} />
        </div>
      </div>
      {/* The search of the List and the Archived tickets keeps its own row under the header. */}
      {view !== 'board' && <TicketSearch q={q} onSearch={search} />}
      {searching ? (
        // A search not answered yet says nothing about its query: the rows kept from the last one
        // show, dimmed, or none at all: the skeleton.
        found.data === undefined || (found.isPlaceholderData && listed.length === 0) ? (
          found.isError ? (
            <p className="text-sm text-destructive">{errorMessage(found.error)}</p>
          ) : (
            <Skeleton className="h-64" />
          )
        ) : listed.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No tickets match “{searching}”.{' '}
            <button type="button" className="underline hover:text-foreground" onClick={() => search('')}>
              Clear the search
            </button>
          </p>
        ) : (
          <div className={found.isPlaceholderData ? 'opacity-60 transition-opacity' : undefined}>
            {view === 'archived' ? (
              <ArchivedList
                projectId={id}
                items={listed}
                onRestore={(ticketId) => restore.mutate(ticketId)}
                restoring={restore.isPending ? restore.variables : undefined}
              />
            ) : (
              <TicketList projectId={id} items={listed} push={push} />
            )}
          </div>
        )
      ) : view === 'archived' ? (
        archiveLoading ? (
          <Skeleton className="h-64" />
        ) : (
          <ArchivedList
            projectId={id}
            items={archived ?? []}
            onRestore={(ticketId) => restore.mutate(ticketId)}
            restoring={restore.isPending ? restore.variables : undefined}
          />
        )
      ) : isLoading ? (
        <Skeleton className="h-64" />
      ) : view === 'list' ? (
        <TicketList projectId={id} items={shown} push={push} />
      ) : (
        <TicketBoard
          projectId={id}
          items={shown}
          push={push}
          onMove={(ticketId, status) => move.mutate({ ticketId, status })}
          onPlace={placeBy}
          onArchiveAll={(status) => archiveAll.mutate(status)}
        />
      )}
    </div>
  )
}

/** How long the tag filter's search waits for the typing to pause before it asks the server, in ms. */
const TAG_SEARCH_DELAY = 200
/** "All tags": no tag at all, so no tag, whatever it is spelled, can be taken for it. */
const ALL_TAGS = { all: true } as const
type TagChoice = string | typeof ALL_TAGS
const tagLabel = (c: TagChoice) => (typeof c === 'string' ? c : 'All tags')
/** Every page of the tag filter's list, under one key per project: dropped whenever it opens. */
const tagsKey = (projectId: string) => ['projectTags', projectId] as const

/**
 * The tag the Board and the List are narrowed to (`?tag=`): the project's suggestions and the tags its
 * tickets carry, most used first. A tag from a link that none of them has is offered too. `count` is how
 * many tickets the view shows with it (none while a search is still loading).
 *
 * Its popup lists them a page at a time from the server (GET /api/projects/:id/tags), the next one when
 * the end of the list comes into view, and searches them all there. Each is written in its chip's colour.
 */
function TagFilter({
  projectId,
  count,
  value,
  onChange,
}: {
  projectId: string
  count: number | undefined
  value: string
  onChange: (tag: string) => void
}) {
  const qc = useQueryClient()
  const { data: project } = useProject(projectId)
  // The tag picked, in the casing the project uses for it: what the trigger shows and the list holds.
  const tags = tagChoices(project?.tagSuggestions ?? [], project?.usedTags ?? [], [])
  const current = tags.find((t) => t.toLowerCase() === value.toLowerCase()) ?? value
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // The search the server is asked for: the field's text once the typing pauses.
  const [searched, setSearched] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setSearched(query.trim()), TAG_SEARCH_DELAY)
    return () => clearTimeout(timer)
  }, [query])
  // A search longer than any tag can be matches none: it is not asked (the server refuses a long one),
  // and only a longer tag from a link could hold it.
  const asked = searched.length <= MAX_TAG_LENGTH
  // One list per search: a page answered for an older one lands under its own key, never in this list.
  const {
    data,
    error,
    isPending,
    refetch,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
  } = useInfiniteQuery({
    queryKey: [...tagsKey(projectId), searched, current],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams()
      if (pageParam) params.set('cursor', pageParam)
      if (searched) params.set('q', searched)
      if (current) params.set('include', current)
      return get<{ tags: string[]; next: string | null }>(`/api/projects/${projectId}/tags?${params}`)
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: open && asked,
  })
  // Each tag once in any casing, whatever the pages hold: an option is keyed by its tag.
  const shown = useMemo(() => {
    if (!asked) return matchTags(current ? [current] : [], searched)
    const seen = new Set<string>()
    return (data?.pages.flatMap((p) => p.tags) ?? []).filter((t) => {
      const key = t.toLowerCase()
      return !seen.has(key) && Boolean(seen.add(key))
    })
  }, [asked, current, searched, data])
  // Typed but not asked yet, or asked and not answered: the list says nothing about this search yet.
  const waiting = query.trim() !== searched || (asked && isPending)
  const choices: TagChoice[] = [ALL_TAGS, ...(waiting ? [] : shown)]
  return (
    <div className="flex min-w-0 items-center gap-1">
      <Combobox<TagChoice>
        value={value ? current : ALL_TAGS}
        onValueChange={(v) => onChange(typeof v === 'string' ? v : '')}
        items={choices}
        filteredItems={choices}
        inputValue={query}
        onInputValueChange={setQuery}
        open={open}
        onOpenChange={(next) => {
          // Opened, it starts over from the first page, fresh from the server.
          if (next) qc.removeQueries({ queryKey: tagsKey(projectId) })
          setOpen(next)
        }}
        // Closed, the search goes.
        onOpenChangeComplete={(isOpen) => {
          if (isOpen) return
          setQuery('')
          setSearched('')
        }}
        itemToStringLabel={tagLabel}
        itemToStringValue={(c) => (typeof c === 'string' ? c : '')}
      >
        <ComboboxTrigger
          size="sm"
          aria-label="Filter by tag"
          className={cn('max-w-56 min-w-0', !value && 'text-muted-foreground')}
        >
          <Tags className="text-muted-foreground" />
          <ComboboxValue />
        </ComboboxTrigger>
        <ComboboxContent aria-label="Tags">
          <ComboboxInput placeholder="Search tags" aria-label="Search tags" />
          <ComboboxScroller>
            <ComboboxList>
              <ComboboxItem value={ALL_TAGS}>All tags</ComboboxItem>
              {!waiting &&
                shown.map((t) => (
                  <ComboboxItem
                    key={t}
                    value={t}
                    className="duration-200 animate-in fade-in-0 slide-in-from-top-1 motion-reduce:animate-none"
                  >
                    <span className={tagTextClass(t)}>{t}</span>
                  </ComboboxItem>
                ))}
            </ComboboxList>
            {error && !isFetchNextPageError ? (
              <TagsError onRetry={() => void refetch()} />
            ) : waiting ? (
              <MoreTags loading />
            ) : (
              <>
                {shown.length === 0 && (
                  <p className="px-1.5 py-1 text-sm text-muted-foreground">No tags match</p>
                )}
                {isFetchNextPageError ? (
                  <TagsError onRetry={() => void fetchNextPage()} />
                ) : (
                  hasNextPage && <MoreTags loading={isFetchingNextPage} onNear={() => void fetchNextPage()} />
                )}
              </>
            )}
          </ComboboxScroller>
        </ComboboxContent>
      </Combobox>
      {value && (
        <>
          {count !== undefined && (
            <span className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
              {count} ticket{count === 1 ? '' : 's'}
            </span>
          )}
          <Tip content="Show every tag">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onChange('')}
              aria-label="Clear the tag filter"
            >
              <X />
            </Button>
          </Tip>
        </>
      )}
    </div>
  )
}

/**
 * The end of the tag filter's list while it holds more: "Loading tags…" while a page is on its way, and
 * once it nears the bottom of the list's scroller, a call for the next page (`onNear`), as the
 * Gallery's MoreFiles does.
 */
function MoreTags({ loading, onNear }: { loading: boolean; onNear?: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const near = useRef(onNear)
  useEffect(() => {
    near.current = onNear
  })
  useEffect(() => {
    const el = ref.current
    if (!el || loading) return
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && near.current?.(), {
      root: el.closest('[data-slot="combobox-scroller"]'),
      rootMargin: '0px 0px 32px 0px',
    })
    io.observe(el)
    return () => io.disconnect()
  }, [loading])
  return (
    <div ref={ref} data-slot="more-tags" className="flex min-h-7 items-center justify-center" role="status">
      {loading && (
        <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading tags…
        </span>
      )}
    </div>
  )
}

/** A page of the tag filter's list the server did not give: said quietly, with a way to ask again. */
function TagsError({ onRetry }: { onRetry: () => void }) {
  return (
    <p className="flex items-center gap-2 px-1.5 py-1 text-xs text-muted-foreground" role="status">
      Couldn't load tags.
      <button type="button" className="underline hover:text-foreground" onClick={onRetry}>
        Retry
      </button>
    </p>
  )
}

/**
 * The search over the List and the Archived tickets. What is typed goes to the URL (`?q=`) once the
 * typing pauses; Escape or the clear button empty it at once.
 */
function TicketSearch({ q, onSearch }: { q: string; onSearch: (q: string) => void }) {
  const [text, setText] = useState(q)
  // The query this field last sent: another one in the URL came from elsewhere (a link, Back).
  const sent = useRef(q)
  const send = useRef(onSearch)
  send.current = onSearch
  useEffect(() => {
    if (q === sent.current) return
    sent.current = q
    setText(q)
  }, [q])
  useEffect(() => {
    const next = text.trim()
    if (next === sent.current) return
    const typing = setTimeout(() => {
      sent.current = next
      send.current(next)
    }, 250)
    return () => clearTimeout(typing)
  }, [text])
  const clear = () => {
    setText('')
    sent.current = ''
    send.current('')
  }
  return (
    <div className="relative w-full max-w-sm">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        aria-label="Search tickets"
        placeholder="Search by name or thread"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Escape' || !text) return
          e.preventDefault()
          clear()
        }}
        className="pr-8 pl-8 [&::-webkit-search-cancel-button]:hidden"
      />
      {text && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={clear}
          className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  )
}
