import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { promisify } from 'node:util'

import { HttpError } from './http'

/**
 * The board never writes to git or GitHub. Every command here is a read, but for `fetchOrigin`, which
 * only refreshes the checkout's copy of origin's branches: the allowlist below is the whole
 * vocabulary, and nothing else in the codebase spawns `git` or `gh`.
 */

const run = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
  return stdout.trim()
}

async function gh<T>(cwd: string, args: string[]): Promise<T> {
  const { stdout } = await run('gh', args, { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
  return JSON.parse(stdout) as T
}

export function assertRepo(repoPath: string) {
  if (!fs.existsSync(repoPath)) throw new HttpError(400, `${repoPath} does not exist`)
  if (!fs.existsSync(`${repoPath}/.git`)) throw new HttpError(400, `${repoPath} is not a git checkout`)
}

export async function repoNameWithOwner(repoPath: string): Promise<string | null> {
  try {
    const r = await gh<{ nameWithOwner: string }>(repoPath, ['repo', 'view', '--json', 'nameWithOwner'])
    return r.nameWithOwner
  } catch {
    return null
  }
}

export async function currentGithubLogin(repoPath: string): Promise<string | null> {
  try {
    const r = await gh<{ login: string }>(repoPath, ['api', 'user'])
    return r.login
  } catch {
    return null
  }
}

/** A check run (GitHub Actions and apps) or a commit status, as `statusCheckRollup` lists them. */
export type GhCheck =
  | {
      __typename: 'CheckRun'
      name: string
      workflowName?: string
      status: string
      conclusion: string
      detailsUrl: string
      startedAt: string
    }
  | { __typename: 'StatusContext'; context: string; state: string; targetUrl: string; startedAt: string }

export interface GhPr {
  number: number
  title: string
  url: string
  author: { login: string }
  headRefName: string
  baseRefName: string
  headRefOid: string
  isDraft: boolean
  reviewDecision: string
  mergeable: string
  mergeStateStatus: string
  statusCheckRollup: GhCheck[] | null
  updatedAt: string
  /** When it was merged; null while open (and for one closed without merging). */
  mergedAt: string | null
  reviews: { author: { login: string }; state: string; submittedAt: string; commit?: { oid: string } }[]
  /** Reviews asked for and not given yet: a user (`login`) or a team (`slug`). */
  reviewRequests: { __typename?: string; login?: string; slug?: string }[]
}

/** A PR of the queue, with the searches that found it. */
export interface MyGhPr extends GhPr {
  /** My review is requested (directly or through a team). */
  requested: boolean
  /** I am one of its assignees. */
  assigned: boolean
}

const PR_FIELDS =
  'number,title,url,author,headRefName,baseRefName,headRefOid,isDraft,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,updatedAt,mergedAt,reviews,reviewRequests'

/** How many PRs one search returns: open ones, and the recently merged ones. */
const OPEN_LIMIT = 100
const MERGED_LIMIT = 30

/**
 * The PRs I am in: the ones I authored (agents push with my account), the ones where my review was
 * requested, the ones I already reviewed, and the ones assigned to me. Open ones, and the ones of the
 * same searches merged on or after `mergedSince` (a date, YYYY-MM-DD), at most `MERGED_LIMIT` per
 * search: the queue keeps them a while after they land, never the repo's whole history.
 */
export async function listMyPrs(repoPath: string, opts: { mergedSince: string }): Promise<MyGhPr[]> {
  const searches = ['author:@me', 'review-requested:@me', 'reviewed-by:@me', 'assignee:@me'] as const
  const queries = [
    ...searches.map((search) => ({ search, state: 'open', limit: OPEN_LIMIT, query: search })),
    ...searches.map((search) => ({
      search,
      state: 'merged',
      limit: MERGED_LIMIT,
      query: `${search} merged:>=${opts.mergedSince}`,
    })),
  ]
  const found = await Promise.all(
    queries.map((q) =>
      gh<GhPr[]>(repoPath, [
        'pr',
        'list',
        '--state',
        q.state,
        '--limit',
        String(q.limit),
        '--search',
        q.query,
        '--json',
        PR_FIELDS,
      ]),
    ),
  )
  const byNumber = new Map<number, MyGhPr>()
  found.forEach((prs, i) => {
    for (const pr of prs) {
      const seen = byNumber.get(pr.number) ?? { ...pr, requested: false, assigned: false }
      if (queries[i]!.search === 'review-requested:@me') seen.requested = true
      if (queries[i]!.search === 'assignee:@me') seen.assigned = true
      byNumber.set(pr.number, seen)
    }
  })
  return [...byNumber.values()]
}

/** Whether a PR was merged: one that left the queue may also have been closed or unassigned. */
export async function prMerged(repoPath: string, number: number): Promise<boolean> {
  try {
    const r = await gh<{ state: string }>(repoPath, ['pr', 'view', String(number), '--json', 'state'])
    return r.state === 'MERGED'
  } catch {
    return false
  }
}

export interface BranchInfo {
  exists: boolean
  sha: string | null
  subject: string | null
  authoredAt: string | null
  ahead: number | null
  behind: number | null
}

/** A branch that is neither here nor on origin (or no branch at all). */
export const NO_BRANCH: BranchInfo = {
  exists: false,
  sha: null,
  subject: null,
  authoredAt: null,
  ahead: null,
  behind: null,
}

/** A commit's subject and when it was authored. */
export async function commitSummary(repoPath: string, sha: string) {
  const line = await git(repoPath, ['log', '-1', '--format=%s%x1f%aI', sha, '--'])
  const [subject = '', authoredAt = ''] = line.split('\x1f')
  return { subject, authoredAt }
}

/** The local branch's head commit, or null when there is no such branch here. */
export async function branchHead(repoPath: string, branch: string): Promise<string | null> {
  if (!branch) return null
  return git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]).catch(
    () => null,
  )
}

