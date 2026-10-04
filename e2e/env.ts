import { execFileSync, spawnSync } from 'node:child_process'
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
    /** The repo's origin: a bare repo, so branches can be pushed or not. */
    originPath: path.join(root, 'origin.git'),
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

/** Runs git in the run's repo (as a fixed author), and answers what it printed. */
export function git(...args: string[]): string {
  return gitWith('', args)
}

function gitWith(input: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...args], {
    cwd: e2eEnv().repoPath,
    encoding: 'utf8',
    input,
  })
}

/**
 * A commit on top of `parent` whose tree is one file, made without touching the repo's working tree
 * (tests run side by side in it); answers its sha.
 */
export function commitFile(parent: string, file: string, content: string, message: string): string {
  const blob = gitWith(content, ['hash-object', '-w', '--stdin']).trim()
  const tree = gitWith(`100644 blob ${blob}\t${file}\n`, ['mktree']).trim()
  return git('commit-tree', tree, '-p', parent, '-m', message).trim()
}
