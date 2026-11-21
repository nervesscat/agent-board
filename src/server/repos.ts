import fs from 'node:fs'
import path from 'node:path'

import { and, asc, eq, inArray, isNull, ne, or } from 'drizzle-orm'

import { db, schema } from '#/db'
import { logActivity } from './activity'
import { folderKey } from './cleanup'
import { hasGitSide } from '#/lib/kinds'
import { assertRepo, originUrl, repoNameWithOwner } from './git'
import { HttpError, notFound } from './http'
import { forgetPreview } from './managedPreview'
import { createProject, getProject } from './projects'
import { seedRepo } from './runConfig'
import { forgetRepoRuns, stopRunsFor } from './runs'

/** A local git checkout the board reads with git and gh. Every repo belongs to one project. */

export function listRepos(projectId?: number) {
  const q = db.select().from(schema.repos)
  return (projectId ? q.where(eq(schema.repos.projectId, projectId)) : q)
    .orderBy(asc(schema.repos.name), asc(schema.repos.id))
    .all()
}

export function getRepo(id: number) {
  const r = db.select().from(schema.repos).where(eq(schema.repos.id, id)).get()
  if (!r) throw notFound('repo')
  return r
}

/**
 * The repo a project-level write refers to: the one given (which must be in the project), or the
 * project's only repo. A project with several repos needs it spelled out.
 */
export function resolveRepo(projectId: number, repoId?: number | null) {
  if (repoId) {
    const r = getRepo(repoId)
    if (r.projectId !== projectId) throw new HttpError(400, `repo ${repoId} is not in project ${projectId}`)
    return r
  }
  const repos = listRepos(projectId)
  if (repos.length === 1) return repos[0]!
  if (!repos.length) throw new HttpError(400, 'this project has no repos yet')
  throw new HttpError(
    400,
    `this project has ${repos.length} repos; give repoId (${repos.map((r) => `${r.id} ${r.name}`).join(', ')})`,
  )
}

/** The checkout a ticket's branch lives in: its own repo, else the project's first. */
export function ticketRepo(ticket: Pick<schema.Ticket, 'projectId' | 'repoId'>) {
  if (ticket.repoId) return getRepo(ticket.repoId)
  // A project with no software kind keeps its repos out of a ticket that names none.
  const kinds = db
    .select({ kinds: schema.projects.kinds })
    .from(schema.projects)
    .where(eq(schema.projects.id, ticket.projectId))
    .get()?.kinds
  if (!hasGitSide(kinds)) return null
  return listRepos(ticket.projectId)[0] ?? null
}

/**
 * The `owner/name` of a github.com remote URL, as git gives it: `https://github.com/o/n(.git)` (a user
 * before the host allowed), `git@github.com:o/n(.git)` or `ssh://git@github.com(:port)/o/n(.git)`. Null for
 * any other host or shape.
 */
