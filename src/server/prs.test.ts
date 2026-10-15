import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { and, eq } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { GhCheck, MyGhPr } from './git'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp

// gh answers from fixtures: the refresh reads whatever `found` holds, or what `foundIn` holds for a
// repo's checkout; a checkout in `failing` has its searches fail. `states` is GitHub's state of a PR
// when a refresh asks for it (a PR that left the searches).
let found: MyGhPr[] = []
let foundIn: Record<string, MyGhPr[]> = {}
let failing = new Set<string>()
let states: Record<number, 'OPEN' | 'CLOSED' | 'MERGED'> = {}
// A checkout whose next search waits for its promise, once: a test holds one refresh's read while another runs.
let holdNext = new Map<string, Promise<void>>()
vi.mock('./git', async (original) => ({
  ...(await original<typeof import('./git')>()),
  listMyPrs: async (repoPath: string) => {
    const hold = holdNext.get(repoPath)
    holdNext.delete(repoPath)
    if (hold) await hold
    if (failing.has(repoPath)) throw new Error(`gh pr list failed in ${repoPath}`)
    return foundIn[repoPath] ?? found
  },
  currentGithubLogin: async () => 'enrique',
  prMerged: async () => false,
  prStateOf: async (_repoPath: string, number: number) => states[number] ?? null,
}))

afterEach(() => {
  found = []
  foundIn = {}
  failing = new Set()
  holdNext = new Map()
  states = {}
  vi.useRealTimers()
})

let prs: typeof import('./prs')
beforeAll(async () => {
  prs = await import('./prs')
})

const HEAD = 'a1b2c3d4e5f6'

const ghPr = (number: number, over: Partial<MyGhPr> = {}): MyGhPr => ({
  number,
  title: `pr ${number}`,
  url: `https://github.com/acme/app/pull/${number}`,
  author: { login: 'enrique' },
  headRefName: `feat/${number}`,
  baseRefName: 'main',
  headRefOid: HEAD,
  isDraft: false,
  reviewDecision: '',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  statusCheckRollup: [],
  updatedAt: '2026-10-01T10:00:00Z',
  mergedAt: null,
  reviews: [],
  reviewRequests: [],
  requested: false,
  assigned: false,
  ...over,
})

const review = (login: string, oid: string, submittedAt = '2026-10-01T09:00:00Z', state = 'COMMENTED') => ({
  author: { login },
  state,
  submittedAt,
  commit: { oid },
})

/** Someone else's PR, for me to review. */
const theirs = (number: number, over: Partial<MyGhPr> = {}) =>
  ghPr(number, { author: { login: 'ana' }, ...over })

const run = (
  name: string,
  status: string,
  conclusion: string,
  startedAt = '2026-10-01T09:00:00Z',
): GhCheck => ({
  __typename: 'CheckRun',
  name,
  workflowName: 'CI',
  status,
  conclusion,
  detailsUrl: `https://github.com/acme/app/actions/runs/1/job/${name}`,
  startedAt,
})

describe('prWaitingOn', () => {
  it("puts someone else's PR in To review, whatever search found it", () => {
    expect(prs.prWaitingOn(theirs(1, { requested: true }), 'enrique')).toBe('me')
    expect(prs.prWaitingOn(theirs(1, { assigned: true }), 'enrique')).toBe('me')
    // Found only because I reviewed it before.
    expect(prs.prWaitingOn(theirs(1), 'enrique')).toBe('me')
  })

  it("puts a PR I authored in Waiting on others, an agent's assigned to me included", () => {
    expect(prs.prWaitingOn(ghPr(1), 'enrique')).toBe('others')
    expect(prs.prWaitingOn(ghPr(1, { assigned: true }), 'enrique')).toBe('others')
    expect(prs.prWaitingOn(ghPr(1, { requested: true }), 'enrique')).toBe('others')
  })

  it('reads every PR as to review when my login is unknown', () => {
    expect(prs.prWaitingOn(ghPr(1), null)).toBe('me')
  })
})

describe('standingVerdicts', () => {
  it("keeps each reviewer's latest verdict; a comment after an approval leaves the approval", () => {
    const v = prs.standingVerdicts([
      review('ana', 'a', '2026-10-01T09:00:00Z', 'APPROVED'),
      review('ana', 'b', '2026-10-01T10:00:00Z', 'COMMENTED'),
      review('bo', 'a', '2026-10-01T09:00:00Z', 'APPROVED'),
      review('bo', 'b', '2026-10-01T10:00:00Z', 'CHANGES_REQUESTED'),
      review('cy', 'a', '2026-10-01T11:00:00Z', 'CHANGES_REQUESTED'),
      review('cy', 'b', '2026-10-01T12:00:00Z', 'COMMENTED'),
    ])
    expect(v.get('ana')).toMatchObject({ state: 'APPROVED', commit: { oid: 'a' } })
    expect(v.get('bo')).toMatchObject({ state: 'CHANGES_REQUESTED' })
    expect(v.get('cy')).toMatchObject({ state: 'COMMENTED', commit: { oid: 'b' } })
  })

  it('ignores unsent and dismissed reviews, in whatever order GitHub lists them', () => {
    const v = prs.standingVerdicts([
      review('ana', 'b', '2026-10-01T12:00:00Z', 'DISMISSED'),
      review('ana', 'a', '2026-10-01T09:00:00Z', 'APPROVED'),
      review('bo', 'a', '2026-10-01T09:00:00Z', 'PENDING'),
    ])
    expect(v.get('ana')).toMatchObject({ state: 'APPROVED' })
    expect(v.has('bo')).toBe(false)
  })
})

