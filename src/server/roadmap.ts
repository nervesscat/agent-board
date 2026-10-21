import { asc, inArray } from 'drizzle-orm'

import { db, schema } from '#/db'
import type { StepTask } from '#/lib/roadmap'
import { listTickets, laneTree } from './features'
import { kindOf, listStages } from './stages'

/** The kinds of stage a top-level ticket is in to show on the roadmap: being worked or waiting. */
const SHOWN = new Set(['active', 'blocked', 'review'])

/** One row on the roadmap: a ticket or a lane, with its tasks in tree order. */
export type RoadmapRow = {
  id: number
  title: string
  assignee: string
  status: string
  branch: string
  updatedAt: string
  tasks: StepTask[]
}

/** A top-level ticket with its lanes (theirs too, nearest first, each with its depth under it). */
export type RoadmapTicket = RoadmapRow & { lanes: (RoadmapRow & { depth: number })[] }

/**
 * The project's roadmap: every top-level ticket in an active, blocked or review stage (archived and
 * PR tickets left out), last updated first, each with its tasks and its lanes' that are not cancelled.
 * Read-only, one pass over the project.
 */
export function roadmap(projectId: number): RoadmapTicket[] {
  const stages = listStages(projectId)
  const all = listTickets(projectId)
  const roots = all.filter((t) => t.parentId === null && SHOWN.has(kindOf(stages, t.status)))
  const byId = new Map(all.map((x) => [x.id, x]))
  const lanesOf = new Map(
    roots.map((t) => {
      const depth = (id: number) => {
        let d = 0
        for (let p = byId.get(id)?.parentId; p && p !== t.id; p = byId.get(p)?.parentId) d++
        return d
      }
      const lanes = laneTree(all, t.id)
        .filter((l) => kindOf(stages, l.status) !== 'cancelled')
        .map((l) => ({ lane: l, depth: depth(l.id) }))
      return [t.id, lanes] as const
    }),
  )
  const ids = [...roots.map((t) => t.id), ...[...lanesOf.values()].flat().map((l) => l.lane.id)]
  const rows = ids.length
    ? db
        .select()
        .from(schema.tasks)
        .where(inArray(schema.tasks.ticketId, ids))
        .orderBy(asc(schema.tasks.position), asc(schema.tasks.id))
        .all()
    : []
  const tasksOf = (ticketId: number): StepTask[] => {
    const own = rows.filter((r) => r.ticketId === ticketId)
    return own
      .filter((r) => !r.parentId)
      .flatMap((r) => [r, ...own.filter((sub) => sub.parentId === r.id)])
      .map(({ id, parentId, text, done, blocked, blockedReason }) => ({
        id,
        parentId,
        text,
        done,
        blocked,
        blockedReason,
      }))
  }
  const row = (t: (typeof all)[number]): RoadmapRow => ({
    id: t.id,
    title: t.title,
    assignee: t.assignee,
    status: t.status,
    branch: t.branch,
    updatedAt: t.updatedAt,
    tasks: tasksOf(t.id),
  })
  return roots.map((t) => ({
    ...row(t),
    lanes: (lanesOf.get(t.id) ?? []).map(({ lane, depth }) => ({ ...row(lane), depth })),
  }))
}
