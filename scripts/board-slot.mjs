#!/usr/bin/env node
// Takes, holds and frees a test slot for one repo's heavy runs, and records the wait on the ticket.
// Served by the server that serves it (GET /api/agent-setup/board-slot) and saved as board-slot.mjs.
//
//   node board-slot.mjs run [--locks <dir>] [--repo <id>] [--project <id>] [--ticket <id>] [--step <name>]
//                           [--full] [--timeout <minutes>] -- <command> [args...]
//   node board-slot.mjs claim <locks dir> <repo id> <holder> [--project <id>] [--ticket <id>] [--full]
//                           [--pid <n>] [--timeout <minutes>]
//   node board-slot.mjs release <slot dir> <token>
//
// A slot is the folder `tests-<repo id>-<n>` (n = 1 or 2) in the locks folder, taken with one plain
// mkdir: the mkdir fails while it is held. Its holder.txt starts with `#<holder> <ISO time>` (the holder
// is "<ticket> <step>"), then `pid <n>`, `token <nonce>` and `started <ISO time>`. `--full` takes
// `tests-<repo id>-full` once every numbered slot is free, and numbered slots wait while it exists.
// A slot whose holder pid is dead is reclaimed. A holder with no pid line is never reclaimed (it was
// written by hand), and a folder with no holder.txt is reclaimed once it is older than a minute.
// Waiters queue in <locks>/queue, first in first served, and poll. A wait is recorded on the ticket:
// wait_start (reason lock, the slot name as the note) when queued, wait_end with its waitId when the
// wait ends. Without a project and ticket the wait is not recorded. A newcomer queues behind a live
// waiter instead of taking a free slot, so the queue is served in order. A waiter refreshes its queue
// file's mtime at each poll; a queue file not refreshed for max(60 s, 3 polls) is dead, whatever its pid.
// Every claim and reclaim runs under one lock: the folder `<locks>/claim.lock` (a plain mkdir, its pid
// written inside). A lock whose pid is dead is taken over; a live one makes the caller poll. A lock with
// no usable pid (empty, or not a number) is taken over once it is a minute old. Releasing does not take
// the lock.
// A caller that keeps a long-lived process passes `--pid <its pid>` to `claim` (the default is its
// parent process, which is gone once the caller's shell exits). Heavy commands use `run`, which holds
// the slot for as long as its command lives.
//
//   BOARD_URL         the server as http(s)://host[:port] (PORT, or BOARD_PORT on this machine)
//   BOARD_TOKEN       the agent token (Authorization: Bearer); read from the environment, never printed
//   BOARD_PROJECT, BOARD_TICKET   the project and ticket a wait is recorded on, when not given as options
//   BOARD_SLOT_LOCKS, BOARD_SLOT_REPO   the locks folder and repo id `run` uses, when not given as options
//   BOARD_SLOT_POLL_MS   how often a waiter looks for a free slot (default 10000)
//
// `run` holds a slot around one command: its stdio is the command's. `claim` prints `<slot dir>` TAB
// `<token>` on stdout for a caller that keeps a long-lived process, and `release` frees a slot by that
// token. Exit codes: `run` exits with the command's own exit code; 3 when no slot was free before the
// timeout (or a stop signal arrived while it waited: then 128 + the signal number). `claim` exits 0 with
// a slot, 3 when it gave up waiting (the holders are on stderr). 4 is `release` refusing (nothing
// removed) and is `release`'s alone: a `run` whose release is refused logs it and still exits with the
// command's code. 2 is a usage error.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const log = (msg) => process.stderr.write(`board-slot: ${msg}\n`)

/** The numbered slots per repo: measured on a 12-core machine (the instructions say when to re-measure). */
export const SLOT_COUNT = 2
/** How long a folder with no holder.txt may stay before it is taken to be a crashed claim's leftover. */
export const GRACE_MS = 60_000
export const DEFAULT_POLL_MS = 10_000
export const DEFAULT_TIMEOUT_MIN = 180
const REQUEST_TIMEOUT_MS = 15_000

