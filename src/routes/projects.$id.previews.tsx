import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { GitBranch, Layers, RefreshCw, Square } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'

import { Empty } from '#/components/Empty'
import {
  ManagedLine,
  PreviewActions,
  PreviewBadge,
  PreviewLimitEditor,
  previewActive,
} from '#/components/Preview'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '#/components/ui/alert-dialog'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Label } from '#/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { Skeleton } from '#/components/ui/skeleton'
import { errorMessage, get, post, type ProjectPreview, type ProjectPreviews, type StopAll } from '#/lib/api'
import { useProject } from '#/lib/project'
import { recall, remember } from '#/lib/remembered'
import {
  ALL_STAGES,
  countByStage,
  inStageFilter,
  isStageFilter,
  resolveStageFilter,
  stageInSearch,
} from '#/lib/stageFilter'
import { type StageLike, stageBadge, stageOf } from '#/lib/stages'

// ?stage= is the stage whose previews show, `_all` for every stage (none, or a stage the project no
// longer has: the one this browser remembers for the project, else its first review stage). The router
// JSON-parses it, so a key such as `2026` or `true` arrives as a number or a boolean (`stageInSearch`).
export const Route = createFileRoute('/projects/$id/previews')({
  component: Previews,
  validateSearch: z.object({
    stage: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional().catch(undefined),
  }),
})

