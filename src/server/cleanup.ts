import crypto from 'node:crypto'
import fs from 'node:fs'

import { and, eq, inArray, isNotNull } from 'drizzle-orm'

import { db, schema } from '#/db'
import { isClosed } from '#/lib/stages'
import { type AuthMode, authMode } from './config'
import {
  aheadBehind,
  type BranchInfo,
  branchReach,
  commitSummary,
  gitSaid,
  isAncestor,
  listRefs,
  listWorktrees,
  NO_BRANCH,
  originHead,
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
 * a done or cancelled stage or archived, whether each branch's work reached where it was meant to
 * land, and whether the human may delete it from the Cleanup page (`cleanupActions.ts` does, after
 * checking it all again). Agents delete local branches and worktrees themselves, with the human's
 * go-ahead, and never origin's.
 */

type Chainable = Pick<schema.Ticket, 'id' | 'parentId' | 'repoId' | 'baseBranch'>
type RepoRow = schema.Repo

/** A checkout's branches and worktrees, as one listing. */
export interface RepoGit {
  refs: Refs
  worktrees: Worktree[]
  /** Why git could not list the checkout: the empty listings then say nothing about it. */
  error: string | null
}

/**
 * One `for-each-ref` and one `worktree list` per repo, however many tickets ask. `recent` takes them
 * from the listings every read shares for a few seconds (`readRefs`), instead of listing afresh.
 */
export function gitCache(opts: { recent?: boolean } = {}) {
  const cache = new Map<string, Promise<RepoGit>>()
  return (repoPath: string) => {
    if (!cache.has(repoPath)) cache.set(repoPath, listing(repoPath, opts.recent ?? false))
    return cache.get(repoPath)!
  }
}

export type GitCache = ReturnType<typeof gitCache>

async function listing(repoPath: string, recent: boolean): Promise<RepoGit> {
  const none = { refs: { local: new Map(), remote: new Map() }, worktrees: [] }
  if (!fs.existsSync(repoPath)) return { ...none, error: `${repoPath} does not exist` }
  // The shared listings keep no error: a failure there reads as null.
  const or = <T>(p: Promise<T | null>) => p.then((v) => v ?? Promise.reject(new Error('git failed')))
  const [refs, worktrees] = await Promise.allSettled([
    recent ? or(readRefs(repoPath)) : listRefs(repoPath),
    recent ? or(readWorktrees(repoPath)) : listWorktrees(repoPath),
  ])
  if (refs.status === 'fulfilled' && worktrees.status === 'fulfilled')
    return { refs: refs.value, worktrees: worktrees.value, error: null }
  const failed = [refs, worktrees].find((r) => r.status === 'rejected') as PromiseRejectedResult
  return { ...none, error: `git cannot read ${repoPath}: ${gitSaid(failed.reason)}` }
}

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
  return reachAt(repoPath, refSha(ref, refs)!, bases, refs)
}

/** How far commit `sha` (one copy of a branch) got into `bases`, refs as `baseRefs` names them. */
export function reachAt(repoPath: string, sha: string, bases: string[], refs: Refs) {
  const shas = bases.map((b) => refSha(b, refs)!)
  const key = [repoPath, sha, ...bases.map((b, i) => `${b}@${shas[i]}`)]
  // Worked out on the listed commits, not on the names: git reads a name as it is now, and the answer
  // would be kept for commits it is not about.
  return memo(reachMemo, REACH_MEMO_MAX, key.join('\0'), async () => {
    const reach = await branchReach(repoPath, sha, shas)
    // Bases at the same commit answer alike and the first of them is kept: so is its name.
    return reach && { ...reach, into: bases[shas.indexOf(reach.into)]! }
  })
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
 * branch at that commit, else those whose branch holds it; never one whose bases hold it too (a commit
 * the bases have, such as dev's tip, is no ticket's own work, even where a branch merged as is still
 * points at it). Empty when git cannot tell, so the worktree stays untracked.
 */
async function detachedClaims(
  repoPath: string,
  head: string,
  refs: Refs,
  tickets: { id: number; names: string[]; chain: string[] }[],
): Promise<Claim[]> {
  const claims = (t: (typeof tickets)[number], holds: (name: string) => boolean) =>
    t.names.filter(holds).map((branch) => ({ ticketId: t.id, branch }))
  // Only tickets with a branch here are asked about, and only then is git asked.
  const present = tickets.filter((t) => t.names.some((n) => refs.local.has(n) || refs.remote.has(n)))
  if (!present.length) return []
  const key = [repoPath, head, refsKey(refs)].join('\0')
  const holding = await memo(containsMemo, CONTAINS_MEMO_MAX, key, () =>
    refsContaining(repoPath, head),
  ).catch(() => null)
  if (!holding) return []
  // The ticket's own branches are not its bases (a workspace on the ticket's own branch).
  const own = present.filter(
    (t) =>
      !baseRefs(
        t.chain.filter((b) => !t.names.includes(b)),
        refs,
      ).some((b) => holding.has(b)),
  )
  const tips = own.flatMap((t) => claims(t, (n) => refs.local.get(n) === head || refs.remote.get(n) === head))
  if (tips.length) return tips
  return own.flatMap((t) => claims(t, (n) => holding.has(n) || holding.has(`origin/${n}`)))
}

/**
 * A folder's path as a key: slashes either way and a trailing one aside, and the case only where the
 * file system ignores it (Windows).
 */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform) {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return platform === 'win32' ? s.toLowerCase() : s
}

