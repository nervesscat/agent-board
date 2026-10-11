import { and, desc, eq } from 'drizzle-orm'

import { db, schema } from '#/db'
import type { ReportSettingsChange } from '#/db/schema'
import { DEFAULT_REPORT_TEMPLATE, effectiveTemplate } from '#/lib/reportTemplate'
import { logActivity } from './activity'
import { HttpError } from './http'
import { getProject } from './projects'
import { getReportSettings, readReportSettings, type ReportSettingsView } from './reports'

/**
 * The history of a project's report prompt and template: every change with the value before it, who
 * made it and whether an agent did. An agent's change is pending until the human accepts or reverts it.
 * A template is kept as the one in force (the default spelled out), so the diff shows what it was.
 */

export type ChangedField = ReportSettingsChange['field']
type Values = Record<ChangedField, string>

const FIELDS = ['prompt', 'template'] as const
/** The value a field shows: the template in force rather than '' for the default. */
const shown = (field: ChangedField, stored: string) =>
  field === 'template' ? effectiveTemplate(stored) : stored

/** One change, kept and logged as a line of the project's activity that opens it. */
function record(
  projectId: number,
  field: ChangedField,
  oldValue: string,
  newValue: string,
  actor: string,
  agent: boolean,
  text: string,
): ReportSettingsChange {
  const change = db
    .insert(schema.reportSettingsChanges)
    .values({
      projectId,
      field,
      oldValue,
      newValue,
      changedBy: actor,
      byAgent: agent,
      state: agent ? 'pending' : 'accepted',
    })
    .returning()
    .get()
  logActivity({ projectId, actor, kind: 'report', text, refType: 'report-settings-change', refId: change.id })
  return change
}

/**
 * Records each of `prompt` and `template` that differs between `before` and `after` (the stored rows);
 * a change by an agent waits on the human. Run inside the transaction that saves `after`.
 */
export function recordSettingsChanges(
  projectId: number,
  before: Values,
  after: Values,
  actor: string,
  opts: { agent?: boolean } = {},
) {
  for (const field of FIELDS) {
    const oldValue = shown(field, before[field])
    const newValue = shown(field, after[field])
    if (oldValue !== newValue)
      record(projectId, field, oldValue, newValue, actor, Boolean(opts.agent), `changed the report ${field}`)
  }
}

const newestFirst = [desc(schema.reportSettingsChanges.createdAt), desc(schema.reportSettingsChanges.id)]

/** The project's changes, newest first; one field's with `field`. */
export function listChanges(projectId: number, opts: { field?: ChangedField } = {}): ReportSettingsChange[] {
  getProject(projectId)
  const where = [eq(schema.reportSettingsChanges.projectId, projectId)]
  if (opts.field) where.push(eq(schema.reportSettingsChanges.field, opts.field))
  return db
    .select()
    .from(schema.reportSettingsChanges)
    .where(and(...where))
    .orderBy(...newestFirst)
    .all()
}

export function getChange(id: number): ReportSettingsChange {
  const change = db
    .select()
    .from(schema.reportSettingsChanges)
    .where(eq(schema.reportSettingsChanges.id, id))
    .get()
  if (!change) throw new HttpError(404, `no report settings change ${id}`)
  return change
}

/** Agents' changes the human has not accepted or reverted yet, newest first. */
export function pendingChanges(projectId: number): ReportSettingsChange[] {
  return db
    .select()
    .from(schema.reportSettingsChanges)
    .where(
      and(
        eq(schema.reportSettingsChanges.projectId, projectId),
        eq(schema.reportSettingsChanges.state, 'pending'),
      ),
    )
    .orderBy(...newestFirst)
    .all()
}

function settle(id: number, state: 'accepted' | 'reverted', actor: string) {
  return db
    .update(schema.reportSettingsChanges)
    .set({ state, resolvedBy: actor, resolvedAt: new Date().toISOString() })
    .where(eq(schema.reportSettingsChanges.id, id))
    .returning()
    .get()!
}

/** Keeps the change. An agent's pending one stops waiting on the human; a reverted one cannot be. */
export function acceptChange(id: number, actor: string): ReportSettingsChange {
  const change = getChange(id)
  if (change.state === 'reverted') throw new HttpError(409, 'this change was reverted')
  if (change.state === 'accepted') return change
  return settle(id, 'accepted', actor)
}

/**
 * Puts the field back to the value before the change, itself recorded as a change (by `actor`, not
 * pending). Only while the field still holds what the change set: after a later change of it, that one
 * is reverted first (409).
 */
export function revertChange(
  id: number,
  actor: string,
): { change: ReportSettingsChange; settings: ReportSettingsView } {
  const change = getChange(id)
  if (change.state === 'reverted') throw new HttpError(409, 'this change was already reverted')
  const { field, projectId } = change
  const row = readReportSettings(projectId)
  if (shown(field, row[field]) !== change.newValue)
    throw new HttpError(
      409,
      `the report ${field} changed again since: revert the later change first, or edit it in the report settings`,
    )

  // The default template is kept as '', so it goes on following the board's default.
  const value = field === 'template' && change.oldValue === DEFAULT_REPORT_TEMPLATE ? '' : change.oldValue
  const reverted = db.transaction(() => {
    db.update(schema.reportSettings)
      .set({ [field]: value, updatedBy: actor, updatedAt: new Date().toISOString() })
      .where(eq(schema.reportSettings.projectId, projectId))
      .run()
    const done = settle(id, 'reverted', actor)
    const by = change.changedBy === actor ? 'their own' : `${change.changedBy}'s`
    record(
      projectId,
      field,
      change.newValue,
      change.oldValue,
      actor,
      false,
      `reverted ${by} change of the report ${field}`,
    )
    return done
  })
  return { change: reverted, settings: getReportSettings(projectId) }
}
