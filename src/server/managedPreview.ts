import { execFile, spawn as nodeSpawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

import Database from 'better-sqlite3'
import { and, eq, inArray } from 'drizzle-orm'

import { db, schema } from '#/db'
import { readPreviewLimit } from '#/lib/constants'
import { logActivity } from './activity'
import { authMode, config, uploadsDir } from './config'
import { HttpError, notFound } from './http'
import { checkPreview } from './preview'
import { ticketRepo } from './repos'
import { kindOf, listStages } from './stages'

/**
 * Previews the board runs itself: a ticket workspace's worktree of the board, built and started as a
 * second board on a free port next to the live one, with a fresh copy of the live data. Agents ask for
 * one instead of running `pnpm dev` in their own session, where it died with the session and behaved
 * differently from the built board.
 *
 * What runs is kept in memory. `previews.json` in the data dir only remembers the last state of each,
 * so after a restart the ticket page can say that one was stopped when the board restarted; nothing
 * is started again on its own.
 */

export type ManagedStatus = 'building' | 'starting' | 'running' | 'failed' | 'stopped'
/** While building: installing dependencies, building, copying the live data; then the server. */
export type ManagedStep = 'install' | 'build' | 'copy' | 'server'

export interface ManagedPreview {
  workspaceId: number
  ticketId: number
  status: ManagedStatus
  step: ManagedStep | null
  /** The port it holds while starting or running. */
  port: number | null
  /** The process it is waiting on: pnpm while building, the server once it starts. */
  pid: number | null
  /** Where it answers while running; also set as the workspace's previewUrl. */
  url: string | null
  startedAt: string
  runningAt: string | null
  stoppedAt: string | null
  /** Why it failed or stopped. */
  reason: string | null
  /** The last lines of the log that explains a failure, and which log they come from. */
  tail: string[]
  tailLog: 'build' | 'server' | null
  /** The worktree it runs from. */
  path: string
  /** Absolute paths of its logs: install and build, then the server. */
  logs: { build: string; server: string }
}

const ACTIVE = new Set<ManagedStatus>(['building', 'starting', 'running'])
export const isActive = (p: Pick<ManagedPreview, 'status'> | null | undefined) => !!p && ACTIVE.has(p.status)

/**
 * At most this many build or run at once, board-wide: the human's preview limit (`previewLimit` in the
 * settings, 8 by default). Each is a whole board with its own copy of the data.
 */
export function previewLimit(): number {
  const row = db.select().from(schema.settings).where(eq(schema.settings.key, 'previewLimit')).get()
  return readPreviewLimit(row?.value)
}
export const PORTS = { from: 47101, to: 47199 }
const READY_MS = 90_000
const WIN = process.platform === 'win32'
export const RESTARTED = 'stopped when the board restarted'

// --- where a preview may run from ---

const norm = (p: string) => {
  const s = path.resolve(p).replace(/[\\/]+$/, '')
  return WIN ? s.toLowerCase() : s
}
const real = (p: string) => {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return null
  }
}

/** The main checkout a worktree's `.git` file points into (`gitdir: <main>/.git/worktrees/<name>`). */
function worktreeOf(dir: string): string | null {
  try {
    const dotGit = path.join(dir, '.git')
    if (!fs.statSync(dotGit).isFile()) return null
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))
    if (!m) return null
    const gitdir = path.resolve(dir, m[1]!.trim())
    const worktrees = path.dirname(gitdir)
    if (path.basename(worktrees) !== 'worktrees' || path.basename(path.dirname(worktrees)) !== '.git')
      return null
    return path.dirname(path.dirname(worktrees))
  } catch {
    return null
  }
}

export type PreviewTarget = { ok: true; path: string } | { ok: false; reason: string }

/**
 * Whether the workspace's path is a worktree the board may act on: a git worktree of the ticket's repo
 * sitting next to that repo's main checkout (`../<repo>-<branch>`), never the main checkout or the
 * board's own folder. `path` is its real path. The path comes from the workspace the agent registered,
 * never from the request.
 */
