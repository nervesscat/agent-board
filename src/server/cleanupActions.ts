import { eq, inArray } from 'drizzle-orm'

import { db, schema } from '#/db'
import { logActivity } from './activity'
import { cleanupReport, type LeftoverBranch, pathKey, samePath } from './cleanup'
import { deleteWorkspace } from './features'
import { deleteLocalBranch, deleteOriginBranch, gitSaid, removeWorktree, worktreeChanges } from './git'
import { activePreviews, stopPreview } from './managedPreview'
import { getProject } from './projects'
import { dropListings, fetchRepo, fetchStatus } from './push'
import { listRepos } from './repos'

/**
 * The Cleanup page's delete actions, the human's alone: a closed ticket's worked branch deleted here,
 * on origin, or with its worktrees. Each item is checked again just before it is acted on, on git's
 * state as it is then (origin fetched first) and against the commit the human saw; the deletions in
 * one checkout run one at a time. Nothing is forced: a worktree with changes, a branch that moved and
 * an origin branch someone pushed to are all left alone.
 */

export const DELETE_KINDS = ['local', 'remote', 'worktrees'] as const
export type DeleteKind = (typeof DELETE_KINDS)[number]

export interface DeleteItem {
  ticketId: number
  branch: string
  /** The local branch, origin's, or the branch's worktrees and then the local branch. */
  kind: DeleteKind
  /**
   * The commit the human saw: origin's for `remote`, the local branch's otherwise (null when there
   * was none). One that moved since is not deleted.
   */
  sha: string | null
  /** The worktrees the human saw listed (`worktrees`): one that is not among them is never removed. */
  worktrees?: string[]
}

export interface DeleteResult extends DeleteItem {
  /** Deleted, or already gone. */
  ok: boolean
  outcome: 'deleted' | 'gone' | 'refused' | 'failed'
  /** Why it was refused or failed, or how it was already gone. */
  reason: string | null
  /** The worktrees removed, also when a later step failed. */
  removed: string[]
  /** The commands that put back what was deleted. */
  restore: string[]
}

/** How long a push to origin may take. */
const ORIGIN_TIMEOUT = 60_000

/** Each checkout's deletions, one after the other: git's ref and worktree locks never collide. */
const queues = new Map<string, Promise<unknown>>()

function inTurn<T>(repoPath: string, work: () => Promise<T>): Promise<T> {
  const key = pathKey(repoPath)
  const next = (queues.get(key) ?? Promise.resolve()).then(work, work)
  const tail = next.catch(() => {})
  queues.set(key, tail)
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return next
}

const result = (
  item: DeleteItem,
  outcome: DeleteResult['outcome'],
  reason: string | null,
  done: { removed?: string[]; restore?: string[] } = {},
): DeleteResult => ({
  ...item,
  ok: outcome === 'deleted' || outcome === 'gone',
  outcome,
  reason,
  removed: done.removed ?? [],
  restore: done.restore ?? [],
})

const short = (sha: string) => sha.slice(0, 7)

/**
 * Deletes what the human confirmed, item by item: one refused or failing does not stop the rest.
 * Answers each item's outcome, in the order asked.
 */
export async function deleteLeftovers(
  projectId: number,
  items: DeleteItem[],
  actor: string,
): Promise<DeleteResult[]> {
  getProject(projectId)
  const repos = listRepos(projectId)
  const results: DeleteResult[] = []
  const byRepo = new Map<string, { repoPath: string; at: number[] }>()
  items.forEach((item, i) => {
    const t = db.select().from(schema.tickets).where(eq(schema.tickets.id, item.ticketId)).get()
    if (!t || t.projectId !== projectId)
      return (results[i] = result(item, 'refused', `#${item.ticketId} is no ticket of this project`))
    const repo = (t.repoId ? repos.find((r) => r.id === t.repoId) : repos[0]) ?? null
    if (!repo) return (results[i] = result(item, 'refused', 'the ticket has no repo'))
    const key = pathKey(repo.repoPath)
    if (!byRepo.has(key)) byRepo.set(key, { repoPath: repo.repoPath, at: [] })
    byRepo.get(key)!.at.push(i)
  })
  await Promise.all(
    [...byRepo.values()].map(({ repoPath, at }) =>
      inTurn(repoPath, async () => {
        // Origin's branches as they are now, not as of the last fetch.
        if (at.some((i) => items[i]!.kind === 'remote')) await fetchRepo(repoPath, { force: true })
        const fetchError = fetchStatus(repoPath).error
        for (const i of at) {
          const item = items[i]!
          try {
            results[i] = await deleteOne(projectId, item, actor, fetchError)
          } catch (err) {
            results[i] = result(item, 'failed', gitSaid(err))
          } finally {
            // The ticket's git panel and the push dots read the checkout afresh.
            dropListings(repoPath)
          }
        }
      }),
    ),
  )
  return results
}

