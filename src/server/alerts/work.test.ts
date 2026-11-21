import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

import type { AlertCandidate, AlertContext, AlertType } from './registry'

// The alerts live in SQLite: point the db at a throwaway directory before anything loads it.
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-work-alerts-')))
process.env.DATA_DIR = path.join(tmp, 'data')
process.env.BOARD_ENV = 'test'

const HOUR = 60 * 60_000
const DAY = 24 * HOUR
const MIN = 60_000

let db: typeof import('#/db').db
let schema: typeof import('#/db').schema
let projects: typeof import('../projects')
let features: typeof import('../features')
let workTimeline: typeof import('../workTimeline')
let actions: typeof import('./actions')
let evaluate: typeof import('./evaluate')
let work: typeof import('./work')
let push: typeof import('../push')
let prs: typeof import('../prs')
let actors: typeof import('../actors')

beforeAll(async () => {
  ;({ db, schema } = await import('#/db'))
  projects = await import('../projects')
  features = await import('../features')
  workTimeline = await import('../workTimeline')
  actions = await import('./actions')
  evaluate = await import('./evaluate')
  work = await import('./work')
  push = await import('../push')
  prs = await import('../prs')
  actors = await import('../actors')
}, 60_000)

let count = 0
/** A project with one repo, as a ticket needs. */
function newProject() {
  const id = projects.createProject({ name: `work ${++count}` }, 'human').id
  db.insert(schema.repos)
    .values({ projectId: id, name: 'app', repoPath: `/r/app-${id}`, baseBranch: 'main' })
    .run()
  return id
}

/** The check's context, the clock `offset` after now. */
function ctxOf(projectId: number, offset = 0): AlertContext {
  const at = Date.now() + offset
  return {
    projectId,
    now: () => at,
    projects: { list: () => projects.listProjects(), get: (id) => projects.getProject(id) },
  }
}

const typeOf = (id: string): AlertType => {
  const found = work.alertTypes.find((t) => t.type === id)
  if (!found) throw new Error(`no work alert type ${id}`)
  return found
}
const check = async (type: string, projectId: number, offset = 0): Promise<AlertCandidate[]> =>
  typeOf(type).check(ctxOf(projectId, offset))

const ticket = (projectId: number, over: Partial<Parameters<typeof features.createTicket>[1]> = {}) =>
  features.createTicket(projectId, { title: `Ticket ${++count}`, status: 'in_progress', ...over }, 'claude')

/** The project's repo, or a new one at `repoPath` (a ticket then names it). */
const repoOf = (projectId: number, repoPath?: string) =>
  repoPath
    ? db
        .insert(schema.repos)
        .values({ projectId, name: 'other', repoPath, baseBranch: 'main' })
        .returning()
        .get()
    : db.select().from(schema.repos).where(eq(schema.repos.projectId, projectId)).get()!

let prNumbers = 100
/** A PR of the queue as the last refresh stored it: open, clean and green unless `over` says otherwise. */
function prRow(projectId: number, repoId: number, over: Partial<typeof schema.prs.$inferInsert> = {}) {
  const number = ++prNumbers
  const at = new Date().toISOString()
  return db
    .insert(schema.prs)
    .values({
      projectId,
      repoId,
      number,
      title: `Change ${number}`,
      url: `https://example.test/pull/${number}`,
      author: 'sam',
      headRef: `branch-${number}`,
      baseRef: 'main',
      headSha: 'abc123',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      checks: [{ name: 'ci', state: 'pass', url: null }],
      updatedAt: at,
      fetchedAt: at,
      ...over,
    })
    .returning()
    .get()
}

/** A ticket whose PR is `number` in the project's repo. */
const withPr = (projectId: number, repoId: number, number: number, status: string) =>
  ticket(projectId, { status, repoId, branch: `branch-${number}`, prNumber: number })

/** Runs the type through the evaluator, then presses a button of the alert it raised, as the human. */
async function press(type: string, projectId: number, buttonId: string, offset = 0) {
  const now = () => Date.now() + offset
  const out = await evaluate.evaluateAlerts({ projectId, type, now })
  const started = out.started[0]
  if (!started) throw new Error(`${type} raised nothing`)
  return actions.runAlertAction({ agent: false }, started.id, buttonId, now)
}

const ids = (found: AlertCandidate[]) => found.map((c) => c.subject)

