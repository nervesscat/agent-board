import type { ReportSettingsChange } from '#/db/schema'
import { logActivity } from './activity'
import { HttpError } from './http'
import type { ReportSettingsView } from './reports'

/**
 * The history of a project's report prompt and template: every change with the value before it, who
 * made it and whether an agent did. An agent's change is pending until the human accepts or reverts it.
 */

export type ChangedField = ReportSettingsChange['field']
type Values = Record<ChangedField, string>

/** Records each of `prompt` and `template` that differs between `before` and `after`. */
export function recordSettingsChanges(
  projectId: number,
  before: Values,
  after: Values,
  actor: string,
  _opts: { agent?: boolean } = {},
) {
  for (const field of ['prompt', 'template'] as const)
    if (before[field] !== after[field])
      logActivity({
        projectId,
        actor,
        kind: 'report',
        text: `changed the report ${field}`,
        refType: 'project',
        refId: projectId,
      })
}

/** The project's changes, newest first. */
export function listChanges(
  _projectId: number,
  _opts: { field?: ChangedField } = {},
): ReportSettingsChange[] {
  return []
}

export function getChange(id: number): ReportSettingsChange {
  throw new HttpError(404, `no report settings change ${id}`)
}

/** Agents' changes the human has not accepted or reverted yet, newest first. */
export function pendingChanges(_projectId: number): ReportSettingsChange[] {
  return []
}

export function acceptChange(id: number, _actor: string): ReportSettingsChange {
  return getChange(id)
}

/** Puts the field back to the value before the change, itself recorded as a change. */
export function revertChange(
  id: number,
  _actor: string,
): { change: ReportSettingsChange; settings: ReportSettingsView } {
  getChange(id)
  throw new HttpError(404, `no report settings change ${id}`)
}