const USAGE = [
  'usage: board-slot.mjs run [--locks <dir>] [--repo <id>] [--project <id>] [--ticket <id>] [--step <name>]',
  '                          [--full] [--timeout <minutes>] -- <command> [args...]',
  '       board-slot.mjs claim <locks dir> <repo id> <holder> [--project <id>] [--ticket <id>] [--full]',
  '                          [--pid <n>] [--timeout <minutes>]',
  '       board-slot.mjs release <slot dir> <token>',
].join('\n')

export const slotName = (repo, n) => `tests-${repo}-${n}`
export const fullName = (repo) => `tests-${repo}-full`
export const slotNames = (repo) => Array.from({ length: SLOT_COUNT }, (_, i) => slotName(repo, i + 1))

/** Whether a process with this pid exists and is not a zombie (a zombie has ended, it only awaits its parent). */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0)
  } catch (err) {
    if (err.code !== 'EPERM') return false
  }
  if (process.platform !== 'linux') return true
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z'
  } catch {
    return true
  }
}

/** The text of a holder.txt: the first line, then the pid, the token and the start time. */
export function formatHolder({ holder, pid, token, started }) {
  return `#${holder} ${started}\npid ${pid}\ntoken ${token}\nstarted ${started}\n`
}

/**
 * A holder.txt read back. `holder` is the first line's text after the `#` (null when there is no such
 * line); `pid` is the number on the pid line, `'bad'` when that line is not a positive whole number, and
 * null when there is no pid line (a holder written by hand); `token` is null when there is none.
 */
export function parseHolder(text) {
  const lines = text.split(/\r?\n/)
  const first = lines[0] ?? ''
  const pidLine = lines.find((line) => line.startsWith('pid '))
  let pid = null
  if (pidLine !== undefined) {
    const raw = pidLine.slice(4).trim()
    pid = /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : 'bad'
  }
  const tokenLine = lines.find((line) => line.startsWith('token '))
  const token = tokenLine === undefined ? null : tokenLine.slice(6).trim() || null
  return { holder: first.startsWith('#') ? first.slice(1) : null, pid, token, lines }
}

/** A slot folder as it is now: its mtime, and its holder when it has a holder.txt; null when absent. */
export function readSlot(dir) {
  let mtimeMs
  try {
    mtimeMs = fs.statSync(dir).mtimeMs
  } catch {
    return null
  }
  let text = null
  try {
    text = fs.readFileSync(path.join(dir, 'holder.txt'), 'utf8')
  } catch {}
  return { dir, mtimeMs, text, holder: text === null ? null : parseHolder(text) }
}

/**
 * Whether a held slot may be reclaimed (`now` is a clock function): no holder.txt and older than the
 * grace; or a pid line whose process is dead. A holder with no pid line, or a bad pid, is never reclaimed: a bad pid counts as live.
 */
export function isStale(slot, { now, isAlive }) {
  if (slot.holder === null) return now() - slot.mtimeMs > GRACE_MS
  const { pid } = slot.holder
  if (pid === null || pid === 'bad') return false
  return !isAlive(pid)
}

/**
 * Moves a stale slot out of the way, so no other claim can use it meanwhile, and reads what it moved.
 * A dead holder is removed. A live one (a claim made between the stale check and the move) goes back
 * to its place. Answers true when the slot name is free again to take.
 */
export function reclaimSlot(dir, { now, isAlive, beforeRename }) {
  const away = `${dir}.reclaim-${process.pid}-${randomBytes(4).toString('hex')}`
  beforeRename?.(dir)
  try {
    fs.renameSync(dir, away)
  } catch (err) {
    return err.code === 'ENOENT'
  }
  const moved = readSlot(away)
  if (moved === null || isStale(moved, { now, isAlive })) {
    fs.rmSync(away, { recursive: true, force: true })
    return true
  }
  try {
    fs.renameSync(away, dir)
  } catch (err) {
    log(`could not put ${dir} back after a reclaim (${err.message}); its holder's folder is at ${away}`)
  }
  return false
}

/** Whether a slot folder is held: it exists and is not stale (a stale one is reclaimed first). */
function heldBy(dir, ctx) {
  const slot = readSlot(dir)
  if (slot === null) return false
  if (!isStale(slot, ctx)) return true
  reclaimSlot(dir, ctx)
  return readSlot(dir) !== null
}

