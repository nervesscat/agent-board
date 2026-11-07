import { type ExecFileOptions, execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import { HttpError } from './http'

/**
 * The board never writes to GitHub, and writes to git only for the human's Cleanup actions:
 * `removeWorktree`, `deleteLocalBranch` and `deleteOriginBranch`, each run once the human confirmed it
 * on the Cleanup page and the server checked again that the work landed (`cleanupActions.ts`), and for a
 * branch preview (`branchPreview.ts`): `fetchOriginBranch`, `addDetachedWorktree` and `checkoutDetached`,
 * which only ever make or move a detached worktree of the board's own and never a branch. Every
 * other command here is a read, but for `fetchOrigin`, which only refreshes the checkout's copy of
 * origin's branches: the allowlist below is the whole vocabulary, and nothing else in the codebase
 * spawns `git` or `gh` but the check of the host's tools (`hostTools.ts`: `--version` and
 * `gh auth status`, both reads).
 */

const execFileAsync = promisify(execFile)

/** The longest folder Windows starts a program in: `cwd`, its closing `\` and the NUL fit MAX_PATH (260). */
const WIN_MAX_CWD = 258

/**
 * The folder a command here starts in: `cwd` resolved, so a trailing separator or a `.` or `..` in a
 * repo's path as it was typed never reaches Windows, which measures the folder as it is given. The
 * length check measures this same path.
 */
export const startDir = (cwd: string, platform: NodeJS.Platform = process.platform): string =>
  platform === 'win32' ? path.win32.resolve(cwd) : path.resolve(cwd)

/**
 * A folder too long for Windows to start a program in. Node does not refuse one: the spawn fails as
 * `spawn git ENOENT`, which would read as git (or gh) not being installed, and its pipes then throw
 * ENOTCONN where nothing can catch it, which takes the server down. So no command here starts in one;
 * each starts in `startDir(cwd)`, the path measured here.
 */
export function cwdTooLong(cwd: string, platform: NodeJS.Platform = process.platform): HttpError | null {
  if (platform !== 'win32' || startDir(cwd, platform).length <= WIN_MAX_CWD) return null
  return new HttpError(
    409,
    `${cwd} is too long a path for Windows to run git or gh in (over ${WIN_MAX_CWD} characters): ` +
      'move the checkout to a shorter path',
  )
}

/** The folder to start a command in (`startDir`), once it fits. */
function assertCwdFits(cwd: string): string {
  const tooLong = cwdTooLong(cwd)
  if (tooLong) throw tooLong
  return startDir(cwd)
}

/**
 * A command run in `cwd` failed to start because of that folder: Node reports a `cwd` it cannot start
 * the binary in (gone, or a file in its place) as the binary's own `spawn git ENOENT` (ENOTDIR for a
 * file on POSIX), which would read as git (or gh) not being installed (`toolProblem`). This says what
 * is really wrong with the folder instead; null for any other failure, or when the folder is fine.
 */
export function folderGone(err: unknown, cwd: string): HttpError | null {
  const e = err as { code?: unknown; syscall?: unknown } | null
  // POSIX names a file in the folder's place ENOTDIR; Windows says ENOENT of every folder it cannot use.
  if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) return null
  if (typeof e.syscall !== 'string' || !e.syscall.startsWith('spawn')) return null
  const cannotOpen = (code: unknown) =>
    new HttpError(409, `${cwd} cannot be opened (${String(code)}): check the repo's folder`)
  let stat: fs.Stats
  try {
    stat = fs.statSync(cwd)
  } catch (statErr) {
    const code = (statErr as { code?: unknown }).code
    if (code === 'ENOENT' || code === 'ENOTDIR')
      return new HttpError(409, `${cwd} does not exist: the repo's folder was moved or deleted`)
    return cannotOpen(code)
  }
  if (!stat.isDirectory())
    return new HttpError(409, `${cwd} is not a folder: the repo's path names a file, not its checkout`)
  try {
    fs.opendirSync(cwd).closeSync()
  } catch (openErr) {
    return cannotOpen((openErr as { code?: unknown }).code)
  }
  return null
}

