import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { and, eq, inArray, isNull } from 'drizzle-orm'

import { db, schema } from '#/db'
import { lastHuman } from '../actors'
import { config, servedEntrance, type PublicEntrance } from '../config'
import { LOCAL_RP_ID } from '../entrance'
import { checkHostTools, hostTools, type HostTool } from '../hostTools'
import { HttpError } from '../http'
import { listPasskeys, revokeSession } from '../passkeys'
import { prRefreshFailures, refreshPrs } from '../prs'
import { generationState } from '../reportGenerate'
import {
  activeRuns,
  cannotStartRun,
  isActive,
  previewLimit,
  previewLimitRefusals,
  restartRun,
  RESTARTED,
  runsInUse,
  runState,
  startRun,
  stopRun,
  workspaceRuns,
  type RunState,
} from '../runs'
import { kindOf, listStages } from '../stages'
import { fileStore, type FileStore } from '../storage'
import { checkEntrance, type EntranceCheck } from '../tailnetEntrance'
import { ticketTimeline } from '../workTimeline'
import type { AlertActionContext, AlertButton, AlertCandidate, AlertContext, AlertType } from './registry'

/**
 * The alerts about this machine and how the board is reached (ideas 4, 5, 10 to 13, 21 to 23, 32 and
 * 34). Each reads what the board already keeps: the last host-tools check, the runs it started, the
 * passkeys and sessions, the settings. A check never waits on the network or on a program for long: what
 * is slow to find out (the tailnet entrance, the file storage) is asked in the background, kept for a
 * few minutes, and waited for only a moment.
 *
 * The board makes no backup of its own database (the live data is only copied for a preview and the
 * benchmark), so idea 13 raises the migrations that were applied since the human last looked, and
 * nothing about a missing backup.
 */

// Not imported from the registry: it imports this file, so its constants are not set yet when this one loads.
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const GB = 1024 ** 3

/** The oldest `claude` the board takes for its report generation; an older one is raised (idea 4). */
export const CLAUDE_MIN_VERSION = '1.0.0'
/** The disk is raised below this share of the data folder's volume free, or below this much (idea 11). */
export const DISK_FREE_FRACTION = 0.1
export const DISK_FREE_BYTES = 2 * GB
/** ... and is a problem, not a warning, below these. */
export const DISK_CRITICAL_FRACTION = 0.03
export const DISK_CRITICAL_BYTES = 500 * 1024 ** 2
/** The 1-minute load per core, and the memory free, over which a check counts as strained (idea 11). */
export const LOAD_PER_CORE = 1.5
export const MEMORY_FREE_FRACTION = 0.05
/** Strained for this many checks in a row (each at least `SAMPLE_GAP_MS` after the one before) is sustained. */
export const SUSTAINED_CHECKS = 3
export const SAMPLE_GAP_MS = 30_000
/** A gap between two checks longer than this breaks the run of strained ones. */
export const SAMPLE_STALE_MS = 5 * MINUTE_MS
/** A refused preview start is raised for this long after the refusal (idea 32). */
export const REFUSAL_HOURS = 24
/** A passkey made within this long ago, with a live session, is a new device (idea 22). */
export const NEW_DEVICE_DAYS = 7
/** How long what the entrance and the file storage answered is kept before it is asked again. */
export const ENTRANCE_TTL_MS = 5 * MINUTE_MS
export const STORAGE_TTL_MS = 2 * MINUTE_MS
/** The longest a check waits for those answers; the evaluator gives a check 10 s. */
export const SLOW_WAIT_MS = 3_000
/** The longest the file storage probe may take. */
export const STORAGE_PROBE_MS = 5_000

/**
 * What the checks read from outside the board's own rows: the tools it looked up, the machine's disk,
 * load and memory, the tailnet entrance and the file storage. The tests swap these for fakes.
 */
export interface MachineEdges {
  /** The last check of the tools the board runs; never runs one. */
  tools: () => { tools: HostTool[] } | null
  /** Checks the tools again. */
  recheckTools: () => Promise<unknown>
  /** The entrance the board serves beyond this machine, or null on a board reachable on loopback only. */
  entrance: () => PublicEntrance | null
  /** Asks the entrance (Tailscale and the listener) whether it answers. */
  checkEntrance: () => Promise<EntranceCheck>
  /** The data folder's volume: bytes free and in all; null when it cannot be read. */
  disk: () => { free: number; total: number } | null
  /** The 1-minute load and the number of cores. */
  load: () => { load: number; cores: number }
  /** The memory free and in all. */
  memory: () => { free: number; total: number }
  /** Where the attachments live. */
  store: () => FileStore
  /** The migrations the database applied, oldest first: when each was made and its name. */
  migrations: () => { at: number; name: string }[]
}

