import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { JobState } from './jobs'

// The registry keeps nothing on disk, but the API router loads the db: point it at a throwaway
// directory before anything loads it. Test mode, as Playwright drives the board: X-Test-Actor says who
// calls.
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-jobs-')))
const dataDir = path.join(tmp, 'data')
process.env.DATA_DIR = dataDir
process.env.BOARD_ENV = 'test'

const JOB_KEYS = [
  'actor',
  'done',
  'finishedAt',
  'href',
  'id',
  'kind',
  'projectId',
  'reason',
  'result',
  'startedAt',
  'state',
  'step',
  'title',
  'total',
]

let jobs: typeof import('./jobs')
let apiModule: typeof import('./api')
let projects: typeof import('./projects')
let handle: (ctx: { request: Request; actor: string }) => Promise<Response>
let callerOf: typeof import('./auth').callerOf

beforeAll(async () => {
  jobs = await import('./jobs')
  apiModule = await import('./api')
  projects = await import('./projects')
  const { api: guard } = await import('./http')
  handle = guard(({ request, actor }: { request: Request; actor: string }) =>
    apiModule.api.handle(request, actor),
  )
  callerOf = (await import('./auth')).callerOf
})

afterEach(() => vi.useRealTimers())

let projectCount = 0
const newProject = (label: string) =>
  projects.createProject({ name: `${label} ${++projectCount}` }, 'human').id

function start(projectId: number, input: Partial<Parameters<typeof jobs.startJob>[0]> = {}) {
  return jobs.startJob({
    kind: 'cleanup',
    title: 'Delete branches',
    projectId,
    actor: 'enrique',
    total: 12,
    ...input,
  })
}

