import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp
const origin = path.join(tmp, 'origin.git')
const repo = path.join(tmp, 'repo')
// Someone else's clone, pushing to origin behind the checkout's back.
const other = path.join(tmp, 'other')

/**
 * Every git command the board runs, in order. The spy only notes the arguments: real git still runs
 * (git.ts promisifies `execFile`, so the promisified form is the one wrapped).
 */
const spawned = vi.hoisted(() => [] as string[][])
vi.mock('node:child_process', async (original) => {
  const real = await original<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const note = (file: string, args: unknown) => {
    if (file === 'git' && Array.isArray(args)) spawned.push(args as string[])
  }
  const execFile = Object.assign(
    (...args: Parameters<typeof real.execFile>) => {
      note(args[0], args[1])
      return real.execFile(...args)
    },
    {
      [promisify.custom]: (file: string, args: string[], opts: object) => {
        note(file, args)
        return promisify(real.execFile)(file, args, opts)
      },
    },
  )
  return { ...real, default: { ...real, execFile }, execFile }
})

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const git = (...args: string[]) => gitIn(repo, ...args)

/**
 * Commits putting `file` on top of `from` and moving `ref` to each, in one git process and without
 * touching a checkout (a git process per step makes a test slow on Windows). Answers their shas.
 */
const commits = (list: { ref: string; from: string; file: string; msg: string }[]) => {
  const marks = path.join(repo, '.git', 'test-marks')
  const data = (text: string) => `data ${Buffer.byteLength(text)}\n${text}`
  const when = `${Math.floor(Date.now() / 1000)} +0000`
  const stream = list.map((c, i) =>
    [
      `commit ${c.ref}`,
      `mark :${i + 1}`,
      `author t <t@t> ${when}`,
      `committer t <t@t> ${when}`,
      data(c.msg),
      `from ${c.from}`,
      `M 100644 inline ${c.file}`,
      data(`${c.msg}\n`),
      '',
    ].join('\n'),
  )
  execFileSync('git', ['fast-import', '--quiet', '--force', `--export-marks=${marks}`], {
    cwd: repo,
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
  return list.map((_, i) => shas.get(`:${i + 1}`)!)
}
/** A commit on `branch`, as an agent's worktree would make it. */
const commitOn = (branch: string, msg: string) =>
  commits([{ ref: `refs/heads/${branch}`, from: `refs/heads/${branch}^0`, file: `${msg}.txt`, msg }])[0]!
/** A merge commit of `from` into `into`, made without a checkout. */
const mergeInto = (into: string, from: string) => {
  const tree = git('merge-tree', '--write-tree', into, from).split('\n')[0]!
  const merge = git('commit-tree', tree, '-p', into, '-p', from, '-m', 'merge')
  git('update-ref', `refs/heads/${into}`, merge)
}
/** Branches cut from `from`, each with one commit of its own. */
const branches = (from: string, ...names: string[]) =>
  commits(names.map((n) => ({ ref: `refs/heads/${n}`, from, file: `${n}.txt`, msg: n })))

// The board's clock, Date only: the refs window passes when a test says so, and never runs backwards.
let now = Date.now()
const later = (ms = 3_100) => vi.setSystemTime((now += ms))
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  later()
})
afterEach(() => {
  vi.useRealTimers()
})

/** The git commands since the last `quiet()`: the two listings apart from the rest. */
const ran = () => {
  const listing = (a: string[]) => a[0] === 'for-each-ref' && a.includes('--format=%(refname) %(objectname)')
  const worktrees = (a: string[]) => a[0] === 'worktree' && a[1] === 'list'
  return {
    refs: spawned.filter(listing).length,
    worktrees: spawned.filter(worktrees).length,
    other: spawned.filter((a) => !listing(a) && !worktrees(a)).map((a) => a.join(' ')),
  }
}
const quiet = () => {
  spawned.length = 0
}

let projectId: number
const view = async (id: number) => (await import('./needs')).ticketGitView(id)
const features = () => import('./features')

/**
 * origin (bare) and a checkout of it, left detached so its branches can move under it. main has a
 * base commit, pushed; each test cuts its own branches from it.
 */
beforeAll(async () => {
  fs.mkdirSync(origin)
  gitIn(origin, 'init', '-q', '--bare', '-b', 'main')
  fs.mkdirSync(repo)
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  git('remote', 'add', 'origin', origin)
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n')
  git('add', 'base.txt')
  git('commit', '-q', '-m', 'base')
  git('push', '-q', 'origin', 'main')
  git('checkout', '-q', '--detach')
  execFileSync('git', ['clone', '-q', origin, other], { stdio: 'ignore' })
  gitIn(other, 'config', 'user.email', 'o@o')
  gitIn(other, 'config', 'user.name', 'o')

  const { db, schema } = await import('#/db')
  projectId = db.insert(schema.projects).values({ name: 'p' }).returning().get().id
  db.insert(schema.repos).values({ projectId, name: 'repo', repoPath: repo, baseBranch: 'main' }).run()
  // Fetched now, so no background fetch starts in the middle of a test.
  await (await import('./push')).fetchRepo(repo, { force: true })
}, 60_000)

