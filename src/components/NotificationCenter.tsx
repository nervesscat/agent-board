import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { Bell, CircleAlert, Info, TriangleAlert, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Button, buttonVariants } from '#/components/ui/button'
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '#/components/ui/popover'
import { Progress } from '#/components/ui/progress'
import {
  type AlertButton,
  type AlertSeverity,
  del,
  errorMessage,
  type FeedItem,
  get,
  post,
  put,
  type DeleteItem,
  type JobState,
  type NoticeCard,
  type TrackedCard,
} from '#/lib/api'
import { ALERT_GROUP_LABELS, ALERT_GROUPS, snoozeLabel, worstSeverity } from '#/lib/alerts'
import { CLEANUP_DELETE_JOB, countsOf, deleteResults, keptItems } from '#/lib/cleanupResults'
import { currentProjectId, useProjects } from '#/lib/project'

/**
 * The top bar's notifications: a bell with the number of things the human should see in the project the
 * page is in, and a panel listing them newest first. One feed (`/api/projects/:id/notifications`) carries
 * every kind: the board's own jobs (jobs.ts), the tracked requests and important notices agents opened
 * (agentCards.ts), and the alerts the board raises itself (alerts/). A tracked request and a notice say
 * which agent made them and trace a tracked one back to the human's own words ("You asked: …"); a
 * notice is marked as its own kind, with no progress and no done or failed line. An alert has a
 * severity mark, a "New" dot until it has been seen, buttons, a snooze menu, a dismissal and a way to
 * mute its kind in this project.
 *
 * The badge counts what is new, running or a notice, coloured by the worst severity among them. While
 * anything runs or a notice waits the feed is polled once a second; idle, every five seconds, so a new
 * alert reaches an open page without a reload. Opening the panel marks the alerts in it seen once it has
 * been open for a moment. A job or tracked card that ends while the panel is closed, a notice and a new
 * alert each raise one toast, so the human hears about it wherever they are. The panel is no place to
 * act on work: an item links to where it happened, and can be dismissed (or every finished thing
 * cleared) once it has been read.
 */

/** Longer than a glance: how long the panel is open before what it shows counts as seen. */
const SEEN_AFTER_MS = 1000
/** More alerts than this are listed under their group's heading. */
const GROUPED_FROM = 5

