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

export interface TicketRuns {
  ticketId: number
  repos: TicketRunsRepo[]
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

/** Every run of every repo of the ticket, grouped by repo in the ticket's order. */
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

/** Stop all: every run of the ticket (of one of its repos, given `repoId`) that builds or runs. */
export async function stopTicketRuns(ticketId: number, actor: string, opts: { repoId?: number } = {}) {
  const ticket = getTicket(ticketId)
  const repos = new Set(reposOf(ticket, opts.repoId).map((e) => e.repoId))
  const workspaces = db.select().from(schema.workspaces).where(eq(schema.workspaces.ticketId, ticketId)).all()
  const active = workspaces
    .flatMap((w) => workspaceRuns(w.id))
    .filter((r) => isActive(r) && repos.has(r.repoId))
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

/**
 * One run of the ticket, by its id or its name (any casing), in `repoId` or, without it, in whichever
 * of the ticket's repos has a run so named (refused, naming them, when several do).
 */
export function findTicketRun(ticketId: number, run: number | string, repoId?: number) {
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
    throw new HttpError(
      400,
      `${found.length} repos have a run named ${run} (${found.map((f) => `${f.entry.repoId} ${f.entry.name}`).join(', ')}): give repoId`,
    )
  const { config } = found[0]!
  const { workspace, reason } = runWorkspace(ticket, config.repoId, config.id)
  if (!workspace) throw new HttpError(400, reason ?? 'no workspace')
  return { ticket, config, workspace }
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

/** stop_run: one run of the ticket that builds or runs, by id or name. */
export async function stopTicketRun(
  ticketId: number,
  run: number | string,
  actor: string,
  opts: { repoId?: number } = {},
) {
  const { config, workspace } = findTicketRun(ticketId, run, opts.repoId)
  if (!isActive(runState(workspace.id, config.id)))
    throw new HttpError(409, `${config.name} does not run from workspace ${workspace.name}`)
  return stopRun(workspace.id, config.id, `stopped by ${actor}`, actor)
}
