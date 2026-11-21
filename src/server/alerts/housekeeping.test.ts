import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

// The alerts live in SQLite: point the db at a throwaway directory before anything loads it. claude is
// the tests' stand-in (e2e/fake-claude.mjs): a marker in the project's report prompt picks its answer.
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-housekeeping-')))
process.env.DATA_DIR = path.join(tmp, 'data')
process.env.BOARD_ENV = 'test'
process.env.HOME = tmp
process.env.USERPROFILE = tmp
process.env.CLAUDE_HOME = path.join(tmp, 'claude')
process.env.CLAUDE_BIN = process.execPath
process.env.CLAUDE_ARGS = JSON.stringify([
  fileURLToPath(new URL('../../../e2e/fake-claude.mjs', import.meta.url)),
])

let dbm: typeof import('#/db')
let features: typeof import('../features')
let reports: typeof import('../reports')
let gen: typeof import('../reportGenerate')
let due: typeof import('../reportDue')
let evaluate: typeof import('./evaluate')
let actions: typeof import('./actions')
let housekeeping: typeof import('./housekeeping')
let feed: typeof import('./feed')
beforeAll(async () => {
  dbm = await import('#/db')
  features = await import('../features')
  reports = await import('../reports')
  gen = await import('../reportGenerate')
  due = await import('../reportDue')
  evaluate = await import('./evaluate')
  actions = await import('./actions')
  housekeeping = await import('./housekeeping')
  feed = await import('./feed')
}, 60_000)

const at = (day: string, time = '12:00') => new Date(`${day}T${time}:00`)
let count = 0
const newProject = (label: string) =>
  dbm.db
    .insert(dbm.schema.projects)
    .values({ name: `${label} ${++count}` })
    .returning()
    .get().id
const ctxOf = (projectId: number, now: Date) => ({
  projectId,
  now: () => now.getTime(),
  projects: { list: () => [], get: () => undefined },
})
const HUMAN = { agent: false }

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** A project with a real repo (branch dev with one commit) on disk. */
function projectWithRepo(label: string) {
  const projectId = newProject(label)
  const repo = path.join(tmp, `repo-${count}`)
  fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'dev')
  git(repo, 'config', 'user.email', 't@t')
  git(repo, 'config', 'user.name', 't')
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n')
  git(repo, 'add', 'base.txt')
  git(repo, 'commit', '-q', '-m', 'base')
  dbm.db.insert(dbm.schema.repos).values({ projectId, name: 'repo', repoPath: repo, baseBranch: 'dev' }).run()
  return { projectId, repo }
}

describe('cleanup ready (14)', () => {
  it('is raised while a finished ticket left a branch and a worktree, and not for one still in work', async () => {
    const { projectId, repo } = projectWithRepo('cleanup')
    git(repo, 'branch', 'feat/done', 'dev')
    git(repo, 'branch', 'feat/open', 'dev')
    const tree = path.join(tmp, `wt-${count}`)
    git(repo, 'worktree', 'add', '-q', '-b', 'feat/tree', tree, 'dev')
    features.createTicket(
      projectId,
      { title: 'open one', branch: 'feat/open', status: 'in_progress' },
      'claude',
    )
    const now = at('2026-10-06')

    // Only a ticket in work holds a branch: nothing to clean.
    expect(await housekeeping.checkCleanup(ctxOf(projectId, now))).toEqual([])

    const done = features.createTicket(
      projectId,
      { title: 'done one', branch: 'feat/done', status: 'done' },
      'claude',
    )
    const closed = features.createTicket(
      projectId,
      { title: 'cancelled one', branch: 'feat/tree', status: 'cancelled' },
      'claude',
    )
    features.addWorkspace(closed.id, { name: 'wt', branch: 'feat/tree', path: tree }, 'claude')
    expect(done.id).not.toBe(closed.id)

    // The cached count is kept for a few minutes, so this check answers without reading git again...
    expect(await housekeeping.checkCleanup(ctxOf(projectId, new Date(now.getTime() + 60_000)))).toEqual([])
    // ...and once it expired, it reads the repo and finds both.
    const later = new Date(now.getTime() + housekeeping.CLEANUP_CACHE_MS + 1)
    const [found] = await housekeeping.checkCleanup(ctxOf(projectId, later))
    expect(found).toMatchObject({
      severity: 'info',
      body: expect.stringContaining('2 branches, 1 worktree'),
      buttons: [{ id: 'open', label: 'Open Cleanup', kind: 'link', href: `/projects/${projectId}/cleanup` }],
    })
    expect(found!.subject).toBeUndefined()

    // Through the evaluator, with the snooze options the idea asks for.
    const out = await evaluate.evaluateAlerts({
      projectId,
      type: 'cleanup-ready',
      now: () => later.getTime(),
    })
    expect(out.started.map((a) => a.type)).toEqual(['cleanup-ready'])
    const item = feed.notificationFeed(projectId, {}, later.getTime()).find((i) => i.type === 'cleanup-ready')
    expect(item).toMatchObject({
      severity: 'info',
      group: 'housekeeping',
      snoozeOptions: [86_400_000, 604_800_000],
    })

    // Cleaned up: the branches and the worktree go, and once the count is read again the alert resolves.
    git(repo, 'worktree', 'remove', '--force', tree)
    git(repo, 'branch', '-D', 'feat/done', 'feat/tree')
    const resolved = await evaluate.evaluateAlerts({
      projectId,
      type: 'cleanup-ready',
      now: () => later.getTime() + housekeeping.CLEANUP_CACHE_MS + 1,
    })
    expect(resolved.resolved.map((a) => a.type)).toEqual(['cleanup-ready'])
  })

  it('is not raised in a project whose repo has nothing left by finished tickets', async () => {
    const { projectId } = projectWithRepo('tidy')
    features.createTicket(projectId, { title: 'done, no branch', status: 'done' }, 'claude')
    expect(await housekeeping.checkCleanup(ctxOf(projectId, at('2026-10-06')))).toEqual([])
  })
})

