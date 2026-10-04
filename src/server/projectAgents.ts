import { and, asc, eq } from 'drizzle-orm'

import { db, schema } from '#/db'
import { logActivity } from './activity'
import { listActors } from './actors'
import { HttpError, notFound } from './http'
import { getProject } from './projects'
import { attachmentUrl, getAttachment } from './uploads'

/**
 * A project's agents: personas the human defines (name, picture, instructions). A connected agent (a
 * gate token, the orchestrator) works a ticket reserved for one by briefing a subagent with its
 * instructions, and posts the work under its name with `as`.
 */

export type ProjectAgent = ReturnType<typeof view>

/** Letters, digits, `-` and `_`, so `@name` in a thread can be told apart from the text around it. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/

const view = (a: schema.Agent) => ({ ...a, avatarUrl: a.avatarId ? attachmentUrl({ id: a.avatarId }) : null })

export function listAgents(projectId: number) {
  return db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.projectId, projectId))
    .orderBy(asc(schema.agents.name))
    .all()
    .map(view)
}

export function getAgent(id: number) {
  const a = db.select().from(schema.agents).where(eq(schema.agents.id, id)).get()
  if (!a) throw notFound('agent')
  return view(a)
}

/** The project's agent with this name, any casing; null when the name is not one of them. */
export function findAgent(projectId: number, name: string) {
  const n = name.trim().toLowerCase()
  return n ? (listAgents(projectId).find((a) => a.name.toLowerCase() === n) ?? null) : null
}

/** The agent a connected agent wants to speak as: it must be one of the project's. */
export function actingAs(projectId: number, name: string) {
  const agent = findAgent(projectId, name)
  if (!agent)
    throw new HttpError(400, `"${name}" is not one of this project's agents; get_project lists them`)
  return agent
}

/** `@name` mentions in a body, lowercased, each once. */
export function mentions(body: string): string[] {
  return [
    ...new Set([...body.matchAll(/(?<![\w@])@([A-Za-z0-9][A-Za-z0-9_-]*)/g)].map((m) => m[1]!.toLowerCase())),
  ]
}

function checkName(projectId: number, name: string, self?: number) {
  if (!NAME.test(name))
    throw new HttpError(400, 'a name is 1–40 letters, digits, - or _, starting with a letter or digit')
  const n = name.toLowerCase()
  if (listAgents(projectId).some((a) => a.id !== self && a.name.toLowerCase() === n))
    throw new HttpError(409, `this project already has an agent called ${name}`)
  // A gate token or the human with the same name would make every assignee and author ambiguous.
  if (listActors().some((a) => a.name.toLowerCase() === n))
    throw new HttpError(409, `${name} already signs in to the board; pick another name`)
}

function checkAvatar(avatarId: number | null | undefined) {
  if (!avatarId) return
  const a = getAttachment(avatarId)
  if (!a.mime.startsWith('image/')) throw new HttpError(400, 'the picture must be an image')
}

export function createAgent(
  projectId: number,
  input: { name: string; instructions?: string; delegation?: string; avatarId?: number | null },
  actor: string,
) {
  getProject(projectId)
  const name = input.name.trim()
  checkName(projectId, name)
  checkAvatar(input.avatarId)
  const row = db
    .insert(schema.agents)
    .values({
      projectId,
      name,
      instructions: input.instructions ?? '',
      delegation: input.delegation ?? '',
      avatarId: input.avatarId ?? null,
      createdBy: actor,
    })
    .returning()
    .get()
  logActivity({
    projectId,
    actor,
    kind: 'agent',
    text: `added agent ${name}`,
    refType: 'agent',
    refId: row.id,
  })
  return view(row)
}

/** A rename carries the tickets reserved for the agent along; past updates keep the name they were posted under. */
export function updateAgent(
  id: number,
  patch: { name?: string; instructions?: string; delegation?: string; avatarId?: number | null },
  actor: string,
) {
  const before = getAgent(id)
  const name = patch.name?.trim()
  if (name !== undefined && name !== before.name) checkName(before.projectId, name, id)
  checkAvatar(patch.avatarId)
  const row = db
    .update(schema.agents)
    .set({ ...patch, ...(name !== undefined ? { name } : {}), updatedAt: new Date().toISOString() })
    .where(eq(schema.agents.id, id))
    .returning()
    .get()!
  if (name && name !== before.name)
    db.update(schema.tickets)
      .set({ assignee: name })
      .where(and(eq(schema.tickets.projectId, before.projectId), eq(schema.tickets.assignee, before.name)))
      .run()
  logActivity({
    projectId: before.projectId,
    actor,
    kind: 'agent',
    text:
      name && name !== before.name ? `renamed agent ${before.name} to ${name}` : `updated agent ${row.name}`,
    refType: 'agent',
    refId: id,
  })
  return view(row)
}

/** Its reserved tickets go back to being shared and unassigned. */
export function deleteAgent(id: number, actor: string) {
  const a = getAgent(id)
  db.update(schema.tickets)
    .set({ assignee: '' })
    .where(and(eq(schema.tickets.projectId, a.projectId), eq(schema.tickets.assignee, a.name)))
    .run()
  db.delete(schema.agents).where(eq(schema.agents.id, id)).run()
  logActivity({ projectId: a.projectId, actor, kind: 'agent', text: `removed agent ${a.name}` })
}
