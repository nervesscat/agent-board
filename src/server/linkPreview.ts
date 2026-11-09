import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { and, eq, inArray, isNull } from 'drizzle-orm'

import { db, schema } from '#/db'
import { logActivity } from './activity'
import { authMode, config } from './config'
import { HttpError, notFound } from './http'
import { activePreviews, worktreeTarget } from './managedPreview'
import { activeRuns, stopRun } from './runs'
import { forgetPreviewState, isLocalUrl } from './preview'
import { getProject } from './projects'
import { exec, type Listener, listenersOn, WIN } from './listeners'
import { workspaceRepo } from './ticketRepos'

export {
  hostPort,
  type Listener,
  listeningAddresses,
  listenersOn,
  parseLsof,
  parseNetstat,
  parseSs,
} from './listeners'

/**
 * Stopping a link preview: a server an agent started itself from its worktree (`pnpm dev`, `vite dev`)
 * and registered with set_preview. The board did not start it, so it stops one only when it can tell
 * the process is that worktree's:
 *
 * - the link is on loopback, on a port that is neither the board's nor a preview the board runs;
 * - the workspace's path is a worktree the board may act on (`worktreeTarget`: a git worktree of the
 *   ticket's repo next to its main checkout, never the main checkout or the board's folder);
 * - something listens on that port, and every listening process runs from inside that worktree: its
 *   executable, an argument that is a path (not on macOS, where `ps` cannot tell where one ends), or
 *   its working directory (where the OS gives it) is the worktree or under it, after resolving `..`,
 *   without regard to case on Windows. The worktree is its real path, and the path as registered only
 *   when that is the same folder.
 *
 * It then kills each listening process with everything it started. A stop always looks again at the
 * moment it is asked; only the Previews page's answer reuses what it read about a process lately.
 *
 * A preview board (development) stops none: it runs on a copy of the live data, so its links point at
 * the servers agents really run for the live board.
 */

/** The port a link points at: its own, or 80/443 by its scheme. */
export function linkPort(url: string): number | null {
  try {
    const u = new URL(url)
    return Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
  } catch {
    return null
  }
}

// --- what a process runs ---

export interface ProcessInfo {
  pid: number
  /** The executable's path, when the OS gives it. */
  exe: string | null
  /** Its command line, the executable first. */
  args: string[]
  /** Its working directory, where the OS gives it (not on Windows). */
  cwd: string | null
}

/** A Windows command line into its arguments, by its quotes. */
export function splitCommandLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  let any = false
  for (const ch of line) {
    if (ch === '"') {
      quoted = !quoted
      any = true
    } else if (!quoted && /\s/.test(ch)) {
      if (cur || any) out.push(cur)
      cur = ''
      any = false
    } else cur += ch
  }
  if (cur || any) out.push(cur)
  return out
}

const readLink = (p: string) => {
  try {
    return fs.readlinkSync(p)
  } catch {
    return null
  }
}

// What the Previews page was told about a process, for its next look: reading a command line on Windows
// starts PowerShell, a second or more, and the page asks every 15 s. A stop never reads from here.
const SEEN_MS = 60_000
const seen = new Map<number, { at: number; info: ProcessInfo }>()

/**
 * The command line (and where the OS says, the working directory) of each process, in one go. `cached`
 * takes what was read about a pid in the last minute (the page only shows it; a stop reads afresh).
 */
export async function processesOf(
  pids: number[],
  opts: { cached?: boolean } = {},
): Promise<Map<number, ProcessInfo>> {
  const now = Date.now()
  for (const [pid, s] of seen) if (now - s.at >= SEEN_MS) seen.delete(pid)
  const ids = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0)
  const known = opts.cached ? ids.filter((p) => seen.has(p)) : []
  const found = await readProcesses(ids.filter((p) => !known.includes(p)))
  for (const info of found.values()) seen.set(info.pid, { at: now, info })
  for (const pid of known) found.set(pid, seen.get(pid)!.info)
  return found
}

