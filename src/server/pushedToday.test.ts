import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp

/**
 * Every git command the board runs, in order. The spy only notes the arguments: real git still runs
 * (git.ts promisifies `execFile`, and calls it with a callback where it writes to git's stdin, so
 * both forms are wrapped).
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

const gitIn = (cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  }).trim()

const day = 86_400_000
/** Noon yesterday, in git's `<seconds> <zone>` form. */
const yesterday = () => `${Math.floor((Date.now() - day) / 1000)} +0000`

/**
 * A repo of the board: a bare origin and the board's checkout of it, whose main has `history`
 * commits, all on origin before the board first looks. Someone else's clone (`other`) pushes behind
 * the checkout's back. The project is the repo's alone.
 */
async function fixture(name: string, history = 1) {
  // Beside the board's data, not in it.
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
  for (let i = 0; i < history; i++) {
    fs.writeFileSync(path.join(repo, `old-${i}.txt`), `old ${i}\n`)
    git('add', '.')
    git('commit', '-q', '-m', `old ${i}`)
  }
  git('push', '-q', 'origin', 'main')
  execFileSync('git', ['clone', '-q', origin, other], { stdio: 'ignore' })
  gitIn(other, ['config', 'user.email', 'o@o'])
  gitIn(other, ['config', 'user.name', 'o'])

  const { db, schema } = await import('#/db')
  const projectId = db.insert(schema.projects).values({ name }).returning().get().id
  const repoId = db
    .insert(schema.repos)
    .values({ projectId, name, repoPath: repo, baseBranch: 'main' })
    .returning()
    .get().id
  await look(repo)
  return {
    projectId,
    repoId,
    repo,
    other,
    git,
    /** Someone else: a commit in their clone writing `lines` to `file` (env sets its dates). */
    commit: (file: string, lines: string, msg: string, env: NodeJS.ProcessEnv = {}) => {
      fs.writeFileSync(path.join(other, file), lines)
      gitIn(other, ['add', file])
      gitIn(other, ['commit', '-q', '-m', msg], env)
      return gitIn(other, ['rev-parse', 'HEAD'])
    },
    push: (...args: string[]) => gitIn(other, ['push', '-q', 'origin', ...args]),
    moves: () =>
      db.select().from(schema.originRefMoves).where(eq(schema.originRefMoves.repoId, repoId)).all(),
    refs: () => db.select().from(schema.originRefs).where(eq(schema.originRefs.repoId, repoId)).all(),
  }
}

/**
 * A repo of the board whose checkout has `commits` commits on main and has not fetched or pushed yet,
 * on an origin that is empty unless `pushed`, which has the checkout's commits pushed there by
 * someone else's clone. The board has not looked at it.
 */
async function unseen(name: string, commits: number, opts: { pushed?: boolean } = {}) {
  const origin = path.join(tmp, 'git', `${name}.git`)
  const repo = path.join(tmp, 'git', name)
  fs.mkdirSync(origin, { recursive: true })
  gitIn(origin, ['init', '-q', '--bare', '-b', 'main'])
  fs.mkdirSync(repo)
  const git = (...args: string[]) => gitIn(repo, args)
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  git('remote', 'add', 'origin', origin)
  for (let i = 0; i < commits; i++) {
    fs.writeFileSync(
      path.join(repo, `n-${i}.txt`),
      `n ${i}
`,
    )
    git('add', '.')
    git('commit', '-q', '-m', `n ${i}`)
  }
  // Pushed from elsewhere: the checkout's copy of origin still has no branch.
  if (opts.pushed) gitIn(origin, ['fetch', '-q', repo, 'main:main'])
  const { db, schema } = await import('#/db')
  const projectId = db.insert(schema.projects).values({ name }).returning().get().id
  const repoId = db
    .insert(schema.repos)
    .values({ projectId, name, repoPath: repo, baseBranch: 'main' })
    .returning()
    .get().id
  return {
    projectId,
    repoId,
    repo,
    git,
    moves: () =>
      db.select().from(schema.originRefMoves).where(eq(schema.originRefMoves.repoId, repoId)).all(),
  }
}

