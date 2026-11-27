#!/usr/bin/env node
// Lists, and with --kill stops, the test leftovers that no live run owns and that are older than --hours
// (default 4): test boards and their builds, browsers, fake agents, and the run folders of runs that ended.
// It never touches a process on the default port 47100 or under a data/ path, and never a process without a test marker. Without --kill
// it signals nothing and removes nothing.
//
//   node scripts/reap-test-leftovers.mjs [--hours <n>] [--kill]
//
// A tagged process (its E2E_ROOT names a run folder) is owned while that folder's runner.pid names a live
// process. An untagged test process (a Chromium profile, a board on a test build) is owned unless its
// parent is init (pid 1), so an orphan is the leftover. --kill sends SIGTERM, then SIGKILL after 5 s.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { pidAlive } from './board-slot.mjs'

export const DEFAULT_HOURS = 4
/** A command line that marks a test process: a board on a test build, a fake agent, a browser profile. */
export const MARKERS = [
  '.output-e2e/server/index.mjs',
  'fake-claude.mjs',
  'fake-tailscale.mjs',
  'playwright_chromiumdev_profile',
  'agent-board-e2e-',
]
export const RUN_PREFIX = 'agent-board-e2e-'
const LIVE_PORT = '47100'
const KILL_AFTER_MS = 5000
/** Clock ticks per second in /proc start times (USER_HZ is 100 on the Linux builds this runs on). */
const USER_HZ = 100

export const hasMarker = (command) => MARKERS.some((marker) => command.includes(marker))

/** The default port in the command or environment, or a data/ path in the command: never touched. */
export function isProtected(proc) {
  const env = proc.env ?? {}
  if (proc.command.includes(LIVE_PORT)) return true
  if (env.PORT === LIVE_PORT || env.BOARD_PORT === LIVE_PORT) return true
  return /[\\/]data[\\/]/.test(proc.command)
}

/**
 * What the reaper lists and what it keeps. `processes` are { pid, ppid, ageHours, command, env };
 * `roots` are { path, ageHours } for each run folder; `runnerAlive(folder)` says whether that run's
 * runner is alive. Pure: the caller reads the machine.
 */
export function classify({ processes, roots, hours = DEFAULT_HOURS, runnerAlive, self = process.pid }) {
  const listed = []
  const kept = []
  for (const proc of processes) {
    if (proc.pid === self || !hasMarker(proc.command) || isProtected(proc)) continue
    if (proc.ageHours < hours) continue
    const base = { pid: proc.pid, ageHours: proc.ageHours, command: proc.command }
    const tag = proc.env?.E2E_ROOT
    if (tag !== undefined) {
      if (runnerAlive(tag)) kept.push({ ...base, reason: 'its run is alive' })
      else listed.push({ ...base, reason: 'its run has ended' })
    } else if (proc.ppid !== 1) kept.push({ ...base, reason: 'not orphaned' })
    else listed.push({ ...base, reason: 'orphaned test process' })
  }
  for (const root of roots) {
    if (!path.basename(root.path).startsWith(RUN_PREFIX) || root.ageHours < hours) continue
    const base = { path: root.path, ageHours: root.ageHours }
    if (runnerAlive(root.path)) kept.push({ ...base, reason: 'its run is alive' })
    else listed.push({ ...base, reason: 'its run has ended' })
  }
  return { listed, kept }
}

/** `[[dd-]hh:]mm:ss`, as ps prints an elapsed time, in seconds. */
export function parseEtime(text) {
  const [days, rest] = text.includes('-') ? text.split('-') : [0, text]
  const parts = rest.split(':').map(Number)
  const [h, m, s] = parts.length === 3 ? parts : [0, ...parts]
  return Number(days) * 86400 + h * 3600 + m * 60 + s
}

function linuxProcesses() {
  const uptime = Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0])
  const out = []
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    try {
      const command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ')
      if (!hasMarker(command)) continue
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      if (fields[0] === 'Z') continue
      const startSec = Number(fields[19]) / USER_HZ
      const env = {}
      for (const entry of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
        const eq = entry.indexOf('=')
        if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1)
      }
      out.push({
        pid,
        ppid: Number(fields[1]),
        ageHours: Math.max(0, uptime - startSec) / 3600,
        command,
        env,
      })
    } catch {
      // The process ended while it was read, or belongs to another user.
    }
  }
  return out
}

