#!/usr/bin/env node
// Build a merge train: several approved pull requests merged, in order, into one branch made from the
// base. The train is pushed as a branch of its own, and one pull request from it into the base runs the
// checks once on the combined tree; landing that pull request lands the whole batch.
//
//   node scripts/merge-batch.mjs <batch.json> [--remote origin] [--base dev] [--train merge-train/<name>] [--push]
//
// batch.json lists the pull requests in the order of the approved column, top first:
//   [{ "pr": 12, "branch": "fix-x", "needs": [] }, ...]
// `needs` names the numbers of other entries that must merge first; the order is those, then the list's
// order. Each branch is merged into the train with --no-ff, in that order.
// The default train name carries the head of the base it was built from, so a train rebuilt after the base
// moved gets a new name and never has to replace the old branch. Without --push nothing leaves this machine:
// the train is built, checked and reported, then discarded.
//
// Exit codes: 0 built (pushed with --push), or --help, which prints the usage; 1 anything else; 2 the input
// is wrong (an unreadable or malformed batch file, a missing file name, a bad needs list); 3 a pull request
// conflicts with the train built so far
// (drop it, or rebase it onto the base, then run again); 4 the migrations do not check on the train (drop
// the newest entry named in the message, then run again).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkMigrations } from './check-migrations.mjs'

export class BatchError extends Error {
  constructor(message, { code, pr } = {}) {
    super(message)
    this.name = 'BatchError'
    this.code = code
    this.pr = pr
  }
}

const EXIT_CODES = { input: 2, conflict: 3, migrations: 4 }
const USAGE =
  'usage: merge-batch.mjs <batch.json> [--remote <name>] [--base <branch>] [--train merge-train/<name>] [--push]'

/** The batch in merge order: each entry after the entries it needs, otherwise in the list's order. */
export function orderBatch(entries) {
  if (!Array.isArray(entries) || entries.length === 0)
    throw new BatchError('the batch is empty', { code: 'input' })
  const byPr = new Map()
  for (const e of entries) {
    if (!e || !Number.isInteger(e.pr) || typeof e.branch !== 'string' || e.branch === '')
      throw new BatchError(`an entry needs an integer pr and a branch: ${JSON.stringify(e)}`, {
        code: 'input',
      })
    if (byPr.has(e.pr)) throw new BatchError(`PR #${e.pr} is listed twice`, { code: 'input', pr: e.pr })
    if (e.needs !== undefined && (!Array.isArray(e.needs) || !e.needs.every(Number.isInteger)))
      throw new BatchError(`PR #${e.pr}: needs must be a list of PR numbers`, { code: 'input', pr: e.pr })
    byPr.set(e.pr, { pr: e.pr, branch: e.branch, needs: e.needs ?? [] })
  }
  for (const e of byPr.values())
    for (const n of e.needs)
      if (!byPr.has(n))
        throw new BatchError(`PR #${e.pr} needs #${n}, which is not in the batch`, {
          code: 'input',
          pr: e.pr,
        })

  const ordered = []
  const placed = new Set()
  let pending = [...byPr.values()]
  while (pending.length > 0) {
    const next = pending.find((e) => e.needs.every((n) => placed.has(n)))
    if (!next)
      throw new BatchError(`the needs of PR #${pending[0].pr} form a cycle`, {
        code: 'input',
        pr: pending[0].pr,
      })
    ordered.push(next)
    placed.add(next.pr)
    pending = pending.filter((e) => e !== next)
  }
  return ordered
}

/** The default train name for a batch built on `baseHead`: its PR numbers, then the base's short head. */
export function trainName(ordered, baseHead) {
  return `merge-train/prs-${ordered.map((e) => e.pr).join('-')}-${baseHead.slice(0, 7)}`
}

/** The batch file, read and parsed; an unreadable or malformed file is bad input. */
export function readBatch(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    throw new BatchError(`cannot read the batch file ${file}: ${err instanceof Error ? err.message : err}`, {
      code: 'input',
    })
  }
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new BatchError(`the batch file ${file} is not JSON: ${err instanceof Error ? err.message : err}`, {
      code: 'input',
    })
  }
}

function git(cwd, args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=merge-batch', '-c', 'user.email=merge-batch@example.invalid', ...args],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim()
}

/**
 * Build the train in a temporary worktree of `repo`: the base, then each entry's branch merged with
 * --no-ff in order. Returns the train's head, the base it was built on and the merges. The worktree and
 * its folder are removed on every path.
 */