/**
 * A ticket on `<name>/branch` (pushed), a workspace on `<name>/wt` checked out in a worktree, and a
 * lane on `<name>/lane` with a workspace on it.
 */
const fixture = async (name: string) => {
  const f = await features()
  branches('refs/heads/main', `${name}/branch`)
  branches(`refs/heads/${name}/branch`, `${name}/wt`, `${name}/lane`)
  git('push', '-q', 'origin', `${name}/branch`)
  const wt = path.join(tmp, `wt-${name}`)
  git('worktree', 'add', '-q', wt, `${name}/wt`)
  const ticket = f.createTicket(
    projectId,
    { title: name, branch: `${name}/branch`, status: 'in_progress' },
    't',
  )
  f.addWorkspace(ticket.id, { name: 'wt', branch: `${name}/wt`, path: wt }, 't')
  const lane = f.createTicket(
    projectId,
    { title: `${name} lane`, branch: `${name}/lane`, parentId: ticket.id },
    't',
  )
  f.addWorkspace(lane.id, { name: 'lane wt', branch: `${name}/lane` }, 't')
  return { ticket, lane, wt }
}

describe('ticketGitView', () => {
  it('asks git nothing per branch on a second read, and nothing at all within the refs window', async () => {
    const { ticket } = await fixture('again')
    const first = await view(ticket.id)
    expect(first.info).toMatchObject({ exists: true, ahead: 1, behind: 0 })
    expect(first.workspaces).toHaveLength(2)

    quiet()
    expect(await view(ticket.id)).toEqual(first)
    expect(spawned).toEqual([])

    // Past the window: the repo is listed again, once, and nothing else is asked.
    later()
    quiet()
    expect(await view(ticket.id)).toEqual(first)
    expect(ran()).toEqual({ refs: 1, worktrees: 1, other: [] })
  })

  it('answers as a read with every cache empty, and as git itself does', async () => {
    const { ticket, lane, wt } = await fixture('same')
    // Another ticket's work merged into this branch, so `includes` has something to say.
    branches('refs/heads/main', 'same/other')
    const f = await features()
    const otherTicket = f.createTicket(
      projectId,
      { title: 'other', branch: 'same/other', status: 'in_progress' },
      't',
    )
    mergeInto('same/branch', 'same/other')

    for (const id of [ticket.id, lane.id, otherTicket.id]) {
      vi.resetModules()
      const cold = await view(id)
      later()
      quiet()
      const warm = await view(id)
      expect(ran()).toEqual({ refs: 1, worktrees: 1, other: [] })
      expect(warm).toEqual(cold)
    }

    // The values themselves, from git directly.
    const v = await view(ticket.id)
    const count = (range: string) => Number(git('rev-list', '--count', range))
    expect(v.info).toMatchObject({
      exists: true,
      sha: git('rev-parse', 'same/branch'),
      subject: 'merge',
      authoredAt: git('log', '-1', '--format=%aI', 'same/branch'),
      ahead: count('main..same/branch'),
      behind: count('same/branch..main'),
      push: { state: 'ahead', ahead: 2 },
      reach: { state: 'unique', into: 'main' },
    })
    expect(v.includes).toEqual([otherTicket.id])
    const [wtSpace, laneSpace] = v.workspaces
    expect(wtSpace!.info).toMatchObject({
      sha: git('rev-parse', 'same/wt'),
      ahead: count('same/branch..same/wt'),
      behind: count('same/wt..same/branch'),
      push: { state: 'local-only' },
    })
    expect(path.resolve(wtSpace!.worktree!.path)).toBe(path.resolve(wt))
    expect(laneSpace).toMatchObject({ lane: { id: lane.id }, worktree: null })
    expect(laneSpace!.info.sha).toBe(git('rev-parse', 'same/lane'))
  })

  it('shows a commit made outside the board once the refs window passed', async () => {
    const { ticket } = await fixture('commit')
    const before = await view(ticket.id)
    expect(before.info).toMatchObject({ ahead: 1, push: { state: 'pushed' } })
    const sha = commitOn('commit/branch', 'one more')

    // Within the window it is the answer of a moment ago, never older than that.
    expect((await view(ticket.id)).info.sha).toBe(before.info.sha)
    later()
    expect((await view(ticket.id)).info).toMatchObject({
      sha,
      subject: 'one more',
      ahead: 2,
      behind: 0,
      push: { state: 'ahead', ahead: 1 },
    })
  })

  it('follows the base: behind grows when it moves, reach turns merged once the branch is in it', async () => {
    const { ticket } = await fixture('base')
    branches('refs/heads/main', 'base/main')
    const f = await features()
    f.updateTicket(ticket.id, { baseBranch: 'base/main' }, 't')
    const before = await view(ticket.id)
    expect(before.info).toMatchObject({ ahead: 1, behind: 1, reach: { state: 'unique', into: 'base/main' } })

    commitOn('base/main', 'base moved')
    later()
    expect((await view(ticket.id)).info).toMatchObject({ ahead: 1, behind: 2, reach: { state: 'unique' } })

    mergeInto('base/main', 'base/branch')
    later()
    expect((await view(ticket.id)).info).toMatchObject({
      ahead: 0,
      behind: 3,
      reach: { state: 'merged', into: 'base/main' },
    })
  })

  it('sees a branch created after it was missing, and gone again once deleted', async () => {
    const f = await features()
    const t = f.createTicket(
      projectId,
      { title: 'later', branch: 'later/branch', status: 'in_progress' },
      't',
    )
    expect((await view(t.id)).info).toMatchObject({ exists: false, sha: null })

    const [sha] = branches('refs/heads/main', 'later/branch')
    later()
    expect((await view(t.id)).info).toMatchObject({ exists: true, sha, ahead: 1 })

    // Gone here but on origin: origin's copy, then nothing once that is gone too.
    git('push', '-q', 'origin', 'later/branch')
    git('fetch', '-q', 'origin')
    git('branch', '-q', '-D', 'later/branch')
    later()
    expect((await view(t.id)).info).toMatchObject({ exists: true, sha, push: { state: 'remote-only' } })
    git('update-ref', '-d', 'refs/remotes/origin/later/branch')
    later()
    expect((await view(t.id)).info).toMatchObject({ exists: false, sha: null })
  })

  it('sees a worktree added or removed on disk once the refs window passed', async () => {
    const { ticket, wt } = await fixture('tree')
    git('worktree', 'remove', wt)
    later()
    expect((await view(ticket.id)).workspaces[0]!.worktree).toBeNull()

    git('worktree', 'add', '-q', wt, 'tree/wt')
    later()
    const added = (await view(ticket.id)).workspaces[0]!.worktree
    expect(added && path.resolve(added.path)).toBe(path.resolve(wt))
  })

  it('shows what the board changes on the very next read', async () => {
    const { ticket } = await fixture('board')
    branches('refs/heads/main', 'board/next', 'board/base', 'board/claimed')
    commitOn('board/base', 'base ahead')
    const f = await features()
    await view(ticket.id)
    // No time passes in this test: every change below is the board's own.

    f.updateTicket(ticket.id, { branch: 'board/next' }, 't')
    let v = await view(ticket.id)
    expect(v.branch).toBe('board/next')
    expect(v.info).toMatchObject({ sha: git('rev-parse', 'board/next'), push: { state: 'local-only' } })

    f.updateTicket(ticket.id, { baseBranch: 'board/base' }, 't')
    v = await view(ticket.id)
    expect(v.baseBranch).toBe('board/base')
    expect(v.info).toMatchObject({ ahead: 1, behind: 2, reach: { into: 'board/base' } })

    const ws = f.addWorkspace(ticket.id, { name: 'new', branch: 'board/claimed' }, 't')
    v = await view(ticket.id)
    expect(v.workspaces.map((w) => w.name)).toEqual(['wt', 'new', 'lane wt'])
    expect(v.workspaces[1]!.info.sha).toBe(git('rev-parse', 'board/claimed'))
    f.deleteWorkspace(ws.id, 't')
    expect((await view(ticket.id)).workspaces.map((w) => w.name)).toEqual(['wt', 'lane wt'])

    const lane = f.createTicket(projectId, { title: 'new lane', parentId: ticket.id }, 't')
    f.addWorkspace(lane.id, { name: 'new lane wt', branch: 'board/claimed' }, 't')
    expect((await view(ticket.id)).workspaces.map((w) => w.name)).toEqual(['wt', 'lane wt', 'new lane wt'])

    const todo = f.createTicket(projectId, { title: 'claimed', status: 'todo' }, 't')
    expect((await view(todo.id)).info.exists).toBe(false)
    f.claimTicket(todo.id, 't', { branch: 'board/claimed' })
    expect((await view(todo.id)).info).toMatchObject({ exists: true, sha: git('rev-parse', 'board/claimed') })

    // Moved to another repo, where the branch is at another commit: read there, at once.
    const { db, schema } = await import('#/db')
    const pid = db.insert(schema.projects).values({ name: 'two repos' }).returning().get().id
    const addRepo = (name: string, repoPath: string) =>
      db.insert(schema.repos).values({ projectId: pid, name, repoPath, baseBranch: 'main' }).returning().get()
        .id
    const here = addRepo('repo', repo)
    const there = addRepo('other', other)
    gitIn(other, 'commit', '-q', '--allow-empty', '-m', 'only there')
    const moved = f.createTicket(pid, { title: 'moved', branch: 'main', repoId: here }, 't')
    expect((await view(moved.id)).info.sha).toBe(git('rev-parse', 'main'))
    f.updateTicket(moved.id, { repoId: there }, 't')
    v = await view(moved.id)
    expect(v.repo).toMatchObject({ id: there, name: 'other' })
    expect(v.info).toMatchObject({ sha: gitIn(other, 'rev-parse', 'main'), subject: 'only there' })
  })

  it('reads origin afresh after a fetch, without waiting for the refs window', async () => {
    const { ticket } = await fixture('fetch')
    const before = await view(ticket.id)
    expect(before.info.push).toMatchObject({ state: 'pushed', ahead: 0, behind: 0 })

    gitIn(other, 'fetch', '-q', 'origin')
    gitIn(other, 'checkout', '-q', '-b', 'fetch/branch', 'origin/fetch/branch')
    fs.writeFileSync(path.join(other, 'theirs.txt'), 'theirs\n')
    gitIn(other, 'add', 'theirs.txt')
    gitIn(other, 'commit', '-q', '-m', 'theirs')
    gitIn(other, 'push', '-q', 'origin', 'fetch/branch')
    gitIn(other, 'checkout', '-q', '--detach')

    later(1_000)
    await (await import('./push')).refreshProjectPush(projectId)
    const after = (await view(ticket.id)).info.push
    expect(after).toMatchObject({ state: 'pushed', ahead: 0, behind: 1 })
    expect(new Date(after.checkedAt!).getTime()).toBeGreaterThan(
      new Date(before.info.push.checkedAt!).getTime(),
    )
  })

  it('shares one listing per repo between reads at the same time', async () => {
    const f = await features()
    const names = ['many/a', 'many/b', 'many/c', 'many/d', 'many/e']
    branches('refs/heads/main', ...names)
    const ids = names.map(
      (b) => f.createTicket(projectId, { title: b, branch: b, status: 'in_progress' }, 't').id,
    )
    for (const id of ids) await view(id)

    later()
    quiet()
    await Promise.all(ids.map(view))
    expect(ran()).toEqual({ refs: 1, worktrees: 1, other: [] })
  })

  it('does not keep a failure: the read degrades, then answers in full once git can read the repo', async () => {
    const lonely = path.join(tmp, 'lonely')
    execFileSync('git', ['clone', '-q', origin, lonely], { stdio: 'ignore' })
    gitIn(lonely, 'branch', '-q', 'lonely/branch', 'origin/main')
    const { db, schema } = await import('#/db')
    const f = await features()
    const pid = db.insert(schema.projects).values({ name: 'lonely' }).returning().get().id
    db.insert(schema.repos)
      .values({ projectId: pid, name: 'lonely', repoPath: lonely, baseBranch: 'main' })
      .run()
    await (await import('./push')).fetchRepo(lonely, { force: true })
    const t = f.createTicket(pid, { title: 'lonely', branch: 'lonely/branch', status: 'in_progress' }, 't')
    const full = await view(t.id)
    expect(full.info).toMatchObject({ exists: true, push: { state: 'local-only' } })

    const away = `${lonely}-away`
    fs.renameSync(lonely, away)
    later()
    const degraded = await view(t.id)
    expect(degraded.info).toMatchObject({ exists: false, sha: null, reach: null, push: { state: 'none' } })
    expect(degraded.includes).toEqual([])

    // Back, and read at once: the failed listing was not kept for the window.
    fs.renameSync(away, lonely)
    expect(await view(t.id)).toEqual(full)
  })
})

describe('memo', () => {
  it('keeps at most its maximum, the oldest answers going first', async () => {
    const { memo } = await import('./cleanup')
    const cache = new Map<string, Promise<number>>()
    for (let i = 0; i < 10; i++) await memo(cache, 4, `k${i}`, async () => i)
    expect([...cache.keys()]).toEqual(['k6', 'k7', 'k8', 'k9'])
    // A failure is not kept.
    await expect(memo(cache, 4, 'bad', () => Promise.reject(new Error('gone')))).rejects.toThrow('gone')
    expect(cache.has('bad')).toBe(false)
  })
})
