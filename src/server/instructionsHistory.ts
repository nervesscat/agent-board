import { and, desc, eq, gt, isNull, ne } from 'drizzle-orm'

import { db, schema } from '#/db'
import type { ProjectInstructionChange } from '#/db/schema'
import type { ActorRole } from './actors'
import { logActivity } from './activity'
import { HttpError, notFound } from './http'

/**
 * The history of a project's instructions, the text every agent follows on it (get_project). Only the
 * human and an orchestrator change it; a worker (a worker token, or any sub-identity) is refused. Every
 * change is kept with the text before it, who made it and their role, and applies at once. An
 * orchestrator's change stays pending, in the human's Needs you, until they mark it reviewed or revert
 * it; a revert is itself a change, pointing at the one it undid.
 */

/** Who changes the instructions: the full name (a sub-identity's included) and its role. */
export interface Changer {
  name: string
  role: ActorRole
}

/** What a worker hears: the one who may change them is its orchestrator, or the human. */
export const workerRefusal = (name: string) =>
  `only an orchestrator or the human changes the project's instructions: ask your orchestrator (you are ${name}, a worker)`

/** Refuses a worker, before anything is read or written. */
export function assertMayChangeInstructions(who: Changer) {
  if (who.role !== 'human' && who.role !== 'orchestrator') throw new HttpError(403, workerRefusal(who.name))
}

function readInstructions(projectId: number): string {
  const row = db
    .select({ instructions: schema.projects.instructions })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .get()
  if (!row) throw notFound('project')
  return row.instructions
}

/** One change, kept and logged as a line of the project's activity that points at it. */
function record(
  projectId: number,
  oldValue: string,
  newValue: string,
  who: Changer,
  text: string,
  revertOf: number | null = null,
): ProjectInstructionChange {
  const orchestrator = who.role === 'orchestrator'
  const change = db
    .insert(schema.projectInstructionChanges)
    .values({
      projectId,
      oldValue,
      newValue,
      changedBy: who.name,
      role: orchestrator ? 'orchestrator' : 'human',
      state: orchestrator ? 'pending' : 'accepted',
      revertOf,
    })
    .returning()
    .get()
  logActivity({
    projectId,
    actor: who.name,
    kind: 'project',
    text,
    refType: 'instruction-change',
    refId: change.id,
  })
  return change
}

/**
 * Replaces the project's instructions with `text`, at once, and records the change. The same text again
 * records nothing (`change: null`). A worker gets 403 and nothing changes.
 */
export function setInstructions(
  projectId: number,
  text: string,
  who: Changer,
): { instructions: string; change: ProjectInstructionChange | null } {
  assertMayChangeInstructions(who)
  return db.transaction(() => {
    const before = readInstructions(projectId)
    if (before === text) return { instructions: before, change: null }
    db.update(schema.projects).set({ instructions: text }).where(eq(schema.projects.id, projectId)).run()
    return {
      instructions: text,
      change: record(projectId, before, text, who, 'changed the project instructions'),
    }
  })
}

const t = schema.projectInstructionChanges
const newestFirst = [desc(t.createdAt), desc(t.id)]

/** The project's changes, newest first, each with whether the human can revert it now. */
export function listInstructionChanges(projectId: number): PendingInstructionChange[] {
  const current = readInstructions(projectId)
  return db
    .select()
    .from(t)
    .where(eq(t.projectId, projectId))
    .orderBy(...newestFirst)
    .all()
    .map((change) => ({
      ...change,
      revertable: change.state !== 'reverted' && !revertRefused(change, current),
    }))
}

export function getInstructionChange(id: number): ProjectInstructionChange {
  const change = db.select().from(t).where(eq(t.id, id)).get()
  if (!change) throw new HttpError(404, `no instructions change ${id}`)
  return change
}

/** A change, and whether the human can revert it now. */
export interface PendingInstructionChange extends ProjectInstructionChange {
  revertable: boolean
}

/** Orchestrators' changes the human has not reviewed or reverted yet, newest first. */
export function pendingInstructionChanges(projectId: number): PendingInstructionChange[] {
  const current = readInstructions(projectId)
  return db
    .select()
    .from(t)
    .where(and(eq(t.projectId, projectId), eq(t.state, 'pending')))
    .orderBy(...newestFirst)
    .all()
    .map((change) => ({ ...change, revertable: !revertRefused(change, current) }))
}

/**
 * Why the change cannot be reverted now, or null when it can: a later change stands (one not reverted
 * since, the record of a revert aside), or the instructions hold something else than it set.
 */
function revertRefused(change: ProjectInstructionChange, current: string): string | null {
  const later = db
    .select({ id: t.id })
    .from(t)
    .where(
      and(
        eq(t.projectId, change.projectId),
        gt(t.id, change.id),
        ne(t.state, 'reverted'),
        isNull(t.revertOf),
      ),
    )
    .get()
  if (later || current !== change.newValue)
    return 'the instructions changed again since: revert the later change first, or edit them in the project settings'
  return null
}

function settle(id: number, state: 'accepted' | 'reverted', actor: string) {
  return db
    .update(t)
    .set({ state, resolvedBy: actor, resolvedAt: new Date().toISOString() })
    .where(eq(t.id, id))
    .returning()
    .get()!
}

/** The human read it and keeps it: a pending change stops waiting on them; a reverted one cannot be. */
export function reviewInstructionChange(id: number, actor: string): ProjectInstructionChange {
  const change = getInstructionChange(id)
  if (change.state === 'reverted') throw new HttpError(409, 'this change was reverted')
  if (change.state === 'accepted') return change
  return settle(id, 'accepted', actor)
}

/**
 * Puts the instructions back to the text before the change, itself recorded as the human's change
 * (accepted, pointing at the change it reverts). Only while no later change stands and the instructions
 * still hold what the change set (409 otherwise), so changes are undone newest first.
 */
export function revertInstructionChange(
  id: number,
  actor: string,
): { change: ProjectInstructionChange; revert: ProjectInstructionChange; instructions: string } {
  const change = getInstructionChange(id)
  if (change.state === 'reverted') throw new HttpError(409, 'this change was already reverted')
  return db.transaction(() => {
    const refused = revertRefused(change, readInstructions(change.projectId))
    if (refused) throw new HttpError(409, refused)
    db.update(schema.projects)
      .set({ instructions: change.oldValue })
      .where(eq(schema.projects.id, change.projectId))
      .run()
    const done = settle(id, 'reverted', actor)
    const by = change.changedBy === actor ? 'their own' : `${change.changedBy}'s`
    const revert = record(
      change.projectId,
      change.newValue,
      change.oldValue,
      { name: actor, role: 'human' },
      `reverted ${by} change of the project instructions`,
      id,
    )
    return { change: done, revert, instructions: change.oldValue }
  })
}
