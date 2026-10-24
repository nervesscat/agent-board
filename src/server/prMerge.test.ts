import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MyGhPr } from './git'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp

/**
 * Every git and gh command the board runs, in order. The spy only notes them: real git still runs
 * (git.ts promisifies `execFile`, and calls it with a callback where it writes to git's stdin, so
 * both forms are wrapped).
 */
const spawned = vi.hoisted(() => [] as { file: string; args: string[] }[])
vi.mock('node:child_process', async (original) => {
  const real = await original<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const note = (file: string, args: unknown) => {
    if ((file === 'git' || file === 'gh') && Array.isArray(args))
      spawned.push({ file, args: args as string[] })
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

// gh answers from `answer`: the PRs a refresh finds, a failure, or no answer at all. Each refresh of a
// repo asks once; `asked` has when.
let answer: () => MyGhPr[] | Promise<MyGhPr[]> = () => []
const asked: number[] = []
vi.mock('./git', async (original) => ({
  ...(await original<typeof import('./git')>()),
  listMyPrs: async () => {
    asked.push(Date.now())
    return answer()
  },
  currentGithubLogin: async () => 'enrique',
  prMerged: async () => false,
  prStateOf: async () => null,
  repoNameWithOwner: async () => 'acme/app',
}))

const failing = () => {
  throw new Error('gh pr list failed')
}

let prs: typeof import('./prs')
let push: typeof import('./push')
let features: typeof import('./features')
let needs: typeof import('./needs')
let dbm: typeof import('#/db')
beforeAll(async () => {
  prs = await import('./prs')
  push = await import('./push')
  features = await import('./features')
  needs = await import('./needs')
  dbm = await import('#/db')
})

let errors: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  asked.length = 0
  answer = () => []
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  prs.resetPrRefreshes()
  vi.useRealTimers()
  errors.mockRestore()
})

const gitIn = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** Lets background work that waits on no timer (a refresh against the gh fake) run to its end. */
async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))
}

/** What the board does now and then: fetch origin into the checkout, then read its branches afresh. */
async function look(repo: string) {
  await push.fetchRepo(repo, { force: true })
  await push.readRefs(repo)
}

/** Only `Date` and timeouts are faked: git's processes and the I/O they wait on stay real. */
const fakeClock = () => vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })

const FORK_HEAD = '0123456789abcdef0123456789abcdef01234567'

/**
 * A repo on GitHub (`githubRepo` set): a bare origin, the board's checkout of it, and someone else's
 * clone (`other`) that pushes behind its back. Origin's main has `a.txt`; `feat`, pushed from the
 * checkout, changes its first line. The board has looked at it once, unless not `looked`.
 */