export const edges: MachineEdges = {
  tools: hostTools,
  recheckTools: checkHostTools,
  entrance: servedEntrance,
  checkEntrance: () => checkEntrance(),
  disk: () => {
    try {
      const s = fs.statfsSync(config.dataDir)
      return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }
    } catch {
      return null
    }
  },
  load: () => ({ load: os.loadavg()[0] ?? 0, cores: os.cpus().length || 1 }),
  memory: () => ({ free: os.freemem(), total: os.totalmem() }),
  store: () => fileStore,
  migrations: appliedMigrations,
}

// --- helpers ---

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** A moment in the words a card uses: `2026-11-21 11:48 UTC`. */
const when = (at: string | number) => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`

/** How long, in the words a card uses. */
function span(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE_MS))
  if (minutes < 60) return plural(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  return hours < 48 ? plural(hours, 'hour') : plural(Math.round(hours / 24), 'day')
}

const gigabytes = (bytes: number) => `${(bytes / GB).toFixed(1)} GB`
const percent = (fraction: number) => `${Math.round(fraction * 100)}%`
const human = () => lastHuman() ?? 'human'

/** Whether `version` is below `min`, both dotted numbers; one that does not parse is not below. */
export function versionBelow(version: string, min: string): boolean {
  const a = version.split('.').map(Number)
  const b = min.split('.').map(Number)
  if ([...a, ...b].some(Number.isNaN)) return false
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x < y
  }
  return false
}

/** Resolves with what `promise` gives, or null once `ms` have passed. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      },
    )
  })
}

/** An answer that is slow to get: kept, and asked again in the background when it is older than its TTL. */
interface Slow<T> {
  value: T | null
  at: number
  running: Promise<void> | null
}
const slowCell = <T>(): Slow<T> => ({ value: null, at: 0, running: null })

/** Starts asking (when nothing runs), and waits for the answer for a moment. */
function ask<T>(cell: Slow<T>, produce: () => Promise<T>, now: number): Promise<void> {
  cell.running ??= produce()
    .then((v) => {
      cell.value = v
      cell.at = now
    })
    .catch(() => {})
    .finally(() => {
      cell.running = null
    })
  return cell.running
}

/** The answer kept, fresh enough or after a moment's wait for a new one; null while there is none. */
async function slowRead<T>(
  cell: Slow<T>,
  produce: () => Promise<T>,
  now: number,
  ttl: number,
): Promise<T | null> {
  const stale = cell.value === null || now - cell.at >= ttl || now < cell.at
  if (stale) await within(ask(cell, produce, now), SLOW_WAIT_MS)
  return cell.value
}

const entranceCell = slowCell<EntranceCheck>()
const storageCell = slowCell<{ ok: boolean; message: string }>()
const history: { at: number; load: number; memory: number }[] = []

/** Forgets what the checks kept: the answers asked for and the run of strained checks (the tests). */
export function resetMachineState() {
  Object.assign(entranceCell, slowCell())
  Object.assign(storageCell, slowCell())
  history.length = 0
}

const toolsOf = () => edges.tools()?.tools ?? []
const toolOf = (name: string) => toolsOf().find((t) => t.name === name)

/** A `check again` button's action: asks the check again, and says whether the alert still holds. */
function recheck(
  type: () => AlertType,
  again: (ctx: AlertActionContext) => Promise<unknown>,
  done: string,
  still: string,
) {
  return async (ctx: AlertActionContext) => {
    await again(ctx)
    const raised = await type().check(ctx)
    const gone = !raised.some((c) => (c.subject ?? '') === ctx.alert.subject)
    return { ok: gone, message: gone ? done : still, resolve: gone }
  }
}

const checkAgain: AlertButton = { id: 'check', label: 'Check again', kind: 'action', primary: true }

// --- the runs of a ticket (ideas 10, 12, 32) ---

const runSubject = (r: { workspaceId: number; runId: number }) => `run:${r.workspaceId}:${r.runId}`

/** The workspace and run a `run:<workspace>:<run>` subject names. */
function runOfSubject(subject: string): { workspaceId: number; runId: number } {
  const [, ws, run] = subject.split(':')
  const workspaceId = Number(ws)
  const runId = Number(run)
  if (!Number.isInteger(workspaceId) || !Number.isInteger(runId)) throw new HttpError(400, 'not a run alert')
  return { workspaceId, runId }
}

const ticketRow = (id: number) => db.select().from(schema.tickets).where(eq(schema.tickets.id, id)).get()
const ticketLabel = (t: { id: number; title: string }) => `#${t.id} ${t.title}`
const ticketHref = (projectId: number, ticketId: number) => `/projects/${projectId}/features/${ticketId}`
const stageKind = (t: { projectId: number; status: string }) => kindOf(listStages(t.projectId), t.status)