describe('the work alert types', () => {
  it('registers each idea once, in the work group, per project', () => {
    expect(work.alertTypes.map((t) => t.idea).sort((a, b) => a - b)).toEqual([
      6, 7, 8, 9, 24, 25, 26, 27, 28, 29, 33,
    ])
    expect(new Set(work.alertTypes.map((t) => t.type)).size).toBe(work.alertTypes.length)
    for (const t of work.alertTypes) {
      expect(t.group).toBe('work')
      expect(t.scope).toBe('project')
    }
  })
})

describe('6: a decision waiting', () => {
  it('is raised for a card unanswered past the wait, and not before or once answered', async () => {
    const pid = newProject()
    const t = ticket(pid)
    const post = features.askDecision(
      t.id,
      { body: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }], block: false },
      'claude',
    )
    expect(await check('decision-waiting', pid, 1 * HOUR)).toEqual([])
    const found = await check('decision-waiting', pid, work.DECISION_WAIT_HOURS * HOUR + MIN)
    expect(found).toMatchObject([
      {
        subject: String(post.id),
        severity: 'warning',
        title: expect.stringContaining(`#${t.id} ${t.title}`),
        body: 'Which database?',
        buttons: [{ kind: 'link', href: `/projects/${pid}/features/${t.id}` }],
      },
    ])
    features.decide(post.id, 0, '', 'enrique')
    expect(await check('decision-waiting', pid, 2 * work.DECISION_WAIT_HOURS * HOUR)).toEqual([])
  })

  it('leaves an archive request to its own alert', async () => {
    const pid = newProject()
    const done = ticket(pid, { status: 'done' })
    features.requestArchive([done.id], {}, 'claude')
    expect(await check('decision-waiting', pid, 3 * DAY)).toEqual([])
  })
})

describe('7: a ticket stalled', () => {
  it('is raised for an active ticket silent past the stall time, not before', async () => {
    const pid = newProject()
    const t = ticket(pid)
    expect(await check('ticket-stalled', pid, 5 * MIN)).toEqual([])
    const found = await check('ticket-stalled', pid, 90 * MIN)
    expect(found).toMatchObject([
      { subject: String(t.id), severity: 'warning', title: `#${t.id} ${t.title} is stalled` },
    ])
  })

  it('is raised as lost contact when the agent died with a step open, and not while its lease is live', async () => {
    const pid = newProject()
    const t = ticket(pid)
    workTimeline.startSpan(pid, t.id, { phase: 'build', agent: 'builder' }, 'claude')
    expect(await check('ticket-stalled', pid, 2 * MIN)).toEqual([])
    const found = await check('ticket-stalled', pid, 40 * MIN)
    expect(found).toMatchObject([
      {
        subject: String(t.id),
        severity: 'problem',
        title: expect.stringContaining('Lost contact'),
        details: [expect.stringContaining('build')],
      },
    ])
  })

  it('is not raised for a ticket in review', async () => {
    const pid = newProject()
    ticket(pid, { status: 'review' })
    expect(await check('ticket-stalled', pid, 5 * HOUR)).toEqual([])
  })
})

describe('8: approved but not merged', () => {
  it('is raised when the PR of an Approved ticket conflicts or fails, and not when it can merge', async () => {
    const pid = newProject()
    const repo = repoOf(pid)
    const conflicting = prRow(pid, repo.id, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })
    const failing = prRow(pid, repo.id, { checks: [{ name: 'unit', state: 'fail', url: null }] })
    const fine = prRow(pid, repo.id)
    const a = withPr(pid, repo.id, conflicting.number, 'approved')
    const b = withPr(pid, repo.id, failing.number, 'approved')
    withPr(pid, repo.id, fine.number, 'approved')
    const found = await check('approved-not-merged', pid)
    expect(ids(found).sort()).toEqual([String(a.id), String(b.id)].sort())
    expect(found.every((c) => c.severity === 'problem')).toBe(true)
    expect(found.find((c) => c.subject === String(b.id))!.details).toEqual(['Failed check: unit'])
  })

  it('is not raised for a ticket still in review with a conflicting PR', async () => {
    const pid = newProject()
    const repo = repoOf(pid)
    const pr = prRow(pid, repo.id, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })
    withPr(pid, repo.id, pr.number, 'review')
    expect(await check('approved-not-merged', pid)).toEqual([])
  })
})