async function readProcesses(ids: number[]): Promise<Map<number, ProcessInfo>> {
  const found = new Map<number, ProcessInfo>()
  if (!ids.length) return found
  if (WIN) {
    // wmic is gone from recent Windows; CIM answers for every pid at once.
    const filter = ids.map((p) => `ProcessId=${p}`).join(' OR ')
    const script =
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8;' +
      `ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter '${filter}' | ` +
      'Select-Object ProcessId,ExecutablePath,CommandLine)'
    const out = await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])
    const rows = JSON.parse(out.trim() || '[]') as {
      ProcessId: number
      ExecutablePath: string | null
      CommandLine: string | null
    }[]
    for (const r of rows)
      found.set(r.ProcessId, {
        pid: r.ProcessId,
        exe: r.ExecutablePath || null,
        args: r.CommandLine ? splitCommandLine(r.CommandLine) : [],
        cwd: null,
      })
  } else if (fs.existsSync('/proc/self/cmdline')) {
    for (const pid of ids) {
      let cmdline: string
      try {
        cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      } catch {
        continue
      }
      found.set(pid, {
        pid,
        exe: readLink(`/proc/${pid}/exe`),
        args: cmdline.split('\0').filter(Boolean),
        cwd: readLink(`/proc/${pid}/cwd`),
      })
    }
  } else {
    // macOS: no /proc. lsof gives the working directory and the executable, each whole.
    for (const pid of ids) {
      const out = await exec('lsof', ['-a', '-p', String(pid), '-d', 'cwd,txt', '-Ffn']).catch(() => '')
      const info = parseLsofProcess(pid, out)
      if (info) found.set(pid, info)
    }
  }
  return found
}

/**
 * A macOS process from `lsof -a -p <pid> -d cwd,txt -Ffn`: its working directory, and its executable
 * (the first `txt` file; the rest are the libraries it loaded). No arguments: `ps` prints them joined by
 * spaces, so `<worktree> copy/server.js` could not be told from `<worktree>` and `copy/server.js`, and
 * a fragment of a path must never count as one.
 */
export function parseLsofProcess(pid: number, out: string): ProcessInfo | null {
  let fd: string | null = null
  let cwd: string | null = null
  let exe: string | null = null
  let ours = false
  let seen = false
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('p')) {
      ours = Number(line.slice(1)) === pid
      seen ||= ours
      fd = null
    } else if (line.startsWith('f')) fd = line.slice(1)
    else if (line.startsWith('n') && ours) {
      if (fd === 'cwd') cwd ??= line.slice(1)
      else if (fd === 'txt') exe ??= line.slice(1)
    }
  }
  // Gone meanwhile: nothing to say about it.
  return seen ? { pid, exe, args: [], cwd } : null
}

// --- inside a worktree ---

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

/** Whether `p` is `root` or under it: on a path boundary, `..` resolved (`<wt>-other` is not `<wt>`). */
export function isInside(p: string, root: string) {
  const a = norm(p)
  const b = norm(root)
  return a === b || a.startsWith(b + path.sep)
}