const projectOf = (ctx: AlertContext) => {
  if (ctx.projectId === null) throw new Error('a run alert is checked per project')
  return ctx.projectId
}

// --- 4: agent login / CLI problem ---

/**
 * What claude (the agent CLI) printed when it was refused for want of a sign-in: only errors that signing
 * in again fixes. A credit balance, an expired token the CLI refreshes itself or any other failure is no
 * login problem.
 */
const LOGIN_FAILURE =
  /invalid (api )?key|please run \/login|not logged in|not authenticated|authentication (failed|required)|\b401 unauthori[sz]ed|login required/i

export const needsLogin = (message: string) => LOGIN_FAILURE.test(message)

function agentLoginAlerts(ctx: AlertContext): AlertCandidate[] {
  const out: AlertCandidate[] = []
  const claude = toolOf('claude')
  if (claude && !claude.found)
    out.push({
      subject: 'cli',
      severity: 'warning',
      title: 'The claude CLI was not found on this machine',
      body: `${claude.problem ?? 'claude was not found'}. Without it ${claude.breaks} does not work.`,
      details: claude.fix ? [`To fix: ${claude.fix}`] : undefined,
      buttons: [checkAgain],
    })
  else if (claude?.found && claude.version && versionBelow(claude.version, CLAUDE_MIN_VERSION))
    out.push({
      subject: 'cli',
      severity: 'warning',
      title: `The claude CLI is too old (${claude.version})`,
      body: `The board needs claude ${CLAUDE_MIN_VERSION} or newer for ${claude.breaks}. Update Claude Code on this machine.`,
      buttons: [checkAgain],
    })
  const failed = ctx.projects.list().flatMap((p) => {
    const error = generationState(p.id).error
    return error && needsLogin(error.message) ? [{ project: p, error }] : []
  })
  if (failed.length) {
    const first = failed[0]!.project
    out.push({
      subject: 'login',
      severity: 'problem',
      title: 'claude on this machine is not signed in',
      body:
        'A report could not be written because claude refused to sign in. Run claude on this machine and ' +
        'sign in again; reports and any agent started from here fail until then.',
      details: failed.map((f) => `${f.project.name}: ${f.error.message}`),
      buttons: [{ id: 'reports', label: 'Open Reports', kind: 'link', href: `/projects/${first.id}/daily` }],
    })
  }
  return out
}

const agentLogin: AlertType = {
  type: 'agent-login',
  idea: 4,
  group: 'machine',
  label: 'Agent login or CLI',
  description: 'The claude CLI is missing or too old on this machine, or it was refused when it signed in.',
  scope: 'board',
  check: agentLoginAlerts,
  actions: {
    check: recheck(
      () => agentLogin,
      () => edges.recheckTools(),
      'claude is fine now.',
      'claude still has a problem.',
    ),
  },
}

// --- 5: GitHub access ---

/** What GitHub or gh said when it refused the board: a bad or missing token, or one without the scope. */
const GITHUB_REFUSAL =
  /\b401\b|bad credentials|not logged in|gh auth|auth login|signed in|token|scope|saml|forbidden.*(credential|auth|login)/i