async function run(file: string, args: string[], opts: ExecFileOptions & { cwd: string }) {
  const cwd = assertCwdFits(opts.cwd)
  try {
    return await execFileAsync(file, args, { ...opts, cwd, encoding: 'utf8' })
  } catch (err) {
    throw folderGone(err, opts.cwd) ?? err
  }
}

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
  /** Its conversation's comments (not review comments): where "CI run locally: green on <sha>" is said. */
  comments: { author: { login: string }; body: string; createdAt: string }[]
}

/** A PR of the queue, with the searches that found it. */
export interface MyGhPr extends GhPr {
  /** My review is requested (directly or through a team). */
  requested: boolean
  /** I am one of its assignees. */
  assigned: boolean
}

const PR_FIELDS =
  'number,title,url,author,headRefName,baseRefName,headRefOid,isDraft,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,updatedAt,mergedAt,reviews,reviewRequests,comments'

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

/** A PR's state on GitHub, or null when GitHub cannot say (the read failed). */
export async function prStateOf(
  repoPath: string,
  number: number,
): Promise<'OPEN' | 'CLOSED' | 'MERGED' | null> {
  try {
    const r = await gh<{ state: string }>(repoPath, ['pr', 'view', String(number), '--json', 'state'])
    return r.state === 'OPEN' || r.state === 'CLOSED' || r.state === 'MERGED' ? r.state : null
  } catch {
    return null
  }
}

/** Whether a PR was merged: one that left the queue may also have been closed or unassigned. */
export async function prMerged(repoPath: string, number: number): Promise<boolean> {
  return (await prStateOf(repoPath, number)) === 'MERGED'
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
  /** Set when it is locked (`git worktree lock`): git keeps it until it is unlocked. */
  locked?: true
  /**
   * What it is in the middle of on `branch` (`rebase in progress`, `bisect in progress`): git lists it
   * detached meanwhile, yet holds the branch as checked out there.
   */
  busy?: string
  /**
   * The branches a stopped `git rebase --update-refs` here will move. Git holds each as checked out in
   * this worktree too, though the worktree is on none of them.
   */
  updates?: string[]
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
    else if (current && (line === 'locked' || line.startsWith('locked '))) current.locked = true
  }
  await Promise.all(
    trees
      .filter((tree) => !tree.branch)
      .map(async (tree) => {
        const busy = await busyWith(tree.path)
        if (busy) Object.assign(tree, busy)
      }),
  )
  return trees
}

/**
 * What a worktree git lists detached is busy with, and the branches it holds checked out there
 * (`branch_checked_out`): a rebase (`git rebase`, or `git am` that names a branch), a bisect started on
 * a branch, or a rebase with `--update-refs`, which will move the branches it lists. Deleting one of
 * them would break `git rebase --continue` or `git bisect reset`. Read from the worktree's own git
 * folder; null when it is busy with none, or that cannot be read.
 */
async function busyWith(worktreePath: string): Promise<Pick<Worktree, 'branch' | 'busy' | 'updates'> | null> {
  const dir = await gitDirOf(worktreePath)
  if (!dir) return null
  const read = (file: string) =>
    fs.promises.readFile(path.join(dir, file), 'utf8').then(
      (text) => text.trim(),
      () => '',
    )
  // Three lines per branch: its refname, then its sha before the rebase and its sha after it.
  const updates = (await read('rebase-merge/update-refs'))
    .split('\n')
    .filter((_, i) => i % 3 === 0)
    .filter((ref) => ref.startsWith('refs/heads/'))
    .map((ref) => ref.slice(11))
  for (const file of ['rebase-merge/head-name', 'rebase-apply/head-name']) {
    const name = await read(file)
    if (name.startsWith('refs/heads/')) return { branch: name.slice(11), busy: 'rebase in progress', updates }
  }
  // The branch bisect started on, as git wrote it: its name with `refs/heads/` removed, or a commit's
  // sha when it started detached.
  const start = await read('BISECT_START')
  if (start && !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(start))
    return { branch: start, busy: 'bisect in progress', updates }
  return updates.length ? { branch: null, busy: 'rebase in progress', updates } : null
}