describe('reviewStage, to review (by my reviews alone)', () => {
  const stage = (over: Partial<MyGhPr>) => prs.reviewStage(theirs(1, over), 'enrique')

  it('is pending while I have no review, or only dismissed or unsent ones', () => {
    expect(stage({})).toBe('pending')
    expect(stage({ reviews: [review('enrique', HEAD, undefined, 'DISMISSED')] })).toBe('pending')
    expect(stage({ reviews: [review('enrique', HEAD, undefined, 'PENDING')] })).toBe('pending')
  })

  it('is reviewed once I approved, even after the head moved', () => {
    expect(stage({ reviews: [review('enrique', HEAD, undefined, 'APPROVED')] })).toBe('reviewed')
    expect(stage({ reviews: [review('enrique', 'older', undefined, 'APPROVED')] })).toBe('reviewed')
    // A reply in a thread after approving leaves it approved.
    expect(
      stage({
        reviews: [
          review('enrique', HEAD, '2026-10-01T09:00:00Z', 'APPROVED'),
          review('enrique', HEAD, '2026-10-01T10:00:00Z', 'COMMENTED'),
        ],
      }),
    ).toBe('reviewed')
  })

  it('is on hold while my comments or requested changes stand at the head', () => {
    expect(stage({ reviews: [review('enrique', HEAD)] })).toBe('on_hold')
    expect(stage({ reviews: [review('enrique', HEAD, undefined, 'CHANGES_REQUESTED')] })).toBe('on_hold')
  })

  it('goes back to pending once they are addressed: a push past them, or my review asked again', () => {
    expect(stage({ reviews: [review('enrique', 'older', undefined, 'CHANGES_REQUESTED')] })).toBe('pending')
    expect(stage({ reviews: [review('enrique', 'older')] })).toBe('pending')
    expect(
      stage({
        reviews: [review('enrique', HEAD)],
        reviewRequests: [{ __typename: 'User', login: 'enrique' }],
      }),
    ).toBe('pending')
    // Someone else asked for again is not me.
    expect(
      stage({ reviews: [review('enrique', HEAD)], reviewRequests: [{ __typename: 'User', login: 'bo' }] }),
    ).toBe('on_hold')
  })

  it("does not move on other people's reviews", () => {
    expect(stage({ reviews: [review('bo', HEAD, undefined, 'APPROVED')], reviewDecision: 'APPROVED' })).toBe(
      'pending',
    )
    expect(stage({ reviews: [review('bo', HEAD, undefined, 'CHANGES_REQUESTED')] })).toBe('pending')
  })
})

describe("reviewStage, my PRs (by everyone else's reviews)", () => {
  const stage = (over: Partial<MyGhPr>) => prs.reviewStage(ghPr(1, over), 'enrique')
  const approved = (login: string, oid = HEAD) => review(login, oid, '2026-10-01T09:00:00Z', 'APPROVED')

  it('is pending with no reviews, or while not every reviewer approved', () => {
    expect(stage({})).toBe('pending')
    // An addressed comment is not an approval.
    expect(stage({ reviews: [approved('ana'), review('bo', 'older')] })).toBe('pending')
  })

  it('never holds on my own replies', () => {
    expect(stage({ reviews: [review('enrique', HEAD)] })).toBe('pending')
    expect(stage({ reviews: [approved('ana'), review('enrique', HEAD)] })).toBe('reviewed')
  })

  it('is reviewed when every reviewer approved and no review is still asked for, or GitHub approves', () => {
    expect(stage({ reviews: [approved('ana'), approved('bo', 'older')] })).toBe('reviewed')
    expect(
      stage({
        reviews: [approved('ana')],
        reviewDecision: 'APPROVED',
        reviewRequests: [{ __typename: 'User', login: 'bo' }],
      }),
    ).toBe('reviewed')
  })

  it('is pending with one approval while another requested reviewer has not reviewed', () => {
    expect(
      stage({
        reviews: [approved('ana')],
        reviewDecision: 'REVIEW_REQUIRED',
        reviewRequests: [{ __typename: 'User', login: 'bo' }],
      }),
    ).toBe('pending')
    expect(
      stage({ reviews: [approved('ana')], reviewRequests: [{ __typename: 'Team', slug: 'core' }] }),
    ).toBe('pending')
  })

  it('is on hold while anyone else has comments or requested changes at the head, approvals or not', () => {
    expect(stage({ reviews: [review('ana', HEAD)] })).toBe('on_hold')
    expect(stage({ reviews: [approved('ana'), review('bo', HEAD, undefined, 'CHANGES_REQUESTED')] })).toBe(
      'on_hold',
    )
    expect(stage({ reviews: [approved('ana'), review('bo', HEAD)], reviewDecision: 'APPROVED' })).toBe(
      'on_hold',
    )
  })

  it('leaves hold once the comments are addressed', () => {
    expect(stage({ reviews: [review('ana', 'older')] })).toBe('pending')
    expect(stage({ reviews: [approved('ana'), review('bo', 'older', undefined, 'CHANGES_REQUESTED')] })).toBe(
      'pending',
    )
    expect(
      stage({
        reviews: [approved('ana'), review('bo', 'older', undefined, 'CHANGES_REQUESTED')],
        reviewDecision: 'APPROVED',
      }),
    ).toBe('reviewed')
    expect(
      stage({ reviews: [review('bo', HEAD)], reviewRequests: [{ __typename: 'User', login: 'bo' }] }),
    ).toBe('pending')
  })
})

