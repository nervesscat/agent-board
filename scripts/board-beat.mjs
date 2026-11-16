#!/usr/bin/env node
// Keeps a ticket's lease alive while a long tool call runs, without the agent having to remember.
//
//   node board-beat.mjs --project <id> --ticket <id> -- <command> [args...]
//   node board-beat.mjs --project <id> --ticket <id> --once
//   node board-beat.mjs --project <id> --ticket <id> [--interval <ms>]
//
// With a command it beats once, runs the command with its own stdio, beats every interval while it
// runs and once when it ends. Without one it beats once, then every interval until it is stopped; use
// it as an OpenCode plugin's background beat for a phase. --once posts one heartbeat and exits, for a
// hook on tool start or tool end.
//
//   BOARD_URL         the board as http(s)://host[:port] (PORT, or BOARD_PORT on this machine)
//   BOARD_TOKEN       the agent token (Authorization: Bearer); read from the environment, never printed
//   BOARD_AGENT_NAME  optional sub-identity, as the board calls it
//   BOARD_BEAT_MS     default beat interval in milliseconds when --interval is not given
//                     (default 120000: two minutes)
//   BOARD_BEAT_TIMEOUT_MS  how long one beat waits for the board before it is given up
//                     (default 15000: a beat older than this is worthless)
//
// stdout carries the command's output only; the beater's own notes go to stderr.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const log = (msg) => process.stderr.write(`board-beat: ${msg}\n`)

export const DEFAULT_INTERVAL_MS = 120_000
/** How long a beat waits for the board before it is given up: a beat older than this is worthless. */
export const DEFAULT_BEAT_TIMEOUT_MS = 15_000

const USAGE =
  'usage: board-beat.mjs --project <id> --ticket <id> [--interval <ms>, default BOARD_BEAT_MS or 120000] [--once] [-- <command>]'

/** The board this machine runs when BOARD_URL is not set: loopback and its port, never another host. */
const defaultUrl = (env) => {
  const port = env.BOARD_PORT ?? env.PORT ?? '47100'
  return `http://127.0.0.1:${port}`
}

/**
 * The beater's arguments: the project and ticket it beats for, the interval, a single beat, and the
 * command it wraps (`--` and everything after it). Anything else is refused: a command's words without
 * the `--` must not be dropped as if there were none.
 */
export function parseArgs(argv) {
  // BOARD_BEAT_MS is the default interval; --interval wins over it, and either must be a whole, positive
  // number of milliseconds. BOARD_BEAT_TIMEOUT_MS bounds one beat the same way.
  const envBeatMs = (process.env.BOARD_BEAT_MS ?? '').trim()
  const defaultIntervalMs = envBeatMs === '' ? DEFAULT_INTERVAL_MS : Number(envBeatMs)
  const envTimeoutMs = (process.env.BOARD_BEAT_TIMEOUT_MS ?? '').trim()
  const defaultTimeoutMs = envTimeoutMs === '' ? DEFAULT_BEAT_TIMEOUT_MS : Number(envTimeoutMs)
  const out = {
    project: null,
    ticket: null,
    intervalMs: defaultIntervalMs,
    timeoutMs: defaultTimeoutMs,
    once: false,
    command: [],
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      out.command = argv.slice(i + 1)
      break
    }
    if (arg === '--once') out.once = true
    else if (arg === '--project' || arg === '--ticket' || arg === '--interval') {
      const value = argv[++i]
      if (arg === '--project') out.project = Number(value)
      else if (arg === '--ticket') out.ticket = Number(value)
      else out.intervalMs = Number(value)
    } else return { problem: USAGE }
  }
  const whole = (n) => Number.isInteger(n) && n > 0
  if (!whole(out.project) || !whole(out.ticket)) return { problem: USAGE }
  if (!whole(out.intervalMs))
    return { problem: '--interval (or BOARD_BEAT_MS) must be a whole number of milliseconds' }
  if (!whole(out.timeoutMs))
    return { problem: 'BOARD_BEAT_TIMEOUT_MS must be a whole number of milliseconds' }
  const url = (process.env.BOARD_URL ?? defaultUrl(process.env)).trim().replace(/\/+$/, '')
  let target
  try {
    target = new URL(url)
  } catch {
    target = null
  }
  if (!target || !/^https?:$/.test(target.protocol))
    return { problem: 'BOARD_URL must be the board as http(s)://host[:port]' }
  if (!process.env.BOARD_TOKEN) return { problem: 'BOARD_TOKEN is not set' }
  return {
    ...out,
    url,
    token: process.env.BOARD_TOKEN,
    agentName: (process.env.BOARD_AGENT_NAME ?? '').trim(),
  }
}

