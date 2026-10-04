#!/usr/bin/env node
// The hot-reload copy of the board, next to the built one in daily use: its own port and its own data,
// so it never answers on the live board's address or writes into its database. The first run copies
// the live database and uploads into data/dev; --fresh copies them again. Run from a git worktree, it
// copies them from the main checkout, the only one with a data/ folder, so a branch's preview shows the
// real board.
//
//   pnpm dev            # the first free port from 47101, or DEV_PORT
//   pnpm dev --fresh    # start over from a copy of the live data
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)

/** The main checkout: this folder, or the one a worktree was made from. */
function mainCheckout() {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
    }).trim()
    return path.dirname(common)
  } catch {
    return root
  }
}

/** Free on both loopbacks: Vite binds `localhost`, which may be ::1 while the built board holds 127.0.0.1. */
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

const port = await pickPort()
const live = path.join(mainCheckout(), 'data')
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

console.log(`Preview: http://localhost:${port} (a copy of the data, in ${path.join(root, dev)})`)
// PORT has to be set here: the PORT in .env would otherwise win over --port.
const child = spawn(`pnpm exec vite dev --port ${port} --strictPort`, {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, PORT: String(port), BOARD_URL: `http://localhost:${port}`, DATA_DIR: `./${dev}` },
})
child.on('exit', (code) => process.exit(code ?? 0))