describe('report due (15)', () => {
  // Oct 5 2026 is a Monday; the shift ends at 17:00 and the reminder opens at 16:30.
  const dailyProject = () => {
    const p = newProject('due')
    reports.setReportSettings(p, { cadence: 'daily' }, 'me', {}, at('2026-10-01'))
    return p
  }

  it('says which period is due, agrees with the banner, and goes quiet once it is written', async () => {
    const p = dailyProject()
    expect(housekeeping.checkReportDue(ctxOf(p, at('2026-10-05', '16:00')))).toEqual([])

    const soon = at('2026-10-05', '16:40')
    const [candidate] = housekeeping.checkReportDue(ctxOf(p, soon))
    expect(candidate).toMatchObject({
      subject: 'daily:2026-10-05',
      severity: 'info',
      title: 'The daily report for Mon, Oct 5 is due soon',
      buttons: [{ id: 'open', label: 'Open Reports', kind: 'link', href: `/projects/${p}/daily` }],
    })
    expect(due.reportDueFor(p, soon)).toMatchObject({ period: '2026-10-05', state: 'due' })

    const [late] = housekeeping.checkReportDue(ctxOf(p, at('2026-10-05', '18:00')))
    expect(late!.title).toBe('The daily report for Mon, Oct 5 is missing')

    // Through the evaluator: it starts, and resolves when the report is posted.
    const out = await evaluate.evaluateAlerts({ projectId: p, type: 'report-due', now: () => soon.getTime() })
    expect(out.started).toHaveLength(1)
    await reports.postReport(p, { period: '2026-10-05', body: 'Done: things' }, 'me', soon)
    expect(housekeeping.checkReportDue(ctxOf(p, soon))).toEqual([])
    const after = await evaluate.evaluateAlerts({
      projectId: p,
      type: 'report-due',
      now: () => soon.getTime(),
    })
    expect(after.resolved).toHaveLength(1)
  })

  it('is not raised when reports are off or the day is not a workday', () => {
    const off = newProject('off')
    expect(housekeeping.checkReportDue(ctxOf(off, at('2026-10-05', '16:40')))).toEqual([])
    // Saturday, Oct 10
    expect(housekeeping.checkReportDue(ctxOf(dailyProject(), at('2026-10-10', '16:40')))).toEqual([])
  })

  it('names a weekly report by its week', () => {
    const p = newProject('weekly due')
    reports.setReportSettings(p, { cadence: 'weekly', weekday: 5 }, 'me', {}, at('2026-10-01'))
    // The Friday of the week of Oct 5, after the shift ended.
    const [c] = housekeeping.checkReportDue(ctxOf(p, at('2026-10-09', '18:00')))
    expect(c).toMatchObject({ subject: 'weekly:2026-10-05', severity: 'info' })
    expect(c!.title).toMatch(/^The weekly report for the week of Oct 5 is /)
  })
})

