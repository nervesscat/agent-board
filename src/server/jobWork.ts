import { fail, progress, startJob, succeed, type JobState, type StartJobInput } from './jobs'

/**
 * Work under a job of the registry: the job says what is being done and how far it is, the work
 * answers, and the job ends with that answer as its result. Work that throws ends the job failed
 * with the throw's message (nothing invented as a result), and the throw is still handed to whoever
 * waits on it: a caller that answered the job at once (an HTTP route) never waits, so its promise is
 * marked handled here and never goes unhandled.
 */

export interface JobWork<T> {
  /** The running job, as the registry holds it now. */
  job: JobState
  /** What the work answered, or the throw that ended the job failed. */
  results: Promise<T>
}

export function runAsJob<T>(
  input: StartJobInput,
  work: (report: (done: number, step: string) => void) => Promise<T>,
): JobWork<T> {
  const job = startJob(input)
  const results = (async () => {
    try {
      const answer = await work((done, step) => progress(job.id, { done, step }))
      succeed(job.id, { result: answer })
      return answer
    } catch (err) {
      fail(job.id, err instanceof Error ? err.message : String(err))
      // The route answered 202 before the work ran, so nothing else logs this throw.
      console.error(`job ${job.kind} #${job.id} failed:`, err)
      throw err
    }
  })()
  results.catch(() => {})
  return { job, results }
}