/** A request as the middleware hands it on, with the actor resolved from the same request. */
async function call(method: string, pathname: string, testActor?: string, body?: unknown) {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (testActor !== undefined) headers['x-test-actor'] = testActor
  if (body !== undefined) headers['content-type'] = 'application/json'
  const request = new Request(`http://localhost${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const caller = await callerOf(request)
  return handle({ request, actor: caller!.name })
}

const listOf = async (projectId: number, actor = 'human:enrique') =>
  (await (await call('GET', `/api/projects/${projectId}/jobs`, actor)).json()) as JobState[]

describe('the job registry', () => {
  it('registers a running job that reads back with every field as plain JSON', () => {
    const projectId = newProject('registered')
    const href = `/projects/${projectId}/cleanup`
    const job = start(projectId, {
      kind: 'cleanup',
      title: 'Delete 12 branches',
      total: 12,
      href,
    })
    expect(Number.isInteger(job.id)).toBe(true)
    expect(job).toEqual({
      id: expect.any(Number),
      kind: 'cleanup',
      title: 'Delete 12 branches',
      projectId,
      actor: 'enrique',
      total: 12,
      done: 0,
      state: 'running',
      step: null,
      reason: null,
      startedAt: expect.any(String),
      finishedAt: null,
      href,
      result: null,
    })
    expect(new Date(job.startedAt).toISOString()).toBe(job.startedAt)
    expect(JSON.parse(JSON.stringify(job))).toEqual(job)
    expect(jobs.listJobs(projectId)).toEqual([job])
  })

  it('applies progress calls in order, clamps done into the total and keeps the last step', () => {
    const projectId = newProject('progress')
    const job = start(projectId, { total: 12 })
    expect(jobs.progress(job.id, { done: 3, step: 'a' })).toMatchObject({ done: 3, step: 'a' })
    expect(jobs.progress(job.id, { done: 5, step: 'b' })).toMatchObject({ done: 5, step: 'b' })
    // The caller is the source of truth: a smaller count moves the bar back.
    expect(jobs.progress(job.id, { done: 2 })).toMatchObject({ done: 2, step: 'b' })
    expect(jobs.progress(job.id, { done: 99 })).toMatchObject({ done: 12, step: 'b' })
    expect(jobs.progress(job.id, { done: -4 })).toMatchObject({ done: 0, step: 'b' })
    // A step over the total stays clamped too.
    expect(jobs.progress(job.id, { done: 40, step: 'c' })).toMatchObject({ done: 12, step: 'c' })
  })

  it('ends a job succeeded with its result kept, every item done and the step cleared', () => {
    const projectId = newProject('succeeded')
    const job = start(projectId, { total: 4 })
    jobs.progress(job.id, { done: 2, step: 'half' })
    const result = { summary: '3 deleted, 1 kept', deleted: [1, 2, 3] }
    const ended = jobs.succeed(job.id, { result })
    expect(ended).toMatchObject({ state: 'succeeded', result, done: 4, step: null, reason: null })
    expect(JSON.parse(JSON.stringify(ended))).toEqual(ended)
    expect(typeof ended!.finishedAt).toBe('string')
    expect(Date.parse(ended!.finishedAt!)).toBeGreaterThanOrEqual(Date.parse(ended!.startedAt))
  })

  it('ends a job failed with its reason verbatim and no result invented', () => {
    const projectId = newProject('failed')
    const job = start(projectId)
    jobs.progress(job.id, { done: 5, step: 'half' })
    const ended = jobs.fail(job.id, 'origin refused the push')
    expect(ended).toMatchObject({
      state: 'failed',
      reason: 'origin refused the push',
      done: 5,
      step: null,
      result: null,
    })
    expect(ended!.finishedAt).toEqual(expect.any(String))
  })

  it('lets the first terminal call win and ignores every call after it', () => {
    const projectId = newProject('terminal')
    const succeeded = start(projectId)
    const failed = start(projectId)
    jobs.fail(succeeded.id, 'first')
    expect(jobs.progress(succeeded.id, { done: 3 })).toMatchObject({ state: 'failed', done: 0 })
    expect(jobs.succeed(succeeded.id, { result: { late: true } })).toMatchObject({
      state: 'failed',
      reason: 'first',
      result: null,
    })
    jobs.succeed(failed.id, { result: { summary: 'done' } })
    expect(jobs.fail(failed.id, 'late')).toMatchObject({
      state: 'succeeded',
      reason: null,
      result: { summary: 'done' },
    })
    expect(jobs.progress(failed.id, { done: 1 })).toMatchObject({ state: 'succeeded', done: 12 })
  })

  it('drops a finished job ten minutes after it ended, and never a running one by age', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T09:00:00.000Z'))
    const projectId = newProject('expiry')
    const finished = start(projectId, { title: 'finished' })
    const ended = jobs.succeed(finished.id)!
    const running = start(projectId, { title: 'running' })

    vi.setSystemTime(new Date(Date.parse(ended.finishedAt!) + jobs.JOB_TTL_MS - 1000))
    expect(jobs.listJobs(projectId).map((job) => job.id)).toEqual([running.id, finished.id])

    vi.setSystemTime(new Date(Date.parse(ended.finishedAt!) + jobs.JOB_TTL_MS + 1000))
    expect(jobs.listJobs(projectId).map((job) => job.id)).toEqual([running.id])

    vi.setSystemTime(new Date(Date.parse(running.startedAt) + 24 * 60 * 60_000))
    expect(jobs.listJobs(projectId).map((job) => job.id)).toEqual([running.id])
  })

  it("never returns another project's jobs", () => {
    const first = newProject('scoped one')
    const second = newProject('scoped two')
    const mine = start(first)
    start(second, { title: 'elsewhere' })
    expect(jobs.listJobs(first).map((job) => job.id)).toEqual([mine.id])
  })

  it('shows the human every job of the project and an agent only its own there', () => {
    const projectId = newProject('actors')
    const other = newProject('actors other')
    const byHuman = start(projectId, { actor: 'enrique' })
    const byClaude = start(projectId, { actor: 'claude' })
    const byCodex = start(projectId, { actor: 'codex' })
    start(other, { actor: 'claude' })

    expect(
      jobs
        .listJobs(projectId)
        .map((job) => job.id)
        .sort(),
    ).toEqual([byHuman.id, byClaude.id, byCodex.id].sort())
    expect(jobs.listJobs(projectId, { agent: 'claude' }).map((job) => job.id)).toEqual([byClaude.id])
    expect(jobs.listJobs(projectId, { agent: 'nobody' })).toEqual([])
    expect(jobs.listJobs(other, { agent: 'claude' })).toHaveLength(1)
  })

  it('keeps at most twenty jobs a project, dropping the oldest finished ones', () => {
    const projectId = newProject('cap')
    const other = newProject('cap other')
    const ids: number[] = []
    for (let i = 0; i < 21; i++) {
      const job = start(projectId, { title: `job ${i}`, total: 1 })
      jobs.succeed(job.id)
      ids.push(job.id)
    }
    const listed = jobs.listJobs(projectId)
    expect(listed).toHaveLength(20)
    expect(listed.map((job) => job.id)).toEqual(ids.slice(1).reverse())
    expect(listed.some((job) => job.id === ids[0])).toBe(false)

    const otherJob = start(other)
    expect(jobs.listJobs(other).map((job) => job.id)).toEqual([otherJob.id])
  })

  it('refuses a new job when every one of the twenty still runs', () => {
    const projectId = newProject('cap running')
    for (let i = 0; i < 20; i++) start(projectId, { title: `running ${i}` })
    expect(() => start(projectId, { title: 'one too many' })).toThrow(
      expect.objectContaining({ status: 409 }),
    )
    expect(jobs.listJobs(projectId)).toHaveLength(20)
  })

  it('changes exactly the job named, and nothing for an unknown id', () => {
    const projectId = newProject('by id')
    const first = start(projectId)
    const second = start(projectId)
    const untouched = JSON.stringify(jobs.listJobs(projectId).find((job) => job.id === second.id))
    jobs.progress(first.id, { done: 1, step: 'one' })
    jobs.succeed(first.id, { result: { ok: true } })
    expect(JSON.stringify(jobs.listJobs(projectId).find((job) => job.id === second.id))).toBe(untouched)

    const count = jobs.listJobs(projectId).length
    expect(jobs.progress(999999, { done: 1 })).toBeNull()
    expect(jobs.succeed(999999)).toBeNull()
    expect(jobs.fail(999999, 'x')).toBeNull()
    expect(jobs.listJobs(projectId)).toHaveLength(count)
  })
})

describe('the jobs routes', () => {
  it('lists the project for the human and an agent only its own jobs there', async () => {
    const projectId = newProject('api list')
    const other = newProject('api list other')
    const humanJob = start(projectId, { actor: 'enrique' })
    const claudeJob = start(projectId, { actor: 'claude' })
    start(other, { actor: 'claude' })

    const asHuman = await call('GET', `/api/projects/${projectId}/jobs`, 'human:enrique')
    expect(asHuman.status).toBe(200)
    expect(((await asHuman.json()) as JobState[]).map((job) => job.id)).toEqual([claudeJob.id, humanJob.id])
    const asClaude = await call('GET', `/api/projects/${projectId}/jobs`, 'agent:claude')
    expect(((await asClaude.json()) as JobState[]).map((job) => job.id)).toEqual([claudeJob.id])
  })

  it('answers 404 for a project that does not exist, and reads the real one as JSON', async () => {
    const projectId = newProject('api project')
    const missing = await call('GET', '/api/projects/999999/jobs', 'human:enrique')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'project not found' })

    const found = await call('GET', `/api/projects/${projectId}/jobs`, 'human:enrique')
    expect(found.status).toBe(200)
    expect(found.headers.get('content-type')).toContain('application/json')
    expect(await found.json()).toEqual([])
  })

  it('starts a slow job through the test route only in test mode', async () => {
    const projectId = newProject('api test route')
    const started = await call('POST', '/api/test/jobs', 'human:enrique', {
      projectId,
      steps: 4,
      ms: 20,
    })
    expect(started.status).toBe(202)
    const job = (await started.json()) as JobState
    expect(job).toMatchObject({
      kind: 'test',
      projectId,
      actor: 'enrique',
      total: 4,
      done: 0,
      state: 'running',
      href: `/projects/${projectId}/cleanup`,
    })
    expect(await listOf(projectId)).toHaveLength(1)

    // Its defaults: six steps, 500 ms apart.
    const defaulted = await call('POST', '/api/test/jobs', 'human:enrique', { projectId })
    expect(((await defaulted.json()) as JobState).total).toBe(6)

    expect(apiModule.testOnlyAllowed('test')).toBe(true)
    expect(apiModule.testOnlyAllowed('development')).toBe(false)
    expect(apiModule.testOnlyAllowed('production')).toBe(false)
  })

  it('dismisses a job the caller may see and answers 404 for the rest', async () => {
    const projectId = newProject('api dismiss')
    const humanJob = start(projectId, { actor: 'enrique' })
    const claudeJob = start(projectId, { actor: 'claude' })

    const refused = await call('DELETE', `/api/jobs/${humanJob.id}`, 'agent:claude')
    expect(refused.status).toBe(404)
    expect(await refused.json()).toEqual({ error: 'job not found' })
    expect((await listOf(projectId)).map((job) => job.id)).toContain(humanJob.id)

    const dismissed = await call('DELETE', `/api/jobs/${claudeJob.id}`, 'agent:claude')
    expect(dismissed.status).toBe(200)
    expect(await dismissed.json()).toEqual({ ok: true })
    // Global: gone for the human too, and from a following read.
    expect((await listOf(projectId)).map((job) => job.id)).not.toContain(claudeJob.id)

    expect((await call('DELETE', '/api/jobs/999999', 'human:enrique')).status).toBe(404)
  })

  it('offers no way to create or move a job from a client', async () => {
    const projectId = newProject('api writes')
    const job = start(projectId)
    for (const [method, pathname] of [
      ['POST', `/api/jobs/${job.id}`],
      ['PATCH', `/api/jobs/${job.id}`],
      ['PUT', `/api/projects/${projectId}/jobs`],
    ]) {
      const res = await call(method, pathname, 'human:enrique', {})
      expect([404, 405], `${method} ${pathname}`).toContain(res.status)
    }
    expect((await listOf(projectId)).find((listed) => listed.id === job.id)).toMatchObject({
      done: 0,
      state: 'running',
    })
  })

  it('hands every entry out with exactly the public shape, nulls included', async () => {
    const projectId = newProject('api shape')
    const running = start(projectId, { title: 'still running' })
    const ended = start(projectId, { title: 'already done' })
    jobs.succeed(ended.id, { result: { summary: 'nothing left' } })
    const list = await listOf(projectId)
    expect(list.map((job) => job.id)).toEqual([ended.id, running.id])
    for (const job of list) expect(Object.keys(job).sort()).toEqual(JOB_KEYS)
    expect(list.find((job) => job.id === running.id)).toMatchObject({
      state: 'running',
      step: null,
      finishedAt: null,
      reason: null,
      result: null,
    })
    expect(list.find((job) => job.id === ended.id)).toMatchObject({
      state: 'succeeded',
      step: null,
      result: { summary: 'nothing left' },
    })
  })

  it('keeps jobs in memory: nothing is written, and a restart starts empty', async () => {
    const projectId = newProject('memory only')
    const before = fs.readdirSync(dataDir, { recursive: true }).sort()
    const job = start(projectId)
    jobs.progress(job.id, { done: 1 })
    jobs.succeed(job.id, { result: { summary: 'done' } })
    expect(jobs.listJobs(projectId)).toHaveLength(1)
    expect(fs.readdirSync(dataDir, { recursive: true }).sort()).toEqual(before)

    // A restart loads the module again: the registry is gone, as the work it reported died with the board.
    vi.resetModules()
    const restarted = await import('./jobs')
    expect(restarted.listJobs(projectId)).toEqual([])
  })
})