/** Makes the folder with a plain mkdir (never recursive): true when it is ours, false when it exists. */
function mkdirSlot(dir) {
  try {
    fs.mkdirSync(dir)
    return true
  } catch (err) {
    if (err.code === 'EEXIST') return false
    throw err
  }
}

/** Takes a folder: a plain mkdir, reclaiming a stale holder of it first. True when the folder is ours. */
function takeDir(dir, ctx) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (mkdirSlot(dir)) return true
    const slot = readSlot(dir)
    if (slot === null) continue
    if (!isStale(slot, ctx)) return false
    reclaimSlot(dir, ctx)
  }
  return false
}

/** Writes a file through a temp file renamed over it, so a reader sees the old text or the new, never half. */
function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}-${randomBytes(3).toString('hex')}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

function writeHolder(dir, { holder, pid, now }) {
  const token = randomBytes(8).toString('hex')
  const started = new Date(now()).toISOString()
  writeFileAtomic(path.join(dir, 'holder.txt'), formatHolder({ holder, pid, token, started }))
  return token
}

/** Points a held slot's holder at another pid (a run's command, once spawned); false when the token is not its. */
export function setHolderPid(dir, token, pid) {
  const slot = readSlot(dir)
  if (slot === null || !token || slot.holder?.token !== token) return false
  let found = false
  const lines = slot.text.split(/\r?\n/).map((line) => {
    if (!line.startsWith('pid ')) return line
    found = true
    return `pid ${pid}`
  })
  if (!found) lines.splice(1, 0, `pid ${pid}`)
  writeFileAtomic(path.join(dir, 'holder.txt'), lines.join('\n'))
  return true
}

/**
 * One attempt, without waiting: the slot it took ({ dir, slot, token }), or null when none is free.
 * A full run takes its folder only after every numbered slot is free. A numbered claim checks for the
 * full folder after it has made its own folder, and a full claim checks the numbered folders the same
 * way, so one of two claims that raced backs off.
 */
export function tryClaim({ locks, repo, holder, pid, full = false, now, isAlive, beforeRename }) {
  fs.mkdirSync(locks, { recursive: true })
  const ctx = { now, isAlive, beforeRename }
  const fullDir = path.join(locks, fullName(repo))
  const numbered = slotNames(repo).map((name) => path.join(locks, name))
  const finish = (dir, slot) => ({ dir, slot, token: writeHolder(dir, { holder, pid, now }) })

  if (full) {
    if (numbered.some((dir) => heldBy(dir, ctx))) return null
    if (!takeDir(fullDir, ctx)) return null
    if (numbered.some((dir) => heldBy(dir, ctx))) {
      fs.rmSync(fullDir, { recursive: true, force: true })
      return null
    }
    return finish(fullDir, fullName(repo))
  }

  if (heldBy(fullDir, ctx)) return null
  for (const dir of numbered) {
    if (!takeDir(dir, ctx)) continue
    if (heldBy(fullDir, ctx)) {
      fs.rmSync(dir, { recursive: true, force: true })
      return null
    }
    return finish(dir, path.basename(dir))
  }
  return null
}

/** How long a waiter's queue file may go without its refresh (one per poll) before the waiter is gone. */
const WAITER_MIN_STALE_MS = 60_000
const waiterStaleMs = (pollMs) => Math.max(WAITER_MIN_STALE_MS, 3 * pollMs)

/**
 * The live waiter files in the queue, oldest first. A waiter is live while its process is alive and its
 * queue file was refreshed lately; any other queue file is removed (a pid the system has reused does not
 * keep it).
 */
function liveWaiters(queueDir, { now, isAlive, pollMs }) {
  const live = []
  let names
  try {
    names = fs.readdirSync(queueDir).sort()
  } catch {
    return live
  }
  for (const name of names) {
    const file = path.join(queueDir, name)
    const pid = Number(name.slice(name.lastIndexOf('-') + 1))
    let mtimeMs
    try {
      mtimeMs = fs.statSync(file).mtimeMs
    } catch {
      continue
    }
    const fresh = now() - mtimeMs <= waiterStaleMs(pollMs)
    if (fresh && Number.isInteger(pid) && isAlive(pid)) live.push(name)
    else fs.rmSync(file, { force: true })
  }
  return live
}

