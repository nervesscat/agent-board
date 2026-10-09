import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { GhCheck, MyGhPr } from './git'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp

// gh answers from fixtures: the refresh reads whatever `found` holds, or what `foundIn` holds for a
// repo's checkout; a checkout in `failing` has its searches fail.
let found: MyGhPr[] = []
let foundIn: Record<string, MyGhPr[]> = {}
let failing = new Set<string>()
vi.mock('./git', async (original) => ({
  ...(await original<typeof import('./git')>()),
  listMyPrs: async (repoPath: string) => {
    if (failing.has(repoPath)) throw new Error(`gh pr list failed in ${repoPath}`)
    return foundIn[repoPath] ?? found
  },
  currentGithubLogin: async () => 'enrique',
  prMerged: async () => false,
}))

afterEach(() => {
  found = []
  foundIn = {}
  failing = new Set()
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