function githubAlerts(ctx: AlertContext): AlertCandidate[] {
  const gh = toolOf('gh')
  if (gh && !gh.found)
    return [
      {
        subject: 'gh-missing',
        severity: 'problem',
        title: 'The GitHub CLI was not found on this machine',
        body: `${gh.problem ?? 'gh was not found'}. Without it ${gh.breaks} do not work.`,
        details: gh.fix ? [`To fix: ${gh.fix}`] : undefined,
        buttons: [checkAgain],
      },
    ]
  if (gh && gh.signedIn === false)
    return [
      {
        subject: 'gh-signed-out',
        severity: 'problem',
        title: 'The GitHub CLI is not signed in',
        body: `${gh.problem ?? 'gh is not signed in'}. Without it ${gh.breaks} do not work.`,
        details: gh.fix ? [`To fix: ${gh.fix}`] : undefined,
        buttons: [checkAgain],
      },
    ]
  const failures = prRefreshFailures().filter((f) => GITHUB_REFUSAL.test(f.message))
  if (!failures.length) return []
  const name = (id: number) => ctx.projects.get(id)?.name ?? `project ${id}`
  return [
    {
      subject: 'refresh',
      severity: 'problem',
      title: 'GitHub refused the board: the PR queue cannot refresh',
      body:
        'The last refresh of the PR queue failed with a sign-in or permission error. The gh login may have ' +
        'expired, or its token lacks a scope: run gh auth login (or gh auth refresh) on this machine.',
      details: failures.map((f) => `${name(f.projectId)}: ${f.message}`),
      buttons: [checkAgain],
    },
  ]
}

const github: AlertType = {
  type: 'github-access',
  idea: 5,
  group: 'machine',
  label: 'GitHub access',
  description:
    'The gh login is missing, expired or lacks a scope, or the PR queue cannot refresh because of it.',
  scope: 'board',
  check: githubAlerts,
  actions: {
    check: recheck(
      () => github,
      async () => {
        await edges.recheckTools()
        // The failures are what the last refresh saw: refresh the projects that failed, so they show the present.
        await Promise.all(prRefreshFailures().map((f) => refreshPrs(f.projectId).catch(() => {})))
      },
      'GitHub answers again.',
      'GitHub access still has a problem.',
    ),
  },
}

// --- 10: leftover processes ---

function leftoverAlerts(ctx: AlertContext): AlertCandidate[] {
  const projectId = projectOf(ctx)
  const now = ctx.now()
  const out: AlertCandidate[] = []
  for (const run of activeRuns()) {
    const ticket = ticketRow(run.ticketId)
    if (!ticket || ticket.projectId !== projectId) continue
    const why = leftoverReason(ticket, now)
    if (!why) continue
    const kind = run.runType === 'preview' ? 'preview' : 'job'
    out.push({
      subject: runSubject(run),
      severity: 'warning',
      title: `${ticketLabel(ticket)}: its ${kind} ${run.runName} is still running`,
      body:
        `The board started it ${span(now - Date.parse(run.startedAt))} ago and ${why}. It keeps using the ` +
        'CPU, memory and a port until it is stopped.',
      details: [`Status: ${run.status}${run.port ? `, port ${run.port}` : ''}`, `Worktree: ${run.path}`],
      buttons: [
        { id: 'stop', label: 'Stop it', kind: 'action', primary: true },
        { id: 'ticket', label: 'Open the ticket', kind: 'link', href: ticketHref(projectId, ticket.id) },
      ],
    })
  }
  return out
}

/** Why a ticket's run no longer has anyone behind it; null while someone does. */
function leftoverReason(ticket: schema.Ticket, now: number): string | null {
  if (ticket.archivedAt) return 'its ticket is archived'
  if (stageKind(ticket) === 'done' || stageKind(ticket) === 'cancelled') return 'its ticket is closed'
  const liveness = ticketTimeline(ticket.id, new Date(now)).timeline.liveness
  if (liveness?.state === 'lost') return 'the agent working on its ticket is gone'
  if (liveness?.state === 'stalled')
    return `its ticket has been silent for ${span(liveness.silentMinutes * MINUTE_MS)}`
  return null
}

const leftover: AlertType = {
  type: 'leftover-process',
  idea: 10,
  group: 'machine',
  label: 'Leftover processes',
  description:
    'A preview or job the board started is still running after its ticket was closed or its agent ended.',
  scope: 'project',
  check: leftoverAlerts,
  actions: {
    stop: async (ctx) => {
      const { workspaceId, runId } = runOfSubject(ctx.alert.subject)
      const run = runState(workspaceId, runId)
      if (!run || !isActive(run)) return { message: 'It is not running any more.', resolve: true }
      await stopRun(workspaceId, runId, 'stopped from an alert', human())
      return { message: `Stopped ${run.runName}.`, resolve: true }
    },
  },
}

