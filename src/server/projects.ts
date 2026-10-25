import { asc, count, eq, isNull, type SQL } from 'drizzle-orm'
import { z } from 'zod'

import { db, schema } from '#/db'
import { LAYOUT_AREAS, LAYOUT_ELEMENTS, mergeLayout } from '#/lib/layout'
import { MAX_TAG_LENGTH, cleanSuggestions, usedTags } from '#/lib/tags'
import { logActivity } from './activity'
import { hostToolsForAgents } from './hostTools'
import { notFound } from './http'
import { listAgents } from './projectAgents'
import { listRepos } from './repos'
import { listStages } from './stages'

/**
 * The top-level phases a new ticket starts with when its project keeps no list of its own: the
 * implementation, then the hand-off's items in the order the work does them (push before the PR, CI
 * once the PR runs it, the preview, then the post). Each is the label of a hand-off check.
 */
export const BUILT_IN_PHASES: readonly string[] = [
  'Implementation',
  'Pushed',
  'PR',
  'CI',
  'Preview',
  'Hand-off post',
]

/**
 * A project as it is handed out: `defaultPhases` is the list in effect and `layout` the layout in
 * effect (what was saved merged with the elements there are now), never null.
 */
function withPhases<T extends Pick<schema.Project, 'defaultPhases' | 'layout'>>(p: T) {
  return { ...p, defaultPhases: p.defaultPhases ?? [...BUILT_IN_PHASES], layout: mergeLayout(p.layout) }
}

/** Projects with their repos and what they hold, for the top-bar menu and agents' `list_projects`. */
export function listProjects() {
  const repos = listRepos()
  // The features' count: a PR's own ticket is in the PR queue only.
  const tickets = countBy(schema.tickets.projectId, schema.tickets, isNull(schema.tickets.prId))
  const prs = countBy(schema.prs.projectId, schema.prs, eq(schema.prs.open, true))
  return db
    .select()
    .from(schema.projects)
    .orderBy(asc(schema.projects.name))
    .all()
    .map((p) => ({
      ...withPhases(p),
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
  return withPhases(p)
}

/**
 * The project plus its repos, its stages in board order and its agents (name, picture, instructions):
 * what agents read before working on it. `usedTags` are the tags its tickets carry (archived and lanes
 * too), most used first, each once in the casing used most: the ones to reuse. `hostTools` is the last
 check of the tools on this machine the board runs (null before the first one ends).
 */
export function getProjectFull(id: number) {
  return {
    ...getProject(id),
    usedTags: projectUsedTags(id),
    repos: listRepos(id),
    stages: listStages(id),
    agents: listAgents(id),
    hostTools: hostToolsForAgents(),
  }
}

function projectUsedTags(projectId: number) {
  const rows = db
    .select({ tags: schema.tickets.tags })
    .from(schema.tickets)
    .where(eq(schema.tickets.projectId, projectId))
    .orderBy(asc(schema.tickets.id))
    .all()
  return usedTags(rows.map((r) => r.tags))
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
  return withPhases(row)
}

/** The tags offered under every ticket's tags field, as REST and MCP take them; [] offers none of the project's own. */
export const TagSuggestions = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(MAX_TAG_LENGTH)
      .refine((t) => !t.includes(','), 'a tag cannot have a comma'),
  )
  .max(50)

/**
 * A project's layout as REST takes it: its elements in order, each with its area and whether it is
 * hidden. Ids and areas are checked as it is merged, not here: an id or an area the board no longer
 * knows is dropped or put back rather than refused. Null goes back to the defaults.
 */
export const LayoutBody = z
  .array(
    z.object({
      id: z.string().max(100),
      area: z.string().max(40),
      hidden: z.boolean().optional(),
    }),
  )
  .max(LAYOUT_ELEMENTS.length * LAYOUT_AREAS.length)
  .nullable()

/**
 * `defaultPhases`: the names trimmed, null for the built-in list again. `tagSuggestions`: trimmed,
 * blanks and repeats in any casing left out; [] stays empty. `stallMinutes`: how long an active ticket
 * may go without a work event before it reads as stalled (the caller checks the range). `layout`: kept
 * as it is in effect (`mergeLayout`: unknown ids dropped, locked elements shown), null for the defaults
 * again.
 */
export function updateProject(
  id: number,
  patch: Partial<
    Pick<
      schema.Project,
      'name' | 'instructions' | 'defaultPhases' | 'tagSuggestions' | 'stallMinutes' | 'layout'
    >
  >,
  actor: string,
) {
  getProject(id)
  const { defaultPhases, tagSuggestions, layout, ...rest } = patch
  const set = {
    ...rest,
    ...(defaultPhases !== undefined && { defaultPhases: defaultPhases?.map((name) => name.trim()) ?? null }),
    ...(tagSuggestions !== undefined && { tagSuggestions: cleanSuggestions(tagSuggestions) }),
    ...(layout !== undefined && { layout: layout && mergeLayout(layout) }),
  }
  const row = db.update(schema.projects).set(set).where(eq(schema.projects.id, id)).returning().get()!
  logActivity({
    projectId: id,
    actor,
    kind: 'project',
    text: `updated project ${row.name}`,
    refType: 'project',
    refId: id,
  })
  return withPhases(row)
}

export function deleteProject(id: number, actor: string) {
  const p = getProject(id)
  db.delete(schema.projects).where(eq(schema.projects.id, id)).run()
  logActivity({ projectId: null, actor, kind: 'project', text: `deleted project ${p.name}` })
}
