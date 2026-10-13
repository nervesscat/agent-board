import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { Archive, BrushCleaning, Columns3, List, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'

import { toastHandoff } from '#/components/Handoff'
import { NewTicket } from '#/components/NewTicket'
import { toastRefusal } from '#/components/Needs'
import { RefreshPush, checkedText, isUnpushed, useProjectPush } from '#/components/PushDot'
import { ArchivedList, TicketBoard, TicketList } from '#/components/TicketBoard'
import { Input } from '#/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { Skeleton } from '#/components/ui/skeleton'
import { errorMessage, get, patch, post, type CleanupReport, type Push, type TicketRow } from '#/lib/api'
import { remember, useRestoreRemembered } from '#/lib/remembered'
import { type TicketsScope, ticketsKey, ticketsQuery } from '#/lib/tickets'

const VIEWS = ['board', 'list', 'archived'] as const
type View = (typeof VIEWS)[number]

// ?view= is the view picked (none: the one this browser remembers, else board). ?q= searches the List
// and the Archived tickets; the Board shows them all. A query that reads as a number (`?q=84`) comes in
// as one.
export const Route = createFileRoute('/projects/$id/features/')({
  component: Features,
  validateSearch: z.object({
    view: z.enum(VIEWS).optional().catch(undefined),
    q: z.union([z.string(), z.number()]).transform(String).optional().catch(undefined),
  }),
})

// The last of board and list picked is remembered in this browser, for a visit whose URL names none
// (the archive is a visit, not a view to come back to).
const VIEW_KEY = 'features.view'
const REMEMBERED_VIEWS = ['board', 'list'] as const

function Features() {
  const { id } = Route.useParams()
  const { view: picked, q = '' } = Route.useSearch()
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
  // The card moves at once; a failed save puts it back. A move to done refused for a need not merged
  // yet offers to make it anyway.
  const move = useMutation({
    mutationFn: (v: { ticketId: number; status: string; force?: boolean }) =>
      patch(`/api/tickets/${v.ticketId}`, { status: v.status, force: v.force }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: key })
      const before = qc.getQueryData<TicketRow[]>(key)
      qc.setQueryData<TicketRow[]>(key, (rows) =>
        rows?.map((t) => (t.id === v.ticketId ? { ...t, status: v.status } : t)),
      )
      return { before }
    },
    // A move to review goes through; the board says what the hand-off still lacks.
    onSuccess: toastHandoff,
    onError: (err, v, ctx) => {
      qc.setQueryData(key, ctx?.before)
      toastRefusal(err, () => move.mutate({ ...v, force: true }))
    },
    onSettled: (_d, _e, v) => {
      qc.invalidateQueries({ queryKey: ticketsKey(id) })
      qc.invalidateQueries({ queryKey: ['ticket', String(v.ticketId)] })
    },
  })
  // The search of the List or the Archived tickets: the server finds them, those found by name first.
  const searching = view === 'board' ? '' : q.trim()
  const scope: TicketsScope = view === 'archived' ? 'archived' : 'root'
  const found = useQuery({
    ...ticketsQuery(id, scope, searching),
    enabled: searching !== '',
    // While the next search loads, the rows of the last one stay, if it searched the same list. The
    // unsearched list (the same key without a query) is not a search: its rows do not stay.
    placeholderData: (rows, last) =>
      last?.queryKey[2] === scope && last.queryKey[3] !== undefined ? rows : undefined,
    refetchInterval: view === 'archived' ? 30_000 : 10_000,
  })
  const search = (next: string) =>
    navigate({ search: (s) => ({ ...s, q: next || undefined }), replace: true })
  const { data: pushData } = useProjectPush(id)
  const push = useMemo(() => new Map(pushData?.tickets.map((t) => [t.id, t.push])), [pushData])
  // Only the tickets whose branch is not on origin, from the line under the header.
  const [onlyUnpushed, setOnlyUnpushed] = useState(false)
  const unpushed = (data ?? []).filter((t) => isUnpushed(push.get(t.id)))
  const shown = onlyUnpushed ? unpushed : (data ?? [])
  // The line narrows the List alone, searched or not; the archive shows every ticket it finds.
  const listed = searching
    ? (found.data ?? []).filter((t) => view !== 'list' || !onlyUnpushed || isUnpushed(push.get(t.id)))
    : shown
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Ongoing features</h1>
          <p className="text-sm text-muted-foreground">
            Tickets agents pick up. Each one carries its todo list, branch, workspaces, updates, a thread, and
            lanes for work running in parallel. On the board, drag a card to another column to change its
            stage; the stages themselves are set in Settings. A done or cancelled column can archive its
            tickets, which then wait under Archived.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
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
      <LeftoverLine projectId={id} />
      {view !== 'archived' && (unpushed.length > 0 || onlyUnpushed) && (
        <UnpushedLine
          projectId={id}
          n={unpushed.length}
          checked={(pushData?.repos ?? []).filter((r) => pushData!.tickets.some((t) => t.repoId === r.id))}
          active={onlyUnpushed}
          onToggle={() => setOnlyUnpushed((v) => !v)}
        />
      )}
      {view !== 'board' && <TicketSearch q={q} onSearch={search} />}
      {searching ? (
        found.data === undefined ? (
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
          onArchiveAll={(status) => archiveAll.mutate(status)}
        />
      )}
    </div>
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
    <div className="relative max-w-sm">
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

const plural = (n: number, word: string, words = `${word}s`) => `${n} ${n === 1 ? word : words}`

/**
 * How many tickets on the board have a branch that is not on origin; clicking it shows only those
 * (and clicking again, all of them). Refresh fetches origin now.
 */
function UnpushedLine({
  projectId,
  n,
  checked,
  active,
  onToggle,
}: {
  projectId: string
  n: number
  checked: Pick<Push, 'checkedAt'>[]
  active: boolean
  onToggle: () => void
}) {
  // The stalest repo is what the count can be trusted to.
  const oldest = checked.reduce<Pick<Push, 'checkedAt'> | null>(
    (a, r) => (!a || !r.checkedAt || (a.checkedAt && r.checkedAt < a.checkedAt) ? r : a),
    null,
  )
  return (
    <div
      className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
        active ? 'border-red-500/50 bg-red-500/5' : 'border-dashed'
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={active}
        className="flex min-w-0 items-center gap-2 text-left hover:underline"
        title={active ? 'Show every ticket' : 'Show only these'}
      >
        <span className="size-2 shrink-0 rounded-full bg-red-500" />
        <span>
          {n === 1 ? '1 branch' : `${n} branches`} not pushed
          {active && <span className="text-muted-foreground"> · showing only {n === 1 ? 'it' : 'them'}</span>}
        </span>
      </button>
      <span className="ml-auto shrink-0 text-xs text-muted-foreground">{oldest && checkedText(oldest)}</span>
      <RefreshPush projectId={projectId} />
    </div>
  )
}

/** One line when closed tickets still hold worktrees or branches, linking to the Cleanup module. */
function LeftoverLine({ projectId }: { projectId: string }) {
  const { data } = useQuery({
    queryKey: ['cleanup', projectId, 'counts'],
    queryFn: () => get<CleanupReport>(`/api/projects/${projectId}/cleanup?reach=0`),
    refetchInterval: 60_000,
  })
  const c = data?.counts
  if (!c?.tickets && !data?.untracked.length) return null
  const held = [
    c!.worktrees && plural(c!.worktrees, 'worktree'),
    c!.branches && plural(c!.branches, 'local branch', 'local branches'),
    c!.remote && `${c!.remote} on origin`,
    c!.workspaces && plural(c!.workspaces, 'registered workspace'),
  ].filter(Boolean)
  return (
    <Link
      to="/projects/$id/cleanup"
      params={{ id: projectId }}
      className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
    >
      <BrushCleaning className="size-4 shrink-0" />
      <span>
        {c!.tickets > 0 && (
          <>
            {plural(c!.tickets, 'closed ticket')} still {c!.tickets === 1 ? 'has' : 'have'} {held.join(', ')}
            {data!.untracked.length > 0 && '; '}
          </>
        )}
        {data!.untracked.length > 0 && `${plural(data!.untracked.length, 'untracked worktree')}`}.
      </span>
      <span className="ml-auto shrink-0 underline">Review</span>
    </Link>
  )
}
