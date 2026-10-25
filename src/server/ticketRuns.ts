import { eq } from 'drizzle-orm'

import { db, schema } from '#/db'
import { HttpError, notFound } from './http'
import { getRepo } from './repos'
import { listRunConfigs, type RunConfig } from './runConfig'
import {
  cannotStartRun,
  isActive,
  previewLimit,
  runsInUse,
  runState,
  type RunState,
  startRun,
  stopRun,
  worktreeTarget,
  workspaceRuns,
  restartRun,
} from './runs'
import { ticketRepoList } from './ticketRepos'

/**
 * A ticket's runs: every run the human configured for each repo the ticket spans, each from the
 * ticket's worktree of that repo. What the Runs card shows and Start all / Stop all act on.
 */

function getTicket(id: number) {
  const t = db.select().from(schema.tickets).where(eq(schema.tickets.id, id)).get()
  if (!t) throw notFound('ticket')
  return t
}

const newest = (a: schema.Workspace, b: schema.Workspace) =>
  b.createdAt.localeCompare(a.createdAt) || b.id - a.id

/**
 * The ticket's workspace a repo's runs use: one whose path is a worktree of that repo the board may
 * act on (`worktreeTarget`), the one on the ticket's branch for the repo first, else the newest. One
 * that already runs the given run comes before any. Null, with why, when there is none.
 */
export function runWorkspace(
  ticket: schema.Ticket,
  repoId: number,
  runId?: number,
): { workspace: schema.Workspace | null; reason: string | null } {
  const entries = ticketRepoList(ticket)
  const entry = entries.find((e) => e.repoId === repoId)
  const repo = getRepo(repoId)
  const primary = entries[0]?.repoId
  const mine = db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.ticketId, ticket.id))
    .all()
    .filter((w) => (w.repoId ?? primary) === repoId)
    .sort(newest)
  const valid = mine.filter((w) => worktreeTarget(w, repo).ok)
  const running = runId ? valid.find((w) => isActive(runState(w.id, runId))) : undefined
  const pick = running ?? valid.find((w) => !!entry?.branch && w.branch === entry.branch) ?? valid[0] ?? null
  if (pick) return { workspace: pick, reason: null }
  if (mine.length)
    return { workspace: null, reason: (worktreeTarget(mine[0]!, repo) as { reason: string }).reason }
  return {
    workspace: null,
    reason: `the ticket has no worktree of ${repo.name}: register it (add_workspace with its path${repoId === primary ? '' : ` and repoId ${repoId}`})`,
  }
}

/** A run config as reads hand it out, with where it would run for the ticket and how it stands there. */
export interface TicketRun extends RunConfig {
  /** The workspace it runs (or would run) from; null when the ticket has none for the repo. */
  workspaceId: number | null
  /** How it last ran from that workspace; null when it never did. */
  state: RunState | null
  /** Why a Start would be refused right now; null when it would start. */
  cannotStart: string | null
}

export interface TicketRunsRepo {
  repoId: number
  name: string
  branch: string
  primary: boolean
  /** The workspace the repo's runs use (see `runWorkspace`), null when there is none. */
  workspace: Pick<schema.Workspace, 'id' | 'name' | 'branch' | 'path'> | null
  /** Why there is none. */
  workspaceProblem: string | null
  runs: TicketRun[]
}

/**
 * A run started from one of the ticket's workspaces that still builds or runs, of a repo that is no
 * longer one of the ticket's (its fallback repo changed, say): listed so it can be stopped from the
 * ticket. It cannot start or restart from there again.
 */
export interface OrphanedRun {
  repoId: number
  repoName: string
  runId: number
  name: string
  type: RunState['runType']
  workspace: Pick<schema.Workspace, 'id' | 'name' | 'branch' | 'path'>
  state: RunState
  /** Why it is not under one of the ticket's repos. */
  reason: string
}

/**
 * A run of one of the ticket's own repos that builds or runs from one of the ticket's workspaces other
 * than the one its repo row shows (a second worktree of the repo it was started from by workspace, say):
 * listed so it can be stopped from the ticket. Its row starts and restarts the one the row shows.
 */
export type AlsoRunning = OrphanedRun

