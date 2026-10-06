import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { MyGhPr } from './git'
import type { PreviewRunner, Proc } from './managedPreview'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-')))
process.env.DATA_DIR = path.join(tmp, 'data')

// gh answers from fixtures: what the PR queue finds, and whether a PR that left it was merged.
let found: MyGhPr[] = []
let merged = new Set<number>()
vi.mock('./git', async (original) => ({
  ...(await original<typeof import('./git')>()),
  listMyPrs: async () => found,
  currentGithubLogin: async () => 'enrique',
  prMerged: async (_repo: string, n: number) => merged.has(n),
}))

let mp: typeof import('./managedPreview')
let features: typeof import('./features')
let dbm: typeof import('#/db')
let projectId: number

// --- a repo on disk: the main checkout, worktrees next to it, and things that are not ---

const repos = path.join(tmp, 'code')
const main = path.join(repos, 'agent-board')
const LOCK = "lockfileVersion: '9.0'\n"

function worktree(dir: string, opts: { of?: string; name?: string; lock?: string } = {}) {
  fs.mkdirSync(path.join(dir, 'node_modules', '.pnpm'), { recursive: true })
  const of = opts.of ?? main
  fs.writeFileSync(
    path.join(dir, '.git'),
    `gitdir: ${path.join(of, '.git', 'worktrees', path.basename(dir))}\n`,
  )
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: opts.name ?? 'agent-board' }))
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), LOCK)
  fs.writeFileSync(path.join(dir, 'node_modules', '.pnpm', 'lock.yaml'), opts.lock ?? LOCK)
  return dir
}

let wtCount = 0
const freshWorktree = () => worktree(path.join(repos, `agent-board-wt${++wtCount}`))

// --- the fake runner: every process is a promise the test controls ---

class FakeRunner implements PreviewRunner {
  calls: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; pid: number }[] = []
  /** Exit code per shell command; 'hang' keeps it running. */
  codes: Record<string, number | 'hang'> = {}
  /** What a server does once spawned: answer, exit with a code, or stay silent. */
  server: 'answer' | 'silent' | number = 'answer'
  busy = new Set<number>()
  up = new Set<string>()
  killed: number[] = []
  private exits = new Map<number, (code: number | null) => void>()
  private urls = new Map<number, string>()
  private pid = 1000

  spawn(
    command: string,
    args: string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv; log: string; shell?: boolean },
  ): Proc {
    const pid = ++this.pid
    this.calls.push({ command, args, cwd: opts.cwd, env: opts.env, pid })
    fs.appendFileSync(opts.log, `${command} line 1\n${command} line 2\n`)
    const exited = new Promise<number | null>((resolve) => this.exits.set(pid, resolve))
    if (opts.shell) {
      const code = this.codes[command] ?? 0
      if (code !== 'hang') setTimeout(() => this.exits.get(pid)!(code), 0)
    } else if (this.server === 'answer') {
      const url = `http://127.0.0.1:${opts.env.PORT}`
      this.up.add(url)
      this.urls.set(pid, url)
    } else if (typeof this.server === 'number') {
      const code = this.server
      setTimeout(() => this.exits.get(pid)!(code), 0)
    }
    return { pid, exited }
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
    return this.up.has(url)
  }
  async copyData(dest: string) {
    fs.mkdirSync(dest, { recursive: true })
    fs.writeFileSync(path.join(dest, 'board.db'), 'a copy')
  }
}

let runner: FakeRunner
beforeAll(async () => {
  fs.mkdirSync(path.join(main, '.git'), { recursive: true })
  fs.writeFileSync(path.join(main, 'package.json'), JSON.stringify({ name: 'agent-board' }))
  mp = await import('./managedPreview')
  features = await import('./features')
  dbm = await import('#/db')
  projectId = dbm.db.insert(dbm.schema.projects).values({ name: 'board' }).returning().get().id
  dbm.db
    .insert(dbm.schema.repos)
    .values({ projectId, name: 'agent-board', repoPath: main, githubRepo: 'acme/agent-board' })
    .run()
})

