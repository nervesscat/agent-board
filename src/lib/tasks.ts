/**
 * A ticket's tasks as a tree: the first open step a ticket works next, with an open parent counted as a
 * container rather than a step. Pure, so every read that has to know what a ticket works next — the
 * blocked badge, Needs you, and whether the ticket waits on the human — picks the same task.
 */

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