/** How many commits the local branch has that `sha` does not; null when either is unknown here. */
export async function commitsSince(repoPath: string, branch: string, sha: string): Promise<number | null> {
  if (!branch || !sha) return null
  const out = await git(repoPath, ['rev-list', '--count', `${sha}..refs/heads/${branch}`]).catch(() => null)
  return out === null ? null : Number(out)
}

export interface Worktree {
  path: string
  branch: string | null
  head: string | null
}

export async function listWorktrees(repoPath: string): Promise<Worktree[]> {
  const out = await git(repoPath, ['worktree', 'list', '--porcelain'])
  const trees: Worktree[] = []
  let current: Worktree | null = null
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice(9), branch: null, head: null }
      trees.push(current)
    } else if (current && line.startsWith('HEAD ')) current.head = line.slice(5)
    else if (current && line.startsWith('branch ')) current.branch = line.slice(7).replace('refs/heads/', '')
  }
  return trees
}

export async function listBranches(repoPath: string): Promise<string[]> {
  const out = await git(repoPath, ['branch', '--list', '--format=%(refname:short)'])
  return out ? out.split('\n') : []
}

export interface Refs {
  /** Local branch → sha. */
  local: Map<string, string>
  /** Branch on origin → sha, as of the last fetch. */
  remote: Map<string, string>
}

export async function listRefs(repoPath: string): Promise<Refs> {
  const out = await git(repoPath, [
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    'refs/heads',
    'refs/remotes/origin',
  ])
  const refs: Refs = { local: new Map(), remote: new Map() }
  for (const line of out ? out.split('\n') : []) {
    const [name, sha] = line.split(' ')
    if (name!.startsWith('refs/heads/')) refs.local.set(name!.slice(11), sha!)
    else if (name !== 'refs/remotes/origin/HEAD') refs.remote.set(name!.slice(20), sha!)
  }
  return refs
}

/**
 * The branches whose history holds commit `sha`, named as `baseRefs` names them: a local branch by its
 * name, origin's as `origin/<name>`. Throws when `sha` is no commit here.
 */
export async function refsContaining(repoPath: string, sha: string): Promise<Set<string>> {
  const out = await git(repoPath, [
    'for-each-ref',
    '--contains',
    sha,
    '--format=%(refname)',
    'refs/heads',
    'refs/remotes/origin',
  ])
  const names = new Set<string>()
  for (const name of out ? out.split('\n') : []) {
    if (name.startsWith('refs/heads/')) names.add(name.slice(11))
    else if (name !== 'refs/remotes/origin/HEAD') names.add(`origin/${name.slice(20)}`)
  }
  return names
}

