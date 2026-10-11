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
