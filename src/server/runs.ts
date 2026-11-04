import { execFile, spawn as nodeSpawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

import Database from 'better-sqlite3'
import { and, asc, eq, inArray } from 'drizzle-orm'

import { db, schema } from '#/db'
import { readPreviewLimit } from '#/lib/constants'
import { DEFAULT_RUN, RUN_PORTS, type RunType, runSlug } from '#/lib/runs'
import { logActivity } from './activity'
import { authMode, config, uploadsDir } from './config'
import { toolProblem } from './hostTools'
import { HttpError, notFound } from './http'
import { checkPreview } from './preview'
import { deleteRunConfig, getRunConfig, listRunConfigs, type RunConfig, seedRepo } from './runConfig'
import { kindOf, listStages } from './stages'
import { noteBoardEvent } from './workTimeline'

/**
 * Runs: long-running processes the board starts itself from a ticket's worktree, as the human
 * configured them for the worktree's repo (runConfig.ts). A preview answers on a port and gets a link;
 * a job is a background worker with no link. Each goes install (when needed), build, a copy of the live
 * data (when the run asks for one), then its start command, and is stopped by the board: by a Stop,
 * when its ticket closes, is archived or its PR merges, and with the board itself. Agents start them
 * by name and never say what runs: the commands are the stored ones.
 *
 * What runs is kept in memory. `previews.json` in the data dir only remembers the last state of each,
 * so after a restart the ticket page can say that one was stopped when the board restarted; nothing
 * is started again on its own.
 */

export type RunStatus = 'building' | 'starting' | 'running' | 'failed' | 'stopped'
/** While building: installing dependencies, building, copying the live data; then the start command. */
export type RunStep = 'install' | 'build' | 'copy' | 'server'

export interface RunState {
  workspaceId: number
  ticketId: number
  /** The run config it runs, and what it was called and was when it started. */
  runId: number
  runName: string
  runType: RunType
  repoId: number
  status: RunStatus
  step: RunStep | null
  /** The port it holds while starting or running (a preview's). */
  port: number | null
  /** The process it is waiting on: a step while building, the start command once it starts. */
  pid: number | null
  /** Where a preview answers while running; also set as the workspace's previewUrl. Never a job's. */
  url: string | null
  startedAt: string
  runningAt: string | null
  stoppedAt: string | null
  /** Why it failed or stopped. */
  reason: string | null
  /**
   * The last lines of a log, and which: while it builds or runs, of the log it is writing; once it
   * failed, of the log that explains the failure.
   */
  tail: string[]
  tailLog: 'build' | 'server' | null
  /** The worktree it runs from. */
  path: string
  /** Absolute paths of its logs: install and build, then the start command's. */
  logs: { build: string; server: string }
}

const ACTIVE = new Set<RunStatus>(['building', 'starting', 'running'])
export const isActive = (p: Pick<RunState, 'status'> | null | undefined) => !!p && ACTIVE.has(p.status)

/**
 * At most this many build or run at once, board-wide, previews and jobs alike: the human's preview
 * limit (`previewLimit` in the settings, 8 by default).
 */
export function previewLimit(): number {
  const row = db.select().from(schema.settings).where(eq(schema.settings.key, 'previewLimit')).get()
  return readPreviewLimit(row?.value)
}
export const PORTS = RUN_PORTS
const READY_MS = 90_000
const WIN = process.platform === 'win32'
export const RESTARTED = 'stopped when the board restarted'

// --- where a run may run from ---

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
 * Whether the workspace's path is a worktree the board may act on: a git worktree of the repo sitting
 * next to that repo's main checkout (`../<repo>-<branch>`), never the main checkout or the board's own
 * folder. `path` is its real path. The path comes from the workspace the agent registered, never from
 * the request.
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
    // A running run must not keep the board alive as it shuts down.
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
/** Tests run against a fake; `null` puts the real one back. */
export function setPreviewRunner(r: PreviewRunner | null) {
  runner = r ?? realRunner
}

// --- state ---

type Entry = RunState & { dataDir: string | null }
const keyOf = (workspaceId: number, runId: number) => `${workspaceId}:${runId}`
const keyOfEntry = (e: Pick<RunState, 'workspaceId' | 'runId'>) => keyOf(e.workspaceId, e.runId)

/**
 * What runs outlives this module. The board hot-reloads its server code (`vite dev`), and a reload
 * evaluates this module again: kept here, the runs, the port queue and the exit hook survive it, so a
 * reload neither forgets a run that is still running (and its port) nor hooks the exit twice. A
 * restart of the board starts from previews.json instead.
 */
interface Kept {
  entries: Map<string, Entry> | undefined
  portQueue: Promise<unknown>
  hooked: boolean
  /** Runs (workspace:run) a restart is replacing: their slot stays taken meanwhile. */
  restarting: Set<string>
  /**
   * Each start's work until it settles, stopped ones too: a stop kills the run's process, but the copy
   * of the live data has none and goes on writing into the worktree until it ends.
   */
  settling: Map<Entry, Promise<void>>
  /** The folders of worktrees being removed, each removal's as its match: no run starts there. */
  removing: Set<(path: string) => boolean>
}
export const KEPT = Symbol.for('agent-board.runs')
const kept = ((globalThis as { [KEPT]?: Kept })[KEPT] ??= {
  entries: undefined,
  portQueue: Promise.resolve(),
  hooked: false,
  restarting: new Set<string>(),
  settling: new Map<Entry, Promise<void>>(),
  removing: new Set<(path: string) => boolean>(),
})
const stateFile = () => path.join(config.dataDir, 'previews.json')

function save() {
  try {
    fs.writeFileSync(stateFile(), JSON.stringify([...all().values()], null, 2))
  } catch (err) {
    console.error('could not save the run state:', err)
  }
}

/** The repo a workspace's worktree is of: its own, else its ticket's primary repo. */
function workspaceRepoId(ws: Pick<schema.Workspace, 'repoId' | 'ticketId'>): number | null {
  if (ws.repoId) return ws.repoId
  const t = db.select().from(schema.tickets).where(eq(schema.tickets.id, ws.ticketId)).get()
  return t ? primaryRepoIdOf(t) : null
}

/** The ticket's primary repo: its own, else the project's first (lowest name, then id). */
function primaryRepoIdOf(t: Pick<schema.Ticket, 'projectId' | 'repoId'>): number | null {
  if (t.repoId) return t.repoId
  return (
    db
      .select({ id: schema.repos.id })
      .from(schema.repos)
      .where(eq(schema.repos.projectId, t.projectId))
      .orderBy(asc(schema.repos.name), asc(schema.repos.id))
      .get()?.id ?? null
  )
}

/**
 * A repo's preview the old single-preview API means (`start_preview`, the Previews page): its first
 * preview-type run, the seeded `Preview` on a checkout of the board. Null when it has none.
 */
export function defaultRunOf(repoId: number | null): RunConfig | null {
  if (!repoId) return null
  try {
    return listRunConfigs(repoId).find((r) => r.type === 'preview') ?? null
  } catch {
    return null
  }
}

/**
 * The runs, loaded once: what the board remembers from before it started. Nothing is started again;
 * one that was building or running is stopped, and its link cleared. A preview remembered from before
 * runs were configurable is its workspace's default run's.
 */
function all(): Map<string, Entry> {
  if (kept.entries) return kept.entries
  const entries = (kept.entries = new Map<string, Entry>())
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
    if (typeof e.runId !== 'number') {
      changed = true
      const repoId = workspaceRepoId(ws)
      const repo = repoId ? db.select().from(schema.repos).where(eq(schema.repos.id, repoId)).get() : null
      if (repo) seedRepo(repo)
      const run = defaultRunOf(repoId)
      if (!run) continue
      Object.assign(e, {
        runId: run.id,
        runName: run.name,
        runType: run.type,
        repoId: run.repoId,
        dataDir: e.dataDir ?? path.join(e.path, 'data', 'preview'),
      })
    } else if (!db.select().from(schema.runConfigs).where(eq(schema.runConfigs.id, e.runId)).get()) {
      changed = true
      continue
    }
    if (isActive(e)) {
      changed = true
      if (e.url && ws.previewUrl === e.url) clearUrl(e.workspaceId, e.url)
      Object.assign(e, { status: 'stopped', step: null, pid: null, port: null, url: null, stoppedAt: now })
      e.reason = RESTARTED
    }
    entries.set(keyOfEntry(e), e)
  }
  if (changed) save()
  return entries
}

