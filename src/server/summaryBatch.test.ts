import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp

let summary: typeof import('./summary')
let reference: typeof import('./summaryReference')
let stagesMod: typeof import('./stages')
let dbm: typeof import('#/db')

beforeAll(async () => {
  summary = await import('./summary')
  reference = await import('./summaryReference')
  stagesMod = await import('./stages')
  dbm = await import('#/db')
})

// Local times, so "today" is the same calendar day whatever the machine's time zone.
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute)
const iso = (d: Date) => d.toISOString()
const NOW = at(7, 15)
const HUMAN = 'enrique'

function project(name: string, opts: { stages?: boolean; repos?: string[] } = {}) {
  const { db, schema } = dbm
  const p = db.insert(schema.projects).values({ name }).returning().get()
  const repos = (opts.repos ?? ['api']).map(
    (repo) =>
      db
        .insert(schema.repos)
        .values({ projectId: p.id, name: repo, repoPath: `/r/${name}/${repo}` })
        .returning()
        .get().id,
  )
  if (opts.stages !== false) stagesMod.listStages(p.id)
  return { id: p.id, repos }
}

function ticket(
  projectId: number,
  title: string,
  values: Partial<typeof dbm.schema.tickets.$inferInsert> = {},
) {
  const { db, schema } = dbm
  return db
    .insert(schema.tickets)
    .values({
      projectId,
      title,
      status: 'todo',
      createdBy: HUMAN,
      createdAt: iso(at(1, 9)),
      updatedAt: iso(at(1, 9)),
      ...values,
    })
    .returning()
    .get()
}

/** A line of the ticket's log, worded as the board writes it. */
function log(projectId: number, ticketId: number, text: string, when: Date, kind = 'ticket') {
  dbm.db
    .insert(dbm.schema.activity)
    .values({
      projectId,
      actor: 'claude',
      kind,
      refType: 'ticket',
      refId: ticketId,
      text,
      createdAt: iso(when),
    })
    .run()
}

function post(
  ticketId: number,
  body: string,
  when: Date,
  values: Partial<typeof dbm.schema.updates.$inferInsert> = {},
) {
  return dbm.db
    .insert(dbm.schema.updates)
    .values({ ticketId, author: 'claude', body, progress: true, createdAt: iso(when), ...values })
    .returning()
    .get()
}

function reply(
  parentType: 'update' | 'pr' | 'review',
  parentId: number,
  author: string,
  body: string,
  when: Date,
) {
  dbm.db
    .insert(dbm.schema.comments)
    .values({ parentType, parentId, author, body, createdAt: iso(when) })
    .run()
}

function pr(
  projectId: number,
  repoId: number | null,
  number: number,
  values: Partial<typeof dbm.schema.prs.$inferInsert> = {},
) {
  return dbm.db
    .insert(dbm.schema.prs)
    .values({
      projectId,
      repoId,
      number,
      title: `PR ${number}`,
      url: `https://github.com/o/r/pull/${number}`,
      author: 'someone',
      headRef: `b${number}`,
      baseRef: 'main',
      headSha: 'abc1234',
      updatedAt: iso(at(7, 9)),
      fetchedAt: iso(at(7, 9)),
      ...values,
    })
    .returning()
    .get()
}

function task(ticketId: number, done: boolean) {
  dbm.db.insert(dbm.schema.tasks).values({ ticketId, text: 'a step', done }).run()
}

/** Old and new answer the same, byte for byte, for every project and each one, for these humans. */
function expectSame(opts: { humans?: string[] }) {
  for (const c of reference.summariesBothWays({ now: NOW, ...opts })) {
    expect(reference.firstDifference(c.reference, c.unindexed), `${c.label}, without the indexes`).toBeNull()
    expect(reference.firstDifference(c.reference, c.batched), `${c.label}, with the indexes`).toBeNull()
  }
}