describe('mergeState', () => {
  it("reads GitHub's mergeable and merge state status", () => {
    const m = (mergeable: string, mergeStateStatus: string) => prs.mergeState({ mergeable, mergeStateStatus })
    expect(m('MERGEABLE', 'CLEAN')).toBe('clean')
    expect(m('MERGEABLE', 'UNSTABLE')).toBe('clean')
    expect(m('MERGEABLE', 'DRAFT')).toBe('clean')
    expect(m('CONFLICTING', 'DIRTY')).toBe('conflicts')
    expect(m('CONFLICTING', 'UNKNOWN')).toBe('conflicts')
    expect(m('MERGEABLE', 'BEHIND')).toBe('behind')
    expect(m('MERGEABLE', 'BLOCKED')).toBe('blocked')
    // Right after a push GitHub has not worked it out yet.
    expect(m('UNKNOWN', 'UNKNOWN')).toBe('checking')
    expect(m('MERGEABLE', 'UNKNOWN')).toBe('checking')
  })
})

describe('prChecks and ciState', () => {
  it('sorts check runs and commit statuses into pass, fail, pending and skipped', () => {
    const checks = prs.prChecks([
      run('build', 'COMPLETED', 'SUCCESS'),
      run('lint', 'COMPLETED', 'FAILURE'),
      run('e2e', 'IN_PROGRESS', ''),
      run('deploy', 'COMPLETED', 'SKIPPED'),
      run('flaky', 'COMPLETED', 'TIMED_OUT'),
      { __typename: 'StatusContext', context: 'ci/legacy', state: 'ERROR', targetUrl: '', startedAt: '' },
      {
        __typename: 'StatusContext',
        context: 'coverage',
        state: 'PENDING',
        targetUrl: 'https://c.io/1',
        startedAt: '',
      },
    ])
    expect(checks).toEqual([
      { name: 'build', state: 'pass', url: 'https://github.com/acme/app/actions/runs/1/job/build' },
      { name: 'lint', state: 'fail', url: 'https://github.com/acme/app/actions/runs/1/job/lint' },
      { name: 'e2e', state: 'pending', url: 'https://github.com/acme/app/actions/runs/1/job/e2e' },
      { name: 'deploy', state: 'skipped', url: 'https://github.com/acme/app/actions/runs/1/job/deploy' },
      { name: 'flaky', state: 'fail', url: 'https://github.com/acme/app/actions/runs/1/job/flaky' },
      { name: 'ci/legacy', state: 'fail', url: null },
      { name: 'coverage', state: 'pending', url: 'https://c.io/1' },
    ])
    expect(prs.ciState(checks)).toBe('failing')
  })

  it('keeps the latest run of a re-run check', () => {
    const checks = prs.prChecks([
      run('test', 'COMPLETED', 'SUCCESS', '2026-10-01T10:00:00Z'),
      run('test', 'COMPLETED', 'FAILURE', '2026-10-01T09:00:00Z'),
    ])
    expect(checks.map((c) => c.state)).toEqual(['pass'])
  })

  it('fails on any failure, then pends on anything running, else passes; none without checks', () => {
    expect(prs.ciState(prs.prChecks([run('a', 'COMPLETED', 'SUCCESS'), run('b', 'QUEUED', '')]))).toBe(
      'pending',
    )
    expect(
      prs.ciState(prs.prChecks([run('a', 'COMPLETED', 'SUCCESS'), run('b', 'COMPLETED', 'NEUTRAL')])),
    ).toBe('passing')
    expect(prs.ciState(prs.prChecks([run('a', 'COMPLETED', 'SKIPPED')]))).toBe('none')
    expect(prs.ciState(prs.prChecks(null))).toBe('none')
  })
})

