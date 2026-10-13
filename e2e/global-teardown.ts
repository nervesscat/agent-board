import fs from 'node:fs'
import path from 'node:path'

import { END_BUILD, e2eEnv } from './env'

/**
 * The run's throwaway folder. A never-ending build a test could not stop is told to end first. The board
 * may still hold its database open (Windows): then it stays in tmp.
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
  try {
    fs.rmSync(e2eEnv().root, { recursive: true, force: true, maxRetries: 3 })
  } catch {}
}