describe('the batched summary answers as the per-project one did', () => {
  it('on an empty board', () => {
    expect(summary.getSummary(undefined, { now: NOW, humans: [HUMAN] }).projects).toEqual([])
    expectSame({ humans: [HUMAN] })
  })

  it('on a board with every case it reads', () => {
    const { db, schema } = dbm
    db.insert(schema.actors)
      .values([
        { name: HUMAN, kind: 'human', lastSeenAt: iso(at(7, 8)) },
        { name: 'phone', kind: 'human', lastSeenAt: iso(at(7, 9)) },
        { name: 'claude', kind: 'agent', lastSeenAt: iso(at(7, 9)) },
      ])
      .run()

    // Two projects inserted out of name order, so the all-projects block order is by name.
    const beta = project('Beta', { repos: ['web', 'api'] })
    const alpha = project('Alpha')
    project('Empty')

    // --- Alpha: the stages renamed and extended, a backlog-named open stage, agents ---
    db.insert(schema.stages)
      .values({ projectId: alpha.id, key: 'icebox', name: 'Icebox', kind: 'open', position: 20 })
      .run()
    db.insert(schema.agents)
      .values([
        { projectId: alpha.id, name: 'builder', createdBy: HUMAN },
        { projectId: alpha.id, name: 'Spec', createdBy: HUMAN },
      ])
      .run()

    // In progress, claimed yesterday, posted this morning; two lanes deep, the deepest one posts last
    // and runs a preview; a cancelled lane's tasks are left out of the rollup.
    const work = ticket(alpha.id, 'Work', {
      status: 'in_progress',
      assignee: 'Builder',
      updatedAt: iso(at(7, 9)),
    })
    log(alpha.id, work.id, `claimed ticket #${work.id} Work (status To do → In progress)`, at(6, 10))
    post(work.id, '**Done:**\n- wired the form', at(7, 9))
    task(work.id, true)
    task(work.id, false)
    const lane = ticket(alpha.id, 'Work lane', { status: 'in_progress', parentId: work.id })
    task(lane.id, true)
    const deep = ticket(alpha.id, 'Work lane lane', { status: 'review', parentId: lane.id })
    task(deep.id, false)
    post(deep.id, 'deep lane: tests pass', at(7, 14))
    db.insert(schema.workspaces)
      .values([
        { ticketId: deep.id, name: 'wt-deep', previewUrl: '' },
        { ticketId: deep.id, name: 'wt-deep-2', previewUrl: 'http://localhost:5175' },
        { ticketId: deep.id, name: 'wt-deep-3', previewUrl: 'http://localhost:5176' },
      ])
      .run()
    const cancelled = ticket(alpha.id, 'Dropped lane', { status: 'cancelled', parentId: work.id })
    task(cancelled.id, true)

    // Started from the log only, through a stage whose name the project no longer has.
    const renamed = ticket(alpha.id, 'Renamed', { status: 'in_progress', createdAt: iso(at(2, 9)) })
    log(
      alpha.id,
      renamed.id,
      `updated ticket #${renamed.id} Renamed (status Old name → In progress)`,
      at(3, 10),
    )
    log(alpha.id, renamed.id, `took over ticket #${renamed.id} Renamed`, at(4, 10))
    // Blocked, started three days ago from the log, last post two days ago: stale.
    const blocked = ticket(alpha.id, 'Blocked', { status: 'blocked' })
    log(alpha.id, blocked.id, `updated ticket #${blocked.id} Blocked (status To do → In progress)`, at(4, 10))
    log(
      alpha.id,
      blocked.id,
      `updated ticket #${blocked.id} Blocked (status In progress → Blocked)`,
      at(5, 10),
    )
    post(blocked.id, 'waiting on the API key', at(5, 12))
    // Two progress posts at the same moment: the later one is the last post.
    post(blocked.id, 'first of two', at(5, 12, 30))
    post(blocked.id, 'second of two', at(5, 12, 30))

    // Carried over with a note that holds, with no note, and with a note a later post made stale.
    const noted = ticket(alpha.id, 'Noted', {
      status: 'in_progress',
      startedAt: iso(at(5, 10)),
      resumeNote: '**State:** the form saves.\n\n1. Validate the [email](http://x) field',
      resumeAt: iso(at(6, 18)),
      resumeBy: 'claude',
    })
    log(alpha.id, noted.id, 'set a task done', at(6, 17), 'task')
    log(alpha.id, noted.id, 'left a resume note', at(6, 19), 'handoff')
    const bare = ticket(alpha.id, 'No note', { status: 'in_progress', startedAt: iso(at(4, 10)) })
    log(alpha.id, bare.id, 'set a task done', at(6, 15), 'task')
    post(bare.id, 'tests pass', at(6, 15))
    const moved = ticket(alpha.id, 'Moved on', {
      status: 'blocked',
      startedAt: iso(at(6, 9)),
      resumeNote: 'State: waiting on the key',
      resumeAt: iso(at(6, 18)),
      resumeBy: 'claude',
    })
    post(moved.id, 'got the key, resuming', at(7, 10))
    post(moved.id, 'handed off', at(7, 11), { handoff: true })
    // Started today.
    ticket(alpha.id, 'Today', { status: 'in_progress', startedAt: iso(at(7, 8)), updatedAt: iso(at(7, 8)) })

    // In review: waiting on the human, and approved (not waiting).
    const review = ticket(alpha.id, 'Review me', { status: 'review', prNumber: 7, startedAt: iso(at(3, 9)) })
    ticket(alpha.id, 'Approved', { status: 'review', approvedAt: iso(at(7, 9)), approvedBy: HUMAN })
    ticket(alpha.id, 'Approved lane', { status: 'review', parentId: review.id, approvedAt: iso(at(7, 9)) })

    // Done today through a move and through a verdict; done yesterday; reopened today.
    const shipped = ticket(alpha.id, 'Shipped', { status: 'done', prNumber: 12, repoId: alpha.repos[0] })
    log(alpha.id, shipped.id, `updated ticket #${shipped.id} Shipped (status In review → Done)`, at(7, 10))
    const verdict = ticket(alpha.id, 'Verdict', { status: 'done' })
    log(alpha.id, verdict.id, `approved ticket #${verdict.id} Verdict (Done)`, at(7, 10))
    const old = ticket(alpha.id, 'Old', { status: 'done' })
    log(alpha.id, old.id, `updated ticket #${old.id} Old (status In review → Done)`, at(6, 10))
    const reopened = ticket(alpha.id, 'Reopened', { status: 'in_progress', updatedAt: iso(at(7, 11)) })
    log(alpha.id, reopened.id, `updated ticket #${reopened.id} Reopened (status In review → Done)`, at(7, 9))
    log(
      alpha.id,
      reopened.id,
      `updated ticket #${reopened.id} Reopened (status Done → In progress)`,
      at(7, 11),
    )
    db.insert(schema.activity)
      .values({ projectId: alpha.id, actor: 'claude', kind: 'task', text: 'x', createdAt: iso(at(7, 8)) })
      .run()

    // Decisions: two open ones at the same moment, a decided one; a feed that ends on an open decision.
    const decide = ticket(alpha.id, 'Decide', { status: 'blocked', assignee: 'claude' })
    post(decide.id, 'Which cache?', at(7, 9), { progress: false, decision: [{ label: 'A' }, { label: 'B' }] })
    post(decide.id, 'Which queue?', at(7, 9), { progress: false, decision: [{ label: 'C' }] })
    post(decide.id, 'Which DB?', at(6, 9), {
      progress: false,
      decision: [{ label: 'D' }],
      decidedOption: 0,
      decidedBy: HUMAN,
      decidedAt: iso(at(6, 10)),
    })

    // Threads: a question on the human's ticket, answered ones, a reply on a post, PR and review threads.
    const asked = ticket(alpha.id, 'Asked', { status: 'todo', updatedAt: iso(at(7, 10)) })
    post(asked.id, 'Should the export include drafts?', at(7, 10), { progress: false })
    const answered = ticket(alpha.id, 'Answered', { status: 'todo', updatedAt: iso(at(7, 10)) })
    post(answered.id, 'Drafts too?', at(7, 8), { progress: false })
    post(answered.id, 'Yes', at(7, 9), { progress: false, author: 'phone' })
    const mine = post(work.id, 'Please look at the layout', at(7, 8), { progress: false, author: HUMAN })
    reply('update', mine.id, 'claude', 'Fixed it', at(7, 10))
    reply('update', mine.id, 'builder', 'Also the footer', at(7, 10))
    const open = pr(alpha.id, alpha.repos[0]!, 30, { author: HUMAN, waitingOn: 'others' })
    reply('pr', open.id, 'claude', 'Rebased', at(7, 11))
    const result = db
      .insert(schema.reviewResults)
      .values({ projectId: alpha.id, prNumber: 30, sha: 'abc', verdict: 'pass', author: HUMAN })
      .returning()
      .get()
    reply('review', result.id, HUMAN, 'Can you run it again?', at(7, 12))
    reply('review', result.id, 'claude', 'Ran it again: it passes', at(7, 13))

    // PRs: to review (two at the same moment, numbered against their insert order), held, others',
    // closed today and on another day.
    pr(alpha.id, alpha.repos[0]!, 21)
    pr(alpha.id, alpha.repos[0]!, 15)
    pr(alpha.id, alpha.repos[0]!, 16, { hold: true })
    pr(alpha.id, alpha.repos[0]!, 17, { waitingOn: 'others' })
    pr(alpha.id, alpha.repos[0]!, 18, { reviewStage: 'reviewed' })
    pr(alpha.id, alpha.repos[0]!, 12, { open: false, closedAt: iso(at(7, 13)), mergedAt: iso(at(7, 13)) })
    pr(alpha.id, alpha.repos[0]!, 11, { open: false, closedAt: iso(at(7, 13)) })
    pr(alpha.id, alpha.repos[0]!, 10, { open: false, closedAt: iso(at(6, 13)) })

    // Next: more than five in To do, some at the same moment; the backlog-named stages behind.
    for (let i = 1; i <= 7; i++)
      ticket(alpha.id, `todo ${i}`, { status: 'todo', tags: ['UI'], updatedAt: iso(at(1, 8 + (i % 3))) })
    ticket(alpha.id, 'someday', { status: 'backlog' })
    ticket(alpha.id, 'frozen', { status: 'icebox' })
    ticket(alpha.id, 'reserved', { status: 'todo', assignee: 'spec' })
    ticket(alpha.id, 'lost', { status: 'gone' })

    // Archived: a ticket with its lane, an open decision and a question on them, and work.
    const gone = { archivedAt: iso(at(7, 14)), archivedBy: HUMAN }
    const parent = ticket(alpha.id, 'Archived', { status: 'done', ...gone })
    log(alpha.id, parent.id, `updated ticket #${parent.id} Archived (status In review → Done)`, at(7, 10))
    const archivedLane = ticket(alpha.id, 'Archived lane', { status: 'review', parentId: parent.id, ...gone })
    post(archivedLane.id, 'Pick one', at(7, 9), { progress: false, decision: [{ label: 'A' }] })
    post(archivedLane.id, 'Anyone?', at(7, 10), { progress: false })
    ticket(alpha.id, 'Archived work', { status: 'in_progress', ...gone })

    // --- Beta: two repos; PR tickets by number and by branch, and one with no repo (the first) ---
    const [web, api] = beta.repos as [number, number]
    ticket(beta.id, 'By number', { status: 'done', repoId: api, prNumber: 40 })
    ticket(beta.id, 'By branch', { status: 'done', repoId: web, branch: 'b41' })
    // No repo: the project's first by name (api).
    ticket(beta.id, 'No repo', { status: 'done', prNumber: 42 })
    ticket(beta.id, 'Other repo', { status: 'done', repoId: web, prNumber: 42 })
    pr(beta.id, api, 40, { open: false, closedAt: iso(at(7, 10)) })
    pr(beta.id, web, 41, { open: false, closedAt: iso(at(7, 10)) })
    pr(beta.id, api, 42, { open: false, closedAt: iso(at(7, 11)) })
    pr(beta.id, web, 43, { author: 'someone' })
    ticket(beta.id, 'in beta', { status: 'in_progress', updatedAt: iso(at(7, 9)) })
    ticket(beta.id, 'tied a', { status: 'in_progress', updatedAt: iso(at(7, 9)) })

    expectSame({ humans: [HUMAN] })
    expectSame({ humans: [HUMAN, 'phone'] })
    expectSame({ humans: [] })
    // The humans the board has seen sign in.
    expectSame({})
    const s = summary.getSummary(alpha.id, { now: NOW, humans: [HUMAN] }).projects[0]!
    // The fixtures reach what they are for.
    expect(s.needsYou.decisions.map((d) => d.question)).toEqual(['Which cache?', 'Which queue?'])
    expect(s.needsYou.prs.map((p) => p.number)).toEqual([15, 21])
    expect(s.needsYou.threads.map((t) => t.parentType).sort()).toEqual([
      'pr',
      'review',
      'ticket',
      'ticket',
      'update',
    ])
    expect(s.inProgress.find((t) => t.id === work.id)).toMatchObject({
      lastPost: { ticketId: deep.id },
      preview: { workspace: 'wt-deep-2' },
      rollup: { done: 2, total: 4 },
    })
    expect(s.carryingOver.length).toBeGreaterThan(3)
    expect(s.doneToday.tickets.map((t) => t.id).sort()).toEqual([shipped.id, verdict.id].sort())
    expect(s.next.total).toBe(10)
    const b = summary.getSummary(beta.id, { now: NOW, humans: [HUMAN] }).projects[0]!
    expect(b.doneToday.prs.map((p) => [p.number, p.repo, p.tickets.map((t) => t.title)])).toEqual([
      [42, 'api', ['No repo']],
      [40, 'api', ['By number']],
      [41, 'web', ['By branch']],
    ])
  })

  it('on a project with no stages yet, which gets the defaults', () => {
    const { db, schema } = dbm
    const bare = project('Bare', { stages: false })
    ticket(bare.id, 'waiting', { status: 'todo' })
    const stagesOf = () =>
      db
        .select()
        .from(schema.stages)
        .all()
        .filter((s) => s.projectId === bare.id)
    // The reference's own insert is rolled back, so the batched read meets the project without stages too.
    class Rollback extends Error {}
    let before = ''
    expect(() =>
      db.transaction(() => {
        before = JSON.stringify(reference.referenceSummary(bare.id, { now: NOW, humans: [HUMAN] }))
        throw new Rollback()
      }),
    ).toThrow(Rollback)
    expect(stagesOf()).toEqual([])
    const after = JSON.stringify(summary.getSummary(bare.id, { now: NOW, humans: [HUMAN] }))
    expect(reference.firstDifference(before, after)).toBeNull()
    expect(stagesOf().map((s) => s.key)).toEqual([
      'backlog',
      'todo',
      'in_progress',
      'blocked',
      'review',
      'done',
      'cancelled',
    ])
    expect(JSON.parse(after).projects[0].next.stage).toEqual({ key: 'todo', name: 'To do' })

    // Every project at once, likewise.
    const other = project('Bare too', { stages: false })
    ticket(other.id, 'waiting too', { status: 'todo' })
    let all = ''
    expect(() =>
      db.transaction(() => {
        all = JSON.stringify(reference.referenceSummary(undefined, { now: NOW, humans: [HUMAN] }))
        throw new Rollback()
      }),
    ).toThrow(Rollback)
    const batched = JSON.stringify(summary.getSummary(undefined, { now: NOW, humans: [HUMAN] }))
    expect(reference.firstDifference(all, batched)).toBeNull()
    expect(
      db
        .select()
        .from(schema.stages)
        .all()
        .filter((s) => s.projectId === other.id),
    ).toHaveLength(7)
  })

  it('on a board with more tickets in progress than SQLite takes parameters in one statement', () => {
    const { db, schema } = dbm
    // 33,000 tickets in progress since yesterday over two projects, half of them dated from the log
    // only: every batch over them (log, last posts, handoffs) holds more ids than one statement binds.
    const big = [project('Big one').id, project('Big two').id]
    db.transaction((tx) => {
      for (let i = 0; i < 33_000; i += 1_000)
        tx.insert(schema.tickets)
          .values(
            Array.from({ length: 1_000 }, (_, j) => ({
              projectId: big[(i + j) % 2]!,
              title: `bulk ${i + j}`,
              status: 'in_progress',
              createdBy: HUMAN,
              startedAt: (i + j) % 4 < 2 ? iso(at(6, 9)) : null,
              createdAt: iso(at(6, 9)),
              updatedAt: iso(at(6, 9)),
            })),
          )
          .run()
    })
    const opts = { now: NOW, humans: [HUMAN] }
    const before = reference.withoutSummaryIndexes(() =>
      JSON.stringify(reference.referenceSummary(undefined, opts)),
    )
    const after = summary.getSummary(undefined, opts)
    expect(reference.firstDifference(before, JSON.stringify(after))).toBeNull()
    const carried = after.projects.filter((p) => big.includes(p.project.id)).flatMap((p) => p.carryingOver)
    expect(carried).toHaveLength(33_000)
  }, 120_000)

  it('keeps the migration to indexes only', () => {
    expect(reference.summaryIndexes().map((i) => i.name)).toEqual([
      'activity_ref',
      'tasks_ticket',
      'tickets_project',
      'updates_ticket',
      'updates_open_decisions',
      'workspaces_ticket',
    ])
  })
})
