import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { toast } from 'sonner'

import { NewTicket } from '#/components/NewTicket'
import { TicketBoard } from '#/components/TicketBoard'
import { Skeleton } from '#/components/ui/skeleton'
import type { TicketStatus } from '#/lib/constants'
import { errorMessage, get, patch, type TicketRow } from '#/lib/api'

export const Route = createFileRoute('/projects/$id/features/')({ component: Features })

function Features() {
  const { id } = Route.useParams()
  const qc = useQueryClient()
  const key = ['tickets', id]
  const { data, isLoading } = useQuery({
    queryKey: key,
    queryFn: () => get<TicketRow[]>(`/api/projects/${id}/tickets?parent=root`),
    refetchInterval: 10_000,
  })
  // The card moves at once; a failed save puts it back.
  const move = useMutation({
    mutationFn: (v: { ticketId: number; status: TicketStatus }) =>
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
            lanes for work running in parallel. Drag a card to another column to change its status.
          </p>
        </div>
        <NewTicket projectId={id} />
      </div>
      {isLoading ? (
        <Skeleton className="h-64" />
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
