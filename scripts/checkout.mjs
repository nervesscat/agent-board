// Which checkout a script runs in: the board runs from the main checkout only, previews of a branch
// from its worktree (git worktree add ../agent-board-<branch> <branch>).
import { execFileSync } from 'node:child_process'
import path from 'node:path'

/** The main checkout: `root` itself, or the one the worktree at `root` was made from. */
export function mainCheckout(root) {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
    return path.dirname(common)
  } catch {
    return root
  }
}

/** Whether `root` is the main checkout rather than a worktree of it. */
export function isMainCheckout(root) {
  const norm = (p) => {
    const abs = path.resolve(p)
    return process.platform === 'win32' ? abs.toLowerCase() : abs
  }
  return norm(mainCheckout(root)) === norm(root)
}
