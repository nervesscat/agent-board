import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { Archive, BrushCleaning, Columns3, List } from 'lucide-react'
import { toast } from 'sonner'
import { z } from 'zod'

import { NewTicket } from '#/components/NewTicket'
import { ArchivedList, TicketBoard, TicketList } from '#/components/TicketBoard'
import { Tabs, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { Skeleton } from '#/components/ui/skeleton'
import { errorMessage, get, patch, post, type CleanupReport, type TicketRow } from '#/lib/api'
import { remember, useRestoreRemembered } from '#/lib/remembered'

const VIEWS = ['board', 'list', 'archived'] as const
type View = (typeof VIEWS)[number]

// ?view= is the view picked (none: the one this browser remembers, else board).
export const Route = createFileRoute('/projects/$id/features/')({
  component: Features,
  validateSearch: z.object({ view: z.enum(VIEWS).optional().catch(undefined) }),
})

// The last of board and list picked is remembered in this browser, for a visit whose URL names none
// (the archive is a visit, not a view to come back to).
const VIEW_KEY = 'features.view'
const REMEMBERED_VIEWS = ['board', 'list'] as const

function Features() {
  const { id } = Route.useParams()
  const { view: picked } = Route.useSearch()
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
  const key = ['tickets', id]
  const { data, isLoading } = useQuery({
    queryKey: key,
    queryFn: () => get<TicketRow[]>(`/api/projects/${id}/tickets?parent=root`),
    refetchInterval: 10_000,
  })
  // Under the same key, so whatever refreshes the board refreshes the archive and its count too.
  const archivedKey = [...key, 'archived']
  const { data: archived, isLoading: archiveLoading } = useQuery({
    queryKey: archivedKey,
    queryFn: () => get<TicketRow[]>(`/api/projects/${id}/tickets?parent=root&archived=only`),
    refetchInterval: 30_000,
  })
  const archiveAll = useMutation({
    mutationFn: (status: string) =>
      post<{ ids: number[] }>(`/api/projects/${id}/tickets/archive`, { status }),
    onSuccess: (res) => toast.success(`Archived ${res.ids.length} ticket${res.ids.length === 1 ? '' : 's'}`),
    onError: (err) => toast.error(errorMessage(err)),
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  })
  const restore = useMutation({
    mutationFn: (ticketId: number) => post(`/api/tickets/${ticketId}/restore`),
    onSuccess: (_d, ticketId) => {
      toast.success(`Restored #${ticketId} to the board`)
      qc.invalidateQueries({ queryKey: ['ticket', String(ticketId)] })
    },
    onError: (err) => toast.error(errorMessage(err)),
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  })
  // The card moves at once; a failed save puts it back.
  const move = useMutation({
    mutationFn: (v: { ticketId: number; status: string }) =>
      patch(`/api/tickets/${v.ticketId}`, { status: v.status }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: key })
      const before = qc.getQueryData<TicketRow[]>(key)
      qc.setQueryData<TicketRow[]>(key, (rows) =>
        rows?.map((t) => (t.id === v.ticketId ? { ...t, status: v.status } : t)),
      )
      return { before }
    },
    onError: (err, _v, ctx) => {
      qc.setQueryData(key, ctx?.before)
      toast.error(errorMessage(err))
    },
    onSettled: (_d, _e, v) => {
      qc.invalidateQueries({ queryKey: key })
      qc.invalidateQueries({ queryKey: ['ticket', String(v.ticketId)] })
    },
  })
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
      {view === 'archived' ? (
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
        <TicketList projectId={id} items={data ?? []} />
      ) : (
        <TicketBoard
          projectId={id}
          items={data ?? []}
          onMove={(ticketId, status) => move.mutate({ ticketId, status })}
          onArchiveAll={(status) => archiveAll.mutate(status)}
        />
      )}
    </div>
  )
}

const plural = (n: number, word: string, words = `${word}s`) => `${n} ${n === 1 ? word : words}`

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
