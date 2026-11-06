import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { and, eq, isNull } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { MyGhPr } from './git'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-auto-phases-'))
process.env.DATA_DIR = tmp
const origin = path.join(tmp, 'origin.git')
const repo = path.join(tmp, 'repo')

// gh answers from fixtures, as in prs.test.ts: a refresh reads whatever `found` holds. git is the real one.
let found: MyGhPr[] = []
/** What GitHub says of a PR that left the searches; null (it cannot say) when not set. */
let states: Record<number, 'OPEN' | 'CLOSED' | 'MERGED'> = {}
vi.mock('./git', async (original) => {
  const real = await original<typeof import('./git')>()
  return {
    ...real,
    listMyPrs: async () => found,
    currentGithubLogin: async () => 'enrique',
    prMerged: async () => false,
    prStateOf: async (_repoPath: string, number: number) => states[number] ?? null,
  }
})
afterEach(() => {
  found = []
  states = {}
})

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const git = (...args: string[]) => gitIn(repo, ...args)

let dbm: typeof import('#/db')
let features: typeof import('./features')
let needs: typeof import('./needs')
let auto: typeof import('./autoPhases')
let prs: typeof import('./prs')
let push: typeof import('./push')
let noteActor: typeof import('./actors').noteActor
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
  dbm = await import('#/db')
  features = await import('./features')
  needs = await import('./needs')
  auto = await import('./autoPhases')
  prs = await import('./prs')
  push = await import('./push')
  ;({ noteActor } = await import('./actors'))
}, 60_000)

/** A commit on `branch` (made from main when it does not exist), leaving main checked out. */
function commitOn(branch: string, file: string) {
  const exists = git('branch', '--list', branch) !== ''
  git('checkout', '-q', ...(exists ? [branch] : ['-b', branch, 'main']))
  fs.writeFileSync(path.join(repo, file), `${file}\n`)
  git('add', file)
  git('commit', '-q', '-m', file)
  git('checkout', '-q', 'main')
  return git('rev-parse', branch)
}

let projects = 0
/**
 * A project on the test repo (or on `repoPath`). With `github` the PR refresh reads its PRs from the
 * fixtures; without, a refresh (the one a read starts in the background too) leaves its rows alone.
 */
function newProject(repoPath: string = repo, opts: { github?: boolean } = {}) {
  const projectId = dbm.db
    .insert(dbm.schema.projects)
    .values({ name: `p${++projects}` })
    .returning()
    .get().id
  const repoId = dbm.db
    .insert(dbm.schema.repos)
    .values({ projectId, name: 'repo', repoPath, baseBranch: 'main', githubRepo: opts.github ? 'o/r' : null })
    .returning()
    .get().id
  return { projectId, repoId }
}

const newTicket = (projectId: number, input: { title?: string; branch?: string; prNumber?: number } = {}) =>
  needs.newTicket(projectId, { title: 't', status: 'in_progress', ...input }, 'claude', { agent: true })

/** The ticket's top-level tasks straight from the table: text to done. */
const ticks = (ticketId: number) =>
  Object.fromEntries(
    dbm.db
      .select()
      .from(dbm.schema.tasks)
      .where(and(eq(dbm.schema.tasks.ticketId, ticketId), isNull(dbm.schema.tasks.parentId)))
      .all()
      .map((t) => [t.text, t.done]),
  )
const taskOf = (ticketId: number, text: string) =>
  dbm.db
    .select()
    .from(dbm.schema.tasks)
    .where(and(eq(dbm.schema.tasks.ticketId, ticketId), eq(dbm.schema.tasks.text, text)))
    .get()!
/** Set a tick straight in the table, as an earlier state of the board. */
const setTick = (ticketId: number, text: string, done: boolean) =>
  dbm.db
    .update(dbm.schema.tasks)
    .set({ done })
    .where(eq(dbm.schema.tasks.id, taskOf(ticketId, text).id))
    .run()
/**
 * Move the ticket's posts an hour back, so a commit made now comes after them (git keeps whole seconds:
 * a commit in the same second as a post would not read as newer).
 */
const backdateSummaries = (ticketId: number) =>
  dbm.db
    .update(dbm.schema.updates)
    .set({ createdAt: new Date(Date.now() - 3_600_000).toISOString() })
    .where(eq(dbm.schema.updates.ticketId, ticketId))
    .run()
/** A ticket read, as the page and get_ticket read it: the phases reconcile on it. */
const read = (ticketId: number) => needs.ticketView(ticketId)

function prRow(
  projectId: number,
  repoId: number,
  number: number,
  over: Partial<typeof dbm.schema.prs.$inferInsert> = {},
) {
  const now = new Date().toISOString()
  return dbm.db
    .insert(dbm.schema.prs)
    .values({
      projectId,
      repoId,
      number,
      title: `pr ${number}`,
      url: `https://github.com/o/r/pull/${number}`,
      author: 'enrique',
      headRef: `feat/${number}`,
      baseRef: 'main',
      headSha: 'a'.repeat(40),
      updatedAt: now,
      fetchedAt: now,
      ...over,
    })
    .returning()
    .get()
}
const setPr = (id: number, set: Partial<typeof dbm.schema.prs.$inferInsert>) =>
  dbm.db.update(dbm.schema.prs).set(set).where(eq(dbm.schema.prs.id, id)).run()

