import { and, asc, desc, eq, gte, lt } from 'drizzle-orm'

import { db, schema } from '#/db'

export interface ActivityInput {
  projectId: number | null
  actor: string
  kind: string
  text: string
  refType?: string
  refId?: number | null
}

/** Every write records one line here; the Daily module is built from these. */
export function logActivity(a: ActivityInput) {
  db.insert(schema.activity)
    .values({
      projectId: a.projectId,
      actor: a.actor,
      kind: a.kind,
      text: a.text,
      refType: a.refType ?? '',
      refId: a.refId ?? null,
    })
    .run()
}

/** A day is a local calendar day; rows are stored in UTC, so the bounds are converted here. */
export function dayBounds(date: string): { from: string; to: string } {
  const start = new Date(`${date}T00:00:00`)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return { from: start.toISOString(), to: end.toISOString() }
}

export function listActivity(date: string, projectId?: number) {
  const { from, to } = dayBounds(date)
  const where = [gte(schema.activity.createdAt, from), lt(schema.activity.createdAt, to)]
  if (projectId) where.push(eq(schema.activity.projectId, projectId))
  return db
    .select()
    .from(schema.activity)
    .where(and(...where))
    .orderBy(asc(schema.activity.createdAt))
    .all()
}

export function listSummaries(date: string, projectId?: number) {
  const where = [eq(schema.dailySummaries.date, date)]
  if (projectId) where.push(eq(schema.dailySummaries.projectId, projectId))
  return db
    .select()
    .from(schema.dailySummaries)
    .where(and(...where))
    .orderBy(desc(schema.dailySummaries.createdAt))
    .all()
}

export function addSummary(input: { projectId: number | null; date: string; author: string; body: string }) {
  const row = db.insert(schema.dailySummaries).values(input).returning().get()
  logActivity({
    projectId: input.projectId,
    actor: input.author,
    kind: 'summary',
    text: `posted the daily summary for ${input.date}`,
    refType: 'summary',
    refId: row.id,
  })
  return row
}