export function worktreeTarget(
  ws: Pick<schema.Workspace, 'path'>,
  repo: Pick<schema.Repo, 'repoPath'> | null,
  boardRoot = process.cwd(),
): PreviewTarget {
  const no = (reason: string): PreviewTarget => ({ ok: false, reason })
  if (!ws.path.trim()) return no('the workspace has no local path')
  if (!repo) return no("the ticket's project has no repo")
  if (!path.isAbsolute(ws.path)) return no(`${ws.path} is not an absolute path`)
  const dir = real(ws.path)
  if (!dir) return no(`${ws.path} does not exist on this machine`)
  const main = real(repo.repoPath)
  if (!main) return no(`the repo's checkout ${repo.repoPath} does not exist on this machine`)
  if (norm(dir) === norm(main)) return no("that is the repo's main checkout; previews run from a worktree")
  const board = real(boardRoot)
  if (board && norm(dir) === norm(board)) return no("that is the board's own folder")
  if (norm(path.dirname(dir)) !== norm(path.dirname(main)))
    return no(`only worktrees next to the main checkout (in ${path.dirname(main)}) are run`)
  const owner = worktreeOf(dir)
  if (!owner || norm(real(owner) ?? owner) !== norm(main))
    return no(`${ws.path} is not a git worktree of ${repo.repoPath}`)
  return { ok: true, path: dir }
}

/**
 * Whether the board may build and run this workspace: a worktree it may act on (`worktreeTarget`) that
 * is a checkout of the board itself (that is what it knows how to run).
 */
export function previewTarget(
  ws: Pick<schema.Workspace, 'path'>,
  repo: Pick<schema.Repo, 'repoPath'> | null,
  boardRoot = process.cwd(),
): PreviewTarget {
  const target = worktreeTarget(ws, repo, boardRoot)
  if (!target.ok) return target
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(target.path, 'package.json'), 'utf8')) as {
      name?: string
    }
    if (pkg.name !== 'agent-board') throw new Error()
  } catch {
    return {
      ok: false,
      reason: 'the board runs previews of its own repo only (package.json name agent-board)',
    }
  }
  return target
}

// --- the processes: real by default, a fake in the tests ---

export interface Proc {
  pid: number | undefined
  /** Resolves with the exit code (null when killed or it could not start). */
  exited: Promise<number | null>
}

export interface PreviewRunner {
  /** Start a command, its output appended to `log`. With `shell`, `command` is a whole command line. */
  spawn(
    command: string,
    args: string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv; log: string; shell?: boolean },
  ): Proc
  /** Kill a process and everything it started. */
  killTree(pid: number): Promise<void>
  /** The same, for the board's last moments (no await there). */
  killTreeSync(pid: number): void
  isFree(port: number): Promise<boolean>
  answers(url: string): Promise<boolean>
  /** The live board's database (a backup, it is open and in WAL mode) and uploads, into `dest`. */
  copyData(dest: string): Promise<void>
}

/** Free on both loopbacks, as `scripts/dev.mjs` checks: something may hold [::1] and not 127.0.0.1. */
async function isFree(port: number) {
  for (const host of ['127.0.0.1', '::1']) {
    const ok = await new Promise<boolean>((resolve) => {
      const probe = net.createServer()
      probe.once('error', (e: NodeJS.ErrnoException) =>
        resolve(e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT'),
      )
      probe.once('listening', () => probe.close(() => resolve(true)))
      probe.listen(port, host)
    })
    if (!ok) return false
  }
  return true
}

const realRunner: PreviewRunner = {
  spawn(command, args, { cwd, env, log, shell }) {
    const fd = fs.openSync(log, 'a')
    // Its own process group off Windows, so the whole tree can be killed; taskkill /T does it there.
    const child = nodeSpawn(command, args, {
      cwd,
      env,
      shell: shell ?? false,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      detached: !WIN,
    })
    fs.closeSync(fd)
    // A running preview must not keep the board alive as it shuts down.
    child.unref()
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => resolve(code))
      child.once('error', (err) => {
        fs.appendFileSync(log, `\n${err.message}\n`)
        resolve(null)
      })
    })
    return { pid: child.pid, exited }
  },
  killTree: (pid) =>
    new Promise((resolve) => {
      if (WIN) execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
      else {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          // already gone
        }
        resolve()
      }
    }),
  killTreeSync(pid) {
    if (WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    else
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        // already gone
      }
  },
  isFree,
  answers: async (url) => (await checkPreview(url, 1000)).running,
  async copyData(dest) {
    const src = path.join(config.dataDir, 'board.db')
    if (fs.existsSync(src)) {
      const live = new Database(src, { readonly: true, fileMustExist: true })
      try {
        await live.backup(path.join(dest, 'board.db'))
      } finally {
        live.close()
      }
    }
    if (fs.existsSync(uploadsDir))
      await fs.promises.cp(uploadsDir, path.join(dest, 'uploads'), { recursive: true })
  },
}

