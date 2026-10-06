#!/usr/bin/env node
// A hot-reload copy of the board for a branch, run in its worktree: its own port and its own data,
// so it never answers on the board's address or writes into its database. The first run copies the
// board's database and uploads from the main checkout into data/dev; --fresh copies them again. In
// the main checkout it refuses: that checkout is the board itself (`pnpm start`, hot reload too), and
// a second copy there is a second board people end up using by mistake.
//
//   pnpm dev            # the first free port from 47101, or DEV_PORT
//   pnpm dev --fresh    # start over from a copy of the live data
//   AUTH=off pnpm dev   # without the passkey gate: every request is the human (README: "Test mode")
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'

import { isMainCheckout, mainCheckout } from './checkout.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)

/** Free on both loopbacks: Vite binds `localhost`, which may be ::1 while the board holds 127.0.0.1. */
async function isFree(port) {
  for (const host of ['127.0.0.1', '::1']) {
    const ok = await new Promise((resolve) => {
      const probe = net.createServer()
      probe.once('error', (e) => resolve(e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT'))
      probe.once('listening', () => probe.close(() => resolve(true)))
      probe.listen(port, host)
    })
    if (!ok) return false
  }
  return true
}

async function pickPort() {
  if (process.env.DEV_PORT) {
    const port = Number(process.env.DEV_PORT)
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error(`DEV_PORT must be a port, got ${process.env.DEV_PORT}`)
    return port
  }
  for (let port = 47101; port < 47200; port++) if (await isFree(port)) return port
  throw new Error('no free port between 47101 and 47199; set DEV_PORT')
}

if (isMainCheckout(root)) {
  console.error(
    'This checkout is the board itself: `pnpm start` runs it on :47100 with hot reload. `pnpm dev` is ' +
      'for a branch, in its worktree: git worktree add ../agent-board-<branch> <branch>',
  )
  process.exit(1)
}

const port = await pickPort()
const live = path.join(mainCheckout(root), 'data')
const dev = path.join('data', 'dev')

if (process.argv.includes('--fresh')) fs.rmSync(dev, { recursive: true, force: true })
if (!fs.existsSync(path.join(dev, 'board.db')) && fs.existsSync(path.join(live, 'board.db'))) {
  console.log(`Copying the live data from ${live} into ${dev}...`)
  fs.mkdirSync(dev, { recursive: true })
  // A backup, not a file copy: the live database is in WAL mode and may be open.
  const db = new Database(path.join(live, 'board.db'), { readonly: true })
  await db.backup(path.join(dev, 'board.db'))
  db.close()
  if (fs.existsSync(path.join(live, 'uploads')))
    fs.cpSync(path.join(live, 'uploads'), path.join(dev, 'uploads'), { recursive: true })
}

console.log(`Preview: http://localhost:${port} (a copy of the board's data, in ${path.join(root, dev)})`)
// PORT has to be set here: the PORT in .env would otherwise win over --port. BOARD_ENV is always
// development, whatever the shell says; AUTH (off turns the gate off) comes through as it is.
// BOARD_DATA_COPY keeps the copy from deleting files in an S3 bucket it shares with the live board.
const child = spawn(`pnpm exec vite dev --port ${port} --strictPort`, {
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    BOARD_ENV: 'development',
    PORT: String(port),
    BOARD_URL: `http://localhost:${port}`,
    DATA_DIR: `./${dev}`,
    BOARD_DATA_COPY: '1',
  },
})
child.on('exit', (code) => process.exit(code ?? 0))