/** Whether two paths name the same folder (`pathKey`). */
export const samePath = (a: string, b: string, platform: NodeJS.Platform = process.platform) =>
  pathKey(a, platform) === pathKey(b, platform)

/** Whether the human may delete it from the Cleanup page; `reason` says why not. */
export interface Verdict {
  ok: boolean
  reason: string | null
}

export interface LeftoverWorktree {
  path: string
  /** The repo's own checkout, not a worktree: never removed. */
  main: boolean
  /** The branch it has checked out; null when it is detached at `head`. */
  branch: string | null
  head: string | null
  /** Previews the board builds or runs from it: removing it stops them first. */
  previews: ManagedPreview[]
  /** Why it may not be removed with its branch; null when it may. */
  protected: string | null
}

export interface LeftoverBranch {
  name: string
  /** Sha of the local branch; null when it is gone locally. */
  local: string | null
  /** Sha of origin's branch as of the last fetch; null when origin has none. */
  remote: string | null
  /** Worktrees with this branch checked out, or checked out detached at one of its commits. */
  worktrees: LeftoverWorktree[]
  /** How far its work got: the local branch's, else origin's when only origin has it. */
  reach: Reach | null
  /** How far origin's copy got, judged by its own commits; null when origin has none. */
  remoteReach: Reach | null
  /** A merged PR whose head is origin's very commit: that copy landed through it, whatever its reach. */
  mergedPr: { number: number; url: string } | null
  /** Recreates the branch here after it was deleted. */
  restore: string | null
  /** Puts origin's copy back after it was deleted there. */
  restoreRemote: string | null
  /** Why it may never be deleted, here or on origin; null when it is not protected. */
  protected: string | null
  /**
   * What the Cleanup page may do with it: delete the local branch, delete origin's, or remove its
   * worktrees and then the local branch.
   */
  can: { local: Verdict; remote: Verdict; worktrees: Verdict }
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
  /**
   * True when every branch's work landed (merged, rebased or edited in), here and on origin, and none
   * of it is protected or in use elsewhere. False when any is unique, unknown or kept.
   */
  safe: boolean
}

