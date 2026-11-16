import { HttpError } from './http'

/**
 * Jobs: long operations the board reports on while they work, so the human can watch them from the
 * top bar instead of a dead button (the Cleanup page's delete is the first caller). A job carries a
 * count of items and its current one, an outcome, a failure reason and a small result the operation
 * shapes, and lives in memory like a run (runs.ts): a restart drops it because the work died with the
 * board too, finished jobs stay long enough to be read, and at most twenty stand per project.
 *
 * Work reports itself: `startJob` registers it, `progress` moves it along, and `succeed` or `fail`
 * ends it. The registry owns the ids. Nobody else writes a job: the API only reads the list and
 * dismisses one.
 */

export type JobStatus = 'running' | 'succeeded' | 'failed'

/** What the API and the top bar are handed: plain JSON, every field there, null where unset. */
export interface JobState {
  id: number
  kind: string
  title: string
  projectId: number
  actor: string
  total: number
  done: number
  state: JobStatus
  /** The item being worked on now. */
  step: string | null
  /** Why it failed. */
  reason: string | null
  startedAt: string
  finishedAt: string | null
  /** Where it happened, for the card's link. */
  href: string | null
  /** The caller-shaped summary of what it did. */
  result: unknown
}

/** How long a finished job stays in the list: ten minutes, swept on the next read. */
export const JOB_TTL_MS = 10 * 60_000
/** The most jobs one project keeps: the oldest finished ones make room for a new one. */
export const MAX_JOBS_PER_PROJECT = 20

const registry = new Map<number, JobState>()
let nextId = 1

/** A copy, so a caller changing what it was handed never changes the registry. */
const view = (job: JobState): JobState => ({ ...job })

const finishedOrder = (a: JobState, b: JobState) =>
  (a.finishedAt ?? '').localeCompare(b.finishedAt ?? '') || a.id - b.id

/** Drops finished jobs older than the TTL. Runs on every read and start; no timer of its own. */
function sweep(now = Date.now()) {
  for (const [id, job] of registry)
    if (job.finishedAt !== null && now - Date.parse(job.finishedAt) >= JOB_TTL_MS) registry.delete(id)
}

export interface StartJobInput {
  kind: string
  title: string
  projectId: number
  actor: string
  total: number
  href?: string | null
}

export interface ListJobsOptions {
  /** An agent's name: it sees only its own jobs there; absent (or null) is the human, who sees all. */
  agent?: string | null
}

/**
 * Registers a running job and returns it. At the project's cap, its oldest finished jobs make room;
 * when every one of them still runs, it refuses with a 409 rather than dropping live work or
 * exceeding the cap.
 */
export function startJob(input: StartJobInput): JobState {
  sweep()
  const mine = [...registry.values()].filter((job) => job.projectId === input.projectId)
  const excess = mine.length - MAX_JOBS_PER_PROJECT + 1
  if (excess > 0) {
    const finished = mine.filter((job) => job.state !== 'running').sort(finishedOrder)
    if (finished.length < excess)
      throw new HttpError(
        409,
        `${mine.length} jobs already run for this project, at most ${MAX_JOBS_PER_PROJECT}: wait for one to finish`,
      )
    for (const job of finished.slice(0, excess)) registry.delete(job.id)
  }
  const job: JobState = {
    id: nextId++,
    kind: input.kind,
    title: input.title,
    projectId: input.projectId,
    actor: input.actor,
    total: Number.isFinite(input.total) ? Math.max(0, Math.trunc(input.total)) : 0,
    done: 0,
    state: 'running',
    step: null,
    reason: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    href: input.href ?? null,
    result: null,
  }
  registry.set(job.id, job)
  return view(job)
}

export interface ProgressInput {
  done?: number
  /** The current item; left out keeps the last one. */
  step?: string | null
}

/**
 * Moves a running job along: `done` is clamped into [0, total] and otherwise taken as given (the
 * caller is the source of truth), and a step left out keeps the previous one. A job that ended, or
 * does not exist, is left as it is.
 */
export function progress(id: number, update: ProgressInput): JobState | null {
  sweep()
  const job = registry.get(id)
  if (!job) return null
  if (job.state === 'running') {
    if (update.done !== undefined && Number.isFinite(update.done))
      job.done = Math.min(Math.max(0, Math.trunc(update.done)), job.total)
    if (update.step !== undefined) job.step = update.step
  }
  return view(job)
}

/** Ends a running job successfully: every item done, the result kept as given, the step cleared. */
export function succeed(id: number, opts: { result?: unknown } = {}): JobState | null {
  sweep()
  const job = registry.get(id)
  if (!job) return null
  if (job.state === 'running') {
    job.state = 'succeeded'
    job.done = job.total
    job.step = null
    job.reason = null
    job.result = opts.result === undefined ? null : opts.result
    job.finishedAt = new Date().toISOString()
  }
  return view(job)
}

/** Ends a running job as failed, with the reason kept verbatim. */
export function fail(id: number, reason: string): JobState | null {
  sweep()
  const job = registry.get(id)
  if (!job) return null
  if (job.state === 'running') {
    job.state = 'failed'
    job.step = null
    job.reason = reason
    job.finishedAt = new Date().toISOString()
  }
  return view(job)
}

/** The project's jobs the caller may see, newest first. An agent's name narrows them to its own. */
export function listJobs(projectId: number, opts: ListJobsOptions = {}): JobState[] {
  sweep()
  const agent = opts.agent ?? null
  return [...registry.values()]
    .filter((job) => job.projectId === projectId && (agent === null || job.actor === agent))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id - a.id)
    .map(view)
}

/**
 * Dismisses one job, for every caller: a finished one is read and gone, a running one is hidden while
 * its work goes on. Returns null for an unknown job, or one the caller may not see (another agent's).
 */
export function dismissJob(id: number, opts: ListJobsOptions = {}): JobState | null {
  sweep()
  const job = registry.get(id)
  if (!job) return null
  const agent = opts.agent ?? null
  if (agent !== null && job.actor !== agent) return null
  registry.delete(id)
  return view(job)
}