export function githubSlug(url: string): string | null {
  const m =
    /^(?:(?:https?|ssh):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(
      url.trim(),
    )
  return m ? `${m[1]}/${m[2]}` : null
}

/** A GitHub `owner/name`, as `githubRepo` is given. */
const GITHUB_REPO = /^[\w.-]+\/[\w.-]+$/

/**
 * Why the repo an agent adds, or a card it posted asks for, cannot be added now, or null when it can: its path is an
 * existing git checkout, given whole; `origin` (the checkout's origin URL, as `originUrl` read it) is
 * github.com's `githubRepo`, owner and name in any casing; the project has no repo of that name (trimmed,
 * any casing); and no repo of the board is registered at that folder (`folderKey`: in any spelling, `.`,
 * `..`, doubled or either slashes, a trailing one, links, and on Windows any casing). Checked when it is
 * added, and again when the human answers Add on a card an agent posted before, since the checkout or the
 * board may have changed in between.
 */
export function repoRequestProblem(req: schema.RepoRequest, origin: string | null): HttpError | null {
  return (
    checkoutProblem(req.repoPath, req.githubRepo, origin) ??
    nameProblem(req.projectId, req.name) ??
    pathProblem(req.repoPath)
  )
}

/**
 * Why `repoPath` is not an existing git checkout, given whole, whose `origin` (as `originUrl` read it) is
 * github.com's `githubRepo` in any casing; null when it is.
 */
function checkoutProblem(repoPath: string, githubRepo: string, origin: string | null): HttpError | null {
  if (!path.isAbsolute(repoPath))
    return new HttpError(400, `give the checkout's absolute path, not ${repoPath}`)
  try {
    assertRepo(repoPath)
  } catch (err) {
    return err as HttpError
  }
  if (!fs.statSync(repoPath).isDirectory()) return new HttpError(400, `${repoPath} is not a folder`)
  if (!origin) return new HttpError(400, `${repoPath} has no origin remote`)
  const slug = githubSlug(origin)
  // Any credentials in the URL stay out of the message.
  const shown = origin.replace(/\/\/[^@/]+@/, '//')
  if (!slug) return new HttpError(400, `${repoPath}'s origin, ${shown}, is not a github.com repository`)
  if (slug.toLowerCase() !== githubRepo.toLowerCase())
    return new HttpError(400, `${repoPath}'s origin is ${slug}, not ${githubRepo}`)
  return null
}

/** Why the project has a repo of this name already (trimmed, any casing; `exceptRepoId` is not counted). */
function nameProblem(projectId: number, name: string, exceptRepoId?: number): HttpError | null {
  const named = listRepos(projectId).find(
    (r) => r.id !== exceptRepoId && r.name.trim().toLowerCase() === name.toLowerCase(),
  )
  return named
    ? new HttpError(409, `this project already has a repo named ${named.name} (repo ${named.id})`)
    : null
}

/** Why a repo of the board is registered at this folder already (`exceptRepoId` is not counted). */
function pathProblem(repoPath: string, exceptRepoId?: number): HttpError | null {
  const key = folderKey(repoPath)
  const there = listRepos().find((r) => r.id !== exceptRepoId && folderKey(r.repoPath) === key)
  return there
    ? new HttpError(
        409,
        `${repoPath} is already registered as repo ${there.id} ${there.name} of project ${getProject(there.projectId).name}`,
      )
    : null
}

/** The checkout's origin URL for `repoRequestProblem`; null when it is no checkout to ask git in. */
export async function requestOrigin(repoPath: string): Promise<string | null> {
  if (!path.isAbsolute(repoPath) || !fs.existsSync(`${repoPath}/.git`)) return null
  return originUrl(repoPath)
}

/** Whether `text` has a control character (U+0000 to U+001F, or DEL): a line break, a tab, an escape. */
const hasControl = (text: string) => [...text].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)

const cleanName = (raw: string) => {
  const name = raw.trim()
  if (!name || name.length > 100) throw new HttpError(400, 'give the repo a name: 1 to 100 characters')
  // The name is quoted in the activity: a line break in it would write lines of its own.
  if (hasControl(name)) throw new HttpError(400, 'the repo name is one line, with no control characters')
  return name
}

/** A path as given: an absolute one resolved, so its `.`, `..` and doubled slashes go; a relative one stays, for the checks to refuse. */
const cleanPath = (raw: string) => {
  const repoPath = raw.trim()
  if (!repoPath) throw new HttpError(400, "give the checkout's path")
  // A folder may be named with a line break on Linux; the activity would show it as lines of its own.
  if (hasControl(repoPath))
    throw new HttpError(400, "the checkout's path is one line, with no control characters")
  return path.isAbsolute(repoPath) ? path.resolve(repoPath) : repoPath
}

const cleanGithubRepo = (raw: string) => {
  const githubRepo = raw.trim()
  if (!GITHUB_REPO.test(githubRepo))
    throw new HttpError(400, `githubRepo is the GitHub owner/name (like acme/shop), not ${githubRepo}`)
  return githubRepo
}

const cleanBaseBranch = (raw: string | undefined) => {
  const baseBranch = raw?.trim() || 'main'
  if (baseBranch.length > 200) throw new HttpError(400, 'the base branch is 200 characters at most')
  // As in git, a branch name has no whitespace or control characters.
  if (/\s/.test(baseBranch) || hasControl(baseBranch))
    throw new HttpError(400, 'the base branch is a branch name: no spaces, line breaks or control characters')
  return baseBranch
}

/**
 * The repo to add to `projectId`, cleaned (trimmed; an absolute path resolved; base branch main when left
 * out) and checked (`repoRequestProblem`): what a card names and its Add creates, and what a direct add
 * inserts. A problem is thrown.
 */
export async function checkRepoRequest(
  projectId: number,
  input: { name: string; repoPath: string; githubRepo: string; baseBranch?: string },
): Promise<schema.RepoRequest> {
  const req = {
    projectId,
    name: cleanName(input.name),
    repoPath: cleanPath(input.repoPath),
    githubRepo: cleanGithubRepo(input.githubRepo),
    baseBranch: cleanBaseBranch(input.baseBranch),
  }
  const problem = repoRequestProblem(req, await requestOrigin(req.repoPath))
  if (problem) throw problem
  return req
}