/** A worktree's own git folder: its `.git` folder, or where its `.git` file points; null when neither. */
async function gitDirOf(worktreePath: string): Promise<string | null> {
  const dotGit = path.join(worktreePath, '.git')
  const stat = await fs.promises.stat(dotGit).catch(() => null)
  if (!stat) return null
  if (stat.isDirectory()) return dotGit
  const text = await fs.promises.readFile(dotGit, 'utf8').catch(() => '')
  const to = /^gitdir: (.+)$/m.exec(text)?.[1]?.trim()
  // A relative one is relative to the worktree (`worktree.useRelativePaths`).
  return to ? path.resolve(worktreePath, to) : null
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
  /** Local branch that is a symbolic ref (an alias, such as `trunk` for `main`) → the branch it points at. */
  symrefs: Map<string, string>
}

export async function listRefs(repoPath: string): Promise<Refs> {
  const out = await git(repoPath, [
    'for-each-ref',
    // The last field is what a symbolic ref points at: empty for any other ref.
    '--format=%(refname) %(objectname) %(symref)',
    'refs/heads',
    'refs/remotes/origin',
  ])
  const refs: Refs = { local: new Map(), remote: new Map(), symrefs: new Map() }
  for (const line of out ? out.split('\n') : []) {
    const [name, sha, target] = line.split(' ')
    if (name!.startsWith('refs/heads/')) {
      refs.local.set(name!.slice(11), sha!)
      if (target) refs.symrefs.set(name!.slice(11), target.replace(/^refs\/heads\//, ''))
    } else if (name !== 'refs/remotes/origin/HEAD') refs.remote.set(name!.slice(20), sha!)
  }
  return refs
}

/**
 * The branches whose history holds commit `sha`, named as `baseRefs` names them: a local branch by its
 * name (its full refname when that starts with `origin/` or `refs/`), origin's as `origin/<name>`.
 * Throws when `sha` is no commit here.
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
    // A local branch called `origin/<x>` or `refs/<x>` keeps its full refname, as `localRef` names it.
    if (name.startsWith('refs/heads/origin/') || name.startsWith('refs/heads/refs/')) names.add(name)
    else if (name.startsWith('refs/heads/')) names.add(name.slice(11))
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

const NO_PROMPT = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }

/** Whether `branch` is a branch name git takes (`git check-ref-format --branch`), never an option. */
export async function validBranchName(repoPath: string, branch: string): Promise<boolean> {
  if (!branch || branch.startsWith('-') || branch !== branch.trim()) return false
  return git(repoPath, ['check-ref-format', '--branch', branch]).then(
    () => true,
    () => false,
  )
}

/**
 * Refreshes `origin/<branch>` alone, from origin, and returns the commit it is at; null when origin has
 * no such branch. Like `fetchOrigin` it touches no local branch or worktree and never prompts.
 */
export async function fetchOriginBranch(
  repoPath: string,
  branch: string,
  timeoutMs: number,
): Promise<string | null> {
  const ref = `refs/remotes/origin/${branch}`
  try {
    await run('git', ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:${ref}`], {
      cwd: repoPath,
      windowsHide: true,
      timeout: timeoutMs,
      env: NO_PROMPT,
    })
  } catch (err) {
    if (/couldn't find remote ref|could not find remote ref/i.test(gitSaid(err))) return null
    throw err
  }
  return (
    (await git(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).catch(() => '')) || null
  )
}

/** A new worktree at `worktreePath`, detached at `sha`: no branch is made or checked out. */
export async function addDetachedWorktree(
  repoPath: string,
  worktreePath: string,
  sha: string,
): Promise<void> {
  await git(repoPath, ['worktree', 'add', '--detach', '--', worktreePath, sha])
}

/** Moves a detached worktree to `sha` (`git checkout --detach`); git refuses when that would lose a change. */
export async function checkoutDetached(worktreePath: string, sha: string): Promise<void> {
  await git(worktreePath, ['checkout', '--quiet', '--detach', sha])
}

/** The worktree's HEAD: its branch (`refs/heads/<name>`), or null when it is detached. */
export async function headBranch(worktreePath: string): Promise<string | null> {
  return (await git(worktreePath, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')) || null
}

/** The commit the worktree is at. */
export async function headSha(worktreePath: string): Promise<string> {
  return git(worktreePath, ['rev-parse', 'HEAD'])
}

/** Origin's default branch (`refs/remotes/origin/HEAD`); null when the checkout does not know it. */
export async function originHead(repoPath: string): Promise<string | null> {
  const ref = await git(repoPath, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']).catch(() => '')
  return ref.startsWith('refs/remotes/origin/') ? ref.slice(20) : null
}

/** Where origin is (`git remote get-url origin`); null when the checkout has no origin. */
export async function originUrl(repoPath: string): Promise<string | null> {
  return (await git(repoPath, ['remote', 'get-url', 'origin']).catch(() => '')) || null
}

/** Whether commit `a` is in `b`'s history (`a` itself included). */
export function isAncestor(repoPath: string, a: string, b: string): Promise<boolean> {
  return git(repoPath, ['merge-base', '--is-ancestor', a, b]).then(
    () => true,
    () => false,
  )
}

/**
 * What removing a worktree would lose: its changed and untracked files as `git status` lists them, not
 * the ignored ones, whatever the repository's or the user's config says `git status` shows; else the
 * edits it never lists, to files marked skip-worktree or assume-unchanged (`markedChanges`).
 */
export async function worktreeChanges(worktreePath: string): Promise<string[]> {
  const out = await git(worktreePath, [
    // A read: no refreshed index written back, so the overrides below never reach it.
    '--no-optional-locks',
    // Neither a cache nor a file monitor that missed a change answers for what is there.
    '-c',
    'core.untrackedCache=false',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.ignoreStat=false',
    'status',
    '--porcelain',
    // Untracked files whatever status.showUntrackedFiles says. `normal` lists an untracked folder as
    // one line, not every file in it: one is enough to keep the worktree.
    '--untracked-files=normal',
    // Submodules whatever diff.ignoreSubmodules or submodule.<name>.ignore says.
    '--ignore-submodules=none',
  ])
  return out ? out.split('\n') : markedChanges(worktreePath)
}

/** How many files marked skip-worktree or assume-unchanged that are there a removal checks, at most. */
const MARKED_LIMIT = 1000

/**
 * Edits `git status` never lists: to a tracked file marked skip-worktree (`S`) or assume-unchanged (a
 * lowercase tag), each as `<path> (<mark>)`. A marked file that is not there, as in a sparse checkout,
 * loses nothing. One that is there is compared with its index entry as git hashes it, with its
 * attributes' filters. More of them than `MARKED_LIMIT` are not checked: that answers as a change, and
 * so does one there whose name is not UTF-8.
 */
async function markedChanges(worktreePath: string): Promise<string[]> {
  // Each folder's names, read once: the marked files of a sparse checkout are many, their folders few.
  const listings = new Map<string, { names: Set<string>; lower: Set<string> } | null>()
  const there = (file: string) => {
    const slash = file.lastIndexOf('/')
    const dir = file.slice(0, slash + 1)
    let listing = listings.get(dir)
    if (listing === undefined) {
      try {
        const names = fs.readdirSync(`${worktreePath}/${dir}`)
        listing = { names: new Set(names), lower: new Set(names.map((n) => n.toLowerCase())) }
      } catch {
        listing = null
      }
      listings.set(dir, listing)
    }
    const name = file.slice(slash + 1)
    if (!listing?.lower.has(name.toLowerCase())) return false
    // Named in another case: there only where names ignore case.
    return listing.names.has(name) || fs.existsSync(`${worktreePath}/${file}`)
  }
  const marked: { file: string; mode: string; sha: string; mark: string }[] = []
  // Marked files whose name is not UTF-8 (Linux takes any bytes): text cannot name them, so they are
  // not compared. One that is there counts as changed, named as git quotes it.
  const unnamed: string[] = []
  let count = 0
  await gitEntries(worktreePath, ['ls-files', '-v', '-s', '-z'], (entry) => {
    // `<tag> <mode> <sha> <stage>\t<path>`
    const tag = String.fromCharCode(entry[0]!)
    if (tag !== 'S' && tag === tag.toUpperCase()) return
    const tab = entry.indexOf(0x09)
    const name = entry.subarray(tab + 1)
    const file = name.toString('utf8')
    const mark =
      tag === 'S' ? 'skip-worktree' : tag === 's' ? 'skip-worktree, assume-unchanged' : 'assume-unchanged'
    if (!Buffer.from(file, 'utf8').equals(name)) {
      const at = Buffer.concat([Buffer.from(`${worktreePath}/`), name])
      if (!fs.lstatSync(at, { throwIfNoEntry: false }) || ++count > MARKED_LIMIT) return
      return void unnamed.push(`${quoted(name)} (${mark})`)
    }
    if (!there(file) || ++count > MARKED_LIMIT) return
    const [, mode = '', sha = ''] = entry.subarray(0, tab).toString('utf8').split(' ')
    marked.push({ file, mode, sha, mark })
  })
  if (count > MARKED_LIMIT)
    return [`${count} files marked skip-worktree or assume-unchanged, too many to check for edits`]
  const changed: typeof marked = []
  const hashed: typeof marked = []
  for (const m of marked) {
    const file = `${worktreePath}/${m.file}`
    const stat = fs.lstatSync(file, { throwIfNoEntry: false })
    if (!stat) continue
    if (stat.isFile() && m.mode !== '160000') hashed.push(m)
    else if (stat.isSymbolicLink() && m.mode === '120000') {
      // A link's blob is its target.
      const target = Buffer.from(fs.readlinkSync(file))
      const hash = createHash(m.sha.length === 64 ? 'sha256' : 'sha1')
      if (hash.update(`blob ${target.length}\0`).update(target).digest('hex') !== m.sha) changed.push(m)
    }
    // A folder or a link where a file was, a submodule: not what the index holds.
    else changed.push(m)
  }
  if (hashed.length) {
    const cwd = assertCwdFits(worktreePath)
    // `--stdin-paths` reads a path a line, and unquotes one that starts with a quote.
    const line = (p: string) =>
      p.startsWith('"') || /[\n\r]/.test(p)
        ? `"${p.replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`
        : p
    const out = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        'git',
        ['hash-object', '--stdin-paths'],
        { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
      )
      child.stdin?.end(hashed.map((m) => line(m.file)).join('\n') + '\n')
    })
    const shas = out.trim().split('\n')
    hashed.forEach((m, i) => shas[i] !== m.sha && changed.push(m))
  }
  return [...unnamed, ...changed.map((m) => `${m.file} (${m.mark})`)]
}

/** A file name as git quotes one (`core.quotePath`): a byte that is not plain ASCII as `\ooo`. */
const quoted = (name: Buffer) =>
  `"${[...name]
    .map((b) =>
      b === 0x22 || b === 0x5c
        ? `\\${String.fromCharCode(b)}`
        : b >= 0x20 && b < 0x7f
          ? String.fromCharCode(b)
          : `\\${b.toString(8).padStart(3, '0')}`,
    )
    .join('')}"`

/**
 * The files git tracks at these paths of the worktree (relative to it, with `/`), or under them, each
 * handed to `each` as git lists it; each path is taken literally, never as a pattern, in any case.
 * The listing is read as it comes, never held whole: a folder of any number of files answers.
 */
export async function eachTrackedFile(
  worktreePath: string,
  paths: string[],
  each: (file: string) => void,
): Promise<void> {
  const pathspecs = paths.map((p) => `:(literal,icase)${p}`)
  // Some at a time: a command line has a length limit (32k characters on Windows).
  while (pathspecs.length) {
    let length = 0
    let n = 0
    while (n < pathspecs.length && (n === 0 || length + pathspecs[n]!.length < 16_000))
      length += pathspecs[n++]!.length + 1
    await gitEntries(worktreePath, ['ls-files', '-z', '--', ...pathspecs.splice(0, n)], (entry) =>
      each(entry.toString('utf8')),
    )
  }
}

/**
 * A git command's `-z` output, entry by entry as git writes it: no buffer to outgrow. Fails as `git`
 * does, with git's error lines for `gitSaid`, and when `each` throws.
 */
function gitEntries(cwd: string, args: string[], each: (entry: Buffer) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const tooLong = cwdTooLong(cwd)
    if (tooLong) return reject(tooLong)
    const child = spawn('git', args, {
      cwd: startDir(cwd),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // Bytes, as git wrote them: a name need not be UTF-8.
    let rest: Buffer = Buffer.alloc(0)
    let stderr = ''
    let thrown: { err: unknown } | null = null
    const take = (entries: Buffer[]) => {
      try {
        for (const entry of entries) if (entry.length) each(entry)
      } catch (err) {
        thrown = { err }
        child.kill()
      }
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (thrown) return
      const data = rest.length ? Buffer.concat([rest, chunk]) : chunk
      const entries: Buffer[] = []
      let start = 0
      for (let end = data.indexOf(0); end >= 0; end = data.indexOf(0, start)) {
        entries.push(data.subarray(start, end))
        start = end + 1
      }
      rest = data.subarray(start)
      take(entries)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => (stderr += chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      if (!thrown && code === 0) take([rest])
      if (thrown) return reject(thrown.err)
      if (code !== 0)
        return reject(Object.assign(new Error(`git ${args[0]} exited with ${code}`), { stderr }))
      resolve()
    })
  })
}

/** git's own last word on why a command failed: its error lines, else the message. */
export function gitSaid(err: unknown): string {
  const e = err as { killed?: boolean; stderr?: string; message?: string }
  if (e.killed) return 'git gave up waiting'
  const lines = (e.stderr || e.message || String(err))
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('Command failed:'))
  const errors = lines.filter((l) => /^(fatal|error):/.test(l))
  return (errors.length ? errors : lines).join(' ') || 'git failed'
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
  const cwd = assertCwdFits(repoPath)
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
      { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
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

// --- writes: the human's Cleanup actions, nothing else ---

/**
 * Removes a worktree and its folder, never with `--force`: git refuses one with changed or untracked
 * files (ignored ones, such as node_modules, go with it), a locked one and the main checkout. On
 * Windows git deletes through a directory junction in it, as through a folder: the caller removes its
 * links first, each the link alone (`worktreeLinks.ts`).
 */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await git(repoPath, ['worktree', 'remove', '--', worktreePath])
}

/**
 * Deletes the local branch, only while it is still at `sha`: one that moved since is left alone. By
 * its full refname, so no branch name is ever read as an option. `--no-deref`: a branch that is a
 * symbolic ref to another goes alone, never the branch it points at.
 */
export async function deleteLocalBranch(repoPath: string, branch: string, sha: string): Promise<void> {
  await git(repoPath, ['update-ref', '--no-deref', '-d', '--end-of-options', `refs/heads/${branch}`, sha])
}

/**
 * The branch origin holds `branch` as a symbolic ref to, by its short name (`main` for an alias of
 * it), as origin holds it now; null when it holds it as a branch of its own, or not at all. Deleting
 * such a ref on origin deletes the branch it points at, so the caller refuses it. Never prompts for
 * credentials, gives up after `timeoutMs`.
 */
export async function originSymref(
  repoPath: string,
  branch: string,
  timeoutMs: number,
): Promise<string | null> {
  const ref = `refs/heads/${branch}`
  const { stdout } = await run('git', ['ls-remote', '--symref', 'origin', ref], {
    cwd: repoPath,
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  })
  // `ref: <target>` and then the ref's own line, tab-separated, where origin holds it as a symbolic ref.
  for (const line of stdout.split('\n')) {
    const m = /^ref: (\S+)\t(\S+)\r?$/.exec(line)
    if (m && m[2] === ref) return m[1]!.replace(/^refs\/heads\//, '')
  }
  return null
}

/**
 * Deletes the branch on origin, only while origin still has it at `sha` (`--force-with-lease`): one
 * someone pushed to since is left alone. A symbolic ref on origin is not deleted here: the caller
 * refuses it first (`originSymref`). Never prompts for credentials, gives up after `timeoutMs`.
 * The checkout's copy (`origin/<branch>`) goes with it.
 */
export async function deleteOriginBranch(
  repoPath: string,
  branch: string,
  sha: string,
  timeoutMs: number,
): Promise<void> {
  const ref = `refs/heads/${branch}`
  await run(
    'git',
    ['push', '--porcelain', `--force-with-lease=${ref}:${sha}`, 'origin', '--end-of-options', `:${ref}`],
    {
      cwd: repoPath,
      windowsHide: true,
      timeout: timeoutMs,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    },
  ).catch((err: { stdout?: string }) => {
    // --porcelain says why on stdout; a lease that no longer holds reads "stale info".
    if (err.stdout?.includes('(stale info)'))
      throw new Error(`origin's ${branch} is no longer at ${sha.slice(0, 7)}`)
    throw err
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

/**
 * Whether merging commit `head` into commit `base` conflicts, as `merge-tree` works it out without a
 * checkout: true or false, or null when git cannot tell (a commit missing here, as a fork's head is,
 * or no common history). Like `branchReach`, it writes no ref and touches no worktree.
 */
export async function mergeConflicts(repoPath: string, base: string, head: string): Promise<boolean | null> {
  try {
    await git(repoPath, ['merge-tree', '--write-tree', base, head])
    return false
  } catch (err) {
    // A conflicted merge exits 1 and still prints the tree it wrote first; anything else is git failing.
    const e = err as { code?: unknown; stdout?: string }
    return e.code === 1 && /^[0-9a-f]{40,64}$/.test(e.stdout?.split('\n')[0] ?? '') ? true : null
  }
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
  return { state: (await addsNothing(repoPath, base, ref)) ? 'edited' : 'unique', into: base, unique }
}

/**
 * Whether merging `ref` into `base` would change nothing: the merge's tree is the base's own. Written
 * by `merge-tree`, which touches no ref and no checkout.
 */
export async function addsNothing(repoPath: string, base: string, ref: string): Promise<boolean> {
  // A conflicting merge exits non-zero: that branch surely still has something of its own.
  const [merged, baseTree] = await Promise.all([
    git(repoPath, ['merge-tree', '--write-tree', base, ref]).catch(() => ''),
    git(repoPath, ['rev-parse', `${base}^{tree}`]),
  ])
  return merged.split('\n')[0] === baseTree
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
  if (await isAncestor(repoPath, ref, other)) return false
  // Quick way out: nothing the two share lies outside the bases.
  const shared = await git(repoPath, ['merge-base', '--all', ref, other]).catch(() => '')
  let outside = false
  for (const sha of shared ? shared.split('\n') : []) {
    const landed = await Promise.all(bases.map((b) => isAncestor(repoPath, sha, b)))
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
