import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp
const repo = path.join(tmp, 'repo')

const gitIn =
  (cwd: string) =>
  (...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const commitIn = (cwd: string) => (file: string, text: string, msg: string) => {
  const git = gitIn(cwd)
  fs.writeFileSync(path.join(cwd, file), text)
  git('add', file)
  git('commit', '-q', '-m', msg)
  return git('rev-parse', 'HEAD')
}
const git = gitIn(repo)
const commit = commitIn(repo)

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
    // git lists worktree paths with forward slashes, also on Windows.
    const worktrees = byTitle.unique!.branches[0]!.worktrees.map((w) => ({
      ...w,
      path: path.resolve(w.path),
    }))
    expect(worktrees).toEqual([{ path: path.join(tmp, 'wt-unique'), main: false }])
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

describe('cleanupReport on detached worktrees', () => {
  it('accounts for a worktree checked out detached at a ticket branch commit', async () => {
    const { db, schema } = await import('#/db')
    const features = await import('./features')
    const { cleanupReport } = await import('./cleanup')
    const dir = path.join(tmp, 'detached')
    const git = gitIn(dir)
    const commit = commitIn(dir)
    const at = (name: string) => path.join(tmp, name)
    const detach = (name: string, sha: string) => git('worktree', 'add', '-q', '--detach', at(name), sha)
    // The way a workspace may be registered: other slashes, other case, a trailing separator.
    const odd = (p: string) => `${p.replace(/\//g, '\\').toUpperCase()}\\`

    fs.mkdirSync(dir)
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    const base = commit('base.txt', 'base\n', 'base')
    const branch = (name: string, from: string, file: string) => {
      git('checkout', '-q', '-B', name, from)
      return commit(file, `${name}\n`, name)
    }
    const reviewed = branch('feat/open', 'main', 'open.txt')
    const ui = branch('feat/open-ui', 'feat/open', 'ui.txt')
    // Only origin has it.
    const remoteOnly = branch('feat/remote', 'main', 'remote.txt')
    git('update-ref', 'refs/remotes/origin/feat/remote', remoteOnly)
    // Origin's copy is the reviewed one; the local branch was started over elsewhere.
    const both = branch('feat/both', 'main', 'both.txt')
    git('update-ref', 'refs/remotes/origin/feat/both', both)
    branch('feat/both', 'main', 'both-again.txt')
    const done = branch('feat/done', 'main', 'done.txt')
    branch('feat/reg', 'main', 'reg.txt')
    branch('unnamed', 'main', 'unnamed.txt')
    const other = branch('other', 'main', 'other.txt')
    git('checkout', '-q', '--detach', 'other')
    git('branch', '-D', 'feat/remote')
    // A commit on no branch at all.
    const dangling = git('commit-tree', `${base}^{tree}`, '-p', base, '-m', 'dangling')

    detach('wt-tip', reviewed)
    detach('wt-ui', ui)
    detach('wt-remote', remoteOnly)
    detach('wt-both', both)
    detach('wt-done', done)
    detach('wt-main', base)
    detach('wt-other', other)
    detach('wt-dangling', dangling)
    detach('wt-reg-open', other)
    git('worktree', 'add', '-q', at('wt-reg-closed'), 'unnamed')

    const projectId = db.insert(schema.projects).values({ name: 'detached' }).returning().get().id
    db.insert(schema.repos).values({ projectId, name: 'detached', repoPath: dir, baseBranch: 'main' }).run()
    const ticket = (title: string, branch: string, status: string) =>
      features.createTicket(projectId, { title, branch, status, baseBranch: 'main' }, 'claude')
    const open = ticket('open', 'feat/open', 'in_progress')
    features.addWorkspace(open.id, { name: 'ui', branch: 'feat/open-ui', path: at('ui-elsewhere') }, 'claude')
    features.addWorkspace(
      open.id,
      { name: 'review', branch: 'feat/open', path: odd(at('wt-reg-open')) },
      'claude',
    )
    ticket('remote', 'feat/remote', 'in_progress')
    ticket('both', 'feat/both', 'in_progress')
    ticket('done', 'feat/done', 'done')
    const reg = ticket('reg', 'feat/reg', 'done')
    features.addWorkspace(
      reg.id,
      { name: 'wt', branch: 'feat/reg', path: odd(at('wt-reg-closed')) },
      'claude',
    )

    type Report = Awaited<ReturnType<typeof cleanupReport>>
    // git lists worktree paths with forward slashes, also on Windows.
    const untracked = (r: Report) => r.untracked.map((w) => path.resolve(w.path)).sort()
    const rows = (r: Report) =>
      Object.fromEntries(
        r.tickets.flatMap((t) =>
          t.branches.map((b) => [b.name, b.worktrees.map((w) => ({ ...w, path: path.resolve(w.path) }))]),
        ),
      )
    const stray = ['wt-dangling', 'wt-main', 'wt-other'].map(at).sort()

    const report = await cleanupReport(projectId)
    expect(untracked(report)).toEqual(stray)
    const heads = Object.fromEntries(report.untracked.map((w) => [path.resolve(w.path), w]))
    // At main's tip: every ticket branch holds it, but so do their bases.
    expect(heads[at('wt-main')]).toMatchObject({ repo: 'detached', branch: null, head: base })
    expect(heads[at('wt-other')]).toMatchObject({ branch: null, head: other })
    expect(heads[at('wt-dangling')]).toMatchObject({ branch: null, head: dangling })
    // The repo's own checkout is never a stray worktree, whatever it has checked out.
    expect(untracked(report)).not.toContain(path.resolve(dir))
    // A closed ticket lists the worktree reviewing its branch, and the one registered on it.
    expect(report.tickets.map((t) => t.title).sort()).toEqual(['done', 'reg'])
    expect(rows(report)).toEqual({
      'feat/done': [{ path: at('wt-done'), main: false }],
      'feat/reg': [{ path: at('wt-reg-closed'), main: false }],
    })
    expect(report.counts).toMatchObject({ tickets: 2, worktrees: 2, branches: 2, remote: 0 })
    expect(untracked(await cleanupReport(projectId, { reach: false }))).toEqual(stray)

    // The branch moved on after the review: the worktree still holds the ticket's work.
    git('checkout', '-q', 'feat/open')
    commit('open.txt', 'more\n', 'after review')
    git('checkout', '-q', '--detach', 'other')
    expect(untracked(await cleanupReport(projectId))).toEqual(stray)
    expect(untracked(await cleanupReport(projectId, { reach: false }))).toEqual(stray)

    // Once that commit is in the base it is no ticket's own work any more.
    git('update-ref', 'refs/heads/main', 'feat/open')
    const landed = [...stray, at('wt-tip')].sort()
    expect(untracked(await cleanupReport(projectId))).toEqual(landed)
    expect(untracked(await cleanupReport(projectId, { reach: false }))).toEqual(landed)

    // A head git cannot read leaves the worktree untracked rather than failing the report.
    const missing = '1'.repeat(40)
    detach('wt-missing', other)
    fs.writeFileSync(path.join(dir, '.git', 'worktrees', 'wt-missing', 'HEAD'), `${missing}\n`)
    const broken = await cleanupReport(projectId)
    expect(untracked(broken)).toEqual([...landed, at('wt-missing')].sort())
    expect(broken.untracked.find((w) => path.resolve(w.path) === at('wt-missing'))?.head).toBe(missing)
  })
})
