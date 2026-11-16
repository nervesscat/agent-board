import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { Bell, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '#/components/ui/popover'
import { Progress } from '#/components/ui/progress'
import {
  type AgentCard,
  del,
  errorMessage,
  get,
  post,
  type DeleteItem,
  type JobState,
  type NoticeCard,
} from '#/lib/api'
import { CLEANUP_DELETE_JOB, countsOf, deleteResults, keptItems } from '#/lib/cleanupResults'
import { currentProjectId, useProjects } from '#/lib/project'

/**
 * The top bar's notifications: a bell with the number of things the human should see in the project the
 * page is in, and a panel listing them newest first. Three kinds share the list: the board's own jobs
 * (jobs.ts), the tracked requests agents opened because the human asked to watch something, and the
 * important notices agents posted. A tracked request and a notice say which agent made them and trace a
 * tracked one back to the human's own words ("You asked: …"); a notice is marked as its own kind, with
 * no progress and no done or failed line, so it is not read as a finished operation.
 *
 * While anything runs (a job or a tracked card) or a notice waits to be dismissed, the list is polled
 * once a second; with nothing live it is polled every five seconds anyway, so a notice posted to an open
 * page arrives without a reload. A tracked card that ends while the panel is closed, and a notice the
 * first time it appears, raises a toast, so the human hears about it wherever they are. The panel is no
 * place to act on work: a card links to where it happened, and can be dismissed (or every finished thing
 * cleared) once it has been read.
 */
export function NotificationCenter() {
  const projectId = useWatchedProject()

  const jobsKey = ['jobs', projectId ?? null] as const
  const { data: jobData } = useQuery({
    queryKey: jobsKey,
    queryFn: () => get<JobState[]>(`/api/projects/${projectId}/jobs`),
    enabled: Boolean(projectId),
    // One second while something runs; nothing at all once every job has finished.
    refetchInterval: (query) => (query.state.data?.some((job) => job.state === 'running') ? 1000 : false),
  })
  const cardsKey = ['agent-cards', projectId ?? null] as const
  const { data: cardData } = useQuery({
    queryKey: cardsKey,
    queryFn: () => get<AgentCard[]>(`/api/projects/${projectId}/agent-cards`),
    enabled: Boolean(projectId),
    // One second while a tracked card runs or a notice waits; five seconds idle, so a new one reaches an
    // open page without a reload (well inside the half minute the panel promises).
    refetchInterval: (query) =>
      query.state.data?.some((card) => card.kind === 'notice' || card.state === 'running') ? 1000 : 5000,
  })

  const jobs = jobData ?? []
  const cards = cardData ?? []
  const runningJobs = jobs.filter((job) => job.state === 'running')
  const finishedJobs = jobs.filter((job) => job.state !== 'running')
  const runningCards = cards.filter((card) => card.kind === 'tracked' && card.state === 'running')
  const notices = cards.filter((card): card is NoticeCard => card.kind === 'notice')
  const finishedCards = cards.filter((card) => card.kind === 'tracked' && card.state !== 'running')
  // The badge: running jobs, running tracked cards and every notice not yet dismissed.
  const badge = runningJobs.length + runningCards.length + notices.length

  // The two lists in one, newest first by when each started.
  type Entry =
    | { key: string; at: string; kind: 'job'; job: JobState }
    | { key: string; at: string; kind: 'card'; card: AgentCard }
  const entries: Entry[] = [
    ...jobs.map((job): Entry => ({ key: `job-${job.id}`, at: job.startedAt, kind: 'job', job })),
    ...cards.map((card): Entry => ({ key: `card-${card.id}`, at: card.startedAt, kind: 'card', card })),
  ].sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key))

  const [open, setOpen] = useState(false)
  const openRef = useRef(false)
  const changeOpen = (next: boolean) => {
    openRef.current = next
    setOpen(next)
  }

  // The previous poll's job states, per watched project, so an end is told apart from a job that was
  // already over. The first read of a project only remembers: a job that finished before the page opened
  // is not news here. A job that first shows up in a later poll already over still counts as an end,
  // since its whole life can fit between two polls while another job keeps the poll going.
  const previousJobs = useRef<{ projectId: string; states: Map<number, JobState['state']> } | null>(null)
  useEffect(() => {
    if (!jobData || !projectId) return
    const before = previousJobs.current?.projectId === projectId ? previousJobs.current.states : null
    previousJobs.current = { projectId, states: new Map(jobData.map((job) => [job.id, job.state])) }
    if (!before || openRef.current) return
    for (const job of jobData) {
      // Absent from the previous poll means it started since: its end is news even when this is the
      // first poll to see it at all.
      const was = before.get(job.id) ?? 'running'
      if (was !== 'running' || job.state === 'running') continue
      if (job.state === 'failed') toast.error(`${job.title} failed`, { description: job.reason ?? undefined })
      else {
        // The card's own line: a cleanup delete says what it did in counts, not the raw result.
        const summary = summaryOf(job)
        toast.success(`${job.title} finished${summary ? ` · ${summary}` : ''}`)
      }
    }
  }, [jobData])

  // The same for agent cards: a tracked card ending while the panel is closed raises its toast, and a
  // notice raises exactly one, the first time this page sees it. One open at the time it appeared stays
  // quiet, as it was read there.
  const previousCards = useRef<{
    projectId: string
    states: Map<number, 'running' | 'succeeded' | 'failed'>
    notices: Set<number>
  } | null>(null)
  useEffect(() => {
    if (!cardData || !projectId) return
    const before = previousCards.current?.projectId === projectId ? previousCards.current : null
    previousCards.current = {
      projectId,
      states: new Map(
        cardData.filter((card) => card.kind === 'tracked').map((card) => [card.id, card.state]),
      ),
      notices: new Set(cardData.filter((card) => card.kind === 'notice').map((card) => card.id)),
    }
    if (!before || openRef.current) return
    for (const card of cardData) {
      if (card.kind === 'notice') {
        if (!before.notices.has(card.id)) toast(card.title, { description: card.reason })
        continue
      }
      const was = before.states.get(card.id) ?? 'running'
      if (was !== 'running' || card.state === 'running') continue
      if (card.state === 'failed')
        toast.error(`${card.title} failed`, { description: card.reason ?? undefined })
      else toast.success(`${card.title} finished`, { description: card.result ?? undefined })
    }
  }, [cardData])

  const queryClient = useQueryClient()
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: jobsKey })
    void queryClient.invalidateQueries({ queryKey: cardsKey })
  }
  const dismissJob = useMutation({
    mutationFn: (job: JobState) => del(`/api/jobs/${job.id}`),
    onSuccess: refresh,
    onError: (err) => toast.error(errorMessage(err)),
  })
  const dismissCard = useMutation({
    mutationFn: (card: AgentCard) => del(`/api/projects/${projectId}/agent-cards/${card.id}`),
    onSuccess: refresh,
    onError: (err) => toast.error(errorMessage(err)),
  })
  // Clear finished: the board jobs and tracked cards that have ended. A notice stays until dismissed.
  const clear = useMutation({
    mutationFn: () =>
      Promise.all([
        ...finishedJobs.map((job) => del(`/api/jobs/${job.id}`)),
        ...finishedCards.map((card) => del(`/api/projects/${projectId}/agent-cards/${card.id}`)),
      ]),
    onSuccess: refresh,
    onError: (err) => toast.error(errorMessage(err)),
  })
  // A cleanup delete's kept items tried again: the same request as the page's, as a new job.
  const retry = useMutation({
    mutationFn: ({ projectId, items }: { projectId: number; items: DeleteItem[] }) =>
      post<JobState>(`/api/projects/${projectId}/cleanup/delete`, { items }),
    onSuccess: refresh,
    onError: (err) => toast.error(errorMessage(err)),
  })

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger
        render={<Button variant="ghost" size="icon" className="relative shrink-0" />}
        aria-label="Notifications"
      >
        <Bell />
        {badge > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-4 font-medium text-primary-foreground tabular-nums">
            {badge}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)] gap-0 p-0">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <PopoverTitle className="text-sm font-medium">Notifications</PopoverTitle>
          {(finishedJobs.length > 0 || finishedCards.length > 0) && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-7 px-2 text-xs"
              disabled={clear.isPending}
              onClick={() => clear.mutate()}
            >
              Clear finished
            </Button>
          )}
        </div>
        {entries.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing running</p>
        ) : (
          <ul className="max-h-[min(70vh,32rem)] divide-y overflow-y-auto">
            {entries.map((entry) => {
              if (entry.kind === 'job')
                return (
                  <JobCard
                    key={entry.key}
                    job={entry.job}
                    onDismiss={() => dismissJob.mutate(entry.job)}
                    onRetry={(items) => retry.mutate({ projectId: entry.job.projectId, items })}
                    retrying={retry.isPending}
                  />
                )
              const { card } = entry
              if (card.kind === 'notice')
                return (
                  <NoticeCardView key={entry.key} card={card} onDismiss={() => dismissCard.mutate(card)} />
                )
              return (
                <TrackedCardView key={entry.key} card={card} onDismiss={() => dismissCard.mutate(card)} />
              )
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}

/**
 * The project the bar watches: the page's own, else the browser's remembered project, so leaving a
 * project's pages for Home does not silently stop following a job there. Read after mount only.
 */
function useWatchedProject() {
  const { id } = useParams({ strict: false }) as { id?: string }
  const { data: projects } = useProjects()
  const [remembered, setRemembered] = useState<string>()
  useEffect(() => {
    if (id || !projects) return
    setRemembered(currentProjectId(projects.map((project) => project.id)))
  }, [id, projects])
  return id ?? remembered
}

function CardTitle({ card }: { card: AgentCard }) {
  if (!card.href) return <span className="min-w-0 flex-1 truncate text-sm font-medium">{card.title}</span>
  // A board path stays inside the board's router; an absolute URL opens outside it.
  if (card.href.startsWith('/'))
    return (
      <Link to={card.href as never} className="min-w-0 flex-1 truncate text-sm font-medium hover:underline">
        {card.title}
      </Link>
    )
  return (
    <a
      href={card.href}
      target="_blank"
      rel="noreferrer"
      className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
    >
      {card.title}
    </a>
  )
}

function Dismiss({ label, onDismiss }: { label: string; onDismiss: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="-my-1 size-6 shrink-0"
      aria-label={`Dismiss ${label}`}
      onClick={onDismiss}
    >
      <X className="size-3.5" />
    </Button>
  )
}

function JobCard({
  job,
  onDismiss,
  onRetry,
  retrying,
}: {
  job: JobState
  onDismiss: () => void
  onRetry: (items: DeleteItem[]) => void
  retrying: boolean
}) {
  // A cleanup delete that kept something offers the same retry as the page: only those items again.
  const kept =
    job.kind === CLEANUP_DELETE_JOB && job.state === 'succeeded'
      ? keptItems(deleteResults(job.result) ?? [])
      : []
  return (
    <li className="flex flex-col gap-1.5 p-3">
      <div className="flex items-start gap-1">
        {job.href ? (
          <Link
            to={job.href as never}
            className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
          >
            {job.title}
          </Link>
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{job.title}</span>
        )}
        <Dismiss label={job.title} onDismiss={onDismiss} />
      </div>
      <Progress
        value={job.done}
        max={Math.max(1, job.total)}
        getAriaValueText={(formatted) => `${formatted} of ${job.total}`}
        className="gap-1.5"
      >
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {job.done} of {job.total}
        </span>
      </Progress>
      {job.state === 'running' ? (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {job.step ?? 'Starting…'}
        </p>
      ) : (
        <p
          role="status"
          className={
            job.state === 'failed'
              ? 'text-xs text-destructive'
              : 'text-xs text-emerald-700 dark:text-emerald-400'
          }
        >
          {job.state === 'failed'
            ? `Failed · ${elapsed(job)} · ${job.reason ?? 'no reason given'}`
            : `Succeeded · ${elapsed(job)}${summaryOf(job) ? ` · ${summaryOf(job)}` : ''}`}
        </p>
      )}
      {kept.length > 0 && (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={retrying}
          onClick={() => onRetry(kept)}
        >
          Retry kept items
        </Button>
      )}
    </li>
  )
}

/** A tracked request: who asked it, the human's own words, progress if it has a total, and its end. */
function TrackedCardView({
  card,
  onDismiss,
}: {
  card: Extract<AgentCard, { kind: 'tracked' }>
  onDismiss: () => void
}) {
  return (
    <li className="flex flex-col gap-1.5 p-3">
      <div className="flex items-start gap-1">
        <CardTitle card={card} />
        <Dismiss label={card.title} onDismiss={onDismiss} />
      </div>
      <p className="text-xs text-muted-foreground">
        {card.actor} · You asked: {card.request}
      </p>
      {card.total > 0 && (
        <Progress
          value={card.done}
          max={card.total}
          getAriaValueText={(formatted) => `${formatted} of ${card.total}`}
          className="gap-1.5"
        >
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {card.done} of {card.total}
          </span>
        </Progress>
      )}
      {card.state === 'running' ? (
        <>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {card.step ?? 'Starting…'}
          </p>
          {card.stale && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              No update for {since(card.updatedAt)} · it may have stopped
            </p>
          )}
        </>
      ) : (
        <p
          role="status"
          className={
            card.state === 'failed'
              ? 'text-xs text-destructive'
              : 'text-xs text-emerald-700 dark:text-emerald-400'
          }
        >
          {card.state === 'failed'
            ? `Failed · ${card.reason ?? 'no reason given'}`
            : `Succeeded${card.result ? ` · ${card.result}` : ''}`}
        </p>
      )}
    </li>
  )
}

/** An important notice: its own kind, its body and why it could not wait, and no progress at all. */
function NoticeCardView({ card, onDismiss }: { card: NoticeCard; onDismiss: () => void }) {
  return (
    <li className="flex flex-col gap-1.5 p-3">
      <div className="flex items-start gap-1">
        <span className="mt-0.5 shrink-0 rounded-full bg-amber-100 px-1.5 text-[10px] leading-4 font-medium tracking-wide text-amber-900 uppercase dark:bg-amber-950 dark:text-amber-200">
          Notice
        </span>
        <CardTitle card={card} />
        <Dismiss label={card.title} onDismiss={onDismiss} />
      </div>
      <p className="text-xs text-muted-foreground">
        {card.actor} · {card.body}
      </p>
      <p className="text-xs text-muted-foreground">Cannot wait: {card.reason}</p>
    </li>
  )
}

/**
 * How a job's result reads in its card: `result.summary` when the caller shaped one, a cleanup delete's
 * counts (`3 deleted, 1 kept`) from the items it answered, else the result as compact JSON.
 */
function summaryOf(job: JobState): string | null {
  const result = job.result
  if (result === null || result === undefined) return null
  if (typeof result === 'string') return result
  if (typeof result === 'object' && 'summary' in result) {
    const summary = (result as { summary?: unknown }).summary
    if (typeof summary === 'string') return summary
  }
  const items = job.kind === CLEANUP_DELETE_JOB ? deleteResults(result) : null
  if (items) return countsOf(items).text
  try {
    return JSON.stringify(result)
  } catch {
    return null
  }
}

/** How long the job took: `0.8 s`, `12 s`, `2.4 min`. Shown once it has finished. */
function elapsed(job: JobState): string {
  if (!job.finishedAt) return ''
  return duration(Date.parse(job.finishedAt) - Date.parse(job.startedAt))
}

/** How long ago `at` was: `12 s`, `2.4 min`, `7.1 h`, `3 d`. The stale marker says it. */
function since(at: string): string {
  return duration(Date.now() - Date.parse(at))
}

function duration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000
  if (seconds < 10) return `${seconds.toFixed(1)} s`
  if (seconds < 60) return `${Math.round(seconds)} s`
  const minutes = seconds / 60
  if (minutes < 10) return `${minutes.toFixed(1)} min`
  if (minutes < 60) return `${Math.round(minutes)} min`
  const hours = minutes / 60
  if (hours < 10) return `${hours.toFixed(1)} h`
  if (hours < 24) return `${Math.round(hours)} h`
  return `${Math.round(hours / 24)} d`
}
