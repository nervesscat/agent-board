import { asc, eq, inArray } from 'drizzle-orm'

import { db, schema } from '#/db'
import { autoPhaseOf, type AutoPhase } from '#/lib/autoPhases'
import type { WorkflowStepId } from '#/lib/workflow'
import { kindOf, listStages } from './stages'
import { ticketWorkflow } from './workflow'

/** The automatic phases that only a workflow step runs: a ticket whose workflow has no such step does not hold for it. */
const PHASE_STEP: Partial<Record<AutoPhase, WorkflowStepId>> = {
  Pushed: 'push',
  PR: 'pr',
  CI: 'ci',
  Preview: 'preview',
}

/**
 * What a ticket in review still has open, from its tasks: every task and subtask not done, of it and of
 * its lanes that are not cancelled (the rollup's scope), in tree order (the ticket's own tasks, then
 * each lane's, a lane before its own lanes). The Merged phases are left out: merging is the human's step
 * (except in Approved, where an orchestrator merges without asking again), done after the hand-off, so
 * listing them would keep this from ever being empty in review. `auto`: a
 * phase the board ticks itself (Pushed, PR, CI, Preview, Summary), which follows its fact, not a tick.
 */
export interface OpenTask {
  taskId: number
  /** The ticket the task is on: the ticket itself, or one of its lanes. */
  ticketId: number
  text: string
  auto: boolean
}

export function openTasks(ticketId: number): OpenTask[] {
  const t = db.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId)).get()
  if (!t) return []
  const stages = listStages(t.projectId)
  const all = db
    .select({
      id: schema.tickets.id,
      parentId: schema.tickets.parentId,
      status: schema.tickets.status,
      projectId: schema.tickets.projectId,
      complexity: schema.tickets.complexity,
      tags: schema.tickets.tags,
    })
    .from(schema.tickets)
    .where(eq(schema.tickets.projectId, t.projectId))
    .orderBy(asc(schema.tickets.id))
    .all()
  // A cancelled lane's tasks are no longer part of the work, and neither are its lanes'.
  const ids: number[] = []
  const walk = (id: number) => {
    ids.push(id)
    for (const lane of all)
      if (lane.parentId === id && kindOf(stages, lane.status) !== 'cancelled') walk(lane.id)
  }
  walk(t.id)
  const rows = db
    .select()
    .from(schema.tasks)
    .where(inArray(schema.tasks.ticketId, ids))
    .orderBy(asc(schema.tasks.position), asc(schema.tasks.id))
    .all()
  return ids.flatMap((id) => {
    const own = rows.filter((task) => task.ticketId === id)
    // Each ticket (a lane included) is held to the steps its own workflow runs.
    const row = all.find((x) => x.id === id)!
    const steps = new Set(ticketWorkflow(row).steps.map((step) => step.id))
    return own
      .filter((task) => !task.parentId)
      .flatMap((task) => [task, ...own.filter((sub) => sub.parentId === task.id)])
      .flatMap((task) => {
        const phase = autoPhaseOf(task)
        if (task.done || phase === 'Merged') return []
        if (phase && PHASE_STEP[phase] && !steps.has(PHASE_STEP[phase]!)) return []
        return [{ taskId: task.id, ticketId: id, text: task.text, auto: phase !== null }]
      })
  })
}