export function buildTrain({ repo, remote = 'origin', base = 'dev', entries }) {
  const ordered = orderBatch(entries)
  git(repo, ['fetch', remote, `+refs/heads/${base}:refs/remotes/${remote}/${base}`])
  const baseHead = git(repo, ['rev-parse', `${remote}/${base}`])
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-batch-'))
  const tree = path.join(dir, 'train')
  try {
    git(repo, ['worktree', 'add', '--detach', tree, baseHead])
    const merged = []
    for (const e of ordered) {
      git(tree, ['fetch', remote, e.branch])
      const sha = git(tree, ['rev-parse', 'FETCH_HEAD'])
      try {
        git(tree, [
          'merge',
          '--no-ff',
          '--no-edit',
          '-m',
          `Merge ${e.branch} (PR #${e.pr}) into the merge train`,
          sha,
        ])
      } catch {
        try {
          git(tree, ['merge', '--abort'])
        } catch {
          // No merge in progress: nothing to abort.
        }
        throw new BatchError(`PR #${e.pr} (${e.branch}) conflicts with the train built so far`, {
          code: 'conflict',
          pr: e.pr,
        })
      }
      merged.push({ pr: e.pr, branch: e.branch, sha })
    }
    const drizzle = path.join(tree, 'drizzle')
    if (fs.existsSync(drizzle)) {
      const problems = checkMigrations(drizzle)
      if (problems.length > 0) {
        // Blame the newest entry that touches the migrations folder: it is the one to drop.
        const touching = ordered.filter((e) => touchesMigrations(tree, baseHead, e.branch, remote))
        const blame = touching.at(-1)
        throw new BatchError(
          `the migrations do not check on the train: ${problems.join('; ')}` +
            (blame
              ? `; drop PR #${blame.pr} (${blame.branch}), the newest entry that touches the migrations`
              : ''),
          { code: 'migrations', pr: blame?.pr },
        )
      }
    }
    return { head: git(tree, ['rev-parse', 'HEAD']), base: baseHead, merged }
  } finally {
    try {
      git(repo, ['worktree', 'remove', '--force', tree])
    } catch {
      // Removed below.
    }
    fs.rmSync(dir, { recursive: true, force: true })
    git(repo, ['worktree', 'prune'])
  }
}

/** Whether a branch changes files in the migrations folder, against the base it was built on. */
function touchesMigrations(tree, baseHead, branch, remote) {
  git(tree, ['fetch', remote, branch])
  const sha = git(tree, ['rev-parse', 'FETCH_HEAD'])
  return git(tree, ['diff', '--name-only', `${baseHead}...${sha}`, '--', 'drizzle']).length > 0
}

/** Push the train's head to a branch of its own. Refuses the base and anything outside merge-train/. */
export function pushTrain({ repo, remote = 'origin', train, head }) {
  if (!/^merge-train\/[\w./-]+$/.test(train) || train.includes('..'))
    throw new BatchError(`the train branch must be merge-train/<name>, not ${train}`, { code: 'input' })
  if (git(repo, ['ls-remote', '--heads', remote, `refs/heads/${train}`]) !== '')
    throw new BatchError(
      `${train} is already on ${remote}: a train is never replaced. Delete that branch to rebuild it, or give this batch another name with --train`,
      { code: 'input' },
    )
  git(repo, ['push', remote, `${head}:refs/heads/${train}`])
}

/** Whether `argv1` (process.argv[1]) is this module's file, following symbolic links. */
export function isEntrypoint(argv1, moduleUrl) {
  if (!argv1) return false
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}

export function parseArgs(argv) {
  const opts = { remote: 'origin', base: 'dev', train: undefined, push: false, file: undefined, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = () => {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--'))
        throw new BatchError(`${a} needs a value\n${USAGE}`, { code: 'input' })
      return v
    }
    if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--push') opts.push = true
    else if (a === '--remote') opts.remote = value()
    else if (a === '--base') opts.base = value()
    else if (a === '--train') opts.train = value()
    else if (opts.file === undefined && !a.startsWith('--')) opts.file = a
    else throw new BatchError(`unexpected argument ${a}\n${USAGE}`, { code: 'input' })
  }
  if (!opts.help && !opts.file) throw new BatchError(USAGE, { code: 'input' })
  return opts
}

function main(argv) {
  const opts = parseArgs(argv)
  if (opts.help) {
    console.log(USAGE)
    return
  }
  const entries = readBatch(opts.file)
  const repo = process.cwd()
  const built = buildTrain({ repo, remote: opts.remote, base: opts.base, entries })
  const train = opts.train ?? trainName(orderBatch(entries), built.base)
  console.log(
    `Train ${train} from ${opts.remote}/${opts.base} at ${built.base.slice(0, 7)}, head ${built.head}`,
  )
  for (const m of built.merged) console.log(`  merged PR #${m.pr} (${m.branch}) at ${m.sha}`)
  if (opts.push) {
    pushTrain({ repo, remote: opts.remote, train, head: built.head })
    console.log(
      `Pushed ${train}. Open one pull request from it into ${opts.base}; its checks run once on the combined tree.`,
    )
  } else {
    console.log('Not pushed (no --push). Rerun with --push to publish the train branch.')
  }
}

if (isEntrypoint(process.argv[1], import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    if (err instanceof BatchError) {
      console.error(err.message)
      process.exit(EXIT_CODES[err.code] ?? 1)
    }
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }
}
