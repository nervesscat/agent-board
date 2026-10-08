import crypto from 'node:crypto'

import { eq, inArray } from 'drizzle-orm'

import { db, schema } from '#/db'
import { isClosed } from '#/lib/stages'
import {
  aheadBehind,
  type BranchInfo,
  branchReach,
  commitSummary,
  listRefs,
  listWorktrees,
  NO_BRANCH,
  refsContaining,
  type Reach,
  type Refs,
  type Worktree,
} from './git'
import { activePreviews, type ManagedPreview } from './managedPreview'
import { getProject } from './projects'
import { readRefs, readWorktrees } from './push'
import { listRepos } from './repos'
import { kindOf, listStages } from './stages'
import { unattachedUploads, type UnattachedUploads } from './unattached'

/**
 * What is left behind by finished work: branches, worktrees and registered workspaces of tickets in
 * a done or cancelled stage or archived, and whether each branch's work reached where it was meant to
 * land. The board only reads git; deleting is the agents' and the human's job.
 */

type Chainable = Pick<schema.Ticket, 'id' | 'parentId' | 'repoId' | 'baseBranch'>
type RepoRow = schema.Repo

/**
 * One `for-each-ref` and one `worktree list` per repo, however many tickets ask. `recent` takes them
 * from the listings every read shares for a few seconds (`readRefs`), instead of listing afresh.
 */
export function gitCache(opts: { recent?: boolean } = {}) {
  const cache = new Map<string, Promise<{ refs: Refs; worktrees: Worktree[] }>>()
  const refsOf = opts.recent ? readRefs : (p: string) => listRefs(p).catch(() => null)
  const worktreesOf = opts.recent ? readWorktrees : (p: string) => listWorktrees(p).catch(() => null)
  return (repoPath: string) => {
    if (!cache.has(repoPath))
      cache.set(
        repoPath,
        Promise.all([refsOf(repoPath), worktreesOf(repoPath)]).then(([refs, worktrees]) => ({
          refs: refs ?? { local: new Map(), remote: new Map() },
          worktrees: worktrees ?? [],
        })),
      )
    return cache.get(repoPath)!
  }
}

export type GitCache = ReturnType<typeof gitCache>

/**
 * Where a ticket's work should end up, nearest first: its base (for a lane, the parent's branch),
 * then the base of each ticket above it in the same repo, then the repo's base branch. A lane is done
 * with once it reached its parent's branch; the parent once it reached dev.
 */
export function baseChain(ticket: Chainable, byId: Map<number, Chainable>, repo: RepoRow | null): string[] {
  const repoOf = (t: Chainable) => t.repoId ?? repo?.id ?? null
  const chain = [ticket.baseBranch]
  for (let p = ticket.parentId ? byId.get(ticket.parentId) : undefined; p; ) {
    if (repoOf(p) === repoOf(ticket)) chain.push(p.baseBranch)
    p = p.parentId ? byId.get(p.parentId) : undefined
  }
  if (repo) chain.push(repo.baseBranch)
  return [...new Set(chain.filter(Boolean))]
}

/** The refs a base name stands for: the local branch, then origin's copy; either may be ahead. */
export function baseRefs(chain: string[], refs: Refs): string[] {
  return chain.flatMap((b) => [
    ...(refs.local.has(b) ? [b] : []),
    ...(refs.remote.has(b) ? [`origin/${b}`] : []),
  ])
}

/** The ref a branch is read from: the local branch, else origin's. */
export const branchRef = (branch: string, refs: Refs) =>
  refs.local.has(branch) ? branch : refs.remote.has(branch) ? `origin/${branch}` : null

/** The commit a ref from `branchRef` or `baseRefs` points at. */
export const refSha = (ref: string, refs: Refs) =>
  refs.local.get(ref) ?? (ref.startsWith('origin/') ? refs.remote.get(ref.slice(7)) : undefined)

/**
 * Answers already worked out, by the commits they were worked out for: a verdict on the same commits
 * never changes, so the board's polling asks git again only once a branch or a base moves. Bounded:
 * the oldest answers go first.
 */
const REACH_MEMO_MAX = 2000
const reachMemo = new Map<string, Promise<Reach | null>>()

