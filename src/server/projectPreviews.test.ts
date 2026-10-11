import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { PreviewRunner, Proc } from './managedPreview'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-')))
process.env.DATA_DIR = path.join(tmp, 'data')

let mp: typeof import('./managedPreview')
let features: typeof import('./features')
let dbm: typeof import('#/db')
let projectPreviews: typeof import('./projectPreviews').projectPreviews
let projectId: number
let otherId: number

// --- the repo the previews run from: a main checkout, and worktrees of the board next to it ---

const repos = path.join(tmp, 'code')
const main = path.join(repos, 'agent-board')
const LOCK = "lockfileVersion: '9.0'\n"
let wtCount = 0

function freshWorktree() {
  const dir = path.join(repos, `agent-board-wt${++wtCount}`)
  fs.mkdirSync(path.join(dir, 'node_modules', '.pnpm'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, '.git'),
    `gitdir: ${path.join(main, '.git', 'worktrees', path.basename(dir))}\n`,
  )
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'agent-board' }))
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), LOCK)
  fs.writeFileSync(path.join(dir, 'node_modules', '.pnpm', 'lock.yaml'), LOCK)
  return dir
}

// --- the fake runner, as in managedPreview.test.ts: builds exit at once, servers answer ---

class FakeRunner implements PreviewRunner {
  /** Exit code per shell command; 'hang' keeps it running. */
  codes: Record<string, number | 'hang'> = {}
  up = new Set<string>()
  private exits = new Map<number, (code: number | null) => void>()
  private urls = new Map<number, string>()
  private pid = 1000

  spawn(
    command: string,
    _args: string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv; log: string; shell?: boolean },
  ): Proc {
    const pid = ++this.pid
    fs.appendFileSync(opts.log, `${command} line 1\n`)
    const exited = new Promise<number | null>((resolve) => this.exits.set(pid, resolve))
    if (opts.shell) {
      const code = this.codes[command] ?? 0
      if (code !== 'hang') setTimeout(() => this.exits.get(pid)!(code), 0)
    } else {
      const url = `http://127.0.0.1:${opts.env.PORT}`
      this.up.add(url)
      this.urls.set(pid, url)
    }
    return { pid, exited }
  }
  async killTree(pid: number) {
    this.killTreeSync(pid)
  }
  killTreeSync(pid: number) {
    const url = this.urls.get(pid)
    if (url) this.up.delete(url)
    this.exits.get(pid)?.(null)
  }
  async isFree() {
    return true
  }
  async answers(url: string) {
    return this.up.has(url)
  }
  async copyData(dest: string) {
    fs.mkdirSync(dest, { recursive: true })
  }
}

// --- local servers: one that answers, one that never does, and a port nothing listens on ---

let answering: http.Server
let silent: http.Server
let answeringUrl: string
let silentUrl: string
let closedUrl: string

const listen = async (server: http.Server) => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

beforeAll(async () => {
  fs.mkdirSync(path.join(main, '.git'), { recursive: true })
  fs.writeFileSync(path.join(main, 'package.json'), JSON.stringify({ name: 'agent-board' }))
  mp = await import('./managedPreview')
  features = await import('./features')
  dbm = await import('#/db')
  ;({ projectPreviews } = await import('./projectPreviews'))
  projectId = dbm.db.insert(dbm.schema.projects).values({ name: 'board' }).returning().get().id
  otherId = dbm.db.insert(dbm.schema.projects).values({ name: 'other' }).returning().get().id
  // Both run from the same checkout: only the project tells their previews apart.
  for (const id of [projectId, otherId])
    dbm.db
      .insert(dbm.schema.repos)
      .values({ projectId: id, name: 'agent-board', repoPath: main, githubRepo: 'acme/agent-board' })
      .run()

  answering = http.createServer((req, res) => {
    res.writeHead(req.url === '/missing' ? 404 : 200)
    res.end('ok')
  })
  answeringUrl = await listen(answering)
  // Takes the connection and never answers: the check gives up after its timeout.
  silent = http.createServer(() => {})
  silentUrl = await listen(silent)
  const probe = http.createServer()
  closedUrl = await listen(probe)
  await new Promise((resolve) => probe.close(resolve))
})