export interface TicketRuns {
  ticketId: number
  repos: TicketRunsRepo[]
  /** Its runs that still go for a repo that is no longer the ticket's (see `OrphanedRun`). */
  orphaned: OrphanedRun[]
  /** Its own repos' runs going from a workspace other than the one their row shows (see `AlsoRunning`). */
  alsoRunning: AlsoRunning[]
  /** Runs the board builds or runs now, board-wide, and the human's limit on them. */
  inUse: number
  limit: number
}

function runOf(ticket: schema.Ticket, config: RunConfig): TicketRun {
  const { workspace, reason } = runWorkspace(ticket, config.repoId, config.id)
  if (!workspace) return { ...config, workspaceId: null, state: null, cannotStart: reason }
  return {
    ...config,
    workspaceId: workspace.id,
    state: runState(workspace.id, config.id),
    cannotStart: cannotStartRun(workspace.id, config.id),
  }
}

const workspacesOf = (ticketId: number) =>
  db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.ticketId, ticketId))
    .all()
    .sort((a, b) => a.id - b.id)

/** Every run that builds or runs from one of the ticket's workspaces, with that workspace. */
const activeOf = (ticketId: number) =>
  workspacesOf(ticketId).flatMap((w) =>
    workspaceRuns(w.id)
      .filter((r) => isActive(r))
      .map((r) => ({ w, r })),
  )

const repoNameOf = (repoId: number) =>
  db.select().from(schema.repos).where(eq(schema.repos.id, repoId)).get()?.name ?? `repo ${repoId}`

function goingRun(w: schema.Workspace, r: RunState, repoName: string, reason: string): OrphanedRun {
  return {
    repoId: r.repoId,
    repoName,
    runId: r.runId,
    name: r.runName,
    type: r.runType,
    workspace: { id: w.id, name: w.name, branch: w.branch, path: w.path },
    state: r,
    reason,
  }
}

/** The ticket's runs that build or run from its workspaces for a repo it no longer spans. */
function orphanedRuns(ticket: schema.Ticket): OrphanedRun[] {
  const own = new Set(ticketRepoList(ticket).map((e) => e.repoId))
  return activeOf(ticket.id)
    .filter(({ r }) => !own.has(r.repoId))
    .map(({ w, r }) => {
      const repoName = repoNameOf(r.repoId)
      return goingRun(w, r, repoName, `${repoName} is no longer one of ticket ${ticket.id}'s repos`)
    })
}

/**
 * The runs of the ticket's own repos that build or run from one of its workspaces other than the one
 * their repo row shows (`runWorkspace`, which takes a workspace running the run first): every run
 * going from the ticket is then either in a row, orphaned, or here.
 */
function alsoRunningRuns(ticket: schema.Ticket): AlsoRunning[] {
  const own = new Set(ticketRepoList(ticket).map((e) => e.repoId))
  const shown = new Map<number, schema.Workspace | null>()
  const shownOf = (repoId: number, runId: number) => {
    if (!shown.has(runId)) shown.set(runId, runWorkspace(ticket, repoId, runId).workspace)
    return shown.get(runId)!
  }
  return activeOf(ticket.id)
    .filter(({ r }) => own.has(r.repoId) && shownOf(r.repoId, r.runId)?.id !== r.workspaceId)
    .map(({ w, r }) => {
      const repoName = repoNameOf(r.repoId)
      const row = shownOf(r.repoId, r.runId)
      return goingRun(
        w,
        r,
        repoName,
        `${r.runName} of ${repoName} also goes from workspace ${w.name}; its row ${row ? `shows workspace ${row.name}` : 'has no workspace'}`,
      )
    })
}

/**
 * Every run of every repo of the ticket, grouped by repo in the ticket's order, and the runs it
 * started that still go for a repo it no longer spans.
 */
export function ticketRuns(ticketId: number): TicketRuns {
  const ticket = getTicket(ticketId)
  return {
    ticketId,
    repos: ticketRepoList(ticket).map((e) => {
      const { workspace, reason } = runWorkspace(ticket, e.repoId)
      return {
        repoId: e.repoId,
        name: e.name,
        branch: e.branch,
        primary: e.primary,
        workspace: workspace && {
          id: workspace.id,
          name: workspace.name,
          branch: workspace.branch,
          path: workspace.path,
        },
        workspaceProblem: reason,
        runs: listRunConfigs(e.repoId).map((c) => runOf(ticket, c)),
      }
    }),
    orphaned: orphanedRuns(ticket),
    alsoRunning: alsoRunningRuns(ticket),
    inUse: runsInUse(),
    limit: previewLimit(),
  }
}

