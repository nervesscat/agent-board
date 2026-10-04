import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp

let summary: typeof import('./summary')
let features: typeof import('./features')
let stagesMod: typeof import('./stages')
let dbm: typeof import('#/db')

beforeAll(async () => {
  summary = await import('./summary')
  features = await import('./features')
  stagesMod = await import('./stages')
  dbm = await import('#/db')
})

// Local times, so "today" is the same calendar day whatever the machine's time zone.
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute)
const iso = (d: Date) => d.toISOString()
const NOW = at(7, 15)
const HUMAN = 'enrique'

function project(name: string) {
  const { db, schema } = dbm
  const p = db.insert(schema.projects).values({ name }).returning().get()
  db.insert(schema.repos)
    .values({ projectId: p.id, name: 'api', repoPath: `/r/${name}` })
    .run()
  stagesMod.listStages(p.id)
  return p.id
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
function log(projectId: number, ticketId: number, text: string, when: Date) {
  const { db, schema } = dbm
  db.insert(schema.activity)
    .values({
      projectId,
      actor: 'claude',
      kind: 'ticket',
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
  const { db, schema } = dbm
  return db
    .insert(schema.updates)
    .values({ ticketId, author: 'claude', body, progress: true, createdAt: iso(when), ...values })
    .returning()
    .get()
}

const take = (projectId: number, opts: { humans?: string[] } = {}) => {
  const s = summary.getSummary(projectId, { now: NOW, humans: [HUMAN], ...opts })
  expect(s.projects).toHaveLength(1)
  return s.projects[0]!
}

describe('moveParser', () => {
  it('reads edits, claims and verdicts by stage name, and skips names it does not know', () => {
    const pid = project('parser')
    const parse = summary.moveParser(stagesMod.listStages(pid))
    expect(parse('updated ticket #4 Login (status To do → In progress, assignee → claude)')).toMatchObject({
      from: { key: 'todo' },
      to: { key: 'in_progress' },
    })
    expect(parse('claimed ticket #4 Login (status Backlog → In progress)')?.to.key).toBe('in_progress')
    expect(parse('approved ticket #4 Login (Done)')).toMatchObject({ from: null, to: { key: 'done' } })
    expect(parse('withdrew the approval of ticket #4 Login (back to In review)')?.to.key).toBe('review')
    expect(parse('updated ticket #4 Login (status Old name → Done)')).toBeNull()
    expect(parse('updated ticket #4 Login (renamed)')).toBeNull()
  })
})

describe('in progress and carrying over', () => {
  it('dates each ticket from its log, marks stale ones and carries over what started before today', () => {
    const pid = project('progress')
    // Claimed yesterday, posted this morning; a lane posted later and runs a preview.
    const alpha = ticket(pid, 'Alpha', {
      status: 'in_progress',
      assignee: 'claude',
      updatedAt: iso(at(7, 9)),
    })
    log(pid, alpha.id, `claimed ticket #${alpha.id} Alpha (status To do → In progress)`, at(6, 10))
    post(alpha.id, '**Done:**\n- wired the form', at(7, 9))
    const lane = ticket(pid, 'Alpha lane', { status: 'in_progress', parentId: alpha.id })
    post(lane.id, 'lane: tests pass', at(7, 14))
    dbm.db
      .insert(dbm.schema.workspaces)
      .values({ ticketId: lane.id, name: 'wt-lane', previewUrl: 'http://localhost:5174' })
      .run()
    // Claimed today, nothing posted yet.
    const beta = ticket(pid, 'Beta', { status: 'in_progress', updatedAt: iso(at(7, 11)) })
    log(pid, beta.id, `claimed ticket #${beta.id} Beta (status To do → In progress)`, at(7, 11))
    // Started three days ago, blocked since, last post two days ago: stale.
    const gamma = ticket(pid, 'Gamma', { status: 'blocked' })
    log(pid, gamma.id, `updated ticket #${gamma.id} Gamma (status To do → In progress)`, at(4, 10))
    log(pid, gamma.id, `updated ticket #${gamma.id} Gamma (status In progress → Blocked)`, at(5, 10))
    post(gamma.id, 'waiting on the API key', at(5, 12))
    // Done once, reopened yesterday: the stretch starts at the reopening.
    const delta = ticket(pid, 'Delta', { status: 'in_progress' })
    log(pid, delta.id, `updated ticket #${delta.id} Delta (status In progress → Done)`, at(3, 10))
    log(pid, delta.id, `updated ticket #${delta.id} Delta (status Done → In progress)`, at(6, 8))
    // Created in progress with no log: since its creation.
    const eps = ticket(pid, 'Epsilon', { status: 'in_progress', createdAt: iso(at(2, 9)) })
    // In review: carried over and waiting on the human, not in the in-progress list. Its log starts
    // with it already in progress, so it counts from its creation.
    const zeta = ticket(pid, 'Zeta', { status: 'review' })
    log(pid, zeta.id, `updated ticket #${zeta.id} Zeta (status In progress → In review)`, at(6, 16))

    const s = take(pid)
    const byId = new Map(s.inProgress.map((t) => [t.id, t]))
    expect([...byId.keys()].sort()).toEqual([alpha.id, beta.id, gamma.id, delta.id, eps.id].sort())
    expect(byId.get(alpha.id)).toMatchObject({
      since: iso(at(6, 10)),
      days: 1,
      stale: false,
      lanes: 1,
      lastPost: { ticketId: lane.id, text: 'lane: tests pass' },
      preview: { url: 'http://localhost:5174', workspace: 'wt-lane' },
    })
    expect(byId.get(beta.id)).toMatchObject({ since: iso(at(7, 11)), days: 0, stale: false, lastPost: null })
    expect(byId.get(gamma.id)).toMatchObject({
      kind: 'blocked',
      since: iso(at(4, 10)),
      days: 3,
      stale: true,
      lastPost: { text: 'waiting on the API key' },
    })
    expect(byId.get(delta.id)).toMatchObject({ since: iso(at(6, 8)) })
    expect(byId.get(eps.id)).toMatchObject({ since: iso(at(2, 9)), days: 5, stale: true })
    // The lane is counted on its ticket, not listed on its own.
    expect(byId.has(lane.id)).toBe(false)

    const carried = s.carryingOver.map((t) => t.id).sort()
    expect(carried).toEqual([alpha.id, gamma.id, delta.id, eps.id, zeta.id].sort())
    expect(s.carryingOver.find((t) => t.id === zeta.id)).toMatchObject({
      kind: 'review',
      since: iso(at(1, 9)),
      days: 6,
    })
    expect(s.carryingOver.every((t) => t.resume === undefined)).toBe(true)
  })
})

describe('done today', () => {
  it('counts tickets that reached a done stage today and PRs that left the queue today', () => {
    const pid = project('done')
    const { db, schema } = dbm
    const today = ticket(pid, 'Shipped today', { status: 'done', prNumber: 12 })
    log(pid, today.id, `updated ticket #${today.id} Shipped today (status In review → Done)`, at(7, 10))
    const yesterday = ticket(pid, 'Shipped yesterday', { status: 'done' })
    log(
      pid,
      yesterday.id,
      `updated ticket #${yesterday.id} Shipped yesterday (status In review → Done)`,
      at(6, 10),
    )
    const approved = ticket(pid, 'PR review', { status: 'done', tags: ['PR'] })
    log(pid, approved.id, `approved ticket #${approved.id} PR review (Done)`, at(7, 12))
    const lane = ticket(pid, 'A lane', { status: 'done', parentId: yesterday.id })
    log(pid, lane.id, `updated ticket #${lane.id} A lane (status In progress → Done)`, at(7, 9))
    // Moved to done today and back out again: not done.
    const reopened = ticket(pid, 'Reopened', { status: 'in_progress' })
    log(pid, reopened.id, `updated ticket #${reopened.id} Reopened (status In review → Done)`, at(7, 9))
    log(pid, reopened.id, `updated ticket #${reopened.id} Reopened (status Done → In progress)`, at(7, 11))
    const archived = ticket(pid, 'Archived', { status: 'done', archivedAt: iso(at(7, 14)) })
    log(pid, archived.id, `updated ticket #${archived.id} Archived (status In review → Done)`, at(7, 10))
    const repoId = db
      .select()
      .from(schema.repos)
      .all()
      .find((r) => r.projectId === pid)!.id
    const pr = (number: number, open: boolean, fetched: Date) =>
      db
        .insert(schema.prs)
        .values({
          projectId: pid,
          repoId,
          number,
          title: `PR ${number}`,
          url: `https://github.com/o/r/pull/${number}`,
          author: 'me',
          headRef: `b${number}`,
          baseRef: 'main',
          headSha: 'abc1234',
          updatedAt: iso(fetched),
          fetchedAt: iso(fetched),
          open,
        })
        .run()
    pr(12, false, at(7, 13))
    pr(13, false, at(6, 13))
    pr(14, true, at(7, 13))
    // Something else happened today too, and yesterday.
    db.insert(schema.activity)
      .values({ projectId: pid, actor: 'claude', kind: 'task', text: 'x', createdAt: iso(at(7, 8)) })
      .run()

    const s = take(pid)
    expect(s.doneToday.tickets.map((t) => t.id)).toEqual([approved.id, today.id, lane.id])
    expect(s.doneToday.tickets.find((t) => t.id === lane.id)?.parent).toEqual({
      id: yesterday.id,
      title: 'Shipped yesterday',
    })
    expect(s.doneToday.prs).toMatchObject([{ number: 12, tickets: [{ id: today.id }] }])
    // Today's lines in the project: four ticket moves, the archived one's and the task.
    expect(s.doneToday.activity).toBe(7)
  })
})

describe('next', () => {
  it('lists the head of the first open stage that is not a backlog, in board order, with the counts', () => {
    const pid = project('next')
    for (let i = 1; i <= 6; i++) ticket(pid, `todo ${i}`, { status: 'todo', updatedAt: iso(at(1, 8 + i)) })
    ticket(pid, 'someday', { status: 'backlog' })
    ticket(pid, 'someday too', { status: 'backlog' })
    ticket(pid, 'stuck', { status: 'blocked' })
    const parent = ticket(pid, 'parent', { status: 'in_progress' })
    ticket(pid, 'a lane waiting', { status: 'todo', parentId: parent.id, updatedAt: iso(at(7, 9)) })
    const s = take(pid)
    expect(s.next.stage).toEqual({ key: 'todo', name: 'To do' })
    expect(s.next.tickets.map((t) => t.title)).toEqual(['todo 6', 'todo 5', 'todo 4', 'todo 3', 'todo 2'])
    expect(s.next).toMatchObject({ total: 6, blocked: 1, backlog: 2 })
  })
})

describe('needs you', () => {
  it('gathers open decisions, PRs to review, threads waiting on the human and tickets in review', () => {
    const pid = project('needs')
    const { db, schema } = dbm
    const t = ticket(pid, 'Decide', { status: 'blocked', assignee: 'claude' })
    const open = post(t.id, 'Which cache?', at(7, 9), {
      progress: false,
      decision: [{ label: 'Redis' }, { label: 'Memory' }],
    })
    post(t.id, 'Which queue?', at(6, 9), {
      progress: false,
      decision: [{ label: 'A' }, { label: 'B' }],
      decidedOption: 0,
      decidedBy: HUMAN,
      decidedAt: iso(at(6, 10)),
    })
    // An agent asked on the human's ticket: waiting. Progress posts alone are not questions.
    const asked = ticket(pid, 'Asked', { status: 'in_progress' })
    post(asked.id, 'Should the export include drafts?', at(7, 10), { progress: false })
    const reported = ticket(pid, 'Reported', { status: 'in_progress' })
    post(reported.id, 'step one done', at(7, 10))
    // The human answered last: not waiting.
    const answered = ticket(pid, 'Answered', { status: 'in_progress' })
    post(answered.id, 'Drafts too?', at(7, 8), { progress: false })
    post(answered.id, 'Yes', at(7, 9), { progress: false, author: HUMAN })
    const review = ticket(pid, 'Review me', { status: 'review', prNumber: 7 })
    ticket(pid, 'Approved lane', { status: 'review', parentId: review.id, approvedAt: iso(at(7, 9)) })
    const pr = (number: number, values: Partial<typeof schema.prs.$inferInsert>) =>
      db
        .insert(schema.prs)
        .values({
          projectId: pid,
          number,
          title: `PR ${number}`,
          url: `https://github.com/o/r/pull/${number}`,
          author: 'me',
          headRef: `b${number}`,
          baseRef: 'main',
          headSha: 'abc1234',
          updatedAt: iso(at(7, 9)),
          fetchedAt: iso(at(7, 9)),
          ...values,
        })
        .run()
    pr(7, { waitingOn: 'me' })
    pr(8, { waitingOn: 'others' })
    pr(9, { waitingOn: 'me', hold: true })
    pr(10, { waitingOn: 'me', open: false })

    const s = take(pid)
    expect(s.needsYou.decisions).toMatchObject([
      { postId: open.id, ticketId: t.id, ticketTitle: 'Decide', question: 'Which cache?', options: 2 },
    ])
    expect(s.needsYou.prs.map((p) => p.number)).toEqual([7])
    expect(s.needsYou.threads).toMatchObject([{ parentType: 'ticket', parentId: asked.id, waiting: 1 }])
    expect(s.needsYou.reviews).toMatchObject([{ id: review.id, prNumber: 7, parent: null }])
    expect(s.needsYou.total).toBe(4)
    // Nobody signed in as the human yet: no threads, the rest stays.
    expect(take(pid, { humans: [] }).needsYou.threads).toEqual([])
  })
})

describe('threads waiting on the human', () => {
  it('treat every name the human signs in under as the same person', () => {
    const pid = project('devices')
    const t = ticket(pid, 'Two devices', { status: 'in_progress', assignee: 'claude' })
    post(t.id, 'Can you check the copy?', at(7, 8), { progress: false, author: HUMAN })
    post(t.id, 'Which page?', at(7, 9), { progress: false })
    post(t.id, 'The pricing page', at(7, 10), { progress: false, author: 'phone' })
    expect(take(pid, { humans: [HUMAN, 'phone'] }).needsYou.threads).toEqual([])
    // Seen as one name only, the other device's answer looks like someone else speaking.
    expect(take(pid, { humans: [HUMAN] }).needsYou.threads).toMatchObject([{ parentId: t.id, waiting: 2 }])
  })
})

describe('archived tickets', () => {
  it('never appear in any section', () => {
    const pid = project('archive')
    const gone = { archivedAt: iso(at(7, 14)), archivedBy: HUMAN }
    const parent = ticket(pid, 'Archived', { status: 'done', ...gone })
    log(pid, parent.id, `updated ticket #${parent.id} Archived (status In review → Done)`, at(7, 10))
    const lane = ticket(pid, 'Archived lane', { status: 'review', parentId: parent.id, ...gone })
    post(lane.id, 'Pick one', at(7, 9), { progress: false, decision: [{ label: 'A' }, { label: 'B' }] })
    post(lane.id, 'Anyone?', at(7, 10), { progress: false })
    ticket(pid, 'Archived todo', { status: 'todo', ...gone })
    ticket(pid, 'Archived work', { status: 'in_progress', ...gone })
    const s = take(pid)
    expect(s.needsYou.total).toBe(0)
    expect(s.inProgress).toEqual([])
    expect(s.carryingOver).toEqual([])
    expect(s.doneToday.tickets).toEqual([])
    expect(s.next).toMatchObject({ tickets: [], total: 0, blocked: 0, backlog: 0 })
  })
})

describe('scope', () => {
  it('summarises one project, or every project by name', () => {
    const b = project('zz second')
    const a = project('zz first')
    ticket(a, 'in a', { status: 'in_progress' })
    ticket(b, 'in b', { status: 'in_progress' })
    const one = summary.getSummary(b, { now: NOW, humans: [] })
    expect(one.date).toBe('2026-10-07')
    expect(one.projects.map((p) => p.project.name)).toEqual(['zz second'])
    expect(one.projects[0]!.inProgress.map((t) => t.title)).toEqual(['in b'])
    const all = summary.getSummary(undefined, { now: NOW, humans: [] })
    const names = all.projects.map((p) => p.project.name)
    expect(names).toEqual([...names].sort())
    expect(names.indexOf('zz first')).toBe(names.indexOf('zz second') - 1)
    expect(all.projects.find((p) => p.project.id === a)!.inProgress.map((t) => t.title)).toEqual(['in a'])
  })
})

describe('with the log the board writes', () => {
  it('sees a claim as in progress since now and a move to done as done today', () => {
    const pid = project('live')
    const t = features.createTicket(pid, { title: 'Live' }, HUMAN)
    features.claimTicket(t.id, 'claude')
    const d = features.createTicket(pid, { title: 'Finished' }, HUMAN)
    features.updateTicket(d.id, { status: 'review' }, 'claude')
    features.updateTicket(d.id, { status: 'done' }, HUMAN)
    const s = summary.getSummary(pid, { humans: [HUMAN] }).projects[0]!
    expect(s.inProgress).toMatchObject([{ id: t.id, assignee: 'claude', days: 0, stale: false }])
    expect(Date.now() - new Date(s.inProgress[0]!.since).getTime()).toBeLessThan(60_000)
    expect(s.doneToday.tickets.map((x) => x.id)).toEqual([d.id])
  })
})