const ghPr = (number: number, over: Partial<MyGhPr> = {}): MyGhPr => ({
  number,
  title: `pr ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  author: { login: 'enrique' },
  headRefName: `feat/${number}`,
  baseRefName: 'main',
  headRefOid: 'b'.repeat(40),
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
const failingRun = {
  __typename: 'CheckRun' as const,
  name: 'check',
  workflowName: 'CI',
  status: 'COMPLETED',
  conclusion: 'FAILURE',
  detailsUrl: '',
  startedAt: '2026-10-01T09:00:00Z',
}

describe('autoPhaseOf', () => {
  it('is a top-level task named Pushed, PR, CI, Preview, Summary or Merged, trimmed, in any case', async () => {
    const { autoPhaseOf } = await import('#/lib/autoPhases')
    expect(autoPhaseOf({ parentId: null, text: 'Pushed' })).toBe('Pushed')
    expect(autoPhaseOf({ parentId: null, text: ' summary ' })).toBe('Summary')
    expect(autoPhaseOf({ parentId: 5, text: 'Summary' })).toBeNull()
    expect(autoPhaseOf({ parentId: null, text: ' ci ' })).toBe('CI')
    expect(autoPhaseOf({ parentId: null, text: 'MERGED' })).toBe('Merged')
    expect(autoPhaseOf({ parentId: null, text: 'pr' })).toBe('PR')
    expect(autoPhaseOf({ parentId: null, text: 'preview' })).toBe('Preview')
    for (const text of ['Implementation', 'Hand-off post', 'CI green', 'PR opened', 'Summary post', ''])
      expect(autoPhaseOf({ parentId: null, text })).toBeNull()
    expect(autoPhaseOf({ parentId: 3, text: 'CI' })).toBeNull()
  })
})

describe('autoPhaseRules', () => {
  const row = (over: Partial<import('#/db/schema').Pr> = {}) => ({
    open: true,
    mergedAt: null,
    checks: [],
    headSha: 'abc1234def',
    localCiSha: null,
    leftAs: null,
    ...over,
  })
  const pass = [{ name: 'c', state: 'pass' as const, url: null }]

  it('Pushed: pushed (behind too), remote-only or merged; ahead, local-only and none untick; unknown stays', () => {
    const pushed = (state: import('./push').PushState) =>
      auto.autoPhaseRules({ push: { state }, pr: null, preview: false, summary: null }).Pushed
    for (const state of ['pushed', 'remote-only', 'merged'] as const) expect(pushed(state)).toBe(true)
    for (const state of ['ahead', 'local-only', 'none'] as const) expect(pushed(state)).toBe(false)
    expect(auto.autoPhaseRules({ push: null, pr: null, preview: false, summary: null }).Pushed).toBeNull()
  })

  it('PR: open or merged; closed without merging or none untick; unknown stays', () => {
    const rule = (pr: ReturnType<typeof row> | null | undefined) =>
      auto.autoPhaseRules({ push: { state: 'pushed' }, pr, preview: false, summary: null }).PR
    expect(rule(row())).toBe(true)
    expect(rule(row({ open: false, mergedAt: '2026-10-01T00:00:00Z' }))).toBe(true)
    expect(rule(row({ open: false, leftAs: 'MERGED' }))).toBe(true)
    expect(rule(row({ open: false, leftAs: 'CLOSED' }))).toBe(false)
    expect(rule(null)).toBe(false)
    expect(rule(undefined)).toBeNull()
  })

  it('a PR closed with no merge time that GitHub has not called closed is unknown: PR, CI and Merged stay', () => {
    const gone = row({ open: false, checks: pass })
    expect(
      auto.autoPhaseRules({ push: { state: 'pushed' }, pr: gone, preview: false, summary: null }),
    ).toMatchObject({
      PR: null,
      CI: null,
      Merged: null,
    })
    // The branch merged still says Merged.
    expect(
      auto.autoPhaseRules({ push: { state: 'merged' }, pr: gone, preview: false, summary: null }).Merged,
    ).toBe(true)
  })

  it('CI: green checks, or the local-green SHA equal to the head; failing or pending checks untick', () => {
    const rule = (pr: ReturnType<typeof row> | null | undefined) =>
      auto.autoPhaseRules({ push: { state: 'pushed' }, pr, preview: false, summary: null }).CI
    expect(rule(row({ checks: pass }))).toBe(true)
    expect(rule(row({ checks: [{ name: 'c', state: 'fail', url: null }] }))).toBe(false)
    expect(rule(row({ checks: [{ name: 'c', state: 'pending', url: null }] }))).toBe(false)
    expect(rule(row())).toBe(false)
    // Red on GitHub (its checks do not run) but green here, on this very head.
    expect(rule(row({ checks: [{ name: 'c', state: 'fail', url: null }], localCiSha: 'abc1234def' }))).toBe(
      true,
    )
    expect(rule(row({ localCiSha: 'older' }))).toBe(false)
    // A PR closed without merging has no CI to speak of.
    expect(rule(row({ open: false, leftAs: 'CLOSED', checks: pass }))).toBe(false)
    expect(rule(row({ open: false, mergedAt: '2026-10-01T00:00:00Z', checks: pass }))).toBe(true)
    expect(rule(row({ open: false, leftAs: 'MERGED', checks: pass }))).toBe(true)
    expect(rule(null)).toBe(false)
    expect(rule(undefined)).toBeNull()
  })

  it('Preview follows the previews; Merged: the PR merged or the branch merged, unknown unless one holds', () => {
    expect(auto.autoPhaseRules({ push: null, pr: undefined, preview: true, summary: null }).Preview).toBe(
      true,
    )
    expect(auto.autoPhaseRules({ push: null, pr: undefined, preview: false, summary: null }).Preview).toBe(
      false,
    )
    const merged = (f: Omit<import('./autoPhases').AutoFacts, 'preview' | 'summary'>) =>
      auto.autoPhaseRules({ ...f, preview: false, summary: null }).Merged
    expect(merged({ push: { state: 'pushed' }, pr: row({ open: false, mergedAt: 'x' }) })).toBe(true)
    expect(merged({ push: { state: 'pushed' }, pr: row({ open: false, leftAs: 'MERGED' }) })).toBe(true)
    expect(merged({ push: { state: 'pushed' }, pr: row({ open: false, leftAs: 'CLOSED' }) })).toBe(false)
    expect(merged({ push: { state: 'merged' }, pr: undefined })).toBe(true)
    expect(merged({ push: null, pr: row({ open: false, mergedAt: 'x' }) })).toBe(true)
    expect(merged({ push: { state: 'pushed' }, pr: row() })).toBe(false)
    expect(merged({ push: { state: 'pushed' }, pr: null })).toBe(false)
    expect(merged({ push: null, pr: row() })).toBeNull()
    expect(merged({ push: { state: 'pushed' }, pr: undefined })).toBeNull()
  })
})

describe('the Summary rule', () => {
  const COMMIT_AT = '2026-01-10T12:00:00.000Z'
  const summary = (author: string, createdAt: string) => ({
    author,
    progress: false,
    handoff: false,
    summary: true,
    createdAt,
  })
  type Post = import('./autoPhases').SummaryFacts['posts'][number]
  const post = (author: string, createdAt: string, extra: Partial<Post> = {}) => ({
    author,
    progress: true,
    handoff: false,
    summary: false,
    createdAt,
    ...extra,
  })
  const written = (over: Partial<import('./autoPhases').SummaryFacts> = {}) =>
    auto.summaryWritten({
      lastCommitAt: COMMIT_AT,
      since: '2026-01-09T09:00:00.000Z',
      posts: [summary('claude', '2026-01-10T13:00:00.000Z')],
      humans: ['enrique'],
      ...over,
    })

  it('is the rule autoPhaseRules ticks Summary by, and unknown when not read', () => {
    const rule = (s: boolean | null) =>
      auto.autoPhaseRules({ push: null, pr: undefined, preview: false, summary: s }).Summary
    expect(rule(true)).toBe(true)
    expect(rule(false)).toBe(false)
    expect(rule(null)).toBeNull()
  })

  it('only a summary an agent wrote at or after the last commit counts', () => {
    expect(written()).toBe(true)
    expect(written({ posts: [summary('claude', COMMIT_AT)] })).toBe(true)
    expect(written({ posts: [] })).toBe(false)
    // Written before the last commit, or by the human.
    expect(written({ posts: [summary('claude', '2026-01-10T11:00:00.000Z')] })).toBe(false)
    expect(written({ posts: [summary('enrique', '2026-01-10T13:00:00.000Z')] })).toBe(false)
    // Any version after the commit counts, an older one before it too.
    expect(
      written({
        posts: [
          summary('enrique', '2026-01-10T14:00:00.000Z'),
          summary('claude', '2026-01-10T13:00:00.000Z'),
        ],
      }),
    ).toBe(true)
    // Once there is a summary only the summary counts: a progress post after the commit does not.
    expect(
      written({
        posts: [post('claude', '2026-01-10T13:00:00.000Z'), summary('claude', '2026-01-10T11:00:00.000Z')],
      }),
    ).toBe(false)
  })

  it('without a summary ever written, an agent progress post after the last commit stands in, a resume note does not', () => {
    expect(written({ posts: [post('claude', '2026-01-10T13:00:00.000Z')] })).toBe(true)
    // Before the last commit; the human's, a discussion post, a resume note do not.
    expect(written({ posts: [post('claude', '2026-01-10T11:00:00.000Z')] })).toBe(false)
    expect(written({ posts: [post('enrique', '2026-01-10T13:00:00.000Z')] })).toBe(false)
    expect(written({ posts: [post('claude', '2026-01-10T13:00:00.000Z', { progress: false })] })).toBe(false)
    expect(written({ posts: [post('claude', '2026-01-10T13:00:00.000Z', { handoff: true })] })).toBe(false)
  })

  it('with no commit to go by (no branch, or git cannot tell), goes by when work started', () => {
    const noCommit = { lastCommitAt: null }
    expect(written({ ...noCommit, posts: [summary('claude', '2026-01-09T08:00:00.000Z')] })).toBe(false)
    expect(written({ ...noCommit, posts: [summary('claude', '2026-01-09T10:00:00.000Z')] })).toBe(true)
    expect(written({ ...noCommit, posts: [post('claude', '2026-01-09T10:00:00.000Z')] })).toBe(true)
  })
})

describe('localGreenSha', () => {
  const HEAD = '0123456789abcdef0123456789abcdef01234567'
  const said = (...bodies: string[]) =>
    prs.localGreenSha(
      bodies.map((body) => ({ body })),
      HEAD,
    )

  it('takes a first line "CI run locally: green" naming a 7 to 40 character prefix of the head', () => {
    expect(said('CI run locally: green on 0123456')).toBe(HEAD)
    expect(said(`ci run locally:   GREEN on ${HEAD}`)).toBe(HEAD)
    expect(said('  CI run locally: green\n\ntypecheck, lint, tests on 0123456789AB.')).toBe(HEAD)
    expect(said('nothing', 'CI run locally: green on 0123456789abcdef')).toBe(HEAD)
  })

  it('refuses one without a SHA, one naming another commit or a short prefix, and other first lines', () => {
    expect(said('CI run locally: green')).toBeNull()
    expect(said('CI run locally: green on fedcba9')).toBeNull()
    expect(said('CI run locally: green on 012345')).toBeNull()
    expect(said('CI run locally: red on 0123456')).toBeNull()
    expect(said('CI run locally: greenish 0123456')).toBeNull()
    expect(said('Earlier:\nCI run locally: green on 0123456')).toBeNull()
    expect(said('CI run locally: green on 0123456x')).toBeNull()
    expect(said()).toBeNull()
  })
})

describe('the board ticking the phases', () => {
  let server: http.Server | null = null
  afterAll(() => server?.close())

  it('Pushed: ticked once the branch is on origin, unticked by a commit not pushed, ticked again on the push', async () => {
    const { projectId } = newProject()
    commitOn('feat/pushed', 'pushed-1.txt')
    const t = await newTicket(projectId, { branch: 'feat/pushed' })
    await read(t.id)
    expect(ticks(t.id).Pushed).toBe(false)
    git('push', '-q', 'origin', 'feat/pushed')
    await push.fetchRepo(repo, { force: true })
    expect((await read(t.id)).tasks.find((x) => x.text === 'Pushed')!.done).toBe(true)
    commitOn('feat/pushed', 'pushed-2.txt')
    push.dropListings(repo)
    const ahead = await read(t.id)
    expect(ahead.push.state).toBe('ahead')
    expect(ticks(t.id).Pushed).toBe(false)
    git('push', '-q', 'origin', 'feat/pushed')
    await push.fetchRepo(repo, { force: true })
    await read(t.id)
    expect(ticks(t.id).Pushed).toBe(true)
  }, 60_000)

  it('PR: an open row by prNumber or branch ticks it, merged keeps it (by branch too), closed unticks it', async () => {
    const { projectId, repoId } = newProject()
    // By prNumber.
    const byNumber = await newTicket(projectId, { prNumber: 21 })
    const pr21 = prRow(projectId, repoId, 21)
    await read(byNumber.id)
    expect(ticks(byNumber.id).PR).toBe(true)
    setPr(pr21.id, { open: false, leftAs: 'CLOSED' })
    await read(byNumber.id)
    expect(ticks(byNumber.id).PR).toBe(false)
    // A prNumber the queue never saw is no PR.
    const unseen = await newTicket(projectId, { prNumber: 999 })
    await read(unseen.id)
    expect(ticks(unseen.id).PR).toBe(false)

    // By the branch alone: open, then merged (no longer in prForTicket's open lookup), then another
    // ticket's branch PR closed without merging.
    const byBranch = await newTicket(projectId, { branch: 'feat/22' })
    const pr22 = prRow(projectId, repoId, 22)
    await read(byBranch.id)
    expect(ticks(byBranch.id).PR).toBe(true)
    setPr(pr22.id, { open: false, mergedAt: new Date().toISOString() })
    await read(byBranch.id)
    expect(ticks(byBranch.id).PR).toBe(true)
    expect(ticks(byBranch.id).Merged).toBe(true)

    const closed = await newTicket(projectId, { branch: 'feat/23' })
    const pr23 = prRow(projectId, repoId, 23)
    await read(closed.id)
    expect(ticks(closed.id).PR).toBe(true)
    setPr(pr23.id, { open: false, leftAs: 'CLOSED' })
    await read(closed.id)
    expect(ticks(closed.id).PR).toBe(false)
  }, 30_000)

  it('CI: green checks tick it, red or pending untick it; a local-green comment on the head ticks it until the head moves', async () => {
    const { projectId, repoId } = newProject()
    const t = await newTicket(projectId, { prNumber: 31 })
    const pr = prRow(projectId, repoId, 31, { checks: [{ name: 'c', state: 'pass', url: null }] })
    await read(t.id)
    expect(ticks(t.id).CI).toBe(true)
    setPr(pr.id, { checks: [{ name: 'c', state: 'fail', url: null }] })
    await read(t.id)
    expect(ticks(t.id).CI).toBe(false)
    setPr(pr.id, { checks: [{ name: 'c', state: 'pending', url: null }] })
    await read(t.id)
    expect(ticks(t.id).CI).toBe(false)

    // The refresh stores the head a "CI run locally: green" comment names, and CI follows it while the
    // checks stay red. (GitHub is set only now: the refresh a read starts would close the row above.)
    dbm.db.update(dbm.schema.repos).set({ githubRepo: 'o/r' }).where(eq(dbm.schema.repos.id, repoId)).run()
    const head = 'c'.repeat(40)
    found = [
      ghPr(31, {
        headRefOid: head,
        statusCheckRollup: [failingRun],
        comments: [
          { author: { login: 'enrique' }, body: 'CI run locally: green', createdAt: '2026-10-01T10:00:00Z' },
          {
            author: { login: 'enrique' },
            body: `CI run locally: green on ${head.slice(0, 9)}`,
            createdAt: '2026-10-01T11:00:00Z',
          },
        ],
      }),
    ]
    await prs.refreshPrs(projectId)
    const stored = dbm.db.select().from(dbm.schema.prs).where(eq(dbm.schema.prs.id, pr.id)).get()!
    expect(stored.localCiSha).toBe(head)
    expect(stored.headSha).toBe(head)
    // Ticked by the refresh itself, before any read.
    expect(ticks(t.id).CI).toBe(true)
    expect((await read(t.id)).open).toBeNull()

    // A new push: the comment names an older head, so CI is unticked until it is green again.
    found = [
      ghPr(31, {
        headRefOid: 'd'.repeat(40),
        statusCheckRollup: [failingRun],
        comments: [
          {
            author: { login: 'enrique' },
            body: `CI run locally: green on ${head.slice(0, 9)}`,
            createdAt: '2026-10-01T11:00:00Z',
          },
        ],
      }),
    ]
    await prs.refreshPrs(projectId)
    expect(
      dbm.db.select().from(dbm.schema.prs).where(eq(dbm.schema.prs.id, pr.id)).get()!.localCiSha,
    ).toBeNull()
    expect(ticks(t.id).CI).toBe(false)
    // A comment without a SHA does not count.
    found = [
      ghPr(31, {
        headRefOid: 'd'.repeat(40),
        statusCheckRollup: [failingRun],
        comments: [
          { author: { login: 'ana' }, body: 'CI run locally: green', createdAt: '2026-10-01T12:00:00Z' },
        ],
      }),
    ]
    await prs.refreshPrs(projectId)
    expect(ticks(t.id).CI).toBe(false)
  }, 30_000)

  it('Preview: ticked while a preview link answers, unticked once it stops; frozen once merged', async () => {
    const { forgetPreviewState } = await import('./preview')
    const { projectId, repoId } = newProject()
    const listen = () =>
      new Promise<http.Server>((resolve, reject) => {
        const s = http.createServer((_req, res) => res.end('ok'))
        s.once('error', reject)
        s.listen(9187, '127.0.0.1', () => resolve(s))
      })
    const url = 'http://127.0.0.1:9187'
    server = await listen()
    const t = await newTicket(projectId, { prNumber: 41 })
    features.addWorkspace(t.id, { name: 'wt', previewUrl: url }, 'claude')
    await read(t.id)
    expect(ticks(t.id).Preview).toBe(true)
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    forgetPreviewState(url)
    await read(t.id)
    expect(ticks(t.id).Preview).toBe(false)

    // Running again, then the PR merges and the preview stops: Preview stays ticked.
    server = await listen()
    forgetPreviewState(url)
    await read(t.id)
    expect(ticks(t.id).Preview).toBe(true)
    prRow(projectId, repoId, 41, { open: false, mergedAt: new Date().toISOString() })
    await read(t.id)
    expect(ticks(t.id).Merged).toBe(true)
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
    forgetPreviewState(url)
    await read(t.id)
    expect(ticks(t.id)).toMatchObject({ Preview: true, Merged: true, PR: true })
  }, 30_000)

  it('Summary: ticked by an agent summary after the last commit, unticked by a newer commit, ticked again; frozen once merged', async () => {
    const { projectId, repoId } = newProject()
    noteActor('enrique', 'human')
    commitOn('feat/summary', 'summary-1.txt')
    const t = await newTicket(projectId, { branch: 'feat/summary', prNumber: 101 })
    const activity = () =>
      dbm.db
        .select()
        .from(dbm.schema.activity)
        .where(and(eq(dbm.schema.activity.refType, 'ticket'), eq(dbm.schema.activity.refId, t.id)))
        .all()
        .filter((a) => a.text.includes('"Summary"'))
        .map((a) => [a.actor, a.text])
    await read(t.id)
    expect(ticks(t.id).Summary).toBe(false)

    // The human's summary does not count.
    features.setSummary(t.id, { body: 'Looks fine?' }, 'enrique')
    await read(t.id)
    expect(ticks(t.id).Summary).toBe(false)

    features.setSummary(
      t.id,
      { body: 'What it does, the PR, the preview.', change: 'the hand-off' },
      'claude',
    )
    const view = await read(t.id)
    expect(view.tasks.find((x) => x.text === 'Summary')).toMatchObject({ done: true, auto: true })
    expect(activity()).toEqual([['board', `completed "Summary" on #${t.id} t`]])

    // A commit after it: the summary is behind the work.
    backdateSummaries(t.id)
    commitOn('feat/summary', 'summary-2.txt')
    expect((await read(t.id)).tasks.find((x) => x.text === 'Summary')!.done).toBe(false)
    expect(activity().at(-1)).toEqual(['board', `reopened "Summary" on #${t.id} t`])

    // A new version brings it back.
    features.setSummary(t.id, { body: 'Updated for the new commit.', change: 'the new commit' }, 'claude')
    await read(t.id)
    expect(ticks(t.id).Summary).toBe(true)

    // Once merged, a later commit leaves it ticked.
    prRow(projectId, repoId, 101, { open: false, mergedAt: new Date().toISOString() })
    await read(t.id)
    expect(ticks(t.id).Merged).toBe(true)
    backdateSummaries(t.id)
    commitOn('feat/summary', 'summary-3.txt')
    await read(t.id)
    expect(ticks(t.id)).toMatchObject({ Summary: true, Merged: true })
  }, 60_000)

  it('in a done stage only ticks: a stopped preview leaves Preview ticked', async () => {
    const { projectId } = newProject()
    const t = await newTicket(projectId)
    setTick(t.id, 'Preview', true)
    features.updateTicket(t.id, { status: 'done' }, 'enrique')
    await read(t.id)
    expect(ticks(t.id).Preview).toBe(true)
    // Before done, the same read unticks it.
    const open = await newTicket(projectId)
    setTick(open.id, 'Preview', true)
    await read(open.id)
    expect(ticks(open.id).Preview).toBe(false)
  })

  it('writes only what differs, logged as the board, and a tick clears the blocked tag', async () => {
    const { projectId, repoId } = newProject()
    const t = await newTicket(projectId, { prNumber: 51 })
    // Tagged blocked while open, as the human or an agent may.
    features.updateTask(taskOf(t.id, 'PR').id, { blocked: true, blockedReason: 'needs a token' }, 'claude')
    prRow(projectId, repoId, 51)
    const activity = () =>
      dbm.db
        .select()
        .from(dbm.schema.activity)
        .where(and(eq(dbm.schema.activity.refType, 'ticket'), eq(dbm.schema.activity.refId, t.id)))
        .all()
    const before = activity().length
    await read(t.id)
    expect(taskOf(t.id, 'PR')).toMatchObject({ done: true, blocked: false, blockedReason: '' })
    const logged = activity().slice(before)
    expect(logged.map((a) => [a.actor, a.kind, a.text])).toEqual([
      ['board', 'task', `completed "PR" on #${t.id} t`],
    ])
    await read(t.id)
    await read(t.id)
    expect(activity().length).toBe(before + 1)
    expect(
      auto.reconcileAutoPhases(t.id, {
        Pushed: null,
        PR: true,
        CI: null,
        Preview: null,
        Summary: null,
        Merged: null,
      }),
    ).toBe(false)
  })

  it('leaves unknown facts alone: git cannot list the refs, or no repo; no branch and no PR reads as unticked', async () => {
    const notGit = fs.mkdtempSync(path.join(tmp, 'not-git-'))
    const unknown = newProject(notGit)
    const a = await newTicket(unknown.projectId, { branch: 'feat/x' })
    setTick(a.id, 'Pushed', true)
    await read(a.id)
    expect(ticks(a.id)).toMatchObject({ Pushed: true, Merged: false })

    // A ticket whose repo went: no repo to read.
    const none = newProject()
    const b = await newTicket(none.projectId, { branch: 'feat/x', prNumber: 5 })
    dbm.db.delete(dbm.schema.repos).where(eq(dbm.schema.repos.id, none.repoId)).run()
    for (const phase of ['Pushed', 'PR', 'CI']) setTick(b.id, phase, true)
    await read(b.id)
    expect(ticks(b.id)).toMatchObject({ Pushed: true, PR: true, CI: true, Merged: false })

    // A repo, but no branch and no PR: those are facts.
    const known = newProject()
    const c = await newTicket(known.projectId)
    for (const phase of ['Pushed', 'PR', 'CI']) setTick(c.id, phase, true)
    await read(c.id)
    expect(ticks(c.id)).toMatchObject({ Pushed: false, PR: false, CI: false, Merged: false })
  })

  it('never touches archived tickets or a PR ticket', async () => {
    const { projectId, repoId } = newProject()
    const t = await newTicket(projectId, { prNumber: 61 })
    prRow(projectId, repoId, 61)
    dbm.db
      .update(dbm.schema.tickets)
      .set({ archivedAt: new Date().toISOString() })
      .where(eq(dbm.schema.tickets.id, t.id))
      .run()
    await read(t.id)
    await auto.reconcileProject(projectId)
    expect(ticks(t.id).PR).toBe(false)
  })

  it('a repo the PR refresh never read (no GitHub remote, no rows) leaves PR, CI and Merged alone', async () => {
    const { projectId } = newProject()
    const byBranch = await newTicket(projectId, { branch: 'feat/unread' })
    const byNumber = await newTicket(projectId, { branch: 'feat/unread-2', prNumber: 7 })
    for (const id of [byBranch.id, byNumber.id]) for (const phase of ['PR', 'CI']) setTick(id, phase, true)
    // The refresh goes through, skipping the repo: the project was refreshed, its repo was not read.
    await prs.refreshPrs(projectId)
    for (const id of [byBranch.id, byNumber.id]) {
      await read(id)
      expect(ticks(id)).toMatchObject({ PR: true, CI: true, Merged: false })
    }

    // A GitHub repo the refresh read, with no PR on the branch: that is a fact.
    const read1 = newProject(repo, { github: true })
    const t = await newTicket(read1.projectId, { branch: 'feat/read-none' })
    for (const phase of ['PR', 'CI']) setTick(t.id, phase, true)
    await prs.refreshPrs(read1.projectId)
    expect(ticks(t.id)).toMatchObject({ PR: false, CI: false })
  })

  it("by the branch, a PR merged before the ticket was made is not the ticket's; its own merged PR is", async () => {
    const { projectId, repoId } = newProject()
    const before = new Date(Date.now() - 10 * 86_400_000).toISOString()
    prRow(projectId, repoId, 81, {
      headRef: 'feat/reused',
      open: false,
      mergedAt: before,
      closedAt: before,
      updatedAt: before,
    })
    const t = await newTicket(projectId, { branch: 'feat/reused' })
    await read(t.id)
    expect(ticks(t.id)).toMatchObject({ PR: false, Merged: false })
    // A new PR on the branch is the ticket's; merging it ticks Merged.
    const own = prRow(projectId, repoId, 82, { headRef: 'feat/reused' })
    await read(t.id)
    expect(ticks(t.id)).toMatchObject({ PR: true, Merged: false })
    const now = new Date().toISOString()
    setPr(own.id, { open: false, mergedAt: now, closedAt: now, updatedAt: now })
    await read(t.id)
    expect(ticks(t.id)).toMatchObject({ PR: true, Merged: true })
  })

  it('a PR that left the searches stays as it was until GitHub says merged or closed', async () => {
    const { projectId, repoId } = newProject()
    const pass = [{ name: 'c', state: 'pass' as const, url: null }]
    const byNumber = await newTicket(projectId, { prNumber: 91 })
    const byBranch = await newTicket(projectId, { branch: 'feat/92' })
    const pr91 = prRow(projectId, repoId, 91, { checks: pass })
    const pr92 = prRow(projectId, repoId, 92, { checks: pass })
    for (const t of [byNumber, byBranch]) {
      await read(t.id)
      expect(ticks(t.id)).toMatchObject({ PR: true, CI: true, Merged: false })
    }
    // Gone from every search, with no merge time and no word from GitHub: maybe a merge they missed.
    const now = new Date().toISOString()
    for (const pr of [pr91, pr92]) setPr(pr.id, { open: false, closedAt: now })
    for (const t of [byNumber, byBranch]) {
      await read(t.id)
      expect(ticks(t.id)).toMatchObject({ PR: true, CI: true, Merged: false })
    }
    setPr(pr91.id, { leftAs: 'MERGED' })
    setPr(pr92.id, { leftAs: 'CLOSED' })
    await read(byNumber.id)
    expect(ticks(byNumber.id)).toMatchObject({ PR: true, CI: true, Merged: true })
    await read(byBranch.id)
    expect(ticks(byBranch.id)).toMatchObject({ PR: false, CI: false, Merged: false })
  })

  it('the refresh asks GitHub about a PR that left every search, and the phases follow its answer', async () => {
    const { projectId, repoId } = newProject(repo, { github: true })
    const merged = await newTicket(projectId, { branch: 'feat/95' })
    const closed = await newTicket(projectId, { branch: 'feat/96' })
    const silent = await newTicket(projectId, { branch: 'feat/97' })
    const green = { statusCheckRollup: [{ ...failingRun, conclusion: 'SUCCESS' }] }
    found = [ghPr(95, green), ghPr(96, green), ghPr(97, green)]
    await prs.refreshPrs(projectId)
    for (const t of [merged, closed, silent]) expect(ticks(t.id)).toMatchObject({ PR: true, CI: true })
    found = []
    states = { 95: 'MERGED', 96: 'CLOSED' }
    await prs.refreshPrs(projectId)
    const leftAs = (number: number) =>
      dbm.db
        .select()
        .from(dbm.schema.prs)
        .where(and(eq(dbm.schema.prs.repoId, repoId), eq(dbm.schema.prs.number, number)))
        .get()!.leftAs
    expect([leftAs(95), leftAs(96), leftAs(97)]).toEqual(['MERGED', 'CLOSED', null])
    expect(ticks(merged.id)).toMatchObject({ PR: true, CI: true, Merged: true })
    expect(ticks(closed.id)).toMatchObject({ PR: false, CI: false, Merged: false })
    expect(ticks(silent.id)).toMatchObject({ PR: true, CI: true, Merged: false })
    // Found by the searches again (reopened): GitHub's earlier answer no longer holds.
    found = [ghPr(96, green)]
    await prs.refreshPrs(projectId)
    expect(leftAs(96)).toBeNull()
    expect(ticks(closed.id)).toMatchObject({ PR: true, CI: true })
  })
})