let runner = realRunner
/** Tests run previews against a fake; `null` puts the real one back. */
export function setPreviewRunner(r: PreviewRunner | null) {
  runner = r ?? realRunner
}

// --- state ---

type Entry = ManagedPreview & { dataDir: string }

/**
 * What runs outlives this module. The board hot-reloads its server code (`vite dev`), and a reload
 * evaluates this module again: kept here, the previews, the port queue and the exit hook survive it,
 * so a reload neither forgets a preview that is still running (and its port) nor hooks the exit
 * twice. A restart of the board starts from previews.json instead.
 */
interface Kept {
  entries: Map<number, Entry> | undefined
  portQueue: Promise<unknown>
  hooked: boolean
  /** Workspaces whose running preview a restart is replacing: their slot stays taken meanwhile. */
  restarting: Set<number> | undefined
  /**
   * Each start's run until it settles, stopped ones too: a stop kills the run's process, but the copy
   * of the live data has none and goes on writing into the worktree until it ends.
   */
  runs: Map<Entry, Promise<void>> | undefined
}
export const KEPT = Symbol.for('agent-board.managedPreviews')
const kept = ((globalThis as { [KEPT]?: Kept })[KEPT] ??= {
  entries: undefined,
  portQueue: Promise.resolve(),
  hooked: false,
  restarting: undefined,
  runs: undefined,
})
// A module loaded before these fields existed kept its object: give it them.
const restarting = (kept.restarting ??= new Set<number>())
const runs = (kept.runs ??= new Map<Entry, Promise<void>>())
const stateFile = () => path.join(config.dataDir, 'previews.json')

function save() {
  try {
    fs.writeFileSync(stateFile(), JSON.stringify([...all().values()], null, 2))
  } catch (err) {
    console.error('could not save the preview state:', err)
  }
}

/**
 * The previews, loaded once: what the board remembers from before it started. Nothing is started again;
 * one that was building or running is stopped, and its link cleared.
 */
function all(): Map<number, Entry> {
  if (kept.entries) return kept.entries
  const entries = (kept.entries = new Map<number, Entry>())
  let saved: Entry[] = []
  try {
    saved = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as Entry[]
  } catch {
    // none yet
  }
  const now = new Date().toISOString()
  let changed = false
  for (const e of saved) {
    const ws = db.select().from(schema.workspaces).where(eq(schema.workspaces.id, e.workspaceId)).get()
    if (!ws) {
      changed = true
      continue
    }
    if (isActive(e)) {
      changed = true
      if (e.url && ws.previewUrl === e.url) clearUrl(e.workspaceId, e.url)
      Object.assign(e, { status: 'stopped', step: null, pid: null, port: null, url: null, stoppedAt: now })
      e.reason = RESTARTED
    }
    entries.set(e.workspaceId, e)
  }
  if (changed) save()
  return entries
}

const view = ({ dataDir: _dataDir, ...e }: Entry): ManagedPreview => ({ ...e, tail: [...e.tail] })

/** The board's own preview of a workspace, or null when it never ran one. */
export function managedPreview(workspaceId: number): ManagedPreview | null {
  const e = all().get(workspaceId)
  return e ? view(e) : null
}