afterEach(async () => {
  // Nothing outlives a test: stop whatever it left running.
  for (const p of mp.activePreviews()) await mp.stopPreview(p.workspaceId, 'test over', 'test')
  mp.setPreviewRunner(null)
})

function useFake() {
  runner = new FakeRunner()
  mp.setPreviewRunner(runner)
  return runner
}

/** A ticket in progress with a workspace on a fresh worktree. */
function ticketWithWorktree(dir = freshWorktree(), over: { branch?: string; parentId?: number } = {}) {
  const t = features.createTicket(
    projectId,
    { title: 'preview me', status: 'in_progress', branch: over.branch ?? '', parentId: over.parentId },
    'claude',
  )
  const ws = features.addWorkspace(t.id, { name: 'wt', branch: 'feat', path: dir }, 'claude')
  return { t, ws, dir }
}

const status = (id: number) => mp.managedPreview(id)?.status
const wsRow = (id: number) =>
  dbm.db.select().from(dbm.schema.workspaces).where(eq(dbm.schema.workspaces.id, id)).get()

async function startRunning(id: number) {
  mp.startPreview(id, 'claude')
  await vi.waitFor(() => expect(status(id)).toBe('running'))
  return mp.managedPreview(id)!
}

describe('previewTarget', () => {
  const repo = { repoPath: main }
  const boardRoot = worktree(path.join(repos, 'agent-board-self'))
  const target = (p: string) => mp.previewTarget({ path: p }, repo, boardRoot)

  it('runs a worktree of the repo next to its main checkout', () => {
    const dir = worktree(path.join(repos, 'agent-board-feat'))
    expect(target(dir)).toEqual({ ok: true, path: dir })
  })

  it("refuses the main checkout and the board's own folder", () => {
    expect(target(main)).toMatchObject({ ok: false, reason: expect.stringMatching(/main checkout/) })
    expect(target(boardRoot)).toMatchObject({ ok: false, reason: expect.stringMatching(/board's own/) })
  })

  it('refuses paths outside the main checkout’s folder, missing ones and relative ones', () => {
    const away = worktree(path.join(tmp, 'elsewhere', 'agent-board-x'))
    expect(target(away)).toMatchObject({ ok: false, reason: expect.stringMatching(/next to the main/) })
    const inside = worktree(path.join(main, 'nested'))
    expect(target(inside)).toMatchObject({ ok: false, reason: expect.stringMatching(/next to the main/) })
    expect(target(path.join(repos, 'gone'))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/does not exist/),
    })
    expect(target('agent-board-feat')).toMatchObject({ ok: false, reason: expect.stringMatching(/absolute/) })
    expect(mp.previewTarget({ path: '' }, repo)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no local path/),
    })
    expect(mp.previewTarget({ path: main }, null)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no repo/),
    })
  })

  it("refuses a folder that is not one of the repo's worktrees, or not the board", () => {
    const plain = path.join(repos, 'plain')
    fs.mkdirSync(path.join(plain, '.git'), { recursive: true })
    expect(target(plain)).toMatchObject({ ok: false, reason: expect.stringMatching(/not a git worktree/) })
    const other = path.join(repos, 'other-repo')
    fs.mkdirSync(path.join(other, '.git'), { recursive: true })
    const foreign = worktree(path.join(repos, 'other-repo-wt'), { of: other })
    expect(target(foreign)).toMatchObject({ ok: false, reason: expect.stringMatching(/not a git worktree/) })
    const app = worktree(path.join(repos, 'agent-board-app'), { name: 'some-app' })
    expect(target(app)).toMatchObject({ ok: false, reason: expect.stringMatching(/own repo only/) })
  })
})