export function memo<T>(cache: Map<string, Promise<T>>, max: number, key: string, work: () => Promise<T>) {
  const hit = cache.get(key)
  if (hit) return hit
  const p = work()
  cache.set(key, p)
  // A failure (a ref gone mid-read) is not remembered.
  p.catch(() => cache.delete(key))
  while (cache.size > max) cache.delete(cache.keys().next().value!)
  return p
}

export async function reachOf(repoPath: string, branch: string, chain: string[], refs: Refs) {
  const ref = branch ? branchRef(branch, refs) : null
  if (!ref) return null
  // A branch is not its own destination (a workspace on the ticket's own branch).
  const bases = baseRefs(chain, refs).filter((b) => b !== ref && b !== branch)
  const key = [repoPath, `${ref}@${refSha(ref, refs)}`, ...bases.map((b) => `${b}@${refSha(b, refs)}`)]
  return memo(reachMemo, REACH_MEMO_MAX, key.join('\0'), () => branchReach(repoPath, ref, bases))
}

/** A commit's subject and date, and how far apart two commits are: by their shas, so never stale. */
const INFO_MEMO_MAX = 2000
const commitMemo = new Map<string, Promise<{ subject: string; authoredAt: string }>>()
const distanceMemo = new Map<string, Promise<[number, number]>>()

/**
 * A branch's last commit and how far it is ahead of and behind `base`, from the ref listing: a branch
 * and base that did not move cost no git at all. The local branch is read first, else origin's.
 */
export async function infoOf(
  repoPath: string,
  branch: string,
  base: string,
  refs: Refs,
): Promise<BranchInfo> {
  const ref = branch ? branchRef(branch, refs) : null
  if (!ref) return NO_BRANCH
  const sha = refSha(ref, refs)!
  // A base that is no branch here nor `origin/<name>` (a tag, a sha) is left to git to read.
  const baseSha = base ? refSha(base, refs) : undefined
  const [commit, counts] = await Promise.all([
    // git failing to read it (the checkout gone since it was listed) reads as no branch, as before.
    memo(commitMemo, INFO_MEMO_MAX, `${repoPath}\0${sha}`, () => commitSummary(repoPath, sha)).catch(
      () => null,
    ),
    (baseSha
      ? memo(distanceMemo, INFO_MEMO_MAX, `${repoPath}\0${baseSha}...${sha}`, () =>
          aheadBehind(repoPath, baseSha, sha),
        )
      : aheadBehind(repoPath, base, sha)
    ).catch(() => null),
  ])
  if (!commit) return NO_BRANCH
  const [behind = null, ahead = null] = counts ?? []
  return { exists: true, sha, ...commit, ahead, behind }
}

/** Which branches hold a commit, by the commit and the sha of every branch: asked again once one moves. */
const CONTAINS_MEMO_MAX = 500
const containsMemo = new Map<string, Promise<Set<string>>>()

const refsKey = (refs: Refs) => {
  const hash = crypto.createHash('sha1')
  for (const [name, sha] of refs.local) hash.update(`${name} ${sha}\n`)
  for (const [name, sha] of refs.remote) hash.update(`origin/${name} ${sha}\n`)
  return hash.digest('hex')
}

/** A ticket's branch that a detached worktree is checked out at a commit of. */
interface Claim {
  ticketId: number
  branch: string
}

/**
 * The tickets a worktree checked out detached at `head` (a review of a commit) works for: those with a
 * branch at that commit, else those whose branch holds it while none of their bases does (the branch
 * moved on since; a commit the bases have, such as dev's tip, is no ticket's own work). Empty when git
 * cannot tell, so the worktree stays untracked.
 */
