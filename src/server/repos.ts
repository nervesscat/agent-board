import { asc, eq, inArray } from 'drizzle-orm'

import { db, schema } from '#/db'
import { logActivity } from './activity'
import { assertRepo, repoNameWithOwner } from './git'
import { HttpError, notFound } from './http'
import { forgetPreview } from './managedPreview'
import { createProject, getProject } from './projects'

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
  return listRepos(ticket.projectId)[0] ?? null
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
  return row
}

export async function updateRepo(
  id: number,
  patch: Partial<Pick<schema.Repo, 'name' | 'repoPath' | 'baseBranch' | 'projectId'>>,
  actor: string,
) {
  const before = getRepo(id)
  if (patch.projectId) getProject(patch.projectId)
  const set: Partial<schema.Repo> = { ...patch }
  const repath = !!patch.repoPath && patch.repoPath !== before.repoPath
  if (patch.repoPath && repath) {
    assertRepo(patch.repoPath)
    set.githubRepo = await repoNameWithOwner(patch.repoPath)
  }
  const moved = patch.projectId !== undefined && patch.projectId !== before.projectId
  const row = db.transaction((tx) => {
    const r = tx.update(schema.repos).set(set).where(eq(schema.repos.id, id)).returning().get()!
    // The repo's PRs, tickets and review results move with it; threads follow their parents.
    if (moved) {
      const to = { projectId: patch.projectId! }
      tx.update(schema.prs).set(to).where(eq(schema.prs.repoId, id)).run()
      tx.update(schema.tickets).set(to).where(eq(schema.tickets.repoId, id)).run()
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
  return row
}

export function deleteRepo(id: number, actor: string) {
  const r = getRepo(id)
  db.transaction((tx) => {
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
    tx.delete(schema.repos).where(eq(schema.repos.id, id)).run()
  })
  logActivity({ projectId: r.projectId, actor, kind: 'project', text: `removed repo ${r.name}` })
}