describe('needsInstall', () => {
  it('installs only when the lockfile changed since the last install', () => {
    const dir = freshWorktree()
    expect(mp.needsInstall(dir)).toBe(false)
    // pnpm keeps LF; a CRLF checkout of the same lockfile is the same.
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), LOCK.replace(/\n/g, '\r\n'))
    expect(mp.needsInstall(dir)).toBe(false)
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), `${LOCK}packages: {}\n`)
    expect(mp.needsInstall(dir)).toBe(true)
    fs.rmSync(path.join(dir, 'node_modules'), { recursive: true })
    expect(mp.needsInstall(dir)).toBe(true)
  })
})

describe('a preview the board runs', () => {
  it('builds, copies the data, starts the server and sets the link; stop kills it and frees the port', async () => {
    const fake = useFake()
    const { ws, dir } = ticketWithWorktree()
    const started = mp.startPreview(ws.id, 'claude')
    expect(started).toMatchObject({ status: 'building', workspaceId: ws.id, path: dir })
    await vi.waitFor(() => expect(status(ws.id)).toBe('running'))

    // No install (the lockfile did not change), the build in the worktree, then the built server.
    expect(fake.calls.map((c) => c.command)).toEqual(['pnpm build', process.execPath])
    expect(fake.calls.every((c) => c.cwd === dir)).toBe(true)
    const server = fake.calls[1]!
    expect(server.args.at(-1)).toBe('.output/server/index.mjs')
    expect(server.env).toMatchObject({
      BOARD_ENV: 'development',
      AUTH: 'off',
      HOST: '127.0.0.1',
      DATA_DIR: path.join(dir, 'data', 'preview'),
      STORAGE: 'local',
    })
    const p = mp.managedPreview(ws.id)!
    expect(p.port).toBeGreaterThanOrEqual(mp.PORTS.from)
    expect(p.port).toBeLessThanOrEqual(mp.PORTS.to)
    expect(server.env.PORT).toBe(String(p.port))
    expect(p.url).toBe(`http://127.0.0.1:${p.port}`)
    expect(wsRow(ws.id)!.previewUrl).toBe(p.url)
    expect(fs.readFileSync(path.join(dir, 'data', 'preview', 'board.db'), 'utf8')).toBe('a copy')
    expect(fs.existsSync(p.logs.build)).toBe(true)

    // The ticket and the preview read show it.
    expect(features.getTicketFull(ws.ticketId).workspaces[0]!.managedPreview).toMatchObject({
      status: 'running',
    })
    const read = await features.workspacePreview(ws.id)
    expect(read).toMatchObject({ url: p.url, managed: { status: 'running' } })

    // One per workspace.
    expect(() => mp.startPreview(ws.id, 'claude')).toThrow(/already running/)

    const stopped = await mp.stopPreview(ws.id, 'stopped by enrique', 'enrique')
    expect(stopped).toMatchObject({ status: 'stopped', reason: 'stopped by enrique', port: null, url: null })
    expect(fake.killed).toContain(server.pid)
    expect(wsRow(ws.id)!.previewUrl).toBe('')
    expect(await fake.answers(p.url!)).toBe(false)
  })

  it('installs first when the lockfile changed', async () => {
    const fake = useFake()
    const { ws } = ticketWithWorktree(worktree(path.join(repos, 'agent-board-newdeps'), { lock: 'old' }))
    await startRunning(ws.id)
    expect(fake.calls.map((c) => c.command).slice(0, 2)).toEqual([
      'pnpm install --frozen-lockfile --prefer-offline',
      'pnpm build',
    ])
  })

  it('fails with the last lines of the build log, and keeps the link it had', async () => {
    const fake = useFake()
    fake.codes['pnpm build'] = 1
    const { ws } = ticketWithWorktree()
    features.setWorkspacePreview(ws.id, 'http://localhost:47188', 'claude')
    mp.startPreview(ws.id, 'claude')
    await vi.waitFor(() => expect(status(ws.id)).toBe('failed'))
    const p = mp.managedPreview(ws.id)!
    expect(p).toMatchObject({ reason: 'pnpm build failed (exit 1)', tailLog: 'build', port: null })
    expect(p.tail).toEqual(['> pnpm build', 'pnpm build line 1', 'pnpm build line 2'])
    expect(mp.previewLog(ws.id, 'build')).toContain('pnpm build line 2')
    expect(wsRow(ws.id)!.previewUrl).toBe('http://localhost:47188')
    // A failed one starts again.
    fake.codes['pnpm build'] = 0
    await startRunning(ws.id)
  })

  it('fails when the server exits, with the server log', async () => {
    const fake = useFake()
    fake.server = 3
    const { ws } = ticketWithWorktree()
    mp.startPreview(ws.id, 'claude')
    await vi.waitFor(() => expect(status(ws.id)).toBe('failed'))
    expect(mp.managedPreview(ws.id)).toMatchObject({
      reason: 'the server exited (exit 3)',
      tailLog: 'server',
    })
    expect(mp.managedPreview(ws.id)!.tail.at(-1)).toMatch(/line 2/)
  })

  it('stops while building: the build is killed and nothing starts after it', async () => {
    const fake = useFake()
    fake.codes['pnpm build'] = 'hang'
    const { ws } = ticketWithWorktree()
    mp.startPreview(ws.id, 'claude')
    await vi.waitFor(() => expect(mp.managedPreview(ws.id)?.step).toBe('build'))
    const build = fake.calls.at(-1)!
    await mp.stopPreview(ws.id, 'stopped by enrique', 'enrique')
    expect(fake.killed).toContain(build.pid)
    await new Promise((r) => setTimeout(r, 20))
    expect(status(ws.id)).toBe('stopped')
    expect(fake.calls.at(-1)).toBe(build)
  })

  it('restarts: stops the running one and builds again', async () => {
    const fake = useFake()
    const { ws } = ticketWithWorktree()
    const first = await startRunning(ws.id)
    const firstServer = fake.calls.at(-1)!
    expect(await mp.restartPreview(ws.id, 'enrique')).toMatchObject({ status: 'building' })
    expect(fake.killed).toContain(firstServer.pid)
    await vi.waitFor(() => expect(status(ws.id)).toBe('running'))
    expect(fake.calls.filter((c) => c.command === 'pnpm build')).toHaveLength(2)
    expect(mp.managedPreview(ws.id)!.startedAt >= first.startedAt).toBe(true)
  })

  it('picks the first port free on both loopbacks and not held by another preview', async () => {
    const fake = useFake()
    fake.busy.add(mp.PORTS.from).add(mp.PORTS.from + 1)
    const a = ticketWithWorktree()
    const b = ticketWithWorktree()
    mp.startPreview(a.ws.id, 'claude')
    mp.startPreview(b.ws.id, 'claude')
    await vi.waitFor(() => expect([status(a.ws.id), status(b.ws.id)]).toEqual(['running', 'running']))
    const ports = [mp.managedPreview(a.ws.id)!.port, mp.managedPreview(b.ws.id)!.port].sort()
    expect(ports).toEqual([mp.PORTS.from + 2, mp.PORTS.from + 3])
  })

  it('fails when no port is free', async () => {
    const fake = useFake()
    for (let port = mp.PORTS.from; port <= mp.PORTS.to; port++) fake.busy.add(port)
    const { ws } = ticketWithWorktree()
    mp.startPreview(ws.id, 'claude')
    await vi.waitFor(() => expect(status(ws.id)).toBe('failed'))
    expect(mp.managedPreview(ws.id)!.reason).toMatch(/no free port between 47101 and 47199/)
  })

  it('runs at most 8 at once, and one per worktree', async () => {
    useFake()
    const running = Array.from({ length: mp.MAX_RUNNING }, () => ticketWithWorktree())
    for (const { ws } of running) mp.startPreview(ws.id, 'claude')
    const ninth = ticketWithWorktree()
    expect(() => mp.startPreview(ninth.ws.id, 'claude')).toThrow(/at most 8/)
    await mp.stopPreview(running[0]!.ws.id, 'make room', 'enrique')
    expect(mp.startPreview(ninth.ws.id, 'claude').status).toBe('building')

    const twin = features.addWorkspace(ninth.t.id, { name: 'twin', path: ninth.dir }, 'claude')
    expect(mp.cannotStart(twin.id)).toMatch(/already runs a preview from/)
  })

  it('refuses closed and archived tickets, and workspaces without a usable path', () => {
    useFake()
    const done = features.createTicket(projectId, { title: 'done', status: 'done' }, 'claude')
    const ws = features.addWorkspace(done.id, { name: 'wt', path: freshWorktree() }, 'claude')
    expect(() => mp.startPreview(ws.id, 'claude')).toThrow(/the ticket is done/)
    const { ws: bare } = ticketWithWorktree('')
    expect(mp.cannotStart(bare.id)).toMatch(/no local path/)
    const { ws: atMain } = ticketWithWorktree(main)
    expect(() => mp.startPreview(atMain.id, 'claude')).toThrow(/main checkout/)
  })
})