/** What a log says lately: its last lines (30 at most, each cut at 400 characters). */
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

/** The state as reads hand it out; one that builds or runs carries the tail of the log it writes. */
function view({ dataDir: _dataDir, ...e }: Entry): RunState {
  if (!isActive(e)) return { ...e, tail: [...e.tail] }
  const log = e.status === 'building' && e.step !== 'server' ? 'build' : 'server'
  return { ...e, tail: tailOf(e.logs[log]), tailLog: log }
}

/** The state of one run of a workspace, or null when the board never ran it there. */
export function runState(workspaceId: number, runId: number): RunState | null {
  const e = all().get(keyOf(workspaceId, runId))
  return e ? view(e) : null
}

/** Every run the board started from the workspace, as it last was. */
export function workspaceRuns(workspaceId: number): RunState[] {
  return [...all().values()].filter((e) => e.workspaceId === workspaceId).map(view)
}

/** Every run the board is building or running, for the cleanup report. */
export function activeRuns(): RunState[] {
  return [...all().values()].filter(isActive).map(view)
}

function getWorkspace(id: number) {
  const ws = db.select().from(schema.workspaces).where(eq(schema.workspaces.id, id)).get()
  if (!ws) throw notFound('workspace')
  return ws
}
const ticketOf = (id: number) => db.select().from(schema.tickets).where(eq(schema.tickets.id, id)).get()!