// --- 11: resources ---

function resourceAlerts(ctx: AlertContext): AlertCandidate[] {
  const now = ctx.now()
  const out: AlertCandidate[] = []
  const disk = edges.disk()
  if (disk && disk.total > 0) {
    const fraction = disk.free / disk.total
    if (fraction < DISK_FREE_FRACTION || disk.free < DISK_FREE_BYTES)
      out.push({
        subject: 'disk',
        severity:
          fraction < DISK_CRITICAL_FRACTION || disk.free < DISK_CRITICAL_BYTES ? 'problem' : 'warning',
        title: `The disk is almost full: ${gigabytes(disk.free)} free`,
        body:
          `The volume of the board's data folder has ${gigabytes(disk.free)} free of ${gigabytes(disk.total)} ` +
          `(${percent(fraction)}). Attachments, previews and the database stop working when it is full. ` +
          'The Cleanup page of each project lists the branches and worktrees to delete. No link here: this alert shows in every project.',
        details: [`Data folder: ${config.dataDir}`],
      })
  }

  // The run of strained checks: one sample per check at least SAMPLE_GAP_MS after the last.
  const last = history.at(-1)
  if (last && (now - last.at > SAMPLE_STALE_MS || now < last.at)) history.length = 0
  if (!history.length || now - history.at(-1)!.at >= SAMPLE_GAP_MS) {
    const { load, cores } = edges.load()
    const memory = edges.memory()
    history.push({ at: now, load: load / cores, memory: memory.total > 0 ? memory.free / memory.total : 1 })
    if (history.length > SUSTAINED_CHECKS) history.shift()
  }
  const sustained = (over: (s: (typeof history)[number]) => boolean) =>
    history.length >= SUSTAINED_CHECKS && history.every(over)
  const latest = history.at(-1)
  if (latest && sustained((s) => s.load >= LOAD_PER_CORE))
    out.push({
      subject: 'load',
      severity: 'warning',
      title: `The machine is overloaded: load ${latest.load.toFixed(1)} per core`,
      body:
        `The load has been over ${LOAD_PER_CORE} per core for the last ${SUSTAINED_CHECKS} checks. ` +
        'Something may be spinning: look for previews or test boards left running.',
    })
  if (latest && sustained((s) => s.memory < MEMORY_FREE_FRACTION))
    out.push({
      subject: 'memory',
      severity: 'warning',
      title: `The machine is short of memory: ${percent(latest.memory)} free`,
      body: `Less than ${percent(MEMORY_FREE_FRACTION)} of the memory has been free for the last ${SUSTAINED_CHECKS} checks.`,
    })
  return out
}

const resources: AlertType = {
  type: 'machine-resources',
  idea: 11,
  group: 'machine',
  label: 'Disk, load and memory',
  description:
    'The data folder’s disk is almost full, or the load or memory has been high for several checks.',
  scope: 'board',
  check: resourceAlerts,
}

// --- 12: preview stopped by a restart ---

function restartedAlerts(ctx: AlertContext): AlertCandidate[] {
  const projectId = projectOf(ctx)
  const tickets = db
    .select()
    .from(schema.tickets)
    .where(and(eq(schema.tickets.projectId, projectId), isNull(schema.tickets.archivedAt)))
    .all()
    .filter((t) => stageKind(t) === 'review')
  if (!tickets.length) return []
  const byId = new Map(tickets.map((t) => [t.id, t]))
  const workspaces = db
    .select()
    .from(schema.workspaces)
    .where(inArray(schema.workspaces.ticketId, [...byId.keys()]))
    .all()
  const out: AlertCandidate[] = []
  for (const ws of workspaces)
    for (const run of workspaceRuns(ws.id)) {
      if (run.runType !== 'preview' || run.status !== 'stopped' || run.reason !== RESTARTED) continue
      const ticket = byId.get(ws.ticketId)!
      out.push({
        subject: runSubject(run),
        severity: 'info',
        title: `${ticketLabel(ticket)}: its preview stopped when the board restarted`,
        body:
          `The preview ${run.runName} was running until ${when(run.stoppedAt ?? run.startedAt)}, when the board ` +
          'restarted, and nothing starts it again by itself. The ticket is still in review.',
        buttons: [
          { id: 'restart', label: 'Restart the preview', kind: 'action', primary: true },
          { id: 'ticket', label: 'Open the ticket', kind: 'link', href: ticketHref(projectId, ticket.id) },
        ],
      })
    }
  return out
}

