/**
 * Tasks as the board shapes them: the tree a ticket's tasks make, the step it works next, and the words
 * a task composer adds at the end.
 */

/**
 * `tasks` with the tasks in `text` added at the end: one per line, trimmed, blank lines left out.
 * Repeats are kept, as the server keeps them: two tasks may read the same.
 */
export function addTasks(tasks: string[], text: string): string[] {
  const added = text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  return added.length ? [...tasks, ...added] : tasks
}

type TaskLike = { id: number; parentId: number | null; position: number; done: boolean }

/**
 * The ticket's tasks as one flat list in tree order: each top-level task, then its subtasks, by
 * ascending position (id breaks a tie) — the order the ticket page hands them out in.
 */
export function treeTasks<T extends TaskLike>(tasks: T[]): T[] {
  const rank = (a: T, b: T) => a.position - b.position || a.id - b.id
  return tasks
    .filter((task) => task.parentId === null)
    .sort(rank)
    .flatMap((task) => [task, ...tasks.filter((sub) => sub.parentId === task.id).sort(rank)])
}

/**
 * The task a ticket works next: the first open one in tree order that is no container. An open parent
 * with open subtasks is skipped in favour of its subtasks (its last one ticked settles it done), so a
 * blocked parent surfaces only once it is its own first open task. Null when every task is done.
 */
export function nextTask<T extends TaskLike>(tasks: T[]): T | null {
  const openParents = new Set(
    tasks.flatMap((task) => (!task.done && task.parentId !== null ? [task.parentId] : [])),
  )
  return treeTasks(tasks).find((task) => !task.done && !openParents.has(task.id)) ?? null
}
