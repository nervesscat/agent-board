import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import type { TFunction } from 'i18next'
import { Copy, FolderGit2, GitBranch, Layers, Paperclip, RefreshCw, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Empty } from '#/components/Empty'
import { ReachBadge } from '#/components/ReachBadge'
import { TrashIcon } from '#/components/TrashIcon'
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
import { Button } from '#/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#/components/ui/card'
import { Progress } from '#/components/ui/progress'
import { Skeleton } from '#/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#/components/ui/table'
import { Tip } from '#/components/ui/tooltip'
import {
  del,
  errorMessage,
  get,
  post,
  type CleanupReport,
  type DeleteItem,
  type DeleteKind,
  type DeleteResult,
  type JobState,
} from '#/lib/api'
import { shared } from '#/i18n'
import { countsOf, deleteResults, keptItems } from '#/lib/cleanupResults'
import { fileSize, shortSha } from '#/lib/format'
import { useStages } from '#/lib/project'
import { stageOf } from '#/lib/stages'

export const Route = createFileRoute('/projects/$id/cleanup')({ component: Cleanup })

type Leftover = CleanupReport['tickets'][number]
type Branch = Leftover['branches'][number]
type Row = { ticket: Leftover; branch: Branch | null }
type Target = { ticket: Leftover; branch: Branch }
/** What the confirmation dialog asks about: one action on the branches listed, nothing else. */
type Pending = { kind: DeleteKind; targets: Target[] }

const GROUPS = [
  { key: 'safe' },
  { key: 'edited' },
  { key: 'unique' },
  { key: 'kept' },
  { key: 'other' },
] as const

const groupOf = (r: Row): (typeof GROUPS)[number]['key'] => {
  if (r.branch?.protected) return 'kept'
  const state = r.branch?.reach?.state
  if (state === 'merged' || state === 'rebased') return 'safe'
  if (state === 'edited' || state === 'unique') return state
  return 'other'
}

/** Each action's words: on a row, for every eligible row at once, and in the dialog. */
const actionsOf = (
  tr: TFunction,
): Record<
  DeleteKind,
  { row: string; all: string; title: (n: number) => string; confirm: (n: number) => string; what: string }
> => ({
  local: {
    row: tr('cleanup.actions.local.row'),
    all: tr('cleanup.actions.local.all'),
    title: (count) => tr('cleanup.actions.local.title', { count }),
    confirm: (count) => tr('cleanup.actions.local.confirm', { count }),
    what: tr('cleanup.actions.local.what'),
  },
  remote: {
    row: tr('cleanup.actions.remote.row'),
    all: tr('cleanup.actions.remote.all'),
    title: (count) => tr('cleanup.actions.remote.title', { count }),
    confirm: (count) => tr('cleanup.actions.remote.confirm', { count }),
    what: tr('cleanup.actions.remote.what'),
  },
  worktrees: {
    row: tr('cleanup.actions.worktrees.row'),
    all: tr('cleanup.actions.worktrees.all'),
    title: (count) => tr('cleanup.actions.worktrees.title', { count }),
    confirm: (count) => tr('cleanup.actions.worktrees.confirm', { count }),
    what: tr('cleanup.actions.worktrees.what'),
  },
})

/** An active preview's state as a phrase: "running on :47101", "building". */
const previewState = (p: { status: string; port: number | null }, tr: TFunction): string =>
  p.status === 'running'
    ? tr('cleanup.previewState.running', { port: p.port })
    : p.status === 'building'
      ? tr('cleanup.previewState.building')
      : p.status === 'starting'
        ? tr('cleanup.previewState.starting')
        : p.status

const itemOf = (kind: DeleteKind, { ticket, branch }: Target): DeleteItem => ({
  ticketId: ticket.id,
  branch: branch.name,
  kind,
  sha: kind === 'remote' ? branch.remote : branch.local,
  ...(kind === 'worktrees' ? { worktrees: branch.worktrees.filter((w) => !w.main).map((w) => w.path) } : {}),
})

const copy = (text: string) =>
  navigator.clipboard.writeText(text).then(
    () => toast.success(shared.t('cleanup.copied')),
    (err) => toast.error(errorMessage(err)),
  )