function psProcesses() {
  // ps -E appends each process's environment to its command: the KEY=value words are its run tag.
  const text = execFileSync('ps', ['-axww', '-E', '-o', 'pid=,ppid=,etime=,command='], { encoding: 'utf8' })
  const out = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!match) continue
    const [, pid, ppid, etime, command] = match
    if (!hasMarker(command)) continue
    const env = {}
    for (const word of command.split(' ')) {
      const eq = word.indexOf('=')
      if (/^[A-Z_][A-Z0-9_]*$/.test(word.slice(0, eq))) env[word.slice(0, eq)] = word.slice(eq + 1)
    }
    out.push({ pid: Number(pid), ppid: Number(ppid), ageHours: parseEtime(etime) / 3600, command, env })
  }
  return out
}

function listProcesses() {
  return process.platform === 'linux' ? linuxProcesses() : psProcesses()
}

function listRoots() {
  const tmp = os.tmpdir()
  const roots = []
  for (const name of fs.readdirSync(tmp)) {
    if (!name.startsWith(RUN_PREFIX)) continue
    try {
      const { mtimeMs } = fs.statSync(path.join(tmp, name))
      roots.push({ path: path.join(tmp, name), ageHours: (Date.now() - mtimeMs) / 3_600_000 })
    } catch {}
  }
  return roots
}

function runnerAlive(folder) {
  try {
    const pid = Number(fs.readFileSync(path.join(folder, 'runner.pid'), 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 && pidAlive(pid)
  } catch {
    return false
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** SIGTERM, then SIGKILL once the process has not ended after five seconds. */
async function stopProcess(pid) {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  const until = Date.now() + KILL_AFTER_MS
  while (Date.now() < until) {
    if (!pidAlive(pid)) return
    await sleep(100)
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {}
}

const hours = (h) => `${h.toFixed(1)}h`

function parseArgs(argv) {
  const out = { hours: DEFAULT_HOURS, kill: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--kill') out.kill = true
    else if (argv[i] === '--hours') {
      const n = Number(argv[++i])
      if (!(n >= 0) || argv[i] === undefined) return { problem: '--hours needs a number of hours, 0 or more' }
      out.hours = n
    } else return { problem: `unknown argument ${argv[i]}` }
  }
  return out
}

export async function main(argv) {
  const cfg = parseArgs(argv)
  if (cfg.problem) {
    process.stderr.write(
      `reap-test-leftovers: ${cfg.problem}\nusage: reap-test-leftovers.mjs [--hours <n>] [--kill]\n`,
    )
    return 2
  }
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    process.stderr.write('reap-test-leftovers: runs on Linux and macOS only; nothing listed\n')
    return 1
  }
  const { listed, kept } = classify({
    processes: listProcesses(),
    roots: listRoots(),
    hours: cfg.hours,
    runnerAlive,
  })
  for (const p of listed.filter((x) => x.pid !== undefined)) {
    process.stdout.write(`process ${p.pid}  ${hours(p.ageHours)}  ${p.reason}: ${p.command.slice(0, 160)}\n`)
  }
  for (const r of listed.filter((x) => x.path !== undefined)) {
    process.stdout.write(`folder  ${r.path}  ${hours(r.ageHours)}  ${r.reason}\n`)
  }
  process.stdout.write(`listed ${listed.length}, kept ${kept.length} (owned by a live run or not orphaned)\n`)
  if (!cfg.kill) {
    if (listed.length)
      process.stdout.write('nothing signalled or removed; rerun with --kill to stop and remove them\n')
    return 0
  }
  for (const p of listed.filter((x) => x.pid !== undefined)) await stopProcess(p.pid)
  for (const r of listed.filter((x) => x.path !== undefined)) {
    try {
      fs.rmSync(r.path, { recursive: true, force: true, maxRetries: 3 })
    } catch (err) {
      process.stderr.write(`reap-test-leftovers: could not remove ${r.path}: ${err.message}\n`)
    }
  }
  return 0
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
      process.stderr.write(`reap-test-leftovers: ${err.message}\n`)
      process.exitCode = 1
    },
  )
}
