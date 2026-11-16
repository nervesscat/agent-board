// Remote mode's slow check on the board its window shows: a board that goes away after it was loaded
// (the host restarted, the machine slept, the tailnet dropped) is reported like one that was never
// there, so the app names the address and retries until it answers again (main.mjs). No Electron here,
// so the tests run it under Node.

/** How often the board is checked while its page is shown. Slow: a check is not a heartbeat. */
export const LIVENESS_INTERVAL_MS = 15_000

/**
 * @typedef {object} Liveness
 * @property {() => void} start Starts the checks; a watch already running starts over.
 * @property {() => void} stop Stops them. A check in flight is awaited and then dropped.
 */

/**
 * Checks the board every `intervalMs` while the watch runs, and reports the first failed check once.
 * The first check comes after an interval, and the next only once the one before has answered, so a
 * board slow to answer is never asked twice at once; a failed check ends the watch, leaving the retry
 * to the caller (main.mjs's scheduleRetry).
 * @param {{ check: () => Promise<boolean>, onLost: () => void, intervalMs?: number }} input
 * @returns {Liveness}
 */
export function watchLiveness({ check, onLost, intervalMs = LIVENESS_INTERVAL_MS }) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null
  let watching = false

  function stop() {
    watching = false
    if (timer) clearTimeout(timer)
    timer = null
  }

  function later() {
    if (!watching) return
    timer = setTimeout(() => void run(), intervalMs)
  }

  async function run() {
    timer = null
    let answers = false
    try {
      answers = await check()
    } catch {
      // A check that throws says what one that fails does.
    }
    // Stopped while the check was in flight: its answer belongs to no watch.
    if (!watching) return
    if (answers) {
      later()
      return
    }
    stop()
    onLost()
  }

  return {
    start() {
      stop()
      watching = true
      later()
    },
    stop,
  }
}