describe('Merged on tickets seeded before it', () => {
  const OLD = ['Implementation', 'Pushed', 'PR', 'CI', 'Preview', 'Hand-off post']
  /** A ticket as one seeded before Merged was built in: its marker unset. */
  function olderTicket(projectId: number, phases: string[] = OLD) {
    const t = features.createTicket(projectId, { title: 'older', tasks: phases }, 'claude')
    dbm.db
      .update(dbm.schema.tickets)
      .set({ mergedPhaseChecked: false })
      .where(eq(dbm.schema.tickets.id, t.id))
      .run()
    return t
  }
  const order = (ticketId: number) => features.getTicketFull(ticketId).tasks.map((x) => x.text)

  it('gets it once, right before its Hand-off post, else at the end; a removed one does not come back', async () => {
    const { projectId } = newProject()
    const t = olderTicket(projectId)
    // A step under Implementation keeps its place.
    features.addTasks(t.id, ['step'], 'claude', { parentTaskId: taskOf(t.id, 'Implementation').id })
    await read(t.id)
    expect(order(t.id)).toEqual([
      'Implementation',
      'step',
      'Pushed',
      'PR',
      'CI',
      'Preview',
      'Merged',
      'Hand-off post',
    ])
    await read(t.id)
    expect(order(t.id).filter((x) => x === 'Merged')).toHaveLength(1)
    features.deleteTask(taskOf(t.id, 'Merged').id, 'enrique')
    await read(t.id)
    await auto.reconcileProject(projectId)
    expect(order(t.id)).not.toContain('Merged')

    const noPost = olderTicket(projectId, ['Implementation', 'Pushed', 'PR'])
    await read(noPost.id)
    expect(order(noPost.id)).toEqual(['Implementation', 'Pushed', 'PR', 'Merged'])
  })

  it('reaches tickets nobody reads, on the PR refresh', async () => {
    const { projectId } = newProject()
    const t = olderTicket(projectId)
    await prs.refreshPrs(projectId)
    expect(order(t.id)).toEqual([
      'Implementation',
      'Pushed',
      'PR',
      'CI',
      'Preview',
      'Merged',
      'Hand-off post',
    ])
  })

  it('is not added without the hand-off phases, to an archived ticket, or when the project has no Merged', async () => {
    const { projectId } = newProject()
    const plain = olderTicket(projectId, ['Implementation', 'Hand-off post'])
    await read(plain.id)
    expect(order(plain.id)).toEqual(['Implementation', 'Hand-off post'])

    const archived = olderTicket(projectId)
    dbm.db
      .update(dbm.schema.tickets)
      .set({ archivedAt: new Date().toISOString() })
      .where(eq(dbm.schema.tickets.id, archived.id))
      .run()
    await read(archived.id)
    await auto.reconcileProject(projectId)
    expect(order(archived.id)).toEqual(OLD)

    const custom = newProject()
    const { updateProject } = await import('./projects')
    updateProject(
      custom.projectId,
      { defaultPhases: ['Implementation', 'Pushed', 'PR', 'Hand-off post'] },
      'enrique',
    )
    const own = olderTicket(custom.projectId)
    await read(own.id)
    expect(order(own.id)).toEqual(OLD)
  })

  it('is not added to a done or cancelled ticket, which would drop it from 100%; it is looked at once', async () => {
    const { projectId } = newProject()
    const { listStages } = await import('./stages')
    const key = (kind: string) => listStages(projectId).find((s) => s.kind === kind)!.key
    for (const kind of ['done', 'cancelled']) {
      const t = olderTicket(projectId)
      dbm.db
        .update(dbm.schema.tickets)
        .set({ status: key(kind) })
        .where(eq(dbm.schema.tickets.id, t.id))
        .run()
      await read(t.id)
      await auto.reconcileProject(projectId)
      expect(order(t.id)).toEqual(OLD)
      expect(
        dbm.db.select().from(dbm.schema.tickets).where(eq(dbm.schema.tickets.id, t.id)).get()!
          .mergedPhaseChecked,
      ).toBe(true)
    }
  })

  it('is never added to a new ticket again: it was seeded with the list in effect', async () => {
    const { projectId } = newProject()
    const { updateProject } = await import('./projects')
    updateProject(projectId, { defaultPhases: ['Implementation', 'Pushed', 'Hand-off post'] }, 'enrique')
    const t = await newTicket(projectId)
    updateProject(projectId, { defaultPhases: null }, 'enrique')
    await read(t.id)
    expect(order(t.id)).toEqual(['Implementation', 'Pushed', 'Hand-off post'])
  })
})