/** Whether this waiter is first in line: no live waiter ahead of it. */
function isHead(queueDir, mine, waiting) {
  const live = liveWaiters(queueDir, waiting)
  return live.length === 0 || live[0] === path.basename(mine)
}

/** Refreshes a queue file's mtime (the waiter is still waiting); a file already removed is no matter. */
function touch(file, ms) {
  const seconds = ms / 1000
  try {
    fs.utimesSync(file, seconds, seconds)
  } catch {}
}

const LOCK_FOLDER = 'claim.lock'
const TIMED_OUT = Symbol('timed out waiting for the claim lock')

/**
 * Whether the claim lock's holder is gone: its pid is dead. A lock with no usable pid (no pid file, an
 * empty one, or one that is not a positive whole number) is gone once it is older than the grace.
 */
function lockStale(lockDir, { now, isAlive }) {
  let text = null
  try {
    text = fs.readFileSync(path.join(lockDir, 'pid'), 'utf8')
  } catch {}
  const pid = text === null ? NaN : Number(text.trim())
  if (!(Number.isInteger(pid) && pid > 0)) {
    try {
      return now() - fs.statSync(lockDir).mtimeMs > GRACE_MS
    } catch {
      return false
    }
  }
  return !isAlive(pid)
}

/** Moves a stale claim lock away and removes it, or puts it back when a live claim took it meanwhile. */
function reclaimLock(lockDir, ctx) {
  const away = `${lockDir}.stale-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    fs.renameSync(lockDir, away)
  } catch {
    return
  }
  if (lockStale(away, ctx)) {
    fs.rmSync(away, { recursive: true, force: true })
    return
  }
  try {
    fs.renameSync(away, lockDir)
  } catch (err) {
    log(`could not put the claim lock back (${err.message}); it is at ${away}`)
  }
}

/** Takes the claim lock with a plain mkdir and writes this process's pid inside it; false while a live one holds it. */
function takeClaimLock(lockDir, owner, ctx) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.mkdirSync(lockDir)
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      if (!lockStale(lockDir, ctx)) return false
      reclaimLock(lockDir, ctx)
      continue
    }
    try {
      fs.writeFileSync(path.join(lockDir, 'pid'), `${owner}\n`)
    } catch (err) {
      // A reclaim moved the fresh lock away between the mkdir and this write: the lock is lost, so go round.
      if (err.code === 'ENOENT') continue
      throw err
    }
    return true
  }
  return false
}

/**
 * Runs `fn` holding the claim lock, the one lock every claim and reclaim of every slot runs under. A
 * live holder makes the caller poll (not a slot wait, so nothing is recorded). Answers TIMED_OUT when
 * `deadline` passes before the lock is taken.
 */
async function withClaimLock(locks, fn, { owner, now, sleep, isAlive, pollMs, deadline }) {
  const lockDir = path.join(locks, LOCK_FOLDER)
  const ctx = { now, isAlive }
  while (!takeClaimLock(lockDir, owner, ctx)) {
    if (now() >= deadline) return TIMED_OUT
    await sleep(pollMs)
  }
  try {
    return fn()
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true })
  }
}

/** The holder.txt lines of each slot of this repo that is held, for the message that gives up. */
export function holderLines(locks, repo, full = false) {
  const names = full ? [fullName(repo)] : slotNames(repo)
  return names.map((name) => {
    const slot = readSlot(path.join(locks, name))
    if (slot === null) return `  ${name}: free`
    if (slot.text === null) return `  ${name}: held, no holder.txt yet`
    return `  ${name}:\n${slot.text
      .trimEnd()
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n')}`
  })
}

/** Sleeps `ms`, or until `signal` aborts (a stop ends the poll at once). */
const delay = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })

const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP']