/**
 * An agent adds a repo to `projectId` at once: it passes the checks of `checkRepoRequest` (nothing is added
 * otherwise) and goes in the project's activity under the agent's name.
 */
export async function addRepoDirect(
  projectId: number,
  input: { name: string; repoPath: string; githubRepo: string; baseBranch?: string },
  actor: string,
) {
  getProject(projectId)
  const row = insertRequestedRepo(await checkRepoRequest(projectId, input))
  logActivity({
    projectId,
    actor,
    kind: 'project',
    text: `added repo ${row.name} (${row.githubRepo})`,
    refType: 'repo',
    refId: row.id,
  })
  return row
}

/** The repo of `projectId` an agent's write names: another project's is refused (403), an unknown one is 404. */
function repoOfProject(projectId: number, repoId: number) {
  const repo = getRepo(repoId)
  if (repo.projectId !== projectId)
    throw new HttpError(
      403,
      `repo ${repoId} is in another project, not project ${projectId}: it is left alone`,
    )
  return repo
}

/**
 * An agent changes a repo of `projectId`: the fields given, cleaned as when adding, and only what changes
 * is checked. A new name is unique in the project (any casing); a new path or GitHub repo is the full
 * check of an add (the path is a git checkout whose origin is the GitHub repo, given or current, and no
 * other repo is at that path). Written through `updateRepo`, so a new path forgets the old checkout's
 * origin looks; the repo never leaves its project.
 */
export async function editRepo(
  projectId: number,
  repoId: number,
  input: { name?: string; repoPath?: string; githubRepo?: string; baseBranch?: string },
  actor: string,
) {
  const before = repoOfProject(projectId, repoId)
  if (
    input.name === undefined &&
    input.repoPath === undefined &&
    input.githubRepo === undefined &&
    input.baseBranch === undefined
  )
    throw new HttpError(400, 'give at least one of name, repoPath, githubRepo and baseBranch')
  const name = input.name === undefined ? undefined : cleanName(input.name)
  const repoPath = input.repoPath === undefined ? undefined : cleanPath(input.repoPath)
  const githubRepo = input.githubRepo === undefined ? undefined : cleanGithubRepo(input.githubRepo)
  const baseBranch = input.baseBranch === undefined ? undefined : cleanBaseBranch(input.baseBranch)
  const patch: Parameters<typeof updateRepo>[1] = {}
  if (name !== undefined && name !== before.name) {
    const problem = nameProblem(projectId, name, repoId)
    if (problem) throw problem
    patch.name = name
  }
  const pathChanged = repoPath !== undefined && repoPath !== before.repoPath
  const slugChanged =
    githubRepo !== undefined && githubRepo.toLowerCase() !== (before.githubRepo ?? '').toLowerCase()
  if (pathChanged || slugChanged) {
    const where = repoPath ?? before.repoPath
    const slug = githubRepo ?? before.githubRepo
    if (!slug) throw new HttpError(400, `give githubRepo: ${before.name} has none stored`)
    const problem =
      checkoutProblem(where, slug, await requestOrigin(where)) ??
      (pathChanged ? pathProblem(where, repoId) : null)
    if (problem) throw problem
    if (pathChanged) patch.repoPath = where
    if (slugChanged) patch.githubRepo = githubRepo
    // A new path keeps the stored slug as checked, not looked up again with gh.
    else if (pathChanged) patch.githubRepo = slug
  }
  if (baseBranch !== undefined && baseBranch !== before.baseBranch) patch.baseBranch = baseBranch
  if (!Object.keys(patch).length) return before
  return updateRepo(repoId, patch, actor)
}

/** An agent removes a repo of `projectId`: exactly the Repositories page's Remove (`deleteRepo`). Returns the removed repo. */
export function deleteRepoIn(projectId: number, repoId: number, actor: string) {
  const repo = repoOfProject(projectId, repoId)
  deleteRepo(repoId, actor)
  return repo
}

/**
 * A repo's add: the repo is created as it was asked (its `githubRepo` as checked, not looked up
 * again with gh). The caller checked it just before (`repoRequestProblem`) and logs it.
 */
export function insertRequestedRepo(req: schema.RepoRequest) {
  const row = db
    .insert(schema.repos)
    .values({
      projectId: req.projectId,
      name: req.name,
      repoPath: req.repoPath,
      githubRepo: req.githubRepo,
      baseBranch: req.baseBranch,
    })
    .returning()
    .get()
  // As createRepo: a checkout of the board gets the board's own preview run.
  seedRepo(row)
  return row
}