describe('9: PR checks failed, behind or conflicting', () => {
  it('is raised for each trouble of a ticket in review, and not for a clean PR or an Approved ticket', async () => {
    const pid = newProject()
    const repo = repoOf(pid)
    const failing = prRow(pid, repo.id, { checks: [{ name: 'e2e', state: 'fail', url: null }] })
    const behind = prRow(pid, repo.id, { mergeStateStatus: 'BEHIND' })
    const conflicts = prRow(pid, repo.id, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })
    const clean = prRow(pid, repo.id)
    const approved = prRow(pid, repo.id, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })
    const f = withPr(pid, repo.id, failing.number, 'review')
    const b = withPr(pid, repo.id, behind.number, 'review')
    const c = withPr(pid, repo.id, conflicts.number, 'review')
    withPr(pid, repo.id, clean.number, 'review')
    withPr(pid, repo.id, approved.number, 'approved')
    const found = await check('pr-checks-failed', pid)
    const by = (id: number) => found.find((x) => x.subject === String(id))!
    expect(found).toHaveLength(3)
    expect(by(f.id)).toMatchObject({ severity: 'problem', details: ['Failed check: e2e'] })
    expect(by(f.id).body).toContain('its checks failed')
    expect(by(b.id)).toMatchObject({ severity: 'warning' })
    expect(by(b.id).body).toContain('behind')
    expect(by(c.id)).toMatchObject({ severity: 'problem' })
    expect(by(c.id).body).toContain('conflicts')
  })

  it('stops when the PR is fixed', async () => {
    const pid = newProject()
    const repo = repoOf(pid)
    const pr = prRow(pid, repo.id, { checks: [{ name: 'e2e', state: 'fail', url: null }] })
    withPr(pid, repo.id, pr.number, 'review')
    expect(await check('pr-checks-failed', pid)).toHaveLength(1)
    db.update(schema.prs)
      .set({ checks: [{ name: 'e2e', state: 'pass', url: null }] })
      .where(eq(schema.prs.id, pr.id))
      .run()
    expect(await check('pr-checks-failed', pid)).toEqual([])
  })
})

describe('24: a task waits on you', () => {
  it('is raised once the task has been blocked past the wait, and not before or once cleared', async () => {
    const pid = newProject()
    const t = ticket(pid, { tasks: ['Write the code'] })
    const [task] = features.getTicketFull(t.id).tasks
    features.updateTask(task!.id, { blocked: true, blockedReason: 'Paste the API key' }, 'claude')
    expect(await check('task-waits-on-you', pid, 1 * HOUR)).toEqual([])
    const found = await check('task-waits-on-you', pid, work.BLOCKED_TASK_HOURS * HOUR + 5 * MIN)
    expect(found).toMatchObject([
      {
        subject: String(task!.id),
        severity: 'warning',
        title: expect.stringContaining(`#${t.id} ${t.title} is blocked on you`),
        body: 'Paste the API key',
        buttons: [{ kind: 'link', label: 'Open the ticket', href: `/projects/${pid}/features/${t.id}` }],
      },
    ])
    expect(typeOf('task-waits-on-you').snoozeOptions).toContain(DAY)
    features.updateTask(task!.id, { blocked: false }, 'claude')
    expect(await check('task-waits-on-you', pid, 2 * DAY)).toEqual([])
  })

  it('counts a task a later step waits behind as not blocking, as Needs you does', async () => {
    const pid = newProject()
    const t = ticket(pid, { tasks: ['First', 'Second'] })
    const tasks = features.getTicketFull(t.id).tasks
    features.updateTask(tasks[1]!.id, { blocked: true, blockedReason: 'Later' }, 'claude')
    expect(await check('task-waits-on-you', pid, 2 * DAY)).toEqual([])
  })
})

describe('25: ready for you', () => {
  it('is raised for a green PR in review with no verdict past the wait, a warning after a week', async () => {
    const pid = newProject()
    const repo = repoOf(pid)
    const pr = prRow(pid, repo.id)
    const t = withPr(pid, repo.id, pr.number, 'review')
    expect(await check('ready-for-you', pid, 1 * DAY)).toEqual([])
    expect(await check('ready-for-you', pid, work.READY_WAIT_DAYS * DAY + HOUR)).toMatchObject([
      { subject: String(t.id), severity: 'info', buttons: [{ label: 'Open the PR page' }] },
    ])
    expect(await check('ready-for-you', pid, work.READY_WARNING_DAYS * DAY + HOUR)).toMatchObject([
      { subject: String(t.id), severity: 'warning' },
    ])
  })

  it('is not raised when checks fail, the branch is behind, the PR is a draft or the human gave a verdict', async () => {
    const pid = newProject()
    const repo = repoOf(pid)
    for (const over of [
      { checks: [{ name: 'ci', state: 'fail' as const, url: null }] },
      { mergeStateStatus: 'BEHIND' },
      { isDraft: true },
    ]) {
      const pr = prRow(pid, repo.id, over)
      withPr(pid, repo.id, pr.number, 'review')
    }
    const verdict = prRow(pid, repo.id)
    const approved = withPr(pid, repo.id, verdict.number, 'review')
    features.setVerdict(approved.id, 'approved', 'enrique')
    expect(await check('ready-for-you', pid, 10 * DAY)).toEqual([])
  })
})