async function detachedClaims(
  repoPath: string,
  head: string,
  refs: Refs,
  tickets: { id: number; names: string[]; chain: string[] }[],
): Promise<Claim[]> {
  const claims = (t: (typeof tickets)[number], holds: (name: string) => boolean) =>
    t.names.filter(holds).map((branch) => ({ ticketId: t.id, branch }))
  const tips = tickets.flatMap((t) =>
    claims(t, (n) => refs.local.get(n) === head || refs.remote.get(n) === head),
  )
  if (tips.length) return tips
  // Only now the costlier question, and only when some ticket has a branch here to ask it of.
  const present = tickets.filter((t) => t.names.some((n) => refs.local.has(n) || refs.remote.has(n)))
  if (!present.length) return []
  const key = [repoPath, head, refsKey(refs)].join('\0')
  const holding = await memo(containsMemo, CONTAINS_MEMO_MAX, key, () =>
    refsContaining(repoPath, head),
  ).catch(() => null)
  if (!holding) return []
  return present.flatMap((t) => {
    // The ticket's own branches are not its bases (a workspace on the ticket's own branch).
    const bases = baseRefs(
      t.chain.filter((b) => !t.names.includes(b)),
      refs,
    )
    if (bases.some((b) => holding.has(b))) return []
    return claims(t, (n) => holding.has(n) || holding.has(`origin/${n}`))
  })
}

const samePath = (a: string, b: string) =>
  a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() ===
  b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

export interface LeftoverBranch {
  name: string
  /** Sha of the local branch; null when it is gone locally. */
  local: string | null
  /** Sha of origin's branch as of the last fetch; null when origin has none. */
  remote: string | null
  /**
   * Worktrees with this branch checked out, or checked out detached at one of its commits. `main` is
   * the repo's own checkout, not a worktree.
   */
  worktrees: { path: string; main: boolean }[]
  reach: Reach | null
  /** Recreates the branch after it was deleted. */
  restore: string | null
}

export interface LeftoverTicket {
  id: number
  title: string
  status: string
  parentId: number | null
  repo: { id: number; name: string; path: string } | null
  /** Where the work should have landed, nearest first. */
  chain: string[]
  workspaces: schema.Workspace[]
  /** Previews the board still builds or runs from its workspaces. */
  previews: ManagedPreview[]
  branches: LeftoverBranch[]
  /** True when nothing on it holds work its bases lack (every branch merged, rebased or edited in). */
  safe: boolean
}

export interface CleanupReport {
  tickets: LeftoverTicket[]
  /**
   * Worktrees no ticket or workspace on the board accounts for (by branch, registered path, or the
   * ticket's branch commit a detached one is at): register them or remove them.
   */
  untracked: { repo: string; path: string; branch: string | null; head: string | null }[]
  counts: {
    tickets: number
    workspaces: number
    previews: number
    worktrees: number
    branches: number
    remote: number
  }
  /** Uploads nothing on the whole board points at (not just this project's). */
  uploads: UnattachedUploads
}

/**
 * The project's closed tickets that still have a registered workspace, a local or origin branch, or a
 * worktree, each branch checked against the ticket's base chain (skip that with `reach: false` for a
 * quick count).
 */