export interface CleanupReport {
  tickets: LeftoverTicket[]
  /**
   * Worktrees no ticket or workspace accounts for (by branch, registered path, or the ticket's branch
   * commit a detached one is at): register them or remove them.
   */
  untracked: { repo: string; path: string; branch: string | null; head: string | null }[]
  /** The project's repos, each with why git could not read it (its leftovers are then unknown). */
  repos: { id: number; name: string; path: string; error: string | null }[]
  /** Why this board deletes nothing; null when the human may delete from the Cleanup page. */
  deleteOff: string | null
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
 * Why a board deletes nothing: a preview runs on a copy of the live data, whose repos are the real
 * ones, so a delete there would land on them all the same.
 */
export function deleteOff(auth: AuthMode = authMode()): string | null {
  return auth.boardEnv === 'development'
    ? 'this board is a preview on a copy of the live data: delete from the live board'
    : null
}

/**
 * What may never be deleted in one checkout, whichever project points at it: the repo's base branch,
 * the main checkout's branch, origin's default branch, the branches, workspace branches and bases of
 * every ticket still in work, and the head and base of every open PR. Also the worktree paths
 * registered on tickets in work, and the branches those tickets use (for a worktree at their tip).
 */
interface Guard {
  branches: Map<string, string>
  inUse: Map<string, number>
  paths: { path: string; ticketId: number }[]
}

async function guardOf(repoPath: string, git: RepoGit): Promise<Guard> {
  const branches = new Map<string, string>()
  const inUse = new Map<string, number>()
  const paths: Guard['paths'] = []
  const keep = (name: string, why: string) => {
    if (name && !branches.has(name)) branches.set(name, why)
  }
  const rows = listRepos().filter((r) => samePath(r.repoPath, repoPath))
  for (const r of rows) keep(r.baseBranch, "the repo's base branch")
  const mainBranch = git.worktrees[0]?.branch
  if (mainBranch) keep(mainBranch, 'checked out in the main checkout')
  const head = await originHead(repoPath)
  if (head) keep(head, "origin's default branch")

  const rowIds = new Set(rows.map((r) => r.id))
  for (const projectId of new Set(rows.map((r) => r.projectId))) {
    const stages = listStages(projectId)
    const projectRepos = listRepos(projectId)
    const all = db.select().from(schema.tickets).where(eq(schema.tickets.projectId, projectId)).all()
    const byId = new Map(all.map((t) => [t.id, t]))
    const repoOf = (t: schema.Ticket) =>
      (t.repoId ? projectRepos.find((r) => r.id === t.repoId) : projectRepos[0]) ?? null
    const working = all.filter(
      (t) => rowIds.has(repoOf(t)?.id ?? -1) && !t.archivedAt && !isClosed(kindOf(stages, t.status)),
    )
    const spaces = working.length
      ? db
          .select()
          .from(schema.workspaces)
          .where(
            inArray(
              schema.workspaces.ticketId,
              working.map((t) => t.id),
            ),
          )
          .all()
      : []
    for (const t of working) {
      const own = spaces.filter((w) => w.ticketId === t.id)
      for (const name of [t.branch, ...own.map((w) => w.branch)].filter(Boolean)) {
        keep(name, `in use by #${t.id}`)
        if (!inUse.has(name)) inUse.set(name, t.id)
      }
      for (const name of baseChain(t, byId, repoOf(t))) keep(name, `the base of #${t.id}`)
      for (const w of own) if (w.path) paths.push({ path: w.path, ticketId: t.id })
    }
    const open = db
      .select()
      .from(schema.prs)
      .where(and(eq(schema.prs.projectId, projectId), eq(schema.prs.open, true)))
      .all()
      .filter((pr) => (pr.repoId ? rowIds.has(pr.repoId) : true))
    for (const pr of open) {
      keep(pr.headRef, `the head of open PR #${pr.number}`)
      keep(pr.baseRef, `the base of open PR #${pr.number}`)
    }
  }
  return { branches, inUse, paths }
}

const landed = (r: Reach | null) => !!r && r.state !== 'unique'

/** Why a copy whose work did not land may not go: its own commits, or nothing to tell by. */
function unlanded(reach: Reach | null, chain: string[]): string | null {
  if (!reach) return `nothing to compare it against (${chain.join(', ') || 'no base'})`
  if (reach.state !== 'unique') return null
  const n = reach.unique.length
  return `${n} commit${n === 1 ? '' : 's'} of its own not in ${reach.into}`
}

const verdict = (reason: string | null): Verdict => ({ ok: !reason, reason })

/**
 * The project's closed tickets that still have a registered workspace, a local or origin branch, or a
 * worktree, each branch checked against the ticket's base chain (skip that with `reach: false` for a
 * quick count). `only` looks at those tickets alone, every branch of theirs kept, even one gone
 * everywhere: what a delete checks again before it acts.
 */
export async function cleanupReport(
  projectId: number,
  opts: { reach?: boolean; only?: number[] } = {},
): Promise<CleanupReport> {
  getProject(projectId)
  const reach = opts.reach ?? true
  const off = deleteOff()
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
  const guards = new Map<string, Promise<Guard>>()
  const guard = (repoPath: string) => {
    if (!guards.has(repoPath))
      guards.set(
        repoPath,
        git(repoPath).then((g) => guardOf(repoPath, g)),
      )
    return guards.get(repoPath)!
  }
  const previews = activePreviews()
  const isOpen = (t: schema.Ticket) => !t.archivedAt && !isClosed(kindOf(stages, t.status))
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
  const closed = all.filter(
    (t) => (!opts.only || opts.only.includes(t.id)) && (t.archivedAt || isClosed(kindOf(stages, t.status))),
  )
  const tickets = await Promise.all(
    closed.map(async (t): Promise<LeftoverTicket> => {
      const repo = repoOf(t)
      const own = workspaces.filter((w) => w.ticketId === t.id)
      const chain = baseChain(t, byId, repo)
      const names = namesOf(t)
      const state = repo ? await git(repo.repoPath) : null
      const kept = repo ? await guard(repo.repoPath) : null
      // A ticket that names no repo goes by the project's first: with several, that is a guess.
      const unsure =
        !t.repoId && repos.length > 1 ? 'the ticket names no repo and the project has several' : null
      const common = off ?? state?.error ?? unsure
      // A detached worktree several of the ticket's branches hold is one worktree: it goes with the
      // first of them, the ticket's own branch when that is one (claims follow `names`).
      const claimedBy = (tree: Worktree) => claimed.get(tree)?.find((c) => c.ticketId === t.id)?.branch
      const branches = await Promise.all(
        names.map(async (name): Promise<LeftoverBranch> => {
          const local = state?.refs.local.get(name) ?? null
          const remote = state?.refs.remote.get(name) ?? null
          // A workspace on its own sub-branch should land in the ticket's branch first.
          const into = name === t.branch || !t.branch ? chain : [t.branch, ...chain]
          const guarded =
            kept?.branches.get(name) ?? (into.includes(name) ? 'a base of this ticket’s own work' : null)
          // Its own copy on origin is no destination of the branch: each copy is judged on its own.
          const bases = state
            ? baseRefs(into, state.refs).filter((b) => b !== name && b !== `origin/${name}`)
            : []
          // A branch that is its own destination has nothing to be judged against.
          const judge = (sha: string | null) =>
            reach && repo && state && sha && !into.includes(name)
              ? reachAt(repo.repoPath, sha, bases, state.refs)
              : Promise.resolve(null)
          const [localReach, remoteReach] = await Promise.all([
            judge(local),
            remote === local ? null : judge(remote),
          ])
          const originReach = remote ? (remote === local ? localReach : remoteReach) : null
          const pr =
            repo && remote
              ? db
                  .select()
                  .from(schema.prs)
                  .where(
                    and(
                      eq(schema.prs.projectId, projectId),
                      eq(schema.prs.headRef, name),
                      eq(schema.prs.headSha, remote),
                      isNotNull(schema.prs.mergedAt),
                    ),
                  )
                  .all()
                  .find((p) => !p.repoId || p.repoId === repo.id)
              : undefined
          const paths = own.filter((w) => w.branch === name && w.path).map((w) => w.path)
          const tip = local ?? remote
          const worktrees = await Promise.all(
            (state?.worktrees ?? [])
              .map((tree, i) => ({ tree, main: i === 0 }))
              .filter(
                ({ tree }) =>
                  tree.branch === name ||
                  paths.some((p) => samePath(p, tree.path)) ||
                  claimedBy(tree) === name,
              )
              .map(
                async ({ tree, main }): Promise<LeftoverWorktree> => ({
                  path: tree.path,
                  main,
                  branch: tree.branch,
                  head: tree.head,
                  previews: previews.filter((p) => samePath(p.path, tree.path)),
                  protected: await treeGuard(tree, main),
                }),
              ),
          )
          const checkedOut = worktrees.find((w) => w.branch === name)
          const removable = worktrees.filter((w) => !w.main)
          const blocked = removable.find((w) => w.protected)
          const reachOfBranch = local ? localReach : originReach
          const shared = common ?? guarded
          return {
            name,
            local,
            remote,
            worktrees,
            reach: reachOfBranch,
            remoteReach: originReach,
            mergedPr: pr ? { number: pr.number, url: pr.url } : null,
            restore: tip ? `git branch ${name} ${tip}` : null,
            restoreRemote: remote ? `git push origin ${remote}:refs/heads/${name}` : null,
            protected: guarded ?? unsure,
            can: {
              local: verdict(
                shared ??
                  (!local
                    ? 'no local branch'
                    : checkedOut
                      ? `checked out in ${checkedOut.main ? 'the main checkout' : checkedOut.path}`
                      : unlanded(localReach, into)),
              ),
              remote: verdict(
                shared ?? (!remote ? 'not on origin' : pr ? null : unlanded(originReach, into)),
              ),
              worktrees: verdict(
                shared ??
                  (!removable.length
                    ? 'no worktree to remove'
                    : blocked
                      ? `${blocked.path}: ${blocked.protected}`
                      : unlanded(reachOfBranch, into)),
              ),
            },
          }

          /** Why a worktree listed under this branch may not be removed with it; null when it may. */
          async function treeGuard(tree: Worktree, main: boolean): Promise<string | null> {
            if (main) return "the repo's main checkout"
            if (samePath(tree.path, process.cwd())) return 'the board runs from it'
            if (tree.locked) return 'locked'
            if (tree.branch && tree.branch !== name) return `has ${tree.branch} checked out`
            const registeredOn = kept?.paths.find((p) => samePath(p.path, tree.path))
            if (registeredOn) return `registered on #${registeredOn.ticketId}`
            if (tree.branch || !tree.head) return tree.branch ? null : 'its commit is unknown'
            const head = tree.head
            const openClaim = (claimed.get(tree) ?? []).find(
              (c) => c.ticketId !== t.id && isOpen(byId.get(c.ticketId)!),
            )
            if (openClaim) return `also at the work of #${openClaim.ticketId}`
            const at = (n: string) => state?.refs.local.get(n) === head || state?.refs.remote.get(n) === head
            const tipOf = [...(kept?.inUse ?? [])].find(([n]) => at(n))
            if (tipOf) return `at the tip of ${tipOf[0]}, in use by #${tipOf[1]}`
            // Deleting the branch with it loses nothing only when the branch holds its commit.
            if (claimedBy(tree) === name || head === tip) return null
            const held = repo && tip ? await isAncestor(repo.repoPath, head, tip) : false
            return held ? null : `detached at ${head.slice(0, 7)}, which ${name} does not hold`
          }
        }),
      )
      const listed = opts.only ? branches : branches.filter((b) => b.local || b.remote || b.worktrees.length)
      return {
        id: t.id,
        title: t.title,
        status: t.status,
        parentId: t.parentId,
        repo: repo ? { id: repo.id, name: repo.name, path: repo.repoPath } : null,
        chain,
        workspaces: own,
        previews: previews.filter((p) => p.ticketId === t.id),
        branches: listed,
        safe:
          !state?.error &&
          (!!repo || !names.length) &&
          !unsure &&
          branches.every(
            (b) =>
              !b.protected &&
              (!b.local || landed(b.reach)) &&
              (!b.remote || landed(b.remoteReach) || !!b.mergedPr) &&
              b.worktrees.every((w) => w.main || !w.protected),
          ),
      }
    }),
  )
  const leftovers = opts.only
    ? tickets
    : tickets.filter((t) => t.workspaces.length || t.previews.length || t.branches.length)

  const known = new Set(
    all.flatMap((t) => [t.branch, ...workspaces.filter((w) => w.ticketId === t.id).map((w) => w.branch)]),
  )
  const listings = await Promise.all(repos.map(async (r) => ({ r, ...(await git(r.repoPath)) })))
  const untracked = listings.flatMap(({ r, worktrees }) =>
    worktrees
      .slice(1)
      .filter(
        (tree) => !(tree.branch && known.has(tree.branch)) && !registered(tree) && !claimed.get(tree)?.length,
      )
      .map((tree) => ({ repo: r.name, path: tree.path, branch: tree.branch, head: tree.head })),
  )

  const branches = leftovers.flatMap((t) => t.branches)
  return {
    tickets: leftovers,
    untracked,
    repos: listings.map(({ r, error }) => ({ id: r.id, name: r.name, path: r.repoPath, error })),
    deleteOff: off,
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
