import { and, asc, eq, max, min } from 'drizzle-orm'

import { db, schema } from '#/db'
import type { Caller } from './auth'
import { HttpError, notFound } from './http'

/**
 * A project's notes: the short facts the human and every agent must not rediscover (a command, a path,
 * a rule, a reminder). Each note is one fact, a label saying why it is there and a plain-text body, kept
 * to a few lines by the limits below. The human and any agent of the project add them; a note's author,
 * an orchestrator and the human change or remove it. `position` orders them, lowest first and ties by
 * id; a pinned note has a negative position, and a new note goes after the last one.
 */

export type ProjectNote = schema.ProjectNote

/** The longest a note's label and body may be, after trimming. */
export const NOTE_LABEL_MAX = 60
export const NOTE_BODY_MAX = 500

export interface NoteInput {
  label?: string
  body?: string
  /** Put the note above the others, or back after the unpinned ones. */
  pinned?: boolean
}

/** A note's label or body, trimmed and held to its limit: a blank or too long text writes nothing. */
function text(value: string, field: 'label' | 'body', limit: number): string {
  const trimmed = value.trim()
  if (!trimmed) throw new HttpError(400, `${field} is 1 to ${limit} characters`)
  if (trimmed.length > limit) throw new HttpError(400, `${field} is at most ${limit} characters`)
  return trimmed
}

/** The note as the caller may see it: only one of this project's. Anything else is not there. */
function noteOf(projectId: number, noteId: number): ProjectNote {
  const note = db
    .select()
    .from(schema.projectNotes)
    .where(and(eq(schema.projectNotes.id, noteId), eq(schema.projectNotes.projectId, projectId)))
    .get()
  if (!note) throw notFound('note')
  return note
}

const mayWrite = (note: ProjectNote, caller: Pick<Caller, 'name' | 'role'>) =>
  caller.role === 'human' || caller.role === 'orchestrator' || note.createdBy === caller.name

function assertProject(projectId: number) {
  const project = db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .get()
  if (!project) throw notFound('project')
}

/** The project's notes, in position order (a pinned one first; ties by id). */
export function listNotes(projectId: number): ProjectNote[] {
  assertProject(projectId)
  return db
    .select()
    .from(schema.projectNotes)
    .where(eq(schema.projectNotes.projectId, projectId))
    .orderBy(asc(schema.projectNotes.position), asc(schema.projectNotes.id))
    .all()
}

/** Where a new note goes: after the last one, or 0 when the project has none. */
function lastPosition(projectId: number) {
  const row = db
    .select({ last: max(schema.projectNotes.position) })
    .from(schema.projectNotes)
    .where(eq(schema.projectNotes.projectId, projectId))
    .get()
  return (row?.last ?? -1) + 1
}

export function createNote(
  projectId: number,
  input: NoteInput,
  caller: Pick<Caller, 'name' | 'role'>,
): ProjectNote {
  assertProject(projectId)
  const label = text(input.label ?? '', 'label', NOTE_LABEL_MAX)
  const body = text(input.body ?? '', 'body', NOTE_BODY_MAX)
  const row = db
    .insert(schema.projectNotes)
    .values({ projectId, label, body, createdBy: caller.name, position: lastPosition(projectId) })
    .returning()
    .get()
  return row
}

/** A later stamp than the one before, also when a write lands in the same millisecond. */
function nextStamp(before: string) {
  const now = Date.now()
  const last = Date.parse(before)
  return new Date(Number.isFinite(last) && now <= last ? last + 1 : now).toISOString()
}

export function updateNote(
  projectId: number,
  noteId: number,
  input: NoteInput,
  caller: Pick<Caller, 'name' | 'role'>,
): ProjectNote {
  const before = noteOf(projectId, noteId)
  if (!mayWrite(before, caller))
    throw new HttpError(403, "only the note's author, an orchestrator or the human changes a note")
  const label = input.label === undefined ? before.label : text(input.label, 'label', NOTE_LABEL_MAX)
  const body = input.body === undefined ? before.body : text(input.body, 'body', NOTE_BODY_MAX)
  const pinned = input.pinned
  let position = before.position
  if (pinned === true && position >= 0) {
    const row = db
      .select({ first: min(schema.projectNotes.position) })
      .from(schema.projectNotes)
      .where(eq(schema.projectNotes.projectId, projectId))
      .get()
    // Always below zero, even when the lowest note is already above it: a pin must read as a pin.
    position = Math.min(row?.first ?? 0, 0) - 1
  } else if (pinned === false && position < 0) {
    // Back among the unpinned notes: never below zero, even when the pinned ones sit deeper.
    position = Math.max(lastPosition(projectId), 0)
  }
  const row = db
    .update(schema.projectNotes)
    .set({ label, body, position, updatedAt: nextStamp(before.updatedAt) })
    .where(eq(schema.projectNotes.id, before.id))
    .returning()
    .get()!
  return row
}

export function deleteNote(
  projectId: number,
  noteId: number,
  caller: Pick<Caller, 'name' | 'role'>,
): ProjectNote {
  const note = noteOf(projectId, noteId)
  if (!mayWrite(note, caller))
    throw new HttpError(403, "only the note's author, an orchestrator or the human deletes a note")
  db.delete(schema.projectNotes).where(eq(schema.projectNotes.id, note.id)).run()
  return note
}
