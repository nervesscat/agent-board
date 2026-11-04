import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

import { DEFAULT_RUN, type RunConfigInput, runConfigProblem } from '#/lib/runs'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-')))
process.env.DATA_DIR = path.join(tmp, 'data')

let rc: typeof import('./runConfig')
let dbm: typeof import('#/db')
let projectId: number

const checkout = (name: string, pkg?: string) => {
  const dir = path.join(tmp, 'code', name)
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
  if (pkg) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkg }))
  return dir
}
const addRepo = (name: string, pkg?: string) =>
  dbm.db
    .insert(dbm.schema.repos)
    .values({ projectId, name, repoPath: checkout(name, pkg) })
    .returning()
    .get()
const configs = (repoId: number) =>
  dbm.db.select().from(dbm.schema.runConfigs).where(eq(dbm.schema.runConfigs.repoId, repoId)).all()

beforeAll(async () => {
  rc = await import('./runConfig')
  dbm = await import('#/db')
  projectId = dbm.db.insert(dbm.schema.projects).values({ name: 'runs' }).returning().get().id
})

async function call(method: string, pathname: string, body?: unknown, as: 'human' | 'agent' = 'human') {
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  const handle = guard(({ request, actor }: { request: Request; actor: string }) =>
    api.handle(request, actor),
  )
  const request = new Request(`http://localhost${pathname}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      // An agent token: an agent, as opposed to the human's passkey session.
      ...(as === 'agent' ? { authorization: 'Bearer token-of-test' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const res = await handle({ request, actor: as === 'agent' ? 'claude' : 'enrique' })
  return { status: res.status, body: (await res.json()) as any }
}

const job = (over: Partial<RunConfigInput> = {}): RunConfigInput => ({
  name: 'Worker',
  type: 'job',
  install: '',
  build: '',
  start: 'python worker.py',
  env: {},
  port: null,
  healthPath: '',
  copyData: false,
  ...over,
})
const preview = (over: Partial<RunConfigInput> = {}): RunConfigInput => ({
  ...job(),
  name: 'Web',
  type: 'preview',
  start: 'node server.js',
  healthPath: '/',
  ...over,
})

describe('seeding the board’s own preview', () => {
  it('gives a checkout of the board its preview once, and other repos none', () => {
    const board = addRepo('agent-board', 'agent-board')
    const shop = addRepo('shop', 'shop-api')
    const bare = addRepo('bare')
    rc.seedRuns()
    expect(configs(shop.id)).toEqual([])
    expect(configs(bare.id)).toEqual([])
    const [seeded, ...rest] = configs(board.id)
    expect(rest).toEqual([])
    expect(seeded).toMatchObject({
      name: 'Preview',
      type: 'preview',
      install: 'pnpm install --frozen-lockfile --prefer-offline',
      build: 'pnpm build',
      start: 'node .output/server/index.mjs',
      env: {
        BOARD_ENV: 'development',
        AUTH: 'off',
        STORAGE: 'local',
        BOARD_URL: 'http://127.0.0.1:{port}',
      },
      port: null,
      healthPath: '/',
      copyData: true,
    })
    expect(seeded).toMatchObject(DEFAULT_RUN)

    // Seeding again adds nothing, and a run the human deleted is not given back.
    rc.seedRuns()
    expect(configs(board.id)).toHaveLength(1)
    rc.deleteRunConfig(seeded!.id, 'enrique')
    rc.seedRuns()
    expect(rc.listRunConfigs(board.id)).toEqual([])
  })

  it('seeds a checkout of the board the first time its runs are read, too', () => {
    const late = addRepo('agent-board-late', 'agent-board')
    expect(configs(late.id)).toEqual([])
    expect(rc.listRunConfigs(late.id).map((r) => r.name)).toEqual(['Preview'])
  })
})

describe('runConfigProblem', () => {
  it('names the field of every problem', () => {
    const cases: [Partial<RunConfigInput>, RegExp][] = [
      [{ name: '' }, /^name:/],
      [{ name: '   ' }, /^name:/],
      [{ name: 'x'.repeat(61) }, /^name: at most 60/],
      [{ name: 'worker' }, /^name: the repo already has a run named Worker/],
      [{ type: 'cron' as never }, /^type:/],
      [{ start: '' }, /^start:/],
      [{ env: { '1BAD': 'x' } }, /^env: 1BAD is not a variable name/],
      [{ env: { 'A-B': 'x' } }, /^env: A-B is not/],
      [{ env: { PORT: '1' } }, /^env: PORT is set by the board/],
      [{ env: { host: '1' } }, /^env: host is set by the board/],
      [{ env: { PREVIEW_PARENT_PID: '1' } }, /^env: PREVIEW_PARENT_PID/],
      [{ env: { DATA_DIR: 'x' }, copyData: true }, /^env: DATA_DIR is set by the board/],
      [{ port: 47100 }, /^port: auto, or a port from 47101 to 47199/],
      [{ port: 47200 }, /^port:/],
      [{ port: 8080 }, /^port:/],
      [{ healthPath: 'health' }, /^healthPath: a path starting with \//],
    ]
    for (const [over, message] of cases)
      expect(runConfigProblem(preview(over), [{ name: 'Worker' }]), JSON.stringify(over)).toMatch(message)
    expect(runConfigProblem(job({ port: 47150 }))).toMatch(/^port: a job has no port/)
    expect(runConfigProblem(job({ healthPath: '/' }))).toMatch(/^healthPath: a job has no health path/)
    // DATA_DIR is the run's own when it takes no copy of the live data.
    expect(runConfigProblem(preview({ env: { DATA_DIR: './data' } }))).toBeNull()
    expect(runConfigProblem(preview({ port: 47101 }))).toBeNull()
    expect(runConfigProblem(preview({ port: 47199, healthPath: '/api/health' }))).toBeNull()
    expect(runConfigProblem(job())).toBeNull()
    expect(runConfigProblem(DEFAULT_RUN)).toBeNull()
  })
})

describe('over REST', () => {
  it('lists, creates, changes, reorders and deletes a repo’s runs, the human and agents alike', async () => {
    const repo = addRepo('api')
    const created = await call('POST', `/api/repos/${repo.id}/runs`, preview({ env: { API_URL: 'x' } }))
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ repoId: repo.id, name: 'Web', type: 'preview', port: null })
    const worker = (await call('POST', `/api/repos/${repo.id}/runs`, job())).body
    expect(worker).toMatchObject({ name: 'Worker', type: 'job', healthPath: '' })

    // Anyone signed in reads them.
    const listed = await call('GET', `/api/repos/${repo.id}/runs`, undefined, 'agent')
    expect(listed.status).toBe(200)
    expect(listed.body.map((r: { name: string }) => r.name)).toEqual(['Web', 'Worker'])

    // An agent writes them as the human does: its own run and the human's, each write under its name.
    const added = await call('POST', `/api/repos/${repo.id}/runs`, job({ name: 'Agent job' }), 'agent')
    expect(added.status).toBe(201)
    expect(added.body).toMatchObject({ name: 'Agent job', type: 'job', position: 2, createdBy: 'claude' })
    const edited = await call(
      'PATCH',
      `/api/runs/${worker.id}`,
      { start: 'python worker.py --fast' },
      'agent',
    )
    expect(edited.status).toBe(200)
    expect(edited.body).toMatchObject({
      id: worker.id,
      start: 'python worker.py --fast',
      createdBy: 'enrique',
    })
    expect(configs(repo.id).find((r) => r.id === worker.id)!.start).toBe('python worker.py --fast')
    const bad = await call('POST', `/api/repos/${repo.id}/runs`, job({ name: 'agent JOB' }), 'agent')
    expect(bad).toEqual({ status: 400, body: { error: 'name: the repo already has a run named Agent job' } })
    const order = await call(
      'PUT',
      `/api/repos/${repo.id}/runs/order`,
      { ids: [added.body.id, created.body.id, worker.id] },
      'agent',
    )
    expect(order.status).toBe(200)
    expect(order.body.map((r: { name: string }) => r.name)).toEqual(['Agent job', 'Web', 'Worker'])
    expect((await call('DELETE', `/api/runs/${added.body.id}`, undefined, 'agent')).status).toBe(200)
    expect(
      configs(repo.id)
        .map((r) => r.name)
        .sort(),
    ).toEqual(['Web', 'Worker'])
    const byAgent = dbm.db
      .select()
      .from(dbm.schema.activity)
      .where(eq(dbm.schema.activity.actor, 'claude'))
      .all()
    expect(
      byAgent.map(({ projectId: p, kind, refType, refId, text }) => ({ p, kind, refType, refId, text })),
    ).toEqual(
      [
        'added the job run Agent job to repo api',
        'changed the run Worker of repo api',
        'reordered the runs of repo api',
        'removed the run Agent job from repo api',
      ].map((text) => ({ p: projectId, kind: 'project', refType: 'repo', refId: repo.id, text })),
    )

    // A change of type takes the port and health path the new type has.
    const changed = await call('PATCH', `/api/runs/${created.body.id}`, { port: 47150 })
    expect(changed.body).toMatchObject({ port: 47150, healthPath: '/' })
    const toJob = await call('PATCH', `/api/runs/${created.body.id}`, { type: 'job', name: 'Web job' })
    expect(toJob.body).toMatchObject({ type: 'job', port: null, healthPath: '', env: { API_URL: 'x' } })

    const reordered = await call('PUT', `/api/repos/${repo.id}/runs/order`, {
      ids: [worker.id, created.body.id],
    })
    expect(reordered.body.map((r: { name: string }) => r.name)).toEqual(['Worker', 'Web job'])
    expect((await call('PUT', `/api/repos/${repo.id}/runs/order`, { ids: [worker.id] })).status).toBe(400)

    expect((await call('DELETE', `/api/runs/${created.body.id}`)).status).toBe(200)
    expect(configs(repo.id).map((r) => r.name)).toEqual(['Worker'])

    // Every write is in the project's activity.
    const activity = dbm.db
      .select()
      .from(dbm.schema.activity)
      .where(eq(dbm.schema.activity.projectId, projectId))
      .all()
      .map((a) => a.text)
    expect(activity).toEqual(
      expect.arrayContaining([
        'added the preview run Web to repo api',
        'added the job run Worker to repo api',
        'changed the run Web of repo api',
        'changed the run Web (now Web job) of repo api',
        'reordered the runs of repo api',
        'removed the run Web job from repo api',
      ]),
    )
  })

  it('refuses a bad run with a 400 naming the field, and stores nothing', async () => {
    const repo = addRepo('checked')
    await call('POST', `/api/repos/${repo.id}/runs`, job())
    const before = configs(repo.id)
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ ...preview(), name: '' }, /name/],
      [{ ...preview(), name: 'y'.repeat(61) }, /name: at most 60/],
      [{ ...preview(), name: 'WORKER' }, /name: the repo already has a run named Worker/],
      [{ ...preview(), type: 'cron' }, /type/],
      [{ ...preview(), start: '' }, /start/],
      [{ ...preview(), env: { 'NOT OK': '1' } }, /env: NOT OK/],
      [{ ...preview(), env: { PORT: '3000' } }, /env: PORT/],
      [{ ...preview(), port: 47100 }, /port/],
      [{ ...preview(), port: 3000 }, /port/],
      [{ ...preview(), healthPath: 'up' }, /healthPath/],
      [{ ...job({ name: 'Other' }), port: 47120 }, /port: a job has no port/],
      [{ ...job({ name: 'Other' }), healthPath: '/' }, /healthPath: a job/],
    ]
    for (const [body, message] of bad) {
      const res = await call('POST', `/api/repos/${repo.id}/runs`, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.body.error).toMatch(message)
    }
    const patch = await call('PATCH', `/api/runs/${before[0]!.id}`, { port: 47150 })
    expect(patch.status).toBe(400)
    expect(patch.body.error).toMatch(/port: a job has no port/)
    expect(configs(repo.id)).toEqual(before)
  })
})