async function fixture(name: string, { looked = true } = {}) {
  const origin = path.join(tmp, 'git', `${name}.git`)
  const repo = path.join(tmp, 'git', name)
  const other = path.join(tmp, 'git', `${name}-other`)
  fs.mkdirSync(origin, { recursive: true })
  gitIn(origin, ['init', '-q', '--bare', '-b', 'main'])
  fs.mkdirSync(repo)
  const git = (...args: string[]) => gitIn(repo, args)
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  git('remote', 'add', 'origin', origin)
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n')
  git('add', '.')
  git('commit', '-q', '-m', 'a')
  git('push', '-q', 'origin', 'main')
  git('checkout', '-q', '-b', 'feat')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'ONE\ntwo\nthree\n')
  git('commit', '-q', '-am', 'shout the first line')
  git('push', '-q', 'origin', 'feat')
  git('checkout', '-q', 'main')
  execFileSync('git', ['clone', '-q', origin, other], { stdio: 'ignore' })
  gitIn(other, ['config', 'user.email', 'o@o'])
  gitIn(other, ['config', 'user.name', 'o'])

  const { db, schema } = dbm
  const projectId = db.insert(schema.projects).values({ name }).returning().get().id
  const repoId = db
    .insert(schema.repos)
    .values({ projectId, name, repoPath: repo, baseBranch: 'main', githubRepo: `acme/${name}` })
    .returning()
    .get().id
  if (looked) await look(repo)
  let n = 0
  /** Someone else's commit writing `text` to `file`, pushed to origin's `branch`. */
  const move = (file: string, text: string, branch = 'main') => {
    gitIn(other, ['fetch', '-q', 'origin'])
    const onOrigin = gitIn(other, ['branch', '-r', '--list', `origin/${branch}`])
    gitIn(other, ['checkout', '-q', '-B', branch, onOrigin ? `origin/${branch}` : 'origin/main'])
    fs.writeFileSync(path.join(other, file), text)
    gitIn(other, ['add', file])
    gitIn(other, ['commit', '-q', '-m', `${file} on ${branch}`])
    gitIn(other, ['push', '-q', 'origin', branch])
  }
  return {
    projectId,
    repoId,
    origin,
    repo,
    git,
    feat: git('rev-parse', 'feat'),
    /** Origin's main changes `feat`'s line its own way. */
    conflictingMove: () => move('a.txt', 'uno\ntwo\nthree\n'),
    /** Origin's main gets a file of its own. */
    cleanMove: () => move(`b-${++n}.txt`, 'b\n'),
    /** A new commit on origin's `feat`, clear of main. */
    headMove: () => move(`f-${++n}.txt`, 'f\n', 'feat'),
    /** A branch no PR is on. */
    otherMove: () => move(`o-${++n}.txt`, 'o\n', 'unrelated'),
    ticket: () => features.createTicket(projectId, { title: 'shout', branch: 'feat' }, 'claude'),
    /** The stored PR row, GitHub's word as of the last refresh. */
    row: () => db.select().from(schema.prs).where(eq(schema.prs.repoId, repoId)).get()!,
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

/** The PR of `feat` into main, number 1, as gh lists it. */
const ghPr = (f: Fixture, over: Partial<MyGhPr> = {}): MyGhPr => ({
  number: 1,
  title: 'shout',
  url: 'https://github.com/acme/app/pull/1',
  author: { login: 'enrique' },
  headRefName: 'feat',
  baseRefName: 'main',
  headRefOid: f.feat,
  isDraft: false,
  reviewDecision: '',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  statusCheckRollup: [],
  updatedAt: '2026-10-01T10:00:00Z',
  mergedAt: null,
  reviews: [],
  reviewRequests: [],
  comments: [],
  requested: false,
  assigned: false,
  ...over,
})

const queued = async (f: Fixture, number = 1) =>
  (await prs.listPrs(f.projectId)).find((p) => p.number === number)!

/** A PR from a fork, number 2: its head is in no checkout of the board. */
const forkPr = (f: Fixture, over: Partial<MyGhPr> = {}) =>
  ghPr(f, { number: 2, headRefName: 'fork/feat', headRefOid: FORK_HEAD, ...over })
const mergeTrees = () => spawned.filter((s) => s.file === 'git' && s.args[0] === 'merge-tree').length

describe("a PR's merge state, checked in the checkout", { timeout: 60_000 }, () => {
  it("shows conflicts once origin's base moved into them, though GitHub's stored word is mergeable", async () => {
    const f = await fixture('conflicted')
    answer = () => [ghPr(f)]
    await prs.refreshPrs(f.projectId)
    const t = f.ticket()
    expect((await needs.ticketView(t.id)).pr!.queue!.merge).toBe('clean')

    f.conflictingMove()
    await look(f.repo)
    await settle()

    const view = await needs.ticketView(t.id)
    expect(view.pr!.queue).toMatchObject({
      merge: 'conflicts',
      mergeCheck: { source: 'local', base: 'main', outdated: false, at: push.fetchStatus(f.repo).checkedAt },
    })
    expect(view.pr!.queue!.mergeCheck.at).toEqual(expect.any(String))
    expect(await queued(f)).toMatchObject({ merge: 'conflicts', mergeCheck: { source: 'local' } })
    // GitHub's own word is kept as it gave it.
    expect(f.row()).toMatchObject({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' })
  })

  it('tells conflicts without GitHub: no gh runs for the check, and a failing gh changes nothing', async () => {
    const f = await fixture('offline')
    answer = () => [ghPr(f)]
    await prs.refreshPrs(f.projectId)
    const t = f.ticket()
    answer = failing
    f.conflictingMove()
    await look(f.repo)
    await settle()

    spawned.length = 0
    expect((await needs.ticketView(t.id)).pr!.queue!.merge).toBe('conflicts')
    expect((await queued(f)).merge).toBe('conflicts')
    expect(mergeTrees()).toBe(1)
    expect(spawned.filter((s) => s.file === 'gh')).toEqual([])
  })

  it('shows a clean merge here as clean over an outdated or still-checking GitHub word', async () => {
    const f = await fixture('clean')
    answer = () => [ghPr(f)]
    await prs.refreshPrs(f.projectId)
    // A clean move after the row was fetched, and GitHub not answering since.
    answer = failing
    f.cleanMove()
    await look(f.repo)
    await settle()
    expect(f.row().fetchedAt < push.fetchStatus(f.repo).checkedAt!).toBe(true)
    expect(await queued(f)).toMatchObject({ merge: 'clean', mergeCheck: { source: 'local' } })

    // GitHub, asked afresh, is still working it out.
    answer = () => [ghPr(f, { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })]
    await prs.refreshPrs(f.projectId)
    expect(await queued(f)).toMatchObject({ merge: 'clean', mergeCheck: { source: 'local' } })
  })

  it("lets GitHub's word given since the board saw the base stand over a clean merge here", async () => {
    const f = await fixture('protected')
    answer = () => [ghPr(f)]
    await prs.refreshPrs(f.projectId)
    f.cleanMove()
    await look(f.repo)
    await settle()
    const said = [
      ['CONFLICTING', 'DIRTY', 'conflicts'],
      ['MERGEABLE', 'BEHIND', 'behind'],
      ['MERGEABLE', 'BLOCKED', 'blocked'],
    ] as const
    for (const [mergeable, mergeStateStatus, merge] of said) {
      answer = () => [ghPr(f, { mergeable, mergeStateStatus })]
      await prs.refreshPrs(f.projectId)
      expect(await queued(f)).toMatchObject({
        merge,
        mergeCheck: { source: 'github', at: f.row().fetchedAt, outdated: false },
      })
    }
  })

  it("shows conflicts here over GitHub's mergeable given after the base moved", async () => {
    const f = await fixture('fresh-word')
    f.conflictingMove()
    await look(f.repo)
    answer = () => [ghPr(f)]
    await prs.refreshPrs(f.projectId)
    expect(f.row()).toMatchObject({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' })
    expect((await queued(f)).merge).toBe('conflicts')
  })

  it('shows checking, never a stale mergeable, for a head not in the checkout once the base moved', async () => {
    const f = await fixture('fork')
    answer = () => [ghPr(f, { headRefOid: FORK_HEAD })]
    await prs.refreshPrs(f.projectId)
    expect(await queued(f)).toMatchObject({ merge: 'clean', mergeCheck: { source: 'github' } })

    // GitHub does not answer the refresh the move asks for: its word stays older than the base.
    answer = failing
    f.cleanMove()
    await look(f.repo)
    await settle()
    expect(await queued(f)).toMatchObject({
      merge: 'checking',
      mergeCheck: { source: 'github', outdated: true, at: f.row().fetchedAt },
    })
    const t = f.ticket()
    expect((await needs.ticketView(t.id)).pr!.queue!.merge).toBe('checking')
  })

  it("takes GitHub's word for a head not in the checkout when it is not older than the base", async () => {
    const f = await fixture('fork-fresh')
    f.cleanMove()
    await look(f.repo)
    answer = () => [ghPr(f, { headRefOid: FORK_HEAD })]
    await prs.refreshPrs(f.projectId)
    expect(await queued(f)).toMatchObject({
      merge: 'clean',
      mergeCheck: { source: 'github', at: f.row().fetchedAt, outdated: false },
    })
    answer = () => [ghPr(f, { headRefOid: FORK_HEAD, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })]
    await prs.refreshPrs(f.projectId)
    expect((await queued(f)).merge).toBe('conflicts')
  })

  it("takes GitHub's word for a repo whose path is no checkout, base known or not", async () => {
    const { db, schema } = dbm
    const projectId = db.insert(schema.projects).values({ name: 'nowhere' }).returning().get().id
    const repoId = db
      .insert(schema.repos)
      .values({ projectId, name: 'app', repoPath: '/r/nowhere', baseBranch: 'main', githubRepo: 'acme/app' })
      .returning()
      .get().id
    answer = () => [pr({ mergeStateStatus: 'BEHIND' })]
    await prs.refreshPrs(projectId)
    const row = (await prs.listPrs(projectId))[0]!
    expect(row).toMatchObject({ merge: 'behind', mergeCheck: { source: 'github', outdated: false } })
    // The board saw origin's main before GitHub's word: git cannot tell here, so GitHub's word stands.
    db.insert(schema.originRefs)
      .values({ repoId, ref: 'main', sha: FORK_HEAD, seenAt: '2020-01-01T00:00:00.000Z' })
      .run()
    expect((await prs.listPrs(projectId))[0]).toMatchObject({
      merge: 'behind',
      mergeCheck: { source: 'github', at: row.fetchedAt },
    })
  })

  it('merges a PR once per base and head: again only after the base moved', async () => {
    const f = await fixture('memo')
    answer = () => [ghPr(f)]
    await prs.refreshPrs(f.projectId)
    spawned.length = 0
    await queued(f)
    await queued(f)
    expect(mergeTrees()).toBe(1)

    f.cleanMove()
    await look(f.repo)
    await settle()
    await queued(f)
    await queued(f)
    expect(mergeTrees()).toBe(2)
  })

  it('leaves the checkout as it was: its refs, its worktree and its branch', async () => {
    const f = await fixture('read-only')
    answer = () => [ghPr(f)]
    await prs.refreshPrs(f.projectId)
    f.conflictingMove()
    await look(f.repo)
    await settle()
    const state = () => ({
      refs: f.git('for-each-ref', '--format=%(refname) %(objectname)'),
      status: f.git('status', '--porcelain'),
      branch: f.git('rev-parse', '--abbrev-ref', 'HEAD'),
    })
    const before = state()
    spawned.length = 0
    expect((await queued(f)).merge).toBe('conflicts')
    expect(mergeTrees()).toBe(1)
    expect(state()).toEqual(before)
  })
})

describe('a first look at origin, which is no move', { timeout: 60_000 }, () => {
  /** GitHub's word on both PRs: the one of `feat` blocked by branch protection, the fork's mergeable. */
  const said = (f: Fixture) => [ghPr(f, { mergeStateStatus: 'BLOCKED' }), forkPr(f)]

  const expectGithubsWord = async (f: Fixture) => {
    const fetchedAt = f.row().fetchedAt
    expect(await queued(f)).toMatchObject({
      merge: 'blocked',
      mergeCheck: { source: 'github', at: fetchedAt, outdated: false },
    })
    expect(await queued(f, 2)).toMatchObject({
      merge: 'clean',
      mergeCheck: { source: 'github', at: fetchedAt, outdated: false },
    })
  }

  it("leaves GitHub's word standing after the board first looks at a repo just added", async () => {
    const f = await fixture('first-look', { looked: false })
    answer = () => said(f)
    await prs.refreshPrs(f.projectId)
    await look(f.repo)
    await settle()
    expect(asked).toHaveLength(1)
    await expectGithubsWord(f)
  })

  it('leaves it standing after the repo is pointed at another checkout of origin, until the base really moves', async () => {
    const f = await fixture('repath')
    answer = () => said(f)
    await prs.refreshPrs(f.projectId)
    const again = path.join(tmp, 'git', 'repath-again')
    execFileSync('git', ['clone', '-q', f.origin, again], { stdio: 'ignore' })
    const { updateRepo } = await import('./repos')
    await updateRepo(f.repoId, { repoPath: again }, 'enrique')
    await look(again)
    await settle()
    expect(asked).toHaveLength(1)
    expect(
      dbm.db
        .select()
        .from(dbm.schema.originRefMoves)
        .where(eq(dbm.schema.originRefMoves.repoId, f.repoId))
        .all(),
    ).toEqual([])
    await expectGithubsWord(f)

    // A real move after GitHub's word, which GitHub does not answer for: the fork's PR is checking, and
    // the conflict found here wins.
    answer = failing
    f.conflictingMove()
    await look(again)
    await settle()
    expect(await queued(f)).toMatchObject({ merge: 'conflicts', mergeCheck: { source: 'local' } })
    expect(await queued(f, 2)).toMatchObject({
      merge: 'checking',
      mergeCheck: { source: 'github', outdated: true },
    })
  })
})

describe('no gh of its own', { timeout: 60_000 }, () => {
  it('runs no gh to serve the queue and a ticket, the refresh a move starts included', async () => {
    const f = await fixture('no-gh')
    answer = () => [ghPr(f)]
    await prs.refreshPrs(f.projectId)
    const t = f.ticket()
    spawned.length = 0
    f.conflictingMove()
    await look(f.repo)
    await settle()
    // The move had GitHub asked, through the fake.
    expect(asked).toHaveLength(2)
    expect((await needs.ticketView(t.id)).pr!.queue!.merge).toBe('conflicts')
    expect((await queued(f)).merge).toBe('conflicts')
    expect(mergeTrees()).toBe(1)
    expect(spawned.filter((s) => s.file === 'gh')).toEqual([])
  })
})

describe('refreshing the PRs when origin moves', { timeout: 60_000 }, () => {
  it("refreshes a project's PRs when an open PR's base or head moves, however recent the last refresh", async () => {
    const f = await fixture('moves')
    fakeClock()
    answer = () => [ghPr(f)]
    await prs.refreshPrs(f.projectId)
    expect(asked).toHaveLength(1)

    vi.setSystemTime(Date.now() + 2 * 60_000)
    f.cleanMove()
    await look(f.repo)
    await settle()
    expect(asked).toHaveLength(2)

    vi.setSystemTime(Date.now() + 2 * 60_000)
    f.headMove()
    await look(f.repo)
    await settle()
    expect(asked).toHaveLength(3)
  })

  it('refreshes nothing for a move of a branch no open PR is on', async () => {
    const f = await fixture('unrelated')
    answer = () => [ghPr(f)]
    await prs.refreshPrs(f.projectId)
    f.otherMove()
    await look(f.repo)
    await settle()
    expect(asked).toHaveLength(1)
  })

  it('refreshes at most once a minute for moves, the last one when the minute ends', async () => {
    const f = await fixture('throttle')
    fakeClock()
    answer = () => [ghPr(f)]
    await prs.refreshPrs(f.projectId)
    const start = Date.now()

    f.cleanMove()
    await look(f.repo)
    await settle()
    expect(asked).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(10_000)
    f.cleanMove()
    await look(f.repo)
    await settle()
    expect(asked).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(start + 59_000 - Date.now())
    await settle()
    expect(asked).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()
    expect(asked).toHaveLength(3)
    expect(asked[2]! - asked[1]!).toBeGreaterThanOrEqual(60_000)

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(asked).toHaveLength(3)
  })

  it('never fails nor waits for the push states that saw the move, when GitHub fails', async () => {
    const f = await fixture('gh-down')
    answer = () => [ghPr(f)]
    await prs.refreshPrs(f.projectId)
    answer = failing
    f.cleanMove()
    // Fetched by hand, and read after the last listing ran out: the push states' own listing sees the move.
    f.git('fetch', '-q', 'origin')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 5_000)
    const states = await push.pushStates(f.repo, ['feat'])
    expect(states.get('feat')).toMatchObject({ state: 'pushed' })
    expect(asked).toHaveLength(2)
    await settle()
    expect(asked).toHaveLength(2)
    expect(errors).toHaveBeenCalledWith(
      `PR refresh failed for project ${f.projectId}:`,
      expect.objectContaining({ message: 'gh pr list failed' }),
    )
  })
})

/** A project on a repo gh can see but git cannot (no checkout): only refreshes and their timers. */
function ghOnly(name: string) {
  const { db, schema } = dbm
  const projectId = db.insert(schema.projects).values({ name }).returning().get().id
  const repoId = db
    .insert(schema.repos)
    .values({ projectId, name, repoPath: `/r/${name}`, baseBranch: 'main', githubRepo: `acme/${name}` })
    .returning()
    .get().id
  return { projectId, repoId }
}

const pr = (over: Partial<MyGhPr> = {}) => ghPr({ feat: FORK_HEAD } as Fixture, over)
const unknown = { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }
const gaps = () => asked.slice(1).map((at, i) => at - asked[i]!)

describe("asking GitHub again while it works out a PR's mergeability", () => {
  it('asks again at most four times, each later than the last, until a move starts it over', async () => {
    const p = ghOnly('unknown')
    fakeClock()
    answer = () => [pr(unknown)]
    await prs.refreshPrs(p.projectId)
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(gaps()).toEqual([30_000, 60_000, 120_000, 240_000])

    prs.recheckMovedPrs([{ repoId: p.repoId, ref: 'main' }])
    await settle()
    expect(asked).toHaveLength(6)
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(gaps().slice(5)).toEqual([30_000, 60_000, 120_000, 240_000])
  })

  it('stops once GitHub knows', async () => {
    const p = ghOnly('known')
    fakeClock()
    answer = () => [pr(unknown)]
    await prs.refreshPrs(p.projectId)
    answer = () => [pr()]
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(gaps()).toEqual([30_000])
  })

  it('asks nothing more when only a merged PR is unknown, or none is', async () => {
    const p = ghOnly('merged-unknown')
    fakeClock()
    answer = () => [pr({ ...unknown, mergedAt: new Date().toISOString() }), pr({ number: 2 })]
    await prs.refreshPrs(p.projectId)
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(asked).toHaveLength(1)

    const q = ghOnly('all-known')
    asked.length = 0
    answer = () => [pr()]
    await prs.refreshPrs(q.projectId)
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(asked).toHaveLength(1)
  })
})

describe("the ticket read refreshes the project's PRs", { timeout: 60_000 }, () => {
  it('in the background, once per refresh interval, without waiting for GitHub', async () => {
    const f = await fixture('ticket-read')
    answer = () => [ghPr(f)]
    await prs.refreshPrs(f.projectId)
    const t = f.ticket()
    await needs.ticketView(t.id)
    expect(asked).toHaveLength(1)

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 6 * 60_000)
    // GitHub never answers: the read does not wait for it.
    answer = () => new Promise(() => {})
    const view = await needs.ticketView(t.id)
    expect(view.pr!.queue!.merge).toBe('clean')
    expect(asked).toHaveLength(2)
    await needs.ticketView(t.id)
    expect(asked).toHaveLength(2)
  })
})