/** One heartbeat: the board's events route for that ticket, as the agent token. */
export async function beatBoard({
  url,
  token,
  agentName,
  project,
  ticket,
  at,
  timeoutMs = DEFAULT_BEAT_TIMEOUT_MS,
  fetch: request = fetch,
}) {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  if (agentName) headers['x-agent-name'] = agentName
  const res = await request(`${url}/api/projects/${project}/tickets/${ticket}/events`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'heartbeat', note: '' }),
    // A board that accepts the connection and never answers must not hold the wrapper before its
    // command: the beat gives up on its own timeout, as a missed beat always does.
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    let said = ''
    try {
      said = (await res.json()).error ?? ''
    } catch {}
    throw new Error(`the board answered ${res.status}${said ? `: ${said}` : ''}`)
  }
  return at
}

/**
 * The beater itself: `start` posts one beat then one every interval, `stop` posts the last one and
 * clears the timer. `post` and the clock and timer are injected so a test can drive it without a
 * board or wall time; each beat records `{at, why}`.
 */
export function createBeater({
  post,
  now = () => Date.now(),
  intervalMs = DEFAULT_INTERVAL_MS,
  setTimer = setInterval,
  clearTimer = clearInterval,
  log: report = log,
}) {
  const beats = []
  const pending = new Set()
  let timer = null
  let running = false
  const beat = (why) => {
    const at = new Date(now()).toISOString()
    const p = (async () => {
      try {
        await post(at, why)
        beats.push({ at, why })
        return at
      } catch (err) {
        // A missed beat is never fatal: the next one tries again, and the wrapped command runs on.
        report(`beat failed (${why}): ${err.message}`)
        return null
      }
    })()
    pending.add(p)
    p.finally(() => pending.delete(p))
    return p
  }
  const idle = () => Promise.allSettled([...pending])
  const start = async () => {
    if (running) return
    running = true
    await beat('start')
    // The interval timer stays referenced: with no command to run, it is what keeps a backgrounded
    // beater's process alive between its beats.
    timer = setTimer(() => {
      void beat('interval')
    }, intervalMs)
  }
  const stop = async () => {
    if (!running) return
    running = false
    if (timer) clearTimer(timer)
    timer = null
    await beat('end')
  }
  return {
    beats,
    beat,
    start,
    stop,
    idle,
    get running() {
      return running
    },
  }
}

/** Runs the wrapped command with the beater's own stdio; resolves with its exit code. */
function run(command) {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { stdio: 'inherit' })
    child.on('error', (err) => {
      log(`could not start ${command[0]}: ${err.message}`)
      resolve(127)
    })
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
  })
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2))
  if (cfg.problem) {
    log(cfg.problem)
    process.exit(2)
  }
  const http = (at) =>
    beatBoard({
      url: cfg.url,
      token: cfg.token,
      agentName: cfg.agentName,
      project: cfg.project,
      ticket: cfg.ticket,
      timeoutMs: cfg.timeoutMs,
      at,
    })
  const beater = createBeater({ post: http, intervalMs: cfg.intervalMs })
  if (cfg.once) {
    await beater.beat('start')
    process.exit(beater.beats.length ? 0 : 1)
  }
  await beater.start()
  if (cfg.command.length) {
    const code = await run(cfg.command)
    await beater.stop()
    process.exit(code)
  }
  const finish = async () => {
    await beater.stop()
    process.exit(0)
  }
  process.on('SIGINT', finish)
  process.on('SIGTERM', finish)
}

const isMain = () => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}
if (isMain()) main()