export interface RunOutcome {
  repoId: number
  runId: number
  name: string
  workspaceId: number | null
  ok: boolean
  /** Why it was refused, or what it was already doing. */
  reason: string | null
  state: RunState | null
}

const reposOf = (ticket: schema.Ticket, repoId?: number) => {
  const entries = ticketRepoList(ticket)
  if (repoId && !entries.some((e) => e.repoId === repoId))
    throw new HttpError(400, `repo ${repoId} is not one of ticket ${ticket.id}'s repos`)
  return entries.filter((e) => !repoId || e.repoId === repoId)
}

/**
 * Start all: every run of the ticket's repos (of one, given `repoId`) that does not run yet, each from
 * its workspace. One refused (no workspace, the limit) does not stop the rest; each says how it went.
 */
export function startTicketRuns(ticketId: number, actor: string, opts: { repoId?: number } = {}) {
  const ticket = getTicket(ticketId)
  const out: RunOutcome[] = []
  for (const e of reposOf(ticket, opts.repoId))
    for (const config of listRunConfigs(e.repoId)) {
      const run = runOf(ticket, config)
      const base = { repoId: e.repoId, runId: config.id, name: config.name, workspaceId: run.workspaceId }
      if (isActive(run.state)) {
        out.push({ ...base, ok: true, reason: `already ${run.state!.status}`, state: run.state })
        continue
      }
      if (run.workspaceId === null) {
        out.push({ ...base, ok: false, reason: run.cannotStart, state: null })
        continue
      }
      try {
        out.push({ ...base, ok: true, reason: null, state: startRun(run.workspaceId, config.id, actor) })
      } catch (err) {
        if (!(err instanceof HttpError)) throw err
        out.push({ ...base, ok: false, reason: err.message, state: run.state })
      }
    }
  return { results: out }
}

/**
 * Stop all: every run started from the ticket's workspaces that builds or runs, the orphaned ones
 * too (only those of one repo, given `repoId`: one of the ticket's, or one it has orphaned runs of).
 */
export async function stopTicketRuns(ticketId: number, actor: string, opts: { repoId?: number } = {}) {
  const ticket = getTicket(ticketId)
  if (opts.repoId && !orphanedRuns(ticket).some((o) => o.repoId === opts.repoId)) reposOf(ticket, opts.repoId)
  const active = workspacesOf(ticketId)
    .flatMap((w) => workspaceRuns(w.id))
    .filter((r) => isActive(r) && (!opts.repoId || r.repoId === opts.repoId))
  const out: RunOutcome[] = []
  for (const r of active) {
    const state = await stopRun(r.workspaceId, r.runId, `stopped by ${actor}`, actor)
    out.push({
      repoId: r.repoId,
      runId: r.runId,
      name: r.runName,
      workspaceId: r.workspaceId,
      ok: true,
      reason: null,
      state,
    })
  }
  return { results: out }
}

/** findTicketRun's refusal of a name several of the ticket's repos have a run of. */
class AmbiguousRun extends HttpError {}

/**
 * One run of the ticket, by its id or its name (any casing), in `repoId` or, without it, in whichever
 * of the ticket's repos has a run so named (refused, naming them, when several do).
 */
export function findTicketRun(ticketId: number, run: number | string, repoId?: number) {
  const { ticket, config } = findTicketRunConfig(ticketId, run, repoId)
  const { workspace, reason } = runWorkspace(ticket, config.repoId, config.id)
  if (!workspace) throw new HttpError(400, reason ?? 'no workspace')
  return { ticket, config, workspace }
}