/** What the board does now and then: fetch origin into the checkout, then read its branches afresh. */
async function look(repo: string) {
  const push = await import('./push')
  await push.fetchRepo(repo, { force: true })
  await push.readRefs(repo)
}

const counting = () => import('./pushedToday')

// Each test builds its repos: a few dozen git processes, slow on Windows, more so beside the other suites.
const slow = { timeout: 30_000 }

/** The per-commit git a read ran since `spawned` was emptied: not the listing of refs, nor a fetch. */
const perCommit = () =>
  spawned.filter((a) => ['log', 'rev-list', 'diff', 'show'].includes(a[0]!)).map((a) => a.join(' '))

describe('noteOriginRefs', slow, () => {
  it("takes the first look as where origin's branches are, then records each move it sees", async () => {
    const f = await fixture('moves')
    // The first look: origin's main noted, nothing seen arriving.
    expect(f.refs().map((r) => r.ref)).toEqual(['main'])
    expect(f.moves()).toEqual([])

    f.commit('a.txt', 'a\n', 'a')
    f.push('HEAD:refs/heads/feat/a')
    await look(f.repo)
    const sha = f.git('rev-parse', 'origin/feat/a')
    expect(f.moves()).toMatchObject([{ ref: 'feat/a', oldSha: null, newSha: sha }])

    // Looking again with nothing moved records nothing.
    await look(f.repo)
    expect(f.moves()).toHaveLength(1)

    // A branch that moves, and one that goes away.
    const main = f.git('rev-parse', 'origin/main')
    f.push('HEAD:main')
    f.push('--delete', 'feat/a')
    await look(f.repo)
    expect(f.moves().slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: 'main', oldSha: main, newSha: sha }),
        expect.objectContaining({ ref: 'feat/a', oldSha: sha, newSha: null }),
      ]),
    )
    expect(f.refs().map((r) => [r.ref, r.sha])).toEqual([['main', sha]])
  })

  it('starts over when a repo is pointed at another checkout', async () => {
    const f = await fixture('repointed')
    const g = await fixture('repointed-elsewhere')
    f.commit('r.txt', 'r\n', 'r')
    f.push('HEAD:refs/heads/feat/r')
    await look(f.repo)
    expect(f.moves()).toHaveLength(1)

    const { updateRepo } = await import('./repos')
    await updateRepo(f.repoId, { repoPath: g.repo }, 't')
    expect(f.refs()).toEqual([])
    expect(f.moves()).toEqual([])
    // Its first look at the other checkout: nothing arrived, whatever history that one has.
    await look(g.repo)
    expect(f.refs().map((r) => r.ref)).toEqual(['main'])
    const { pushedToday } = await counting()
    expect(await pushedToday(f.projectId)).toMatchObject({ commits: 0, repos: [] })
  })

  it('counts the first push to an origin that had no branch when the board first looked', async () => {
    const f = await unseen('empty-origin', 3)
    // The board fetches the empty origin and lists no branch of it: a look all the same.
    await look(f.repo)
    expect(f.moves()).toEqual([])

    f.git('push', '-q', 'origin', 'main')
    await look(f.repo)
    expect(f.moves()).toMatchObject([{ ref: 'main', oldSha: null, newSha: f.git('rev-parse', 'main') }])
    const { pushedToday } = await counting()
    expect(await pushedToday(f.projectId)).toMatchObject({
      commits: 3,
      added: 3,
      removed: 0,
      repos: [{ repoId: f.repoId, branches: [{ branch: 'main', commits: 3 }] }],
    })
  })

  it('does not take a checkout that never fetched for a look at an empty origin', async () => {
    // Origin has history the checkout has never fetched: its listing shows no branch of origin.
    const f = await unseen('never-fetched', 2, { pushed: true })
    const push = await import('./push')
    expect((await push.readRefs(f.repo))!.remote.size).toBe(0)

    // The board's first fetch: origin's history was there before the board looked, not pushed today.
    await look(f.repo)
    expect(f.moves()).toEqual([])
    const { pushedToday } = await counting()
    expect(await pushedToday(f.projectId)).toMatchObject({ commits: 0, repos: [] })
  })

  it('records nothing for a checkout no repo of the board is on', async () => {
    const { noteOriginRefs } = await counting()
    expect(() =>
      noteOriginRefs(path.join(tmp, 'nowhere'), { local: new Map(), remote: new Map([['main', 'abc']]) }),
    ).not.toThrow()
  })
})