// The last stage picked is remembered in this browser, per project, for a visit whose URL names none.
const stageKey = (projectId: string) => `previews.stage.${projectId}`

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
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const project = useProject(id)
  const stages = project.data?.stages ?? []
  const inUrl = stageInSearch(stages, search.stage)
  // Polled only while the page is in view, faster while the board builds or starts one, as on a ticket.
  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ['previews', id],
    queryFn: () => get<ProjectPreviews>(`/api/projects/${id}/previews`),
    refetchInterval: (q) =>
      q.state.data?.previews.some((p) => previewActive(p.managed) && p.managed?.status !== 'running')
        ? 2_000
        : 15_000,
  })
  const previews = data?.previews ?? []

  // The stages come with the project, after mount (no loader), and storage is read only after mount
  // (src/lib/remembered.ts): the filter is known once the stages are and, unless the URL names one of
  // them, once the remembered stage is read. Until then a skeleton shows, on the server as in the
  // browser, rather than a list the filter would then change.
  const stagesKnown = !project.isPending
  const storageKey = stageKey(id)
  const stageKeys = [ALL_STAGES, ...stages.map((s) => s.key)]
  const urlNamesStage = isStageFilter(stages, inUrl)
  // The stage remembered for the project read (undefined for none), null until read.
  const [remembered, setRemembered] = useState<{ key: string; value: string | undefined } | null>(null)
  // Read whenever the URL names no stage of the project: on every visit without one, the sidebar's link
  // included while the page stays mounted (a stage may have been picked since, in another tab too), for
  // another project, and once its stages have changed. The stage read goes in the URL, and a stage the
  // project does not have leaves it; the default stays out of it. The URL takes the value just read,
  // not the one this render holds, which can be older.
  useEffect(() => {
    if (!stagesKnown || urlNamesStage) return
    const value = recall(storageKey, stageKeys)
    setRemembered({ key: storageKey, value })
    if (value !== inUrl) navigate({ search: (s) => ({ ...s, stage: value }), replace: true })
  }, [storageKey, stagesKnown, urlNamesStage, inUrl, stageKeys.join()])
  const recalled = remembered?.key === storageKey ? remembered.value : null
  const known = stagesKnown && (urlNamesStage || recalled !== null)
  const filter = resolveStageFilter(stages, inUrl, recalled)
  const pickStage = (key: string) => {
    navigate({ search: (s) => ({ ...s, stage: key }), replace: true })
    remember(storageKey, key)
    // So a visit without a stage in the URL (the sidebar's link) shows it from its first render.
    setRemembered({ key: storageKey, value: key })
  }

  // None until the previews have loaded, rather than a 0 for every stage.
  const counts = data && countByStage(previews.map((p) => p.ticket.status))
  const shown = previews.filter((p) => inStageFilter(filter, p.ticket.status))
  const filterName = filter === ALL_STAGES ? 'All stages' : stageOf(stages, filter).name

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Previews</h1>
          <p className="text-sm text-muted-foreground">
            Every preview of the project's tickets, running or not: links the agents registered, and the
            previews the board builds and runs from their worktrees. Archived tickets are left out.
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2 sm:shrink-0">
          {known ? (
            <StageFilter stages={stages} value={filter} counts={counts} onChange={pickStage} />
          ) : (
            <Skeleton className="h-7 w-48" />
          )}
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw data-icon="inline-start" className={isFetching ? 'animate-spin' : ''} /> Refresh
          </Button>
        </div>
      </div>
      {data && (
        <PreviewsBar
          projectId={id}
          inUse={data.inUse}
          limit={data.limit}
          anyRunning={previews.some((p) => p.running)}
          onChange={() => void refetch()}
        />
      )}
      {error && <p className="text-sm text-destructive">{errorMessage(error)}</p>}
      {isLoading || !known ? (
        <Skeleton className="h-64" />
      ) : !previews.length ? (
        !error && (
          <Empty>
            No previews yet. One shows up here once an agent registers a preview link on a ticket's workspace,
            or the board runs one from its worktree.
          </Empty>
        )
      ) : !shown.length ? (
        <Empty>
          <p>No previews in {filterName}.</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => pickStage(ALL_STAGES)}>
            Show all stages
          </Button>
        </Empty>
      ) : (
        GROUPS.map((g) => {
          const items = shown.filter((p) => p.running === (g.key === 'running'))
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

/**
 * Picks the stage whose previews show, or every stage: the project's stages in board order, each with
 * how many previews it holds. A dropdown, as a project's stages do not fit a phone's width as tabs.
 */
function StageFilter({
  stages,
  value,
  counts,
  onChange,
}: {
  stages: StageLike[]
  value: string
  counts: Map<string, number> | undefined
  onChange: (key: string) => void
}) {
  const options = [{ key: ALL_STAGES, name: 'All stages' }, ...stages]
  // A list, not an object by key: a key such as `constructor` would be read from its prototype.
  const items = options.map((o) => ({ value: o.key, label: o.name }))
  // After a space, so the option reads "Done 2" to a screen reader; the flex layout drops the space.
  const count = (key: string) =>
    counts && (
      <>
        {' '}
        <span className="ml-auto rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">
          {counts.get(key) ?? 0}
        </span>
      </>
    )
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Label htmlFor="previews-stage">Stage</Label>
      <Select value={value} onValueChange={(v) => v && onChange(v)} items={items}>
        <SelectTrigger
          id="previews-stage"
          size="sm"
          className="max-w-60 min-w-36"
          title="Shows the previews of the tickets in this stage"
        >
          <SelectValue>
            {(v: string) => (
              <>
                <span className="truncate">{options.find((o) => o.key === v)?.name ?? v}</span>
                {count(v)}
              </>
            )}
          </SelectValue>
        </SelectTrigger>
        {/* Below the trigger, from the top of the list: laid over it, near the top of the page, the
            list would open scrolled to the stage picked. */}
        <SelectContent alignItemWithTrigger={false} align="start">
          {options.map((o) => (
            <SelectItem key={o.key} value={o.key}>
              <span className="truncate">{o.name}</span>
              {count(o.key)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

/** "Stopped 2 · could not stop 1: …", for the toast after Stop all. */
function stopAllSummary({ stopped, skipped }: StopAll) {
  if (!stopped.length && !skipped.length) return 'Nothing to stop'
  const could = skipped.length
    ? `could not stop ${skipped.length}: ${skipped.map((s) => `#${s.ticketId} ${s.reason}`).join('; ')}`
    : ''
  return [stopped.length || !could ? `Stopped ${stopped.length}` : '', could].filter(Boolean).join(' · ')
}

/**
 * The board-wide use of the preview limit (the previews the board builds or runs, every project's),
 * the limit itself, and Stop all for this project's previews, after a confirmation.
 */
function PreviewsBar({
  projectId,
  inUse,
  limit,
  anyRunning,
  onChange,
}: {
  projectId: string
  inUse: number
  limit: number
  anyRunning: boolean
  onChange: () => void
}) {
  const [confirm, setConfirm] = useState(false)
  const stopAll = useMutation({
    mutationFn: () => post<StopAll>(`/api/projects/${projectId}/previews/stop`),
    onSuccess: (r) => {
      if (r.skipped.length) toast.warning(stopAllSummary(r))
      else toast.success(stopAllSummary(r))
      onChange()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-3 py-2 text-sm">
      <span title="Previews the board builds or runs, in every project, and how many it runs at most at once">
        Board-run previews:{' '}
        <span className="font-medium">
          {inUse} of {limit} in use
        </span>{' '}
        <span className="text-muted-foreground">(board-wide)</span>
      </span>
      <PreviewLimitEditor key={limit} id="previews-limit" limit={limit} />
      {anyRunning && (
        <AlertDialog open={confirm} onOpenChange={setConfirm}>
          <AlertDialogTrigger
            render={
              <Button variant="outline" size="sm" className="sm:ml-auto" disabled={stopAll.isPending} />
            }
          >
            <Square /> Stop all
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Stop every running preview of this project?</AlertDialogTitle>
              <AlertDialogDescription>
                The previews the board runs stop and free their ports. Links stop when the board can tell
                their server runs from the workspace's worktree; the others keep running, and the toast says
                why. The links stay on the page.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep them</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setConfirm(false)
                  stopAll.mutate()
                }}
              >
                Stop all
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
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
  // A link that answers, not a preview the board runs: whether the board may stop the server behind it.
  const link = !previewActive(p.managed) && !!p.check?.running
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
      {link && p.linkStop && (
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          The board will not stop it: {p.linkStop}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 empty:hidden">
        <PreviewActions
          workspaceId={w.id}
          url={p.url}
          managed={p.managed}
          cannotStart={p.cannotStart}
          linkStop={link ? p.linkStop : undefined}
          onChange={onChange}
        />
      </div>
    </li>
  )
}
