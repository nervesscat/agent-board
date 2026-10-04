import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it, vi } from 'vitest'

import type { GhCheck, MyGhPr } from './git'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp

// gh answers from fixtures: the refresh reads whatever `found` holds.
let found: MyGhPr[] = []
vi.mock('./git', async (original) => ({
  ...(await original<typeof import('./git')>()),
  listMyPrs: async () => found,
  currentGithubLogin: async () => 'enrique',
}))

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
  reviews: [],
  requested: false,
  assigned: false,
  ...over,
})

const review = (login: string, oid: string, submittedAt = '2026-10-01T09:00:00Z') => ({
  author: { login },
  state: 'COMMENTED',
  submittedAt,
  commit: { oid },
})

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
  it('waits on me when my review is requested, whatever I reviewed before', () => {
    expect(prs.prWaitingOn(ghPr(1, { requested: true }), review('enrique', HEAD))).toBe('me')
  })

  it("waits on me for a PR assigned to me (an agent's) until I review its head", () => {
    expect(prs.prWaitingOn(ghPr(1, { assigned: true }), undefined)).toBe('me')
    expect(prs.prWaitingOn(ghPr(1, { assigned: true }), review('enrique', 'older'))).toBe('me')
    expect(prs.prWaitingOn(ghPr(1, { assigned: true }), review('enrique', HEAD))).toBe('others')
  })

  it('waits on others when I only reviewed it and nobody asks me again', () => {
    expect(prs.prWaitingOn(ghPr(1), review('enrique', 'older'))).toBe('others')
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
  it('stores whose move each PR waits on and where it stands on GitHub', async () => {
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
      // Someone else's PR I already reviewed at its head: the author has the next move.
      ghPr(2, {
        author: { login: 'ana' },
        reviewDecision: 'CHANGES_REQUESTED',
        reviews: [{ ...review('enrique', HEAD), state: 'CHANGES_REQUESTED' }],
        mergeable: 'UNKNOWN',
        mergeStateStatus: 'UNKNOWN',
      }),
    ]
    const queue = await prs.listPrs(projectId, { refresh: true })
    expect(queue.find((p) => p.number === 1)).toMatchObject({
      waitingOn: 'me',
      status: 'pending',
      merge: 'conflicts',
      ci: 'failing',
      checks: [{ name: 'lint', state: 'fail' }],
    })
    expect(queue.find((p) => p.number === 2)).toMatchObject({
      waitingOn: 'others',
      status: 'reviewed',
      myReview: 'changes_requested',
      reviewDecision: 'CHANGES_REQUESTED',
      merge: 'checking',
      ci: 'none',
    })
  })
})