function log(e: Pick<RunState, 'ticketId' | 'workspaceId' | 'runName'>, actor: string, text: string) {
  const ticket = db.select().from(schema.tickets).where(eq(schema.tickets.id, e.ticketId)).get()
  // Gone with its ticket: nothing to log it on.
  if (!ticket) return
  const ws = db.select().from(schema.workspaces).where(eq(schema.workspaces.id, e.workspaceId)).get()
  logActivity({
    projectId: ticket.projectId,
    actor,
    kind: 'workspace',
    text: `${text} of workspace ${ws?.name ?? e.workspaceId} on #${ticket.id} (run ${e.runName})`,
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

/**
 * Why no preview of the board itself can start on this machine, as the last check of its tools found:
 * a build runs pnpm, which needs node on the PATH. Null when both were found (or no check ended yet).
 */
export const previewToolProblem = () => toolProblem('pnpm') ?? toolProblem('node')

/**
 * The tool a run's commands need that the last check did not find: pnpm (and node with it) when one
 * starts with pnpm, node for node, npm, npx or yarn. Other programs are not checked. Null when fine.
 */
export function runToolProblem(run: Pick<RunConfig, 'install' | 'build' | 'start'>): string | null {
  const first = [run.install, run.build, run.start].map((c) => c.trim().split(/\s+/)[0] ?? '')
  if (first.includes('pnpm')) return previewToolProblem()
  if (first.some((p) => ['node', 'npm', 'npx', 'yarn'].includes(p))) return toolProblem('node')
  return null
}

const article = (type: RunType) => (type === 'preview' ? 'a preview' : 'a job')

/** Whether the repo is one of the ticket's: its primary, or one of its project's it lists. */
function isTicketRepo(ticket: schema.Ticket, repo: schema.Repo) {
  if (repo.id === primaryRepoIdOf(ticket)) return true
  if (repo.projectId !== ticket.projectId) return false
  return !!db
    .select({ repoId: schema.ticketRepos.repoId })
    .from(schema.ticketRepos)
    .where(and(eq(schema.ticketRepos.ticketId, ticket.id), eq(schema.ticketRepos.repoId, repo.id)))
    .get()
}

/**
 * Why no run at all may start from the workspace, whatever the run: a preview board, a finished
 * ticket, a repo the ticket does not span, a path that is not a worktree of its repo the board may act
 * on, one being removed. Null when runs may start there.
 */
export function workspaceCannotRun(workspaceId: number): string | null {
  if (authMode().boardEnv === 'development')
    return 'runs are started by the live board (or a test-mode one), not by a preview'
  const ws = getWorkspace(workspaceId)
  const ticket = ticketOf(ws.ticketId)
  if (ticket.archivedAt) return 'the ticket is archived'
  const kind = kindOf(listStages(ticket.projectId), ticket.status)
  if (kind === 'done' || kind === 'cancelled') return `the ticket is ${kind}`
  const repoId = workspaceRepoId(ws)
  const repo = repoId
    ? (db.select().from(schema.repos).where(eq(schema.repos.id, repoId)).get() ?? null)
    : null
  // A worktree of a repo taken off the ticket has nothing left to run for it.
  if (repo && !isTicketRepo(ticket, repo)) return `${repo.name} is not one of ticket ${ticket.id}'s repos`
  const target = worktreeTarget(ws, repo)
  if (!target.ok) return target.reason
  if ([...kept.removing].some((at) => at(target.path))) return 'its worktree is being removed'
  return null
}

/** Whether a start would be refused before anything runs; null when it may start. */
export function cannotStartRun(workspaceId: number, runId: number): string | null {
  const run = getRunConfig(runId)
  const refused = workspaceCannotRun(workspaceId)
  if (refused) return refused
  const ws = getWorkspace(workspaceId)
  if (run.repoId !== workspaceRepoId(ws)) return `${run.name} is a run of another repo than the workspace's`
  const tools = runToolProblem(run)
  if (tools) return tools
  const target = real(ws.path)!
  const here = (e: Entry) => isActive(e) && norm(e.path) === norm(target)
  const other = [...all().values()].find((e) => here(e) && e.runId === runId && e.workspaceId !== workspaceId)
  if (other)
    return `workspace ${other.workspaceId} already runs ${article(run.type)} from ${target} (${run.name})`
  // Runs that copy the live data share its folder in the worktree.
  const copying = run.copyData
    ? [...all().values()].find((e) => here(e) && e.runId !== runId && e.dataDir === dataDirOf(target))
    : undefined
  return copying ? `${copying.runName} already uses ${dataDirOf(target)}` : null
}

// --- start, stop ---

const dataDirOf = (worktree: string) => path.join(worktree, 'data', 'preview')
const runsDirOf = (worktree: string) => path.join(worktree, 'data', 'runs')

/** A folder the board fills in a worktree, kept out of git: its files would read as changes there. */
function ownFolder(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
  const ignore = path.join(dir, '.gitignore')
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n')
}

/**
 * Build and run one run of the workspace's worktree, in the background: install (when needed), build,
 * copy the live data (when the run does), start it, and for a preview set the workspace's previewUrl
 * once it answers. Returns at once, building.
 */
export function startRun(
  workspaceId: number,
  runId: number,
  actor: string,
  opts: { replacing?: boolean } = {},
): RunState {
  const ws = getWorkspace(workspaceId)
  const refused = cannotStartRun(workspaceId, runId)
  if (refused) throw new HttpError(400, refused)
  const run = getRunConfig(runId)
  const repo = db.select().from(schema.repos).where(eq(schema.repos.id, run.repoId)).get()!
  const target = worktreeTarget(ws, repo) as { ok: true; path: string }
  const before = all().get(keyOf(workspaceId, runId))
  if (isActive(before))
    throw new HttpError(
      409,
      `its ${run.type} ${run.name} is already ${before!.status}: stop it first, or restart it`,
    )
  // A restart puts back the one it just stopped: it adds none, so the limit does not stop it.
  if (!opts.replacing) assertRoom()
  const dataDir = run.copyData ? dataDirOf(target.path) : null
  const logs = dataDir
    ? path.join(dataDir, 'logs')
    : path.join(runsDirOf(target.path), runSlug(run.name), 'logs')
  const e: Entry = {
    workspaceId,
    ticketId: ws.ticketId,
    runId,
    runName: run.name,
    runType: run.type,
    repoId: run.repoId,
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
  stopRunsOnExit()
  all().set(keyOfEntry(e), e)
  save()
  log(e, actor, `started ${article(run.type)}`)
  notePreview(e, 'building')
  const going = go(e, run)
    .catch((err: unknown) => fail(e, `could not start: ${(err as Error).message ?? err}`, null))
    .finally(() => kept.settling.delete(e))
  kept.settling.set(e, going)
  return view(e)
}

/**
 * Settles once the runs the board started from a folder `at` takes (a run's real path) settle,
 * stopped ones included: a stop returns at once, while the step it caught may still be writing into
 * the worktree (the copy of the live data, which no process holds). The runs are those there as it is
 * called: one started after that is not waited for. What removes the worktree waits for this.
 */
export function runsSettled(at: (path: string) => boolean): Promise<void> {
  const settling = [...kept.settling].filter(([e]) => at(e.path)).map(([, settled]) => settled)
  return Promise.all(settling).then(() => {})
}

/**
 * No run starts from a folder `at` takes (a run's real path) until the returned release is called:
 * what removes a worktree holds its folder from before it stops the runs there until it is done, so
 * none starts from a folder going away.
 */
export function holdRuns(at: (path: string) => boolean): () => void {
  // Its own: the same match held twice is released once each.
  const hold = (p: string) => at(p)
  kept.removing.add(hold)
  return () => void kept.removing.delete(hold)
}

/** Still the run being started: not stopped, restarted or forgotten meanwhile. */
const current = (e: Entry) => all().get(keyOfEntry(e)) === e && isActive(e)

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

const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'poetry.lock', 'uv.lock']

/** The hash of the worktree's lockfile (the first there is, `requirements*.txt` last), null for none. */
function lockHash(dir: string): string | null {
  let names: string[] = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return null
  }
  const file =
    LOCKFILES.find((f) => names.includes(f)) ?? names.filter((f) => /^requirements.*\.txt$/.test(f)).sort()[0]
  if (!file) return null
  try {
    const text = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n')
    return `${file}:${createHash('sha256').update(text).digest('hex')}`
  } catch {
    return null
  }
}

const installedFile = (dir: string) => path.join(runsDirOf(dir), '.installed.json')

function installedHashes(dir: string): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(installedFile(dir), 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}

/**
 * Whether a run's install command has to run in the worktree: a pnpm project as `needsInstall` says;
 * any other one unless its lockfile is the one the last successful install of that command there saw.
 */
function installNeeded(dir: string, command: string) {
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return needsInstall(dir)
  const hash = lockHash(dir)
  return hash === null || installedHashes(dir)[command] !== hash
}

function rememberInstall(dir: string, command: string) {
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return
  const hash = lockHash(dir)
  if (!hash) return
  try {
    ownFolder(runsDirOf(dir))
    fs.writeFileSync(
      installedFile(dir),
      JSON.stringify({ ...installedHashes(dir), [command]: hash }, null, 2),
    )
  } catch {
    // The next start installs again.
  }
}

// The live board's tailnet entrance: a run stays on this machine (README: "Using it from other devices").
// PUBLIC_GATE_URL, PUBLIC_GATE_AUTH_URL and TAILNET_HOST are the earlier entrance's names, which a
// preview of an older branch still reads (and refuses to start on, given only some of them).
const ENTRANCE_KEYS = /^(PUBLIC_ORIGIN|PUBLIC_GATE_URL|PUBLIC_GATE_AUTH_URL|TAILNET_HOST)$/

/** The environment of what runs in the worktree: none of the live board's own settings. */
export function worktreeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env))
    if (
      /^(NODE_ENV|PORT|HOST|NITRO_\w+|DATA_DIR|BOARD_URL|BOARD_ENV|AUTH|DEV_HUMAN|TEST_HUMAN|STORAGE|S3_\w+)$/.test(
        key,
      ) ||
      ENTRANCE_KEYS.test(key)
    )
      delete env[key]
  return env
}

