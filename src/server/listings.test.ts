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
const commits = (list: { ref: string; from: string; file: string; msg: string }[], cwd = repo) => {
  const marks = path.join(tmp, 'test-marks')
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
  return list.map((_, i) => shas.get(`:${i + 1}`)!)
}
/** A commit on `branch`, as an agent's worktree would make it. */
const commitOn = (branch: string, msg: string, cwd = repo) =>
  commits([{ ref: `refs/heads/${branch}`, from: `refs/heads/${branch}^0`, file: `${msg}.txt`, msg }], cwd)[0]!
/** A merge commit of `from` into `into`, made without a checkout. */
const mergeInto = (into: string, from: string) => {
  const tree = git('merge-tree', '--write-tree', into, from).split('\n')[0]!
  const merge = git('commit-tree', tree, '-p', into, '-p', from, '-m', 'merge')
  git('update-ref', `refs/heads/${into}`, merge)
  return merge
}
/** Branches cut from `from`, each with one commit of its own. */
const branches = (from: string, ...names: string[]) =>
  commits(names.map((n) => ({ ref: `refs/heads/${n}`, from, file: `${n}.txt`, msg: n })))

// The board's clock, Date only: time passes when a test says so, and never runs backwards.
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

const features = () => import('./features')
const needsModule = () => import('./needs')
const rows = async (pid: number) => (await needsModule()).ticketRows(pid)
/** The ticket page's read, without when origin was last fetched (that moves with the clock). */
const view = async (id: number) =>
  JSON.parse(
    JSON.stringify(await (await needsModule()).ticketView(id), (k, v) => (k === 'checkedAt' ? null : v)),
  )
const report = async (pid: number, reach = true) => (await import('./cleanup')).cleanupReport(pid, { reach })

/** Every polled read of a project and one of its tickets. */
const reads = async (pid: number, id: number) => ({
  rows: await rows(pid),
  view: await view(id),
  full: await report(pid),
  quick: await report(pid, false),
})
/** The same reads with every cache empty: a fresh copy of every module. */
const cold = async (pid: number, id: number) => {
  vi.resetModules()
  return reads(pid, id)
}
/**
 * The reads answer as they do with every cache empty. The push state's listing is shared for a few
 * seconds by design, so that window is let pass first.
 */
const matchesCold = async (pid: number, id: number) => {
  later()
  const warm = await reads(pid, id)
  expect(warm).toEqual(await cold(pid, id))
}

/** A progress post by an agent, made now on the board's clock (as the commits are). */
const postNow = async (id: number, body: string) => {
  const { db, schema } = await import('#/db')
  const { eq } = await import('drizzle-orm')
  const row = (await features()).postUpdate(id, body, [], 'claude')
  db.update(schema.updates)
    .set({ createdAt: new Date().toISOString() })
    .where(eq(schema.updates.id, row.id))
    .run()
}

const rowOf = async (pid: number, id: number) => (await rows(pid)).find((t) => t.id === id)!
const branchIn = (r: Awaited<ReturnType<typeof report>>, name: string) =>
  r.tickets.flatMap((t) => t.branches).find((b) => b.name === name)
const handoffPost = (v: { handoff: { checks: { code: string; ok: boolean }[] } }) =>
  v.handoff.checks.find((c) => c.code === 'no_handoff_post')!.ok

/** A project on `repoPath`, with `main` as its base. */
const project = async (name: string, repoPath = repo) => {
  const { db, schema } = await import('#/db')
  const pid = db.insert(schema.projects).values({ name }).returning().get().id
  db.insert(schema.repos).values({ projectId: pid, name, repoPath, baseBranch: 'main' }).run()
  return pid
}

/**
 * A project of its own on the shared checkout: `<name>/dev` cut from main is the base of three
 * tickets: `need` (in progress, on `<name>/need`), `work` (in review, on `<name>/work`, needing
 * `need`, with a resume note) and `done` (done, on `<name>/done`, which the cleanup report lists).
 * Each branch has one commit of its own.
 */
