#!/usr/bin/env node
// The board: one copy, from the main checkout, on PORT (47100) from .env, with hot reload (`vite dev`)
// on the real data in DATA_DIR. Code on main reaches it by `git pull` alone; a pull that changes
// dependencies or adds a migration needs `pnpm start` again (migrations apply as it starts).
//
//   pnpm start          # stop the board, install, start it in the background, wait until it answers
//   pnpm start --fg     # the same in the foreground (Ctrl+C stops it)
//   pnpm stop           # just stop it
//
// Logs: data/logs/board.out.log and data/logs/board.err.log. It always runs as production, so it
// always requires sign-in, whatever BOARD_ENV or AUTH the shell has (AUTH=off is refused at startup).
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { isMainCheckout } from './checkout.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)
const win = process.platform === 'win32'
const args = process.argv.slice(2)
for (const arg of args)
  if (!['--fg', '--stop'].includes(arg)) fail(`unknown option ${arg}; use --fg or --stop`)

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function fail(message) {
  console.error(message)
  process.exit(1)
}

/** PIDs listening on the board's port: netstat on Windows, ss (or lsof) elsewhere. */
function listeners() {
  const pids = new Set()
  if (win) {
    const out =
      execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }) +
      execFileSync('netstat', ['-ano', '-p', 'tcpv6'], { encoding: 'utf8' })
    for (const line of out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/)
      if (cols[0] === 'TCP' && cols[1]?.endsWith(`:${port}`) && cols[3] === 'LISTENING')
        pids.add(Number(cols[4]))
    }
  } else {
    const ss = spawnSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' })
    if (ss.status === 0) for (const m of ss.stdout.matchAll(/pid=(\d+)/g)) pids.add(Number(m[1]))
    else {
      const lsof = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
      for (const pid of (lsof.stdout ?? '').split(/\s+/)) if (pid) pids.add(Number(pid))
    }
  }
  pids.delete(0)
  return [...pids]
}

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

/** The board always requires sign-in, whatever BOARD_ENV or AUTH the shell running this has. */
function boardEnv() {
  const e = { ...process.env, BOARD_ENV: 'production', PORT: String(port), HOST: host }
  for (const key of ['AUTH', 'DEV_HUMAN', 'TEST_HUMAN', 'BOARD_DATA_COPY']) delete e[key]
  return e
}

const vite = [
  path.join('node_modules', 'vite', 'bin', 'vite.js'),
  'dev',
  '--host',
  host,
  '--port',
  String(port),
  '--strictPort',
]

async function waitUp() {
  for (let i = 0; i < 120; i++) {
    try {
      // The board sends a browser to /setup or /login before anyone signs in; any answer means it is up.
      await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(2000) })
      return true
    } catch {
      await sleep(500)
    }
  }
  return false
}

if (!isMainCheckout(root))
  fail(
    'The board runs from the main checkout only. In a worktree, try the branch with a preview: ' +
      "Start on the ticket's Preview card (start_preview), or `pnpm dev` for your own copy.",
  )

await stop()
if (args.includes('--stop')) process.exit(0)

// After the stop: on Windows a running board holds the SQLite driver in node_modules open.
// Through the shell, so Windows finds pnpm's .cmd shim; the command is a fixed string.
console.log('Installing dependencies...')
if (spawnSync('pnpm install --frozen-lockfile', { stdio: 'inherit', shell: true }).status !== 0)
  fail('pnpm install failed; the board is not running')

if (args.includes('--fg')) {
  const child = spawn(process.execPath, vite, { stdio: 'inherit', env: boardEnv() })
  child.on('exit', (code) => process.exit(code ?? 0))
} else {
  fs.mkdirSync(logs, { recursive: true })
  const out = fs.openSync(path.join(logs, 'board.out.log'), 'a')
  const err = fs.openSync(path.join(logs, 'board.err.log'), 'a')
  spawn(process.execPath, vite, {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, err],
    env: boardEnv(),
  }).unref()
  console.log(`Starting the board on http://localhost:${port}`)
  if (!(await waitUp())) fail(`The board did not answer on :${port}; see ${path.join(logs, 'board.err.log')}`)
  console.log(`Up, with hot reload. Logs in ${path.join(logs, 'board.out.log')} and board.err.log`)
}
