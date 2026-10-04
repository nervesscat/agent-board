#!/usr/bin/env node
// Put the code in this checkout live: install dependencies, stop the board, build, start it again in
// the background and wait until it answers. Run it after `git pull`; it also starts a board that is
// not running.
//
//   pnpm redeploy
//
// Logs: data/logs/build.log, data/logs/board.out.log and data/logs/board.err.log.
//
// On Windows the build cannot replace .output while the board runs (the SQLite driver inside it is
// locked), so the board is down for the length of the build. The previous build is kept aside and
// started again if the new one fails. On Linux/WSL this hands over to scripts/start.sh --build.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)
const win = process.platform === 'win32'

function env(key, fallback) {
  const line = fs.existsSync('.env')
    ? fs
        .readFileSync('.env', 'utf8')
        .split(/\r?\n/)
        .find((l) => l.startsWith(`${key}=`))
    : undefined
  return line?.slice(key.length + 1).trim() || fallback
}
const port = Number(env('PORT', '47100'))
const host = env('HOST', '127.0.0.1')
const logs = path.join('data', 'logs')
fs.mkdirSync(logs, { recursive: true })

// Through the shell, so Windows finds pnpm's .cmd shim; the commands are fixed strings.
const run = (command, opts = {}) =>
  spawnSync(command, { stdio: 'inherit', shell: true, ...opts }).status === 0

console.log('Installing dependencies...')
if (!run('pnpm install --frozen-lockfile')) fail('pnpm install failed')

if (!win) {
  // start.sh already stops, rebuilds and restarts the board the Linux way.
  process.exit(spawnSync('bash', ['scripts/start.sh', '--build'], { stdio: 'inherit' }).status ?? 1)
}

/** PIDs listening on the board's port, from netstat (IPv4 and IPv6). */
function listeners() {
  const out =
    execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }) +
    execFileSync('netstat', ['-ano', '-p', 'tcpv6'], { encoding: 'utf8' })
  const pids = new Set()
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols[0] === 'TCP' && cols[1]?.endsWith(`:${port}`) && cols[3] === 'LISTENING')
      pids.add(Number(cols[4]))
  }
  pids.delete(0)
  return [...pids]
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function stop() {
  const pids = listeners()
  if (!pids.length) return
  console.log(`Stopping the board on :${port} (pid ${pids.join(', ')})`)
  for (const pid of pids) {
    try {
      process.kill(pid)
    } catch {
      // already gone
    }
  }
  for (let i = 0; i < 50 && listeners().length; i++) await sleep(100)
  if (listeners().length) fail(`something still listens on :${port}; stop it and run this again`)
}

function start() {
  const out = fs.openSync(path.join(logs, 'board.out.log'), 'a')
  const err = fs.openSync(path.join(logs, 'board.err.log'), 'a')
  spawn(process.execPath, ['--env-file-if-exists=.env', '.output/server/index.mjs'], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, err],
  }).unref()
}

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      // The gate answers 401 before anyone signs in; any answer means the board is up.
      await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(1000) })
      return true
    } catch {
      await sleep(500)
    }
  }
  return false
}

/** Windows can hold a file for a moment after the process that had it open exits. */
async function move(from, to) {
  for (let i = 0; ; i++) {
    try {
      return fs.renameSync(from, to)
    } catch (e) {
      if (i >= 20) throw e
      await sleep(250)
    }
  }
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

await stop()
const prev = '.output.prev'
fs.rmSync(prev, { recursive: true, force: true })
if (fs.existsSync('.output')) await move('.output', prev)

console.log(`Building (log in ${path.join(logs, 'build.log')})...`)
const log = fs.openSync(path.join(logs, 'build.log'), 'w')
const built = run('pnpm build', { stdio: ['ignore', log, log] })
if (!built) {
  fs.rmSync('.output', { recursive: true, force: true })
  if (fs.existsSync(prev)) {
    await move(prev, '.output')
    start()
    await waitUp()
    fail(`Build failed, see ${path.join(logs, 'build.log')}. The previous build is running again.`)
  }
  fail(`Build failed, see ${path.join(logs, 'build.log')}. Nothing is running.`)
}
fs.rmSync(prev, { recursive: true, force: true })

console.log(`Starting the board on http://localhost:${port}`)
start()
if (!(await waitUp())) fail(`The board did not answer on :${port}; see ${path.join(logs, 'board.err.log')}`)
console.log(`Up. Logs in ${path.join(logs, 'board.out.log')} and board.err.log`)