const previewRestarted: AlertType = {
  type: 'preview-restarted',
  idea: 12,
  group: 'machine',
  label: 'Preview stopped by a restart',
  description: 'A preview was stopped when the board restarted while its ticket is still in review.',
  scope: 'project',
  check: restartedAlerts,
  actions: {
    restart: async (ctx) => {
      const { workspaceId, runId } = runOfSubject(ctx.alert.subject)
      const run = await restartRun(workspaceId, runId, human())
      return { message: `Started ${run.runName} again.`, resolve: true }
    },
  },
}

// --- 13: a migration applied ---

const MIGRATIONS_SEEN = 'alertMigrationsSeen'

/** The migrations the database applied, with the names the journal gives them. */
function appliedMigrations(): { at: number; name: string }[] {
  const rows = db.$client
    .prepare('select created_at as at from __drizzle_migrations order by created_at')
    .all() as { at: number }[]
  const names = new Map<number, string>()
  try {
    const journal = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'drizzle', 'meta', '_journal.json'), 'utf8'),
    ) as { entries: { when: number; tag: string }[] }
    for (const e of journal.entries) names.set(e.when, e.tag)
  } catch {
    // no journal beside the process: the migrations stay unnamed
  }
  return rows.map((r) => ({ at: r.at, name: names.get(r.at) ?? `a migration made ${when(r.at)}` }))
}

const migrationsSeen = () => {
  const row = db.select().from(schema.settings).where(eq(schema.settings.key, MIGRATIONS_SEEN)).get()
  const at = (row?.value as { at?: unknown } | undefined)?.at
  return typeof at === 'number' ? at : null
}

const markMigrationsSeen = (at: number) =>
  db
    .insert(schema.settings)
    .values({ key: MIGRATIONS_SEEN, value: { at } })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: { at } } })
    .run()

function migrationAlerts(): AlertCandidate[] {
  const applied = edges.migrations()
  const newest = applied.at(-1)
  if (!newest) return []
  const seen = migrationsSeen()
  // The first look has nothing to compare with: what is applied now is what the human starts from.
  if (seen === null) {
    markMigrationsSeen(newest.at)
    return []
  }
  const fresh = applied.filter((m) => m.at > seen)
  if (!fresh.length) return []
  return [
    {
      subject: `migrated:${newest.at}`,
      severity: 'info',
      title: `The board applied ${plural(fresh.length, 'database migration')} when it started`,
      body:
        'The database changed shape since you last looked. The board keeps no backup of its database: ' +
        'copy data/board.db if you want one from before.',
      details: fresh.map((m) => m.name),
      buttons: [{ id: 'seen', label: 'Got it', kind: 'action', primary: true }],
    },
  ]
}

const migrations: AlertType = {
  type: 'migration-applied',
  idea: 13,
  group: 'machine',
  label: 'Migration applied',
  description: 'The board applied database migrations since you last looked, and what changed.',
  scope: 'board',
  check: migrationAlerts,
  actions: {
    seen: () => {
      const newest = edges.migrations().at(-1)
      if (newest) markMigrationsSeen(newest.at)
      return { message: 'Marked as seen.', resolve: true }
    },
  },
}

// --- 21: only one passkey ---

function onePasskeyAlerts(): AlertCandidate[] {
  const passkeys = listPasskeys()
  if (passkeys.length !== 1) return []
  const beyond = edges.entrance() !== null
  return [
    {
      severity: beyond ? 'warning' : 'info',
      title: 'You have only one passkey',
      body:
        `If the device holding ${passkeys[0]!.name} is lost, nothing else signs you in.` +
        (beyond ? ' The board can be reached from other devices, so this matters more.' : '') +
        ' Add a second passkey on another device.',
      buttons: [{ id: 'add', label: 'Add a passkey', kind: 'link', href: '/settings#devices' }],
    },
  ]
}