function Cleanup() {
  const { t: tr } = useTranslation()
  const ACTIONS = actionsOf(tr)
  const { id } = Route.useParams()
  const stages = useStages(id)
  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ['cleanup', id],
    queryFn: () => get<CleanupReport>(`/api/projects/${id}/cleanup`),
  })
  const rows = (data?.tickets ?? []).flatMap<Row>((ticket) =>
    ticket.branches.length
      ? ticket.branches.map((branch) => ({ ticket, branch }))
      : [{ ticket, branch: null }],
  )
  const targets = rows.filter((r): r is Target => !!r.branch)
  const eligible = (kind: DeleteKind) => targets.filter((t) => t.branch.can[kind].ok)
  const remote = targets.filter((r) => r.branch.remote)
  const uploads = data?.uploads
  const [confirmSweep, setConfirmSweep] = useState(false)
  const sweep = useMutation({
    mutationFn: () => del<{ deleted: number; bytes: number; failed: number }>('/api/uploads/unattached'),
    onSuccess: (r) => {
      if (r.failed) toast.error(tr('cleanup.sweep.partial', { count: r.deleted, failed: r.failed }))
      else toast.success(tr('cleanup.sweep.done', { count: r.deleted, size: fileSize(r.bytes) }))
      void refetch()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })

  const [pending, setPending] = useState<Pending | null>(null)
  const [results, setResults] = useState<DeleteResult[] | null>(null)
  const ask = (kind: DeleteKind, chosen: Target[]) => {
    if (chosen.length) setPending({ kind, targets: chosen })
  }
  // The deletion the page is following: the job its request answered, with the items it asked for
  // (the job itself does not carry them), and the poll's latest word on it.
  const [run, setRun] = useState<{ job: JobState; items: DeleteItem[] } | null>(null)
  /** The poll that has seen the job at all: a read from before the request is not a job that vanished. */
  const seenJob = useRef(false)
  /** The job whose end was already told, so a poll of a finished job does not say it twice. */
  const handled = useRef<number | null>(null)
  const queryClient = useQueryClient()
  const remove = useMutation({
    mutationFn: (items: DeleteItem[]) => post<JobState>(`/api/projects/${id}/cleanup/delete`, { items }),
    onSuccess: (job, items) => {
      seenJob.current = false
      setRun({ job, items })
      void queryClient.invalidateQueries({ queryKey: ['jobs', id] })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  // The job's progress: read from the same list the top bar polls, twice a second while it runs, so a
  // short deletion is followed as it lands instead of being read a whole second late.
  const jobs = useQuery({
    queryKey: ['jobs', id],
    queryFn: () => get<JobState[]>(`/api/projects/${id}/jobs`),
    enabled: !!run,
    refetchInterval: (query) =>
      query.state.data?.some((job) => job.id === run?.job.id && job.state === 'running') ? 500 : false,
  })
  const polled = run ? (jobs.data?.find((job) => job.id === run.job.id) ?? null) : null
  const job = polled ?? run?.job ?? null
  const running = job?.state === 'running' ? job : null
  // Only a read of the list that holds the job says it is there: the request's own copy does not, so a
  // list read from before the request cannot be taken for a job that vanished.
  useEffect(() => {
    if (polled) seenJob.current = true
  }, [polled])
  useEffect(() => {
    if (!job || job.state === 'running') return
    if (handled.current === job.id) return
    handled.current = job.id
    // The job keeps what it did as its result: the last deletion, as the route used to answer it.
    if (job.state === 'succeeded') {
      const done = deleteResults(job.result)
      if (done) setResults(done)
      const counts = countsOf(done ?? [])
      if (counts.kept) toast.error(tr('cleanup.toast.keptSee', { counts: counts.text }))
      else toast.success(counts.text)
    } else
      toast.error(
        tr('cleanup.toast.jobFailed', {
          title: job.title,
          reason: job.reason ?? tr('cleanup.noReasonGiven'),
        }),
      )
    void refetch()
  }, [job, refetch, tr])
  useEffect(() => {
    if (!run || !jobs.data || polled || !seenJob.current) return
    // Dismissed from the top bar while it ran: nothing left to follow, and the report is read again.
    seenJob.current = false
    setRun(null)
    void refetch()
  }, [run, polled, jobs.data, refetch])
  const actionsOff = data?.deleteOff ?? null
  /** The items of the deletion being followed: their controls stay off until it ends. */
  const inRun = (branch: string, kind: DeleteKind) =>
    !!running && !!run?.items.some((item) => item.branch === branch && item.kind === kind)
  const busy = (branch: string, kind: DeleteKind) => remove.isPending || inRun(branch, kind)
  const busyAll = (kind: DeleteKind) => eligible(kind).some((t) => busy(t.branch.name, kind))
  const retry = results ? keptItems(results) : []

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{tr('cleanup.title')}</h1>
          <p className="text-sm text-muted-foreground">{tr('cleanup.intro')}</p>
        </div>
        <Button
          className="w-full sm:w-auto"
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <RefreshCw data-icon="inline-start" className={isFetching ? 'animate-spin' : ''} />{' '}
          {tr('cleanup.refresh')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        <Trans i18nKey="cleanup.agentsNote" components={{ tool: <span className="font-mono" /> }} />
      </p>
      {error && <p className="text-sm text-destructive">{errorMessage(error)}</p>}
      {actionsOff && (
        <p className="rounded-lg border bg-muted/40 p-3 text-sm">
          {tr('cleanup.deleteOff', { reason: actionsOff })}
        </p>
      )}
      {data?.repos
        .filter((r) => r.error)
        .map((r) => (
          <p key={r.id} className="text-sm text-destructive">
            {tr('cleanup.repoError', { name: r.name, error: r.error })}
          </p>
        ))}
      {job && (
        <section aria-label={tr('cleanup.progress.label')} className="space-y-1.5 rounded-lg border p-3">
          {job.state === 'running' ? (
            <>
              <Progress
                value={job.done}
                max={Math.max(1, job.total)}
                getAriaValueText={(formatted) =>
                  tr('cleanup.progress.of', { done: formatted, total: job.total })
                }
                className="gap-1.5"
              >
                <span className="text-xs font-medium">{job.title}</span>
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                  {tr('cleanup.progress.of', { done: job.done, total: job.total })}
                </span>
              </Progress>
              <p className="text-xs text-muted-foreground" aria-live="polite">
                {job.step ?? tr('cleanup.progress.starting')}
              </p>
            </>
          ) : (
            <p
              role="status"
              className={
                job.state === 'failed'
                  ? 'text-xs text-destructive'
                  : 'text-xs text-emerald-700 dark:text-emerald-400'
              }
            >
              {tr('cleanup.progress.of', { done: job.done, total: job.total })} ·{' '}
              {job.state === 'failed'
                ? tr('cleanup.progress.failed', { reason: job.reason ?? tr('cleanup.noReasonGiven') })
                : tr('cleanup.progress.succeeded', {
                    counts: countsOf(deleteResults(job.result) ?? []).text,
                  })}
            </p>
          )}
        </section>
      )}
      {results && (
        <Results
          results={results}
          onClose={() => {
            setResults(null)
            setRun(null)
          }}
          onRetry={retry.length ? () => remove.mutate(retry) : null}
        />
      )}
      {isLoading ? (
        <Skeleton className="h-64" />
      ) : !rows.length && !data?.untracked.length ? (
        <Empty>{tr('cleanup.empty')}</Empty>
      ) : (
        <>
          {!actionsOff && (eligible('local').length > 0 || eligible('worktrees').length > 0) && (
            <div className="flex flex-wrap gap-2">
              {(['worktrees', 'local'] as const).map(
                (kind) =>
                  eligible(kind).length > 0 && (
                    <Button
                      key={kind}
                      variant="outline"
                      size="sm"
                      disabled={busyAll(kind)}
                      onClick={() => ask(kind, eligible(kind))}
                    >
                      <TrashIcon data-icon="inline-start" /> {ACTIONS[kind].all} ({eligible(kind).length})
                    </Button>
                  ),
              )}
            </div>
          )}
          {GROUPS.map((g) => {
            const title = tr(`cleanup.group.${g.key}.title`)
            const items = rows.filter((r) => groupOf(r) === g.key)
            if (!items.length) return null
            return (
              <section key={g.key} className="space-y-1.5">
                <h2 className="text-sm font-medium">
                  {title} <span className="text-muted-foreground">· {items.length}</span>
                </h2>
                <p className="text-xs text-muted-foreground">{tr(`cleanup.group.${g.key}.hint`)}</p>
                <div className="space-y-2 md:hidden">
                  {items.map(({ ticket: t, branch: b }) => (
                    <Card key={`${t.id}:${b?.name ?? ''}`} size="sm">
                      <CardHeader>
                        <CardTitle className="flex items-start gap-1.5 text-sm">
                          {t.parentId && <Layers className="mt-0.5 size-3 shrink-0 text-muted-foreground" />}
                          <Link
                            to="/projects/$id/features/$ticketId"
                            params={{ id, ticketId: String(t.id) }}
                            className="min-w-0 hover:underline"
                          >
                            {t.title}
                          </Link>
                        </CardTitle>
                        <CardDescription>
                          #{t.id} · {stages.length ? stageOf(stages, t.status).name : t.status}
                          {t.workspaces.length > 0 &&
                            ` · ${tr('cleanup.workspacesRegistered', { count: t.workspaces.length })}`}
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-2 text-xs">
                        {t.previews.map((p) => (
                          <div key={p.workspaceId} className="text-amber-700 dark:text-amber-400">
                            {tr('cleanup.previewStop', { state: previewState(p, tr) })}
                          </div>
                        ))}
                        <div className="flex flex-wrap items-center gap-2">
                          {b ? (
                            <>
                              <span className="inline-flex items-center gap-1 font-mono">
                                <GitBranch className="size-3" /> {b.name}
                              </span>
                              <span className="font-mono text-muted-foreground">
                                {b.local ? shortSha(b.local) : tr('cleanup.notLocal')}
                              </span>
                              {b.reach && <ReachBadge reach={b.reach} />}
                            </>
                          ) : (
                            <span className="text-muted-foreground">
                              {t.workspaces.map((w) => w.name).join(', ')}
                            </span>
                          )}
                        </div>
                        {b?.worktrees.map((w) => (
                          <Tip
                            key={w.path}
                            content={
                              w.protected
                                ? tr('cleanup.worktreeKept', { path: w.path, reason: w.protected })
                                : w.path
                            }
                          >
                            <div className="flex items-center gap-1 truncate font-mono text-[11px]">
                              <FolderGit2 className="size-3 shrink-0 text-muted-foreground" />
                              <span className="truncate">{w.main ? tr('cleanup.mainCheckout') : w.path}</span>
                            </div>
                          </Tip>
                        ))}
                        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2">
                          <span className="font-mono text-muted-foreground">
                            {b?.remote ? tr('cleanup.originSha', { sha: shortSha(b.remote) }) : ''}
                          </span>
                          <div className="flex flex-wrap items-center gap-1">
                            {b?.restore && (
                              <Tip content={tr('cleanup.copyRestore', { command: b.restore })}>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={tr('cleanup.copyRestore', { command: b.restore })}
                                  onClick={() => copy(b.restore!)}
                                >
                                  <Copy />
                                </Button>
                              </Tip>
                            )}
                            {b && !actionsOff && (
                              <RowActions
                                branch={b}
                                busy={(kind) => busy(b.name, kind)}
                                onAsk={(kind) => ask(kind, [{ ticket: t, branch: b }])}
                              />
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
                <div className="hidden overflow-x-auto rounded-lg border md:block">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{tr('cleanup.col.ticket')}</TableHead>
                        <TableHead>{tr('cleanup.col.branch')}</TableHead>
                        <TableHead>{tr('cleanup.col.reach')}</TableHead>
                        <TableHead>{tr('cleanup.col.worktree')}</TableHead>
                        <TableHead>{tr('cleanup.col.origin')}</TableHead>
                        <TableHead className="w-8" />
                        <TableHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items.map(({ ticket: t, branch: b }) => (
                        <TableRow key={`${t.id}:${b?.name ?? ''}`} data-branch={b?.name}>
                          <TableCell className="max-w-72">
                            <Link
                              to="/projects/$id/features/$ticketId"
                              params={{ id, ticketId: String(t.id) }}
                              className="flex items-center gap-1 truncate font-medium hover:underline"
                            >
                              {t.parentId && <Layers className="size-3 shrink-0 text-muted-foreground" />}
                              <span className="truncate">{t.title}</span>
                            </Link>
                            <div className="text-xs text-muted-foreground">
                              #{t.id} · {stages.length ? stageOf(stages, t.status).name : t.status}
                              {t.workspaces.length > 0 &&
                                ` · ${tr('cleanup.workspacesRegistered', { count: t.workspaces.length })}`}
                            </div>
                            {t.previews.map((p) => (
                              <div key={p.workspaceId} className="text-xs text-amber-700 dark:text-amber-400">
                                {tr('cleanup.previewStop', { state: previewState(p, tr) })}
                              </div>
                            ))}
                          </TableCell>
                          <TableCell>
                            {b ? (
                              <>
                                <div className="inline-flex items-center gap-1 font-mono text-xs">
                                  <GitBranch className="size-3" /> {b.name}
                                </div>
                                <div className="font-mono text-[11px] text-muted-foreground">
                                  {b.local ? shortSha(b.local) : tr('cleanup.notLocal')}
                                </div>
                              </>
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                {t.workspaces.map((w) => w.name).join(', ')}
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            {b?.reach ? (
                              <ReachBadge reach={b.reach} />
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="max-w-64">
                            {b?.worktrees.map((w) => (
                              <Tip
                                key={w.path}
                                content={
                                  w.protected
                                    ? tr('cleanup.worktreeKept', { path: w.path, reason: w.protected })
                                    : w.path
                                }
                              >
                                <div className="flex items-center gap-1 truncate font-mono text-[11px]">
                                  <FolderGit2 className="size-3 shrink-0 text-muted-foreground" />
                                  <span className="truncate">
                                    {w.main ? tr('cleanup.mainCheckout') : w.path}
                                  </span>
                                </div>
                              </Tip>
                            ))}
                          </TableCell>
                          <TableCell className="font-mono text-[11px] text-muted-foreground">
                            {b?.remote ? shortSha(b.remote) : ''}
                          </TableCell>
                          <TableCell>
                            {b?.restore && (
                              <Tip content={tr('cleanup.copyRestore', { command: b.restore })}>
                                <button
                                  type="button"
                                  aria-label={tr('cleanup.copyRestore', { command: b.restore })}
                                  onClick={() => copy(b.restore!)}
                                  className="text-muted-foreground hover:text-foreground"
                                >
                                  <Copy className="size-3.5" />
                                </button>
                              </Tip>
                            )}
                          </TableCell>
                          <TableCell className="max-w-64">
                            {b && !actionsOff && (
                              <RowActions
                                branch={b}
                                busy={(kind) => busy(b.name, kind)}
                                onAsk={(kind) => ask(kind, [{ ticket: t, branch: b }])}
                              />
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </section>
            )
          })}
          {remote.length > 0 && (
            <section className="space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-medium">
                  {tr('cleanup.remote.title')}{' '}
                  <span className="text-muted-foreground">· {remote.length}</span>
                </h2>
                {!actionsOff && eligible('remote').length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busyAll('remote')}
                    onClick={() => ask('remote', eligible('remote'))}
                  >
                    <TrashIcon data-icon="inline-start" /> {ACTIONS.remote.all} ({eligible('remote').length})
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{tr('cleanup.remote.intro')}</p>
              <div className="space-y-2 md:hidden">
                {remote.map(({ ticket: t, branch: b }) => (
                  <Card key={`${t.id}:${b.name}`} size="sm">
                    <CardHeader>
                      <CardTitle className="text-sm">
                        <span className="text-muted-foreground">#{t.id}</span> {t.title}
                      </CardTitle>
                      <CardDescription className="font-mono">
                        {b.name} · {shortSha(b.remote!)}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-2 text-xs">
                      <div>
                        {b.mergedPr ? (
                          <span>{tr('cleanup.prMerged', { number: b.mergedPr.number })}</span>
                        ) : b.remoteReach ? (
                          <ReachBadge reach={b.remoteReach} />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2">
                        {b.restoreRemote ? (
                          <Tip content={tr('cleanup.copyRestore', { command: b.restoreRemote })}>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={tr('cleanup.copyRestore', { command: b.restoreRemote })}
                              onClick={() => copy(b.restoreRemote!)}
                            >
                              <Copy />
                            </Button>
                          </Tip>
                        ) : (
                          <span />
                        )}
                        {!actionsOff &&
                          (b.can.remote.ok ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy(b.name, 'remote')}
                              onClick={() => ask('remote', [{ ticket: t, branch: b }])}
                            >
                              {ACTIONS.remote.row}
                            </Button>
                          ) : (
                            <Kept reason={b.can.remote.reason} />
                          ))}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
              <div className="hidden overflow-x-auto rounded-lg border md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{tr('cleanup.col.ticket')}</TableHead>
                      <TableHead>{tr('cleanup.col.branchOnOrigin')}</TableHead>
                      <TableHead>{tr('cleanup.col.reach')}</TableHead>
                      <TableHead className="w-8" />
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {remote.map(({ ticket: t, branch: b }) => (
                      <TableRow key={`${t.id}:${b.name}`} data-origin-branch={b.name}>
                        <TableCell className="max-w-72 truncate text-xs">
                          #{t.id} {t.title}
                        </TableCell>
                        <TableCell>
                          <div className="font-mono text-xs">{b.name}</div>
                          <div className="font-mono text-[11px] text-muted-foreground">
                            {shortSha(b.remote!)}
                          </div>
                        </TableCell>
                        <TableCell>
                          {b.mergedPr ? (
                            <span className="text-xs">
                              {tr('cleanup.prMerged', { number: b.mergedPr.number })}
                            </span>
                          ) : b.remoteReach ? (
                            <ReachBadge reach={b.remoteReach} />
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {b.restoreRemote && (
                            <Tip content={tr('cleanup.copyRestore', { command: b.restoreRemote })}>
                              <button
                                type="button"
                                aria-label={tr('cleanup.copyRestore', { command: b.restoreRemote })}
                                onClick={() => copy(b.restoreRemote!)}
                                className="text-muted-foreground hover:text-foreground"
                              >
                                <Copy className="size-3.5" />
                              </button>
                            </Tip>
                          )}
                        </TableCell>
                        <TableCell className="max-w-64">
                          {!actionsOff &&
                            (b.can.remote.ok ? (
                              <Button
                                variant="outline"
                                size="xs"
                                disabled={busy(b.name, 'remote')}
                                onClick={() => ask('remote', [{ ticket: t, branch: b }])}
                              >
                                {ACTIONS.remote.row}
                              </Button>
                            ) : (
                              <Kept reason={b.can.remote.reason} />
                            ))}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>
          )}
          {!!data?.untracked.length && (
            <section className="space-y-1.5">
              <h2 className="text-sm font-medium">
                {tr('cleanup.untracked.title')}{' '}
                <span className="text-muted-foreground">· {data.untracked.length}</span>
              </h2>
              <p className="text-xs text-muted-foreground">{tr('cleanup.untracked.intro')}</p>
              <ul className="space-y-1 rounded-lg border p-3">
                {data.untracked.map((w) => (
                  <li key={w.path} className="flex flex-wrap items-center gap-2 font-mono text-xs">
                    <span className="text-muted-foreground">{w.repo}</span>
                    <Tip content={w.path}>
                      <span className="truncate">{w.path}</span>
                    </Tip>
                    <span className="text-muted-foreground">
                      {w.branch ?? (w.head ? tr('cleanup.detached', { sha: shortSha(w.head) }) : '')}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      <ConfirmDelete
        pending={pending}
        onClose={() => setPending(null)}
        onConfirm={(p) => {
          setPending(null)
          remove.mutate(p.targets.map((t) => itemOf(p.kind, t)))
        }}
      />
      {!!uploads?.count && (
        <section className="space-y-1.5">
          <h2 className="text-sm font-medium">
            {tr('cleanup.uploads.title')}{' '}
            <span className="text-muted-foreground">
              · {uploads.count} · {fileSize(uploads.bytes)}
            </span>
          </h2>
          <p className="text-xs text-muted-foreground">
            {uploads.recent
              ? tr('cleanup.uploads.introRecent', { recent: uploads.recent })
              : tr('cleanup.uploads.intro')}
          </p>
          <div className="flex items-center gap-2 rounded-lg border p-3 text-sm">
            <Paperclip className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex-1">
              {tr('cleanup.uploads.summary', { count: uploads.count, size: fileSize(uploads.bytes) })}
            </span>
            <AlertDialog open={confirmSweep} onOpenChange={setConfirmSweep}>
              <AlertDialogTrigger render={<Button variant="outline" size="sm" disabled={sweep.isPending} />}>
                {tr('cleanup.uploads.deleteNow')}
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{tr('cleanup.uploads.confirmTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {tr('cleanup.uploads.confirmText', {
                      count: uploads.count,
                      size: fileSize(uploads.bytes),
                    })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{tr('cleanup.keep')}</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => {
                      setConfirmSweep(false)
                      sweep.mutate()
                    }}
                  >
                    {tr('cleanup.delete')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </section>
      )}
    </div>
  )
}

/** Why something stays: no control, only the reason. */
function Kept({ reason }: { reason: string | null }) {
  const { t: tr } = useTranslation()
  return <div className="text-[11px] text-muted-foreground">{tr('cleanup.keptReason', { reason })}</div>
}

/**
 * What a row may do: remove its worktrees with the branch, or delete the branch alone; when neither,
 * why it stays. `busy` is per kind, since a delete of one kind leaves the other free.
 */
function RowActions({
  branch: b,
  busy,
  onAsk,
}: {
  branch: Branch
  busy: (kind: DeleteKind) => boolean
  onAsk: (kind: DeleteKind) => void
}) {
  const { t: tr } = useTranslation()
  const ACTIONS = actionsOf(tr)
  const hasTrees = b.worktrees.some((w) => !w.main)
  const kinds = (['worktrees', 'local'] as const).filter((k) => b.can[k].ok)
  if (!kinds.length) {
    if (!b.local && !hasTrees) return null
    return <Kept reason={b.protected ?? (hasTrees ? b.can.worktrees.reason : b.can.local.reason)} />
  }
  return (
    <div className="flex flex-wrap gap-1">
      {kinds.map((k) => (
        <Button key={k} variant="outline" size="xs" disabled={busy(k)} onClick={() => onAsk(k)}>
          {ACTIONS[k].row}
        </Button>
      ))}
    </div>
  )
}

/** Every item exactly as it will go; nothing is sent until the action's own button is pressed. */
function ConfirmDelete({
  pending,
  onClose,
  onConfirm,
}: {
  pending: Pending | null
  onClose: () => void
  onConfirm: (p: Pending) => void
}) {
  const { t: tr } = useTranslation()
  const ACTIONS = actionsOf(tr)
  const kind = pending?.kind ?? 'local'
  const all = pending?.targets ?? []
  // A branch edited on the way in differs from its base: listed apart, with the commits that differ.
  const edited = all.filter(
    (t) => (kind === 'remote' ? t.branch.remoteReach : t.branch.reach)?.state === 'edited',
  )
  const plain = all.filter((t) => !edited.includes(t))
  const item = (t: Target) => {
    const b = t.branch
    const sha = kind === 'remote' ? b.remote : b.local
    const reach = kind === 'remote' ? b.remoteReach : b.reach
    const trees = b.worktrees.filter((w) => !w.main)
    return (
      <li key={`${t.ticket.id}:${b.name}`} className="space-y-0.5 rounded-md border p-2">
        <div className="truncate font-medium">
          #{t.ticket.id} {t.ticket.title}
          {t.ticket.repo && (
            <span className="font-normal text-muted-foreground"> · {t.ticket.repo.name}</span>
          )}
        </div>
        <div className="font-mono">
          {b.name} @ {sha ? shortSha(sha) : tr('cleanup.noLocalBranch')}{' '}
          <span className="text-muted-foreground">
            {kind === 'remote' ? tr('cleanup.kind.remote') : tr('cleanup.kind.local')}
          </span>
        </div>
        {kind === 'remote' && b.mergedPr && (
          <div className="text-muted-foreground">
            {tr('cleanup.prWasMerged', { number: b.mergedPr.number })}
          </div>
        )}
        {reach?.state === 'edited' && (
          <ul className="text-muted-foreground">
            {reach.unique.map((c) => (
              <li key={c.sha} className="font-mono">
                {shortSha(c.sha)} {c.subject}
              </li>
            ))}
          </ul>
        )}
        {kind === 'worktrees' &&
          trees.map((w) => (
            <div key={w.path} className="flex items-center gap-1 font-mono">
              <FolderGit2 className="size-3 shrink-0 text-muted-foreground" />{' '}
              {tr('cleanup.worktreePath', { path: w.path })}
              {w.previews.map((p) => (
                <span key={p.workspaceId} className="font-sans text-amber-700 dark:text-amber-400">
                  {' '}
                  · {tr('cleanup.stopsPreview', { state: previewState(p, tr) })}
                </span>
              ))}
              {w.linkedPreviews.map((l) => (
                <span key={`link-${l.workspaceId}`} className="font-sans text-amber-700 dark:text-amber-400">
                  {' '}
                  · {tr('cleanup.stopsServer', { port: l.port })}
                </span>
              ))}
            </div>
          ))}
      </li>
    )
  }
  return (
    <AlertDialog open={!!pending} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent className="data-[size=default]:sm:max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>{ACTIONS[kind].title(all.length)}</AlertDialogTitle>
          <AlertDialogDescription>
            {ACTIONS[kind].what} {tr('cleanup.confirmChecked')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="max-h-[50vh] space-y-3 overflow-y-auto text-xs">
          {plain.length > 0 && (
            <ul aria-label={tr('cleanup.toDelete')} className="space-y-1.5">
              {plain.map(item)}
            </ul>
          )}
          {edited.length > 0 && (
            <div className="space-y-1.5">
              <p className="font-medium">{tr('cleanup.editedOnTheWay')}</p>
              <ul aria-label={tr('cleanup.toDeleteEdited')} className="space-y-1.5">
                {edited.map(item)}
              </ul>
            </div>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{tr('cleanup.keep')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => pending && onConfirm(pending)}>
            {ACTIONS[kind].confirm(all.length)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

const OUTCOME: Record<DeleteResult['outcome'], { className: string; dot: string }> = {
  deleted: {
    className: 'text-emerald-700 dark:text-emerald-400',
    dot: 'bg-emerald-600 dark:bg-emerald-400',
  },
  refused: {
    className: 'text-amber-700 dark:text-amber-400',
    dot: 'bg-amber-600 dark:bg-amber-400',
  },
  failed: { className: 'text-destructive', dot: 'bg-destructive' },
  gone: { className: 'text-muted-foreground', dot: 'bg-muted-foreground/60' },
}

/** What went first, then what stayed and why, then what could not be done, then what was gone already. */
const OUTCOME_ORDER: DeleteResult['outcome'][] = ['deleted', 'refused', 'failed', 'gone']

const kindLabel = (kind: DeleteKind, tr: TFunction) =>
  kind === 'remote'
    ? tr('cleanup.kind.remote')
    : kind === 'worktrees'
      ? tr('cleanup.kind.worktrees')
      : tr('cleanup.kind.local')

/** The next step for the reasons this page can name; null when the reason already says it. */
function advice(reason: string, tr: TFunction): string | null {
  if (/has changes or untracked files: /.test(reason)) return tr('cleanup.advice.changes')
  if (reason.endsWith(' is gone: git worktree prune drops it')) return tr('cleanup.advice.prune')
  if (/ moved since: now at /.test(reason)) return tr('cleanup.advice.moved')
  if (reason.startsWith('checked out in ')) return tr('cleanup.advice.checkedOut')
  return null
}

/** Ticket ids as they read best: a run of three or more as a range, the rest in full. */
function idsText(ids: number[]): string {
  const sorted = [...new Set(ids)].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length; ) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++
    const run = sorted.slice(i, j + 1)
    parts.push(run.length >= 3 ? `#${run[0]}–#${run.at(-1)}` : run.map((id) => `#${id}`).join(', '))
    i = j + 1
  }
  return parts.join(', ')
}

/** One line's worth of a group: a branch and a kind read once, with every item that stayed for it. */
type Bucket = { branch: string; kind: DeleteKind; items: DeleteResult[] }

function bucketsOf(items: DeleteResult[]): Bucket[] {
  const buckets = new Map<string, Bucket>()
  for (const r of items) {
    const key = `${r.branch}\u0000${r.kind}`
    const found = buckets.get(key)
    if (found) found.items.push(r)
    else buckets.set(key, { branch: r.branch, kind: r.kind, items: [r] })
  }
  return [...buckets.values()]
}

/** The items that stayed for the very same reason, so it reads once for all of them. */
function groupsOf(items: DeleteResult[], tr: TFunction) {
  const groups = new Map<string, DeleteResult[]>()
  for (const r of items) {
    const key = r.reason ?? ''
    const found = groups.get(key)
    if (found) found.push(r)
    else groups.set(key, [r])
  }
  return [...groups].map(([key, list]) => {
    const buckets = bucketsOf(list)
    // A message that opens with its own branch says it again below: the branch line keeps the fact.
    const only = buckets.length === 1 ? buckets[0] : null
    const branch = only?.branch ?? ''
    const prefix = branch
      ? [`${branch}: `, `${branch} `, `origin's ${branch}: `, `origin's ${branch} `].find(
          (p) => key.length > p.length && key.startsWith(p),
        )
      : undefined
    return {
      key,
      reason: prefix ? key.slice(prefix.length) : key,
      // The patterns read the message whole: the branch and its space are part of what they look for.
      advice: advice(key, tr),
      buckets,
    }
  })
}

/** What an item took with it, each fact once: the paths removed, the links, and how to put them back. */
function Facts({ items }: { items: DeleteResult[] }) {
  const { t: tr } = useTranslation()
  const removed = [...new Set(items.flatMap((r) => r.removed))]
  const unlinked = [
    ...new Map(items.flatMap((r) => r.unlinked).map((l) => [`${l.path}\u0000${l.target}`, l])).values(),
  ]
  const restore = [...new Set(items.flatMap((r) => r.restore))]
  if (!removed.length && !unlinked.length && !restore.length) return null
  return (
    <div className="space-y-1">
      {removed.map((p) => (
        <p key={p} className="break-all font-mono text-[11px] text-muted-foreground">
          {tr('cleanup.removed', { path: p })}
        </p>
      ))}
      {unlinked.map((l) => (
        <p key={`${l.path}:${l.target}`} className="break-all font-mono text-[11px] text-muted-foreground">
          {tr('cleanup.removedLink', { path: l.path, target: l.target })}
        </p>
      ))}
      {restore.map((cmd) => (
        <div key={cmd} className="flex items-center gap-2 rounded bg-muted/40 px-2 py-1">
          <code className="flex-1 overflow-x-auto font-mono">{cmd}</code>
          <Tip content={tr('cleanup.copyCommand', { command: cmd })}>
            <button
              type="button"
              aria-label={tr('cleanup.copyCommand', { command: cmd })}
              onClick={() => copy(cmd)}
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <Copy className="size-3.5" />
            </button>
          </Tip>
        </div>
      ))}
    </div>
  )
}

/** The items that stayed, each reason once, and under it the branches, tickets and what it took with it. */
function Groups({ outcome, items }: { outcome: DeleteResult['outcome']; items: DeleteResult[] }) {
  const { t: tr } = useTranslation()
  return (
    <ul className="space-y-2">
      {groupsOf(items, tr).map((g) => (
        <li key={g.key} className="space-y-1">
          <div className="space-y-0.5">
            <p className="break-words text-muted-foreground">{g.reason || tr('cleanup.noReasonGiven')}</p>
            {g.advice && <p className="break-words text-muted-foreground/80">→ {g.advice}</p>}
          </div>
          <ul className="space-y-1 pl-2">
            {g.buckets.map((b) => (
              <li key={`${b.branch}:${b.kind}`} data-outcome={outcome} className="space-y-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono">{b.branch}</span>
                  <span className="text-muted-foreground">{kindLabel(b.kind, tr)}</span>
                  <span className="text-muted-foreground">{idsText(b.items.map((r) => r.ticketId))}</span>
                </div>
                <Facts items={b.items} />
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  )
}

/** The items that went, each with what it took and the commands that put it back. */
function Deleted({ items }: { items: DeleteResult[] }) {
  const { t: tr } = useTranslation()
  return (
    <ul className="space-y-1.5">
      {items.map((r, i) => (
        <li key={`${r.ticketId}:${r.branch}:${r.kind}:${i}`} data-outcome={r.outcome} className="space-y-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono">{r.branch}</span>
            <span className="text-muted-foreground">
              {kindLabel(r.kind, tr)} · #{r.ticketId}
            </span>
          </div>
          <Facts items={[r]} />
        </li>
      ))}
    </ul>
  )
}

/**
 * What the last deletion did, each item once, with what was kept and why, and what puts back what went.
 * When something was kept, `onRetry` resends exactly those items (the page's own retry; the top bar's
 * card offers the same for a job it holds).
 */
function Results({
  results,
  onClose,
  onRetry,
}: {
  results: DeleteResult[]
  onClose: () => void
  onRetry: (() => void) | null
}) {
  const { t: tr } = useTranslation()
  const sections = OUTCOME_ORDER.map((outcome) => ({
    outcome,
    items: results.filter((r) => r.outcome === outcome),
  })).filter((s) => s.items.length)
  return (
    <section className="space-y-1.5" aria-label={tr('cleanup.results.label')}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">
          {tr('cleanup.results.title')} <span className="text-muted-foreground">· {results.length}</span>
        </h2>
        <div className="flex items-center gap-1">
          {onRetry && (
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RefreshCw data-icon="inline-start" /> {tr('cleanup.results.retry')}
            </Button>
          )}
          <Tip content={tr('cleanup.results.dismiss')}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={tr('cleanup.results.dismiss')}
              onClick={onClose}
            >
              <X />
            </Button>
          </Tip>
        </div>
      </div>
      <div className="divide-y rounded-lg border px-3 text-xs">
        {sections.map(({ outcome, items }) => (
          <section key={outcome} aria-label={tr(`cleanup.outcome.${outcome}`)} className="space-y-1.5 py-3">
            <h3 className={`flex items-center gap-1.5 font-medium ${OUTCOME[outcome].className}`}>
              <span className={`size-1.5 shrink-0 rounded-full ${OUTCOME[outcome].dot}`} aria-hidden />
              {tr(`cleanup.outcome.${outcome}`)}{' '}
              <span className="font-normal text-muted-foreground">· {items.length}</span>
            </h3>
            {outcome === 'deleted' ? <Deleted items={items} /> : <Groups outcome={outcome} items={items} />}
          </section>
        ))}
      </div>
    </section>
  )
}