describe('26: an agent asked to archive a ticket', () => {
  it('is raised for an open request; Archive archives the ticket as the human would', async () => {
    const pid = newProject()
    const done = ticket(pid, { status: 'done' })
    const post = features.requestArchive([done.id], {}, 'claude')
    const found = await check('archive-requested', pid)
    expect(found).toMatchObject([
      {
        subject: String(post.id),
        severity: 'info',
        title: `claude asks to archive #${done.id} ${done.title}`,
        buttons: [
          { id: 'archive', kind: 'action', label: 'Archive' },
          { id: 'keep', kind: 'action', label: 'Keep it' },
          { kind: 'link', href: `/projects/${pid}/features/${done.id}` },
        ],
      },
    ])

    const result = await press('archive-requested', pid, 'archive')
    expect(result).toMatchObject({ ok: true, resolved: true })
    expect(features.getTicket(done.id).archivedAt).not.toBeNull()
    expect(features.getPost(post.id)).toMatchObject({ decidedOption: 0 })
    expect(await check('archive-requested', pid)).toEqual([])
  })

  it('Keep it declines the request and leaves the ticket where it is', async () => {
    const pid = newProject()
    const done = ticket(pid, { status: 'done' })
    const post = features.requestArchive([done.id], {}, 'claude')
    const result = await press('archive-requested', pid, 'keep')
    expect(result).toMatchObject({ ok: true, resolved: true })
    expect(features.getTicket(done.id).archivedAt).toBeNull()
    expect(features.getPost(post.id)).toMatchObject({ decidedOption: 1 })
    expect(await check('archive-requested', pid)).toEqual([])
  })

  it('is not raised once the tickets are archived by the human meanwhile', async () => {
    const pid = newProject()
    const done = ticket(pid, { status: 'done' })
    features.requestArchive([done.id], {}, 'claude')
    features.archiveTicket(done.id, 'enrique')
    expect(await check('archive-requested', pid)).toEqual([])
  })
})

describe('27: the Needs-you digest', () => {
  // Wednesday 18 November 2026: a workday; the project's shift starts at 09:00 local.
  const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 0).getTime() - Date.now()

  function waiting(pid: number, decisions: number, blocked = 0) {
    const t = ticket(pid, { tasks: Array.from({ length: blocked }, (_, i) => `Step ${i}`) })
    for (let i = 0; i < decisions; i++)
      features.askDecision(
        t.id,
        { body: `Question ${i}`, options: [{ label: 'Yes' }, { label: 'No' }], block: false },
        'claude',
      )
    return t
  }

  it('is one card once the workday has started, counting what waits', async () => {
    const pid = newProject()
    const t = waiting(pid, 2, 1)
    const [task] = features.getTicketFull(t.id).tasks
    features.updateTask(task!.id, { blocked: true, blockedReason: 'Sign the form' }, 'claude')
    const done = ticket(pid, { status: 'done' })
    features.requestArchive([done.id], {}, 'claude')

    const found = await check('needs-you-digest', pid, at(18, 10))
    expect(found).toMatchObject([
      {
        subject: '2026-11-18',
        severity: 'info',
        title: 'Waiting on you: 2 decisions, 1 archive request, 1 blocked task',
        buttons: [{ kind: 'link', label: 'Open Needs you', href: `/projects/${pid}` }],
      },
    ])
    // The same card all day; tomorrow another one.
    expect(ids(await check('needs-you-digest', pid, at(18, 16)))).toEqual(['2026-11-18'])
    expect(ids(await check('needs-you-digest', pid, at(19, 10)))).toEqual(['2026-11-19'])
  })

  it('waits for the workday: not before the shift, not on a weekend, and not with nothing waiting', async () => {
    const pid = newProject()
    waiting(pid, 2)
    expect(await check('needs-you-digest', pid, at(18, 7))).toEqual([])
    expect(await check('needs-you-digest', pid, at(21, 10))).toEqual([])
    expect(await check('needs-you-digest', pid, at(18, 10))).toHaveLength(1)
    expect(await check('needs-you-digest', newProject(), at(18, 10))).toEqual([])
  })

  it('comes early when the list is longer than the limit', async () => {
    const pid = newProject()
    waiting(pid, work.DIGEST_ITEMS)
    expect(await check('needs-you-digest', pid, at(21, 7))).toEqual([])
    waiting(pid, 1)
    const found = await check('needs-you-digest', pid, at(21, 7))
    expect(found).toMatchObject([{ title: `Waiting on you: ${work.DIGEST_ITEMS + 1} decisions` }])
  })
})