const onePasskey: AlertType = {
  type: 'one-passkey',
  idea: 21,
  group: 'machine',
  label: 'Only one passkey',
  description: 'The account has a single passkey and no other way to sign in.',
  scope: 'board',
  check: onePasskeyAlerts,
  snoozeOptions: [30 * DAY_MS],
  stickyDismiss: true,
}

// --- 22: sign-in from a new device (a board reached from other devices) ---

function newDeviceAlerts(ctx: AlertContext): AlertCandidate[] {
  const now = ctx.now()
  return listPasskeys()
    .filter(
      (p) =>
        p.rpId !== LOCAL_RP_ID && p.sessions > 0 && now - Date.parse(p.createdAt) <= NEW_DEVICE_DAYS * DAY_MS,
    )
    .map((p) => ({
      subject: `passkey:${p.id}`,
      severity: 'warning' as const,
      title: `New sign-in from ${p.name}`,
      body:
        `A device that had not signed in before, ${p.name} (on ${p.rpId}), signed in at ${when(p.createdAt)}. ` +
        'If it was not you, sign it out and remove its passkey in Devices.',
      buttons: [
        { id: 'sign-out', label: 'Sign out this device', kind: 'action' as const, primary: true },
        { id: 'devices', label: 'Open Devices', kind: 'link' as const, href: '/settings#devices' },
      ],
    }))
}

const newDevice: AlertType = {
  type: 'new-device',
  idea: 22,
  group: 'machine',
  label: 'Sign-in from a new device',
  description: 'A device that never signed in before did, on a board reached from other devices.',
  scope: 'board',
  applies: () => edges.entrance() !== null,
  check: newDeviceAlerts,
  actions: {
    'sign-out': (ctx) => {
      const id = Number(ctx.alert.subject.split(':')[1])
      const sessions = db
        .select({ id: schema.sessions.id })
        .from(schema.sessions)
        .where(eq(schema.sessions.passkeyId, id))
        .all()
      for (const s of sessions) revokeSession(s.id)
      return { message: `Signed out ${plural(sessions.length, 'session')}.`, resolve: true }
    },
  },
}

// --- 23: the tailnet entrance does not answer ---

const askEntrance = () =>
  edges.checkEntrance().catch(
    (err: unknown): EntranceCheck => ({
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    }),
  )

async function entranceAlerts(ctx: AlertContext): Promise<AlertCandidate[]> {
  const entrance = edges.entrance()
  if (!entrance) return []
  const answer = await slowRead(entranceCell, askEntrance, ctx.now(), ENTRANCE_TTL_MS)
  if (!answer || answer.ok) return []
  return [
    {
      severity: 'problem',
      title: `The tailnet link ${entrance.origin} is not answering`,
      body: `Your other devices cannot reach the board. ${answer.message}`,
      buttons: [
        checkAgain,
        { id: 'tailnet', label: 'Open Settings', kind: 'link', href: '/settings#tailnet' },
      ],
    },
  ]
}

const tailnet: AlertType = {
  type: 'tailnet-entrance',
  idea: 23,
  group: 'machine',
  label: 'Tailnet entrance',
  description: 'The tailnet entrance is on, but Tailscale or its listener does not answer.',
  scope: 'board',
  applies: () => edges.entrance() !== null,
  check: entranceAlerts,
  actions: {
    check: async (ctx) => {
      await ask(entranceCell, askEntrance, ctx.now())
      const ok = entranceCell.value?.ok === true
      return {
        ok,
        message: ok ? 'The entrance answers.' : (entranceCell.value?.message ?? 'No answer.'),
        resolve: ok,
      }
    },
  },
}

// --- 32: the preview limit was reached ---