describe('what is open in review', () => {
  it("leaves out the open Merged phases, the ticket's and its lanes'; the progress still counts them", async () => {
    const { projectId } = newProject()
    const { updateProject } = await import('./projects')
    updateProject(projectId, { defaultPhases: ['Implementation', 'Merged'] }, 'enrique')
    const t = await newTicket(projectId)
    const lane = await needs.newTicket(
      projectId,
      { title: 'lane', parentId: t.id, defaultPhases: true },
      'claude',
      { agent: true },
    )
    for (const id of [t.id, lane.id])
      features.updateTask(taskOf(id, 'Implementation').id, { done: true }, 'claude')
    const moved = await needs.changeTicket(t.id, { status: 'review' }, 'claude', { agent: true })
    expect('open' in moved && moved.open).toEqual([])
    const view = await read(t.id)
    expect(view.rollup).toEqual({ done: 2, total: 4 })
    expect(ticks(t.id).Merged).toBe(false)
  })
})

describe('without anyone reading the ticket', () => {
  it('the PR refresh ticks PR, CI and Merged', async () => {
    const { projectId } = newProject(repo, { github: true })
    const t = await newTicket(projectId, { branch: 'feat/71' })
    found = [ghPr(71, { statusCheckRollup: [{ ...failingRun, conclusion: 'SUCCESS' }] })]
    await prs.refreshPrs(projectId)
    expect(ticks(t.id)).toMatchObject({ PR: true, CI: true, Merged: false })
    // Merged after the ticket was made, as its own PR is.
    found = [ghPr(71, { mergedAt: new Date().toISOString() })]
    await prs.refreshPrs(projectId)
    expect(ticks(t.id)).toMatchObject({ PR: true, Merged: true })
  })

  it('the push poll and the PR refresh tick Summary, with no read in between', async () => {
    const { projectId } = newProject()
    commitOn('feat/summary-poll', 'summary-poll.txt')
    const t = await newTicket(projectId, { branch: 'feat/summary-poll' })
    features.setSummary(t.id, { body: 'Written, never read back.' }, 'claude')
    expect(ticks(t.id).Summary).toBe(false)
    await auto.reconcileProject(projectId)
    expect(ticks(t.id).Summary).toBe(true)
    // A new commit, then the project's push poll.
    backdateSummaries(t.id)
    commitOn('feat/summary-poll', 'summary-poll-2.txt')
    await push.projectPush(projectId)
    expect(ticks(t.id).Summary).toBe(false)
  }, 30_000)

  it("the project's push poll ticks Pushed", async () => {
    const { projectId } = newProject()
    commitOn('feat/poll', 'poll.txt')
    const t = await newTicket(projectId, { branch: 'feat/poll' })
    await push.projectPush(projectId)
    expect(ticks(t.id).Pushed).toBe(false)
    git('push', '-q', 'origin', 'feat/poll')
    await push.fetchRepo(repo, { force: true })
    const polled = await push.projectPush(projectId)
    expect(polled.tickets.find((x) => x.id === t.id)!.push.state).toBe('pushed')
    expect(ticks(t.id).Pushed).toBe(true)
  }, 30_000)
})
