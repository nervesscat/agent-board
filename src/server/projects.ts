import { asc, count, eq, type SQL } from 'drizzle-orm'

import { db, schema } from '#/db'
import { logActivity } from './activity'
import { notFound } from './http'
import { listRepos } from './repos'
import { listStages } from './stages'

/** Projects with their repos and what they hold, for the top-bar menu and agents' `list_projects`. */
export function listProjects() {
  const repos = listRepos()
  const tickets = countBy(schema.tickets.projectId, schema.tickets)
  const prs = countBy(schema.prs.projectId, schema.prs, eq(schema.prs.open, true))
  return db
    .select()
    .from(schema.projects)
    .orderBy(asc(schema.projects.name))
    .all()
    .map((p) => ({
      ...p,
      repos: repos.filter((r) => r.projectId === p.id),
      counts: { tickets: tickets.get(p.id) ?? 0, openPrs: prs.get(p.id) ?? 0 },
    }))
}

function countBy(
  column: typeof schema.tickets.projectId | typeof schema.prs.projectId,
  table: typeof schema.tickets | typeof schema.prs,
  where?: SQL,
) {
  const q = db.select({ projectId: column, n: count() }).from(table)
  const rows = (where ? q.where(where) : q).groupBy(column).all()
  return new Map(rows.map((r) => [r.projectId, r.n]))
}

export function getProject(id: number) {
  const p = db.select().from(schema.projects).where(eq(schema.projects.id, id)).get()
  if (!p) throw notFound('project')
  return p
}

/** The project plus its repos and its stages in board order: what agents read before working on it. */
export function getProjectFull(id: number) {
  return { ...getProject(id), repos: listRepos(id), stages: listStages(id) }
}

export type ProjectFull = ReturnType<typeof getProjectFull>

export function createProject(input: { name: string; instructions?: string }, actor: string) {
  const row = db
    .insert(schema.projects)
    .values({ name: input.name, instructions: input.instructions || '' })
    .returning()
    .get()
  logActivity({
    projectId: row.id,
    actor,
    kind: 'project',
    text: `created project ${row.name}`,
    refType: 'project',
    refId: row.id,
  })
  return row
}

export function updateProject(
  id: number,
  patch: Partial<Pick<schema.Project, 'name' | 'instructions'>>,
  actor: string,
) {
  getProject(id)
  const row = db.update(schema.projects).set(patch).where(eq(schema.projects.id, id)).returning().get()!
  logActivity({
    projectId: id,
    actor,
    kind: 'project',
    text: `updated project ${row.name}`,
    refType: 'project',
    refId: id,
  })
  return row
}

export function deleteProject(id: number, actor: string) {
  const p = getProject(id)
  db.delete(schema.projects).where(eq(schema.projects.id, id)).run()
  logActivity({ projectId: null, actor, kind: 'project', text: `deleted project ${p.name}` })
}