const fixture = async (name: string) => {
  const f = await features()
  const pid = await project(name)
  const dev = `${name}/dev`
  branches('refs/heads/main', dev)
  branches(`refs/heads/${dev}`, `${name}/need`, `${name}/work`, `${name}/done`)
  const make = (title: string, status: string) =>
    f.createTicket(pid, { title, branch: `${name}/${title}`, baseBranch: dev, status }, 't')
  const need = make('need', 'in_progress')
  const work = make('work', 'review')
  const done = make('done', 'done')
  ;(await needsModule()).setNeeds(work.id, [need.id], 't')
  await f.setResumeNote(work.id, 'where it stands', 'claude')
  return { pid, dev, need, work, done, b: (t: string) => `${name}/${t}` }
}

/**
 * origin (bare) and a checkout of it, left detached so its branches can move under it. main has a
 * base commit, pushed.
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
  // Fetched now, so no background fetch starts in the middle of a test.
  await (await import('./push')).fetchRepo(repo, { force: true })
}, 60_000)

describe('the polled reads', () => {
  it('ask git nothing on a second read with nothing moved, also once the refs window passed', async () => {
    const x = await fixture('again')
    const first = await reads(x.pid, x.work.id)
    expect(first.view).toMatchObject({
      needs: [{ id: x.need.id, merged: false }],
      resume: { commitsSince: 0, stale: false },
    })
    expect(branchIn(first.full, x.b('done'))).toMatchObject({ reach: { state: 'unique' } })

    quiet()
    expect(await reads(x.pid, x.work.id)).toEqual(first)
    expect(spawned).toEqual([])

    // Past the window the push state lists the repo again, as it always did (it is shared for a few
    // seconds by design); nothing else asks git anything.
    later()
    quiet()
    expect(await reads(x.pid, x.work.id)).toEqual(first)
    expect(ran()).toEqual({ refs: 1, worktrees: 0, other: [] })
    quiet()
    later()
    await rows(x.pid)
    await report(x.pid)
    await report(x.pid, false)
    expect(spawned).toEqual([])

    expect(first).toEqual(await cold(x.pid, x.work.id))
  })

  it('show a commit made outside the board on the very next read', async () => {
    const x = await fixture('commit')
    await reads(x.pid, x.work.id)

    // The ticket's own branch: commits since the note, and a stale note.
    commitOn(x.b('work'), 'more work')
    let v = await view(x.work.id)
    expect(v.resume).toMatchObject({ commitsSince: 1, stale: true })
    expect((await rowOf(x.pid, x.work.id)).resume).toMatchObject({ stale: true })

    // The hand-off post counts once it is newer than the last commit, and no longer after one more.
    later()
    await postNow(x.work.id, 'ready for review')
    expect(handoffPost(await view(x.work.id))).toBe(true)
    later()
    commitOn(x.b('work'), 'after the post')
    v = await view(x.work.id)
    expect(handoffPost(v)).toBe(false)
    expect(v.resume).toMatchObject({ commitsSince: 2 })

    // A need merged, then committed to again: no longer in the base.
    mergeInto(x.dev, x.b('need'))
    expect((await view(x.work.id)).needs).toMatchObject([{ merged: true }])
    commitOn(x.b('need'), 'need moved on')
    expect((await view(x.work.id)).needs).toMatchObject([{ merged: false }])
    expect((await rowOf(x.pid, x.work.id)).needs).toMatchObject([{ merged: false }])

    // The cleanup report: the branch's sha, and its reach once it is merged.
    const sha = commitOn(x.b('done'), 'done moved on')
    expect(branchIn(await report(x.pid), x.b('done'))).toMatchObject({
      local: sha,
      reach: { state: 'unique' },
    })
    mergeInto(x.dev, x.b('done'))
    expect(branchIn(await report(x.pid), x.b('done'))).toMatchObject({
      local: sha,
      reach: { state: 'merged' },
    })

    await matchesCold(x.pid, x.work.id)
  })

  it('see a branch created or deleted on the very next read', async () => {
    const x = await fixture('made')
    const f = await features()
    await reads(x.pid, x.work.id)

    // Deleted: the note's commits cannot be counted, and a done need whose branch went is met.
    f.updateTicket(x.need.id, { status: 'done' }, 't')
    expect((await view(x.work.id)).needs).toMatchObject([{ merged: false }])
    const work = git('rev-parse', x.b('work'))
    const need = git('rev-parse', x.b('need'))
    git('branch', '-q', '-D', x.b('work'), x.b('need'))
    let v = await view(x.work.id)
    expect(v.resume).toMatchObject({ commitsSince: null })
    expect(v.needs).toMatchObject([{ merged: true }])
    await matchesCold(x.pid, x.work.id)

    // Made again, one commit further: counted, and not met.
    git('branch', '-q', x.b('work'), work)
    git('branch', '-q', x.b('need'), need)
    commitOn(x.b('work'), 'back')
    v = await view(x.work.id)
    expect(v.resume).toMatchObject({ commitsSince: 1, stale: true })
    expect(v.needs).toMatchObject([{ merged: false }])

    // A branch in folders of its own, made and deleted.
    const deep = `${x.b('deep')}/er/branch`
    const t = f.createTicket(x.pid, { title: 'deep', branch: deep, baseBranch: x.dev, status: 'done' }, 't')
    expect(branchIn(await report(x.pid), deep)).toBeUndefined()
    const [sha] = branches(`refs/heads/${x.dev}`, deep)
    expect(branchIn(await report(x.pid), deep)).toMatchObject({ local: sha, reach: { state: 'unique' } })
    git('push', '-q', 'origin', deep)
    git('fetch', '-q', 'origin')
    git('branch', '-q', '-D', deep)
    // Gone here, still on origin.
    expect(branchIn(await report(x.pid), deep)).toMatchObject({ local: null, remote: sha })
    await matchesCold(x.pid, t.id)
  })

  it('see origin moved by a fetch on the very next read, by hand or by the board', async () => {
    const x = await fixture('fetch')
    const f = await features()
    const push = await import('./push')
    // A need that is only on origin, and the done branch pushed.
    branches(`refs/heads/${x.dev}`, x.b('far'))
    git('push', '-q', 'origin', x.dev, x.b('far'), x.b('done'))
    git('fetch', '-q', 'origin')
    git('branch', '-q', '-D', x.b('far'))
    const far = f.createTicket(
      x.pid,
      { title: 'far', branch: x.b('far'), baseBranch: x.dev, status: 'in_progress' },
      't',
    )
    ;(await needsModule()).setNeeds(x.work.id, [x.need.id, far.id], 't')
    const before = await reads(x.pid, x.work.id)
    expect(before.view.needs).toMatchObject([{ merged: false }, { merged: false }])

    // Merged into dev on origin by someone else: seen once fetched by hand.
    gitIn(other, 'fetch', '-q', 'origin')
    gitIn(other, 'checkout', '-q', '-b', x.dev, `origin/${x.dev}`)
    gitIn(other, 'merge', '-q', '--no-ff', '-m', 'merge far', `origin/${x.b('far')}`)
    gitIn(other, 'push', '-q', 'origin', x.dev)
    gitIn(other, 'checkout', '-q', '--detach')
    expect(await reads(x.pid, x.work.id)).toEqual(before)
    git('fetch', '-q', 'origin')
    expect((await view(x.work.id)).needs).toMatchObject([{ merged: false }, { merged: true }])

    // Pushed to by someone else: seen once the board fetched.
    gitIn(other, 'checkout', '-q', '-b', x.b('done'), `origin/${x.b('done')}`)
    fs.writeFileSync(path.join(other, 'theirs.txt'), 'theirs\n')
    gitIn(other, 'add', 'theirs.txt')
    gitIn(other, 'commit', '-q', '-m', 'theirs')
    gitIn(other, 'push', '-q', 'origin', x.b('done'))
    const theirs = gitIn(other, 'rev-parse', 'HEAD')
    gitIn(other, 'checkout', '-q', '--detach')
    expect(branchIn(await report(x.pid), x.b('done'))!.remote).not.toBe(theirs)
    later(1_000)
    await push.refreshProjectPush(x.pid)
    expect(branchIn(await report(x.pid), x.b('done'))).toMatchObject({
      remote: theirs,
      reach: { state: 'unique' },
    })

    // Deleted on origin: a fetch that prunes drops it, here and in the background.
    gitIn(other, 'push', '-q', 'origin', '--delete', x.b('done'))
    await push.fetchRepo(repo, { force: true })
    expect(branchIn(await report(x.pid), x.b('done'))).toMatchObject({ remote: null })
    await matchesCold(x.pid, x.work.id)
  })

  it('follow the base: a need and a reach judged again when it moves, never by an old verdict', async () => {
    const x = await fixture('base')
    const needs = await needsModule()
    const f = await features()
    const guard = () =>
      needs.guardDone({ ...f.getTicket(x.work.id), from: 'review' }, 'done', [x.need.id], { agent: true })
    await reads(x.pid, x.work.id)
    await expect(guard()).rejects.toMatchObject({ status: 409 })

    const dev = git('rev-parse', x.dev)
    mergeInto(x.dev, x.b('need'))
    mergeInto(x.dev, x.b('done'))
    expect((await view(x.work.id)).needs).toMatchObject([{ merged: true }])
    expect((await rowOf(x.pid, x.work.id)).needs).toMatchObject([{ merged: true }])
    expect(branchIn(await report(x.pid), x.b('done'))!.reach).toMatchObject({ state: 'merged', into: x.dev })
    await expect(guard()).resolves.toEqual([])

    // Reset: the verdicts kept for the merged base are not served for the old one.
    git('update-ref', `refs/heads/${x.dev}`, dev)
    expect((await view(x.work.id)).needs).toMatchObject([{ merged: false }])
    expect(branchIn(await report(x.pid), x.b('done'))!.reach).toMatchObject({ state: 'unique' })
    await expect(guard()).rejects.toMatchObject({ status: 409 })

    // Merged again, then the need moved past its base: refused at once.
    mergeInto(x.dev, x.b('need'))
    await expect(guard()).resolves.toEqual([])
    commitOn(x.b('need'), 'past the base')
    await expect(guard()).rejects.toMatchObject({ status: 409, code: 'needs' })
    await matchesCold(x.pid, x.work.id)

    // Its base on origin only counts too: pushed there, merged there, fetched. (Compared without the
    // push state from here: pushing the base changes how many of the branch's commits are on no origin
    // branch, which the push state keeps by the branch's sha alone.)
    git('push', '-q', 'origin', x.dev)
    git('fetch', '-q', 'origin')
    gitIn(other, 'fetch', '-q', 'origin')
    gitIn(other, 'checkout', '-q', '-b', `${x.dev}-o`, `origin/${x.dev}`)
    git('push', '-q', 'origin', x.b('need'))
    gitIn(other, 'fetch', '-q', 'origin')
    gitIn(other, 'merge', '-q', '--no-ff', '-m', 'merge need', `origin/${x.b('need')}`)
    gitIn(other, 'push', '-q', 'origin', `HEAD:${x.dev}`)
    gitIn(other, 'checkout', '-q', '--detach')
    await expect(guard()).rejects.toMatchObject({ status: 409 })
    git('fetch', '-q', 'origin')
    await expect(guard()).resolves.toEqual([])
    const warm = await reads(x.pid, x.work.id)
    expect(warm.view.needs).toMatchObject([{ merged: true }])
    const fresh = await cold(x.pid, x.work.id)
    expect([warm.rows, warm.view.needs, warm.full]).toEqual([fresh.rows, fresh.view.needs, fresh.full])
  })

  it('see a worktree added, removed, switched or detached outside the board', async () => {
    const x = await fixture('tree')
    const wt = path.join(tmp, 'wt-tree')
    const untracked = (r: Awaited<ReturnType<typeof report>>) =>
      r.untracked.filter((u) => path.resolve(u.path) === path.resolve(wt))
    const trees = async () =>
      branchIn(await report(x.pid), x.b('done'))!.worktrees.map((w) => path.resolve(w.path))
    expect(await trees()).toEqual([])

    git('worktree', 'add', '-q', wt, x.b('done'))
    expect(await trees()).toEqual([path.resolve(wt)])

    branches('refs/heads/main', 'tree/scratch')
    gitIn(wt, 'checkout', '-q', 'tree/scratch')
    expect(await trees()).toEqual([])
    expect(untracked(await report(x.pid))).toMatchObject([{ branch: 'tree/scratch' }])

    // Detached at the done branch's commit: claimed by it, not untracked.
    gitIn(wt, 'checkout', '-q', '--detach', x.b('done'))
    expect(await trees()).toEqual([path.resolve(wt)])
    expect(untracked(await report(x.pid))).toEqual([])
    await matchesCold(x.pid, x.work.id)

    git('worktree', 'remove', wt)
    expect(await trees()).toEqual([])
    expect(untracked(await report(x.pid))).toEqual([])
  })

  it("show the board's own changes on the very next read", async () => {
    const x = await fixture('board')
    const f = await features()
    const needs = await needsModule()
    await reads(x.pid, x.work.id)

    // A note saved right after a commit holds.
    commitOn(x.b('work'), 'just now')
    const saved = await f.setResumeNote(x.work.id, 'saved after the commit', 'claude')
    expect(saved.resume).toMatchObject({ commitsSince: 0, stale: false })
    expect((await view(x.work.id)).resume).toMatchObject({ commitsSince: 0, stale: false })

    // The need's branch, the subject's base and the needs themselves, changed by the board.
    branches(`refs/heads/${x.dev}`, x.b('landed'))
    mergeInto(x.dev, x.b('landed'))
    await reads(x.pid, x.work.id)
    f.updateTicket(x.need.id, { branch: x.b('landed') }, 't')
    expect((await view(x.work.id)).needs).toMatchObject([{ branch: x.b('landed'), merged: true }])
    f.updateTicket(x.work.id, { baseBranch: 'main' }, 't')
    expect((await rowOf(x.pid, x.work.id)).needs).toMatchObject([{ into: 'main', merged: false }])
    needs.setNeeds(x.work.id, [], 't')
    expect((await view(x.work.id)).needs).toEqual([])

    // Claimed with a branch that has commits since a note: the list and the ticket read it at once.
    const todo = f.createTicket(x.pid, { title: 'claimed', status: 'todo' }, 't')
    f.claimTicket(todo.id, 't', { branch: x.b('done') })
    await f.setResumeNote(todo.id, 'claimed', 'claude')
    commitOn(x.b('done'), 'on the claimed branch')
    expect((await view(todo.id)).resume).toMatchObject({ commitsSince: 1, stale: true })
    expect((await rowOf(x.pid, todo.id)).resume).toMatchObject({ stale: true })
    await matchesCold(x.pid, todo.id)
  })

  it('share one listing per repo between reads at the same time', async () => {
    // The commits since a resume note, counted once for the new head.
    const counted = /^rev-list --count [0-9a-f]{40}\.\.[0-9a-f]{40}$/
    const x = await fixture('many')
    await reads(x.pid, x.work.id)

    commitOn(x.b('work'), 'moved')
    quiet()
    await Promise.all([rows(x.pid), rows(x.pid), rows(x.pid), report(x.pid), report(x.pid, false)])
    let after = ran()
    expect(after).toMatchObject({ refs: 1, worktrees: 1 })
    expect(after.other.filter((c) => counted.test(c))).toHaveLength(1)
    expect(new Set(after.other).size).toBe(after.other.length)

    // The ticket page past the refs window: its push state lists once more (shared for a few seconds,
    // as always), and that is all.
    commitOn(x.b('work'), 'moved again')
    later()
    quiet()
    await Promise.all([view(x.work.id), view(x.work.id), view(x.work.id)])
    after = ran()
    expect(after.refs).toBe(2)
    expect(after.worktrees).toBe(1)
    expect(after.other.filter((c) => counted.test(c))).toHaveLength(1)
    expect(new Set(after.other).size).toBe(after.other.length)
  })

  it('keep no failure: the reads degrade, then answer in full once git can read the repo', async () => {
    const lonely = path.join(tmp, 'lonely')
    execFileSync('git', ['clone', '-q', origin, lonely], { stdio: 'ignore' })
    gitIn(lonely, 'config', 'user.email', 't@t')
    gitIn(lonely, 'config', 'user.name', 't')
    gitIn(lonely, 'branch', '-q', 'lonely/dev', 'origin/main')
    commits(
      ['need', 'work', 'done'].map((n) => ({
        ref: `refs/heads/lonely/${n}`,
        from: 'refs/heads/lonely/dev',
        file: `${n}.txt`,
        msg: n,
      })),
      lonely,
    )
    await (await import('./push')).fetchRepo(lonely, { force: true })
    const f = await features()
    const pid = await project('lonely', lonely)
    const make = (title: string, status: string) =>
      f.createTicket(pid, { title, branch: `lonely/${title}`, baseBranch: 'lonely/dev', status }, 't')
    const need = make('need', 'in_progress')
    const work = make('work', 'review')
    make('done', 'done')
    ;(await needsModule()).setNeeds(work.id, [need.id], 't')
    await f.setResumeNote(work.id, 'lonely', 'claude')
    later()
    await postNow(work.id, 'ready')
    later()
    commitOn('lonely/work', 'after the post', lonely)
    const full = await reads(pid, work.id)
    expect(full.view).toMatchObject({ resume: { commitsSince: 1 }, needs: [{ merged: false }] })
    expect(handoffPost(full.view)).toBe(false)
    expect(full.full.tickets[0]!.branches).toHaveLength(1)

    const away = `${lonely}-away`
    fs.renameSync(lonely, away)
    const degraded = await reads(pid, work.id)
    expect(degraded.view.resume).toMatchObject({ commitsSince: null })
    expect(degraded.view.needs).toMatchObject([{ merged: false }])
    // No last commit to go by: the post after work started counts.
    expect(handoffPost(degraded.view)).toBe(true)
    expect(degraded.full.tickets).toEqual([])

    // Back, and read at once.
    fs.renameSync(away, lonely)
    expect(await reads(pid, work.id)).toEqual(full)

    // A note's sha that is no commit here: unknown, and asked again on the next read.
    const { db, schema } = await import('#/db')
    const { eq } = await import('drizzle-orm')
    db.update(schema.tickets)
      .set({ resumeSha: 'f'.repeat(40) })
      .where(eq(schema.tickets.id, work.id))
      .run()
    expect((await view(work.id)).resume).toMatchObject({ commitsSince: null })
    quiet()
    expect((await view(work.id)).resume).toMatchObject({ commitsSince: null })
    expect(ran().other).toEqual([
      `rev-list --count ${'f'.repeat(40)}..${gitIn(lonely, 'rev-parse', 'lonely/work')}`,
    ])
  })

  it('work an answer out on the listed commits: a branch moved back answers for where it is', async () => {
    const x = await fixture('back')
    const one = commitOn(x.b('work'), 'one')
    later()
    await postNow(x.work.id, 'between the two')
    later()
    commitOn(x.b('work'), 'two')
    let v = await view(x.work.id)
    expect(v.resume).toMatchObject({ commitsSince: 2 })
    expect(handoffPost(v)).toBe(false)

    git('update-ref', `refs/heads/${x.b('work')}`, one)
    v = await view(x.work.id)
    expect(v.resume).toMatchObject({ commitsSince: 1 })
    expect(handoffPost(v)).toBe(true)
    await matchesCold(x.pid, x.work.id)
  })
})

describe('repo layouts', () => {
  it('reads packed refs, and sees them change', async () => {
    const x = await fixture('packed')
    await reads(x.pid, x.work.id)
    git('pack-refs', '--all')
    expect(fs.existsSync(path.join(repo, '.git', 'refs', 'heads', 'packed', 'work'))).toBe(false)
    const packed = await reads(x.pid, x.work.id)
    quiet()
    expect(await reads(x.pid, x.work.id)).toEqual(packed)
    expect(spawned).toEqual([])
    await matchesCold(x.pid, x.work.id)

    // Packed, then moved (a loose ref again), then deleted (packed-refs rewritten).
    git('pack-refs', '--all')
    commitOn(x.b('work'), 'over the packed ref')
    expect((await view(x.work.id)).resume).toMatchObject({ commitsSince: 1 })
    git('pack-refs', '--all')
    git('branch', '-q', '-D', x.b('work'))
    expect((await view(x.work.id)).resume).toMatchObject({ commitsSince: null })
    await matchesCold(x.pid, x.work.id)
  })

  it('reads a repo registered at a linked worktree, and sees its refs change', async () => {
    const x = await fixture('linked')
    const wt = path.join(tmp, 'wt-linked')
    git('worktree', 'add', '-q', '--detach', wt, 'main')
    const { db, schema } = await import('#/db')
    const { eq } = await import('drizzle-orm')
    db.update(schema.repos).set({ repoPath: wt }).where(eq(schema.repos.projectId, x.pid)).run()
    await (await import('./push')).fetchRepo(wt, { force: true })
    const first = await reads(x.pid, x.work.id)
    quiet()
    expect(await reads(x.pid, x.work.id)).toEqual(first)
    expect(spawned).toEqual([])

    commitOn(x.b('work'), 'from the main checkout')
    expect((await view(x.work.id)).resume).toMatchObject({ commitsSince: 1 })
    gitIn(wt, 'checkout', '-q', '--detach', x.b('done'))
    const trees = branchIn(await report(x.pid), x.b('done'))!.worktrees
    expect(trees.map((w) => ({ ...w, path: path.resolve(w.path) }))).toEqual([
      { path: path.resolve(wt), main: false },
    ])
    await matchesCold(x.pid, x.work.id)
  })

  it('lists a reftable repo with git on every read', async () => {
    const rt = path.join(tmp, 'reftable')
    fs.mkdirSync(rt)
    gitIn(rt, 'init', '-q', '--ref-format=reftable', '-b', 'main')
    gitIn(rt, 'config', 'user.email', 't@t')
    gitIn(rt, 'config', 'user.name', 't')
    gitIn(rt, 'commit', '-q', '--allow-empty', '-m', 'base')
    gitIn(rt, 'branch', 'rt/work')
    gitIn(rt, 'checkout', '-q', '--detach')
    const f = await features()
    const pid = await project('reftable', rt)
    const t = f.createTicket(pid, { title: 'rt', branch: 'rt/work', status: 'in_progress' }, 't')
    await f.setResumeNote(t.id, 'reftable', 'claude')
    const first = await reads(pid, t.id)
    quiet()
    expect(await reads(pid, t.id)).toEqual(first)
    expect(ran().refs).toBeGreaterThan(0)

    commitOn('rt/work', 'in the reftable', rt)
    expect((await view(t.id)).resume).toMatchObject({ commitsSince: 1, stale: true })
    await matchesCold(pid, t.id)
  })
})

/** Real time passing, for ref folders to settle (the file system's clock, not the board's). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 2_600))

describe('the kept listings', () => {
  it('go by a settled folder alone, and still see a change in it on the very next read', async () => {
    const x = await fixture('settled')
    await reads(x.pid, x.work.id)
    await settle()
    // Read once settled: from now on the folders are checked by their own time.
    later()
    const first = await reads(x.pid, x.work.id)
    quiet()
    later()
    expect(await reads(x.pid, x.work.id)).toEqual(first)
    expect(ran()).toEqual({ refs: 1, worktrees: 0, other: [] })

    // A branch moved in a settled folder, one made in a new folder, one deleted: each seen at once.
    commitOn(x.b('work'), 'in a settled folder')
    expect((await view(x.work.id)).resume).toMatchObject({ commitsSince: 1, stale: true })
    await settle()
    later()
    await reads(x.pid, x.work.id)
    const [sha] = branches(`refs/heads/${x.dev}`, `${x.b('new')}/folder`)
    const t = (await features()).createTicket(
      x.pid,
      { title: 'new', branch: `${x.b('new')}/folder`, baseBranch: x.dev, status: 'done' },
      't',
    )
    expect(branchIn(await report(x.pid), `${x.b('new')}/folder`)).toMatchObject({ local: sha })
    await settle()
    await reads(x.pid, t.id)
    git('branch', '-q', '-D', `${x.b('new')}/folder`)
    expect(branchIn(await report(x.pid), `${x.b('new')}/folder`)).toBeUndefined()
    await matchesCold(x.pid, t.id)
  }, 60_000)

  it('ask git each read while a folder of many refs is recent, and nothing once it settled', async () => {
    const big = path.join(tmp, 'big')
    fs.mkdirSync(big)
    gitIn(big, 'init', '-q', '-b', 'main')
    gitIn(big, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'one')
    const head = gitIn(big, 'rev-parse', 'HEAD')
    execFileSync('git', ['update-ref', '--stdin'], {
      cwd: big,
      input: Array.from({ length: 600 }, (_, i) => `create refs/heads/many-${i} ${head}\n`).join(''),
    })
    gitIn(big, 'checkout', '-q', '--detach')
    const { currentRefs } = await import('./listings')
    quiet()
    expect((await currentRefs(big))?.local.size).toBe(601)
    expect((await currentRefs(big))?.local.size).toBe(601)
    expect(ran().refs).toBe(2)

    await settle()
    await currentRefs(big)
    quiet()
    expect((await currentRefs(big))?.local.size).toBe(601)
    expect(ran().refs).toBe(0)

    gitIn(big, 'branch', '-q', '-D', 'many-7')
    expect((await currentRefs(big))?.local.has('many-7')).toBe(false)
  }, 60_000)

  it('keep one per repo, at most their maximum, the oldest repo going first', async () => {
    const { currentRefs } = await import('./listings')
    const tiny = path.join(tmp, 'tiny')
    fs.mkdirSync(tiny)
    gitIn(tiny, 'init', '-q', '-b', 'main')
    gitIn(tiny, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'one')
    const paths = Array.from({ length: 101 }, (_, i) => {
      const p = path.join(tmp, `tiny-${i}`)
      fs.cpSync(tiny, p, { recursive: true })
      return p
    })
    for (let i = 0; i < paths.length; i += 20) await Promise.all(paths.slice(i, i + 20).map(currentRefs))
    quiet()
    expect((await currentRefs(paths[100]!))?.local.size).toBe(1)
    expect((await currentRefs(paths[1]!))?.local.size).toBe(1)
    expect(ran().refs).toBe(0)
    expect((await currentRefs(paths[0]!))?.local.size).toBe(1)
    expect(ran().refs).toBe(1)
  })
})
