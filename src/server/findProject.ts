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

/**
 * What matched: the GitHub slug, the path (equal to a repo's, or holding several), a path `inside` a
 * repo's checkout (a worktree nested in it), the folder name, or a folder `beside` a repo's checkout whose
 * name starts with the repo's (a worktree next to it, `<folder>-<branch>`).
 */
type By = 'githubRepo' | 'path' | 'inside' | 'folder' | 'beside'

const OWNER_NAME = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/
/** An ssh origin on any host: `[user@]host:o/n(.git)` or `ssh://[user@]host[:port]/o/n(.git)`. */
const SSH_ORIGIN =
  /^(?:ssh:\/\/(?:[^@/]+@)?([^/:@]+)(?::\d+)?\/|(?:[^@/:]+@)?([^/:@]+):)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i

/**
 * The `owner/name` of what the agent gave as its origin: an `owner/name` (a trailing `.git` or `/` aside),
 * a github.com URL, or an ssh origin on another host, which is how an ssh-config alias of GitHub
 * (`git@github-work:o/n.git`) reads. `alias` is that other host: the slug is then only a guess. Null for
 * anything else (an https URL of another host).
 */
export function originOf(given: string): { slug: string | null; alias: string | null } {
  const s = given.trim()
  const own = OWNER_NAME.exec(s)
  if (own) return { slug: `${own[1]}/${own[2]}`, alias: null }
  const github = githubSlug(s)
  if (github) return { slug: github, alias: null }
  const ssh = SSH_ORIGIN.exec(s)
  if (!ssh) return { slug: null, alias: null }
  const host = (ssh[1] ?? ssh[2])!
  return { slug: `${ssh[3]}/${ssh[4]}`, alias: host.toLowerCase() === 'github.com' ? null : host }
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
export function folderOf(p: string) {
  const s = p.trim()
  // Trailing slashes stripped by a scan from the end: a regex for them backtracks over a long run.
  let end = s.length
  while (end > 0 && (s[end - 1] === '/' || s[end - 1] === '\\')) end--
  return s.slice(0, end).split(/[\\/]/).pop() || s
}

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
  const { slug, alias } = given.githubRepo ? originOf(given.githubRepo) : { slug: null, alias: null }
  const repos = listRepos()
  const sameSlug = (r: schema.Repo) => !!slug && r.githubRepo?.toLowerCase() === slug.toLowerCase()

  const key = given.path ? checkoutKey(given.path) : ''
  const parentOf = (k: string) => k.slice(0, k.lastIndexOf('/'))
  const atPath = (r: schema.Repo) => !!key && checkoutKey(r.repoPath) === key
  const under = (r: schema.Repo) => !!key && checkoutKey(r.repoPath).startsWith(`${key}/`)
  const inside = (r: schema.Repo) => !!key && key.startsWith(`${checkoutKey(r.repoPath)}/`)
  // The folder the agent named, else the last segment of its path: the same repo checked out on Windows
  // and in WSL, or on another machine, sits under another path with the same folder name.
  const named = given.folder || given.path
  const folder = named ? folderOf(named).toLowerCase() : ''
  const inFolder = (r: schema.Repo) => !!folder && folderOf(r.repoPath).toLowerCase() === folder
  const beside = (r: schema.Repo) =>
    !!key &&
    key.includes('/') &&
    parentOf(checkoutKey(r.repoPath)) === parentOf(key) &&
    folder.startsWith(`${folderOf(r.repoPath).toLowerCase()}-`)

  let hits: schema.Repo[] = []
  let by: By | null = null
  // A slug read from an ssh host that is not github.com is only a guess: the checkout's own path, or the
  // checkout it sits in, wins over it.
  if (alias)
    for (const [test, kind] of [
      [atPath, 'path'],
      [inside, 'inside'],
    ] as const) {
      hits = repos.filter(test)
      by = kind
      if (hits.length) break
    }
  if (slug && !hits.length) {
    hits = repos.filter(sameSlug)
    by = 'githubRepo'
    // The same GitHub repo registered more than once: the checkout's own path or folder picks among them.
    if (hits.length > 1) {
      const narrowed = [atPath, inside, inFolder].map((f) => hits.filter(f)).find((h) => h.length)
      if (narrowed) hits = narrowed
    }
  }
  if (!hits.length) {
    for (const [test, kind] of [
      [atPath, 'path'],
      [under, 'path'],
      [inside, 'inside'],
      [inFolder, 'folder'],
      [beside, 'beside'],
    ] as const) {
      hits = repos.filter(test)
      by = kind
      if (hits.length) break
    }
  }
  // Checkouts nested in one another: the path belongs to the innermost.
  if (by === 'inside' && hits.length > 1) {
    const depth = (r: schema.Repo) => checkoutKey(r.repoPath).length
    const deepest = Math.max(...hits.map(depth))
    hits = hits.filter((r) => depth(r) === deepest)
  }
  if (!hits.length || !by) return { match: 'none', message: noProject(given, slug, alias) }

  // A hit that may be another repository than the agent's is returned marked as weak, never taken
  // silently: a slug read from an ssh host that is not github.com; a path or folder hit on a repo whose
  // GitHub repo is another than the one given; a path inside a checkout whose GitHub repo the origin does
  // not confirm; a path that only holds one checkout; and a folder beside a checkout, which only its name
  // ties to it.
  const cautions: string[] = []
  if (by === 'githubRepo' && alias)
    cautions.push(
      `your origin's host is ${alias}, not github.com, so ${slug} is read from its path only: this may be another repository`,
    )
  // A path inside a checkout is checked against any origin given, even one that reads as no GitHub repo (a
  // clone nested in another repo's checkout is another repository); a GitHub origin also does not confirm
  // a repo with no GitHub repo on the board. A slug guessed from another ssh host is no GitHub origin: the
  // host may as well be GitLab's as an alias of GitHub.
  const checked = by === 'inside' ? !!given.githubRepo : !!slug && (by === 'path' || by === 'folder')
  if (checked) {
    const others = hits.filter((r) => (r.githubRepo ? !sameSlug(r) : by === 'inside' && !!slug && !alias))
    if (others.length)
      cautions.push(
        `your origin is ${slug ?? withoutCredentials(given.githubRepo)}, but ${others.map((r) => `${r.name} is ${r.githubRepo ?? 'no GitHub repo'}`).join(', ')} on the board: this may be another repository ${by === 'inside' ? 'checked out inside it' : `with the same ${by}`}`,
      )
  }
  // A path holding one checkout is not that checkout: the agent may be in another repository around it.
  if (by === 'path' && hits.length === 1 && !atPath(hits[0]!))
    cautions.push(
      `your path ${given.path} is not the checkout of ${hits[0]!.name} but holds it (${hits[0]!.repoPath}): you may be in another repository that contains it`,
    )
  if (by === 'beside')
    cautions.push(
      `your checkout only sits beside ${hits.map((r) => r.repoPath).join(', ')} with a name that starts like it: it may be a worktree of it, or another repository`,
    )
  const weak = cautions.length ? { weak: true as const } : {}
  const caution = cautions.length
    ? ` Careful: ${cautions.join('; ')}; confirm with the human before using it.`
    : ''

  const names = projectNames([...new Set(hits.map((r) => r.projectId))])
  const what =
    by === 'githubRepo'
      ? `GitHub repo ${slug}`
      : by === 'path' || by === 'inside'
        ? `path ${given.path}`
        : `folder ${folder}`
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

/** An origin URL as it may be shown back: any `user:password@` after `//` dropped. */
const withoutCredentials = (origin: string) => origin.replace(/\/\/[^@/]+@/, '//')

function noProject(
  given: { githubRepo: string; folder: string; path: string },
  slug: string | null,
  alias: string | null,
) {
  const origin = withoutCredentials(given.githubRepo)
  const asked = [
    given.githubRepo &&
      (slug && !alias
        ? `GitHub repo ${slug}`
        : slug
          ? `origin ${origin} (read as ${slug})`
          : `origin ${origin} (not a GitHub repo)`),
    given.folder && `folder ${given.folder}`,
    given.path && `path ${given.path}`,
  ].filter(Boolean)
  return `No board project for this repo (${asked.join(', ')}): say so and stop using the board for it. Do not guess from other projects and do not create one.`
}
