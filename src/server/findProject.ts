import { inArray } from 'drizzle-orm'

import { db, schema } from '#/db'
import { HttpError } from './http'
import { githubSlug, listRepos } from './repos'

/**
 * The board project of the checkout an agent is in, found from what the agent knows about it: its
 * origin's GitHub slug, its folder name and its path. Read from the board as it is now, so a project or
 * repo added, moved or renamed is found at once. The answer holds only the repos that matched and their
 * projects, never the others: an agent learns its own project, not the board's list.
 */

export interface Where {
  /** `owner/name`, or the origin URL as `git remote get-url origin` gives it. */
  githubRepo?: string
  /** The checkout's folder name (a whole path counts by its last segment). */
  folder?: string
  /** The checkout's path, in the agent's own form (Linux, WSL or Windows). */
  path?: string
}

type Repo = Pick<schema.Repo, 'id' | 'name' | 'repoPath' | 'githubRepo' | 'baseBranch'>

export type Found =
  | {
      match: 'one'
      by: By
      projectId: number
      projectName: string
      repoId: number
      repo: Repo
      message: string
      weak?: true
    }
  | {
      match: 'repos'
      by: By
      projectId: number
      projectName: string
      repos: Repo[]
      message: string
      weak?: true
    }
  | {
      match: 'ambiguous'
      by: By
      candidates: { projectId: number; projectName: string; repo: Repo }[]
      message: string
      weak?: true
    }
  | { match: 'none'; message: string }

type By = 'githubRepo' | 'path' | 'folder'

const GITHUB_REPO = /^[\w.-]+\/[\w.-]+$/

/** `owner/name` from either an `owner/name` or a github.com origin URL; null for anything else. */
export function slugOf(given: string): string | null {
  const s = given.trim()
  return GITHUB_REPO.test(s) ? s : githubSlug(s)
}

/**
 * A checkout's path as a key the board and an agent on another side of WSL agree on: slashes either way,
 * doubled or trailing ones aside, and `/mnt/c/…` the same as `C:\…`. A drive path is a Windows file
 * system's, which ignores case; any other path keeps its case.
 */
export function checkoutKey(p: string): string {
  let s = p
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')
  const wsl = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(s)
  if (wsl) s = `${wsl[1]}:${wsl[2] ?? ''}`
  return /^[a-zA-Z]:(\/|$)/.test(s) ? s.toLowerCase() : s
}

/** The last segment of a path, either slash, a trailing one ignored. */
export const folderOf = (p: string) =>
  p
    .trim()
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || p.trim()

const repoShape = (r: schema.Repo): Repo => ({
  id: r.id,
  name: r.name,
  repoPath: r.repoPath,
  githubRepo: r.githubRepo,
  baseBranch: r.baseBranch,
})

export function findProject(where: Where): Found {
  const given = {
    githubRepo: where.githubRepo?.trim() || '',
    folder: where.folder?.trim() || '',
    path: where.path?.trim() || '',
  }
  if (!given.githubRepo && !given.folder && !given.path)
    throw new HttpError(
      400,
      'give at least one of githubRepo (git remote get-url origin), folder or path (git rev-parse --show-toplevel)',
    )
  const slug = given.githubRepo ? slugOf(given.githubRepo) : null
  const repos = listRepos()

  const key = given.path ? checkoutKey(given.path) : ''
  const atPath = (r: schema.Repo) => !!key && checkoutKey(r.repoPath) === key
  const under = (r: schema.Repo) => !!key && checkoutKey(r.repoPath).startsWith(`${key}/`)
  // The folder the agent named, else the last segment of its path: the same repo checked out on Windows
  // and in WSL, or on another machine, sits under another path with the same folder name.
  const named = given.folder || given.path
  const folder = named ? folderOf(named).toLowerCase() : ''
  const inFolder = (r: schema.Repo) => !!folder && folderOf(r.repoPath).toLowerCase() === folder

  let hits: schema.Repo[] = []
  let by: By | null = null
  if (slug) {
    hits = repos.filter((r) => r.githubRepo?.toLowerCase() === slug.toLowerCase())
    by = 'githubRepo'
    // The same GitHub repo registered more than once: the checkout's own path or folder picks among them.
    if (hits.length > 1) {
      const narrowed = [atPath, inFolder].map((f) => hits.filter(f)).find((h) => h.length)
      if (narrowed) hits = narrowed
    }
  }
  if (!hits.length) {
    for (const [test, kind] of [
      [atPath, 'path'],
      [under, 'path'],
      [inFolder, 'folder'],
    ] as const) {
      hits = repos.filter(test)
      by = kind
      if (hits.length) break
    }
  }
  if (!hits.length || !by) return { match: 'none', message: noProject(given, slug) }

  // A hit by path or folder on a repo whose GitHub repo is another than the one given may be another
  // repository that only shares the folder: it is returned, marked as weak, never taken silently.
  const others =
    slug && by !== 'githubRepo'
      ? hits.filter((r) => r.githubRepo && r.githubRepo.toLowerCase() !== slug.toLowerCase())
      : []
  const weak = others.length ? { weak: true as const } : {}
  const caution = others.length
    ? ` Careful: your origin is ${slug}, but ${others.map((r) => `${r.name} is ${r.githubRepo}`).join(', ')} on the board: this may be another repository with the same ${by}; confirm with the human before using it.`
    : ''

  const names = projectNames([...new Set(hits.map((r) => r.projectId))])
  const what =
    by === 'githubRepo' ? `GitHub repo ${slug}` : by === 'path' ? `path ${given.path}` : `folder ${folder}`
  if (names.size > 1) {
    return {
      match: 'ambiguous',
      by,
      candidates: hits.map((r) => ({
        projectId: r.projectId,
        projectName: names.get(r.projectId)!,
        repo: repoShape(r),
      })),
      message: `The ${what} matches repos in ${names.size} projects: do not pick one; ask the human which project this repo belongs to.${caution}`,
      ...weak,
    }
  }
  const projectId = hits[0]!.projectId
  const projectName = names.get(projectId)!
  if (hits.length > 1) {
    return {
      match: 'repos',
      by,
      projectId,
      projectName,
      repos: hits.map(repoShape),
      message: `The ${what} matches ${hits.length} repos of project ${projectName}: ask which repo (or take it from the ticket) before passing a repoId.${caution}`,
      ...weak,
    }
  }
  const repo = repoShape(hits[0]!)
  return {
    match: 'one',
    by,
    projectId,
    projectName,
    repoId: repo.id,
    repo,
    message: `This is repo ${repo.name} of project ${projectName}.${caution}`,
    ...weak,
  }
}

function projectNames(ids: number[]) {
  const rows = db
    .select({ id: schema.projects.id, name: schema.projects.name })
    .from(schema.projects)
    .where(inArray(schema.projects.id, ids))
    .all()
  return new Map(rows.map((p) => [p.id, p.name]))
}

function noProject(given: { githubRepo: string; folder: string; path: string }, slug: string | null) {
  const asked = [
    given.githubRepo &&
      (slug
        ? `GitHub repo ${slug}`
        : `origin ${given.githubRepo.replace(/\/\/[^@/]+@/, '//')} (not a GitHub repo)`),
    given.folder && `folder ${given.folder}`,
    given.path && `path ${given.path}`,
  ].filter(Boolean)
  return `No board project for this repo (${asked.join(', ')}): say so and stop using the board for it. Do not guess from other projects and do not create one.`
}