describe('stops by itself', () => {
  it('when the ticket moves to done or cancelled', async () => {
    useFake()
    const a = ticketWithWorktree()
    await startRunning(a.ws.id)
    features.updateTicket(a.t.id, { status: 'done' }, 'enrique')
    await vi.waitFor(() => expect(status(a.ws.id)).toBe('stopped'))
    expect(mp.managedPreview(a.ws.id)!.reason).toBe('the ticket moved to Done')
    expect(wsRow(a.ws.id)!.previewUrl).toBe('')

    const b = ticketWithWorktree()
    await startRunning(b.ws.id)
    features.setVerdict(b.t.id, 'disapproved', 'enrique')
    await vi.waitFor(() => expect(status(b.ws.id)).toBe('stopped'))
    expect(mp.managedPreview(b.ws.id)!.reason).toMatch(/moved to Cancelled/)
  })

  it("when the ticket is archived, its lanes' previews too", async () => {
    useFake()
    const parent = ticketWithWorktree()
    const lane = ticketWithWorktree(undefined, { parentId: parent.t.id })
    await startRunning(parent.ws.id)
    await startRunning(lane.ws.id)
    features.updateTicket(parent.t.id, { status: 'done' }, 'enrique')
    await vi.waitFor(() => expect(status(parent.ws.id)).toBe('stopped'))
    // Done stops the ticket's lanes as well.
    await vi.waitFor(() => expect(status(lane.ws.id)).toBe('stopped'))

    const other = ticketWithWorktree()
    const otherLane = ticketWithWorktree(undefined, { parentId: other.t.id })
    await startRunning(otherLane.ws.id)
    // Moved straight to done in the database: only the archive notices.
    dbm.db
      .update(dbm.schema.tickets)
      .set({ status: 'done' })
      .where(eq(dbm.schema.tickets.id, other.t.id))
      .run()
    features.archiveTicket(other.t.id, 'enrique')
    await vi.waitFor(() => expect(status(otherLane.ws.id)).toBe('stopped'))
    expect(mp.managedPreview(otherLane.ws.id)!.reason).toBe('the ticket was archived')
  })

  it('when the workspace or the ticket is removed', async () => {
    const fake = useFake()
    const a = ticketWithWorktree()
    await startRunning(a.ws.id)
    const server = fake.calls.at(-1)!
    features.deleteWorkspace(a.ws.id, 'claude')
    await vi.waitFor(() => expect(fake.killed).toContain(server.pid))
    await vi.waitFor(() => expect(mp.managedPreview(a.ws.id)).toBeNull())

    const b = ticketWithWorktree()
    await startRunning(b.ws.id)
    features.deleteTicket(b.t.id, 'enrique')
    await vi.waitFor(() => expect(mp.managedPreview(b.ws.id)).toBeNull())
    expect(mp.activePreviews().some((p) => p.workspaceId === b.ws.id)).toBe(false)
  })

  // A PR of mine in the queue, as gh lists it.
  const queuePr = (number: number, headRefName: string, mergedAt: string | null = null) =>
    ({
      number,
      title: `pr ${number}`,
      url: `https://github.com/acme/agent-board/pull/${number}`,
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
      requested: false,
      assigned: true,
    }) satisfies MyGhPr

  it("when the ticket's PR is merged (not when it is only closed)", async () => {
    useFake()
    const mergedOne = ticketWithWorktree(undefined, { branch: 'feat/merged' })
    const closedOne = ticketWithWorktree(undefined, { branch: 'feat/closed' })
    await startRunning(mergedOne.ws.id)
    await startRunning(closedOne.ws.id)
    const prs = await import('./prs')
    found = [queuePr(41, 'feat/merged'), queuePr(42, 'feat/closed')]
    await prs.refreshPrs(projectId)
    // Both leave the queue; GitHub says only 41 was merged.
    found = []
    merged = new Set([41])
    await prs.refreshPrs(projectId)
    await vi.waitFor(() => expect(status(mergedOne.ws.id)).toBe('stopped'))
    expect(mp.managedPreview(mergedOne.ws.id)!.reason).toBe('PR #41 was merged')
    expect(status(closedOne.ws.id)).toBe('running')
  })

  it("when the merged searches find the ticket's PR merged, without asking GitHub again", async () => {
    useFake()
    const t = ticketWithWorktree(undefined, { branch: 'feat/landed' })
    await startRunning(t.ws.id)
    const prs = await import('./prs')
    found = [queuePr(43, 'feat/landed')]
    await prs.refreshPrs(projectId)
    // Found merged by the searches; `gh pr view` would not say so.
    found = [queuePr(43, 'feat/landed', new Date().toISOString())]
    merged = new Set()
    await prs.refreshPrs(projectId)
    await vi.waitFor(() => expect(status(t.ws.id)).toBe('stopped'))
    expect(mp.managedPreview(t.ws.id)!.reason).toBe('PR #43 was merged')
  })
})