describe('28: a PR waiting on you in the PR queue', () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

  it('is raised when a PR waits on the human and nothing happened for the wait, and not otherwise', async () => {
    const pid = newProject()
    const repo = repoOf(pid)
    const quiet = prRow(pid, repo.id, { updatedAt: ago(work.PR_WAIT_HOURS * HOUR + 10 * MIN) })
    prRow(pid, repo.id, { updatedAt: ago(1 * HOUR) })
    prRow(pid, repo.id, { updatedAt: ago(10 * HOUR), waitingOn: 'others' })
    prRow(pid, repo.id, { updatedAt: ago(10 * HOUR), isDraft: true })
    prRow(pid, repo.id, { updatedAt: ago(10 * HOUR), reviewStage: 'reviewed' })
    prRow(pid, repo.id, { updatedAt: ago(10 * HOUR), open: false })
    const found = await check('pr-waiting-on-you', pid)
    expect(found).toMatchObject([
      {
        subject: String(quiet.id),
        severity: 'info',
        title: `PR #${quiet.number} ${quiet.title} is waiting on you`,
        buttons: [{ kind: 'link', label: 'Open the PR review', href: `/projects/${pid}/prs` }],
      },
    ])
    // Not on hold: nothing to release.
    expect(found[0]!.buttons!.some((b) => b.kind === 'action')).toBe(false)
  })

  it('offers Release the hold on a held PR, and the button releases it', async () => {
    const pid = newProject()
    const repo = repoOf(pid)
    const held = prRow(pid, repo.id, {
      updatedAt: ago(9 * HOUR),
      hold: true,
      holdNote: 'Waiting on the schema change',
      reviewStage: 'on_hold',
    })
    const found = await check('pr-waiting-on-you', pid)
    expect(found[0]!.buttons).toContainEqual({
      id: 'release',
      label: 'Release the hold',
      kind: 'action',
      primary: true,
    })
    expect(found[0]!.details).toContain('Hold: Waiting on the schema change')

    const result = await press('pr-waiting-on-you', pid, 'release')
    expect(result).toMatchObject({ ok: true, resolved: true })
    expect(prs.getPr(held.id).hold).toBe(false)
  })
})

describe('29: no agent has called in while work waits', () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

  // The first of these runs before any agent signs in: the board has never heard from one.
  it('is raised when tickets wait in To do and no agent ever called in, and not with nothing waiting', async () => {
    const empty = newProject()
    expect(await check('no-agent-calling', empty)).toEqual([])
    const pid = newProject()
    ticket(pid, { status: 'todo' })
    expect(await check('no-agent-calling', pid)).toMatchObject([
      {
        severity: 'info',
        title: 'No agent has contacted the board yet',
        buttons: [{ kind: 'link', label: 'Open Connect an agent', href: '/agents' }],
      },
    ])
  })

  it('goes by the last call of any agent and the wait', async () => {
    const pid = newProject()
    ticket(pid, { status: 'todo' })
    ticket(pid, { status: 'todo' })
    ticket(pid, { status: 'in_progress' })
    db.insert(schema.actors)
      .values({ name: 'builder-a', kind: 'agent', lastSeenAt: ago(work.NO_AGENT_HOURS * HOUR + 30 * MIN) })
      .onConflictDoUpdate({
        target: schema.actors.name,
        set: { lastSeenAt: ago(work.NO_AGENT_HOURS * HOUR + 30 * MIN) },
      })
      .run()
    const found = await check('no-agent-calling', pid)
    expect(found).toHaveLength(1)
    expect(found[0]!.title).toBe('No agent has contacted the board for 7 hours')
    expect(found[0]!.body).toContain('2 tickets are in To do')
    expect(typeOf('no-agent-calling').snoozeOptions).toContain(4 * HOUR)

    // The agent calls in again (every request notes its caller).
    actors.noteActor('builder-b', 'agent')
    expect(await check('no-agent-calling', pid)).toEqual([])
  })
})