describe('the queue', () => {
  it('stores which side each PR is on, its stage, and where it stands on GitHub', async () => {
    const { db, schema } = await import('#/db')
    const projectId = db.insert(schema.projects).values({ name: 'q' }).returning().get().id
    db.insert(schema.repos)
      .values({ projectId, name: 'app', repoPath: '/r/app', baseBranch: 'main', githubRepo: 'acme/app' })
      .run()
    found = [
      // An agent's PR, opened with my account and assigned to me, failing CI and in conflict.
      ghPr(1, {
        assigned: true,
        mergeable: 'CONFLICTING',
        mergeStateStatus: 'DIRTY',
        statusCheckRollup: [run('lint', 'COMPLETED', 'FAILURE')],
      }),
      // Someone else's PR I requested changes on at its head: on hold until they are addressed.
      ghPr(2, {
        author: { login: 'ana' },
        reviewDecision: 'CHANGES_REQUESTED',
        reviews: [{ ...review('enrique', HEAD), state: 'CHANGES_REQUESTED' }],
        mergeable: 'UNKNOWN',
        mergeStateStatus: 'UNKNOWN',
      }),
      // Someone else's, found by each search on its own.
      theirs(3, { requested: true }),
      theirs(4, { assigned: true }),
      theirs(5, { reviews: [review('enrique', 'older', undefined, 'APPROVED')] }),
      // Mine, found only by the author search: nobody asked me for anything.
      ghPr(6),
    ]
    const queue = await prs.listPrs(projectId, { refresh: true })
    const byNumber = (n: number) => queue.find((p) => p.number === n)
    expect(byNumber(1)).toMatchObject({
      waitingOn: 'others',
      status: 'pending',
      merge: 'conflicts',
      ci: 'failing',
      checks: [{ name: 'lint', state: 'fail' }],
    })
    expect(byNumber(2)).toMatchObject({
      waitingOn: 'me',
      status: 'on_hold',
      myReview: 'changes_requested',
      reviewDecision: 'CHANGES_REQUESTED',
      merge: 'checking',
      ci: 'none',
      open: true,
      mergedAt: null,
    })
    expect(byNumber(3)).toMatchObject({ waitingOn: 'me', status: 'pending' })
    expect(byNumber(4)).toMatchObject({ waitingOn: 'me', status: 'pending' })
    expect(byNumber(5)).toMatchObject({ waitingOn: 'me', status: 'reviewed', myReview: 'approved' })
    expect(byNumber(6)).toMatchObject({ waitingOn: 'others', status: 'pending', myReview: 'none' })
  })

  it('answers from the stored rows without a refresh: the stages survive with GitHub out of reach', async () => {
    const { db, schema } = await import('#/db')
    const projectId = db.insert(schema.projects).values({ name: 'stored' }).returning().get().id
    db.insert(schema.repos)
      .values({ projectId, name: 'app', repoPath: '/r/stored', baseBranch: 'main', githubRepo: 'acme/app' })
      .run()
    found = [
      theirs(1, { reviews: [review('enrique', HEAD)] }),
      theirs(2, { reviews: [review('enrique', HEAD, undefined, 'APPROVED')] }),
      ghPr(3, { mergedAt: new Date().toISOString() }),
      ghPr(4),
    ]
    const status = (q: { number: number; status: string; waitingOn: string }[]) =>
      q.map((p) => `${p.number}:${p.waitingOn}:${p.status}`).sort()
    const first = await prs.listPrs(projectId, { refresh: true })
    expect(status(first)).toEqual(['1:me:on_hold', '2:me:reviewed', '3:others:done', '4:others:pending'])
    // Nothing reaches GitHub now: a refresh would fail.
    failing = new Set(['/r/stored'])
    expect(status(await prs.listPrs(projectId))).toEqual(status(first))
  })

  it('keeps merged PRs under done in their filter, drops closed ones, and leaves them out of the open readers', async () => {
    const { db, schema } = await import('#/db')
    const features = await import('./features')
    const needs = await import('./needs')
    const summary = await import('./summary')
    const projectId = db.insert(schema.projects).values({ name: 'merged' }).returning().get().id
    db.insert(schema.repos)
      .values({ projectId, name: 'app', repoPath: '/r/merged', baseBranch: 'main', githubRepo: 'acme/app' })
      .run()
    found = [theirs(20), ghPr(21), theirs(22), ghPr(23)]
    await prs.refreshPrs(projectId)
    // 20 and 21 land, 22 is closed without merging; 24 was merged long ago, out of the window.
    const mergedAt = new Date().toISOString()
    const longAgo = new Date(Date.now() - 30 * 86_400_000).toISOString()
    found = [
      theirs(20, { mergedAt, reviews: [review('enrique', HEAD, undefined, 'APPROVED')] }),
      ghPr(21, { mergedAt }),
      ghPr(23),
      ghPr(24, { mergedAt: longAgo }),
    ]
    const queue = await prs.listPrs(projectId, { refresh: true })
    const byNumber = (n: number) => queue.find((p) => p.number === n)
    expect(byNumber(20)).toMatchObject({ waitingOn: 'me', status: 'done', open: false, mergedAt })
    expect(byNumber(21)).toMatchObject({ waitingOn: 'others', status: 'done', open: false, mergedAt })
    expect(byNumber(22)).toBeUndefined()
    expect(byNumber(24)).toBeUndefined()
    expect(byNumber(23)).toMatchObject({ status: 'pending', open: true })

    // The open-only readers do not see them: the summary's PRs to review, merge order, branch links.
    expect(summary.getSummary(projectId, { humans: [] }).projects[0]!.needsYou.prs).toEqual([])
    const base = features.createTicket(projectId, { title: 'base', branch: 'feat/21' }, 'claude')
    const top = features.createTicket(projectId, { title: 'top', branch: 'feat/23' }, 'claude')
    await needs.changeTicket(top.id, { needs: [base.id] }, 'claude', { agent: true })
    expect((await prs.listPrs(projectId)).find((p) => p.number === 23)!.mergeAfter).toEqual([])
    expect(features.getTicketFull(base.id).pr).toBeNull()
    // Named by its number, the ticket still finds it, done.
    const named = features.createTicket(projectId, { title: 'named', prNumber: 21 }, 'claude')
    expect(features.getTicketFull(named.id).pr).toMatchObject({ queue: { open: false, status: 'done' } })
  })

  it('holds an open PR in either filter, releases it to its stage, and keeps the hold when it merges', async () => {
    const { db, schema } = await import('#/db')
    const projectId = db.insert(schema.projects).values({ name: 'hold' }).returning().get().id
    db.insert(schema.repos)
      .values({ projectId, name: 'app', repoPath: '/r/hold', baseBranch: 'main', githubRepo: 'acme/app' })
      .run()
    found = [theirs(30, { reviews: [review('enrique', HEAD, undefined, 'APPROVED')] }), ghPr(31)]
    const queue = await prs.listPrs(projectId, { refresh: true })
    const id = (n: number) => queue.find((p) => p.number === n)!.id
    expect(prs.setPrHold(id(30), true, 'wait for the release', 'enrique').status).toBe('on_hold')
    expect(prs.setPrHold(id(31), true, 'mine waits too', 'enrique').status).toBe('on_hold')
    expect(prs.setPrHold(id(30), false, '', 'enrique').status).toBe('reviewed')
    // Held through a refresh that finds it merged: the hold stays, and merged wins.
    found = [theirs(30), ghPr(31, { mergedAt: new Date().toISOString() })]
    const after = await prs.listPrs(projectId, { refresh: true })
    expect(after.find((p) => p.number === 31)).toMatchObject({
      hold: true,
      holdNote: 'mine waits too',
      status: 'done',
    })
    expect(prs.setPrHold(id(31), true, 'still', 'enrique').status).toBe('done')
    expect(after.find((p) => p.number === 30)).toMatchObject({ hold: false, status: 'pending' })
  })

  it("lists a merged PR in the summary's done on the day it left the queue, not again on later days", async () => {
    const { db, schema } = await import('#/db')
    const summary = await import('./summary')
    const projectId = db.insert(schema.projects).values({ name: 'done days' }).returning().get().id
    db.insert(schema.repos)
      .values({ projectId, name: 'app', repoPath: '/r/days', baseBranch: 'main', githubRepo: 'acme/app' })
      .run()
    // Local times, so each is on the calendar day it says whatever the machine's time zone.
    const at = (day: number, hour: number) => new Date(2026, 9, day, hour)
    const done = (day: number) =>
      summary
        .getSummary(projectId, { now: at(day, 18), humans: [] })
        .projects[0]!.doneToday.prs.map((p) => ({ number: p.number, closedAt: p.closedAt }))
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(at(1, 10))
    found = [ghPr(40), ghPr(41)]
    await prs.refreshPrs(projectId)
    vi.setSystemTime(at(2, 10))
    // 40 merged; 42 was merged the day before and never in the queue open.
    found = [
      ghPr(40, { mergedAt: at(2, 9).toISOString() }),
      ghPr(41),
      ghPr(42, { mergedAt: at(1, 9).toISOString() }),
    ]
    await prs.refreshPrs(projectId)
    vi.setSystemTime(at(3, 10))
    // Fetched merged again, and 41 leaves the queue some other way.
    found = [ghPr(40, { mergedAt: at(2, 9).toISOString() }), ghPr(42, { mergedAt: at(1, 9).toISOString() })]
    await prs.refreshPrs(projectId)
    vi.setSystemTime(at(4, 10))
    await prs.refreshPrs(projectId)
    expect(done(1)).toEqual([{ number: 42, closedAt: at(1, 9).toISOString() }])
    expect(done(2)).toEqual([{ number: 40, closedAt: at(2, 10).toISOString() }])
    expect(done(3)).toEqual([{ number: 41, closedAt: at(3, 10).toISOString() }])
    expect(done(4)).toEqual([])
  })

  it('lists the other repos when one repo fails, the merged searches included, and throws only when all do', async () => {
    const { db, schema } = await import('#/db')
    const projectId = db.insert(schema.projects).values({ name: 'two repos' }).returning().get().id
    db.insert(schema.repos)
      .values([
        { projectId, name: 'app', repoPath: '/r/ok', baseBranch: 'main', githubRepo: 'acme/app' },
        { projectId, name: 'api', repoPath: '/r/broken', baseBranch: 'main', githubRepo: 'acme/api' },
      ])
      .run()
    foundIn = { '/r/ok': [ghPr(50), ghPr(51, { mergedAt: new Date().toISOString() })] }
    failing = new Set(['/r/broken'])
    const queue = await prs.listPrs(projectId, { refresh: true })
    expect(queue.map((p) => `${p.number}:${p.status}`).sort()).toEqual(['50:pending', '51:done'])
    failing = new Set(['/r/ok', '/r/broken'])
    await expect(prs.listPrs(projectId, { refresh: true })).rejects.toThrow('gh pr list failed')
  })
  it('says which PR to merge first when the ticket of a PR needs another ticket with an open PR', async () => {
    const { db, schema } = await import('#/db')
    const features = await import('./features')
    const needs = await import('./needs')
    const projectId = db.insert(schema.projects).values({ name: 'stacked' }).returning().get().id
    db.insert(schema.repos)
      .values({ projectId, name: 'app', repoPath: '/r/app', baseBranch: 'main', githubRepo: 'acme/app' })
      .run()
    found = [ghPr(10, { assigned: true }), ghPr(11, { assigned: true }), ghPr(12, { assigned: true })]
    const base = features.createTicket(projectId, { title: 'base', branch: 'feat/10' }, 'claude')
    const top = features.createTicket(projectId, { title: 'top', branch: 'feat/11', prNumber: 11 }, 'claude')
    // A need whose PR is outside the queue still counts while its ticket is open; once done, not.
    const outside = features.createTicket(projectId, { title: 'outside', prNumber: 99 }, 'claude')
    const other = features.createTicket(projectId, { title: 'other', branch: 'feat/12' }, 'claude')
    await needs.changeTicket(top.id, { needs: [base.id, outside.id] }, 'claude', { agent: true })
    await needs.changeTicket(other.id, { needs: [outside.id] }, 'claude', { agent: true })
    features.updateTicket(outside.id, { status: 'done' }, 'me')
    const queue = await prs.listPrs(projectId, { refresh: true })
    const byNumber = (n: number) => queue.find((p) => p.number === n)!
    expect(byNumber(11).mergeAfter).toEqual([
      {
        ticketId: base.id,
        title: 'base',
        repoId: byNumber(10).repoId,
        number: 10,
        url: 'https://github.com/acme/app/pull/10',
      },
    ])
    expect(byNumber(10).mergeAfter).toEqual([])
    expect(byNumber(12).mergeAfter).toEqual([])
    features.updateTicket(outside.id, { status: 'review' }, 'me')
    expect((await prs.listPrs(projectId)).find((p) => p.number === 12)!.mergeAfter).toMatchObject([
      { ticketId: outside.id, number: 99, url: 'https://github.com/acme/app/pull/99' },
    ])
  })
})