/**
 * Listens for a stop signal while a claim is in progress. `name` is the signal once one has arrived,
 * `stopped` resolves then, and `dispose` removes the listeners (a claim calls it on every path).
 */
function listenForStop() {
  const controller = new AbortController()
  const stop = {
    name: null,
    controller,
    stopped: new Promise((resolve) => controller.signal.addEventListener('abort', resolve, { once: true })),
    dispose: null,
  }
  const handlers = STOP_SIGNALS.map((name) => {
    const handler = () => {
      if (!stop.name) stop.name = name
      controller.abort()
    }
    process.on(name, handler)
    return [name, handler]
  })
  stop.dispose = () => {
    for (const [name, handler] of handlers) process.off(name, handler)
  }
  return stop
}

/**
 * Claims a slot, waiting in the queue while none is free. Resolves { ok: true, dir, slot, token }, or
 * { ok: false, holders, signal } once `timeoutMs` has passed or a stop signal (`signal`, a name such as
 * 'SIGTERM') arrived. The wait is recorded through `recorder` (see createRecorder), if there is one; its
 * start and its end are the only recorded events, and the end is posted on every path.
 */
export async function claim({
  locks,
  repo,
  holder,
  pid = process.ppid,
  full = false,
  timeoutMs = DEFAULT_TIMEOUT_MIN * 60_000,
  pollMs = DEFAULT_POLL_MS,
  now = () => Date.now(),
  sleep = delay,
  isAlive = pidAlive,
  beforeRename,
  recorder = null,
  queuePid = process.pid,
}) {
  const deadline = now() + timeoutMs
  const waiting = { now, isAlive, pollMs }
  const attempt = () =>
    withClaimLock(locks, () => tryClaim({ locks, repo, holder, pid, full, now, isAlive, beforeRename }), {
      owner: queuePid,
      now,
      sleep,
      isAlive,
      pollMs,
      deadline,
    })
  const queueDir = path.join(locks, 'queue')
  fs.mkdirSync(locks, { recursive: true })
  const stop = listenForStop()
  const gaveUp = () => ({ ok: false, holders: holderLines(locks, repo, full), signal: stop.name })
  // Waits for a slot: the slot taken (a folder with its holder), or null when the wait ends without one.
  // The queue file is removed and the wait end is posted on every path, before this returns.
  const waitForSlot = async () => {
    let mine = null
    let waitId = null
    try {
      // A newcomer takes a free slot only when no live waiter is queued ahead of it.
      if (liveWaiters(queueDir, waiting).length === 0) {
        const first = await attempt()
        if (first === TIMED_OUT) return null
        if (first) return first
      }
      if (stop.name) return null

      fs.mkdirSync(queueDir, { recursive: true })
      mine = path.join(queueDir, `${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${queuePid}`)
      fs.writeFileSync(mine, `${queuePid}\n`)
      const note = full ? fullName(repo) : `${slotName(repo, 1)} to ${slotName(repo, SLOT_COUNT)}`
      if (!recorder) log(`waiting for a test slot; the wait is not recorded (no project and ticket given)`)
      waitId = recorder ? await recorder.start(note) : null
      for (;;) {
        if (isHead(queueDir, mine, waiting)) {
          const got = await attempt()
          if (got === TIMED_OUT) return null
          if (got) return got
        }
        touch(mine, now())
        if (stop.name || now() >= deadline) return null
        await Promise.race([sleep(pollMs, stop.controller.signal), stop.stopped])
      }
    } finally {
      if (mine !== null) fs.rmSync(mine, { force: true })
      if (recorder && waitId !== null) await recorder.end(waitId)
    }
  }
  try {
    const got = await waitForSlot()
    if (!got) return gaveUp()
    // A stop that arrived while the slot was taken or the wait end was posted: give the slot back, so
    // nothing starts that was stopped. The listeners are still installed here, so such a stop is seen.
    if (stop.name) {
      release(got.dir, got.token)
      return gaveUp()
    }
    return { ok: true, ...got }
  } finally {
    stop.dispose()
  }
}

/** Frees a slot when its holder.txt carries this token; false (nothing removed) otherwise. */
export function release(dir, token) {
  const slot = readSlot(dir)
  if (slot === null || !token || slot.holder?.token !== token) return false
  fs.rmSync(dir, { recursive: true, force: true })
  return true
}