/** The paths a process names: its executable, its arguments that are paths (`--x=<path>` too), its cwd. */
function pathsOf(info: ProcessInfo): string[] {
  const paths = new Set<string>()
  const add = (s: string | null | undefined) => {
    const p = s?.replace(/^["']|["']$/g, '')
    if (p && path.isAbsolute(p)) paths.add(p)
  }
  add(info.exe)
  add(info.cwd)
  for (const arg of info.args) {
    add(arg)
    const eq = arg.indexOf('=')
    if (eq > 0) add(arg.slice(eq + 1))
  }
  return [...paths]
}

/** Whether the process runs from inside one of `roots` (the worktree's real path, and its spelling as registered). */
export function runsFrom(info: ProcessInfo, roots: string[]) {
  return pathsOf(info).some((p) => {
    const resolved = real(p)
    return roots.some((root) => isInside(p, root) || (resolved !== null && isInside(resolved, root)))
  })
}

// --- the rule ---

type Refusal = { ok: false; status: 400 | 409; reason: string }
const refuse = (status: 400 | 409, reason: string): Refusal => ({ ok: false, status, reason })

interface Target {
  ok: true
  ws: schema.Workspace
  ticket: schema.Ticket
  port: number
  /** The worktree's real path. */
  worktree: string
  roots: string[]
}

/**
 * What can be said without looking at the processes: the link, its port and the worktree. `ownStopped`
 * judges it as it will be once the board-run preview of the workspace itself is stopped, for a caller
 * that stops that preview first: every other check stands, and that preview still holds its port, so a
 * link to it (its own url) stays refused.
 */
function linkTarget(ws: schema.Workspace, opts: { ownStopped?: boolean } = {}): Target | Refusal {
  if (!ws.previewUrl) return refuse(409, 'the workspace has no preview link')
  if (authMode().boardEnv === 'development')
    return refuse(400, 'links are stopped by the live board (or a test-mode one), not by a preview')
  if (!opts.ownStopped && activeRuns().some((r) => r.workspaceId === ws.id && r.runType === 'preview'))
    return refuse(
      409,
      'the board runs this preview itself: stop it with the Stop of a preview the board runs',
    )
  if (!isLocalUrl(ws.previewUrl))
    return refuse(400, `${ws.previewUrl} is not on this machine (localhost, 127.0.0.1 or [::1])`)
  const port = linkPort(ws.previewUrl)!
  if (port === config.port) return refuse(400, `:${port} is the board's own port`)
  const held = activePreviews().find((p) => p.port === port)
  if (held) return refuse(409, `:${port} is a preview the board runs (workspace ${held.workspaceId})`)
  const ticket = db.select().from(schema.tickets).where(eq(schema.tickets.id, ws.ticketId)).get()
  if (!ticket) return refuse(409, 'the ticket is gone')
  const target = worktreeTarget(ws, workspaceRepo(ws, ticket))
  if (!target.ok) return refuse(400, target.reason)
  return { ok: true, ws, ticket, port, worktree: target.path, roots: worktreeRoots(ws.path, target.path) }
}

/**
 * The port of a workspace's link when the rule could stop the server behind it, as far as that can be
 * told without looking at the processes (`linkTarget`); null when the rule refuses it before that.
 * `ownStopped`: as it will be once the workspace's own board-run preview is stopped.
 */
export function stoppableLinkPort(ws: schema.Workspace, opts: { ownStopped?: boolean } = {}): number | null {
  const t = linkTarget(ws, opts)
  return t.ok ? t.port : null
}

/**
 * What a process may name the worktree by: its real path (the one `worktreeTarget` checked), and the
 * path as registered only when that path, read as the rule reads it (`..` resolved first), is the same
 * folder, such as a symlink to the worktree. On Linux and macOS `<symlink>/..` is the parent of the
 * link's target to the OS but the folder holding the link to `path.resolve`: never a root then.
 */
export function worktreeRoots(registered: string, worktree: string): string[] {
  const roots = [worktree]
  const lexical = path.resolve(registered)
  const same = real(lexical)
  if (norm(lexical) !== norm(worktree) && same !== null && norm(same) === norm(worktree)) roots.push(lexical)
  return roots
}

/** The listening processes, if every one of them runs from the worktree. */
function judge(
  t: Target,
  listeners: Map<number, Listener[]>,
  processes: Map<number, ProcessInfo>,
): { ok: true; pids: number[] } | Refusal {
  const on = listeners.get(t.port) ?? []
  if (!on.length) return refuse(409, `nothing listens on :${t.port}`)
  if (on.some((l) => l.pid === null))
    return refuse(409, `something listens on :${t.port}, but the board cannot tell which process`)
  const pids = [...new Set(on.map((l) => l.pid!))]
  if (pids.includes(process.pid)) return refuse(409, `the board itself listens on :${t.port}`)
  for (const pid of pids) {
    const info = processes.get(pid)
    if (!info) return refuse(409, `the board cannot read the process on :${t.port} (pid ${pid})`)
    if (!runsFrom(info, t.roots))
      return refuse(409, `the process on :${t.port} (pid ${pid}) does not run from ${t.worktree}`)
  }
  return { ok: true, pids }
}

/** Look at the processes on the targets' ports, all in one go. */
async function look(targets: Target[], opts: { cached?: boolean } = {}) {
  const listeners = await listenersOn(targets.map((t) => t.port))
  const pids = [...listeners.values()].flat().flatMap((l) => (l.pid ? [l.pid] : []))
  const processes = await processesOf(pids, opts)
  return (t: Target) => judge(t, listeners, processes)
}

/**
 * For the Previews page: whether each workspace's link could be stopped right now (null) or why not.
 * One look at the listening processes for all of them, and only when a link on this machine could be.
 */
export async function linkStopReasons(workspaces: schema.Workspace[]): Promise<Map<number, string | null>> {
  const reasons = new Map<number, string | null>()
  const targets: Target[] = []
  for (const ws of workspaces) {
    const t = linkTarget(ws)
    if (t.ok) targets.push(t)
    else reasons.set(ws.id, t.reason)
  }
  if (!targets.length) return reasons
  let verdict: (t: Target) => ReturnType<typeof judge>
  try {
    verdict = await look(targets, { cached: true })
  } catch (err) {
    const reason = `the board could not look at the processes: ${(err as Error).message}`
    for (const t of targets) reasons.set(t.ws.id, reason)
    return reasons
  }
  for (const t of targets) {
    const v = verdict(t)
    reasons.set(t.ws.id, v.ok ? null : v.reason)
  }
  return reasons
}

// --- the stop ---

/** Kill a process and everything it started: `taskkill /T` on Windows, its descendants by ppid elsewhere. */
async function killTree(pid: number) {
  if (WIN)
    return new Promise<void>((resolve) =>
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve()),
    )
  // Not the process group, as for the board's own previews: a server an agent started is rarely the
  // leader of its group, and its group may hold the agent's shell.
  const children = new Map<number, number[]>()
  const table = await exec('ps', ['-A', '-o', 'pid=,ppid=']).catch(() => '')
  for (const line of table.split('\n')) {
    const [p, pp] = line.trim().split(/\s+/).map(Number)
    if (p && pp) children.set(pp, [...(children.get(pp) ?? []), p])
  }
  const tree: number[] = []
  for (const queue = [pid]; queue.length; ) {
    const p = queue.shift()!
    if (tree.includes(p)) continue
    tree.push(p)
    queue.push(...(children.get(p) ?? []))
  }
  for (const p of tree)
    try {
      process.kill(p, 'SIGKILL')
    } catch {
      // already gone
    }
}

export interface LinkStopped {
  workspaceId: number
  ticketId: number
  kind: 'link'
  port: number
  pids: number[]
  /** Whether the port was free again when the stop answered. */
  freed: boolean
}

const FREE_WITHIN_MS = 5_000

async function kill(t: Target, pids: number[], actor: string): Promise<LinkStopped> {
  await Promise.all(pids.map(killTree))
  let freed = false
  for (const until = Date.now() + FREE_WITHIN_MS; ; ) {
    freed = !(await listenersOn([t.port])).get(t.port)?.length
    if (freed || Date.now() > until) break
    await new Promise((r) => setTimeout(r, 150))
  }
  // The link stays (the row is still on the page, not running); what the check said about it goes.
  forgetPreviewState(t.ws.previewUrl)
  logActivity({
    projectId: t.ticket.projectId,
    actor,
    kind: 'workspace',
    text: `stopped the preview on :${t.port} (pid ${pids.join(', ')}) of workspace ${t.ws.name} on #${t.ticket.id}`,
    refType: 'ticket',
    refId: t.ticket.id,
  })
  return { workspaceId: t.ws.id, ticketId: t.ticket.id, kind: 'link', port: t.port, pids, freed }
}

/** Stop the server behind a workspace's link, if the rule above allows it; refused with why otherwise. */
export async function stopLinkPreview(workspaceId: number, actor: string): Promise<LinkStopped> {
  const ws = db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get()
  if (!ws) throw notFound('workspace')
  const t = linkTarget(ws)
  if (!t.ok) throw new HttpError(t.status, t.reason)
  const v = (await look([t]))(t)
  if (!v.ok) throw new HttpError(v.status, v.reason)
  return kill(t, v.pids, actor)
}

export interface StopAll {
  stopped: (LinkStopped | { workspaceId: number; ticketId: number; kind: 'managed'; port: number | null })[]
  /** Running links the board would not stop, and why. */
  skipped: { workspaceId: number; ticketId: number; reason: string }[]
}

/**
 * Stop every preview of the project (its tickets and lanes, archived ones aside): the ones the board
 * runs, building or running, and the links on this machine that something listens on and that the rule
 * allows. Links off this machine and links nothing listens on are left out; the other links are skipped
 * with the reason. A workspace whose preview the board ran can still link an agent's own server (one it
 * linked while the board's was building, or after): its link is read again once that preview stopped.
 */
export async function stopProjectLinksAndPreviews(projectId: number, actor: string): Promise<StopAll> {
  getProject(projectId)
  const ticketIds = db
    .select({ id: schema.tickets.id })
    .from(schema.tickets)
    .where(and(eq(schema.tickets.projectId, projectId), isNull(schema.tickets.archivedAt)))
    .all()
    .map((t) => t.id)
  const result: StopAll = { stopped: [], skipped: [] }
  if (!ticketIds.length) return result
  const workspaces = db
    .select()
    .from(schema.workspaces)
    .where(inArray(schema.workspaces.ticketId, ticketIds))
    .all()

  // Every preview-type run the board builds or runs from them (a job has no link to stop).
  const previews = activeRuns().filter((r) => r.runType === 'preview')
  const managed = workspaces.filter((w) => previews.some((r) => r.workspaceId === w.id))
  await Promise.all(
    previews
      .filter((r) => managed.some((w) => w.id === r.workspaceId))
      .map(async (r) => {
        const port = r.port
        await stopRun(r.workspaceId, r.runId, `stopped by ${actor}`, actor)
        result.stopped.push({ workspaceId: r.workspaceId, ticketId: r.ticketId, kind: 'managed', port })
      }),
  )
  // Stopping a preview the board ran cleared the link that was its own; another link stays, judged as any.
  const relinked = managed.length
    ? db
        .select()
        .from(schema.workspaces)
        .where(
          inArray(
            schema.workspaces.id,
            managed.map((w) => w.id),
          ),
        )
        .all()
    : []

  const links = [...workspaces.filter((w) => !managed.includes(w)), ...relinked].filter(
    (w) => w.previewUrl && isLocalUrl(w.previewUrl),
  )
  const listeners = await listenersOn(links.map((w) => linkPort(w.previewUrl)!))
  const running = links.filter((w) => listeners.get(linkPort(w.previewUrl)!)?.length)
  const checked = running.map((w) => ({ w, t: linkTarget(w) }))
  const targets = checked.flatMap(({ t }) => (t.ok ? [t] : []))
  const processes = await processesOf(
    targets.flatMap((t) => (listeners.get(t.port) ?? []).flatMap((l) => (l.pid ? [l.pid] : []))),
  )
  await Promise.all(
    checked.map(async ({ w, t }) => {
      const v = t.ok ? judge(t, listeners, processes) : t
      if (!v.ok) result.skipped.push({ workspaceId: w.id, ticketId: w.ticketId, reason: v.reason })
      else result.stopped.push(await kill(t as Target, v.pids, actor))
    }),
  )
  return result
}