// Run inside a run's Node process: it exits within a few seconds of the board, whichever way the
// board went (`pnpm stop` ends it without a chance to clean up).
const WATCHDOG = `data:text/javascript,${encodeURIComponent(
  'const p=Number(process.env.PREVIEW_PARENT_PID);if(p)setInterval(()=>{try{process.kill(p,0)}catch(e){if(e.code==="ESRCH")process.exit(0)}},2000).unref()',
)}`

/**
 * The Node that runs a `node …` start command: this board's own, but in the desktop app (README:
 * "Install"), where the board runs under Electron's Node, the `node` on PATH that the build used: a
 * worktree's native modules are built for Node's ABI, not Electron's.
 */
export const previewNode = (
  electron: string | undefined = process.versions.electron,
  execPath = process.execPath,
) => (electron ? 'node' : execPath)

const withPort = (value: string, port: number | null) =>
  port === null ? value : value.replaceAll('{port}', String(port))

/**
 * What a run's start command runs with: the worktree's environment, the run's own variables (`{port}`
 * in a value is its port), and what the board sets itself: for a preview its port on loopback, for a
 * run with a copy of the live data that copy, and the board's pid for the watchdog.
 */
export function runEnv(
  run: Pick<RunConfig, 'type' | 'env' | 'copyData'>,
  port: number | null,
  dataDir: string | null,
): NodeJS.ProcessEnv {
  return {
    ...worktreeEnv(),
    ...Object.fromEntries(Object.entries(run.env).map(([k, v]) => [k, withPort(v, port)])),
    ...(run.type === 'preview' ? { HOST: '127.0.0.1', PORT: String(port) } : {}),
    ...(run.copyData && dataDir ? { DATA_DIR: dataDir } : {}),
    PREVIEW_PARENT_PID: String(process.pid),
  }
}