/** Every preview the board is building or running, for the cleanup report. */
export function activePreviews(): ManagedPreview[] {
  return [...all().values()].filter(isActive).map(view)
}

function getWorkspace(id: number) {
  const ws = db.select().from(schema.workspaces).where(eq(schema.workspaces.id, id)).get()
  if (!ws) throw notFound('workspace')
  return ws
}
const ticketOf = (id: number) => db.select().from(schema.tickets).where(eq(schema.tickets.id, id)).get()!

function log(e: Pick<ManagedPreview, 'ticketId' | 'workspaceId'>, actor: string, text: string) {
  const ticket = db.select().from(schema.tickets).where(eq(schema.tickets.id, e.ticketId)).get()
  // Gone with its ticket: nothing to log it on.
  if (!ticket) return
  const ws = db.select().from(schema.workspaces).where(eq(schema.workspaces.id, e.workspaceId)).get()
  logActivity({
    projectId: ticket.projectId,
    actor,
    kind: 'workspace',
    text: `${text} of workspace ${ws?.name ?? e.workspaceId} on #${ticket.id}`,
    refType: 'ticket',
    refId: ticket.id,
  })
}

function clearUrl(workspaceId: number, url: string) {
  db.update(schema.workspaces)
    .set({ previewUrl: '' })
    .where(and(eq(schema.workspaces.id, workspaceId), eq(schema.workspaces.previewUrl, url)))
    .run()
}

/** Whether a start would be refused before anything runs; null when it may start. */
export function cannotStart(workspaceId: number): string | null {
  if (authMode().boardEnv === 'development')
    return 'previews are started by the live board (or a test-mode one), not by a preview'
  const ws = getWorkspace(workspaceId)
  const ticket = ticketOf(ws.ticketId)
  if (ticket.archivedAt) return 'the ticket is archived'
  const kind = kindOf(listStages(ticket.projectId), ticket.status)
  if (kind === 'done' || kind === 'cancelled') return `the ticket is ${kind}`
  const target = previewTarget(ws, ticketRepo(ticket))
  if (!target.ok) return target.reason
  const other = [...all().values()].find(
    (e) => e.workspaceId !== workspaceId && isActive(e) && norm(e.path) === norm(target.path),
  )
  return other ? `workspace ${other.workspaceId} already runs a preview from ${target.path}` : null
}

// --- start, stop ---

/**
 * Build and run the workspace's worktree as a preview, in the background: install (only when the
 * lockfile changed since the last install there), build, copy the live data, start the built server
 * on a free port, and set the workspace's previewUrl once it answers. Returns at once, building.
 */
export function startPreview(
  workspaceId: number,
  actor: string,
  opts: { replacing?: boolean } = {},
): ManagedPreview {
  const ws = getWorkspace(workspaceId)
  const refused = cannotStart(workspaceId)
  if (refused) throw new HttpError(400, refused)
  const target = previewTarget(ws, ticketRepo(ticketOf(ws.ticketId))) as { ok: true; path: string }
  const before = all().get(workspaceId)
  if (isActive(before))
    throw new HttpError(409, `its preview is already ${before!.status}: stop it first, or restart it`)
  // A restart puts back the one it just stopped: it adds none, so the limit does not stop it.
  if (!opts.replacing) assertRoom()
  const dataDir = path.join(target.path, 'data', 'preview')
  const logs = path.join(dataDir, 'logs')
  const e: Entry = {
    workspaceId,
    ticketId: ws.ticketId,
    status: 'building',
    step: null,
    port: null,
    pid: null,
    url: null,
    startedAt: new Date().toISOString(),
    runningAt: null,
    stoppedAt: null,
    reason: null,
    tail: [],
    tailLog: null,
    path: target.path,
    logs: { build: path.join(logs, 'build.log'), server: path.join(logs, 'server.log') },
    dataDir,
  }
  stopPreviewsOnExit()
  all().set(workspaceId, e)
  save()
  log(e, actor, 'started a preview')
  const running = run(e)
    .catch((err: unknown) => fail(e, `could not start: ${(err as Error).message ?? err}`, null))
    .finally(() => runs.delete(e))
  runs.set(e, running)
  return view(e)
}