/**
 * Brings the remote-tracking refs (`origin/*`) up to date, dropping the ones gone from origin. It
 * never touches a local branch, a worktree or origin itself, never prompts for credentials, and gives
 * up after `timeoutMs`.
 */
export async function fetchOrigin(repoPath: string, timeoutMs: number): Promise<void> {
  await run('git', ['fetch', '--prune', '--quiet', 'origin'], {
    cwd: repoPath,
    windowsHide: true,
    timeout: timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  })
}

export interface CommitLines {
  sha: string
  added: number
  removed: number
}

/**
 * The commits reachable from `tip` that none of `before` reaches, merge commits left out, each with
 * the lines it adds and removes against its parent, in one git process. The lines are its `--numstat`
 * summed, which is what `git diff --shortstat` says (a binary file adds none) without its wording,
 * which git translates. The revisions go through stdin, so any number of `before` fits; one this
 * checkout lacks is skipped.
 */
export async function commitsBrought(
  repoPath: string,
  tip: string,
  before: string[],
): Promise<CommitLines[]> {
  const out = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      'git',
      [
        'log',
        '--no-merges',
        '--no-show-signature',
        '--format=%x1e%H',
        '--numstat',
        '--ignore-missing',
        '--stdin',
      ],
      { cwd: repoPath, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
    )
    child.stdin?.end([tip, ...before.map((sha) => `^${sha}`)].join('\n') + '\n')
  })
  return out
    .split('\x1e')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [sha = '', ...files] = chunk.split('\n')
      const lines = { sha: sha.trim(), added: 0, removed: 0 }
      for (const file of files) {
        // `<added>\t<removed>\t<path>`; a binary file is `-\t-`: no lines.
        const [added = '', removed = ''] = file.split('\t')
        lines.added += Number(added) || 0
        lines.removed += Number(removed) || 0
      }
      return lines
    })
}

/** How many commits `a` has that `b` lacks, and the other way round. */
export async function aheadBehind(repoPath: string, a: string, b: string): Promise<[number, number]> {
  const out = await git(repoPath, ['rev-list', '--left-right', '--count', `${a}...${b}`])
  const [ahead = 0, behind = 0] = out.split(/\s+/).map(Number)
  return [ahead, behind]
}

/** How many commits reachable from `ref` are on no branch of origin. */
export async function notOnOrigin(repoPath: string, ref: string): Promise<number> {
  return Number(await git(repoPath, ['rev-list', '--count', ref, '--not', '--remotes=origin']))
}

/**
 * Whether commit `sha` was merged into `base`: it is in the base's history but not on its
 * first-parent line. A branch cut from the base and never committed to sits on that line: it is in
 * the base without having been merged into it.
 */
export async function mergedInto(repoPath: string, sha: string, base: string): Promise<boolean> {
  const inBase = await git(repoPath, ['merge-base', '--is-ancestor', sha, base]).then(
    () => true,
    () => false,
  )
  if (!inBase) return false
  // The base's first parents down to the first commit `sha` holds: its first parent is `sha` itself
  // when `sha` is on that line.
  const walk = await git(repoPath, ['rev-list', '--first-parent', '--parents', base, '--not', sha])
  if (!walk) return false
  const [, firstParent] = walk.split('\n').at(-1)!.split(' ')
  return firstParent !== sha
}

/** When the branch's last commit was made (committer date): the local branch, else origin's. */
export async function lastCommitAt(repoPath: string, branch: string): Promise<string | null> {
  if (!branch) return null
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    const at = await git(repoPath, ['log', '-1', '--format=%cI', ref, '--']).catch(() => '')
    if (at) return new Date(at).toISOString()
  }
  return null
}

/**
 * How far a branch's work got into a base, best first:
 * - `merged`: every commit is in the base as is;
 * - `rebased`: the commits differ but each one's patch is in the base (rebased, cherry-picked);
 * - `edited`: some patches differ, yet merging the branch would change nothing (squashed, reworded,
 *   edited on the way in);
 * - `unique`: the branch still holds work the base does not have.
 */
