import { Link } from '@tanstack/react-router'
import { useMutation, useQueries, useQuery } from '@tanstack/react-query'
import { AppWindow, ExternalLink, GitBranch, Layers, Loader2, Play, RotateCw, Square } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { openPreview } from '#/components/PreviewWindow'
import { PreviewActions, PreviewBadge } from '#/components/Preview'
import { Badge } from '#/components/ui/badge'
import { Button, buttonVariants } from '#/components/ui/button'
import { Tip } from '#/components/ui/tooltip'
import {
  type AlsoRunning,
  errorMessage,
  get,
  type OrphanedRun,
  post,
  type RunOutcome,
  type RunState,
  type TicketFull,
  type TicketGit,
  type TicketRun,
  type TicketRuns,
  type Workspace,
  type WorkspacePreview,
} from '#/lib/api'
import { clock } from '#/lib/format'
import { previewOpenLinks } from '#/lib/previewLinks'
import { previewBrowserUrl, previewTab } from '#/lib/previewWindow'
import { cn } from '#/lib/utils'
import type { TFunction } from 'i18next'

/**
 * The ticket's Runs card: every run the human configured for each repo the ticket spans (previews,
 * which answer on a port and have a link, and jobs, which do not), grouped by repo, each with its
 * state, the last lines of its log and Start, Stop and Restart; Start all and Stop all for the whole
 * ticket. Runs the ticket started that still go for a repo it no longer spans, and runs of its repos
 * also going from another of its worktrees than the one their row shows, are listed with Stop only. Below them, the links agents set on the ticket's workspaces and its lanes' (`set_preview`),
 * with Open and whether they answer. Hidden while the ticket has neither.
 */

const ACTIVE = new Set(['building', 'starting', 'running'])
export const runActive = (s: RunState | null | undefined) => !!s && ACTIVE.has(s.status)

const STEP = {
  install: 'runsCard.step.install',
  build: 'runsCard.step.build',
  copy: 'runsCard.step.copy',
  server: 'runsCard.step.server',
} as const satisfies Record<NonNullable<RunState['step']>, string>

/** A run's state in a few words: stopped, building with its step, running, failed. */
function statusOf(s: RunState | null, t: TFunction): { label: string; className: string } {
  if (!s) return { label: t('runsCard.status.stopped'), className: 'bg-muted text-muted-foreground' }
  if (s.status === 'building' || s.status === 'starting')
    return {
      label: s.step
        ? t('runsCard.status.buildingStep', { step: t(STEP[s.step]) })
        : t('runsCard.status.building'),
      className: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
    }
  if (s.status === 'running')
    return {
      label: t('runsCard.status.running'),
      className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    }
  if (s.status === 'failed')
    return { label: t('runsCard.status.failed'), className: 'bg-destructive/10 text-destructive' }
  return { label: t('runsCard.status.stopped'), className: 'bg-muted text-muted-foreground' }
}

/**
 * The ticket's runs and the links agents set, as the Runs card shows them; `shown` is false while it
 * has neither and the card is left out. The page asks it too, to know whether the card shows.
 */
export function useTicketRuns(t: TicketFull | undefined, git?: TicketGit) {
  const { data, refetch, isPending } = useQuery({
    queryKey: ['ticket-runs', t?.id],
    queryFn: () => get<TicketRuns>(`/api/tickets/${t!.id}/runs`),
    enabled: !!t,
    refetchInterval: (q) => {
      const states = [
        ...(q.state.data?.repos ?? []).flatMap((r) => r.runs.map((x) => x.state)),
        ...(q.state.data?.orphaned ?? []).map((o) => o.state),
        ...(q.state.data?.alsoRunning ?? []).map((o) => o.state),
      ]
      if (states.some((s) => s?.status === 'building' || s?.status === 'starting')) return 2_000
      return states.some((s) => s?.status === 'running') ? 15_000 : 30_000
    },
  })
  const boardUrls = new Set([
    ...(data?.repos ?? []).flatMap((r) => r.runs.flatMap((x) => (x.state?.url ? [x.state.url] : []))),
    ...[...(data?.orphaned ?? []), ...(data?.alsoRunning ?? [])].flatMap((o) =>
      o.state.url ? [o.state.url] : [],
    ),
  ])
  // The links agents set (a server they started), the lanes' with them; one a run of the board set is
  // that run's link, an orphaned run's or one also running from another workspace too.
  const links = [
    ...(t?.workspaces ?? []).filter((w) => w.previewUrl).map((w) => ({ ...w, lane: null })),
    ...(git?.workspaces ?? []).filter((w) => w.lane && w.previewUrl),
  ].filter((w) => !boardUrls.has(w.previewUrl))
  const anyRuns =
    (data?.repos ?? []).some((r) => r.runs.length) ||
    (data?.orphaned ?? []).length > 0 ||
    (data?.alsoRunning ?? []).length > 0
  return { data, refetch, links, anyRuns, shown: anyRuns || links.length > 0, loading: !!t && isPending }
}

