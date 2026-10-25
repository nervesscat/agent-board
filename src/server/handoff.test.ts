import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { HandoffFacts } from './handoff'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp
const origin = path.join(tmp, 'origin.git')
const repo = path.join(tmp, 'repo')

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const git = (...args: string[]) => gitIn(repo, ...args)

const COMMIT_AT = '2026-01-10T12:00:00.000Z'
const facts = (over: Partial<HandoffFacts> = {}): HandoffFacts => ({
  branch: 'feat/x',
  tasks: { done: 3, total: 3 },
  pr: { number: 7, ci: 'passing', merged: false },
  push: { state: 'pushed', ahead: 0 },
  previews: [{ url: 'http://localhost:47101', running: true }],
  lastCommitAt: COMMIT_AT,
  since: '2026-01-09T09:00:00.000Z',
  posts: [
    {
      author: 'claude',
      progress: false,
      handoff: false,
      summary: true,
      createdAt: '2026-01-10T13:00:00.000Z',
    },
  ],
  humans: ['enrique'],
  ...over,
})

describe('handoffOf', () => {
  it('finds nothing missing in a full hand-off', async () => {
    const { handoffOf } = await import('./handoff')
    const h = handoffOf(facts())
    expect(h.missing).toEqual([])
    // Merged first, waiting on the human: listed, never missing.
    expect(h.checks.map((c) => [c.code, c.ok])).toEqual([
      ['not_merged', false],
      ['tasks_open', true],
      ['no_pr', true],
      ['not_pushed', true],
      ['no_preview', true],
      ['no_handoff_post', true],
      ['checks_unknown', true],
    ])
  })

  it('tasks_open: Implementation, met once there are tasks and every one is done', async () => {
    const { handoffOf } = await import('./handoff')
    // Right after Merged in the checklist.
    const implementation = (tasks: HandoffFacts['tasks']) => handoffOf(facts({ tasks })).checks[1]!
    expect(implementation({ done: 3, total: 3 })).toEqual({
      code: 'tasks_open',
      label: 'Implementation',
      ok: true,
      text: '3 of 3 tasks done',
    })
    const none = handoffOf(facts({ tasks: { done: 0, total: 0 } }))
    expect(none.checks[1]).toMatchObject({ code: 'tasks_open', ok: false })
    expect(none.missing).toEqual([{ code: 'tasks_open', text: expect.stringMatching(/^No tasks/) }])
    // It points to the default phases, with the steps under Implementation.
    expect(none.checks[1]!.text).toBe(
      'No tasks: add the default phases (Implementation, then Pushed, PR, CI, Preview, Merged, Hand-off post), put the steps under Implementation, and tick each step as you finish it (the board ticks Pushed, PR, CI, Preview and Merged itself)',
    )
    expect(handoffOf(facts({ tasks: { done: 3, total: 5 } })).missing).toEqual([
      { code: 'tasks_open', text: '3 of 5 tasks done' },
    ])
    expect(handoffOf(facts({ tasks: { done: 0, total: 1 } })).missing).toEqual([
      { code: 'tasks_open', text: '0 of 1 task done' },
    ])
    // First in missing: Merged, above it, never is.
    expect(handoffOf(facts({ tasks: { done: 0, total: 2 }, pr: null })).missing.map((m) => m.code)).toEqual([
      'tasks_open',
      'no_pr',
    ])
  })

  it('not_merged: merged by push state or by the PR, and never missing', async () => {
    const { handoffOf } = await import('./handoff')
    const merged = (over: Partial<HandoffFacts>) => {
      const h = handoffOf(facts(over))
      expect(h.checks[0]).toMatchObject({ code: 'not_merged', label: 'Merged' })
      return h
    }
    expect(merged({}).checks[0]).toMatchObject({ ok: false, text: 'Not merged yet' })
    expect(merged({ push: { state: 'merged', ahead: 0, into: 'main' } }).checks[0]).toMatchObject({
      ok: true,
      text: 'Merged into main',
    })
    expect(merged({ push: { state: 'merged', ahead: 0 } }).checks[0]!.text).toBe('Merged into its base')
    // Merged on GitHub while the branch still reads as pushed.
    expect(merged({ pr: { number: 7, ci: 'passing', merged: true } }).checks[0]).toMatchObject({
      ok: true,
      text: 'PR #7 merged',
    })
    // Not merged, with other items missing: those are listed, in order, and Merged is not.
    const h = merged({ pr: null, previews: [], posts: [] })
    expect(h.checks[0]!.ok).toBe(false)
    expect(h.missing.map((m) => m.code)).toEqual(['no_pr', 'no_preview', 'no_handoff_post'])
    for (const push of [
      { state: 'ahead', ahead: 2 },
      { state: 'local-only', ahead: 1 },
      { state: 'none', ahead: 0 },
    ] as const)
      expect(merged({ push }).missing.map((m) => m.code)).toEqual(['not_pushed'])
  })

  it('no_pr: without a PR', async () => {
    const { handoffOf } = await import('./handoff')
    const codes = (f: HandoffFacts) => handoffOf(f).missing.map((m) => m.code)
    expect(codes(facts({ pr: null }))).toEqual(['no_pr'])
    expect(codes(facts({ pr: { number: 3, ci: null, merged: false } }))).toEqual([])
  })

  it('not_pushed: ahead, local-only or no branch; a merged branch is fine', async () => {
    const { handoffOf } = await import('./handoff')
    const missing = (push: HandoffFacts['push'], branch = 'feat/x') =>
      handoffOf(facts({ push, branch })).missing
    expect(missing({ state: 'ahead', ahead: 2 })).toEqual([
      { code: 'not_pushed', text: '2 commits not pushed' },
    ])
    expect(missing({ state: 'local-only', ahead: 1 })).toEqual([
      { code: 'not_pushed', text: 'Branch not on origin' },
    ])
    expect(missing({ state: 'none', ahead: 0 }, '')).toEqual([{ code: 'not_pushed', text: 'No branch set' }])
    expect(missing({ state: 'merged', ahead: 0, into: 'main' })).toEqual([])
    expect(handoffOf(facts({ push: { state: 'merged', ahead: 0, into: 'main' } })).checks[3]!.text).toBe(
      'Merged into main',
    )
  })

  it('no_preview: none, or none running', async () => {
    const { handoffOf } = await import('./handoff')
    const codes = (previews: HandoffFacts['previews']) =>
      handoffOf(facts({ previews })).missing.map((m) => m.code)
    expect(codes([])).toEqual(['no_preview'])
    expect(codes([{ url: 'http://localhost:47102', running: false }])).toEqual(['no_preview'])
    expect(
      codes([
        { url: 'http://localhost:47102', running: false },
        { url: 'http://localhost:47103', running: true },
      ]),
    ).toEqual([])
  })

  it('no_handoff_post: only a summary an agent wrote after the last commit counts', async () => {
    const { handoffOf } = await import('./handoff')
    const check = (over: Partial<HandoffFacts>) =>
      handoffOf(facts(over)).checks.find((c) => c.code === 'no_handoff_post')!
    const codes = (over: Partial<HandoffFacts>) => handoffOf(facts(over)).missing.map((m) => m.code)
    const summary = (author: string, createdAt: string) => ({
      author,
      progress: false,
      handoff: false,
      summary: true,
      createdAt,
    })
    const post = (author: string, createdAt: string, extra: Partial<HandoffFacts['posts'][number]> = {}) => ({
      author,
      progress: true,
      handoff: false,
      summary: false,
      createdAt,
      ...extra,
    })
    expect(check({})).toEqual({
      code: 'no_handoff_post',
      label: 'Summary',
      ok: true,
      text: 'Summary updated by claude after the last commit',
    })
    expect(codes({ posts: [] })).toEqual(['no_handoff_post'])
    // Written before the last commit, or by the human.
    expect(codes({ posts: [summary('claude', '2026-01-10T11:00:00.000Z')] })).toEqual(['no_handoff_post'])
    expect(codes({ posts: [summary('enrique', '2026-01-10T13:00:00.000Z')] })).toEqual(['no_handoff_post'])
    // Any version after the commit counts, an older one before it too.
    expect(
      codes({
        posts: [
          summary('enrique', '2026-01-10T14:00:00.000Z'),
          summary('claude', '2026-01-10T13:00:00.000Z'),
        ],
      }),
    ).toEqual([])
    // Once there is a summary only the summary counts: a progress post after the commit does not.
    expect(
      codes({
        posts: [post('claude', '2026-01-10T13:00:00.000Z'), summary('claude', '2026-01-10T11:00:00.000Z')],
      }),
    ).toEqual(['no_handoff_post'])
    expect(check({ posts: [summary('claude', '2026-01-10T11:00:00.000Z')] }).text).toBe(
      'No summary since the last commit',
    )

    // A ticket whose summary was never written: an agent's progress post after the last commit stands in for it.
    expect(check({ posts: [post('claude', '2026-01-10T13:00:00.000Z')] })).toMatchObject({
      ok: true,
      text: 'No summary yet; progress post by claude after the last commit',
    })
    // Before the last commit; the human's, a discussion post, a resume note do not.
    expect(codes({ posts: [post('claude', '2026-01-10T11:00:00.000Z')] })).toEqual(['no_handoff_post'])
    expect(codes({ posts: [post('enrique', '2026-01-10T13:00:00.000Z')] })).toEqual(['no_handoff_post'])
    expect(codes({ posts: [post('claude', '2026-01-10T13:00:00.000Z', { progress: false })] })).toEqual([
      'no_handoff_post',
    ])
    expect(codes({ posts: [post('claude', '2026-01-10T13:00:00.000Z', { handoff: true })] })).toEqual([
      'no_handoff_post',
    ])
    // Without a branch, since work started.
    const noBranch = { branch: '', lastCommitAt: null, push: { state: 'none' as const, ahead: 0 } }
    const before = handoffOf(facts({ ...noBranch, posts: [summary('claude', '2026-01-09T08:00:00.000Z')] }))
    expect(before.missing.find((m) => m.code === 'no_handoff_post')!.text).toBe(
      'No summary since work started',
    )
    const after = handoffOf(facts({ ...noBranch, posts: [summary('claude', '2026-01-09T10:00:00.000Z')] }))
    expect(after.missing.map((m) => m.code)).not.toContain('no_handoff_post')
    const fallback = handoffOf(facts({ ...noBranch, posts: [post('claude', '2026-01-09T10:00:00.000Z')] }))
    expect(fallback.missing.map((m) => m.code)).not.toContain('no_handoff_post')
  })

  it('checks_unknown: only when CI is failing or still running', async () => {
    const { handoffOf } = await import('./handoff')
    const ci = (state: 'passing' | 'failing' | 'pending' | 'none' | null) =>
      handoffOf(facts({ pr: { number: 7, ci: state, merged: false } }))
    expect(ci('failing').missing).toEqual([{ code: 'checks_unknown', text: "The PR's CI is failing" }])
    expect(ci('pending').missing).toEqual([{ code: 'checks_unknown', text: "The PR's CI is still running" }])
    expect(ci('passing').missing).toEqual([])
    // No checks, or the PR is not in the queue: nothing to say, and no CI row.
    for (const state of ['none', null] as const) {
      expect(ci(state).missing).toEqual([])
      expect(ci(state).checks.map((c) => c.code)).not.toContain('checks_unknown')
    }
  })

  it('checks_unknown: a "CI run locally: green" comment on the head passes it, whatever the checks say', async () => {
    const { handoffOf } = await import('./handoff')
    for (const state of ['failing', 'pending', 'none', null] as const) {
      const h = handoffOf(facts({ pr: { number: 7, ci: state, merged: false, localCi: true } }))
      expect(h.missing).toEqual([])
      expect(h.checks.find((c) => c.code === 'checks_unknown')).toEqual({
        code: 'checks_unknown',
        label: 'CI',
        ok: true,
        text: 'CI run locally: green on the head',
      })
    }
    expect(
      handoffOf(facts({ pr: { number: 7, ci: 'failing', merged: false, localCi: false } })).missing,
    ).toEqual([{ code: 'checks_unknown', text: "The PR's CI is failing" }])
  })
})

