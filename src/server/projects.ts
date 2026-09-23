import { asc, eq } from 'drizzle-orm'

import { db, schema } from '#/db'
import { logActivity } from './activity'
import { notFound } from './http'
import { listRepos } from './repos'

/** Projects with their repos, for the top-bar selector and agents' `list_projects`. */
export function listProjects() {
  const repos = listRepos()
  return db
    .select()
    .from(schema.projects)
    .orderBy(asc(schema.projects.name))
    .all()
    .map((p) => ({ ...p, repos: repos.filter((r) => r.projectId === p.id) }))
}

export function getProject(id: number) {
  const p = db.select().from(schema.projects).where(eq(schema.projects.id, id)).get()
  if (!p) throw notFound('project')
  return p
}

/** The project plus its repos: what agents read before working on it. */
export function getProjectFull(id: number) {
  return { ...getProject(id), repos: listRepos(id) }
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