/** The repo a card's Add created already: the same name and folder (`folderKey`) in its project. */
export function requestedRepo(req: schema.RepoRequest) {
  const key = folderKey(req.repoPath)
  return (
    listRepos(req.projectId).find(
      (r) => r.name.trim().toLowerCase() === req.name.toLowerCase() && folderKey(r.repoPath) === key,
    ) ?? null
  )
}

const dirName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

export async function createRepo(
  input: { projectId?: number; projectName?: string; name?: string; repoPath: string; baseBranch?: string },
  actor: string,
) {
  assertRepo(input.repoPath)
  const projectId = input.projectId
    ? getProject(input.projectId).id
    : input.projectName
      ? createProject({ name: input.projectName }, actor).id
      : null
  if (!projectId) throw new HttpError(400, 'give projectId or projectName')
  const githubRepo = await repoNameWithOwner(input.repoPath)
  const row = db
    .insert(schema.repos)
    .values({
      projectId,
      name: input.name || githubRepo?.split('/').pop() || dirName(input.repoPath),
      repoPath: input.repoPath,
      githubRepo,
      baseBranch: input.baseBranch || 'main',
    })
    .returning()
    .get()
  logActivity({
    projectId,
    actor,
    kind: 'project',
    text: `added repo ${row.name}`,
    refType: 'repo',
    refId: row.id,
  })
  // A checkout of the board gets the board's own preview run.
  seedRepo(row)
  return row
}

export async function updateRepo(
  id: number,
  patch: Partial<Pick<schema.Repo, 'name' | 'repoPath' | 'githubRepo' | 'baseBranch' | 'projectId'>>,
  actor: string,
) {
  const before = getRepo(id)
  if (patch.projectId) getProject(patch.projectId)
  const set: Partial<schema.Repo> = { ...patch }
  const repath = !!patch.repoPath && patch.repoPath !== before.repoPath
  if (patch.repoPath && repath) {
    assertRepo(patch.repoPath)
    // A slug the caller checked is stored as given, not looked up again with gh.
    set.githubRepo = patch.githubRepo ?? (await repoNameWithOwner(patch.repoPath))
  }
  const moved = patch.projectId !== undefined && patch.projectId !== before.projectId
  // A ticket's repos are all of its project: what the move splits apart leaves the ticket, and its
  // runs for that ticket stop once the rows are gone.
  const left: { ticketId: number; repoId: number }[] = []
  const row = db.transaction((tx) => {
    const r = tx.update(schema.repos).set(set).where(eq(schema.repos.id, id)).returning().get()!
    // The repo's PRs, tickets and review results move with it; threads follow their parents.
    if (moved) {
      // The tickets it leaves behind no longer span it; the ones it takes no longer span the repos
      // that stay.
      const stays = tx
        .select({ ticketId: schema.ticketRepos.ticketId, repoId: schema.ticketRepos.repoId })
        .from(schema.ticketRepos)
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.ticketRepos.ticketId))
        .where(
          and(
            eq(schema.ticketRepos.repoId, id),
            or(isNull(schema.tickets.repoId), ne(schema.tickets.repoId, id)),
          ),
        )
        .all()
      const goes = tx
        .select({ ticketId: schema.ticketRepos.ticketId, repoId: schema.ticketRepos.repoId })
        .from(schema.ticketRepos)
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.ticketRepos.ticketId))
        .where(and(eq(schema.tickets.repoId, id), ne(schema.ticketRepos.repoId, id)))
        .all()
      for (const e of [...stays, ...goes]) {
        tx.delete(schema.ticketRepos)
          .where(and(eq(schema.ticketRepos.ticketId, e.ticketId), eq(schema.ticketRepos.repoId, e.repoId)))
          .run()
        left.push(e)
      }
      const to = { projectId: patch.projectId! }
      tx.update(schema.prs).set(to).where(eq(schema.prs.repoId, id)).run()
      // On the other project's board they arrive unplaced in their columns.
      tx.update(schema.tickets)
        .set({ ...to, rank: null })
        .where(eq(schema.tickets.repoId, id))
        .run()
      tx.update(schema.reviewResults).set(to).where(eq(schema.reviewResults.repoId, id)).run()
    }
    // Another checkout: what origin's branches were in the old one says nothing about it, so the
    // board's next look at it is a first look (pushed today).
    if (repath) {
      tx.delete(schema.originRefs).where(eq(schema.originRefs.repoId, id)).run()
      tx.delete(schema.originRefMoves).where(eq(schema.originRefMoves.repoId, id)).run()
      tx.delete(schema.originLooks).where(eq(schema.originLooks.repoId, id)).run()
    }
    return r
  })
  logActivity({
    projectId: row.projectId,
    actor,
    kind: 'project',
    text: moved
      ? `moved repo ${row.name} here from ${getProject(before.projectId).name}`
      : `updated repo ${row.name}`,
    refType: 'repo',
    refId: id,
  })
  if (left.length) {
    const from = getProject(before.projectId).name
    const to = getProject(row.projectId).name
    const names = new Map(listRepos(before.projectId).map((r) => [r.id, r.name]))
    for (const e of left)
      stopRunsFor(
        [e.ticketId],
        e.repoId === id
          ? `${row.name} moved to project ${to}`
          : `the ticket moved to project ${to} with ${row.name}; ${names.get(e.repoId) ?? `repo ${e.repoId}`} stays in ${from}`,
        actor,
        { repoId: e.repoId, lanes: false },
      )
    const behind = [...new Set(left.filter((e) => e.repoId === id).map((e) => e.ticketId))]
    if (behind.length)
      logActivity({
        projectId: before.projectId,
        actor,
        kind: 'project',
        text: `moved repo ${row.name} to ${to}: ${behind.map((t) => `#${t}`).join(', ')} no longer span it`,
        refType: 'repo',
        refId: id,
      })
  }
  if (moved) {
    // A ticket that stays can be running the repo without a row of it (one with no repo of its own
    // runs the project's first): those runs stop too.
    const stopped = new Set(left.filter((e) => e.repoId === id).map((e) => e.ticketId))
    const staying = db
      .select({ id: schema.tickets.id })
      .from(schema.tickets)
      .where(eq(schema.tickets.projectId, before.projectId))
      .all()
      .map((t) => t.id)
      .filter((t) => !stopped.has(t))
    if (staying.length)
      stopRunsFor(staying, `${row.name} moved to project ${getProject(row.projectId).name}`, actor, {
        repoId: id,
        lanes: false,
      })
  }
  return row
}

