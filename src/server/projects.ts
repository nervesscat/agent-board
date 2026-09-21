import { asc, eq } from 'drizzle-orm'

import { db, schema } from '#/db'
import { logActivity } from './activity'
import { assertRepo, repoNameWithOwner } from './git'
import { notFound } from './http'

export const listProjects = () => db.select().from(schema.projects).orderBy(asc(schema.projects.name)).all()

export function getProject(id: number) {
  const p = db.select().from(schema.projects).where(eq(schema.projects.id, id)).get()
  if (!p) throw notFound('project')
  return p
}

export async function createProject(
  input: { name: string; repoPath: string; baseBranch?: string; instructions?: string },
  actor: string,
) {
  assertRepo(input.repoPath)
  const githubRepo = await repoNameWithOwner(input.repoPath)
  const row = db
    .insert(schema.projects)
    .values({
      name: input.name,
      repoPath: input.repoPath,
      githubRepo,
      baseBranch: input.baseBranch || 'main',
      instructions: input.instructions || '',
    })
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
  patch: Partial<Pick<schema.Project, 'name' | 'baseBranch' | 'instructions' | 'repoPath'>>,
  actor: string,
) {
  getProject(id)
  if (patch.repoPath) assertRepo(patch.repoPath)
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
