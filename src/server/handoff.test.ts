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
  pr: { number: 7, ci: 'passing' },
  push: { state: 'pushed', ahead: 0 },
  previews: [{ url: 'http://localhost:47101', running: true }],
  lastCommitAt: COMMIT_AT,
  since: '2026-01-09T09:00:00.000Z',
  posts: [{ author: 'claude', progress: true, handoff: false, createdAt: '2026-01-10T13:00:00.000Z' }],
  humans: ['enrique'],
  ...over,
})

describe('handoffOf', () => {
  it('finds nothing missing in a full hand-off', async () => {
    const { handoffOf } = await import('./handoff')
    const h = handoffOf(facts())
    expect(h.missing).toEqual([])
    expect(h.checks.map((c) => [c.code, c.ok])).toEqual([
      ['no_pr', true],
      ['not_pushed', true],
      ['no_preview', true],
      ['no_handoff_post', true],
      ['checks_unknown', true],
    ])
  })

  it('no_pr: without a PR', async () => {
    const { handoffOf } = await import('./handoff')
    const codes = (f: HandoffFacts) => handoffOf(f).missing.map((m) => m.code)
    expect(codes(facts({ pr: null }))).toEqual(['no_pr'])
    expect(codes(facts({ pr: { number: 3, ci: null } }))).toEqual([])
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
    expect(handoffOf(facts({ push: { state: 'merged', ahead: 0, into: 'main' } })).checks[1]!.text).toBe(
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

  it('no_handoff_post: only an agent progress post after the last commit counts', async () => {
    const { handoffOf } = await import('./handoff')
    const codes = (over: Partial<HandoffFacts>) => handoffOf(facts(over)).missing.map((m) => m.code)
    const post = (author: string, createdAt: string, extra: Partial<HandoffFacts['posts'][number]> = {}) => ({
      author,
      progress: true,
      handoff: false,
      createdAt,
      ...extra,
    })
    expect(codes({ posts: [] })).toEqual(['no_handoff_post'])
    // Before the last commit.
    expect(codes({ posts: [post('claude', '2026-01-10T11:00:00.000Z')] })).toEqual(['no_handoff_post'])
    // The human's, a discussion post, a resume note.
    expect(codes({ posts: [post('enrique', '2026-01-10T13:00:00.000Z')] })).toEqual(['no_handoff_post'])
    expect(codes({ posts: [post('claude', '2026-01-10T13:00:00.000Z', { progress: false })] })).toEqual([
      'no_handoff_post',
    ])
    expect(codes({ posts: [post('claude', '2026-01-10T13:00:00.000Z', { handoff: true })] })).toEqual([
      'no_handoff_post',
    ])
    // Without a branch, since work started.
    const noBranch = { branch: '', lastCommitAt: null, push: { state: 'none' as const, ahead: 0 } }
    const before = handoffOf(facts({ ...noBranch, posts: [post('claude', '2026-01-09T08:00:00.000Z')] }))
    expect(before.missing.map((m) => m.code)).toContain('no_handoff_post')
    expect(before.missing.find((m) => m.code === 'no_handoff_post')!.text).toBe(
      'No progress post since work started',
    )
    const after = handoffOf(facts({ ...noBranch, posts: [post('claude', '2026-01-09T10:00:00.000Z')] }))
    expect(after.missing.map((m) => m.code)).not.toContain('no_handoff_post')
  })

  it('checks_unknown: only when CI is failing or still running', async () => {
    const { handoffOf } = await import('./handoff')
    const ci = (state: 'passing' | 'failing' | 'pending' | 'none' | null) =>
      handoffOf(facts({ pr: { number: 7, ci: state } }))
    expect(ci('failing').missing).toEqual([{ code: 'checks_unknown', text: "The PR's CI is failing" }])
    expect(ci('pending').missing).toEqual([{ code: 'checks_unknown', text: "The PR's CI is still running" }])
    expect(ci('passing').missing).toEqual([])
    // No checks, or the PR is not in the queue: nothing to say, and no CI row.
    for (const state of ['none', null] as const) {
      expect(ci(state).missing).toEqual([])
      expect(ci(state).checks.map((c) => c.code)).not.toContain('checks_unknown')
    }
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
    db.insert(schema.repos).values({ projectId, name: 'repo', repoPath: repo, baseBranch: 'main' }).run()
    noteActor('enrique', 'human')
    const t = features.createTicket(
      projectId,
      { title: 't', branch: 'feat/handoff', status: 'in_progress' },
      'claude',
    )
    const codes = (h: { missing: { code: string }[] } | null | undefined) => h?.missing.map((m) => m.code)

    // Not a review stage: no hand-off.
    const moved = await needs.changeTicket(t.id, { title: 'renamed' }, 'claude', { agent: true })
    expect('handoff' in moved).toBe(false)
    expect((await needs.ticketView(t.id)).handoff).toBeNull()

    const first = await needs.changeTicket(t.id, { status: 'review' }, 'claude', { agent: true })
    expect('handoff' in first && codes(first.handoff)).toEqual([
      'no_pr',
      'not_pushed',
      'no_preview',
      'no_handoff_post',
    ])
    // Not blocked: it is in review.
    expect(first.status).toBe('review')

    // The human's post does not count; the agent's does. Then the branch is pushed, a PR set, and a
    // preview that answers registered.
    features.postUpdate(t.id, 'looks fine?', [], 'enrique')
    features.postUpdate(t.id, 'PR #12, preview at …', [], 'claude')
    git('push', '-q', 'origin', 'feat/handoff')
    await fetchRepo(repo, { force: true })
    features.addWorkspace(t.id, { name: 'wt', branch: 'feat/handoff', previewUrl }, 'claude')
    const view = await needs.ticketView(t.id)
    expect(codes(view.handoff)).toEqual(['no_pr'])
    expect(view.handoff!.checks.find((c) => c.code === 'no_preview')).toMatchObject({
      ok: true,
      text: `Running at ${previewUrl}`,
    })

    const again = await needs.changeTicket(t.id, { status: 'review', prNumber: 12 }, 'claude', {
      agent: true,
    })
    expect('handoff' in again && again.handoff.missing).toEqual([])
  }, 30_000)
})