describe('report generation failed (35)', () => {
  let logs = 0
  /** A weekly project whose claude stand-in answers as `mode`, with activity in the week of Oct 5. */
  function weekly(mode: string) {
    const p = newProject('failed')
    const now = at('2026-10-07', '15:00')
    reports.setReportSettings(
      p,
      {
        cadence: 'weekly',
        prompt: `Bullets.\n[fake-claude-log: ${path.join(tmp, `c-${++logs}.jsonl`)}]\n[fake-claude: ${mode}]`,
      },
      'me',
      {},
      now,
    )
    dbm.db
      .insert(dbm.schema.activity)
      .values({
        projectId: p,
        actor: 'me',
        kind: 'ticket',
        text: 'did a thing',
        createdAt: at('2026-10-06', '10:00').toISOString(),
      })
      .run()
    return { p, now }
  }
  const alertRow = (p: number) =>
    dbm.db
      .select()
      .from(dbm.schema.alerts)
      .where(and(eq(dbm.schema.alerts.projectId, p), eq(dbm.schema.alerts.type, 'report-generation-failed')))
      .get()

  it('is raised with the reason after a failed run, and the opposite holds before it and after a success', async () => {
    const { p, now } = weekly('fail')
    expect(housekeeping.checkReportFailed(ctxOf(p, now))).toEqual([])

    await expect(gen.generateReport(p, {}, now)).rejects.toMatchObject({ status: 502 })
    const [c] = housekeeping.checkReportFailed(ctxOf(p, now))
    expect(c).toMatchObject({
      subject: '2026-10-05',
      severity: 'warning',
      title: 'The weekly report for the week of Oct 5 could not be generated',
      body: expect.stringContaining('asked to fail'),
      buttons: [
        { id: 'retry', label: 'Try again', kind: 'action', primary: true },
        { id: 'write', label: 'Write it by hand', kind: 'link', href: `/projects/${p}/daily` },
        { id: 'open', label: 'Open Reports', kind: 'link', href: `/projects/${p}/daily` },
      ],
    })
    expect(c!.body).toMatch(
      /^The weekly report for the week of Oct 5 could not be generated: claude exited with 3/,
    )
  })

  it('Try again runs the generation: the report is stored, the alert resolves and the check is empty', async () => {
    const { p, now } = weekly('fail')
    await expect(gen.generateReport(p, {}, now)).rejects.toBeDefined()
    const nowMs = () => now.getTime()
    await evaluate.evaluateAlerts({ projectId: p, type: 'report-generation-failed', now: nowMs })
    const row = alertRow(p)!
    expect(row.resolvedAt).toBeNull()

    // Still failing: the answer says why, and the alert stays.
    const again = await actions.runAlertAction(HUMAN, row.id, 'retry', nowMs)
    expect(again).toMatchObject({
      ok: true,
      resolved: false,
      message: expect.stringContaining('claude exited with 3'),
    })
    expect(alertRow(p)!.resolvedAt).toBeNull()

    // claude works now: the same button writes the report.
    reports.setReportSettings(p, { prompt: 'Bullets.' }, 'me', {}, now)
    const ok = await actions.runAlertAction(HUMAN, row.id, 'retry', nowMs)
    expect(ok).toMatchObject({ ok: true, resolved: true, message: 'claude wrote the report' })
    expect(reports.reportVersions(p, '2026-10-05')).toHaveLength(1)
    expect(reports.reportVersions(p, '2026-10-05')[0]!.author).toBe('claude')
    expect(alertRow(p)!.resolvedAt).not.toBeNull()
    expect(housekeeping.checkReportFailed(ctxOf(p, now))).toEqual([])
  })

  it('resolves when the report for the period is written by hand', async () => {
    const { p, now } = weekly('fail')
    await expect(gen.generateReport(p, {}, now)).rejects.toBeDefined()
    expect(housekeeping.checkReportFailed(ctxOf(p, now))).toHaveLength(1)
    await reports.postReport(p, { period: '2026-10-05', body: 'Written by hand' }, 'me', now)
    expect(housekeeping.checkReportFailed(ctxOf(p, now))).toEqual([])
  })

  it('names claude missing as the reason', async () => {
    const { p, now } = weekly('good')
    const { config } = await import('../config')
    const was = config.claudeBin
    config.claudeBin = path.join(tmp, 'no-such-claude')
    try {
      await expect(gen.generateReport(p, {}, now)).rejects.toMatchObject({ status: 502 })
    } finally {
      config.claudeBin = was
    }
    const [c] = housekeeping.checkReportFailed(ctxOf(p, now))
    expect(c!.body).toMatch(/could not be generated: .*claude/i)
  })
})