export function RunsCard({ t, git, onChange }: { t: TicketFull; git?: TicketGit; onChange: () => void }) {
  const { t: tr } = useTranslation()
  const { data, refetch, links, anyRuns } = useTicketRuns(t, git)
  const changed = () => {
    void refetch()
    onChange()
  }
  const checks = useQueries({
    queries: links.map((w) => ({
      queryKey: ['preview', w.id, w.previewUrl],
      queryFn: () => get<WorkspacePreview>(`/api/workspaces/${w.id}/preview`),
      refetchInterval: 15_000,
      retry: false,
    })),
  })
  const all = useMutation({
    mutationFn: (what: 'start' | 'stop') =>
      post<{ results: RunOutcome[] }>(`/api/tickets/${t.id}/runs/${what}`),
    onSuccess: ({ results }, what) => {
      const refused = results.filter((r) => !r.ok)
      if (refused.length)
        toast.warning(
          tr('runsCard.notStarted', {
            count: refused.length,
            list: refused.map((r) => `${r.name} (${r.reason})`).join('; '),
          }),
        )
      else if (what === 'stop' && !results.length) toast.info(tr('runsCard.nothingRunning'))
      changed()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const repos = data?.repos ?? []
  const orphaned = data?.orphaned ?? []
  const alsoRunning = data?.alsoRunning ?? []
  if (!anyRuns && !links.length) return null
  const runsList = repos.flatMap((r) => r.runs)
  const canStartAll = runsList.some((x) => !runActive(x.state) && x.cannotStart === null)
  const canStopAll = runsList.some((x) => runActive(x.state)) || orphaned.length > 0 || alsoRunning.length > 0
  return (
    <section className="rounded-lg border p-3" aria-label={tr('runsSettings.title')}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium">{tr('runsSettings.title')}</h2>
        {anyRuns && (
          <div className="ml-auto flex flex-wrap gap-1.5">
            <Tip content={tr('runsCard.startAllTip')}>
              <Button
                variant="outline"
                size="sm"
                disabled={all.isPending || !canStartAll}
                onClick={() => all.mutate('start')}
              >
                <Play /> {tr('runsCard.startAll')}
              </Button>
            </Tip>
            <Tip content={tr('runsCard.stopAllTip')}>
              <Button
                variant="outline"
                size="sm"
                disabled={all.isPending || !canStopAll}
                onClick={() => all.mutate('stop')}
              >
                <Square /> {tr('runsCard.stopAll')}
              </Button>
            </Tip>
          </div>
        )}
      </div>
      {data && anyRuns && (
        <p className="mb-2 text-[11px] text-muted-foreground">
          {tr('runsCard.inUse', { inUse: data.inUse, limit: data.limit })}
        </p>
      )}
      <div className="space-y-4">
        {anyRuns &&
          repos.map((repo) => (
            <div key={repo.repoId} className="space-y-2" role="group" aria-label={repo.name}>
              <h3 className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
                <span className="truncate">{repo.name}</span>
                {repos.length > 1 && repo.primary && (
                  <span className="font-normal text-muted-foreground">{tr('runsCard.primary')}</span>
                )}
              </h3>
              {repo.workspace ? (
                <Tip
                  content={tr('runsCard.workspaceTip', {
                    name: repo.workspace.name,
                    path: repo.workspace.path,
                  })}
                >
                  <span className="inline-flex min-w-0 items-center gap-1 font-mono text-xs text-muted-foreground">
                    <GitBranch className="size-3 shrink-0" />
                    <span className="truncate">{repo.workspace.branch || repo.workspace.name}</span>
                  </span>
                </Tip>
              ) : (
                repo.runs.length > 0 && (
                  <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {repo.workspaceProblem}
                  </p>
                )
              )}
              {repo.runs.length ? (
                <ul className="space-y-3">
                  {repo.runs.map((r) => (
                    <RunRow key={r.id} run={r} ticketId={t.id} ticketTitle={t.title} onChange={changed} />
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">{tr('runsCard.noRuns')}</p>
              )}
            </div>
          ))}
        {orphaned.length > 0 && (
          <div className="space-y-2" role="group" aria-label={tr('runsCard.orphaned')}>
            <h3 className="text-xs font-medium">{tr('runsCard.orphaned')}</h3>
            <ul className="space-y-3">
              {orphaned.map((o) => (
                <OrphanedRow
                  key={`${o.workspace.id}-${o.runId}`}
                  run={o}
                  hint={tr('runsCard.orphanedHint')}
                  onChange={changed}
                />
              ))}
            </ul>
          </div>
        )}
        {alsoRunning.length > 0 && (
          <div className="space-y-2" role="group" aria-label={tr('runsCard.alsoRunning')}>
            <h3 className="text-xs font-medium">{tr('runsCard.alsoRunning')}</h3>
            <ul className="space-y-3">
              {alsoRunning.map((o) => (
                <OrphanedRow
                  key={`${o.workspace.id}-${o.runId}`}
                  run={o}
                  hint={tr('runsCard.alsoRunningHint')}
                  onChange={changed}
                />
              ))}
            </ul>
          </div>
        )}
        {links.length > 0 && (
          <div className="space-y-2" role="group" aria-label={tr('runsCard.links')}>
            {anyRuns && <h3 className="text-xs font-medium">{tr('runsCard.links')}</h3>}
            <ul className="space-y-3">
              {links.map((w, i) => (
                <LinkRow
                  key={w.id}
                  w={w}
                  check={checks[i]?.data}
                  projectId={t.projectId}
                  ticketId={t.id}
                  ticketTitle={t.title}
                  onChange={changed}
                />
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  )
}

function RunRow({
  run,
  ticketId,
  ticketTitle,
  onChange,
}: {
  run: TicketRun
  ticketId: number
  ticketTitle: string
  onChange: () => void
}) {
  const { t } = useTranslation()
  const s = run.state
  const active = runActive(s)
  const action = useMutation({
    mutationFn: (what: 'start' | 'stop' | 'restart') =>
      post(`/api/workspaces/${run.workspaceId}/runs/${run.id}/${what}`),
    onSuccess: onChange,
    onError: (err) => toast.error(errorMessage(err)),
  })
  const status = statusOf(s, t)
  const log = (name: 'build' | 'server', label: string) => (
    <a
      href={`/api/workspaces/${run.workspaceId}/runs/${run.id}/log?name=${name}`}
      target="_blank"
      rel="noreferrer"
      className="underline hover:text-foreground"
    >
      {label}
    </a>
  )
  return (
    <li className="space-y-1.5 text-sm" aria-label={run.name}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{run.name}</span>
        <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal">
          {run.type === 'preview' ? t('runsSettings.typePreview') : t('runsSettings.typeJob')}
        </Badge>
        <span
          className={cn(
            'ml-auto inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px]',
            status.className,
          )}
          data-testid="run-status"
        >
          {(s?.status === 'building' || s?.status === 'starting') && (
            <Loader2 className="size-3 animate-spin" />
          )}
          {status.label}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {s?.status === 'running' && (s.url || s.proxyUrl) && (
          <>
            {(() => {
              const tab = previewTab({
                ticketId,
                title: ticketTitle,
                workspaceId: s.workspaceId,
                runId: run.id,
                label: run.name,
                run: s,
              })
              return tab ? (
                <Tip content={t('runsCard.openTip')}>
                  <Button size="sm" data-testid="run-open" onClick={() => openPreview(tab)}>
                    <AppWindow /> {t('runsCard.open')}
                  </Button>
                </Tip>
              ) : null
            })()}
            {previewBrowserUrl(s) && (
              <a
                href={previewBrowserUrl(s)!}
                target="_blank"
                rel="noreferrer"
                className={buttonVariants({ size: 'sm', variant: 'outline' })}
                data-testid="run-open-browser"
              >
                {t('runsCard.openBrowser')} <ExternalLink />
              </a>
            )}
            {previewOpenLinks(s).through && (
              <a
                href={previewOpenLinks(s).through!}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                data-testid="run-through-board"
              >
                {t('runsCard.throughBoard')}
              </a>
            )}
          </>
        )}
        {!active && (
          <Tip
            content={
              run.cannotStart ??
              (run.type === 'preview' ? t('runsCard.startTipPreview') : t('runsCard.startTipJob'))
            }
          >
            {/* A span keeps the tooltip on a disabled button. */}
            <span>
              <Button
                variant="outline"
                size="sm"
                disabled={action.isPending || run.cannotStart !== null || run.workspaceId === null}
                onClick={() => action.mutate('start')}
              >
                <Play /> {t('runsCard.start')}
              </Button>
            </span>
          </Tip>
        )}
        {active && (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={action.isPending}
              onClick={() => action.mutate('stop')}
            >
              <Square /> {t('runsCard.stop')}
            </Button>
            <Tip content={t('runsCard.restartTip')}>
              <Button
                variant="outline"
                size="sm"
                disabled={action.isPending}
                onClick={() => action.mutate('restart')}
              >
                <RotateCw /> {t('runsCard.restart')}
              </Button>
            </Tip>
          </>
        )}
      </div>
      {!active && run.cannotStart && run.workspaceId !== null && (
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {t('runsCard.cannotStart', { reason: run.cannotStart })}
        </p>
      )}
      {s && (
        <div className="text-xs text-muted-foreground">
          {s.status === 'running' &&
            `${t(s.port ? 'runsCard.onPort' : 'runsCard.runningPlain', { port: s.port })}${s.runningAt ? t('runsCard.since', { time: clock(s.runningAt) }) : ''} · `}
          {s.status === 'failed' && <span className="text-destructive">{s.reason} · </span>}
          {s.status === 'stopped' && s.reason && (
            <>
              {s.reason.charAt(0).toUpperCase() + s.reason.slice(1)}
              {s.stoppedAt && ` (${clock(s.stoppedAt)})`} ·{' '}
            </>
          )}
          {log('build', t('runsCard.buildLog'))} · {log('server', t('runsCard.runLog'))}
        </div>
      )}
      {s && s.tail.length > 0 && (
        <pre
          className="max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap"
          aria-label={t('runsCard.logAria', { name: run.name })}
        >
          {s.tail.join('\n')}
        </pre>
      )}
    </li>
  )
}

/**
 * A run going from one of the ticket's workspaces that no repo row shows: one for a repo the ticket no
 * longer spans, or one also running from another worktree of its repo. It can only be stopped here.
 */
function OrphanedRow({
  run,
  hint,
  onChange,
}: {
  run: OrphanedRun | AlsoRunning
  hint: string
  onChange: () => void
}) {
  const stop = useMutation({
    mutationFn: () => post(`/api/workspaces/${run.workspace.id}/runs/${run.runId}/stop`),
    onSuccess: onChange,
    onError: (err) => toast.error(errorMessage(err)),
  })
  const { t } = useTranslation()
  const status = statusOf(run.state, t)
  return (
    <li className="space-y-1.5 text-sm" aria-label={run.name}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{run.name}</span>
        <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal">
          {run.type === 'preview' ? t('runsSettings.typePreview') : t('runsSettings.typeJob')}
        </Badge>
        <span className="truncate text-xs text-muted-foreground">{run.repoName}</span>
        <span
          className={cn(
            'ml-auto inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px]',
            status.className,
          )}
          data-testid="run-status"
        >
          {status.label}
        </span>
      </div>
      <Button variant="outline" size="sm" disabled={stop.isPending} onClick={() => stop.mutate()}>
        <Square /> {t('runsCard.stop')}
      </Button>
      <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
        {run.reason}: {hint}.
      </p>
    </li>
  )
}

function LinkRow({
  w,
  check,
  projectId,
  ticketId,
  ticketTitle,
  onChange,
}: {
  w: Workspace & { lane: { id: number; title: string } | null }
  check: WorkspacePreview | undefined
  projectId: number
  ticketId: number
  ticketTitle: string
  onChange: () => void
}) {
  const { t } = useTranslation()
  return (
    <li className="space-y-1.5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <PreviewActions
          workspaceId={w.id}
          url={w.previewUrl}
          managed={null}
          cannotStart={undefined}
          onChange={onChange}
          ticketId={ticketId}
          ticketTitle={ticketTitle}
          label={w.name}
        />
        <PreviewBadge url={w.previewUrl} check={check} className="ml-auto" />
      </div>
      <Tip content={w.previewUrl}>
        <div className="truncate font-mono text-xs text-muted-foreground">{w.previewUrl}</div>
      </Tip>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <Tip
          content={
            w.path
              ? t('runsCard.workspaceTip', { name: w.name, path: w.path })
              : t('runsCard.workspaceTipNoPath', { name: w.name })
          }
        >
          <span className="inline-flex min-w-0 items-center gap-1 font-mono">
            <GitBranch className="size-3 shrink-0" /> <span className="truncate">{w.branch || w.name}</span>
          </span>
        </Tip>
        {w.agent && <Badge variant="secondary">{w.agent}</Badge>}
      </div>
      {w.lane && (
        <Link
          to="/projects/$id/features/$ticketId"
          params={{ id: String(projectId), ticketId: String(w.lane.id) }}
          className="inline-flex max-w-full items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <Layers className="size-3 shrink-0" /> <span className="truncate">{w.lane.title}</span>
        </Link>
      )}
    </li>
  )
}
