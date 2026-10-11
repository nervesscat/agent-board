import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { GitBranch, Layers, RefreshCw } from 'lucide-react'

import { Empty } from '#/components/Empty'
import { ManagedLine, PreviewActions, PreviewBadge, previewActive } from '#/components/Preview'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Skeleton } from '#/components/ui/skeleton'
import { errorMessage, get, type ProjectPreview } from '#/lib/api'
import { useStages } from '#/lib/project'
import { type StageLike, stageBadge, stageOf } from '#/lib/stages'

export const Route = createFileRoute('/projects/$id/previews')({ component: Previews })

const GROUPS = [
  {
    key: 'running',
    title: 'Running',
    hint: 'Built and run by the board, or a link on this machine that answers.',
  },
  {
    key: 'stopped',
    title: 'Not running',
    hint: 'Stopped, failed, a link that does not answer, or one off this machine the board does not check.',
  },
] as const

function Previews() {
  const { id } = Route.useParams()
  const stages = useStages(id)
  // Polled only while the page is in view, faster while the board builds or starts one, as on a ticket.
  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ['previews', id],
    queryFn: () => get<{ previews: ProjectPreview[] }>(`/api/projects/${id}/previews`),
    refetchInterval: (q) =>
      q.state.data?.previews.some((p) => previewActive(p.managed) && p.managed?.status !== 'running')
        ? 2_000
        : 15_000,
  })
  const previews = data?.previews ?? []

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Previews</h1>
          <p className="text-sm text-muted-foreground">
            Every preview of the project's tickets, running or not: links the agents registered, and the
            previews the board builds and runs from their worktrees. Archived tickets are left out.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw data-icon="inline-start" className={isFetching ? 'animate-spin' : ''} /> Refresh
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{errorMessage(error)}</p>}
      {isLoading ? (
        <Skeleton className="h-64" />
      ) : !previews.length ? (
        !error && (
          <Empty>
            No previews yet. One shows up here once an agent registers a preview link on a ticket's workspace,
            or the board runs one from its worktree.
          </Empty>
        )
      ) : (
        GROUPS.map((g) => {
          const items = previews.filter((p) => p.running === (g.key === 'running'))
          if (!items.length) return null
          return (
            <section key={g.key} aria-label={g.title} className="space-y-1.5">
              <h2 className="text-sm font-medium">
                {g.title} <span className="text-muted-foreground">· {items.length}</span>
              </h2>
              <p className="text-xs text-muted-foreground">{g.hint}</p>
              <ul className="space-y-2">
                {items.map((p) => (
                  <PreviewItem
                    key={p.workspace.id}
                    p={p}
                    projectId={id}
                    stage={stages.length ? stageOf(stages, p.ticket.status) : null}
                    onChange={() => void refetch()}
                  />
                ))}
              </ul>
            </section>
          )
        })
      )}
    </div>
  )
}

function PreviewItem({
  p,
  projectId,
  stage,
  onChange,
}: {
  p: ProjectPreview
  projectId: string
  stage: StageLike | null
  onChange: () => void
}) {
  const { workspace: w, ticket: t } = p
  return (
    <li className="min-w-0 space-y-1.5 rounded-lg border p-3 text-sm">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Link
          to="/projects/$id/features/$ticketId"
          params={{ id: projectId, ticketId: String(t.id) }}
          className="flex min-w-0 items-center gap-1 font-medium hover:underline"
        >
          {t.parentId && <Layers className="size-3 shrink-0 text-muted-foreground" />}
          <span className="shrink-0 text-muted-foreground">#{t.id}</span>
          <span className="truncate">{t.title}</span>
        </Link>
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] leading-none font-medium ${stage ? stageBadge(stage) : 'bg-muted'}`}
        >
          {stage?.name ?? t.status}
        </span>
        <PreviewBadge
          url={p.url}
          check={p.check}
          unchecked="The board checks links on this machine only"
          className="ml-auto"
        />
      </div>
      {p.url && (
        <div className="truncate font-mono text-xs text-muted-foreground" title={p.url}>
          {p.url}
        </div>
      )}
      {p.managed && <ManagedLine m={p.managed} workspaceId={w.id} />}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span
          className="inline-flex min-w-0 items-center gap-1 font-mono"
          title={`workspace ${w.name}${w.path ? ` in ${w.path}` : ''}`}
        >
          <GitBranch className="size-3 shrink-0" /> <span className="truncate">{w.branch || w.name}</span>
        </span>
        {w.agent && <Badge variant="secondary">{w.agent}</Badge>}
      </div>
      <div className="flex flex-wrap items-center gap-2 empty:hidden">
        <PreviewActions
          workspaceId={w.id}
          url={p.url}
          managed={p.managed}
          cannotStart={p.cannotStart}
          onChange={onChange}
        />
      </div>
    </li>
  )
}