describe('33: work only on this machine', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

  /** A bare origin and a checkout of it, with `main` pushed. */
  function checkout() {
    const dir = fs.mkdtempSync(path.join(tmp, 'git-'))
    const origin = path.join(dir, 'origin.git')
    const repo = path.join(dir, 'repo')
    fs.mkdirSync(origin)
    git(origin, 'init', '-q', '--bare', '-b', 'main')
    fs.mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 't@t')
    git(repo, 'config', 'user.name', 't')
    git(repo, 'remote', 'add', 'origin', origin)
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'base')
    git(repo, 'push', '-q', 'origin', 'main')
    return repo
  }

  function branchWithCommit(repo: string, branch: string) {
    git(repo, 'checkout', '-q', '-b', branch, 'main')
    fs.writeFileSync(path.join(repo, `${branch.replace('/', '-')}.txt`), 'work\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', `work on ${branch}`)
    git(repo, 'checkout', '-q', 'main')
  }

  it('is raised once a branch in review has been only here for the wait, and stops when it is pushed', async () => {
    const repoPath = checkout()
    branchWithCommit(repoPath, 'feat/local')
    const pid = newProject()
    const repo = repoOf(pid, repoPath)
    const t = ticket(pid, { status: 'review', repoId: repo.id, branch: 'feat/local', baseBranch: 'main' })

    // First seen unpushed now: the wait counts from here.
    expect(await check('work-only-here', pid)).toEqual([])
    push.dropListings(repoPath)
    expect(await check('work-only-here', pid, 1 * HOUR)).toEqual([])
    push.dropListings(repoPath)
    const found = await check('work-only-here', pid, work.UNPUSHED_HOURS * HOUR + 5 * MIN)
    expect(found).toMatchObject([
      {
        subject: String(t.id),
        severity: 'warning',
        title: `#${t.id} ${t.title} has 1 commit only on this machine`,
        buttons: [
          { kind: 'link', href: `/projects/${pid}/features/${t.id}` },
          { id: 'ask-push', kind: 'action', label: 'Ask the agent to push' },
        ],
      },
    ])

    git(repoPath, 'push', '-q', 'origin', 'feat/local')
    push.dropListings(repoPath)
    expect(await check('work-only-here', pid, 6 * HOUR)).toEqual([])
  })

  it('is not raised for a ticket still being worked, or one already pushed', async () => {
    const repoPath = checkout()
    branchWithCommit(repoPath, 'feat/active')
    branchWithCommit(repoPath, 'feat/pushed')
    git(repoPath, 'push', '-q', 'origin', 'feat/pushed')
    const pid = newProject()
    const repo = repoOf(pid, repoPath)
    ticket(pid, { status: 'in_progress', repoId: repo.id, branch: 'feat/active', baseBranch: 'main' })
    ticket(pid, { status: 'review', repoId: repo.id, branch: 'feat/pushed', baseBranch: 'main' })
    expect(await check('work-only-here', pid)).toEqual([])
    push.dropListings(repoPath)
    expect(await check('work-only-here', pid, 10 * HOUR)).toEqual([])
  })

  it('Ask the agent to push posts a message on the ticket as the human', async () => {
    const repoPath = checkout()
    branchWithCommit(repoPath, 'feat/ask')
    const pid = newProject()
    const repo = repoOf(pid, repoPath)
    const t = ticket(pid, { status: 'blocked', repoId: repo.id, branch: 'feat/ask', baseBranch: 'main' })
    await evaluate.evaluateAlerts({ projectId: pid, type: 'work-only-here' })
    push.dropListings(repoPath)
    const later = 5 * HOUR
    const result = await press('work-only-here', pid, 'ask-push', later)
    expect(result).toMatchObject({ ok: true, resolved: false, message: 'Asked the agent to push' })
    const posts = db.select().from(schema.updates).where(eq(schema.updates.ticketId, t.id)).all()
    expect(posts).toHaveLength(1)
    expect(posts[0]!.body).toContain('feat/ask')
    expect(posts[0]!.body).toContain('push')
    expect(posts[0]!.progress).toBe(false)
    expect(posts[0]!.tab).toBe('main')
  })
})