afterAll(async () => {
  silent.closeAllConnections()
  await Promise.all([answering, silent].map((s) => new Promise((resolve) => s.close(resolve))))
})

afterEach(async () => {
  for (const p of mp.activePreviews()) await mp.stopPreview(p.workspaceId, 'test over', 'test')
  mp.setPreviewRunner(null)
})

let fake: FakeRunner
function useFake() {
  fake = new FakeRunner()
  mp.setPreviewRunner(fake)
  return fake
}

let ticketCount = 0
function ticket(over: { project?: number; status?: string; parentId?: number } = {}) {
  return features.createTicket(
    over.project ?? projectId,
    { title: `ticket ${++ticketCount}`, status: over.status ?? 'in_progress', parentId: over.parentId },
    'claude',
  )
}
const workspace = (ticketId: number, input: { branch?: string; path?: string; previewUrl?: string } = {}) =>
  features.addWorkspace(ticketId, { name: 'wt', branch: 'feat', ...input }, 'claude')

const rowOf = async (workspaceId: number, project = projectId) =>
  (await projectPreviews(project)).find((p) => p.workspace.id === workspaceId)

async function startRunning(id: number) {
  mp.startPreview(id, 'claude')
  await vi.waitFor(() => expect(mp.managedPreview(id)?.status).toBe('running'))
  return mp.managedPreview(id)!
}

