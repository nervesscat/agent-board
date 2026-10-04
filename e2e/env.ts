import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Where this e2e run's board lives. Worked out once, in the runner, and handed to the workers (and to
 * a second load of the config) through the environment: a loopback port above 47140 that nothing
 * holds, and a throwaway folder for the board's data and the git repo it reads.
 */
export function e2eEnv() {
  process.env.E2E_PORT ||= freePort()
  process.env.E2E_ROOT ||= fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-e2e-'))
  const root = process.env.E2E_ROOT
  return {
    port: Number(process.env.E2E_PORT),
    baseURL: `http://127.0.0.1:${process.env.E2E_PORT}`,
    root,
    dataDir: path.join(root, 'data'),
    repoPath: path.join(root, 'repo'),
    seedFile: path.join(root, 'seed.json'),
  }
}

/** The human the browser is (no X-Test-Actor header) and the API calls name. */
export const HUMAN = 'enrique'
export const AGENT = 'claude'

// Synchronous, since the config is: a child process tries each port in turn and prints the first free one.
function freePort(): string {
  const probe = `
    const net = require('node:net')
    const tryPort = (p) => {
      if (p > 47199) process.exit(1)
      const s = net.createServer()
      s.once('error', () => tryPort(p + 1))
      s.listen(p, '127.0.0.1', () => s.close(() => console.log(p)))
    }
    tryPort(47141 + Math.floor(Math.random() * 40))`
  const out = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' })
  const port = out.stdout.trim()
  if (out.status !== 0 || !port) throw new Error('no free port between 47141 and 47199 for the e2e board')
  return port
}
