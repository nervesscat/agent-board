#!/usr/bin/env node
// The hot-reload copy of the board, next to the built one in daily use: its own port and its own data,
// so it never answers on the live board's address or writes into its database. The first run copies
// the live database and uploads into data/dev; --fresh copies them again.
//
//   pnpm dev            # http://localhost:47101 (DEV_PORT to change it)
//   pnpm dev --fresh    # start over from a copy of the live data
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)

const port = Number(process.env.DEV_PORT || 47101)
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error(`DEV_PORT must be a port, got ${port}`)
const live = 'data'
const dev = path.join('data', 'dev')

if (process.argv.includes('--fresh')) fs.rmSync(dev, { recursive: true, force: true })
if (!fs.existsSync(path.join(dev, 'board.db')) && fs.existsSync(path.join(live, 'board.db'))) {
  console.log(`Copying the live data into ${dev}...`)
  fs.mkdirSync(dev, { recursive: true })
  // A backup, not a file copy: the live database is in WAL mode and may be open.
  const db = new Database(path.join(live, 'board.db'), { readonly: true })
  await db.backup(path.join(dev, 'board.db'))
  db.close()
  if (fs.existsSync(path.join(live, 'uploads')))
    fs.cpSync(path.join(live, 'uploads'), path.join(dev, 'uploads'), { recursive: true })
}

// PORT has to be set here: the PORT in .env would otherwise win over --port.
const child = spawn(`pnpm exec vite dev --port ${port} --strictPort`, {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, PORT: String(port), BOARD_URL: `http://localhost:${port}`, DATA_DIR: `./${dev}` },
})
child.on('exit', (code) => process.exit(code ?? 0))