describe('the project previews', () => {
  it('lists every workspace with a link, and none without a link or a preview the board ran', async () => {
    const a = workspace(ticket().id, { previewUrl: closedUrl })
    const b = workspace(ticket().id, { previewUrl: 'https://example.com/x' })
    const c = workspace(ticket().id, { path: path.join(tmp, 'nowhere') })
    const list = await projectPreviews(projectId)
    const ids = list.map((p) => p.workspace.id)
    expect(ids).toContain(a.id)
    expect(ids).toContain(b.id)
    expect(ids).not.toContain(c.id)

    // A link on this machine that does not answer; one elsewhere is never checked.
    expect(list.find((p) => p.workspace.id === a.id)).toMatchObject({
      url: closedUrl,
      check: { running: false },
      managed: null,
      running: false,
      ticket: { id: a.ticketId, title: expect.stringMatching(/^ticket /) },
      workspace: { branch: 'feat' },
    })
    expect(list.find((p) => p.workspace.id === b.id)).toMatchObject({
      url: 'https://example.com/x',
      check: null,
      running: false,
    })
  })

  it('marks a link on this machine running when anything answers, an error page too', async () => {
    const ok = workspace(ticket().id, { previewUrl: `${answeringUrl}/` })
    const missing = workspace(ticket().id, { previewUrl: `${answeringUrl}/missing` })
    expect(await rowOf(ok.id)).toMatchObject({ running: true, check: { running: true, status: 200 } })
    expect(await rowOf(missing.id)).toMatchObject({ running: true, check: { running: true, status: 404 } })
  })

  it('lists the running ones first, then the rest, each the most recent first', async () => {
    const t = ticket()
    const older = workspace(t.id, { previewUrl: `${closedUrl}/older` })
    const running = workspace(t.id, { previewUrl: `${answeringUrl}/first` })
    const newer = workspace(t.id, { previewUrl: `${closedUrl}/newer` })
    dbm.db
      .update(dbm.schema.workspaces)
      .set({ createdAt: '2020-01-01T00:00:00.000Z' })
      .where(eq(dbm.schema.workspaces.id, older.id))
      .run()
    const list = await projectPreviews(projectId)
    const at = (id: number) => list.findIndex((p) => p.workspace.id === id)
    const lastRunning = list.map((p) => p.running).lastIndexOf(true)
    const firstStopped = list.findIndex((p) => !p.running)
    expect(lastRunning).toBeLessThan(firstStopped)
    expect(at(running.id)).toBeLessThan(firstStopped)
    expect(at(newer.id)).toBeLessThan(at(older.id))
  })

  it('checks the links all at once: several that never answer cost one timeout, not one each', async () => {
    const t = ticket({ project: otherId })
    for (const n of [1, 2, 3, 4]) workspace(t.id, { previewUrl: `${silentUrl}/slow-${n}` })
    const started = Date.now()
    const list = await projectPreviews(otherId)
    const took = Date.now() - started
    const slow = list.filter((p) => p.url.startsWith(silentUrl))
    expect(slow).toHaveLength(4)
    expect(slow.every((p) => p.check?.running === false && !p.running)).toBe(true)
    // Each check gives up after 1.5 s: one after another would take 6 s.
    expect(took).toBeLessThan(4_000)
  })

  it('keeps a preview the board ran after it stopped or failed, its link cleared, and says why', async () => {
    useFake()
    const t = ticket()
    const ws = workspace(t.id, { path: freshWorktree() })
    const p = await startRunning(ws.id)

    const running = (await rowOf(ws.id))!
    expect(running).toMatchObject({
      url: `http://127.0.0.1:${p.port}`,
      managed: { status: 'running', port: p.port, url: `http://127.0.0.1:${p.port}` },
      running: true,
      cannotStart: null,
    })
    expect(running.managed!.runningAt).toBeTruthy()

    await mp.stopPreview(ws.id, 'stopped by enrique', 'enrique')
    const stopped = (await rowOf(ws.id))!
    expect(stopped).toMatchObject({
      url: '',
      check: null,
      managed: { status: 'stopped', reason: 'stopped by enrique', port: null, url: null },
      running: false,
      // Stopped on an open ticket from a worktree the board runs: it may start again.
      cannotStart: null,
    })
    expect(stopped.managed!.stoppedAt).toBeTruthy()

    fake.codes['pnpm build'] = 1
    const broken = workspace(ticket().id, { path: freshWorktree() })
    mp.startPreview(broken.id, 'claude')
    await vi.waitFor(() => expect(mp.managedPreview(broken.id)?.status).toBe('failed'))
    expect(await rowOf(broken.id)).toMatchObject({
      url: '',
      managed: { status: 'failed', reason: 'pnpm build failed (exit 1)' },
      running: false,
    })
  })

  it('counts a preview the board is still building as running', async () => {
    useFake()
    fake.codes['pnpm build'] = 'hang'
    const ws = workspace(ticket().id, { path: freshWorktree() })
    mp.startPreview(ws.id, 'claude')
    await vi.waitFor(() => expect(mp.managedPreview(ws.id)?.step).toBe('build'))
    expect(await rowOf(ws.id)).toMatchObject({
      managed: { status: 'building', step: 'build' },
      running: true,
      url: '',
      // Stop and Restart, not Start, while it builds.
      cannotStart: null,
    })
  })

  it("lists closed tickets' previews with their stage, and leaves archived tickets out", async () => {
    useFake()
    const t = ticket()
    const ws = workspace(t.id, { path: freshWorktree(), previewUrl: closedUrl })
    const managed = workspace(t.id, { path: freshWorktree() })
    await startRunning(managed.id)

    features.updateTicket(t.id, { status: 'done' }, 'enrique')
    // Closing it stops the board's preview; the record stays, and so does the manual link.
    await vi.waitFor(() => expect(mp.managedPreview(managed.id)?.status).toBe('stopped'))
    expect(await rowOf(ws.id)).toMatchObject({ ticket: { id: t.id, status: 'done' }, url: closedUrl })
    expect(await rowOf(managed.id)).toMatchObject({
      ticket: { status: 'done' },
      managed: { status: 'stopped' },
      // Nothing is started for a finished ticket.
      cannotStart: 'the ticket is done',
    })

    const cancelled = ticket({ status: 'cancelled' })
    const wsCancelled = workspace(cancelled.id, { previewUrl: closedUrl })
    expect(await rowOf(wsCancelled.id)).toMatchObject({ ticket: { status: 'cancelled' } })

    features.archiveTicket(t.id, 'enrique')
    features.archiveTicket(cancelled.id, 'enrique')
    const ids = (await projectPreviews(projectId)).map((p) => p.workspace.id)
    expect(ids).not.toContain(ws.id)
    expect(ids).not.toContain(managed.id)
    expect(ids).not.toContain(wsCancelled.id)
  })

  it("includes the lanes' previews, as the lane's", async () => {
    const parent = ticket()
    const lane = ticket({ parentId: parent.id })
    const ws = workspace(lane.id, { previewUrl: 'https://example.com/lane' })
    expect(await rowOf(ws.id)).toMatchObject({
      ticket: { id: lane.id, title: lane.title, parentId: parent.id },
    })
  })

  it("lists only the project's own previews", async () => {
    useFake()
    const mine = workspace(ticket().id, { previewUrl: 'https://example.com/mine' })
    const theirs = workspace(ticket({ project: otherId }).id, { previewUrl: 'https://example.com/theirs' })
    // The other project's ticket, with a preview the board ran: still not ours.
    const theirsManaged = workspace(ticket({ project: otherId }).id, { path: freshWorktree() })
    await startRunning(theirsManaged.id)

    const ours = (await projectPreviews(projectId)).map((p) => p.workspace.id)
    expect(ours).toContain(mine.id)
    expect(ours).not.toContain(theirs.id)
    expect(ours).not.toContain(theirsManaged.id)
    const others = (await projectPreviews(otherId)).map((p) => p.workspace.id)
    expect(others).toContain(theirs.id)
    expect(others).toContain(theirsManaged.id)
    expect(others).not.toContain(mine.id)
  })

  it('is empty for a project without previews', async () => {
    const empty = dbm.db.insert(dbm.schema.projects).values({ name: 'empty' }).returning().get().id
    expect(await projectPreviews(empty)).toEqual([])
    dbm.db.insert(dbm.schema.repos).values({ projectId: empty, name: 'agent-board', repoPath: main }).run()
    workspace(ticket({ project: empty }).id)
    expect(await projectPreviews(empty)).toEqual([])
  })
})