function limitAlerts(ctx: AlertContext): AlertCandidate[] {
  const projectId = projectOf(ctx)
  const limit = previewLimit()
  if (runsInUse() < limit) return []
  const inUse = activeRuns().sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
  const label = (r: RunState) => {
    const t = ticketRow(r.ticketId)
    return t
      ? `${ticketLabel(t)} (${r.runName}, since ${when(r.startedAt)})`
      : `${r.runName} (since ${when(r.startedAt)})`
  }
  const out: AlertCandidate[] = []
  for (const refused of previewLimitRefusals()) {
    if (ctx.now() - refused.at > REFUSAL_HOURS * HOUR_MS) continue
    const run = runState(refused.workspaceId, refused.runId)
    if (isActive(run)) continue
    const ws = db.select().from(schema.workspaces).where(eq(schema.workspaces.id, refused.workspaceId)).get()
    const ticket = ws ? ticketRow(ws.ticketId) : undefined
    if (!ws || !ticket || ticket.projectId !== projectId) continue
    out.push({
      subject: runSubject(refused),
      severity: 'warning',
      title: `The preview of ${ticketLabel(ticket)} did not start: the limit is reached`,
      body:
        `The board runs at most ${plural(limit, 'preview')} at once and ${inUse.length} are in use. ` +
        'Stop one, or raise the limit in Settings.',
      details: inUse.map(label),
      buttons: [
        { id: 'stop-oldest', label: 'Stop the oldest and start this one', kind: 'action', primary: true },
        { id: 'previews', label: 'Open Previews', kind: 'link', href: `/projects/${projectId}/previews` },
      ],
    })
  }
  return out
}

const previewLimitReached: AlertType = {
  type: 'preview-limit',
  idea: 32,
  group: 'machine',
  label: 'Preview limit reached',
  description: 'A preview was refused because the limit of previews at once is in use.',
  scope: 'project',
  check: limitAlerts,
  actions: {
    'stop-oldest': async (ctx) => {
      const { workspaceId, runId } = runOfSubject(ctx.alert.subject)
      // Whatever would refuse the start refuses before anything is stopped.
      const refused = cannotStartRun(workspaceId, runId)
      if (refused) throw new HttpError(409, refused)
      const oldest = activeRuns()
        .filter((r) => !(r.workspaceId === workspaceId && r.runId === runId))
        .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))[0]
      if (oldest) await stopRun(oldest.workspaceId, oldest.runId, 'stopped to make room', human())
      const run = startRun(workspaceId, runId, human())
      return {
        message: oldest ? `Stopped ${oldest.runName} and started ${run.runName}.` : `Started ${run.runName}.`,
        resolve: true,
      }
    },
  },
}

// --- 34: the file storage does not answer (S3 only) ---

const PROBE_KEY = 'alert-probe'

/** Writes a small object and removes it again: the bucket, a write and a delete, through the board's store. */
async function probeStorage(): Promise<{ ok: boolean; message: string }> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`it did not answer within ${STORAGE_PROBE_MS / 1000} s`)),
      STORAGE_PROBE_MS,
    )
  })
  try {
    const store = edges.store()
    const probe = (async () => {
      await store.put(PROBE_KEY, Buffer.from('ok'), 'text/plain')
      await store.delete(PROBE_KEY)
    })()
    // A probe that loses the race still settles on its own: its rejection is already handled here.
    probe.catch(() => {})
    await Promise.race([probe, late])
    return { ok: true, message: 'The file storage answers.' }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}

async function storageAlerts(ctx: AlertContext): Promise<AlertCandidate[]> {
  const answer = await slowRead(storageCell, probeStorage, ctx.now(), STORAGE_TTL_MS)
  if (!answer || answer.ok) return []
  const bucket = config.s3.bucket
  return [
    {
      severity: 'problem',
      title: 'The file storage is not answering',
      body:
        `The S3 bucket${bucket ? ` ${bucket}` : ''} did not answer: ${answer.message}. New attachments cannot be ` +
        "saved and agents' file reads fail until it is back.",
      buttons: [
        { id: 'test', label: 'Test the connection', kind: 'action', primary: true },
        { id: 'settings', label: 'Open Settings', kind: 'link', href: '/settings' },
      ],
    },
  ]
}

const storage: AlertType = {
  type: 'file-storage',
  idea: 34,
  group: 'machine',
  label: 'File storage',
  description: 'The S3 file storage does not answer to a write or the bucket check.',
  scope: 'board',
  applies: () => edges.store().kind === 's3',
  check: storageAlerts,
  actions: {
    test: async (ctx) => {
      await ask(storageCell, probeStorage, ctx.now())
      const answer = storageCell.value
      return {
        ok: answer?.ok === true,
        message: answer?.ok ? 'The file storage answers.' : `No answer: ${answer?.message}`,
        resolve: answer?.ok === true,
      }
    },
  },
}

export const alertTypes: AlertType[] = [
  agentLogin,
  github,
  leftover,
  resources,
  previewRestarted,
  migrations,
  onePasskey,
  newDevice,
  tailnet,
  previewLimitReached,
  storage,
]
