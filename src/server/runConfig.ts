import fs from 'node:fs'
import path from 'node:path'

import { and, asc, eq, ne } from 'drizzle-orm'

import { db, schema } from '#/db'
import { DEFAULT_RUN, type RunConfigInput, runConfigProblem } from '#/lib/runs'
import { logActivity } from './activity'
import { HttpError, notFound } from './http'

/**
 * The runs of each repo, as the human configures them in the project's settings and agents with the MCP
 * add_run, update_run and delete_run: what the board may start from a ticket's worktree of the repo
 * (src/server/runs.ts). Every write, whoever makes it, goes through here with the same checks and is in
 * the project's activity under its author's name; what runs is always what is stored here, never what a
 * start request carries.
 */

export type RunConfig = schema.RunConfig

/** Whether the repo's checkout is the board itself: the repo its own preview is seeded for. */
function isBoardCheckout(repoPath: string): boolean | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8')) as {
      name?: string
    }
    return pkg.name === 'agent-board'
  } catch {
    // Not on this machine (yet), or not a node project: nothing to tell.
    return null
  }
}

/**
 * Give a checkout of the board the preview it always had (`DEFAULT_RUN`), once: a repo that was given
 * it is never given it again, so a run the human deleted stays deleted. Other repos get none.
 */
export function seedRepo(repo: Pick<schema.Repo, 'id' | 'repoPath' | 'runsSeeded' | 'projectId'>) {
  if (repo.runsSeeded || !isBoardCheckout(repo.repoPath)) return false
  return db.transaction(
    (tx) => {
      // Another request may have seeded it since the row was read.
      const now = tx.select().from(schema.repos).where(eq(schema.repos.id, repo.id)).get()
      if (!now || now.runsSeeded) return false
      const taken = tx
        .select({ id: schema.runConfigs.id })
        .from(schema.runConfigs)
        .where(and(eq(schema.runConfigs.repoId, repo.id), eq(schema.runConfigs.name, DEFAULT_RUN.name)))
        .get()
      if (!taken) {
        const position = tx
          .select()
          .from(schema.runConfigs)
          .where(eq(schema.runConfigs.repoId, repo.id))
          .all().length
        tx.insert(schema.runConfigs)
          .values({ ...DEFAULT_RUN, repoId: repo.id, position, createdBy: 'board' })
          .run()
      }
      tx.update(schema.repos).set({ runsSeeded: true }).where(eq(schema.repos.id, repo.id)).run()
      return !taken
    },
    { behavior: 'immediate' },
  )
}

/** Every repo the board knows that is a checkout of the board and was never seeded: as the board starts. */
export function seedRuns() {
  for (const repo of db.select().from(schema.repos).all())
    try {
      seedRepo(repo)
    } catch (err) {
      console.error(`could not seed the runs of repo ${repo.name}:`, err)
    }
}

/** A repo's runs, in the human's order. */
export function listRunConfigs(repoId: number): RunConfig[] {
  const repo = db.select().from(schema.repos).where(eq(schema.repos.id, repoId)).get()
  if (!repo) throw notFound('repo')
  seedRepo(repo)
  return db
    .select()
    .from(schema.runConfigs)
    .where(eq(schema.runConfigs.repoId, repoId))
    .orderBy(asc(schema.runConfigs.position), asc(schema.runConfigs.id))
    .all()
}

export function getRunConfig(id: number): RunConfig {
  const row = db.select().from(schema.runConfigs).where(eq(schema.runConfigs.id, id)).get()
  if (!row) throw notFound('run')
  return row
}