describe('GET /api/projects/:id/previews', () => {
  async function call(pathname: string, actor = 'enrique') {
    const { api } = await import('./api')
    const { api: guard } = await import('./http')
    const handle = guard(({ request, actor }: { request: Request; actor: string }) =>
      api.handle(request, actor),
    )
    return handle({ request: new Request(`http://localhost${pathname}`), actor })
  }

  it('answers the previews, and 404 for a project that does not exist', async () => {
    const ws = workspace(ticket().id, { previewUrl: 'https://example.com/rest' })
    const res = await call(`/api/projects/${projectId}/previews`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { previews: { workspace: { id: number } }[] }
    expect(body.previews.map((p) => p.workspace.id)).toContain(ws.id)
    const missing = await call('/api/projects/999999/previews')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'project not found' })
  })

  it('only reads: no link, preview or activity changes, however often it is asked', async () => {
    useFake()
    const stoppedWs = workspace(ticket().id, { path: freshWorktree() })
    await startRunning(stoppedWs.id)
    await mp.stopPreview(stoppedWs.id, 'stopped by enrique', 'enrique')
    const runningWs = workspace(ticket().id, { path: freshWorktree() })
    await startRunning(runningWs.id)
    workspace(ticket().id, { previewUrl: closedUrl })
    workspace(ticket().id, { previewUrl: answeringUrl })

    const snapshot = () => ({
      workspaces: dbm.db.select().from(dbm.schema.workspaces).all(),
      tickets: dbm.db.select().from(dbm.schema.tickets).all(),
      activity: dbm.db.select().from(dbm.schema.activity).all().length,
      managed: [stoppedWs.id, runningWs.id].map((id) => mp.managedPreview(id)),
    })
    const before = snapshot()
    for (let i = 0; i < 2; i++) expect((await call(`/api/projects/${projectId}/previews`)).status).toBe(200)
    expect(snapshot()).toEqual(before)
  })
})