export type ReachState = 'merged' | 'rebased' | 'edited' | 'unique'

export interface Reach {
  state: ReachState
  /** The base ref the verdict is against: the first that holds the work, else the nearest. */
  into: string
  /** The branch's commits whose patch is not in `into` (only for `edited` and `unique`). */
  unique: { sha: string; subject: string }[]
}

const REACH_ORDER: ReachState[] = ['merged', 'rebased', 'edited', 'unique']

/**
 * Checks `ref` against each of `bases` (refs or shas, nearest first) and keeps the best verdict. `merge-tree`
 * writes no ref and touches no checkout: it only leaves loose objects that `git gc` reaps.
 */
export async function branchReach(repoPath: string, ref: string, bases: string[]): Promise<Reach | null> {
  let best: Reach | null = null
  for (const base of bases) {
    const reach = await reachInto(repoPath, ref, base).catch(() => null)
    if (!reach) continue
    if (!best || REACH_ORDER.indexOf(reach.state) < REACH_ORDER.indexOf(best.state)) best = reach
    if (best.state === 'merged') break
  }
  return best
}

async function reachInto(repoPath: string, ref: string, base: string): Promise<Reach> {
  const ancestor = await git(repoPath, ['merge-base', '--is-ancestor', ref, base]).then(
    () => true,
    () => false,
  )
  if (ancestor) return { state: 'merged', into: base, unique: [] }
  const cherry = await git(repoPath, ['cherry', '-v', base, ref])
  const unique = (cherry ? cherry.split('\n') : [])
    .filter((l) => l.startsWith('+ '))
    .map((l) => {
      const [sha, ...subject] = l.slice(2).split(' ')
      return { sha: sha!, subject: subject.join(' ') }
    })
  if (!unique.length) return { state: 'rebased', into: base, unique }
  // A conflicting merge exits non-zero: that branch surely still has something of its own.
  const [merged, baseTree] = await Promise.all([
    git(repoPath, ['merge-tree', '--write-tree', base, ref]).catch(() => ''),
    git(repoPath, ['rev-parse', `${base}^{tree}`]),
  ])
  const tree = merged.split('\n')[0]
  return { state: tree === baseTree ? 'edited' : 'unique', into: base, unique }
}

/**
 * Whether `ref` holds work of `other` that none of `bases` has: a commit of `other`'s own (not in a
 * base, nor in one of `others`, the other branches, those of them `other` itself is built on) that is
 * in `ref`. A branch built on `ref` does not count, and without a base nothing can be told. Each is a
 * commit's full sha, so the answer is about those commits whatever the branches did since.
 */
export async function holdsWorkOf(
  repoPath: string,
  ref: string,
  other: string,
  bases: string[],
  others: string[],
) {
  if (!bases.length) return false
  const isAncestor = (a: string, b: string) =>
    git(repoPath, ['merge-base', '--is-ancestor', a, b]).then(
      () => true,
      () => false,
    )
  if (await isAncestor(ref, other)) return false
  // Quick way out: nothing the two share lies outside the bases.
  const shared = await git(repoPath, ['merge-base', '--all', ref, other]).catch(() => '')
  let outside = false
  for (const sha of shared ? shared.split('\n') : []) {
    const landed = await Promise.all(bases.map((b) => isAncestor(sha, b)))
    if (!landed.some(Boolean)) outside = true
  }
  if (!outside) return false
  // What `other` stands on is not its own work: the shared commits may be a third branch's. rev-list
  // prints each of `others` that is not in `other`; one in a base is left out too, which changes
  // nothing: what a base holds is not counted anyway.
  const tips = [...new Set(others)]
  const over = tips.length ? await git(repoPath, ['rev-list', ...tips, '--not', other, ...bases]) : ''
  const notBelow = new Set(over ? over.split('\n') : [])
  const stands = tips.filter((x) => !notBelow.has(x))
  const own = ['rev-list', '--count', other, ...[...bases, ...stands].map((b) => `^${b}`)]
  const mine = Number(await git(repoPath, own))
  return mine > 0 && Number(await git(repoPath, [...own, `^${ref}`])) < mine
}
