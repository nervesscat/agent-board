/**
 * A write that lost SQLite's write lock to another connection, and is worth trying again.
 *
 * The connection waits out a lock up to its `busy_timeout`; a transaction that read before it wrote
 * has no wait to ride out, though: when another connection committed in between, its snapshot is gone
 * and SQLite answers at once. Both reach the caller as `SQLITE_BUSY` ("database is locked"). A burst
 * of writes from several connections is not an error worth a 500, so the unit of work runs again a
 * few times, pausing a little more each time.
 */

/** How long to pause before each retry, in order. The lock is normally held for a moment only. */
const RETRY_AFTER_MS = [100, 250]

/** Whether SQLite refused a write because another connection held the database's lock. */
function locked(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return (
    typeof code === 'string' &&
    (code === 'SQLITE_BUSY' ||
      code === 'SQLITE_LOCKED' ||
      code.startsWith('SQLITE_BUSY_') ||
      code.startsWith('SQLITE_LOCKED_'))
  )
}

/** Wait without giving the event loop a turn, so the requests keep the order they arrived in. */
function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Run `write`, again when it lost the lock to another connection, until the pauses run out. `write` is
 * the whole unit of work (a transaction, so a failed try leaves nothing behind), never one statement of
 * a larger change: running half of a change again would write it twice.
 */
export function retryWhileLocked<T>(write: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return write()
    } catch (err) {
      const pause = RETRY_AFTER_MS[attempt]
      if (pause === undefined || !locked(err)) throw err
      sleepSync(pause)
    }
  }
}
