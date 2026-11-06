import { writeSync } from 'node:fs'

/**
 * The server's own trace of how it ends, on stderr (`board.err.log` under `pnpm start` and the desktop
 * app): a timestamped line when it is sent SIGTERM, SIGINT or SIGHUP, when an error escapes (with its
 * stack), and as it exits, with its pid, uptime and peak memory. None of it changes how the process
 * ends: Nitro's graceful shutdown still handles SIGINT and SIGTERM, Nitro's own trap still keeps it
 * running after an escaped error, and a SIGHUP nothing else handles still ends it, by the signal.
 * Which process sent a signal is not something Node can tell.
 */

export const LOGGED_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const

type Write = (text: string) => void

/** Written at once: a line queued on an async stream is lost when the process ends right after. */
const writeStderr: Write = (text) => {
  try {
    writeSync(2, text)
  } catch {
    // stderr closed: nothing to tell
  }
}

/** `<ISO time> board pid <pid> <what> uptime=<s>s maxrss=<MB>MB` */
export function processLine(what: string, at = new Date()): string {
  const uptime = Math.round(process.uptime())
  const maxRss = Math.round(process.resourceUsage().maxRSS / 1024)
  return `${at.toISOString()} board pid ${process.pid} ${what} uptime=${uptime}s maxrss=${maxRss}MB`
}

/** The stack of what escaped, or what it was when it is not an Error. */
export function errorStack(err: unknown): string {
  if (err instanceof Error) return err.stack || `${err.name}: ${err.message}`
  try {
    return `non-error value: ${typeof err === 'string' ? err : JSON.stringify(err)}`
  } catch {
    return `non-error value: ${String(err)}`
  }
}

// On globalThis: under `vite dev` the server's modules, and the plugin that calls this, run again on
// each reload in the same process, and each run would add its listeners again.
const HOOKED = Symbol.for('agent-board.processLog.hooked')

/** Hooks the lines in, once per process. `write` is for the tests. */
export function logProcessEnd(write: Write = writeStderr) {
  const g = globalThis as { [HOOKED]?: boolean }
  if (g[HOOKED]) return
  g[HOOKED] = true
  for (const signal of LOGGED_SIGNALS) {
    const onSignal = () => {
      write(`${processLine(`received ${signal}`)}\n`)
      // Ours was the only handler: the signal does what it would have done without it (SIGHUP ends the
      // process). Nitro's graceful shutdown is still listening for SIGINT and SIGTERM, so those are left
      // to it.
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal)
    }
    process.once(signal, onSignal)
  }
  // A monitor sees an uncaught exception before whatever handles it, and changes nothing.
  process.on('uncaughtExceptionMonitor', (err, origin) => {
    write(`${processLine(origin)}\n${errorStack(err)}\n`)
  })
  // Nitro's trap listens for these as well (so a rejection never becomes an uncaught exception there):
  // another listener changes nothing either.
  process.on('unhandledRejection', (reason) => {
    write(`${processLine('unhandledRejection')}\n${errorStack(reason)}\n`)
    // Nothing else listens: Node's default, the rejection thrown as an uncaught exception.
    if (process.listenerCount('unhandledRejection') === 1) throw reason
  })
  process.on('exit', (code) => {
    write(`${processLine(`exiting code=${code}`)}\n`)
  })
}
