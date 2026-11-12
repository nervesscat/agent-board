import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { Bell, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '#/components/ui/popover'
import { Progress } from '#/components/ui/progress'
import { del, errorMessage, get, type JobState } from '#/lib/api'
import { currentProjectId, useProjects } from '#/lib/project'

/**
 * The top bar's notifications: a bell with the number of jobs still running in the project the page is
 * in, and a panel listing them, newest first, each with its progress, its step, or how it ended. While
 * any job runs, the list is polled once a second; once every job has finished it is not polled at all.
 *
 * A job that ends while the panel is closed raises a toast too, so the human hears about it wherever
 * they are. The panel is no place to act on work: a card links to where the job ran, and can be
 * dismissed (or every finished one cleared) once it has been read.
 */
export function NotificationCenter() {
  const projectId = useWatchedProject()
  const queryKey = ['jobs', projectId ?? null] as const
  const { data } = useQuery({
    queryKey,
    queryFn: () => get<JobState[]>(`/api/projects/${projectId}/jobs`),
    enabled: Boolean(projectId),
    // One second while something runs; nothing at all once every job has finished.
    refetchInterval: (query) => (query.state.data?.some((job) => job.state === 'running') ? 1000 : false),
  })

  const jobs = data ?? []
  const running = jobs.filter((job) => job.state === 'running')
  const finished = jobs.filter((job) => job.state !== 'running')

  const [open, setOpen] = useState(false)
  const openRef = useRef(false)
  const changeOpen = (next: boolean) => {
    openRef.current = next
    setOpen(next)
  }

  // The previous poll's states, per watched project, so an end is told apart from a job that was
  // already over. The first read of a project only remembers: a job that finished before the page
  // opened is not news here. A job that first shows up in a later poll already over still counts as
  // an end, since its whole life can fit between two polls while another job keeps the poll going.
  const previous = useRef<{ projectId: string; states: Map<number, JobState['state']> } | null>(null)
  useEffect(() => {
    if (!data || !projectId) return
    const before = previous.current?.projectId === projectId ? previous.current.states : null
    previous.current = { projectId, states: new Map(data.map((job) => [job.id, job.state])) }
    if (!before || openRef.current) return
    for (const job of data) {
      // Absent from the previous poll means it started since: its end is news even when this is the
      // first poll to see it at all.
      const was = before.get(job.id) ?? 'running'
      if (was !== 'running' || job.state === 'running') continue
      if (job.state === 'failed') toast.error(`${job.title} failed`, { description: job.reason ?? undefined })
      else toast.success(`${job.title} finished`)
    }
  }, [data])

  const queryClient = useQueryClient()
  const refresh = () => queryClient.invalidateQueries({ queryKey })
  const dismiss = useMutation({
    mutationFn: (job: JobState) => del(`/api/jobs/${job.id}`),
    onSuccess: refresh,
    onError: (err) => toast.error(errorMessage(err)),
  })
  const clear = useMutation({
    mutationFn: () => Promise.all(finished.map((job) => del(`/api/jobs/${job.id}`))),
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
        {running.length > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-4 font-medium text-primary-foreground tabular-nums">
            {running.length}
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
        {jobs.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing running</p>
        ) : (
          <ul className="max-h-[min(70vh,32rem)] divide-y overflow-y-auto">
            {jobs.map((job) => (
              <JobCard key={job.id} job={job} onDismiss={() => dismiss.mutate(job)} />
            ))}
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

function JobCard({ job, onDismiss }: { job: JobState; onDismiss: () => void }) {
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
        <Button
          variant="ghost"
          size="icon"
          className="-my-1 size-6 shrink-0"
          aria-label={`Dismiss ${job.title}`}
          onClick={onDismiss}
        >
          <X className="size-3.5" />
        </Button>
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
    </li>
  )
}

/** `result.summary` when the caller shaped one, else the result as compact JSON. */
function summaryOf(job: JobState): string | null {
  const result = job.result
  if (result === null || result === undefined) return null
  if (typeof result === 'string') return result
  if (typeof result === 'object' && 'summary' in result) {
    const summary = (result as { summary?: unknown }).summary
    if (typeof summary === 'string') return summary
  }
  try {
    return JSON.stringify(result)
  } catch {
    return null
  }
}

/** How long the job took: `0.8 s`, `12 s`, `2.4 min`. Shown once it has finished. */
function elapsed(job: JobState): string {
  if (!job.finishedAt) return ''
  const seconds = Math.max(0, Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000
  if (seconds < 10) return `${seconds.toFixed(1)} s`
  if (seconds < 60) return `${Math.round(seconds)} s`
  const minutes = seconds / 60
  if (minutes < 10) return `${minutes.toFixed(1)} min`
  if (minutes < 60) return `${Math.round(minutes)} min`
  return `${(minutes / 60).toFixed(1)} h`
}