async function deleteOne(
  projectId: number,
  item: DeleteItem,
  actor: string,
  fetchError: string | null,
): Promise<DeleteResult> {
  const report = await cleanupReport(projectId, { only: [item.ticketId] })
  const t = report.tickets[0]
  if (!t) return result(item, 'refused', `#${item.ticketId} is not done, cancelled or archived any more`)
  const b = t.branches.find((x) => x.name === item.branch)
  if (!b) return result(item, 'refused', `${item.branch} is no branch of #${t.id}`)
  // Before anything else: a listing git could not make says nothing about what is gone.
  const blocked = report.deleteOff ?? report.repos.find((r) => r.id === t.repo?.id)?.error ?? null
  if (blocked || !t.repo) return result(item, 'refused', blocked ?? 'the ticket has no repo')
  // A protected branch is never deleted, in any form, nor anything with it.
  if (b.protected) return result(item, 'refused', b.protected)
  const repoPath = t.repo.path
  const log = (text: string) =>
    logActivity({
      projectId,
      actor,
      kind: 'git',
      text: `${text} of #${t.id}`,
      refType: 'ticket',
      refId: t.id,
    })

  if (item.kind === 'remote') {
    if (fetchError) return result(item, 'refused', `origin could not be fetched to check it: ${fetchError}`)
    if (!b.remote) return result(item, 'gone', `origin has no ${b.name} any more`)
    if (b.remote !== item.sha)
      return result(item, 'refused', `origin's ${b.name} moved since: now at ${short(b.remote)}`)
    if (!b.can.remote.ok) return result(item, 'refused', b.can.remote.reason)
    await deleteOriginBranch(repoPath, b.name, b.remote, ORIGIN_TIMEOUT)
    log(`deleted origin's branch ${b.name} @ ${b.remote}`)
    return result(item, 'deleted', null, { restore: [b.restoreRemote!] })
  }

  if (item.kind === 'local') return deleteLocal(item, b, repoPath, log)

  // The worktrees, then the local branch.
  const sent = item.worktrees ?? []
  if (sent.some((p) => samePath(p, repoPath) || b.worktrees.some((w) => w.main && samePath(w.path, p))))
    return result(item, 'refused', 'the main checkout is never removed')
  const trees = b.worktrees.filter((w) => !w.main)
  if (!trees.length) {
    if (!b.local) return result(item, 'gone', `${b.name} and its worktrees are gone already`)
    return deleteLocal(item, b, repoPath, log)
  }
  if (b.local && b.local !== item.sha)
    return result(item, 'refused', `${b.name} moved since: now at ${short(b.local)}`)
  const unseen = trees.filter((w) => !sent.some((p) => samePath(p, w.path)))
  if (unseen.length)
    return result(
      item,
      'refused',
      `${unseen.map((w) => w.path).join(', ')} came up since: refresh and confirm again`,
    )
  if (!b.can.worktrees.ok) return result(item, 'refused', b.can.worktrees.reason)
  // All of them are checked before any is removed: git refuses one with changes, and a refusal
  // half-way would leave the rest removed for nothing.
  for (const w of trees) {
    const changes = await worktreeChanges(w.path).catch((err: unknown) => [gitSaid(err)])
    if (changes.length)
      return result(
        item,
        'refused',
        `${w.path} has changes or untracked files: ${changes.slice(0, 3).join(', ')}${changes.length > 3 ? ', …' : ''}`,
      )
  }
  const removed: string[] = []
  // A worktree on the branch can only be added back once the branch is.
  const restore: string[] = []
  for (const w of trees) {
    await stopPreviews(w.path, actor)
    try {
      await removeWorktree(repoPath, w.path)
    } catch (err) {
      return result(item, 'failed', `${w.path}: ${gitSaid(err)}; ${b.name} is kept`, { removed, restore })
    }
    removed.push(w.path)
    restore.push(
      w.branch
        ? `git worktree add "${w.path}" ${w.branch}`
        : `git worktree add --detach "${w.path}" ${w.head}`,
    )
    log(`removed the worktree ${w.path} (${w.branch ?? `detached at ${w.head}`})`)
    forgetWorkspaces(projectId, w.path, actor)
  }
  if (b.local) {
    try {
      await deleteLocalBranch(repoPath, b.name, b.local)
    } catch (err) {
      return result(item, 'failed', `${b.name}: ${gitSaid(err)}`, { removed, restore })
    }
    log(`deleted the branch ${b.name} @ ${b.local}`)
    restore.unshift(b.restore!)
  }
  return result(item, 'deleted', null, { removed, restore })
}

async function deleteLocal(
  item: DeleteItem,
  b: LeftoverBranch,
  repoPath: string,
  log: (text: string) => void,
): Promise<DeleteResult> {
  if (!b.local) return result(item, 'gone', `${b.name} is gone already`)
  if (b.local !== item.sha) return result(item, 'refused', `${b.name} moved since: now at ${short(b.local)}`)
  if (!b.can.local.ok) return result(item, 'refused', b.can.local.reason)
  await deleteLocalBranch(repoPath, b.name, b.local)
  log(`deleted the branch ${b.name} @ ${b.local}`)
  return result(item, 'deleted', null, { restore: [b.restore!] })
}

/** A preview the board builds or runs from the worktree stops first, and is waited for. */
async function stopPreviews(worktreePath: string, actor: string) {
  for (const p of activePreviews().filter((p) => samePath(p.path, worktreePath)))
    await stopPreview(p.workspaceId, 'its worktree was removed', actor)
}

/** The project's workspaces registered at a removed worktree go too. */
function forgetWorkspaces(projectId: number, worktreePath: string, actor: string) {
  const ids = db
    .select({ id: schema.tickets.id })
    .from(schema.tickets)
    .where(eq(schema.tickets.projectId, projectId))
    .all()
    .map((x) => x.id)
  const at = db
    .select()
    .from(schema.workspaces)
    .where(inArray(schema.workspaces.ticketId, ids))
    .all()
    .filter((w) => w.path && samePath(w.path, worktreePath))
  for (const w of at) deleteWorkspace(w.id, actor)
}