/**
 * Settles once the runs the board started from a folder `at` takes (a preview's real path) settle,
 * stopped previews included: a stop returns at once, while the step it caught may still be writing
 * into the worktree (the copy of the live data, which no process holds). The runs are those there as
 * it is called: one started after that is not waited for. What removes the worktree waits for this.
 */
export function previewsSettled(at: (path: string) => boolean): Promise<void> {
  const settling = [...runs].filter(([e]) => at(e.path)).map(([, settled]) => settled)
  return Promise.all(settling).then(() => {})
}

/** Still the preview being started: not stopped, restarted or forgotten meanwhile. */
const current = (e: Entry) => all().get(e.workspaceId) === e && isActive(e)

/** Whether `pnpm install` has to run: no install yet, or the lockfile changed since the last one. */
export function needsInstall(dir: string) {
  const read = (f: string) => {
    try {
      return fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n')
    } catch {
      return null
    }
  }
  // pnpm keeps the lockfile it installed from there.
  const installed = read('node_modules/.pnpm/lock.yaml')
  return installed === null || installed !== read('pnpm-lock.yaml')
}

/** The environment of what runs in the worktree: none of the live board's own settings. */
function worktreeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env))
    if (
      /^(NODE_ENV|PORT|HOST|NITRO_\w+|DATA_DIR|BOARD_URL|BOARD_ENV|AUTH|DEV_HUMAN|TEST_HUMAN|STORAGE|S3_\w+)$/.test(
        key,
      )
    )
      delete env[key]
  return env
}

// Run inside the preview's server: it exits within a few seconds of the board, whichever way the
// board went (`pnpm stop` ends it without a chance to clean up).
const WATCHDOG = `data:text/javascript,${encodeURIComponent(
  'const p=Number(process.env.PREVIEW_PARENT_PID);if(p)setInterval(()=>{try{process.kill(p,0)}catch(e){if(e.code==="ESRCH")process.exit(0)}},2000).unref()',
)}`

/** The preview's server: a development board without the gate, on loopback, on its own data copy. */
export function serverEnv(port: number, dataDir: string): NodeJS.ProcessEnv {
  return {
    ...worktreeEnv(),
    BOARD_ENV: 'development',
    AUTH: 'off',
    HOST: '127.0.0.1',
    PORT: String(port),
    BOARD_URL: `http://127.0.0.1:${port}`,
    DATA_DIR: dataDir,
    STORAGE: 'local',
    PREVIEW_PARENT_PID: String(process.pid),
  }
}