describe('moving a ticket to review', () => {
  let server: http.Server
  let previewUrl: string

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
    git('checkout', '-q', '-b', 'feat/handoff')
    fs.writeFileSync(path.join(repo, 'work.txt'), 'work\n')
    git('add', 'work.txt')
    // Committed a minute ago, so the posts below come after it.
    const at = new Date(Date.now() - 60_000).toISOString()
    execFileSync('git', ['commit', '-q', '-m', 'work'], {
      cwd: repo,
      stdio: 'ignore',
      env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
    })
    git('checkout', '-q', 'main')
    server = http.createServer((_req, res) => res.end('ok'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    previewUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }, 60_000)

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  it('answers with what is missing, and get_ticket shows the same while it is in review', async () => {
    const { db, schema } = await import('#/db')
    const { noteActor } = await import('./actors')
    const features = await import('./features')
    const needs = await import('./needs')
    const { fetchRepo } = await import('./push')
    const projectId = db.insert(schema.projects).values({ name: 'p' }).returning().get().id
    const repoId = db
      .insert(schema.repos)
      .values({ projectId, name: 'repo', repoPath: repo, baseBranch: 'main' })
      .returning()
      .get().id
    noteActor('enrique', 'human')
    // The implementation: a step with two parts, all open.
    const t = features.createTicket(
      projectId,
      {
        title: 't',
        branch: 'feat/handoff',
        status: 'in_progress',
        tasks: [{ text: 'build it', subtasks: ['code', 'test'] }],
      },
      'claude',
    )
    const codes = (h: { missing: { code: string }[] } | null | undefined) => h?.missing.map((m) => m.code)

    // Not a review stage: no hand-off.
    const moved = await needs.changeTicket(t.id, { title: 'renamed' }, 'claude', { agent: true })
    expect('handoff' in moved).toBe(false)
    expect((await needs.ticketView(t.id)).handoff).toBeNull()

    const first = await needs.changeTicket(t.id, { status: 'review' }, 'claude', { agent: true })
    expect('handoff' in first && codes(first.handoff)).toEqual([
      'tasks_open',
      'no_pr',
      'not_pushed',
      'no_preview',
      'no_handoff_post',
    ])
    // Not blocked: it is in review.
    expect(first.status).toBe('review')

    // The human's summary does not count; the agent's does. Then the branch is pushed, a PR set, and a
    // preview that answers registered.
    features.setSummary(t.id, { body: 'looks fine?' }, 'enrique')
    expect(codes((await needs.ticketView(t.id)).handoff)).toContain('no_handoff_post')
    features.setSummary(t.id, { body: 'PR #12, preview at …', change: 'the hand-off' }, 'claude')
    git('push', '-q', 'origin', 'feat/handoff')
    await fetchRepo(repo, { force: true })
    features.addWorkspace(t.id, { name: 'wt', branch: 'feat/handoff', previewUrl }, 'claude')
    const view = await needs.ticketView(t.id)
    expect(codes(view.handoff)).toEqual(['tasks_open', 'no_pr'])
    expect(view.handoff!.missing[0]!.text).toBe('0 of 3 tasks done')

    // A lane's tasks count too, until it is cancelled.
    const lane = features.createTicket(
      projectId,
      { title: 'lane', parentId: t.id, tasks: ['lane step'] },
      'claude',
    )
    // One tick on the step ticks its parts.
    const step = features.getTicketFull(t.id).tasks.find((x) => x.text === 'build it')!
    features.updateTask(step.id, { done: true }, 'claude')
    const ticked = await needs.ticketView(t.id)
    expect(ticked.handoff!.missing[0]).toEqual({ code: 'tasks_open', text: '3 of 4 tasks done' })
    features.updateTicket(lane.id, { status: 'cancelled' }, 'claude')
    expect(codes((await needs.ticketView(t.id)).handoff)).toEqual(['no_pr'])
    expect(view.handoff!.checks.find((c) => c.code === 'no_preview')).toMatchObject({
      ok: true,
      text: `Running at ${previewUrl}`,
    })

    const again = await needs.changeTicket(t.id, { status: 'review', prNumber: 12 }, 'claude', {
      agent: true,
    })
    expect('handoff' in again && again.handoff.missing).toEqual([])
    // Nothing missing, and the branch not merged yet: that waits on the human.
    expect('handoff' in again && again.handoff.checks[0]).toMatchObject({
      code: 'not_merged',
      ok: false,
      text: 'Not merged yet',
    })

    // GitHub merged PR #12 (the queue saw it): Merged, though the branch is still on origin.
    const now = new Date().toISOString()
    db.insert(schema.prs)
      .values({
        projectId,
        repoId,
        number: 12,
        title: 'Hand it off',
        url: 'https://github.com/o/r/pull/12',
        author: 'claude',
        headRef: 'feat/handoff',
        baseRef: 'main',
        headSha: git('rev-parse', 'feat/handoff'),
        updatedAt: now,
        fetchedAt: now,
        open: false,
        mergedAt: now,
        closedAt: now,
      })
      .run()
    const merged = await needs.ticketView(t.id)
    expect(merged.push.state).toBe('pushed')
    expect(merged.handoff!.missing).toEqual([])
    expect(merged.handoff!.checks[0]).toMatchObject({ code: 'not_merged', ok: true, text: 'PR #12 merged' })
  }, 30_000)

  it('with the default phases: the board ticks the hand-off phases, Merged is not counted, ticks never undo the summary', async () => {
    const { db, schema } = await import('#/db')
    const features = await import('./features')
    const needs = await import('./needs')
    const { fetchRepo } = await import('./push')
    const projectId = db.insert(schema.projects).values({ name: 'phases' }).returning().get().id
    const repoId = db
      .insert(schema.repos)
      .values({ projectId, name: 'repo', repoPath: repo, baseBranch: 'main' })
      .returning()
      .get().id
    // The branch's last commit is a minute old, and it is on origin.
    git('checkout', '-q', '-b', 'feat/phases', 'main')
    fs.writeFileSync(path.join(repo, 'phases.txt'), 'phases\n')
    git('add', 'phases.txt')
    const at = new Date(Date.now() - 60_000).toISOString()
    execFileSync('git', ['commit', '-q', '-m', 'phases'], {
      cwd: repo,
      stdio: 'ignore',
      env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
    })
    git('checkout', '-q', 'main')
    git('push', '-q', 'origin', 'feat/phases')
    await fetchRepo(repo, { force: true })

    const t = await needs.newTicket(
      projectId,
      { title: 'phased', branch: 'feat/phases', status: 'in_progress', tasks: ['code', 'test'] },
      'claude',
      { agent: true },
    )
    const task = (text: string) => features.getTicketFull(t.id).tasks.find((x) => x.text === text)!
    const ticks = () => Object.fromEntries(features.getTicketFull(t.id).tasks.map((x) => [x.text, x.done]))
    // The work done: Implementation's steps ticked, which ticks it.
    features.updateTask(task('code').id, { done: true }, 'claude')
    features.updateTask(task('test').id, { done: true }, 'claude')
    // The rest of the hand-off done, none of it ticked by hand: pushed above, the PR with its CI green,
    // a preview that runs, the post.
    features.addWorkspace(t.id, { name: 'wt', branch: 'feat/phases', previewUrl }, 'claude')
    const now = new Date().toISOString()
    db.insert(schema.prs)
      .values({
        projectId,
        repoId,
        number: 13,
        title: 'Phases',
        url: 'https://github.com/o/r/pull/13',
        author: 'claude',
        headRef: 'feat/phases',
        baseRef: 'main',
        headSha: git('rev-parse', 'feat/phases'),
        checks: [{ name: 'check', state: 'pass', url: null }],
        updatedAt: now,
        fetchedAt: now,
      })
      .run()
    await needs.changeTicket(t.id, { prNumber: 13 }, 'claude', { agent: true })
    features.setSummary(t.id, { body: 'Hand-off: PR #13, preview at …' }, 'claude')
    // The board ticks the phases that follow git, GitHub and the previews on its own, at the next read;
    // Merged and Hand-off post stay open.
    await needs.ticketView(t.id)
    expect(ticks()).toEqual({
      Implementation: true,
      code: true,
      test: true,
      Pushed: true,
      PR: true,
      CI: true,
      Preview: true,
      Merged: false,
      'Hand-off post': false,
    })

    // The move goes through; the post is all Implementation lacks, and the open Merged (the human's
    // step) is not counted.
    const moved = await needs.changeTicket(t.id, { status: 'review' }, 'claude', { agent: true })
    expect(moved.status).toBe('review')
    expect('handoff' in moved && moved.handoff.missing).toEqual([
      { code: 'tasks_open', text: '7 of 8 tasks done' },
    ])

    // Hand-off post ticked by hand: a tick is not a commit, so the summary written before it still counts.
    features.updateTask(task('Hand-off post').id, { done: true }, 'claude')
    const view = await needs.ticketView(t.id)
    expect(view.handoff!.missing).toEqual([])
    expect(view.handoff!.checks.find((c) => c.code === 'tasks_open')).toMatchObject({
      ok: true,
      text: '8 of 8 tasks done',
    })
    expect(view.handoff!.checks.find((c) => c.code === 'no_handoff_post')).toMatchObject({ ok: true })
    // The progress bar still counts Merged.
    expect(view.progress).toEqual({ done: 8, total: 9 })
  }, 30_000)
})
