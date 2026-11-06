import fs from 'node:fs'
import path from 'node:path'

import { db, schema } from '#/db'
import { addWorkspace, getTicket } from './features'
import {
  addDetachedWorktree,
  checkoutDetached,
  fetchOriginBranch,
  gitSaid,
  headBranch,
  headSha,
  validBranchName,
  worktreeChanges,
} from './git'
import { HttpError } from './http'
import {
  isActive,
  managedPreview,
  restartPreview,
  startPreview,
  stopPreview,
  worktreeTarget,
} from './managedPreview'
import { getRepo } from './repos'
import { ticketCannotRun } from './runs'
import { ticketRepoList } from './ticketRepos'

/**
 * A preview of a branch the board's machine has no worktree of: work pushed from another machine (a
 * cloud session, another computer). The board fetches the branch from the repo's own origin into a
 * worktree of its own, detached at the branch's head, next to the repo's main checkout
 * (`<checkout>-preview-<branch>`), registers it as a workspace of the ticket and starts the repo's
 * preview run from it, as `start_preview` would. Asked again, it moves that worktree to the branch's
 * new head and builds again. It never makes or moves a branch, and it only moves a worktree it made: a
 * folder there that is on a branch, has changes, or is not a worktree of the repo is refused.
 */

const FETCH_TIMEOUT_MS = 60_000

/** The folder name part for a branch: `feat/login` becomes `feat-login`. */
export const branchSlug = (branch: string) =>
  branch
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80) || 'branch'

/** Where the board keeps its worktree of `branch`: beside the repo's main checkout. */
export function previewWorktreePath(repoPath: string, branch: string) {
  const main = path.resolve(repoPath)
  return path.join(path.dirname(main), `${path.basename(main)}-preview-${branchSlug(branch)}`)
}

/** Paths being prepared right now: a second call for one waits for nothing and is refused. */
const preparing = new Set<string>()

const samePath = (a: string, b: string) => {
  const r = (p: string) => {
    try {
      return fs.realpathSync.native(p)
    } catch {
      return path.resolve(p)
    }
  }
  const x = r(a)
  const y = r(b)
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

export async function previewBranch(
  ticketId: number,
  input: { branch?: string; repoId?: number },
  actor: string,
) {
  const ticket = getTicket(ticketId)
  const repos = ticketRepoList(ticket)
  const entry = input.repoId ? repos.find((r) => r.repoId === input.repoId) : repos[0]
  if (!entry)
    throw new HttpError(
      400,
      input.repoId
        ? `repo ${input.repoId} is not one of ticket ${ticketId}'s repos (${repos.map((r) => `${r.repoId} ${r.name}`).join(', ') || 'none'})`
        : `ticket ${ticketId}'s project has no repo`,
    )
  const refused = ticketCannotRun(ticketId)
  if (refused) throw new HttpError(409, refused)
  const repo = getRepo(entry.repoId)
  const branch = (input.branch ?? entry.branch ?? '').trim()
  if (!branch)
    throw new HttpError(
      400,
      `no branch to preview: give branch, or claim ticket ${ticketId} with its branch first`,
    )
  if (!(await validBranchName(repo.repoPath, branch)))
    throw new HttpError(400, `${JSON.stringify(branch)} is not a branch name`)

  const dir = previewWorktreePath(repo.repoPath, branch)
  if (preparing.has(dir)) throw new HttpError(409, `a preview of ${branch} is being prepared already`)
  preparing.add(dir)
  try {
    let sha: string | null
    try {
      sha = await fetchOriginBranch(repo.repoPath, branch, FETCH_TIMEOUT_MS)
    } catch (err) {
      throw new HttpError(502, `could not fetch ${branch} from origin: ${gitSaid(err)}`)
    }
    if (!sha) throw new HttpError(404, `origin has no branch ${branch}: push it first`)

    // Every workspace registered at that folder, on any ticket: it previews one branch for one ticket.
    const here = db
      .select()
      .from(schema.workspaces)
      .all()
      .filter((w) => w.path && samePath(w.path, dir))
    const other = here.find((w) => w.ticketId !== ticketId || (w.branch && w.branch !== branch))
    if (other)
      throw new HttpError(
        409,
        `${dir} is workspace ${other.id} of ticket ${other.ticketId}${other.branch ? `, on ${other.branch}` : ''}: remove it first`,
      )
    let ws = here.find((w) => w.repoId === entry.repoId) ?? null

    if (fs.existsSync(dir)) {
      const target = worktreeTarget({ path: dir }, repo)
      if (!target.ok) throw new HttpError(409, `${dir} exists and cannot be used: ${target.reason}`)
      const onBranch = await headBranch(dir)
      if (onBranch)
        throw new HttpError(
          409,
          `${dir} is on ${onBranch.replace(/^refs\/heads\//, '')}: the board only moves the detached worktrees it made`,
        )
      const changes = await worktreeChanges(dir)
      if (changes.length)
        throw new HttpError(409, `${dir} has changes the board would lose: ${changes.slice(0, 5).join(', ')}`)
      if ((await headSha(dir)) !== sha) {
        // The build runs from these files: nothing of the old head may keep running while they change.
        if (ws && isActive(managedPreview(ws.id)))
          await stopPreview(ws.id, `moving to ${sha.slice(0, 7)}`, actor)
        try {
          await checkoutDetached(dir, sha)
        } catch (err) {
          throw new HttpError(409, `could not move ${dir} to ${sha.slice(0, 7)}: ${gitSaid(err)}`)
        }
      }
    } else {
      try {
        await addDetachedWorktree(repo.repoPath, dir, sha)
      } catch (err) {
        throw new HttpError(409, `could not make a worktree at ${dir}: ${gitSaid(err)}`)
      }
    }

    ws ??= addWorkspace(
      ticketId,
      { name: `preview ${branch}`, branch, path: dir, repoId: entry.repoId },
      actor,
    )
    const preview = isActive(managedPreview(ws.id))
      ? await restartPreview(ws.id, actor)
      : startPreview(ws.id, actor)
    return { workspace: ws, branch, sha, path: dir, preview }
  } finally {
    preparing.delete(dir)
  }
}
