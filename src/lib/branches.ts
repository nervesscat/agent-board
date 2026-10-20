/** Where one task stands on a branch's timeline. */
export type StepState = 'done' | 'now' | 'next' | 'later' | 'blocked'

/** What the timeline needs of a task, in the ticket's tree order (each task, then its subtasks). */
export type StepTask = {
  id: number
  parentId: number | null
  text: string
  done: boolean
  blocked: boolean
  blockedReason: string
}

export type Step = StepTask & { state: StepState }

/** A run of steps: a task's subtasks under its name, or a task without subtasks on its own. */
export type StepGroup = { caption: string | null; steps: Step[] }

/**
 * The timeline of one ticket's tasks, left to right: a task with subtasks is shown as its subtasks
 * under its name, a task without as itself. Done steps are done; the first open one is where the
 * branch is now (blocked when it waits on the human), the open one after it is next, the rest later.
 * An open step tagged blocked stays blocked wherever it is.
 */
export function timeline(tasks: StepTask[]): StepGroup[] {
  const parents = new Set(tasks.flatMap((t) => (t.parentId ? [t.parentId] : [])))
  const groups: StepGroup[] = []
  for (const t of tasks) {
    if (t.parentId === null && parents.has(t.id)) groups.push({ caption: t.text, steps: [] })
    else if (t.parentId === null) groups.push({ caption: null, steps: [{ ...t, state: 'later' }] })
    else groups.at(-1)?.steps.push({ ...t, state: 'later' })
  }
  let pointer: 'before' | 'now' | 'after' = 'before'
  for (const step of groups.flatMap((g) => g.steps)) {
    if (step.done) step.state = 'done'
    else if (step.blocked) {
      step.state = 'blocked'
      if (pointer === 'before') pointer = 'now'
    } else if (pointer === 'before') {
      step.state = 'now'
      pointer = 'now'
    } else if (pointer === 'now') {
      step.state = 'next'
      pointer = 'after'
    }
  }
  return groups.filter((g) => g.steps.length)
}

/** The steps a timeline shows: done and total, for its progress. */
export function stepCounts(groups: StepGroup[]) {
  const steps = groups.flatMap((g) => g.steps)
  return { done: steps.filter((s) => s.state === 'done').length, total: steps.length }
}
