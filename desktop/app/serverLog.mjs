// The app's own record of the board's server: one line in the data folder's logs/desktop.log each
// time it starts it and each time it exits, however it ends (a signal from outside, a crash, Quit), so
// how and when it stopped outlives the dialog that said so. README: "The desktop app".
import fs from 'node:fs'
import path from 'node:path'

export const SERVER_LOG = 'desktop.log'
// Past this size the log is moved to desktop.log.1 (the one before it goes) and a new one begun.
export const SERVER_LOG_MAX = 1024 * 1024

/**
 * The line of a server start.
 * @param {{ pid: number | undefined, at?: Date }} start
 */
export const startLine = ({ pid, at = new Date() }) => `${at.toISOString()} server pid ${pid ?? '?'} started`

/**
 * The line of a server exit, e.g.
 * `2026-11-04T20:33:47.853Z server pid 5901 exited signal=SIGKILL code=null uptime=16832s quitting=false`.
 * `quitting`: the app was stopping it (Quit, or a failure it was showing), so the exit was asked for.
 * @param {{ pid: number | undefined, code: number | null, signal: string | null, startedAt: number,
 *   quitting: boolean, at?: Date }} exit
 */
export function exitLine({ pid, code, signal, startedAt, quitting, at = new Date() }) {
  const uptime = Math.max(0, Math.round((at.getTime() - startedAt) / 1000))
  return (
    `${at.toISOString()} server pid ${pid ?? '?'} exited signal=${signal ?? 'null'} code=${code ?? 'null'} ` +
    `uptime=${uptime}s quitting=${quitting}`
  )
}

/**
 * The line of a server that could not be started at all (no exit follows).
 * @param {{ error: string, at?: Date }} failure
 */
export const spawnFailedLine = ({ error, at = new Date() }) =>
  `${at.toISOString()} server could not be started: ${error}`

/**
 * How the server ended, for the stopped board's dialog: the signal that killed it, else its code.
 * @param {number | null} code
 * @param {string | null} signal
 * @param {Date} [at]
 */
export function exitSentence(code, signal, at = new Date()) {
  const when = ` at ${at.toLocaleTimeString()}`
  if (signal) return `It was killed by ${signal}${when}.`
  if (code !== null) return `It exited with code ${code}${when}.`
  return `It exited${when}.`
}

/**
 * Appends `line` to `<logs>/desktop.log`, moving it to desktop.log.1 first once it has reached `max`
 * bytes, so the two together stay near twice that. A log that cannot be written is no reason to fail:
 * the line is on the app's stderr too (logServer).
 * @param {string} logs
 * @param {string} line
 * @param {number} [max]
 * @returns {boolean} whether it was written
 */
export function appendServerLog(logs, line, max = SERVER_LOG_MAX) {
  const file = path.join(logs, SERVER_LOG)
  try {
    const size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0
    if (size >= max) fs.renameSync(file, `${file}.1`)
  } catch {
    // not rolled: the line is still added below
  }
  try {
    fs.appendFileSync(file, `${line}\n`)
    return true
  } catch {
    return false
  }
}

/**
 * The line in desktop.log and on the app's stderr, for whoever started it from a terminal.
 * @param {string} logs
 * @param {string} line
 */
export function logServer(logs, line) {
  appendServerLog(logs, line)
  try {
    process.stderr.write(`agent-board desktop: ${line}\n`)
  } catch {
    // nobody reads the app's stderr
  }
}
