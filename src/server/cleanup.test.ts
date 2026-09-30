import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp
const repo = path.join(tmp, 'repo')

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const commit = (file: string, text: string, msg: string) => {
  fs.writeFileSync(path.join(repo, file), text)
  git('add', file)
  git('commit', '-q', '-m', msg)
  return git('rev-parse', 'HEAD')
}

/**
 * dev ← fix/audit (the parent's branch) ← lanes:
 * - lane/merged: merged into fix/audit as is
 * - lane/rebased: cherry-picked onto fix/audit
 * - lane/edited: squashed into fix/audit with a tweak to the commit, same end result
 * - lane/unique: never landed
 * fix/audit itself is merged into dev.
 */
beforeAll(() => {
  fs.mkdirSync(repo)
  git('init', '-q', '-b', 'dev')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  commit('base.txt', 'base\n', 'base')
  git('checkout', '-q', '-b', 'fix/audit')
  commit('audit.txt', 'audit\n', 'audit')

  git('checkout', '-q', '-b', 'lane/merged')
  commit('merged.txt', 'merged\n', 'merged lane')
  git('checkout', '-q', 'fix/audit')
  git('merge', '-q', '--ff-only', 'lane/merged')

  git('checkout', '-q', '-b', 'lane/rebased', 'dev')
  commit('rebased.txt', 'rebased\n', 'rebased lane')
  git('checkout', '-q', 'fix/audit')
  git('cherry-pick', 'lane/rebased')

  git('checkout', '-q', '-b', 'lane/edited', 'dev')
  commit('edited.txt', 'first\n', 'edited lane 1')
  commit('edited.txt', 'second\n', 'edited lane 2')
  git('checkout', '-q', 'fix/audit')
  fs.writeFileSync(path.join(repo, 'edited.txt'), 'second\n')
  git('add', 'edited.txt')
  git('commit', '-q', '-m', 'edited lane, squashed')

  git('checkout', '-q', '-b', 'lane/unique', 'dev')
  commit('unique.txt', 'unique\n', 'unique lane')

  git('checkout', '-q', 'dev')
  git('merge', '-q', '--no-ff', '-m', 'merge fix/audit', 'fix/audit')
  git('worktree', 'add', '-q', path.join(tmp, 'wt-unique'), 'lane/unique')
  git('worktree', 'add', '-q', '-b', 'scratch', path.join(tmp, 'wt-scratch'), 'dev')
})

describe('branchReach', () => {
  it('tells merged, rebased, edited and unique work apart', async () => {
    const { branchReach } = await import('./git')
    const reach = (b: string, bases = ['fix/audit', 'dev']) => branchReach(repo, b, bases)
    expect(await reach('lane/merged')).toMatchObject({ state: 'merged', into: 'fix/audit' })
    expect(await reach('lane/rebased')).toMatchObject({ state: 'rebased', into: 'fix/audit', unique: [] })
    const edited = await reach('lane/edited')
    expect(edited).toMatchObject({ state: 'edited', into: 'fix/audit' })
    expect(edited!.unique.map((c) => c.subject)).toEqual(['edited lane 1', 'edited lane 2'])
    const unique = await reach('lane/unique')
    expect(unique).toMatchObject({ state: 'unique', into: 'fix/audit' })
    expect(unique!.unique.map((c) => c.subject)).toEqual(['unique lane'])
    // The parent's branch is in dev: the next link of the chain.
    expect(await reach('fix/audit', ['dev'])).toMatchObject({ state: 'merged', into: 'dev' })
    expect(await reach('lane/merged', ['nope', 'dev'])).toMatchObject({ state: 'merged', into: 'dev' })
  })
})

describe('cleanupReport', () => {
  it('lists closed tickets with what they left behind, checked against their base chain', async () => {
    const { db, schema } = await import('#/db')
    const features = await import('./features')
    const { cleanupReport } = await import('./cleanup')
    const projectId = db.insert(schema.projects).values({ name: 'p' }).returning().get().id
    db.insert(schema.repos).values({ projectId, name: 'repo', repoPath: repo, baseBranch: 'dev' }).run()
    const parent = features.createTicket(
      projectId,
      { title: 'audit', branch: 'fix/audit', status: 'done', baseBranch: 'dev' },
      'claude',
    )
    const lane = (title: string, branch: string, status: string) =>
      features.createTicket(projectId, { title, branch, status, parentId: parent.id }, 'claude')
    lane('merged', 'lane/merged', 'done')
    lane('edited', 'lane/edited', 'cancelled')
    const unique = lane('unique', 'lane/unique', 'done')
    lane('open', 'lane/rebased', 'in_progress')
    features.addWorkspace(
      unique.id,
      { name: 'wt', branch: 'lane/unique', path: path.join(tmp, 'wt-unique') },
      'claude',
    )

    const report = await cleanupReport(projectId)
    const byTitle = Object.fromEntries(report.tickets.map((t) => [t.title, t]))
    expect(Object.keys(byTitle).sort()).toEqual(['audit', 'edited', 'merged', 'unique'])
    expect(byTitle.edited!.chain).toEqual(['fix/audit', 'dev'])
    expect(byTitle.audit!.branches[0]!.reach).toMatchObject({ state: 'merged', into: 'dev' })
    expect(byTitle.edited!.branches[0]!.reach?.state).toBe('edited')
    expect(byTitle.edited!.safe).toBe(true)
    expect(byTitle.unique!.safe).toBe(false)
    expect(byTitle.unique!.branches[0]!.worktrees).toEqual([
      { path: path.join(tmp, 'wt-unique'), main: false },
    ])
    expect(byTitle.merged!.branches[0]!.restore).toBe(
      `git branch lane/merged ${git('rev-parse', 'lane/merged')}`,
    )
    expect(report.untracked.map((w) => w.branch)).toEqual(['scratch'])
    expect(report.counts).toMatchObject({ tickets: 4, workspaces: 1, worktrees: 1, branches: 4, remote: 0 })

    const quick = await cleanupReport(projectId, { reach: false })
    expect(quick.tickets.every((t) => t.branches.every((b) => b.reach === null))).toBe(true)

    const g = await features.ticketGit(unique.id)
    expect(g.info.reach?.state).toBe('unique')
    expect(g.workspaces[0]!.info.reach?.state).toBe('unique')
  })
})