/** A project with one GitHub repo, which the refreshes in these tests read from `found`. */
async function queueProject(name: string) {
  const { db, schema } = await import('#/db')
  const projectId = db.insert(schema.projects).values({ name }).returning().get().id
  const repoId = db
    .insert(schema.repos)
    .values({ projectId, name: 'app', repoPath: `/r/${name}`, baseBranch: 'main', githubRepo: 'acme/app' })
    .returning()
    .get().id
  return { projectId, repoId }
}

/** Lets every refresh that can run without a held search run to its end: the searches here answer at once. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

/** PR `number` as stored, with the PR ticket its row holds (undefined when it has none). */
async function storedPr(projectId: number, number: number) {
  const { db, schema } = await import('#/db')
  const row = db
    .select()
    .from(schema.prs)
    .where(and(eq(schema.prs.projectId, projectId), eq(schema.prs.number, number)))
    .get()!
  const ticket = db.select().from(schema.tickets).where(eq(schema.tickets.prId, row.id)).get()
  return { row, ticket }
}

describe('PR tickets', () => {
  it('opens one for each open PR of the queue, in the stage its status has, and never a second', async () => {
    const { db, schema } = await import('#/db')
    const { projectId, repoId } = await queueProject('pr-tickets-open')
    found = [
      ghPr(1),
      theirs(2, { reviews: [review('enrique', HEAD, undefined, 'APPROVED')] }),
      ghPr(3, { isDraft: true }),
      ghPr(4, { mergedAt: new Date().toISOString() }),
    ]
    await prs.refreshPrs(projectId)
    // Two refreshes at once: each checks and inserts in one synchronous step, so neither opens a second.
    await Promise.all([prs.refreshPrs(projectId), prs.refreshPrs(projectId)])
    const own = db
      .select()
      .from(schema.tickets)
      .all()
      .filter((t) => t.projectId === projectId && t.prId !== null)
    expect(own.map((t) => t.prNumber).sort()).toEqual([1, 2, 3])
    const one = (await storedPr(projectId, 1)).ticket!
    expect(one).toMatchObject({
      title: 'PR #1: pr 1',
      status: 'todo',
      repoId,
      prNumber: 1,
      createdBy: 'board',
      branch: '',
      body: 'https://github.com/acme/app/pull/1',
      archivedAt: null,
    })
    expect((await storedPr(projectId, 2)).ticket).toMatchObject({ title: 'PR #2: pr 2', status: 'review' })
    expect((await storedPr(projectId, 3)).ticket).toMatchObject({ status: 'todo' })
    // First seen merged: no ticket.
    expect((await storedPr(projectId, 4)).ticket).toBeUndefined()
    const queue = await prs.listPrs(projectId)
    expect(queue.find((p) => p.number === 1)!.ticket).toEqual({
      id: one.id,
      title: 'PR #1: pr 1',
      status: 'todo',
    })
    expect(queue.find((p) => p.number === 4)!.ticket).toBeNull()
  })

  it('opens one for a stored open PR of a project with no GitHub repo, at the next refresh', async () => {
    const { db, schema } = await import('#/db')
    const projectId = db.insert(schema.projects).values({ name: 'pr-tickets-seeded' }).returning().get().id
    const repoId = db
      .insert(schema.repos)
      .values({ projectId, name: 'app', repoPath: '/r/pr-tickets-seeded', baseBranch: 'main' })
      .returning()
      .get().id
    const now = new Date().toISOString()
    db.insert(schema.prs)
      .values({
        projectId,
        repoId,
        number: 9001,
        title: 'Seeded PR',
        url: 'https://example.invalid/pr/9001',
        author: 'someone',
        headRef: 'seed-branch',
        baseRef: 'main',
        headSha: 'abcdef1234567',
        waitingOn: 'me',
        updatedAt: now,
        fetchedAt: now,
      })
      .run()
    await prs.refreshPrs(projectId)
    expect((await storedPr(projectId, 9001)).ticket).toMatchObject({
      title: 'PR #9001: Seeded PR',
      status: 'todo',
    })
  })

  it("titles it with its number and the PR's title, cut to 80 characters", async () => {
    const { projectId } = await queueProject('pr-tickets-title')
    found = [ghPr(5, { title: 'x'.repeat(120) })]
    await prs.refreshPrs(projectId)
    const title = (await storedPr(projectId, 5)).ticket!.title
    expect(title).toHaveLength(80)
    expect(title.startsWith('PR #5: xxx')).toBe(true)
  })

  it('gives no ticket to a PR a feature ticket names, by number or by branch, but opens one for a PR a feature names by another number', async () => {
    const features = await import('./features')
    const { projectId } = await queueProject('pr-tickets-feature')
    const seven = features.createTicket(projectId, { title: 'seven', prNumber: 7 }, 'claude')
    const eight = features.createTicket(projectId, { title: 'eight', branch: 'feat/8' }, 'claude')
    // Its branch is PR 9's, but it names PR 99: it claims no PR by its branch.
    features.createTicket(projectId, { title: 'other', branch: 'feat/9', prNumber: 99 }, 'claude')
    found = [ghPr(7), ghPr(8), ghPr(9)]
    const queue = await prs.listPrs(projectId, { refresh: true })
    const byNumber = (n: number) => queue.find((p) => p.number === n)!
    expect((await storedPr(projectId, 7)).ticket).toBeUndefined()
    expect((await storedPr(projectId, 8)).ticket).toBeUndefined()
    expect((await storedPr(projectId, 9)).ticket).toMatchObject({ title: 'PR #9: pr 9' })
    // The card opens the feature ticket that names the PR; `tickets` lists only those.
    expect(byNumber(7).ticket).toEqual({ id: seven.id, title: 'seven', status: 'todo' })
    expect(byNumber(8).ticket).toEqual({ id: eight.id, title: 'eight', status: 'todo' })
    expect(byNumber(7).tickets.map((t) => t.id)).toEqual([seven.id])
    expect(byNumber(9).ticket).toMatchObject({ title: 'PR #9: pr 9' })
    expect(byNumber(9).tickets).toEqual([])
  })

  it('follows its PR: a refresh, a hold and its release, merged to done, closed to cancelled, and a PR that only leaves the searches keeps its stage', async () => {
    const features = await import('./features')
    const { projectId } = await queueProject('pr-tickets-stages')
    const status = async (n: number) => (await storedPr(projectId, n)).ticket!.status
    found = [ghPr(20), ghPr(21), ghPr(22), ghPr(23)]
    await prs.refreshPrs(projectId)
    expect(await status(20)).toBe('todo')
    // A person's move holds through a refresh that finds no change of status.
    features.updateTicket((await storedPr(projectId, 20)).ticket!.id, { status: 'in_progress' }, 'enrique')
    await prs.refreshPrs(projectId)
    expect(await status(20)).toBe('in_progress')
    // Approved by the human: its reviews are reviewed, so it is in review.
    const approved = theirs(20, { reviews: [review('enrique', HEAD, undefined, 'APPROVED')] })
    found = [approved, ghPr(21), ghPr(22), ghPr(23)]
    await prs.refreshPrs(projectId)
    expect(await status(20)).toBe('review')
    // Held: blocked; released: back to its status.
    const held = prs.setPrHold((await storedPr(projectId, 20)).row.id, true, 'wait', 'enrique')
    expect(await status(20)).toBe('blocked')
    prs.setPrHold(held.id, false, '', 'enrique')
    expect(await status(20)).toBe('review')
    // Merged: done in the refresh that finds it. Closed without merging: cancelled. Only gone from the searches
    // (GitHub says it is still open): keeps its stage.
    states = { 22: 'CLOSED', 23: 'OPEN' }
    found = [approved, ghPr(21, { mergedAt: new Date().toISOString() })]
    await prs.refreshPrs(projectId)
    expect(await status(21)).toBe('done')
    expect(await status(22)).toBe('cancelled')
    expect(await status(23)).toBe('todo')
    // The board archives none of them: that stays the human's.
    for (const n of [20, 21, 22, 23]) expect((await storedPr(projectId, n)).ticket!.archivedAt).toBeNull()
  })

  it('leaves no ticket to a PR stored before the change that is merged or closed, nor to one first seen merged', async () => {
    const { db, schema } = await import('#/db')
    const { projectId, repoId } = await queueProject('pr-tickets-old')
    const now = new Date().toISOString()
    const stored = (number: number, values: { open: boolean; mergedAt?: string; closedAt: string }) =>
      db
        .insert(schema.prs)
        .values({
          projectId,
          repoId,
          number,
          title: `pr ${number}`,
          url: `https://github.com/acme/app/pull/${number}`,
          author: 'enrique',
          headRef: `feat/${number}`,
          baseRef: 'main',
          headSha: HEAD,
          updatedAt: now,
          fetchedAt: now,
          ...values,
        })
        .run()
    stored(88, { open: false, mergedAt: now, closedAt: now })
    stored(89, { open: false, closedAt: now })
    found = [ghPr(90, { mergedAt: now })]
    await prs.refreshPrs(projectId)
    expect(
      db
        .select()
        .from(schema.tickets)
        .all()
        .filter((t) => t.projectId === projectId),
    ).toEqual([])
  })

  it('takes posts and tasks like any ticket, shows its PR with the latest review, and gets the reviews of its PR posted', async () => {
    const features = await import('./features')
    const reviews = await import('./reviews')
    const { projectId } = await queueProject('pr-tickets-review')
    found = [ghPr(30)]
    await prs.refreshPrs(projectId)
    const ticket = (await storedPr(projectId, 30)).ticket!
    features.postUpdate(ticket.id, 'Checked the diff.', [], 'claude')
    features.addTasks(ticket.id, ['Read the change'], 'claude')
    reviews.postResult(
      projectId,
      { prNumber: 30, sha: HEAD, verdict: 'SHIP', summaryMd: 'Looks right.' },
      'claude',
    )
    const full = features.getTicketFull(ticket.id)
    expect(full.updates.map((u) => u.body)).toEqual([
      'Review of PR #30 at a1b2c3d: SHIP\n\nLooks right.',
      'Checked the diff.',
    ])
    expect(full.updates[0]).toMatchObject({ author: 'claude', progress: true })
    expect(full.tasks.map((t) => t.text)).toEqual(['Read the change'])
    expect(full.pr).toMatchObject({
      number: 30,
      queue: { status: 'pending' },
      latestReview: { verdict: 'SHIP', fresh: true },
    })
  })

  it('posts a review on the ticket of its PR, the feature ticket that names it first, and on no ticket for a PR nobody has one for', async () => {
    const { db, schema } = await import('#/db')
    const features = await import('./features')
    const reviews = await import('./reviews')
    const { projectId } = await queueProject('pr-tickets-posts')
    const named = features.createTicket(projectId, { title: 'named', prNumber: 41 }, 'claude')
    found = [ghPr(40), ghPr(41)]
    await prs.refreshPrs(projectId)
    reviews.postResult(
      projectId,
      { prNumber: 40, sha: HEAD, verdict: 'FIX FIRST', summaryMd: 'Two findings.' },
      'claude',
    )
    reviews.postResult(projectId, { prNumber: 41, sha: HEAD, verdict: 'SHIP', summaryMd: '' }, 'claude')
    reviews.postResult(
      projectId,
      { prNumber: 42, sha: HEAD, verdict: 'SHIP', summaryMd: 'Not in the queue.' },
      'claude',
    )
    const bodies = (ticketId: number) => features.getTicketFull(ticketId).updates.map((u) => u.body)
    expect(bodies((await storedPr(projectId, 40)).ticket!.id)).toEqual([
      'Review of PR #40 at a1b2c3d: FIX FIRST\n\nTwo findings.',
    ])
    expect(bodies(named.id)).toEqual(['Review of PR #41 at a1b2c3d: SHIP'])
    expect((await storedPr(projectId, 41)).ticket).toBeUndefined()
    expect(reviews.listResults(projectId, 20, { prNumber: 42 })).toHaveLength(1)
    expect(
      db
        .select()
        .from(schema.updates)
        .all()
        .some((u) => u.body.includes('Not in the queue.')),
    ).toBe(false)
  })

  it('runs overlapping refreshes of a project one after the other, so an older read cannot move a ticket last', async () => {
    const { db, schema } = await import('#/db')
    const projectId = db.insert(schema.projects).values({ name: 'pr-refresh-overlap' }).returning().get().id
    const [one, two] = ['one', 'two'].map((name) =>
      db
        .insert(schema.repos)
        .values({
          projectId,
          name,
          repoPath: `/r/overlap-${name}`,
          baseBranch: 'main',
          githubRepo: `acme/${name}`,
        })
        .returning()
        .get(),
    )
    // Someone else's PR in repo one, waiting on my review: pending, with its ticket in To do.
    foundIn = { [one.repoPath]: [theirs(40)], [two.repoPath]: [] }
    await prs.refreshPrs(projectId)
    expect((await storedPr(projectId, 40)).ticket).toMatchObject({ status: 'todo' })

    // Refresh A reads repo one with my approval, then waits on repo two's search.
    foundIn[one.repoPath] = [theirs(40, { reviews: [review('enrique', HEAD, undefined, 'APPROVED')] })]
    let release = () => {}
    holdNext.set(two.repoPath, new Promise<void>((resolve) => (release = () => resolve())))
    const a = prs.refreshPrs(projectId)
    await settle()
    // Then I request changes, and refresh B reads that while A still waits.
    foundIn[one.repoPath] = [
      theirs(40, { reviews: [review('enrique', HEAD, undefined, 'CHANGES_REQUESTED')] }),
    ]
    const b = prs.refreshPrs(projectId)
    await settle()
    release()
    await Promise.all([a, b])

    // The row and its ticket agree: on hold, in Blocked. A's older read must not put the ticket back in review.
    const stored = await storedPr(projectId, 40)
    expect(stored.row.reviewStage).toBe('on_hold')
    expect(stored.ticket).toMatchObject({ status: 'blocked' })
  })

  it('runs the next refresh of a project after one that failed', async () => {
    const { projectId } = await queueProject('pr-refresh-after-failure')
    failing = new Set(['/r/pr-refresh-after-failure'])
    await expect(prs.refreshPrs(projectId)).rejects.toThrow('gh pr list failed')
    failing = new Set()
    found = [theirs(41)]
    await prs.refreshPrs(projectId)
    expect((await storedPr(projectId, 41)).ticket).toMatchObject({ status: 'todo' })
  })
})