/** The board's own preview's server: a development board with sign-in off, on loopback, on its own data copy. */
export const serverEnv = (port: number, dataDir: string) => runEnv(DEFAULT_RUN, port, dataDir)

// Arguments `node` can take as they are, without a shell to read quotes, variables or globs.
const PLAIN_ARGS = /^[\w./:@+,=-]+(\s+[\w./:@+,=-]+)*$/

/**
 * How the start command is spawned. `node <plain args>` runs under the board's own Node with the
 * watchdog loaded, as the board's preview always ran; anything else through the shell, with the
 * watchdog in NODE_OPTIONS for whatever Node it starts.
 */
function startSpawn(start: string, env: NodeJS.ProcessEnv) {
  const m = /^node\s+(.+)$/.exec(start.trim())
  if (m && PLAIN_ARGS.test(m[1]!.trim()))
    return { command: previewNode(), args: ['--import', WATCHDOG, ...m[1]!.trim().split(/\s+/)], env }
  const options = [env.NODE_OPTIONS, `--import=${WATCHDOG}`].filter(Boolean).join(' ')
  return { command: start, args: [], env: { ...env, NODE_OPTIONS: options }, shell: true }
}

async function go(e: Entry, run: RunConfig) {
  if (e.dataDir) await fs.promises.rm(e.dataDir, { recursive: true, force: true })
  else await fs.promises.rm(path.dirname(e.logs.build), { recursive: true, force: true })
  await fs.promises.mkdir(path.dirname(e.logs.build), { recursive: true })
  ownFolder(e.dataDir ?? runsDirOf(e.path))
  const env = worktreeEnv()
  const step = async (name: RunStep, command: string) => {
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
  if (run.install && installNeeded(e.path, run.install)) {
    if (!(await step('install', run.install))) return
    rememberInstall(e.path, run.install)
  }
  if (run.build && !(await step('build', run.build))) return

  if (e.dataDir) {
    e.step = 'copy'
    await runner.copyData(e.dataDir)
    if (!current(e)) return
  }

  e.status = 'starting'
  e.step = 'server'
  let port: number | null = null
  if (run.type === 'preview') {
    const taken = await takePort(e, run.port)
    if (!current(e)) return
    if (typeof taken === 'string') return fail(e, taken, null)
    port = taken
  }
  const start = startSpawn(withPort(run.start, port), runEnv(run, port, e.dataDir))
  const proc = runner.spawn(start.command, start.args, {
    cwd: e.path,
    env: start.env,
    log: e.logs.server,
    ...(start.shell ? { shell: true } : {}),
  })
  e.pid = proc.pid ?? null
  save()
  let exited: number | null | undefined
  const what = run.type === 'preview' ? 'the server' : 'the job'
  void proc.exited.then((code) => {
    exited = code
    if (current(e) && e.pid === proc.pid)
      fail(e, `${what} exited${code === null ? '' : ` (exit ${code})`}`, 'server')
  })
  if (run.type === 'job') {
    // A job has nothing to answer: running once its process is.
    await new Promise((r) => setTimeout(r, 0))
    if (!current(e) || exited !== undefined) return
    Object.assign(e, { status: 'running', step: null, runningAt: new Date().toISOString() })
    save()
    return
  }
  const base = `http://127.0.0.1:${port}`
  const health = run.healthPath && run.healthPath !== '/' ? `${base}${run.healthPath}` : base
  for (const until = Date.now() + READY_MS; Date.now() < until; ) {
    if (!current(e) || exited !== undefined) return
    if (await runner.answers(health)) {
      if (!current(e)) return
      e.status = 'running'
      e.step = null
      e.url = base
      e.runningAt = new Date().toISOString()
      db.update(schema.workspaces)
        .set({ previewUrl: base })
        .where(eq(schema.workspaces.id, e.workspaceId))
        .run()
      save()
      notePreview(e, `running ${base}`)
      return
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  if (!current(e)) return
  if (e.pid) await runner.killTree(e.pid)
  fail(e, `the server did not answer within ${READY_MS / 1000}s`, 'server')
}

// One allocation at a time (kept.portQueue), so two runs starting together never pick the same port.

/** The port a preview takes: its fixed one, or the first free from 47101; a string says why none. */
function takePort(e: Entry, fixed: number | null): Promise<number | string> {
  const next = kept.portQueue.then(async () => {
    const taken = new Set([...all().values()].filter((x) => x !== e && x.port).map((x) => x.port))
    if (fixed !== null) {
      if (fixed < PORTS.from || fixed > PORTS.to) return `port ${fixed} is outside ${PORTS.from}-${PORTS.to}`
      if (taken.has(fixed) || !(await runner.isFree(fixed))) return `port ${fixed} is in use`
      e.port = fixed
      return fixed
    }
    for (let port = PORTS.from; port <= PORTS.to; port++) {
      if (taken.has(port) || !(await runner.isFree(port))) continue
      e.port = port
      return port
    }
    return `no free port between ${PORTS.from} and ${PORTS.to}`
  })
  kept.portQueue = next.catch(() => {})
  return next
}

function fail(e: Entry, reason: string, from: 'build' | 'server' | null) {
  if (all().get(keyOfEntry(e)) !== e || !isActive(e)) return
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
  notePreview(e, `failed: ${reason}`)
}

/**
 * Stop one run of the workspace, building or running: kill its process tree, clear its link, free its
 * port. A run that is not running is left as it is (null when the board never ran it there).
 */
export async function stopRun(workspaceId: number, runId: number, reason: string, actor: string) {
  const e = all().get(keyOf(workspaceId, runId))
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
  log(e, actor, `stopped the ${e.runType} (${reason})`)
  notePreview(e, `stopped: ${reason}`)
  return view(e)
}

/**
 * A preview's states on its ticket's work timeline (building, running, failed, stopped); a run other
 * than the default Preview says its name. A job has no link to show there and records none.
 */
function notePreview(e: Pick<Entry, 'ticketId' | 'runType' | 'runName'>, what: string) {
  if (e.runType !== 'preview') return
  noteBoardEvent(e.ticketId, 'preview', {
    note: e.runName === DEFAULT_RUN.name ? what : `${e.runName} ${what}`,
  })
}

/**
 * How many build or run right now, board-wide; one a restart is replacing counts while it is being
 * stopped, so no other start takes its slot in the meantime.
 */
export const runsInUse = () =>
  [...all().values()].filter((e) => isActive(e) || kept.restarting.has(keyOfEntry(e))).length

/** A refusal when the preview limit is reached: as many build or run as the human allows. */
function assertRoom() {
  const running = runsInUse()
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
export async function restartRun(workspaceId: number, runId: number, actor: string) {
  getWorkspace(workspaceId)
  const refused = cannotStartRun(workspaceId, runId)
  if (refused) throw new HttpError(400, refused)
  const key = keyOf(workspaceId, runId)
  const replacing = isActive(all().get(key))
  if (!replacing) assertRoom()
  // Its slot stays taken while it is stopped (killing its processes takes a moment), so a start in
  // between cannot take it and leave the board over the limit once this one is back.
  const reserved = replacing && !kept.restarting.has(key)
  if (reserved) kept.restarting.add(key)
  try {
    await stopRun(workspaceId, runId, `restarted by ${actor}`, actor)
    return startRun(workspaceId, runId, actor, { replacing })
  } finally {
    if (reserved) kept.restarting.delete(key)
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

/** Whether a run builds or runs for any of these tickets or their lanes (in that repo, given one). */
export function hasRuns(ticketIds: number[], opts: { repoId?: number } = {}) {
  const ids = withLanes(ticketIds)
  return [...all().values()].some(
    (e) => isActive(e) && ids.has(e.ticketId) && (!opts.repoId || e.repoId === opts.repoId),
  )
}

const stopping = (e: Entry, reason: string, actor: string) =>
  void stopRun(e.workspaceId, e.runId, reason, actor).catch((err) => console.error('stop run:', err))

/**
 * Stop the runs of these tickets and their lanes (only those of one repo, given `repoId`): the work is
 * merged, done, cancelled or archived. Returns at once; the processes go in the background.
 */
export function stopRunsFor(
  ticketIds: number[],
  reason: string,
  actor = 'board',
  opts: { repoId?: number; lanes?: boolean } = {},
) {
  const ids = opts.lanes === false ? new Set(ticketIds) : withLanes(ticketIds)
  for (const e of all().values())
    if (isActive(e) && ids.has(e.ticketId) && (!opts.repoId || e.repoId === opts.repoId))
      stopping(e, reason, actor)
}

/** The project is going, its tickets and workspaces with it. */
export function stopProjectRuns(projectId: number, actor: string) {
  const ids = db
    .select({ id: schema.tickets.id })
    .from(schema.tickets)
    .where(eq(schema.tickets.projectId, projectId))
    .all()
    .map((t) => t.id)
  if (ids.length) stopRunsFor(ids, 'the project was deleted', actor)
}

/** Stop and forget the entries `which` picks: their workspace, run or repo is going. */
function forget(which: (e: Entry) => boolean, reason: string, actor: string) {
  for (const e of [...all().values()].filter(which)) {
    const drop = () => {
      if (all().get(keyOfEntry(e)) === e) all().delete(keyOfEntry(e))
      save()
    }
    if (isActive(e))
      void stopRun(e.workspaceId, e.runId, reason, actor)
        .catch((err) => console.error('stop run:', err))
        .finally(drop)
    else drop()
  }
}

/** The workspace is going: stop its runs and forget them. Call before the row is deleted. */
export function forgetWorkspaceRuns(workspaceId: number, actor: string) {
  forget((e) => e.workspaceId === workspaceId, 'the workspace was removed', actor)
}

/** The run config is going: stop it wherever it runs and forget it. Call before the row is deleted. */
export function forgetRunConfig(runId: number, actor: string) {
  forget((e) => e.runId === runId, 'its run was removed from the settings', actor)
}

/** Delete a run config, the human's or an agent's, stopping it wherever it builds or runs first. */
export function removeRunConfig(runId: number, actor: string) {
  getRunConfig(runId)
  forgetRunConfig(runId, actor)
  return deleteRunConfig(runId, actor)
}

/** The repo is going: stop its runs and forget them. Call before the row is deleted. */
export function forgetRepoRuns(repoId: number, actor: string) {
  forget((e) => e.repoId === repoId, 'the repo was removed', actor)
}

/** A log of the run, for the "full log" link. */
export function runLog(workspaceId: number, runId: number, name: 'build' | 'server') {
  const e = all().get(keyOf(workspaceId, runId))
  if (!e) throw new HttpError(404, 'the board never ran this run of the workspace')
  try {
    return fs.readFileSync(e.logs[name], 'utf8')
  } catch {
    throw new HttpError(404, `no ${name} log yet`)
  }
}

/** The board is going down: every run goes with it (synchronously, there is no later). */
export function stopAllRuns() {
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

/** Stop the runs when the board exits or is told to stop. Once per process. */
export function stopRunsOnExit() {
  if (kept.hooked) return
  kept.hooked = true
  process.once('exit', stopAllRuns)
  // The server's own handler closes it gracefully but leaves the process to exit on its own.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, stopAllRuns)
}

// What the board remembers from before it started is settled as it loads, before any request reads a
// workspace's link.
all()