export function deleteRepo(id: number, actor: string) {
  const r = getRepo(id)
  // What runs from its worktrees goes with it: its run configs and ticket rows go with the row.
  forgetRepoRuns(id, actor)
  db.transaction(
    (tx) => {
      // The repo's PR rows go with it, and so do their tickets: a PR's own ticket is for its PR, and would read as a
      // feature ticket without one. Their workspaces' previews stop, as deleting a ticket stops them.
      const repoPrIds = tx.select({ id: schema.prs.id }).from(schema.prs).where(eq(schema.prs.repoId, id))
      const prTicketIds = tx
        .select({ id: schema.tickets.id })
        .from(schema.tickets)
        .where(inArray(schema.tickets.prId, repoPrIds))
      const workspaces = tx
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .where(inArray(schema.workspaces.ticketId, prTicketIds))
        .all()
      for (const w of workspaces) forgetPreview(w.id, actor)
      tx.delete(schema.tickets).where(inArray(schema.tickets.prId, repoPrIds)).run()
      // A ticket whose primary it was gets its next repo as the primary, with that repo's own branch,
      // base and PR. One with no other repo falls back to the project's, as a ticket without a repo does.
      const primaryOf = tx
        .select({ id: schema.tickets.id })
        .from(schema.tickets)
        .where(
          or(
            eq(schema.tickets.repoId, id),
            inArray(
              schema.tickets.id,
              tx
                .select({ id: schema.ticketRepos.ticketId })
                .from(schema.ticketRepos)
                .where(and(eq(schema.ticketRepos.repoId, id), eq(schema.ticketRepos.position, 0))),
            ),
          ),
        )
        .all()
      for (const t of primaryOf) {
        const next = tx
          .select()
          .from(schema.ticketRepos)
          .where(and(eq(schema.ticketRepos.ticketId, t.id), ne(schema.ticketRepos.repoId, id)))
          .orderBy(asc(schema.ticketRepos.position), asc(schema.ticketRepos.repoId))
          .get()
        if (!next) continue
        tx.update(schema.tickets)
          .set({
            repoId: next.repoId,
            branch: next.branch,
            baseBranch: next.baseBranch,
            prNumber: next.prNumber,
          })
          .where(eq(schema.tickets.id, t.id))
          .run()
        tx.update(schema.ticketRepos)
          .set({ position: 0 })
          .where(and(eq(schema.ticketRepos.ticketId, t.id), eq(schema.ticketRepos.repoId, next.repoId)))
          .run()
      }
      tx.delete(schema.repos).where(eq(schema.repos.id, id)).run()
    },
    { behavior: 'immediate' },
  )
  logActivity({ projectId: r.projectId, actor, kind: 'project', text: `removed repo ${r.name}` })
}