describe('cleanup report', () => {
  it('lists previews still running for closed tickets', async () => {
    useFake()
    const { t, ws } = ticketWithWorktree()
    await startRunning(ws.id)
    // Closed without the board noticing (a stage turned into a done one, say).
    dbm.db.update(dbm.schema.tickets).set({ status: 'done' }).where(eq(dbm.schema.tickets.id, t.id)).run()
    const { cleanupReport } = await import('./cleanup')
    const report = await cleanupReport(projectId, { reach: false })
    const row = report.tickets.find((x) => x.id === t.id)!
    expect(row.previews).toMatchObject([{ workspaceId: ws.id, status: 'running' }])
    expect(report.counts.previews).toBeGreaterThanOrEqual(1)
  })
})

describe('over MCP and REST', () => {
  async function call(method: string, pathname: string, body?: unknown) {
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
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return handle({ request, actor: 'claude' })
  }
  const tool = async (name: string, args: Record<string, unknown>) => {
    const res = await call('POST', '/api/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    })
    const { result } = (await res.json()) as {
      result: { isError?: boolean; content: { text: string }[] }
    }
    return { error: !!result.isError, text: result.content[0]!.text }
  }

  it('start_preview, get_ticket and stop_preview', async () => {
    useFake()
    const { t, ws } = ticketWithWorktree()
    const started = await tool('start_preview', { workspaceId: ws.id })
    expect(started.error).toBe(false)
    expect(JSON.parse(started.text)).toMatchObject({ status: 'building', workspaceId: ws.id })
    await vi.waitFor(() => expect(status(ws.id)).toBe('running'))

    const ticket = JSON.parse((await tool('get_ticket', { ticketId: t.id })).text)
    expect(ticket.workspaces[0].managedPreview).toMatchObject({ status: 'running' })

    const again = await tool('start_preview', { workspaceId: ws.id })
    expect(again).toMatchObject({ error: true, text: expect.stringMatching(/already running/) })

    const stopped = await tool('stop_preview', { workspaceId: ws.id })
    expect(JSON.parse(stopped.text)).toMatchObject({ status: 'stopped', reason: 'stopped by claude' })
    expect(await tool('stop_preview', { workspaceId: ws.id })).toMatchObject({
      error: true,
      text: expect.stringMatching(/runs no preview/),
    })
  })

  it('the REST routes', async () => {
    useFake()
    const { ws } = ticketWithWorktree()
    const before = await (await call('GET', `/api/workspaces/${ws.id}/preview`)).json()
    expect(before).toMatchObject({ running: false, url: '', managed: null, cannotStart: null })
    const start = await call('POST', `/api/workspaces/${ws.id}/preview/start`)
    expect(start.status).toBe(202)
    await vi.waitFor(() => expect(status(ws.id)).toBe('running'))
    const log = await call('GET', `/api/workspaces/${ws.id}/preview/log?name=build`)
    expect(await log.text()).toContain('pnpm build line 1')
    expect((await call('POST', `/api/workspaces/${ws.id}/preview/stop`)).status).toBe(200)
    expect((await call('POST', `/api/workspaces/${ws.id}/preview/stop`)).status).toBe(409)
    const { ws: atMain } = ticketWithWorktree(main)
    const refused = await call('POST', `/api/workspaces/${atMain.id}/preview/start`)
    expect(refused.status).toBe(400)
  })
})

// Last: these load the module afresh, as a hot reload or a restarted board would.
describe('board reloads and restarts', () => {
  it('a hot reload of the server code keeps what runs', async () => {
    const fake = useFake()
    const { ws } = ticketWithWorktree()
    const p = await startRunning(ws.id)
    vi.resetModules()
    const reloaded = await import('./managedPreview')
    expect(reloaded.managedPreview(ws.id)).toMatchObject({ status: 'running', url: p.url, port: p.port })
    expect(reloaded.activePreviews().map((x) => x.workspaceId)).toContain(ws.id)
    expect(wsRow(ws.id)!.previewUrl).toBe(p.url)
    expect(fake.killed).toEqual([])
  })

  it('when the board shuts down; after a restart it says so and starts nothing', async () => {
    const fake = useFake()
    const { ws } = ticketWithWorktree()
    const p = await startRunning(ws.id)
    const server = fake.calls.at(-1)!
    mp.stopAllPreviews()
    expect(fake.killed).toContain(server.pid)
    expect(mp.managedPreview(ws.id)).toMatchObject({ status: 'stopped', reason: mp.RESTARTED })
    expect(wsRow(ws.id)!.previewUrl).toBe('')

    // A board that went down without a word (killed): its file still says running.
    const file = path.join(process.env.DATA_DIR!, 'previews.json')
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { workspaceId: number }[]
    const entry = saved.find((e) => e.workspaceId === ws.id)!
    Object.assign(entry, { status: 'running', url: p.url, port: p.port, pid: 4242, reason: null })
    fs.writeFileSync(file, JSON.stringify(saved))
    features.setWorkspacePreview(ws.id, p.url, 'board')

    // A restart is a new process: nothing is kept in memory, only the file.
    delete (globalThis as Record<symbol, unknown>)[mp.KEPT]
    vi.resetModules()
    const fresh = await import('./managedPreview')
    const fakeAfter = new FakeRunner()
    fresh.setPreviewRunner(fakeAfter)
    expect(fresh.managedPreview(ws.id)).toMatchObject({
      status: 'stopped',
      reason: 'stopped when the board restarted',
      url: null,
      port: null,
    })
    expect(wsRow(ws.id)!.previewUrl).toBe('')
    expect(fakeAfter.calls).toEqual([])
  })
})