async function run(e: Entry) {
  await fs.promises.rm(e.dataDir, { recursive: true, force: true })
  await fs.promises.mkdir(path.dirname(e.logs.build), { recursive: true })
  const env = worktreeEnv()
  const step = async (name: ManagedStep, command: string) => {
    // Stopped while it cleared the last run's data: nothing more starts.
    if (!current(e)) return false
    e.step = name
    fs.appendFileSync(e.logs.build, `> ${command}\n`)
    const proc = runner.spawn(command, [], { cwd: e.path, env, log: e.logs.build, shell: true })
    e.pid = proc.pid ?? null
    const code = await proc.exited
    if (!current(e)) return false
    e.pid = null
    if (code === 0) return true
    fail(e, `${command} failed${code === null ? '' : ` (exit ${code})`}`, 'build')
    return false
  }
  if (needsInstall(e.path) && !(await step('install', 'pnpm install --frozen-lockfile --prefer-offline')))
    return
  if (!(await step('build', 'pnpm build'))) return

  e.step = 'copy'
  await runner.copyData(e.dataDir)
  if (!current(e)) return

  e.status = 'starting'
  e.step = 'server'
  const port = await takePort(e)
  if (!current(e)) return
  if (!port) return fail(e, `no free port between ${PORTS.from} and ${PORTS.to}`, null)
  const url = `http://127.0.0.1:${port}`
  const proc = runner.spawn(process.execPath, ['--import', WATCHDOG, '.output/server/index.mjs'], {
    cwd: e.path,
    env: serverEnv(port, e.dataDir),
    log: e.logs.server,
  })
  e.pid = proc.pid ?? null
  save()
  let exited: number | null | undefined
  void proc.exited.then((code) => {
    exited = code
    if (current(e) && e.pid === proc.pid)
      fail(e, `the server exited${code === null ? '' : ` (exit ${code})`}`, 'server')
  })
  for (const until = Date.now() + READY_MS; Date.now() < until; ) {
    if (!current(e) || exited !== undefined) return
    if (await runner.answers(url)) {
      if (!current(e)) return
      e.status = 'running'
      e.step = null
      e.url = url
      e.runningAt = new Date().toISOString()
      db.update(schema.workspaces)
        .set({ previewUrl: url })
        .where(eq(schema.workspaces.id, e.workspaceId))
        .run()
      save()
      return
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  if (!current(e)) return
  if (e.pid) await runner.killTree(e.pid)
  fail(e, `the server did not answer within ${READY_MS / 1000}s`, 'server')
}

// One allocation at a time (kept.portQueue), so two previews starting together never pick the same port.

function takePort(e: Entry): Promise<number | null> {
  const next = kept.portQueue.then(async () => {
    const taken = new Set([...all().values()].filter((x) => x !== e && x.port).map((x) => x.port))
    for (let port = PORTS.from; port <= PORTS.to; port++) {
      if (taken.has(port) || !(await runner.isFree(port))) continue
      e.port = port
      return port
    }
    return null
  })
  kept.portQueue = next.catch(() => {})
  return next
}

function tailOf(file: string, lines = 30): string[] {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return text
      .slice(-64 * 1024)
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .slice(-lines)
      .map((l) => (l.length > 400 ? `${l.slice(0, 400)}…` : l))
  } catch {
    return []
  }
}

function fail(e: Entry, reason: string, from: 'build' | 'server' | null) {
  if (all().get(e.workspaceId) !== e || !isActive(e)) return
  const pid = e.pid
  if (e.url) clearUrl(e.workspaceId, e.url)
  Object.assign(e, {
    status: 'failed',
    step: null,
    pid: null,
    port: null,
    url: null,
    stoppedAt: new Date().toISOString(),
    reason,
    tail: from ? tailOf(e.logs[from]) : [],
    tailLog: from,
  })
  if (pid) void runner.killTree(pid)
  save()
}

/**
 * Stop the workspace's preview, building or running: kill its process tree, clear its link, free its
 * port. A preview that is not running is left as it is.
 */
export async function stopPreview(workspaceId: number, reason: string, actor: string) {
  const e = all().get(workspaceId)
  if (!e || !isActive(e)) return e ? view(e) : null
  const { pid, url } = e
  Object.assign(e, {
    status: 'stopped',
    step: null,
    pid: null,
    url: null,
    stoppedAt: new Date().toISOString(),
    reason,
    tail: [],
    tailLog: null,
  })
  if (pid) await runner.killTree(pid)
  e.port = null
  if (url) clearUrl(workspaceId, url)
  save()
  log(e, actor, `stopped the preview (${reason})`)
  return view(e)
}

/**
 * How many build or run right now, board-wide; one a restart is replacing counts while it is being
 * stopped, so no other start takes its slot in the meantime.
 */
export const previewsInUse = () =>
  [...all().values()].filter((e) => isActive(e) || restarting.has(e.workspaceId)).length

/** A refusal when the preview limit is reached: as many build or run as the human allows. */
function assertRoom() {
  const running = previewsInUse()
  const limit = previewLimit()
  if (running >= limit)
    throw new HttpError(
      409,
      `${running} previews already run, at most ${limit} (the preview limit): stop one first`,
    )
}

/**
 * Stop it if it runs, then build and start it again. Restarting one that runs is allowed at or over
 * the preview limit (it adds none); one that does not run is a start and counts. Whatever would refuse
 * the start refuses before anything is stopped.
 */
export async function restartPreview(workspaceId: number, actor: string) {
  getWorkspace(workspaceId)
  const refused = cannotStart(workspaceId)
  if (refused) throw new HttpError(400, refused)
  const replacing = isActive(all().get(workspaceId))
  if (!replacing) assertRoom()
  // Its slot stays taken while it is stopped (killing its processes takes a moment), so a start in
  // between cannot take it and leave the board over the limit once this one is back.
  const reserved = replacing && !restarting.has(workspaceId)
  if (reserved) restarting.add(workspaceId)
  try {
    await stopPreview(workspaceId, `restarted by ${actor}`, actor)
    return startPreview(workspaceId, actor, { replacing })
  } finally {
    if (reserved) restarting.delete(workspaceId)
  }
}

/** Every ticket under these, their lanes (and theirs) included. */
function withLanes(ticketIds: number[]) {
  const ids = new Set(ticketIds)
  for (let level = ticketIds; level.length; ) {
    level = db
      .select({ id: schema.tickets.id })
      .from(schema.tickets)
      .where(inArray(schema.tickets.parentId, level))
      .all()
      .map((t) => t.id)
      .filter((id) => !ids.has(id))
    for (const id of level) ids.add(id)
  }
  return ids
}

/** Whether a preview runs for any of these tickets or their lanes. */
export function hasPreviews(ticketIds: number[]) {
  const ids = withLanes(ticketIds)
  return [...all().values()].some((e) => isActive(e) && ids.has(e.ticketId))
}

/**
 * Stop the previews of these tickets and their lanes: the work is merged, done, cancelled or
 * archived. Returns at once; the processes go in the background.
 */
export function stopPreviewsFor(ticketIds: number[], reason: string, actor = 'board') {
  const ids = withLanes(ticketIds)
  for (const e of all().values())
    if (isActive(e) && ids.has(e.ticketId))
      void stopPreview(e.workspaceId, reason, actor).catch((err) => console.error('stop preview:', err))
}

/** The project is going, its tickets and workspaces with it. */
export function stopProjectPreviews(projectId: number, actor: string) {
  const ids = db
    .select({ id: schema.tickets.id })
    .from(schema.tickets)
    .where(eq(schema.tickets.projectId, projectId))
    .all()
    .map((t) => t.id)
  if (ids.length) stopPreviewsFor(ids, 'the project was deleted', actor)
}

/** The workspace is going: stop its preview and forget it. Call before the row is deleted. */
export function forgetPreview(workspaceId: number, actor: string) {
  const e = all().get(workspaceId)
  if (!e) return
  if (isActive(e))
    void stopPreview(workspaceId, 'the workspace was removed', actor)
      .catch((err) => console.error('stop preview:', err))
      .finally(() => {
        all().delete(workspaceId)
        save()
      })
  else {
    all().delete(workspaceId)
    save()
  }
}

/** A log of the preview, for the "full log" link. */
export function previewLog(workspaceId: number, name: 'build' | 'server') {
  const e = all().get(workspaceId)
  if (!e) throw new HttpError(404, 'the board never ran a preview of this workspace')
  try {
    return fs.readFileSync(e.logs[name], 'utf8')
  } catch {
    throw new HttpError(404, `no ${name} log yet`)
  }
}

/** The board is going down: every preview goes with it (synchronously, there is no later). */
export function stopAllPreviews() {
  if (!kept.entries) return
  const now = new Date().toISOString()
  for (const e of kept.entries.values()) {
    if (!isActive(e)) continue
    if (e.pid) runner.killTreeSync(e.pid)
    if (e.url) clearUrl(e.workspaceId, e.url)
    Object.assign(e, { status: 'stopped', step: null, pid: null, port: null, url: null, stoppedAt: now })
    e.reason = RESTARTED
  }
  save()
}

/** Stop the previews when the board exits or is told to stop. Once per process. */
export function stopPreviewsOnExit() {
  if (kept.hooked) return
  kept.hooked = true
  process.once('exit', stopAllPreviews)
  // The server's own handler closes it gracefully but leaves the process to exit on its own.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, stopAllPreviews)
}

// What the board remembers from before it started is settled as it loads, before any request reads a
// workspace's link.
all()
