import { tickSchedules } from './reviews'

const KEY = Symbol.for('agent-board.scheduler')

/** One minute tick that fires due review schedules. Idempotent, so the dev server's reloads don't stack timers. */
export function startScheduler() {
  const g = globalThis as { [KEY]?: ReturnType<typeof setInterval> }
  if (g[KEY]) clearInterval(g[KEY])
  g[KEY] = setInterval(() => {
    try {
      tickSchedules()
    } catch (err) {
      console.error('scheduler tick failed:', err)
    }
  }, 60_000)
  g[KEY].unref()
}