/** findTicketRun's run config, whether or not the ticket has a workspace to run it from. */
function findTicketRunConfig(ticketId: number, run: number | string, repoId?: number) {
  const ticket = getTicket(ticketId)
  const entries = reposOf(ticket, repoId)
  const found = entries.flatMap((e) =>
    listRunConfigs(e.repoId)
      .filter((c) =>
        typeof run === 'number' ? c.id === run : c.name.toLowerCase() === run.trim().toLowerCase(),
      )
      .map((c) => ({ entry: e, config: c })),
  )
  if (!found.length)
    throw new HttpError(
      404,
      `no run ${typeof run === 'number' ? `#${run}` : run} in ${entries.map((e) => e.name).join(', ') || 'the ticket’s repos'}: list_runs lists them`,
    )
  if (found.length > 1)
    throw new AmbiguousRun(
      400,
      `${found.length} repos have a run named ${run} (${found.map((f) => `${f.entry.repoId} ${f.entry.name}`).join(', ')}): give repoId`,
    )
  return { ticket, config: found[0]!.config }
}

/** start_run: one run of the ticket, by id or name; with `restart`, a running one is restarted. */
export async function startTicketRun(
  ticketId: number,
  run: number | string,
  actor: string,
  opts: { repoId?: number; restart?: boolean } = {},
) {
  const { config, workspace } = findTicketRun(ticketId, run, opts.repoId)
  return opts.restart ? restartRun(workspace.id, config.id, actor) : startRun(workspace.id, config.id, actor)
}

/**
 * stop_run: one run of the ticket that builds or runs, by id or name: of one of its repos, else one
 * of its orphaned runs (see `OrphanedRun`) so named, from every one of the ticket's workspaces it goes
 * from (`alsoRunning` included). A name several
 * of its repos have a run of is refused without repoId, orphans or not, as is one several repos it no
 * longer spans have a run going of.
 */
export async function stopTicketRun(
  ticketId: number,
  run: number | string,
  actor: string,
  opts: { repoId?: number } = {},
) {
  let found: (ReturnType<typeof findTicketRunConfig> & ReturnType<typeof runWorkspace>) | null = null
  let refused: HttpError | null = null
  try {
    const { ticket, config } = findTicketRunConfig(ticketId, run, opts.repoId)
    found = { ticket, config, ...runWorkspace(ticket, config.repoId, config.id) }
  } catch (err) {
    if (!(err instanceof HttpError) || err instanceof AmbiguousRun) throw err
    refused = err
  }
  if (found) {
    // A run of one of the ticket's repos is one run config: stopped from every one of the ticket's
    // workspaces it goes from (alsoRunning's too), the one its row shows first (its state is the answer).
    const { config, workspace } = found
    const going = activeOf(ticketId)
      .filter(({ r }) => r.runId === config.id)
      .sort((a, b) => Number(b.w.id === workspace?.id) - Number(a.w.id === workspace?.id))
    if (going.length) {
      const states: Awaited<ReturnType<typeof stopRun>>[] = []
      for (const { r } of going)
        states.push(await stopRun(r.workspaceId, r.runId, `stopped by ${actor}`, actor))
      return states[0]
    }
  }
  const orphans = orphanedRuns(getTicket(ticketId)).filter(
    (o) =>
      (!opts.repoId || o.repoId === opts.repoId) &&
      (typeof run === 'number' ? o.runId === run : o.name.toLowerCase() === run.trim().toLowerCase()),
  )
  // A run id, or a name within one repo, is one run config: the same run going from several of the
  // ticket's workspaces is stopped from all of them.
  const repos = [...new Map(orphans.map((o) => [o.repoId, o.repoName])).entries()]
  if (repos.length > 1)
    throw new HttpError(
      400,
      `${repos.length} repos that are no longer the ticket's have a run named ${run} going (${repos.map(([id, name]) => `${id} ${name}`).join(', ')}): give repoId, or stop them all`,
    )
  if (orphans.length) {
    const states: Awaited<ReturnType<typeof stopRun>>[] = []
    for (const o of orphans) states.push(await stopRun(o.workspace.id, o.runId, `stopped by ${actor}`, actor))
    return states[0]
  }
  if (refused) throw refused
  const { config, workspace, reason } = found!
  if (!workspace) throw new HttpError(400, reason ?? 'no workspace')
  throw new HttpError(409, `${config.name} does not run from workspace ${workspace.name}`)
}
