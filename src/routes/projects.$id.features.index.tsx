import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Columns3, List } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { NewTicket } from '#/components/NewTicket'
import { TicketBoard, TicketList } from '#/components/TicketBoard'
import { Tabs, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { Skeleton } from '#/components/ui/skeleton'
import { errorMessage, get, patch, type TicketRow } from '#/lib/api'

export const Route = createFileRoute('/projects/$id/features/')({ component: Features })

type View = 'board' | 'list'
// The last view picked is remembered in this browser; storage can be unavailable, so board is the fallback.
const VIEW_KEY = 'features.view'
function savedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'board'
  } catch {
    return 'board'
  }
}

function Features() {
  const { id } = Route.useParams()
  const qc = useQueryClient()
  const [view, setView] = useState<View>(savedView)
  const pickView = (v: View) => {
    setView(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {}
  }
  const key = ['tickets', id]
  const { data, isLoading } = useQuery({
    queryKey: key,
    queryFn: () => get<TicketRow[]>(`/api/projects/${id}/tickets?parent=root`),
    refetchInterval: 10_000,
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
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Ongoing features</h1>
          <p className="text-sm text-muted-foreground">
            Tickets agents pick up. Each one carries its todo list, branch, workspaces, updates, a thread, and
            lanes for work running in parallel. On the board, drag a card to another column to change its
            stage; the stages themselves are set in Settings.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Tabs value={view} onValueChange={(v) => pickView(v as View)}>
            <TabsList>
              <TabsTrigger value="board" aria-label="Board">
                <Columns3 /> Board
              </TabsTrigger>
              <TabsTrigger value="list" aria-label="List">
                <List /> List
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <NewTicket projectId={id} />
        </div>
      </div>
      {isLoading ? (
        <Skeleton className="h-64" />
      ) : view === 'list' ? (
        <TicketList projectId={id} items={data ?? []} />
      ) : (
        <TicketBoard
          projectId={id}
          items={data ?? []}
          onMove={(ticketId, status) => move.mutate({ ticketId, status })}
        />
      )}
    </div>
  )
}
