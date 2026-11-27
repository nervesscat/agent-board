import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { END_BUILD, e2eEnv } from './env'

/**
 * The run's throwaway folder, and every process the run started. A never-ending build a test could not
 * stop is told to end first. Each process the run started carries this run's E2E_ROOT in its environment
 * (the runner sets it, and children inherit it): those are stopped, SIGTERM and then SIGKILL after five
 * seconds. A folder that still cannot be removed (Windows keeps a database open) is reported, not ignored:
 * the test-run reaper removes it later.
 */
export default async function globalTeardown() {
  const { root } = e2eEnv()
  let worktrees: string[] = []
  try {
    worktrees = fs.readdirSync(root).filter((name) => name.startsWith('wt-'))
  } catch {}
  for (const name of worktrees)
    try {
      fs.writeFileSync(path.join(root, name, END_BUILD), '')
    } catch {}
  // A build looks for it every 200 ms.
  if (worktrees.length) await new Promise((resolve) => setTimeout(resolve, 500))
  await stopRunProcesses(root)
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  } catch (err) {
    console.error(
      `e2e: the run folder ${root} could not be removed (${(err as Error).message}); the test-run reaper will remove it`,
    )
  }
}

const runningPid = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  // A zombie has ended; it only waits for its parent to collect it.
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z'
  } catch {
    return true
  }
}

/** The pids of the processes started under this run's root, other than this runner. */
function runPids(root: string): number[] {
  const self = process.pid
  const tag = `E2E_ROOT=${root}`
  const pids: number[] = []
  if (process.platform === 'linux') {
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue
      try {
        const env = fs.readFileSync(`/proc/${name}/environ`, 'utf8').split('\0')
        if (env.includes(tag) && Number(name) !== self) pids.push(Number(name))
      } catch {}
    }
  } else if (process.platform === 'darwin') {
    const listing = execFileSync('ps', ['-axww', '-E', '-o', 'pid=,command='], { encoding: 'utf8' })
    for (const line of listing.split('\n')) {
      const match = /^\s*(\d+)\s/.exec(line)
      if (!match || Number(match[1]) === self) continue
      if (line.split(' ').includes(tag)) pids.push(Number(match[1]))
    }
  }
  return pids
}

async function stopRunProcesses(root: string) {
  if (process.platform === 'win32') {
    console.error(
      'e2e: stopping the run processes is not supported on Windows; the test-run reaper will stop them',
    )
    return
  }
  const pids = runPids(root)
  for (const pid of pids)
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
  const until = Date.now() + 5000
  while (Date.now() < until && pids.some(runningPid)) await new Promise((resolve) => setTimeout(resolve, 100))
  for (const pid of pids.filter(runningPid))
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
}