describe('PR tickets over the API', () => {
  let handle: (request: Request) => Promise<Response>
  beforeAll(async () => {
    const { api } = await import('./api')
    const { api: guard } = await import('./http')
    // As the server answers: a bearer token is an agent (`claude`), anyone else is the human.
    const guarded = guard(({ request }: { request: Request }) =>
      api.handle(request, request.headers.has('authorization') ? 'claude' : 'enrique'),
    )
    handle = (request) => guarded({ request })
  })

  async function call(method: string, pathname: string, body?: unknown, as: 'human' | 'agent' = 'human') {
    const res = await handle(
      new Request(`http://localhost${pathname}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(as === 'agent' ? { authorization: 'Bearer gate_test' } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    )
    return { status: res.status, body: (await res.json()) as any }
  }

  it("gives each queue row its ticket, keeps it off the features board, and refuses an agent's archive and PR threads", async () => {
    const { projectId } = await queueProject('pr-tickets-api')
    found = [ghPr(60)]
    const rows = await call('GET', `/api/projects/${projectId}/prs?refresh=1`)
    expect(rows.status).toBe(200)
    const ticket = rows.body.find((p: { number: number }) => p.number === 60).ticket
    expect(ticket).toMatchObject({ title: 'PR #60: pr 60', status: 'todo' })
    expect((await call('GET', `/api/projects/${projectId}/tickets`)).body).toEqual([])
    expect((await call('GET', `/api/tickets/${ticket.id}`)).body).toMatchObject({
      id: ticket.id,
      prNumber: 60,
    })
    expect((await call('POST', `/api/tickets/${ticket.id}/archive`, undefined, 'agent')).status).toBe(403)
    expect(
      (await call('POST', '/api/comments', { parentType: 'pr', parentId: ticket.id, body: 'hi' })).status,
    ).toBe(400)
    expect((await call('GET', `/api/comments?parentType=pr&parentId=${ticket.id}`)).status).toBe(400)
  })

  it('tell agents the same over MCP: the instructions and the tools name a PR ticket, and no PR thread', async () => {
    const { handleMcp } = await import('./mcp')
    let rpcId = 0
    const rpc = async (method: string, params: Record<string, unknown> = {}) => {
      const res = await handleMcp(
        new Request('http://localhost/api/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
        }),
        'claude',
      )
      return ((await res.json()) as { result: any }).result
    }
    const init = await rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })
    expect(init.instructions).toContain('list_prs names it as ticket')
    expect(init.instructions).toContain('this ticket takes the PR over')
    expect(init.instructions).not.toContain('PR thread')
    const tools = (await rpc('tools/list')).tools as {
      name: string
      description: string
      inputSchema: unknown
    }[]
    const told = (name: string) => {
      const tool = tools.find((t) => t.name === name)!
      return `${tool.description} ${JSON.stringify(tool.inputSchema)}`
    }
    expect(told('list_prs')).toContain('ticket is the ticket its card opens')
    expect(told('post_review_result')).toContain('list_prs ticket')
    expect(told('list_tickets')).toContain("a PR's own ticket")
    expect(told('get_summary')).toContain('prTicket true')
    expect(told('create_ticket')).toContain('takes the PR over')
    expect(told('update_ticket')).toContain('takes the PR over')
    for (const name of ['comment', 'list_comments'])
      expect(told(name)).not.toMatch(/under a PR|a PR or a review/)
  })
})
