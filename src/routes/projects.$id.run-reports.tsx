import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { ClipboardList, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import { Empty } from '#/components/Empty'
import { DelayedLoading } from '#/components/Loading'
import { RunReportDialog, runReportDuration } from '#/components/RunReport'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { Skeleton } from '#/components/ui/skeleton'
import { errorMessage, get, type RunReportRow } from '#/lib/api'
import { ago } from '#/lib/format'
import { RUN_REPORT_AGENTS, type RunReport } from '#/lib/runReports'
import { cn } from '#/lib/utils'

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
  const { t } = useTranslation()
  const { id } = Route.useParams()
  const { agent, ticket } = Route.useSearch()
  const navigate = Route.useNavigate()
  const [open, setOpen] = useState<RunReport | null>(null)
  const [ticketText, setTicketText] = useState(ticket ? String(ticket) : '')
  const params = new URLSearchParams()
  if (agent) params.set('agent', agent)
  if (ticket) params.set('ticketId', String(ticket))
  const { data, isLoading, isPlaceholderData, error } = useQuery({
    queryKey: ['run-reports', id, agent ?? '', ticket ?? ''],
    queryFn: () => get<RunReportRow[]>(`/api/projects/${id}/run-reports?${params}`),
    refetchInterval: 30_000,
    // A filter keeps the rows it replaces on show, dimmed; another project's rows never do.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === id ? keepPreviousData(previous) : undefined,
  })
  const filter = (patch: { agent?: string; ticket?: number }) =>
    navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })
  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t('runReport.pageTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('runReport.pageText')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={agent ?? 'all'}
          onValueChange={(v) => filter({ agent: v === 'all' ? undefined : (v ?? undefined) })}
          items={[{ value: 'all', label: t('runReport.allAgents') }, ...agents]}
        >
          <SelectTrigger className="w-40" aria-label={t('runReport.agent')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('runReport.allAgents')}</SelectItem>
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
            placeholder={t('runReport.ticketPlaceholder')}
            aria-label={t('runReport.ticketNumber')}
            className="w-28"
            inputMode="numeric"
          />
          <Button type="submit" variant="outline" size="sm">
            {t('runReport.filter')}
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
            <X data-icon="inline-start" /> {t('runReport.clear')}
          </Button>
        )}
      </div>
      {error ? (
        <p className="text-sm text-destructive">{errorMessage(error)}</p>
      ) : isLoading || (isPlaceholderData && !data?.length) ? (
        <DelayedLoading label={t('loading.runReports')} className="space-y-2">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="flex items-center gap-2 rounded-lg border px-3 py-2" aria-hidden>
              <Skeleton className="h-4 w-4" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="ml-auto h-4 w-16" />
            </div>
          ))}
        </DelayedLoading>
      ) : !data?.length ? (
        <Empty>{agent || ticket ? t('runReport.emptyFiltered') : t('runReport.empty')}</Empty>
      ) : (
        <ul
          className={cn('space-y-2', isPlaceholderData && 'opacity-60 transition-opacity')}
          aria-label={t('runReport.panelTitle')}
          aria-busy={isPlaceholderData || undefined}
        >
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
                  {r.round !== null && (
                    <Badge variant="outline">{t('runReport.round', { round: r.round })}</Badge>
                  )}
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    #{r.ticketId} {r.ticketTitle}
                  </span>
                  <span className="text-xs text-muted-foreground">{runReportDuration(r, t)}</span>
                  {r.difficulty !== null && (
                    <span className="text-xs text-muted-foreground">
                      {t('runReport.difficultyShort', { n: r.difficulty })}
                    </span>
                  )}
                  {r.confidence !== null && (
                    <span className="text-xs text-muted-foreground">
                      {t('runReport.confidenceShort', { n: r.confidence })}
                    </span>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground">{ago(r.createdAt)}</span>
                </button>
                <Link
                  to="/projects/$id/features/$ticketId"
                  params={{ id, ticketId: String(r.ticketId) }}
                  className="shrink-0 text-xs text-muted-foreground hover:text-foreground hover:underline"
                >
                  {t('runReport.openTicket')}
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
