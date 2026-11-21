import { and, eq } from 'drizzle-orm'

import { db, schema } from '#/db'
import { HttpError, notFound } from '../http'
import { getProject, listProjects } from '../projects'
import { visibleAlerts } from './feed'
import {
  allAlertTypes,
  applies,
  findAlertType,
  snoozeOptionsOf,
  type AlertActionResult,
  type AlertButton,
  type AlertGroup,
} from './registry'

/**
 * What the human does with alerts: see, dismiss, snooze, press a button, mute a kind in a project. Only
 * the human does any of it; an agent gets 403, as it does for dismissing a card.
 */

export interface AlertCaller {
  agent: boolean
}

const human = (caller: AlertCaller) => {
  if (caller.agent) throw new HttpError(403, 'only the human acts on a notification')
}

function rowOf(alertId: number) {
  const row = db.select().from(schema.alerts).where(eq(schema.alerts.id, alertId)).get()
  if (!row) throw notFound('alert')
  return row
}

const touch = (alertId: number, set: Partial<schema.AlertRow>) =>
  db.update(schema.alerts).set(set).where(eq(schema.alerts.id, alertId)).run()

export function markSeen(caller: AlertCaller, alertId: number, at = Date.now()) {
  human(caller)
  const row = rowOf(alertId)
  if (row.seenAt === null) touch(alertId, { seenAt: new Date(at).toISOString() })
}

/** Marks every alert on show in the project seen; answers how many were new. */
export function markProjectSeen(caller: AlertCaller, projectId: number, at = Date.now()) {
  human(caller)
  getProject(projectId)
  const unseen = visibleAlerts(projectId, at).filter(({ row }) => row.seenAt === null)
  for (const { row } of unseen) touch(row.id, { seenAt: new Date(at).toISOString() })
  return { seen: unseen.length }
}

export function dismissAlert(caller: AlertCaller, alertId: number, at = Date.now()) {
  human(caller)
  const row = rowOf(alertId)
  const type = findAlertType(row.type)
  if (type && type.dismissible === false) throw new HttpError(409, 'this alert cannot be dismissed')
  touch(alertId, { dismissedAt: new Date(at).toISOString() })
}

export function snoozeAlert(caller: AlertCaller, alertId: number, ms: number, at = Date.now()) {
  human(caller)
  const row = rowOf(alertId)
  const type = findAlertType(row.type)
  const options = type ? snoozeOptionsOf(type) : []
  if (!options.includes(ms)) throw new HttpError(400, `ms must be one of ${options.join(', ')}`)
  const until = new Date(at + ms).toISOString()
  touch(alertId, { snoozedUntil: until })
  return { snoozedUntil: until }
}

/** Runs the handler behind one of the alert's buttons of kind action. */
export async function runAlertAction(
  caller: AlertCaller,
  alertId: number,
  buttonId: string,
  now: () => number = Date.now,
) {
  human(caller)
  const row = rowOf(alertId)
  const type = findAlertType(row.type)
  if (!type || row.resolvedAt) throw notFound('alert')
  const buttons = JSON.parse(row.buttons) as AlertButton[]
  const button = buttons.find((b) => b.id === buttonId && b.kind === 'action')
  const handler = type.actions?.[buttonId]
  if (!button || !handler) throw notFound('button')
  let result: AlertActionResult | void
  try {
    result = await handler({
      projectId: row.projectId,
      now,
      projects: {
        list: () => listProjects(),
        get: (id) => {
          try {
            return getProject(id)
          } catch {
            return undefined
          }
        },
      },
      alert: {
        id: row.id,
        type: row.type,
        subject: row.subject,
        projectId: row.projectId,
        data: JSON.parse(row.data) as Record<string, unknown>,
      },
    })
  } catch (err) {
    if (err instanceof HttpError) throw err
    throw new HttpError(500, err instanceof Error ? err.message : 'the action failed')
  }
  const resolve = result?.resolve === true
  if (resolve) touch(alertId, { resolvedAt: new Date(now()).toISOString() })
  return { ok: true, message: result?.message ?? null, resolved: resolve }
}

export interface AlertTypeView {
  type: string
  idea: number
  group: AlertGroup
  label: string
  description: string
  scope: 'project' | 'board'
  /** Muted in this project. */
  muted: boolean
  applies: boolean
}

/** Every type with whether this project muted it. */
export function alertTypesOf(projectId: number): AlertTypeView[] {
  getProject(projectId)
  const muted = new Set(
    db
      .select()
      .from(schema.alertMutes)
      .where(eq(schema.alertMutes.projectId, projectId))
      .all()
      .map((m) => m.type),
  )
  return allAlertTypes().map((t) => ({
    type: t.type,
    idea: t.idea,
    group: t.group,
    label: t.label,
    description: t.description,
    scope: t.scope,
    muted: muted.has(t.type),
    applies: applies(t),
  }))
}

export function muteType(caller: AlertCaller, projectId: number, type: string) {
  human(caller)
  getProject(projectId)
  if (!findAlertType(type)) throw notFound('alert type')
  db.insert(schema.alertMutes).values({ projectId, type }).onConflictDoNothing().run()
}

export function unmuteType(caller: AlertCaller, projectId: number, type: string) {
  human(caller)
  getProject(projectId)
  db.delete(schema.alertMutes)
    .where(and(eq(schema.alertMutes.projectId, projectId), eq(schema.alertMutes.type, type)))
    .run()
}
