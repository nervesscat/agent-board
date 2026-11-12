import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { ClipboardList, X } from 'lucide-react'
import { useState } from 'react'
import { z } from 'zod'

import { Empty } from '#/components/Empty'
import { RunReportDialog } from '#/components/RunReport'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { Skeleton } from '#/components/ui/skeleton'
import { errorMessage, get, type RunReportRow } from '#/lib/api'
import { ago } from '#/lib/format'
import { RUN_REPORT_AGENTS, type RunReport } from '#/lib/runReports'
import { formatDuration } from '#/lib/workTimeline'

// ?agent= and ?ticket= narrow the list: one kind of run across tickets, and further to one ticket. A
// value the board does not know is dropped, and the list shows unfiltered on that count.
export const Route = createFileRoute('/projects/$id/run-reports')({
  component: RunReportsPage,
  validateSearch: z.object({
    agent: z.string().optional().catch(undefined),
    ticket: z.number().int().positive().optional().catch(undefined),
  }),
})

const agents = RUN_REPORT_AGENTS.map((a) => ({ value: a, label: a }))

function RunReportsPage() {
  const { id } = Route.useParams()
  const { agent, ticket } = Route.useSearch()
  const navigate = Route.useNavigate()
  const [open, setOpen] = useState<RunReport | null>(null)
  const [ticketText, setTicketText] = useState(ticket ? String(ticket) : '')
  const params = new URLSearchParams()
  if (agent) params.set('agent', agent)
  if (ticket) params.set('ticketId', String(ticket))
  const { data, isLoading, error } = useQuery({
    queryKey: ['run-reports', id, agent ?? '', ticket ?? ''],
    queryFn: () => get<RunReportRow[]>(`/api/projects/${id}/run-reports?${params}`),
    refetchInterval: 30_000,
  })
  const filter = (patch: { agent?: string; ticket?: number }) =>
    navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })
  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Run reports</h1>
        <p className="text-sm text-muted-foreground">
          How each subagent run went, in its own words. One report per run; a review round has one of each of
          its agents.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={agent ?? 'all'}
          onValueChange={(v) => filter({ agent: v === 'all' ? undefined : (v ?? undefined) })}
          items={[{ value: 'all', label: 'All agents' }, ...agents]}
        >
          <SelectTrigger className="w-40" aria-label="Agent">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All agents</SelectItem>
            {agents.map((a) => (
              <SelectItem key={a.value} value={a.value}>
                {a.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault()
            const n = Number(ticketText.trim().replace(/^#/, ''))
            filter({ ticket: Number.isInteger(n) && n > 0 ? n : undefined })
          }}
        >
          <Input
            value={ticketText}
            onChange={(e) => setTicketText(e.target.value)}
            placeholder="Ticket #"
            aria-label="Ticket number"
            className="w-28"
            inputMode="numeric"
          />
          <Button type="submit" variant="outline" size="sm">
            Filter
          </Button>
        </form>
        {(agent || ticket) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setTicketText('')
              navigate({ search: {}, replace: true })
            }}
          >
            <X data-icon="inline-start" /> Clear
          </Button>
        )}
      </div>
      {error ? (
        <p className="text-sm text-destructive">{errorMessage(error)}</p>
      ) : isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : !data?.length ? (
        <Empty>No run reports{agent || ticket ? ' for that filter' : ' yet'}.</Empty>
      ) : (
        <ul className="space-y-2" aria-label="Run reports">
          {data.map((r) => (
            <li key={r.id} className="rounded-lg border">
              <div className="flex items-center gap-2 px-3 py-2">
                <button
                  type="button"
                  onClick={() => setOpen(r)}
                  className="flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 text-left text-sm hover:text-foreground"
                >
                  <ClipboardList className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="font-medium">{r.agent}</span>
                  {r.round !== null && <Badge variant="outline">round {r.round}</Badge>}
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    #{r.ticketId} {r.ticketTitle}
                  </span>
                  <span className="text-xs text-muted-foreground">{formatDuration(r.durationMs)}</span>
                  {r.difficulty !== null && (
                    <span className="text-xs text-muted-foreground">difficulty {r.difficulty}/5</span>
                  )}
                  {r.confidence !== null && (
                    <span className="text-xs text-muted-foreground">confidence {r.confidence}/5</span>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground">{ago(r.createdAt)}</span>
                </button>
                <Link
                  to="/projects/$id/features/$ticketId"
                  params={{ id, ticketId: String(r.ticketId) }}
                  className="shrink-0 text-xs text-muted-foreground hover:text-foreground hover:underline"
                >
                  Open ticket
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
      <RunReportDialog report={open} onClose={() => setOpen(null)} />
    </div>
  )
}