export function NotificationCenter() {
  const projectId = useWatchedProject()

  const feedKey = ['notifications', projectId ?? null] as const
  const { data } = useQuery({
    queryKey: feedKey,
    queryFn: () => get<FeedItem[]>(`/api/projects/${projectId}/notifications`),
    enabled: Boolean(projectId),
    // One second while a job or tracked card runs or a notice waits; five seconds idle, so a new one
    // reaches an open page without a reload (well inside the half minute the panel promises).
    refetchInterval: (query) =>
      query.state.data?.some((item) => item.state === 'running' || item.source === 'notice') ? 1000 : 5000,
  })

  const items = data ?? []
  const finished = items.filter(
    (item) => (item.source === 'job' || item.source === 'tracked') && item.state !== 'running',
  )
  const alerts = items.filter((item) => item.source === 'alert')
  // The badge: what is new, what runs and every notice not yet dismissed.
  const counted = items.filter((item) => item.isNew || item.state === 'running' || item.source === 'notice')
  const badge = counted.length
  const badgeSeverity = worstSeverity(counted.map((item) => item.severity))

  const [open, setOpen] = useState(false)
  const openRef = useRef(false)
  const changeOpen = (next: boolean) => {
    openRef.current = next
    setOpen(next)
  }

  // What the previous poll showed, per watched project, so an end or an arrival is told apart from what
  // was already there. The first read of a project only remembers: a job that finished before the page
  // opened is not news here. A job that first shows up in a later poll already over still counts as an
  // end, since its whole life can fit between two polls while another job keeps the poll going.
  const previous = useRef<{ projectId: string; states: Map<string, string>; keys: Set<string> } | null>(null)
  useEffect(() => {
    if (!data || !projectId) return
    const before = previous.current?.projectId === projectId ? previous.current : null
    previous.current = {
      projectId,
      states: new Map(data.filter((item) => item.state).map((item) => [item.key, item.state!])),
      keys: new Set(data.map((item) => item.key)),
    }
    if (!before || openRef.current) return
    for (const item of data) {
      if (item.source === 'notice') {
        if (!before.keys.has(item.key)) toast(item.title, { description: item.card?.reason })
        continue
      }
      if (item.source === 'alert') {
        if (before.keys.has(item.key) || !item.isNew) continue
        const options = { description: item.body }
        if (item.severity === 'problem') toast.error(item.title, options)
        else if (item.severity === 'warning') toast.warning(item.title, options)
        else toast(item.title, options)
        continue
      }
      // Absent from the previous poll means it started since: its end is news even when this is the
      // first poll to see it at all.
      const was = before.states.get(item.key) ?? 'running'
      if (was !== 'running' || item.state === 'running') continue
      if (item.source === 'job' && item.job) {
        const { job } = item
        if (job.state === 'failed')
          toast.error(`${job.title} failed`, { description: job.reason ?? undefined })
        else {
          // The card's own line: a cleanup delete says what it did in counts, not the raw result.
          const summary = summaryOf(job)
          toast.success(`${job.title} finished${summary ? ` · ${summary}` : ''}`)
        }
      } else if (item.card?.kind === 'tracked') {
        const { card } = item
        if (card.state === 'failed')
          toast.error(`${card.title} failed`, { description: card.reason ?? undefined })
        else toast.success(`${card.title} finished`, { description: card.result ?? undefined })
      }
    }
  }, [data, projectId])

  const queryClient = useQueryClient()
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: feedKey })
    // The Cleanup page follows the same jobs.
    void queryClient.invalidateQueries({ queryKey: ['jobs', projectId] })
  }
  const dismissItem = useMutation({
    mutationFn: (item: FeedItem) => dismiss(item, projectId),
    onSuccess: refresh,
    onError: (err) => toast.error(errorMessage(err)),
  })
  // Clear finished: the board jobs and tracked cards that have ended. A notice and an alert stay.
  const clear = useMutation({
    mutationFn: () => Promise.all(finished.map((item) => dismiss(item, projectId))),
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
  const snooze = useMutation({
    mutationFn: ({ item, ms }: { item: FeedItem; ms: number }) =>
      post(`/api/alerts/${item.id}/snooze`, { ms }),
    onSuccess: refresh,
    onError: (err) => toast.error(errorMessage(err)),
  })
  const mute = useMutation({
    mutationFn: (item: FeedItem) =>
      put(`/api/projects/${projectId}/alert-mutes/${item.type}`).then(() => item),
    onSuccess: (item) => {
      toast.success(`Muted "${item.typeLabel ?? item.type}" in this project`)
      void queryClient.invalidateQueries({ queryKey: ['alert-types', projectId] })
      refresh()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const act = useMutation({
    mutationFn: ({ item, button }: { item: FeedItem; button: AlertButton }) =>
      post<{ message: string | null }>(`/api/alerts/${item.id}/actions/${button.id}`),
    onSuccess: (answer) => {
      if (answer.message) toast.success(answer.message)
      refresh()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })

  // Open for a moment: what the panel shows now counts as seen. An alert that arrives while it is open
  // is marked a moment after it shows, in the same way.
  const unseen = alerts
    .filter((item) => item.isNew)
    .map((item) => item.id)
    .join(',')
  useEffect(() => {
    if (!open || !projectId || !unseen) return
    const timer = setTimeout(() => {
      post(`/api/projects/${projectId}/notifications/seen`)
        .then(refresh)
        .catch(() => {})
    }, SEEN_AFTER_MS)
    return () => clearTimeout(timer)
    // refresh only reads the client and the project.
  }, [open, projectId, unseen])

  const grouped = alerts.length > GROUPED_FROM
  const plain = grouped ? items.filter((item) => item.source !== 'alert') : items

  const view = (item: FeedItem) => {
    if (item.source === 'job' && item.job)
      return (
        <JobCard
          key={item.key}
          job={item.job}
          severity={item.severity}
          onDismiss={() => dismissItem.mutate(item)}
          onRetry={(kept) => retry.mutate({ projectId: item.job!.projectId, items: kept })}
          retrying={retry.isPending}
        />
      )
    if (item.source === 'notice' && item.card?.kind === 'notice')
      return (
        <NoticeCardView
          key={item.key}
          card={item.card}
          severity={item.severity}
          onDismiss={() => dismissItem.mutate(item)}
        />
      )
    if (item.source === 'tracked' && item.card?.kind === 'tracked')
      return (
        <TrackedCardView
          key={item.key}
          card={item.card}
          severity={item.severity}
          onDismiss={() => dismissItem.mutate(item)}
        />
      )
    return (
      <AlertCardView
        key={item.key}
        item={item}
        busy={act.isPending || snooze.isPending}
        onDismiss={() => dismissItem.mutate(item)}
        onSnooze={(ms) => snooze.mutate({ item, ms })}
        onMute={() => mute.mutate(item)}
        onAction={(button) => act.mutate({ item, button })}
      />
    )
  }

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger
        render={<Button variant="ghost" size="icon" className="relative shrink-0" />}
        aria-label="Notifications"
      >
        <Bell />
        {badge > 0 && (
          <span
            data-severity={badgeSeverity}
            className={`absolute -top-0.5 -right-0.5 flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-4 font-medium tabular-nums ${BADGE_CLASS[badgeSeverity]}`}
          >
            {badge}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)] gap-0 p-0">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <PopoverTitle className="text-sm font-medium">Notifications</PopoverTitle>
          {finished.length > 0 && (
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
        {items.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing running</p>
        ) : (
          <ul className="max-h-[min(70vh,32rem)] divide-y overflow-y-auto">
            {plain.map(view)}
            {grouped &&
              ALERT_GROUPS.flatMap((group) => {
                const inGroup = alerts.filter((item) => item.group === group)
                if (inGroup.length === 0) return []
                return [
                  <li
                    key={`group-${group}`}
                    role="presentation"
                    className="bg-muted/50 px-3 py-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
                  >
                    {ALERT_GROUP_LABELS[group]}
                  </li>,
                  ...inGroup.map(view),
                ]
              })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}

const BADGE_CLASS: Record<AlertSeverity, string> = {
  info: 'bg-primary text-primary-foreground',
  warning: 'bg-amber-500 text-amber-950 dark:bg-amber-400',
  problem: 'bg-destructive text-white dark:bg-red-500',
}

/** Dismisses one item: an alert stays a row (so a dismissal is remembered), a job or card is deleted. */
function dismiss(item: FeedItem, projectId: string | undefined) {
  if (item.source === 'alert') return post(`/api/alerts/${item.id}/dismiss`)
  if (item.source === 'job') return del(`/api/jobs/${item.id}`)
  return del(`/api/projects/${projectId}/agent-cards/${item.id}`)
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

function CardTitle({ card }: { card: { title: string; href: string | null } }) {
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
  severity,
  onDismiss,
  onRetry,
  retrying,
}: {
  job: JobState
  severity: AlertSeverity
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
        <SeverityMark severity={severity} />
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
  severity,
  onDismiss,
}: {
  card: TrackedCard
  severity: AlertSeverity
  onDismiss: () => void
}) {
  return (
    <li className="flex flex-col gap-1.5 p-3">
      <div className="flex items-start gap-1">
        <SeverityMark severity={severity} />
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
function NoticeCardView({
  card,
  severity,
  onDismiss,
}: {
  card: NoticeCard
  severity: AlertSeverity
  onDismiss: () => void
}) {
  return (
    <li className="flex flex-col gap-1.5 p-3">
      <div className="flex items-start gap-1">
        <SeverityMark severity={severity} />
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

const MARK: Record<AlertSeverity, { Icon: typeof Info; label: string; className: string }> = {
  info: { Icon: Info, label: 'Info', className: 'text-sky-700 dark:text-sky-400' },
  warning: { Icon: TriangleAlert, label: 'Warning', className: 'text-amber-700 dark:text-amber-400' },
  problem: { Icon: CircleAlert, label: 'Problem', className: 'text-red-700 dark:text-red-400' },
}

/** The severity of an item: an icon whose shape, not only its colour, tells the three apart. */
function SeverityMark({ severity }: { severity: AlertSeverity }) {
  const { Icon, label, className } = MARK[severity]
  return <Icon role="img" aria-label={label} className={`mt-0.5 size-3.5 shrink-0 ${className}`} />
}

/** An alert: its severity, a New dot until seen, its words, its buttons, and snooze, dismiss and mute. */
function AlertCardView({
  item,
  busy,
  onDismiss,
  onSnooze,
  onMute,
  onAction,
}: {
  item: FeedItem
  busy: boolean
  onDismiss: () => void
  onSnooze: (ms: number) => void
  onMute: () => void
  onAction: (button: AlertButton) => void
}) {
  const [snoozing, setSnoozing] = useState(false)
  return (
    <li data-severity={item.severity} className="flex flex-col gap-1.5 p-3">
      <div className="flex items-start gap-1">
        <SeverityMark severity={item.severity} />
        {item.isNew && (
          <span
            data-testid="new-dot"
            className="mt-1.5 size-2 shrink-0 rounded-full bg-sky-600 dark:bg-sky-400"
            title="New"
          >
            <span className="sr-only">New</span>
          </span>
        )}
        <span className="min-w-0 flex-1 text-sm font-medium">{item.title}</span>
        {item.dismissible && <Dismiss label={item.title} onDismiss={onDismiss} />}
      </div>
      {item.body && <p className="text-xs text-muted-foreground">{item.body}</p>}
      {item.details && item.details.length > 0 && (
        <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          {item.details.map((line, at) => (
            <p key={at} className="break-words">
              {line}
            </p>
          ))}
        </div>
      )}
      {item.buttons.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {item.buttons.map((button) => (
            <AlertButtonView key={button.id} button={button} busy={busy} onAction={onAction} />
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
        {item.snoozeOptions.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-xs text-muted-foreground"
            aria-expanded={snoozing}
            onClick={() => setSnoozing(!snoozing)}
          >
            Snooze
          </Button>
        )}
        {item.mutable && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-xs text-muted-foreground"
            onClick={onMute}
          >
            Mute this kind in this project
          </Button>
        )}
      </div>
      {snoozing && (
        <div role="group" aria-label="Snooze for" className="flex flex-wrap gap-1.5">
          {item.snoozeOptions.map((ms) => (
            <Button
              key={ms}
              variant="outline"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => onSnooze(ms)}
            >
              {snoozeLabel(ms)}
            </Button>
          ))}
        </div>
      )}
    </li>
  )
}

function AlertButtonView({
  button,
  busy,
  onAction,
}: {
  button: AlertButton
  busy: boolean
  onAction: (button: AlertButton) => void
}) {
  if (button.kind === 'link') {
    const className = buttonVariants({ variant: 'outline', size: 'sm' })
    // A board path stays inside the board's router; an absolute URL opens outside it.
    return button.href.startsWith('/') ? (
      <Link to={button.href as never} className={className}>
        {button.label}
      </Link>
    ) : (
      <a href={button.href} target="_blank" rel="noreferrer" className={className}>
        {button.label}
      </a>
    )
  }
  if (button.kind === 'copy')
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          navigator.clipboard.writeText(button.text).then(
            () => toast.success('Copied'),
            () => toast.error('Could not copy: select the text instead'),
          )
        }
      >
        {button.label}
      </Button>
    )
  return (
    <Button
      variant={button.primary ? 'default' : 'outline'}
      size="sm"
      disabled={busy}
      onClick={() => onAction(button)}
    >
      {button.label}
    </Button>
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
