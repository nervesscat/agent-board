import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

import type { CleanupReport } from './cleanup'

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

/** A commit putting `file` with `text` on top of `from` (a ref or sha; none for a root) and moving `ref` to it. */
interface Commit {
  ref: string
  from?: string
  file: string
  text: string
  msg: string
}
/**
 * Makes `commits` in order in one git process, without touching any checkout (a git process per step
 * makes a test slow on Windows). Returns their shas, in the same order.
 */
const commitsIn = (cwd: string) => (commits: Commit[]) => {
  const marks = path.join(cwd, '.git', 'test-marks')
  const data = (text: string) => `data ${Buffer.byteLength(text)}\n${text}`
  const when = `${Math.floor(Date.now() / 1000)} +0000`
  const stream = commits.map((c, i) =>
    [
      `commit ${c.ref}`,
      `mark :${i + 1}`,
      `committer t <t@t> ${when}`,
      data(c.msg),
      ...(c.from ? [`from ${c.from}`] : []),
      `M 100644 inline ${c.file}`,
      data(c.text),
      '',
    ].join('\n'),
  )
  execFileSync('git', ['fast-import', '--quiet', `--export-marks=${marks}`], {
    cwd,
    input: stream.join(''),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const shas = new Map(
    fs
      .readFileSync(marks, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split(' ') as [string, string]),
  )
  return commits.map((_, i) => shas.get(`:${i + 1}`)!)
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
      path: path.resolve(w.path),
      main: w.main,
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
  const at = (name: string) => path.join(tmp, name)

  /**
   * A repo with main at a base commit and `commits` on top, its own checkout detached at `head`,
   * registered as a repo row of a new project. Returns the commits' shas, base first.
   */
  const detachedRepo = async (name: string, commits: Commit[], head = 'main') => {
    const { db, schema } = await import('#/db')
    const dir = path.join(tmp, name)
    const git = gitIn(dir)
    fs.mkdirSync(dir)
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    const shas = commitsIn(dir)([
      { ref: 'refs/heads/main', file: 'base.txt', text: 'base\n', msg: 'base' },
      ...commits,
    ])
    git('checkout', '-q', '--detach', head)
    const projectId = db.insert(schema.projects).values({ name }).returning().get().id
    const addRow = (row: string) =>
      db.insert(schema.repos).values({ projectId, name: row, repoPath: dir, baseBranch: 'main' }).run()
    addRow(name)
    return { dir, git, commits: commitsIn(dir), shas, projectId, addRow }
  }
  /** A branch's commit adding a file named after it, made from `from`. */
  const onto = (name: string, from: string, file: string, ref = `refs/heads/${name}`): Commit => ({
    ref,
    from,
    file,
    text: `${name}\n`,
    msg: name,
  })
  const report = async (projectId: number, opts?: { reach?: boolean }) =>
    (await import('./cleanup')).cleanupReport(projectId, opts)

  // The repo and tickets are made once; each test below goes on from where the one before left off.
  describe('accounts for a worktree checked out detached at a ticket branch commit', () => {
    let fixture: Awaited<ReturnType<typeof detachedRepo>>
    let sha: Record<
      'base' | 'reviewed' | 'ui' | 'remoteOnly' | 'both' | 'done' | 'other' | 'dangling',
      string
    >
    const detach = (name: string, commit: string) =>
      fixture.git('worktree', 'add', '-q', '--detach', at(name), commit)
    // git lists worktree paths with forward slashes, also on Windows.
    const untracked = (r: CleanupReport) => r.untracked.map((w) => path.resolve(w.path)).sort()
    const rows = (r: CleanupReport) =>
      Object.fromEntries(
        r.tickets.flatMap((t) =>
          t.branches.map((b) => [
            b.name,
            b.worktrees.map((w) => ({ path: path.resolve(w.path), main: w.main })),
          ]),
        ),
      )
    const stray = ['wt-dangling', 'wt-main', 'wt-other'].map(at).sort()
    const landed = [...stray, at('wt-tip')].sort()

    beforeAll(async () => {
      const features = await import('./features')
      // The way a workspace may be registered: other slashes, other case, a trailing separator.
      const odd = (p: string) => `${p.replace(/\//g, '\\').toUpperCase()}\\`
      const main = 'refs/heads/main'
      fixture = await detachedRepo(
        'detached',
        [
          onto('feat/open', main, 'open.txt'),
          onto('feat/open-ui', 'refs/heads/feat/open', 'ui.txt'),
          // Only origin has it.
          onto('feat/remote', main, 'remote.txt', 'refs/remotes/origin/feat/remote'),
          // Origin's copy is the reviewed one; the local branch was started over elsewhere.
          onto('feat/both', main, 'both.txt', 'refs/remotes/origin/feat/both'),
          onto('feat/both', main, 'both-again.txt'),
          onto('feat/done', main, 'done.txt'),
          onto('feat/reg', main, 'reg.txt'),
          onto('unnamed', main, 'unnamed.txt'),
          onto('other', main, 'other.txt'),
        ],
        'other',
      )
      const [base, reviewed, ui, remoteOnly, both, , done, , , other] = fixture.shas
      // A commit on no branch at all.
      const dangling = fixture.git('commit-tree', `${base}^{tree}`, '-p', base, '-m', 'dangling')
      sha = { base, reviewed, ui, remoteOnly, both, done, other, dangling }

      detach('wt-tip', sha.reviewed)
      detach('wt-ui', sha.ui)
      detach('wt-remote', sha.remoteOnly)
      detach('wt-both', sha.both)
      detach('wt-done', sha.done)
      detach('wt-main', sha.base)
      detach('wt-other', sha.other)
      detach('wt-dangling', sha.dangling)
      detach('wt-reg-open', sha.other)
      fixture.git('worktree', 'add', '-q', at('wt-reg-closed'), 'unnamed')

      const { projectId } = fixture
      const ticket = (title: string, branch: string, status: string) =>
        features.createTicket(projectId, { title, branch, status, baseBranch: 'main' }, 'claude')
      const open = ticket('open', 'feat/open', 'in_progress')
      features.addWorkspace(
        open.id,
        { name: 'ui', branch: 'feat/open-ui', path: at('ui-elsewhere') },
        'claude',
      )
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
    })

    it('leaves untracked only the worktrees at no ticket’s own commit', async () => {
      const r = await report(fixture.projectId)
      expect(untracked(r)).toEqual(stray)
      const heads = Object.fromEntries(r.untracked.map((w) => [path.resolve(w.path), w]))
      // At main's tip: every ticket branch holds it, but so do their bases.
      expect(heads[at('wt-main')]).toMatchObject({ repo: 'detached', branch: null, head: sha.base })
      expect(heads[at('wt-other')]).toMatchObject({ branch: null, head: sha.other })
      expect(heads[at('wt-dangling')]).toMatchObject({ branch: null, head: sha.dangling })
      // The repo's own checkout is never a stray worktree, whatever it has checked out.
      expect(untracked(r)).not.toContain(path.resolve(fixture.dir))
      // A closed ticket lists the worktree reviewing its branch, and the one registered on it.
      expect(r.tickets.map((t) => t.title).sort()).toEqual(['done', 'reg'])
      expect(rows(r)).toEqual({
        'feat/done': [{ path: at('wt-done'), main: false }],
        'feat/reg': [{ path: at('wt-reg-closed'), main: false }],
      })
      expect(r.counts).toMatchObject({ tickets: 2, worktrees: 2, branches: 2, remote: 0 })
      expect(untracked(await report(fixture.projectId, { reach: false }))).toEqual(stray)
    })

    it('still accounts for it once the branch moved on after the review', async () => {
      fixture.commits([
        {
          ref: 'refs/heads/feat/open',
          from: sha.reviewed,
          file: 'open.txt',
          text: 'more\n',
          msg: 'after review',
        },
      ])
      expect(untracked(await report(fixture.projectId))).toEqual(stray)
      expect(untracked(await report(fixture.projectId, { reach: false }))).toEqual(stray)
    })

    it('leaves it untracked once the commit is in the base, no ticket’s own work any more', async () => {
      fixture.git('update-ref', 'refs/heads/main', 'feat/open')
      expect(untracked(await report(fixture.projectId))).toEqual(landed)
      expect(untracked(await report(fixture.projectId, { reach: false }))).toEqual(landed)
    })

    it('leaves a worktree whose head git cannot read untracked rather than failing the report', async () => {
      const missing = '1'.repeat(40)
      detach('wt-missing', sha.other)
      fs.writeFileSync(path.join(fixture.dir, '.git', 'worktrees', 'wt-missing', 'HEAD'), `${missing}\n`)
      const broken = await report(fixture.projectId)
      expect(untracked(broken)).toEqual([...landed, at('wt-missing')].sort())
      expect(broken.untracked.find((w) => path.resolve(w.path) === at('wt-missing'))?.head).toBe(missing)
    })
  })

  // The repo and ticket are made once; each test below goes on from where the one before left off.
  describe('lists a detached worktree several branches of a closed ticket hold under one of them', () => {
    let fixture: Awaited<ReturnType<typeof detachedRepo>>
    let tip: string
    const rows = (r: CleanupReport) =>
      Object.fromEntries(
        r.tickets.flatMap((t) =>
          t.branches.map((b) => [b.name, b.worktrees.map((w) => path.resolve(w.path))]),
        ),
      )
    const expectOnce = async (branch: string) => {
      for (const r of [await report(fixture.projectId), await report(fixture.projectId, { reach: false })]) {
        const other = branch === 'feat/x' ? 'feat/x-ui' : 'feat/x'
        expect(rows(r)).toEqual({ [branch]: [at('ff-wt')], [other]: [] })
        expect(r.counts.worktrees).toBe(1)
        expect(r.untracked).toEqual([])
      }
    }

    beforeAll(async () => {
      const features = await import('./features')
      fixture = await detachedRepo('detached-ff', [
        { ref: 'refs/heads/feat/x', from: 'refs/heads/main', file: 'x.txt', text: 'x\n', msg: 'x' },
        { ref: 'refs/heads/feat/x-ui', from: 'refs/heads/feat/x', file: 'ui.txt', text: 'ui\n', msg: 'ui' },
      ])
      tip = fixture.shas[2]
      // The workspace's sub-branch landed in the ticket's branch: both are at the same commit.
      fixture.git('update-ref', 'refs/heads/feat/x', tip)
      fixture.git('worktree', 'add', '-q', '--detach', at('ff-wt'), tip)

      const done = features.createTicket(
        fixture.projectId,
        { title: 'x', branch: 'feat/x', status: 'done', baseBranch: 'main' },
        'claude',
      )
      features.addWorkspace(
        done.id,
        { name: 'ui', branch: 'feat/x-ui', path: at('ff-ui-elsewhere') },
        'claude',
      )
    })

    it('under the ticket’s own branch when both tips are at it', async () => {
      await expectOnce('feat/x')
    })

    it('under the sub-branch once the ticket’s branch moved on', async () => {
      fixture.commits([
        { ref: 'refs/heads/feat/x', from: tip, file: 'x.txt', text: 'more\n', msg: 'after review' },
      ])
      await expectOnce('feat/x-ui')
    })

    it('under the ticket’s own branch again once both moved on and both hold it', async () => {
      fixture.commits([
        { ref: 'refs/heads/feat/x-ui', from: tip, file: 'ui.txt', text: 'more\n', msg: 'ui after review' },
      ])
      await expectOnce('feat/x')
    })
  })

  it('keeps an open ticket’s detached worktree tracked when two repo rows share its path', async () => {
    const features = await import('./features')
    const { git, shas, projectId, addRow } = await detachedRepo('detached-dup', [
      { ref: 'refs/heads/feat/o', from: 'refs/heads/main', file: 'o.txt', text: 'o\n', msg: 'o' },
    ])
    git('worktree', 'add', '-q', '--detach', at('dup-wt'), shas[1])
    // On the first row; the second, added below at the same path, has no tickets.
    features.createTicket(
      projectId,
      { title: 'o', branch: 'feat/o', status: 'in_progress', baseBranch: 'main' },
      'claude',
    )
    expect((await report(projectId)).untracked).toEqual([])

    addRow('detached-dup-again')
    expect((await report(projectId)).untracked).toEqual([])
    expect((await report(projectId, { reach: false })).untracked).toEqual([])
  })
})

describe('cleanupReport never calls a branch safe that is not', () => {
  const at = (name: string) => path.join(tmp, name)

  /**
   * A repo with `base` at a first commit and the branches of `commits`, all pushed to a bare origin
   * beside it but those `local` lists, registered as a repo row of a new project. Returns the commits'
   * shas, the base's first.
   */
  const pushedRepo = async (
    name: string,
    commits: Commit[],
    opts: { base?: string; local?: string[] } = {},
  ) => {
    const { db, schema } = await import('#/db')
    const base = opts.base ?? 'main'
    const dir = at(name)
    const origin = at(`${name}.git`)
    execFileSync('git', ['init', '-q', '--bare', '-b', base, origin], { stdio: 'ignore' })
    fs.mkdirSync(dir)
    const git = gitIn(dir)
    git('init', '-q', '-b', base)
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    git('remote', 'add', 'origin', origin)
    const shas = commitsIn(dir)([
      { ref: `refs/heads/${base}`, file: 'base.txt', text: 'base\n', msg: 'base' },
      ...commits,
    ])
    git('reset', '-q', '--hard')
    const branches = commits.filter((c) => c.ref.startsWith('refs/heads/')).map((c) => c.ref.slice(11))
    const pushed = [...new Set([base, ...branches])].filter((b) => !opts.local?.includes(b))
    git('push', '-q', 'origin', ...pushed)
    const projectId = db.insert(schema.projects).values({ name }).returning().get().id
    const repoId = db
      .insert(schema.repos)
      .values({ projectId, name, repoPath: dir, baseBranch: base })
      .returning()
      .get().id
    return { dir, origin, git, shas, projectId, repoId }
  }
  const report = async (projectId: number) => (await import('./cleanup')).cleanupReport(projectId)
  const branchOf = (r: CleanupReport, ticketId: number, name: string) =>
    r.tickets.find((t) => t.id === ticketId)?.branches.find((b) => b.name === name)
  const safe = (r: CleanupReport, ticketId: number) => r.tickets.find((t) => t.id === ticketId)?.safe
  const ticket = async (
    projectId: number,
    input: Parameters<(typeof import('./features'))['createTicket']>[1],
  ) => (await import('./features')).createTicket(projectId, input, 'claude')

  it('protects a branch that is its own base instead of calling it merged into origin’s copy', async () => {
    const { projectId } = await pushedRepo('self-base', [], { base: 'dev' })
    const t = await ticket(projectId, { title: 'on dev', branch: 'dev', baseBranch: 'dev', status: 'done' })
    const r = await report(projectId)
    const dev = branchOf(r, t.id, 'dev')!
    expect(dev.reach).toBeNull()
    expect(dev.protected).toMatch(/base/)
    expect(dev.can.local.ok).toBe(false)
    expect(dev.can.remote.ok).toBe(false)
    expect(safe(r, t.id)).toBe(false)
  })

  it('protects a closed lane’s branch that is its open parent’s', async () => {
    const { projectId } = await pushedRepo('lane-on-parent', [
      { ref: 'refs/heads/feat/p', from: 'refs/heads/main', file: 'p.txt', text: 'p\n', msg: 'p' },
    ])
    const parent = await ticket(projectId, { title: 'parent', branch: 'feat/p', status: 'in_progress' })
    const lane = await ticket(projectId, {
      title: 'lane',
      branch: 'feat/p',
      status: 'done',
      parentId: parent.id,
    })
    const r = await report(projectId)
    const b = branchOf(r, lane.id, 'feat/p')!
    expect(b.reach).toBeNull()
    expect(b.protected).toEqual(expect.any(String))
    expect(b.can.local.ok).toBe(false)
    expect(b.can.remote.ok).toBe(false)
    expect(safe(r, lane.id)).toBe(false)
  })

  it('protects a branch an open ticket also works on, and its worktree', async () => {
    const { projectId, git } = await pushedRepo('shared-branch', [])
    // A fresh branch: no commits of its own, so it reads merged.
    git('branch', 'feat/x', 'main')
    git('worktree', 'add', '-q', at('shared-wt'), 'feat/x')
    const done = await ticket(projectId, { title: 'done', branch: 'feat/x', status: 'done' })
    const open = await ticket(projectId, { title: 'open', branch: 'feat/x', status: 'in_progress' })
    const r = await report(projectId)
    expect(safe(r, done.id)).toBe(false)
    const b = branchOf(r, done.id, 'feat/x')!
    expect(b.protected).toContain(`#${open.id}`)
    expect(b.can.local.ok).toBe(false)
    expect(b.can.worktrees.ok).toBe(false)
  })

  it('is not safe while a branch’s reach is unknown', async () => {
    const { db, schema } = await import('#/db')
    const { projectId, repoId, git } = await pushedRepo('no-base', [])
    git('branch', 'feat/lost', 'main')
    // Neither the ticket's base nor the repo's is a branch: nothing to compare against.
    db.update(schema.repos).set({ baseBranch: 'nowhere' }).where(eq(schema.repos.id, repoId)).run()
    const t = await ticket(projectId, { title: 'lost', branch: 'feat/lost', status: 'done' })
    const r = await report(projectId)
    expect(safe(r, t.id)).toBe(false)
    expect(branchOf(r, t.id, 'feat/lost')!.reach).toBeNull()
    expect(branchOf(r, t.id, 'feat/lost')!.can.local.ok).toBe(false)
  })

  it('leaves untracked a detached checkout of the base’s tip a branch was fast-forwarded into', async () => {
    const { projectId, git, shas } = await pushedRepo('ff-tip', [
      { ref: 'refs/heads/feat/done', from: 'refs/heads/main', file: 'd.txt', text: 'd\n', msg: 'd' },
    ])
    git('update-ref', 'refs/heads/main', shas[1]!)
    git('push', '-q', 'origin', 'main')
    git('worktree', 'add', '-q', '--detach', at('ff-tip-wt'), 'main')
    const t = await ticket(projectId, { title: 'done', branch: 'feat/done', status: 'done' })
    const r = await report(projectId)
    expect(r.untracked.map((w) => path.resolve(w.path))).toEqual([at('ff-tip-wt')])
    expect(branchOf(r, t.id, 'feat/done')?.worktrees ?? []).toEqual([])
  })

  it('protects a detached worktree an open ticket also claims', async () => {
    const { projectId, git, shas } = await pushedRepo('shared-detached', [
      { ref: 'refs/heads/feat/a', from: 'refs/heads/main', file: 'a.txt', text: 'a\n', msg: 'a' },
    ])
    git('branch', 'feat/b', shas[1]!)
    git('worktree', 'add', '-q', '--detach', at('shared-detached-wt'), shas[1]!)
    const done = await ticket(projectId, { title: 'done', branch: 'feat/a', status: 'done' })
    const open = await ticket(projectId, { title: 'open', branch: 'feat/b', status: 'in_progress' })
    const b = branchOf(await report(projectId), done.id, 'feat/a')!
    expect(b.worktrees.map((w) => path.resolve(w.path))).toEqual([at('shared-detached-wt')])
    expect(b.worktrees[0]!.protected).toContain(`#${open.id}`)
    expect(b.can.worktrees.ok).toBe(false)
  })

  it('judges origin’s copy by its own commits, and restores each copy that differs', async () => {
    const { projectId, git, shas } = await pushedRepo('origin-ahead', [
      { ref: 'refs/heads/feat/x', from: 'refs/heads/main', file: 'x.txt', text: 'x\n', msg: 'x' },
      { ref: 'refs/heads/feat/x', file: 'x.txt', text: 'more\n', msg: 'more on origin' },
    ])
    // origin has both commits; here the branch is back at the first one, which main took as is.
    git('update-ref', 'refs/heads/feat/x', shas[1]!)
    git('update-ref', 'refs/heads/main', shas[1]!)
    git('push', '-q', 'origin', 'main')
    const t = await ticket(projectId, { title: 'x', branch: 'feat/x', status: 'done' })
    const b = branchOf(await report(projectId), t.id, 'feat/x')!
    expect(b.local).toBe(shas[1])
    expect(b.remote).toBe(shas[2])
    expect(b.reach?.state).toBe('merged')
    expect(b.remoteReach?.state).toBe('unique')
    expect(b.can.local.ok).toBe(true)
    expect(b.can.remote.ok).toBe(false)
    expect(b.restore).toBe(`git branch feat/x ${shas[1]}`)
    expect(b.restoreRemote).toBe(`git push origin ${shas[2]}:refs/heads/feat/x`)
  })

  it('quotes a branch name a shell would read as more than a name in its restore commands', async () => {
    const { shellArg } = await import('./cleanup')
    expect(shellArg('lane/47')).toBe('lane/47')
    expect(shellArg('x;touch${IFS}y')).toBe(`'x;touch\${IFS}y'`)
    expect(shellArg("it's")).toBe(String.raw`'it'\''s'`)
  })

  it('folds the case of paths only where the file system does', async () => {
    const { samePath } = await import('./cleanup')
    expect(samePath('/tmp/x/WT', '/tmp/x/wt', 'linux')).toBe(false)
    expect(samePath('/tmp/x/wt/', '/tmp/x/wt', 'linux')).toBe(true)
    expect(samePath('C:\\X\\WT\\', 'c:/x/wt', 'win32')).toBe(true)
  })

  it('says when git cannot read a repo instead of showing it clean', async () => {
    const { db, schema } = await import('#/db')
    const dir = at('not-a-repo')
    fs.mkdirSync(dir)
    const projectId = db.insert(schema.projects).values({ name: 'not-a-repo' }).returning().get().id
    db.insert(schema.repos).values({ projectId, name: 'nope', repoPath: dir, baseBranch: 'main' }).run()
    const t = await ticket(projectId, { title: 'gone', branch: 'feat/y', status: 'done' })
    const r = await report(projectId)
    expect(r.repos).toEqual([expect.objectContaining({ name: 'nope', error: expect.any(String) })])
    expect(safe(r, t.id) ?? false).toBe(false)
  })
})