/**
 * The wait recorder: wait_start and wait_end on the ticket's events route, as the agent token, through
 * the same route the beater uses. A failed request is reported and never stops the wait.
 */
export function createRecorder({ url, token, project, ticket, request = fetch }) {
  const post = async (body) => {
    const res = await request(`${url}/api/projects/${project}/tickets/${ticket}/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) {
      let said = ''
      try {
        said = (await res.json()).error ?? ''
      } catch {}
      throw new Error(`the server answered ${res.status}${said ? `: ${said}` : ''}`)
    }
    return res.json()
  }
  return {
    async start(note) {
      try {
        const out = await post({ kind: 'wait_start', reason: 'lock', note })
        return out.waitId ?? null
      } catch (err) {
        log(`wait not recorded: ${err.message}`)
        return null
      }
    },
    async end(waitId) {
      try {
        await post({ kind: 'wait_end', waitId })
      } catch (err) {
        log(`wait end not recorded: ${err.message}`)
      }
    },
  }
}

/** Splits argv into positionals and `--name value` / `--flag` options; `--` ends them (the rest is `command`). */
export function parseArgv(argv, valueFlags, boolFlags) {
  const positional = []
  const opts = {}
  let command = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      command = argv.slice(i + 1)
      break
    }
    if (boolFlags.includes(arg)) opts[arg.slice(2)] = true
    else if (valueFlags.includes(arg)) {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) return { problem: `${arg} needs a value` }
      opts[arg.slice(2)] = value
    } else if (arg.startsWith('--')) return { problem: `unknown option ${arg}` }
    else positional.push(arg)
  }
  return { positional, opts, command }
}

const isWhole = (n) => Number.isInteger(n) && n > 0

/** The configuration `claim` and `run` share: the repo, the holder, the timing and the wait recorder. */
function sharedConfig(opts, env, { repo, holder }) {
  if (!/^[A-Za-z0-9_-]+$/.test(repo ?? '')) return { problem: 'the repo id must be letters, digits, - or _' }
  if (!holder || /[\r\n]/.test(holder))
    return { problem: 'the holder must be one line, such as "<ticket> <step>"' }
  const timeoutMin = opts.timeout === undefined ? DEFAULT_TIMEOUT_MIN : Number(opts.timeout)
  if (!(timeoutMin > 0)) return { problem: '--timeout must be a number of minutes above 0' }
  const pollRaw = (env.BOARD_SLOT_POLL_MS ?? '').trim()
  const pollMs = pollRaw === '' ? DEFAULT_POLL_MS : Number(pollRaw)
  if (!isWhole(pollMs)) return { problem: 'BOARD_SLOT_POLL_MS must be a whole number of milliseconds' }
  const ticketRaw = opts.ticket ?? env.BOARD_TICKET
  const projectRaw = opts.project ?? env.BOARD_PROJECT
  const project = projectRaw === undefined ? null : Number(projectRaw)
  const ticket = ticketRaw === undefined ? null : Number(ticketRaw)
  let recorder = null
  if (isWhole(project) && isWhole(ticket)) {
    const port = env.BOARD_PORT ?? env.PORT ?? '47100'
    const url = (env.BOARD_URL ?? `http://127.0.0.1:${port}`).trim().replace(/\/+$/, '')
    if (!env.BOARD_TOKEN) log('wait recording off: BOARD_TOKEN is not set')
    else if (!/^https?:\/\//.test(url)) log('wait recording off: BOARD_URL must be http(s)://host[:port]')
    else recorder = createRecorder({ url, token: env.BOARD_TOKEN, project, ticket })
  }
  return {
    repo,
    holder,
    full: opts.full === true,
    timeoutMs: timeoutMin * 60_000,
    pollMs,
    recorder,
  }
}

const CLAIM_VALUES = ['--project', '--ticket', '--pid', '--timeout']
const RUN_VALUES = ['--locks', '--repo', '--project', '--ticket', '--step', '--timeout']

function parseClaim(args, env) {
  const { positional, opts, problem } = parseArgv(args, CLAIM_VALUES, ['--full'])
  if (problem) return { problem }
  if (positional.length !== 3) return { problem: USAGE }
  const [locks, repo, holder] = positional
  const pid = opts.pid === undefined ? process.ppid : Number(opts.pid)
  if (!isWhole(pid)) return { problem: '--pid must be a positive whole number' }
  const shared = sharedConfig(opts, env, { repo, holder: holder.trim().replace(/^#\s*/, '') })
  if (shared.problem) return shared
  return { locks: path.resolve(locks), pid, ...shared }
}

function parseRun(args, env) {
  const { positional, opts, command, problem } = parseArgv(args, RUN_VALUES, ['--full'])
  if (problem) return { problem }
  if (positional.length || !command.length) return { problem: USAGE }
  const locks = opts.locks ?? env.BOARD_SLOT_LOCKS
  if (!locks) return { problem: 'run needs the locks folder: --locks <dir> or BOARD_SLOT_LOCKS' }
  const repo = opts.repo ?? env.BOARD_SLOT_REPO
  if (!repo) return { problem: 'run needs the repo id: --repo <id> or BOARD_SLOT_REPO' }
  const step = opts.step ?? 'test'
  const ticket = opts.ticket ?? env.BOARD_TICKET ?? 'run'
  const shared = sharedConfig(opts, env, { repo, holder: `${ticket} ${step}` })
  if (shared.problem) return shared
  return { locks: path.resolve(locks), command, ...shared }
}

function reportGaveUp(result) {
  const why = result.signal
    ? `stopped by ${result.signal} while waiting for a test slot`
    : 'no test slot free before the timeout'
  log(`${why}; holders:\n${result.holders.join('\n')}`)
}

async function runCommand(cfg) {
  // This process holds the slot only until its command starts; the command holds it after that.
  const got = await claim({ ...cfg, pid: process.pid })
  if (!got.ok) {
    reportGaveUp(got)
    return got.signal ? 128 + os.constants.signals[got.signal] : 3
  }
  const [file, ...args] = cfg.command
  const child = spawn(file, args, { stdio: 'inherit' })
  // The command holds the slot from here: if this process is killed, the slot stays held while it lives.
  if (child.pid !== undefined && !setHolderPid(got.dir, got.token, child.pid))
    log(`the slot ${got.slot} still names this process: its holder file changed`)
  const forward = (signal) => () => child.kill(signal)
  const forwarded = ['SIGINT', 'SIGTERM', 'SIGHUP']
  for (const signal of forwarded) process.on(signal, forward(signal))
  const code = await new Promise((resolve) => {
    child.on('error', (err) => {
      log(`could not start ${file}: ${err.message}`)
      resolve(127)
    })
    child.on('exit', (exitCode, signal) =>
      resolve(exitCode ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1)),
    )
  })
  for (const signal of forwarded) process.removeAllListeners(signal)
  if (!release(got.dir, got.token)) log(`the slot ${got.slot} was not released: its holder file changed`)
  return code
}

async function main(argv) {
  const [sub, ...rest] = argv
  const env = process.env
  if (sub === 'claim') {
    const cfg = parseClaim(rest, env)
    if (cfg.problem) return usage(cfg.problem)
    const got = await claim(cfg)
    if (!got.ok) {
      reportGaveUp(got)
      return 3
    }
    process.stdout.write(`${got.dir}\t${got.token}\n`)
    return 0
  }
  if (sub === 'release') {
    if (rest.length !== 2) return usage(USAGE)
    if (release(path.resolve(rest[0]), rest[1])) return 0
    log(`not released: ${rest[0]} is not held with that token`)
    return 4
  }
  if (sub === 'run') {
    const cfg = parseRun(rest, env)
    if (cfg.problem) return usage(cfg.problem)
    return runCommand(cfg)
  }
  return usage(USAGE)
}

function usage(message) {
  process.stderr.write(`${message}\n`)
  return 2
}

const isMain = () => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}
if (isMain()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (err) => {
      log(err.message)
      process.exitCode = 1
    },
  )
}