export async function cleanupReport(
  projectId: number,
  opts: { reach?: boolean } = {},
): Promise<CleanupReport> {
  getProject(projectId)
  const reach = opts.reach ?? true
  const stages = listStages(projectId)
  const repos = listRepos(projectId)
  const repoById = new Map(repos.map((r) => [r.id, r]))
  const repoOf = (t: Pick<schema.Ticket, 'repoId'>) => (t.repoId ? repoById.get(t.repoId) : repos[0]) ?? null
  const all = db.select().from(schema.tickets).where(eq(schema.tickets.projectId, projectId)).all()
  const byId = new Map(all.map((t) => [t.id, t]))
  const workspaces = all.length
    ? db
        .select()
        .from(schema.workspaces)
        .where(
          inArray(
            schema.workspaces.ticketId,
            all.map((t) => t.id),
          ),
        )
        .all()
    : []
  const git = gitCache()
  const previews = activePreviews()
  const namesOf = (t: schema.Ticket) => [
    ...new Set(
      [t.branch, ...workspaces.filter((w) => w.ticketId === t.id).map((w) => w.branch)].filter(Boolean),
    ),
  ]
  const registered = (tree: Worktree) => workspaces.some((w) => w.path && samePath(w.path, tree.path))

  // A detached worktree has no branch to go by: it belongs to the tickets of its repo whose branch
  // commit it is checked out at. Repo rows sharing a path share its worktrees, so their claims add up.
  const claimed = new Map<Worktree, Claim[]>()
  await Promise.all(
    repos.map(async (r) => {
      const { refs, worktrees } = await git(r.repoPath)
      const detached = worktrees.slice(1).filter((tree) => !tree.branch && tree.head && !registered(tree))
      if (!detached.length) return
      const mine = all
        .filter((t) => repoOf(t)?.id === r.id)
        .map((t) => ({ id: t.id, names: namesOf(t), chain: baseChain(t, byId, r) }))
      await Promise.all(
        detached.map(async (tree) => {
          const found = await detachedClaims(r.repoPath, tree.head!, refs, mine)
          claimed.set(tree, [...(claimed.get(tree) ?? []), ...found])
        }),
      )
    }),
  )

  // An archived ticket is finished work too, whatever stage it was left in.
  const closed = all.filter((t) => t.archivedAt || isClosed(kindOf(stages, t.status)))
  const tickets = await Promise.all(
    closed.map(async (t): Promise<LeftoverTicket> => {
      const repo = repoOf(t)
      const own = workspaces.filter((w) => w.ticketId === t.id)
      const chain = baseChain(t, byId, repo)
      const names = namesOf(t)
      const state = repo ? await git(repo.repoPath) : null
      // A detached worktree several of the ticket's branches hold is one worktree: it goes with the
      // first of them, the ticket's own branch when that is one (claims follow `names`).
      const claimedBy = (tree: Worktree) => claimed.get(tree)?.find((c) => c.ticketId === t.id)?.branch
      const branches = await Promise.all(
        names.map(async (name): Promise<LeftoverBranch> => {
          const local = state?.refs.local.get(name) ?? null
          const remote = state?.refs.remote.get(name) ?? null
          const paths = own.filter((w) => w.branch === name && w.path).map((w) => w.path)
          const worktrees = (state?.worktrees ?? [])
            .map((tree, i) => ({ tree, main: i === 0 }))
            .filter(
              ({ tree }) =>
                tree.branch === name || paths.some((p) => samePath(p, tree.path)) || claimedBy(tree) === name,
            )
            .map(({ tree, main }) => ({ path: tree.path, main }))
          // A workspace on its own sub-branch should land in the ticket's branch first.
          const into = name === t.branch || !t.branch ? chain : [t.branch, ...chain]
          return {
            name,
            local,
            remote,
            worktrees,
            reach: reach && repo && state ? await reachOf(repo.repoPath, name, into, state.refs) : null,
            restore: local || remote ? `git branch ${name} ${local ?? remote}` : null,
          }
        }),
      )
      return {
        id: t.id,
        title: t.title,
        status: t.status,
        parentId: t.parentId,
        repo: repo ? { id: repo.id, name: repo.name, path: repo.repoPath } : null,
        chain,
        workspaces: own,
        previews: previews.filter((p) => p.ticketId === t.id),
        branches: branches.filter((b) => b.local || b.remote || b.worktrees.length),
        safe: branches.every((b) => !b.reach || b.reach.state !== 'unique'),
      }
    }),
  )
  const leftovers = tickets.filter((t) => t.workspaces.length || t.previews.length || t.branches.length)

  const known = new Set(
    all.flatMap((t) => [t.branch, ...workspaces.filter((w) => w.ticketId === t.id).map((w) => w.branch)]),
  )
  const untracked = (
    await Promise.all(
      repos.map(async (r) =>
        (await git(r.repoPath)).worktrees
          .slice(1)
          .filter(
            (tree) =>
              !(tree.branch && known.has(tree.branch)) && !registered(tree) && !claimed.get(tree)?.length,
          )
          .map((tree) => ({ repo: r.name, ...tree })),
      ),
    )
  ).flat()

  const branches = leftovers.flatMap((t) => t.branches)
  return {
    tickets: leftovers,
    untracked,
    counts: {
      tickets: leftovers.length,
      workspaces: leftovers.reduce((n, t) => n + t.workspaces.length, 0),
      previews: leftovers.reduce((n, t) => n + t.previews.length, 0),
      worktrees: branches.reduce((n, b) => n + b.worktrees.filter((w) => !w.main).length, 0),
      branches: branches.filter((b) => b.local).length,
      remote: branches.filter((b) => b.remote).length,
    },
    uploads: unattachedUploads(),
  }
}
