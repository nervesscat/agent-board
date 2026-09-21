import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { promisify } from 'node:util'

import { HttpError } from './http'

/**
 * The board never writes to git or GitHub. Every command here is a read: the allowlist below is
 * the whole vocabulary, and nothing else in the codebase spawns `git` or `gh`.
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
  updatedAt: string
  reviews: { author: { login: string }; state: string; submittedAt: string }[]
}

const PR_FIELDS =
  'number,title,url,author,headRefName,baseRefName,headRefOid,isDraft,reviewDecision,updatedAt,reviews'

/** Open PRs where my review was requested, plus the ones I already reviewed and are still open. */
export async function listMyPrs(repoPath: string): Promise<GhPr[]> {
  const [requested, reviewed] = await Promise.all([
    gh<GhPr[]>(repoPath, [
      'pr',
      'list',
      '--state',
      'open',
      '--limit',
      '100',
      '--search',
      'review-requested:@me',
      '--json',
      PR_FIELDS,
    ]),
    gh<GhPr[]>(repoPath, [
      'pr',
      'list',
      '--state',
      'open',
      '--limit',
      '100',
      '--search',
      'reviewed-by:@me',
      '--json',
      PR_FIELDS,
    ]),
  ])
  const byNumber = new Map<number, GhPr>()
  for (const pr of [...requested, ...reviewed]) byNumber.set(pr.number, pr)
  return [...byNumber.values()]
}

export interface BranchInfo {
  exists: boolean
  sha: string | null
  subject: string | null
  authoredAt: string | null
  ahead: number | null
  behind: number | null
}

export async function branchInfo(repoPath: string, branch: string, base: string): Promise<BranchInfo> {
  const none: BranchInfo = {
    exists: false,
    sha: null,
    subject: null,
    authoredAt: null,
    ahead: null,
    behind: null,
  }
  if (!branch) return none
  let ref = branch
  try {
    await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  } catch {
    try {
      await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])
      ref = `origin/${branch}`
    } catch {
      return none
    }
  }
  const [line, counts] = await Promise.all([
    git(repoPath, ['log', '-1', '--format=%H%x1f%s%x1f%aI', ref]),
    git(repoPath, ['rev-list', '--left-right', '--count', `${base}...${ref}`]).catch(() => ''),
  ])
  const [sha, subject, authoredAt] = line.split('\x1f')
  const [behind, ahead] = counts ? counts.split(/\s+/).map(Number) : [null, null]
  return { exists: true, sha, subject, authoredAt, ahead, behind }
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