/** A run as a write gives it, with what it leaves out: a preview answers on `/`, a job on no port. */
function normalize(input: Partial<RunConfigInput>, before?: RunConfig): RunConfigInput {
  const type = input.type ?? before?.type ?? 'preview'
  const changedType = before !== undefined && input.type !== undefined && input.type !== before.type
  const kept = <K extends keyof RunConfigInput>(key: K, fallback: RunConfigInput[K]) =>
    input[key] !== undefined ? input[key] : before && !changedType ? before[key] : fallback
  return {
    name: (input.name ?? before?.name ?? '').trim(),
    type,
    install: (input.install ?? before?.install ?? '').trim(),
    build: (input.build ?? before?.build ?? '').trim(),
    start: (input.start ?? before?.start ?? '').trim(),
    env: input.env ?? before?.env ?? {},
    copyData: input.copyData ?? before?.copyData ?? false,
    port: kept('port', null),
    healthPath: kept('healthPath', type === 'preview' ? '/' : ''),
  }
}

function assertValid(run: RunConfigInput, repoId: number, except?: number) {
  const others = db
    .select({ name: schema.runConfigs.name })
    .from(schema.runConfigs)
    .where(
      except === undefined
        ? eq(schema.runConfigs.repoId, repoId)
        : and(eq(schema.runConfigs.repoId, repoId), ne(schema.runConfigs.id, except)),
    )
    .all()
  const problem = runConfigProblem(run, others)
  if (problem) throw new HttpError(400, problem)
}

function getRepoRow(repoId: number) {
  const repo = db.select().from(schema.repos).where(eq(schema.repos.id, repoId)).get()
  if (!repo) throw notFound('repo')
  return repo
}

const logRun = (repo: schema.Repo, actor: string, text: string) =>
  logActivity({ projectId: repo.projectId, actor, kind: 'project', text, refType: 'repo', refId: repo.id })

export function createRunConfig(repoId: number, input: Partial<RunConfigInput>, actor: string) {
  const repo = getRepoRow(repoId)
  const run = normalize(input)
  assertValid(run, repoId)
  const position = db
    .select()
    .from(schema.runConfigs)
    .where(eq(schema.runConfigs.repoId, repoId))
    .all().length
  const row = db
    .insert(schema.runConfigs)
    .values({ ...run, repoId, position, createdBy: actor })
    .returning()
    .get()
  logRun(repo, actor, `added the ${run.type} run ${row.name} to repo ${repo.name}`)
  return row
}

export function updateRunConfig(id: number, patch: Partial<RunConfigInput>, actor: string) {
  const before = getRunConfig(id)
  const repo = getRepoRow(before.repoId)
  const run = normalize(patch, before)
  assertValid(run, before.repoId, id)
  const row = db
    .update(schema.runConfigs)
    .set({ ...run, updatedAt: new Date().toISOString() })
    .where(eq(schema.runConfigs.id, id))
    .returning()
    .get()!
  logRun(
    repo,
    actor,
    `changed the run ${before.name}${row.name !== before.name ? ` (now ${row.name})` : ''} of repo ${repo.name}`,
  )
  return row
}

/** Callers stop what runs of it first (runs.ts `forgetRunConfig`). */
export function deleteRunConfig(id: number, actor: string) {
  const row = getRunConfig(id)
  const repo = getRepoRow(row.repoId)
  db.delete(schema.runConfigs).where(eq(schema.runConfigs.id, id)).run()
  logRun(repo, actor, `removed the run ${row.name} from repo ${repo.name}`)
  return row
}

/** `ids`: every run of the repo, in the new order. */
export function reorderRunConfigs(repoId: number, ids: number[], actor: string) {
  const repo = getRepoRow(repoId)
  const rows = listRunConfigs(repoId)
  const known = new Set(rows.map((r) => r.id))
  if (ids.length !== rows.length || new Set(ids).size !== ids.length || ids.some((x) => !known.has(x)))
    throw new HttpError(400, `ids: every run of repo ${repo.name}, each once`)
  db.transaction((tx) => {
    ids.forEach((runId, position) =>
      tx.update(schema.runConfigs).set({ position }).where(eq(schema.runConfigs.id, runId)).run(),
    )
  })
  logRun(repo, actor, `reordered the runs of repo ${repo.name}`)
  return listRunConfigs(repoId)
}