describe('pushedToday', slow, () => {
  it('counts a commit written yesterday and pushed today', async () => {
    const f = await fixture('yesterday')
    const when = yesterday()
    const sha = f.commit('y.txt', 'one\ntwo\n', 'from yesterday', {
      GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_DATE: when,
    })
    expect(Date.parse(gitIn(f.other, ['log', '-1', '--format=%cI', sha]))).toBeLessThan(Date.now() - day / 2)
    f.push('HEAD:refs/heads/feat/y')
    await look(f.repo)
    const { pushedToday } = await counting()
    expect(await pushedToday(f.projectId)).toMatchObject({ commits: 1, added: 2, removed: 0 })
  })

  it('counts a commit once however many branches bring it, under the first', async () => {
    const f = await fixture('twice')
    f.commit('t.txt', 't\n', 'twice')
    f.push('HEAD:refs/heads/a')
    await look(f.repo)
    f.push('HEAD:refs/heads/b')
    await look(f.repo)
    const { pushedToday } = await counting()
    const today = await pushedToday(f.projectId)
    expect(today).toMatchObject({ commits: 1, added: 1, removed: 0 })
    expect(today.repos).toEqual([
      expect.objectContaining({
        repoId: f.repoId,
        commits: 1,
        branches: [{ branch: 'a', commits: 1, added: 1, removed: 0, ticket: null }],
      }),
    ])
  })

  it("counts only a branch's own commits, not what origin already had", async () => {
    const f = await fixture('cut', 5)
    const { pushedToday } = await counting()
    // A branch cut from main, pushed without a commit of its own: nothing reached origin.
    f.push('HEAD:refs/heads/empty')
    await look(f.repo)
    expect(await pushedToday(f.projectId)).toMatchObject({ commits: 0, added: 0, removed: 0, repos: [] })

    f.commit('c1.txt', 'c1\n', 'c1')
    f.commit('c2.txt', 'c2\n', 'c2')
    f.push('HEAD:refs/heads/feat/cut')
    await look(f.repo)
    expect(await pushedToday(f.projectId)).toMatchObject({
      commits: 2,
      repos: [{ branches: [{ branch: 'feat/cut', commits: 2 }] }],
    })
  })

  it("adds up each commit's git diff --shortstat, and leaves merge commits out", async () => {
    const f = await fixture('lines')
    fs.writeFileSync(path.join(f.other, 'old-0.txt'), 'one\ntwo\nthree\n')
    gitIn(f.other, ['commit', '-q', '-am', 'three lines'])
    // Three lines added and one removed.
    const sha = f.commit('old-0.txt', 'one\nTWO\nthree\nfour\nfive\n', 'edit')
    const shortstat = gitIn(f.other, ['diff', '--shortstat', `${sha}^`, sha])
    expect(shortstat).toMatch(/3 insertions\(\+\), 1 deletion\(-\)/)
    // A merge of a side branch, which repeats its lines.
    gitIn(f.other, ['checkout', '-q', '-b', 'side', 'HEAD~2'])
    f.commit('side.txt', 's\n', 'side')
    gitIn(f.other, ['checkout', '-q', 'main'])
    gitIn(f.other, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side'])
    f.push('HEAD:main')
    await look(f.repo)

    const { pushedToday } = await counting()
    // old-0.txt: 1 line replaced by 3 (+3 −1), then +3 −1 again; side.txt +1; the merge not at all.
    expect(await pushedToday(f.projectId)).toMatchObject({ commits: 3, added: 7, removed: 2 })
    const sum = (rev: string) =>
      gitIn(f.other, ['diff', '--shortstat', `${rev}^`, rev])
        .match(/\d+ (?:insertion|deletion)/g)!
        .map((s) => Number(s.split(' ')[0]))
    expect(sum(sha)).toEqual([3, 1])
  })

  it('counts the local day: a move seen before midnight belongs to the day before', async () => {
    const f = await fixture('midnight')
    const { noteOriginRefs, pushedToday } = await counting()
    const { listRefs } = await import('./git')
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    const at = (minutes: number) => new Date(midnight.getTime() + minutes * 60_000)

    f.commit('late.txt', 'late\n', 'late')
    f.push('HEAD:refs/heads/late')
    gitIn(f.repo, ['fetch', '-q', 'origin'])
    noteOriginRefs(f.repo, await listRefs(f.repo), at(-10))
    f.commit('early.txt', 'early\nmorning\n', 'early')
    f.push('HEAD:refs/heads/early')
    gitIn(f.repo, ['fetch', '-q', 'origin'])
    noteOriginRefs(f.repo, await listRefs(f.repo), at(10))

    expect(await pushedToday(f.projectId, at(12 * 60))).toMatchObject({
      date: (await import('#/lib/format')).localDate(midnight),
      commits: 1,
      added: 2,
      repos: [{ branches: [{ branch: 'early' }] }],
    })
    expect(await pushedToday(f.projectId, at(-1))).toMatchObject({
      commits: 1,
      added: 1,
      repos: [{ branches: [{ branch: 'late' }] }],
    })
    // The day after: nothing yet.
    expect(await pushedToday(f.projectId, at(36 * 60))).toMatchObject({ commits: 0, repos: [] })
  })

  it('asks git nothing per commit on a second read, and only for the new range after a move', async () => {
    const f = await fixture('cache')
    const { pushedToday } = await counting()
    f.commit('k1.txt', 'k1\n', 'k1')
    f.push('HEAD:refs/heads/k')
    await look(f.repo)
    // What was counted, whenever origin was last fetched.
    const read = async () => ({ ...(await pushedToday(f.projectId)), checkedAt: null })
    const first = await read()
    expect(first).toMatchObject({ commits: 1 })

    spawned.length = 0
    expect(await read()).toEqual(first)
    await look(f.repo)
    expect(await read()).toEqual(first)
    expect(perCommit()).toEqual([])

    // One more commit on the branch: one git log, for that move alone.
    f.commit('k2.txt', 'k2\n', 'k2')
    f.push('HEAD:refs/heads/k')
    await look(f.repo)
    spawned.length = 0
    expect(await pushedToday(f.projectId)).toMatchObject({ commits: 2, added: 2 })
    expect(perCommit()).toEqual([expect.stringMatching(/^log --no-merges /)])
    spawned.length = 0
    await pushedToday(f.projectId)
    expect(perCommit()).toEqual([])
  })

  it("names the ticket a branch belongs to, and adds the project's repos up", async () => {
    const f = await fixture('tickets')
    const { createTicket } = await import('./features')
    const ticket = createTicket(
      f.projectId,
      { title: 'The work', branch: 'feat/work', status: 'in_progress' },
      't',
    )
    // A second repo joins the project.
    const g = await fixture('tickets-second')
    const { db, schema } = await import('#/db')
    db.update(schema.repos).set({ projectId: f.projectId }).where(eq(schema.repos.id, g.repoId)).run()

    f.commit('w.txt', 'w\n', 'work')
    f.push('HEAD:refs/heads/feat/work')
    g.commit('x.txt', 'x\ny\n', 'elsewhere')
    g.push('HEAD:refs/heads/feat/work')
    await look(f.repo)
    await look(g.repo)

    const { pushedToday } = await counting()
    const today = await pushedToday(f.projectId)
    expect(today).toMatchObject({ commits: 2, added: 3, removed: 0 })
    expect(today.checkedAt).toEqual(expect.any(String))
    const byName = Object.fromEntries(today.repos.map((r) => [r.name, r]))
    // A ticket without a repo is on the project's first (by name): only there is the branch its own.
    expect(byName.tickets!.branches).toEqual([
      { branch: 'feat/work', commits: 1, added: 1, removed: 0, ticket: { id: ticket.id, title: 'The work' } },
    ])
    expect(byName['tickets-second']!.branches).toEqual([
      { branch: 'feat/work', commits: 1, added: 2, removed: 0, ticket: null },
    ])
  })
})
