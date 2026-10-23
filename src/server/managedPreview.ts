import { eq } from 'drizzle-orm'

import { db, schema } from '#/db'
import { HttpError, notFound } from './http'
import {
  cannotStartRun,
  defaultRunOf,
  forgetWorkspaceRuns,
  restartRun,
  runLog,
  runState,
  startRun,
  stopRun,
  type RunState,
  workspaceCannotRun,
  workspaceRuns,
} from './runs'

/**
 * The preview of a workspace as the board ran it before runs were configurable: one per workspace,
 * now the first preview-type run of the workspace's repo (the seeded `Preview` on a checkout of the
 * board). `start_preview`, `stop_preview`, the workspace's preview routes and the Previews page go
 * through these; the runs engine (runs.ts) does the work.
 */

export {
  activeRuns as activePreviews,
  holdRuns as holdPreviews,
  hasRuns as hasPreviews,
  isActive,
  KEPT,
  needsInstall,
  PORTS,
  previewLimit,
  previewNode,
  previewToolProblem,
  RESTARTED,
  runsInUse as previewsInUse,
  runsSettled as previewsSettled,
  serverEnv,
  setPreviewRunner,
  stopAllRuns as stopAllPreviews,
  stopProjectRuns as stopProjectPreviews,
  stopRunsFor as stopPreviewsFor,
  stopRunsOnExit as stopPreviewsOnExit,
  worktreeTarget,
} from './runs'
export type {
  PreviewRunner,
  PreviewTarget,
  Proc,
  RunStatus as ManagedStatus,
  RunStep as ManagedStep,
} from './runs'

export type ManagedPreview = RunState

function workspaceOf(id: number) {
  const ws = db.select().from(schema.workspaces).where(eq(schema.workspaces.id, id)).get()
  if (!ws) throw notFound('workspace')
  return ws
}

/** The repo of the workspace's worktree: its own, else its ticket's primary repo (or the project's first). */
function repoIdOf(ws: schema.Workspace): number | null {
  if (ws.repoId) return ws.repoId
  const t = db.select().from(schema.tickets).where(eq(schema.tickets.id, ws.ticketId)).get()
  if (!t) return null
  if (t.repoId) return t.repoId
  const repos = db.select().from(schema.repos).where(eq(schema.repos.projectId, t.projectId)).all()
  repos.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id - b.id))
  return repos[0]?.id ?? null
}

/** The workspace's preview run: the first preview-type run of its repo, or null when it has none. */
export function previewRunOf(workspaceId: number) {
  return defaultRunOf(repoIdOf(workspaceOf(workspaceId)))
}

const NO_PREVIEW_RUN =
  "the workspace's repo has no preview run: the human adds one in the project's settings (Runs)"

function previewRunId(workspaceId: number) {
  const run = previewRunOf(workspaceId)
  if (!run) throw new HttpError(400, NO_PREVIEW_RUN)
  return run.id
}

/** The board's own preview of a workspace, or null when it never ran one. */
export function managedPreview(workspaceId: number): ManagedPreview | null {
  const ws = db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get()
  // Gone: what the board still remembers of it until its runs are forgotten.
  if (!ws) return workspaceRuns(workspaceId).find((r) => r.runType === 'preview') ?? null
  const run = defaultRunOf(repoIdOf(ws))
  return run ? runState(workspaceId, run.id) : null
}

/** Whether a start would be refused before anything runs; null when it may start. */
export function cannotStart(workspaceId: number): string | null {
  const run = previewRunOf(workspaceId)
  // What stands in the way of any run comes first: it says more than the missing run.
  return run ? cannotStartRun(workspaceId, run.id) : (workspaceCannotRun(workspaceId) ?? NO_PREVIEW_RUN)
}

export function startPreview(workspaceId: number, actor: string, opts: { replacing?: boolean } = {}) {
  return startRun(workspaceId, previewRunId(workspaceId), actor, opts)
}

export async function stopPreview(workspaceId: number, reason: string, actor: string) {
  const run = previewRunOf(workspaceId)
  return run ? stopRun(workspaceId, run.id, reason, actor) : null
}

export function restartPreview(workspaceId: number, actor: string) {
  return restartRun(workspaceId, previewRunId(workspaceId), actor)
}

/** A log of the preview, for the "full log" link. */
export function previewLog(workspaceId: number, name: 'build' | 'server') {
  const run = previewRunOf(workspaceId)
  if (!run || !runState(workspaceId, run.id))
    throw new HttpError(404, 'the board never ran a preview of this workspace')
  return runLog(workspaceId, run.id, name)
}

/** The workspace is going: stop its runs and forget them. Call before the row is deleted. */
export const forgetPreview = forgetWorkspaceRuns
