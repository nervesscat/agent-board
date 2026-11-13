import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
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
  })

  it('dates a ticket from when its work started, carrying over only what was already in progress', () => {
    const pid = project('started')
    // Started two days ago (the log only knows a later claim).
    const fresh = ticket(pid, 'Fresh', { status: 'in_progress', startedAt: iso(at(5, 10)) })
    log(pid, fresh.id, `claimed ticket #${fresh.id} Fresh (status To do → In progress)`, at(7, 9))
    log(pid, fresh.id, 'set a task done', at(6, 17))
    // Started three days ago, worked yesterday.
    const bare = ticket(pid, 'No note', { status: 'in_progress', startedAt: iso(at(4, 10)) })
    log(pid, bare.id, 'set a task done', at(6, 15))
    post(bare.id, 'tests pass', at(6, 15))
    const moved = ticket(pid, 'Moved on', { status: 'blocked', startedAt: iso(at(6, 9)) })
    post(moved.id, 'got the key, resuming', at(7, 10))
    // Started this morning, though the log has it claimed days ago: not carried over.
    const today = ticket(pid, 'Started today', { status: 'in_progress', startedAt: iso(at(7, 8)) })
    log(pid, today.id, `claimed ticket #${today.id} Started today (status To do → In progress)`, at(3, 10))

    const s = take(pid)
    expect(s.inProgress.find((t) => t.id === fresh.id)).toMatchObject({ since: iso(at(5, 10)), days: 2 })
    expect(s.inProgress.find((t) => t.id === today.id)).toMatchObject({ since: iso(at(7, 8)), days: 0 })
    expect(s.carryingOver.map((t) => t.id).sort()).toEqual([fresh.id, bare.id, moved.id].sort())
    const carried = new Map(s.carryingOver.map((t) => [t.id, t]))
    expect(carried.get(fresh.id)).toMatchObject({ since: iso(at(5, 10)), days: 2 })
    expect(carried.get(bare.id)).toMatchObject({
      since: iso(at(4, 10)),
      days: 3,
      lastPost: { text: 'tests pass' },
    })
    expect(carried.get(moved.id)).toMatchObject({ days: 1 })
    // The note is gone from the summary: the ticket's summary is its one state card.
    expect(carried.get(fresh.id)).not.toHaveProperty('resume')
  })
})

describe('excerpt', () => {
  it('reads a note as one line of plain text, cut to length', () => {
    expect(summary.excerpt('## Heading\n\n- **bold** item\n> quote with `code`\n')).toBe(
      'Heading bold item quote with code',
    )
    expect(summary.excerpt('see [the PR](https://x/1) and ![shot](a.png)')).toBe('see the PR and shot')
    expect(summary.excerpt('')).toBe('')
    const long = summary.excerpt('word '.repeat(100))
    expect(long).toHaveLength(200)
    expect(long.endsWith('…')).toBe(true)
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
          // The refresh stamps when a PR left the open queue.
          closedAt: open ? null : iso(fetched),
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

  it("follows the column's order: a ticket placed first heads it", () => {
    const pid = project('next placed')
    const ids = [1, 2, 3].map(
      (i) => ticket(pid, `todo ${i}`, { status: 'todo', updatedAt: iso(at(1, 8 + i)) }).id,
    )
    features.placeTicket(ids[0]!, 1, HUMAN)
    expect(take(pid).next.tickets.map((t) => t.title)).toEqual(['todo 1', 'todo 3', 'todo 2'])
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
    // Approved by the human, or with their comments standing: not waiting on their review.
    pr(11, { waitingOn: 'me', reviewStage: 'reviewed' })
    pr(12, { waitingOn: 'me', reviewStage: 'on_hold' })
    // Merged: done.
    pr(13, { waitingOn: 'me', open: false, mergedAt: iso(at(7, 8)) })

    const s = take(pid)
    expect(s.needsYou.decisions).toMatchObject([
      { postId: open.id, ticketId: t.id, ticketTitle: 'Decide', question: 'Which cache?', options: 2 },
    ])
    expect(s.needsYou.prs.map((p) => p.number)).toEqual([7])
    expect(s.needsYou.threads).toMatchObject([{ parentType: 'ticket', parentId: asked.id, waiting: 1 }])
    expect(s.needsYou.reviews).toMatchObject([{ id: review.id, prNumber: 7, parent: null }])
    // The tickets in progress have no work-timeline event since long before now: stalled, and counted.
    expect(s.needsYou.stalled.map((x) => x.ticketId).sort()).toEqual(
      [asked.id, reported.id, answered.id].sort(),
    )
    expect(s.needsYou.total).toBe(4 + 3)
    // Each stalled row carries its ticket's activity: the open spans and waits, and the last heard.
    for (const x of s.needsYou.stalled) {
      expect(x.activity).toEqual({
        spans: [],
        waits: [],
        lastHeard: null,
        lastClosedSpan: null,
        now: expect.any(String),
      })
    }
    // Nobody signed in as the human yet: no threads, the rest stays.
    expect(take(pid, { humans: [] }).needsYou.threads).toEqual([])
  })
})

describe('needs you by stage kind', () => {
  /** A decision, a thread waiting on the human and a blocked step on the ticket. */
  function ask(ticketId: number) {
    post(ticketId, 'Which one?', at(7, 7), {
      progress: false,
      decision: [{ label: 'A' }, { label: 'B' }],
    })
    post(ticketId, 'What now?', at(7, 8), { progress: false, author: HUMAN })
    post(ticketId, 'On it.', at(7, 8, 30), { progress: false })
    features.addTasks(
      ticketId,
      [{ text: `step ${ticketId}`, blocked: true, blockedReason: 'go on' }],
      'claude',
      { quiet: true },
    )
  }

  it('leaves the entries of done, cancelled, backlog and todo tickets out of every list and the total', () => {
    const pid = project('needs by kind')
    for (const status of ['done', 'cancelled', 'backlog', 'todo']) ask(ticket(pid, status, { status }).id)
    const empty = take(pid).needsYou
    expect(empty.decisions).toEqual([])
    expect(empty.threads).toEqual([])
    expect(empty.blockedTasks).toEqual([])
    expect(empty.total).toBe(0)

    // The same entries on work going on, handed off or stopped: they ask the human.
    const kept = ['in_progress', 'review', 'blocked'].map((status) => ticket(pid, status, { status }))
    for (const t of kept) ask(t.id)
    const s = take(pid).needsYou
    const ids = kept.map((t) => t.id).sort()
    expect(s.decisions.map((d) => d.ticketId).sort()).toEqual(ids)
    expect(
      s.threads
        .filter((th) => th.parentType === 'ticket')
        .map((th) => th.ticketId)
        .sort(),
    ).toEqual(ids)
    expect(s.blockedTasks.map((task) => task.ticketId).sort()).toEqual(ids)
    expect(s.decisions.length + s.threads.length + s.blockedTasks.length).toBe(9)
    // The total is what the lists show, and nothing else.
    expect(s.total).toBe(
      s.decisions.length +
        s.humanWaits.length +
        s.prs.length +
        s.threads.length +
        s.reviews.length +
        s.blockedTasks.length +
        s.instructionChanges.length +
        s.stalled.length,
    )
  })

  it('goes by the stage’s kind, whatever the stage is called', () => {
    const pid = project('needs by kind name')
    const { db, schema } = dbm
    db.insert(schema.stages)
      .values({ projectId: pid, key: 'bug_found', name: 'Bug Found', kind: 'active', position: 20 })
      .run()
    db.insert(schema.stages)
      .values({ projectId: pid, key: 'shipped', name: 'Done', kind: 'done', position: 21 })
      .run()
    const kept = ticket(pid, 'A bug', { status: 'bug_found' })
    const dropped = ticket(pid, 'A shipment', { status: 'shipped' })
    ask(kept.id)
    ask(dropped.id)

    const s = take(pid).needsYou
    expect(s.decisions.map((d) => d.ticketId)).toEqual([kept.id])
    expect(s.threads.map((th) => th.ticketId)).toEqual([kept.id])
    expect(s.blockedTasks.map((task) => task.ticketId)).toEqual([kept.id])
  })

  it('does not break for a project with no stage of an asking kind', () => {
    const pid = project('needs no asking stages')
    const { db, schema } = dbm
    db.update(schema.stages).set({ kind: 'open' }).where(eq(schema.stages.projectId, pid)).run()
    const t = ticket(pid, 'Lined up', { status: 'todo' })
    ask(t.id)

    expect(() => take(pid)).not.toThrow()
    const s = take(pid).needsYou
    expect([...s.decisions, ...s.threads, ...s.blockedTasks]).toEqual([])
    expect(s.total).toBe(0)
  })
})

describe('waits on the human', () => {
  const wait = (projectId: number, ticketId: number, when: Date, note: string, agent = 'claude') => {
    const { db, schema } = dbm
    return db
      .insert(schema.ticketEvents)
      .values({
        ticketId,
        projectId,
        kind: 'wait_start',
        agent,
        by: agent,
        reason: 'human',
        note,
        at: iso(when),
      })
      .returning()
      .get()
  }
  const endWait = (projectId: number, ticketId: number, waitId: number, when: Date) => {
    const { db, schema } = dbm
    db.insert(schema.ticketEvents)
      .values({
        ticketId,
        projectId,
        kind: 'wait_end',
        agent: 'claude',
        by: 'claude',
        reason: 'human',
        refId: waitId,
        at: iso(when),
      })
      .run()
  }

  it('lists an open wait on an active ticket with its note, agent, since and ticket', () => {
    const pid = project('human waits')
    const t = ticket(pid, 'Approve the copy', { status: 'in_progress', assignee: 'claude' })
    const w = wait(pid, t.id, at(7, 9), 'needs the copy approved')

    const s = take(pid)
    expect(s.needsYou.humanWaits).toEqual([
      {
        waitId: w.id,
        ticketId: t.id,
        ticketTitle: 'Approve the copy',
        status: 'in_progress',
        assignee: 'claude',
        parent: null,
        agent: 'claude',
        note: 'needs the copy approved',
        since: iso(at(7, 9)),
      },
    ])
    expect(s.needsYou.total).toBe(1)
    // An open wait on the human keeps the ticket out of the stalled list.
    expect(s.needsYou.stalled).toEqual([])
  })

  it('leaves out a wait that ended, and one on a ticket that is not active', () => {
    const pid = project('human waits closed')
    const closed = ticket(pid, 'Answered', { status: 'in_progress' })
    const w = wait(pid, closed.id, at(7, 14, 30), 'needs the copy approved')
    endWait(pid, closed.id, w.id, at(7, 14, 50))
    const review = ticket(pid, 'Review me', { status: 'review' })
    wait(pid, review.id, at(7, 14), 'sign it off')

    expect(take(pid).needsYou.humanWaits).toEqual([])
  })

  it('does not list a wait twice when the ticket already asks with an open decision card', () => {
    const pid = project('human waits decided')
    const t = ticket(pid, 'Decide', { status: 'in_progress', assignee: 'claude' })
    wait(pid, t.id, at(7, 9), 'needs the copy approved')
    post(t.id, 'Which cache?', at(7, 10), {
      progress: false,
      decision: [{ label: 'Redis' }, { label: 'Memory' }],
    })

    const s = take(pid)
    expect(s.needsYou.decisions).toHaveLength(1)
    expect(s.needsYou.humanWaits).toEqual([])
    expect(s.needsYou.total).toBe(1)
  })
})

describe('blocked tasks', () => {
  /** Tasks on the ticket, the ones named in `blocked` tagged with a reason; the rows by text. */
  function tasks(ticketId: number, items: import('./features').NewTask[], blocked: string[]) {
    const rows = features.addTasks(ticketId, items, 'claude', { quiet: true })
    const byText = new Map(rows.map((r) => [r.text, r]))
    for (const text of blocked)
      features.updateTask(byText.get(text)!.id, { blocked: true, blockedReason: `do ${text}` }, 'claude')
    return byText
  }

  it('surfaces each ticket’s next blocked step, with its ticket, and counts it in the total', () => {
    const pid = project('blocked tasks')
    const t = ticket(pid, 'Payments', { status: 'in_progress', assignee: 'claude' })
    const own = tasks(
      t.id,
      [{ text: 'Implementation', subtasks: ['keys', 'webhook'] }, 'deploy'],
      ['keys', 'deploy'],
    )
    const lane = ticket(pid, 'Payments lane', { status: 'in_progress', parentId: t.id })
    const laneTasks = tasks(lane.id, ['lane step'], ['lane step'])
    // In review it still waits on the human.
    const review = ticket(pid, 'In review', { status: 'review' })
    const reviewTasks = tasks(review.id, ['sign off'], ['sign off'])
    const base = take(pid)
    // Newest ticket activity first; the order between tickets touched in the same moment is not fixed.
    const byTask = (list: typeof base.needsYou.blockedTasks) => [...list].sort((a, b) => a.taskId - b.taskId)
    // `keys` is the first open step under Implementation, so it surfaces; `deploy` waits behind it.
    expect(byTask(base.needsYou.blockedTasks)).toEqual([
      {
        taskId: own.get('keys')!.id,
        text: 'keys',
        reason: 'do keys',
        parentTask: 'Implementation',
        ticketId: t.id,
        ticketTitle: 'Payments',
        status: 'in_progress',
        parent: null,
      },
      expect.objectContaining({
        taskId: laneTasks.get('lane step')!.id,
        ticketId: lane.id,
        parent: { id: t.id, title: 'Payments' },
      }),
      expect.objectContaining({
        taskId: reviewTasks.get('sign off')!.id,
        ticketId: review.id,
        status: 'review',
      }),
    ])
    expect(base.needsYou.blockedTasks.map((x) => x.taskId)).not.toContain(own.get('deploy')!.id)
    // The ticket in review is there twice: once to review, once for its blocked task.
    expect(base.needsYou.reviews.map((r) => r.id)).toEqual([review.id])
    // The ticket and its lane in progress are silent on the work timeline: stalled, and counted.
    expect(base.needsYou.stalled.map((x) => x.ticketId).sort()).toEqual([t.id, lane.id].sort())
    expect(base.needsYou.total).toBe(3 + 1 + 2)

    // In progress carries the true count of each ticket, its lanes' included, and says a blocked step
    // is the one it works next.
    const payments = base.inProgress.find((x) => x.id === t.id)!
    expect(payments.blockedTasks).toBe(3)
    expect(payments.blockedNext).toBe(true)
    expect(payments.blockedTasks).toBe(features.listTickets(pid).find((x) => x.id === t.id)!.blockedTasks)

    // One more tagged behind the next step: counted, not surfaced, and the total does not move.
    features.updateTask(own.get('webhook')!.id, { blocked: true }, 'claude')
    const more = take(pid)
    expect(more.needsYou.blockedTasks).toHaveLength(3)
    expect(more.needsYou.blockedTasks.map((x) => x.taskId)).not.toContain(own.get('webhook')!.id)
    expect(more.inProgress.find((x) => x.id === t.id)!.blockedTasks).toBe(4)
    expect(more.needsYou.total).toBe(3 + 1 + 2)
    // Ticked done: gone from the count too (it never surfaced).
    features.updateTask(own.get('webhook')!.id, { done: true }, 'claude')
    expect(take(pid).needsYou.total).toBe(3 + 1 + 2)
  })

  it('leaves a blocked step out while an earlier open one comes first, and still counts it', () => {
    const pid = project('blocked behind')
    const t = ticket(pid, 'Wait', { status: 'in_progress' })
    const own = tasks(t.id, ['write', 'publish'], ['publish'])
    const s = take(pid)
    expect(s.needsYou.blockedTasks).toEqual([])
    expect(s.needsYou.blockedTasks.map((x) => x.taskId)).not.toContain(own.get('publish')!.id)
    expect(features.listTickets(pid).find((x) => x.id === t.id)!.blockedTasks).toBe(1)
    expect(features.listTickets(pid).find((x) => x.id === t.id)!.blockedNext).toBe(false)
    expect(features.getTicketFull(t.id).blockedTasks).toBe(1)
  })

  it('follows the ticket’s order: only the first open step surfaces, then the next one as it is reached', () => {
    const pid = project('blocked next')
    const t = ticket(pid, 'Ship', { status: 'in_progress', assignee: 'claude' })
    const own = tasks(
      t.id,
      [{ text: 'Implementation', subtasks: ['keys', 'webhook'] }, 'deploy'],
      ['keys', 'deploy'],
    )
    const row = () => features.listTickets(pid).find((x) => x.id === t.id)!
    // The open parent is a container: its first open subtask is the next step, and the blocked one after
    // it (`deploy`) stays out though it is counted.
    expect(take(pid).needsYou.blockedTasks).toEqual([
      expect.objectContaining({ text: 'keys', parentTask: 'Implementation', reason: 'do keys' }),
    ])
    expect(row().blockedTasks).toBe(2)
    expect(row().blockedNext).toBe(true)
    expect(features.getTicketFull(t.id).blockedTasks).toBe(2)
    // `total` counts the surfaced step alone, not every blocked one.
    const before = take(pid)
    expect(before.needsYou.blockedTasks).toHaveLength(1)
    expect(before.needsYou.total).toBe(
      before.needsYou.decisions.length +
        before.needsYou.humanWaits.length +
        before.needsYou.prs.length +
        before.needsYou.threads.length +
        before.needsYou.reviews.length +
        before.needsYou.blockedTasks.length +
        before.needsYou.instructionChanges.length +
        before.needsYou.stalled.length,
    )

    // `keys` done: `webhook` is the step being worked, so nothing of the ticket's surfaces, and `deploy`
    // is still counted behind it.
    features.updateTask(own.get('keys')!.id, { done: true }, 'claude')
    expect(take(pid).needsYou.blockedTasks).toEqual([])
    expect(row().blockedTasks).toBe(1)
    expect(row().blockedNext).toBe(false)

    // `webhook` done settles Implementation done: `deploy` is next now, and surfaces.
    features.updateTask(own.get('webhook')!.id, { done: true }, 'claude')
    expect(take(pid).needsYou.blockedTasks).toEqual([expect.objectContaining({ text: 'deploy' })])
    expect(row().blockedTasks).toBe(1)
    expect(row().blockedNext).toBe(true)
  })

  it('rolls a lane’s next blocked step up to its parent, whose own next step is not blocked', () => {
    const pid = project('blocked lane')
    const parent = ticket(pid, 'Parent', { status: 'in_progress', assignee: 'claude' })
    const own = tasks(parent.id, ['write', 'publish'], ['publish'])
    const lane = ticket(pid, 'Docs', { status: 'in_progress', parentId: parent.id })
    const laneTasks = tasks(lane.id, ['proofread'], ['proofread'])
    const row = (id: number) => features.listTickets(pid).find((x) => x.id === id)!
    const s = take(pid)
    // The parent's own next step (`write`) is unblocked, so its blocked `publish` stays out; its lane's
    // blocked next step does not.
    expect(s.needsYou.blockedTasks).toEqual([
      expect.objectContaining({
        taskId: laneTasks.get('proofread')!.id,
        text: 'proofread',
        ticketId: lane.id,
        ticketTitle: 'Docs',
        status: 'in_progress',
        parent: { id: parent.id, title: 'Parent' },
      }),
    ])
    expect(s.needsYou.blockedTasks.map((x) => x.taskId)).not.toContain(own.get('publish')!.id)
    expect(row(parent.id).blockedTasks).toBe(2)
    expect(row(parent.id).blockedNext).toBe(true)
    expect(row(lane.id).blockedNext).toBe(true)
    expect(s.inProgress.find((x) => x.id === parent.id)).toMatchObject({
      blockedTasks: 2,
      blockedNext: true,
    })
  })

  it('leave out done tasks, and tickets that are done, cancelled, archived or under a cancelled lane', () => {
    const pid = project('blocked closed')
    const done = ticket(pid, 'Done', { status: 'done' })
    tasks(done.id, ['a'], ['a'])
    const cancelled = ticket(pid, 'Cancelled', { status: 'cancelled' })
    tasks(cancelled.id, ['a'], ['a'])
    const archived = ticket(pid, 'Archived', {
      status: 'in_progress',
      archivedAt: iso(at(7, 9)),
      archivedBy: HUMAN,
    })
    tasks(archived.id, ['a'], ['a'])
    const parent = ticket(pid, 'Parent', { status: 'in_progress' })
    const dropped = ticket(pid, 'Dropped lane', { status: 'cancelled', parentId: parent.id })
    tasks(dropped.id, ['a'], ['a'])
    const under = ticket(pid, 'Under the dropped lane', { status: 'in_progress', parentId: dropped.id })
    tasks(under.id, ['a'], ['a'])
    const live = ticket(pid, 'Live', { status: 'in_progress' })
    const rows = tasks(live.id, ['ticked', 'open'], ['ticked', 'open'])
    features.updateTask(rows.get('ticked')!.id, { done: true }, 'claude')

    const s = take(pid)
    expect(s.needsYou.blockedTasks.map((x) => [x.ticketId, x.text])).toEqual([[live.id, 'open']])
    // The tickets in progress (not the archived one) are silent on the work timeline: stalled, and counted.
    expect(s.needsYou.stalled.map((x) => x.ticketId).sort()).toEqual([parent.id, under.id, live.id].sort())
    expect(s.needsYou.total).toBe(1 + 3)
    expect(s.inProgress.find((x) => x.id === parent.id)!.blockedTasks).toBe(0)
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

describe('PR tickets', () => {
  it('stay out of every list but needs you, where their decisions and threads show as PR rows', async () => {
    const { db, schema } = dbm
    const features = await import('./features')
    const prTickets = await import('./prTickets')
    const pid = project('pr tickets')
    const pr = (number: number) =>
      db
        .insert(schema.prs)
        .values({
          projectId: pid,
          number,
          title: `PR ${number}`,
          url: `https://github.com/o/r/pull/${number}`,
          author: HUMAN,
          waitingOn: 'others',
          headRef: `b${number}`,
          baseRef: 'main',
          headSha: 'abc1234',
          updatedAt: iso(at(7, 9)),
          fetchedAt: iso(at(7, 9)),
        })
        .returning()
        .get()
    const [todo, doing, reviewed] = [pr(81), pr(82), pr(83)]
    prTickets.openPrTickets(pid, (row) => (row.number === 83 ? 'reviewed' : 'pending'))
    const ownOf = (row: { id: number }) =>
      db
        .select()
        .from(schema.tickets)
        .all()
        .find((t) => t.prId === row.id)!
    // 82 is worked on since before today, with a task waiting on the human and a question asked on it.
    const doingTicket = ownOf(doing)
    db.update(schema.tickets)
      .set({ status: 'in_progress', startedAt: iso(at(5, 9)) })
      .where(eq(schema.tickets.id, doingTicket.id))
      .run()
    features.addTasks(
      doingTicket.id,
      [{ text: 'Get the token', blocked: true, blockedReason: 'Give it the token' }],
      'claude',
    )
    features.askDecision(
      doingTicket.id,
      { body: 'Ship the fix?', options: [{ label: 'Yes' }, { label: 'No' }], block: false },
      'claude',
    )
    features.addComment(
      { parentType: 'ticket', parentId: doingTicket.id, body: 'Is it safe to merge?' },
      'ana',
    )

    const s = take(pid)
    // Their decisions and their threads waiting on the human show here, as PR rows.
    expect(s.needsYou.decisions).toMatchObject([
      { ticketId: doingTicket.id, ticketTitle: 'PR #82: PR 82', prTicket: true, question: 'Ship the fix?' },
    ])
    expect(s.needsYou.threads).toMatchObject([
      { parentType: 'ticket', ticketId: doingTicket.id, title: 'PR #82: PR 82', prTicket: true, waiting: 2 },
    ])
    // Nothing else lists them: not in progress, not in review, not next, not carrying over, not a blocked task.
    expect(s.inProgress).toEqual([])
    expect(s.needsYou.reviews).toEqual([])
    expect(s.needsYou.blockedTasks).toEqual([])
    expect(s.next).toMatchObject({ tickets: [], total: 0 })
    expect(s.carryingOver).toEqual([])
    expect(ownOf(todo).status).toBe('todo')
    expect(ownOf(reviewed).status).toBe('review')
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
    expect(s.inProgress[0]!.since).toBe(features.getTicket(t.id).startedAt)
    expect(s.doneToday.tickets.map((x) => x.id)).toEqual([d.id])
  })
})

describe('instruction changes in needs you', () => {
  it("lists an orchestrator's pending change until the human reviews or reverts it", async () => {
    const history = await import('./instructionsHistory')
    const ORCH = { name: 'orch', role: 'orchestrator' } as const
    const HUMAN_CHANGER = { name: HUMAN, role: 'human' } as const
    const p = project('instructions')
    const take = () => summary.getSummary(p, { humans: [] }).projects[0]!.needsYou
    const before = take().total
    const one = history.setInstructions(p, '# Rules\n\nAlways   run the e2e suite.', ORCH).change!
    history.setInstructions(p, '# Rules\n\nAlways run the e2e suite.', HUMAN_CHANGER)
    const two = history.setInstructions(p, 'two', ORCH).change!
    expect(take().instructionChanges).toEqual([
      {
        changeId: two.id,
        projectId: p,
        changedBy: 'orch',
        role: 'orchestrator',
        createdAt: two.createdAt,
        excerpt: 'two',
        revertable: true,
      },
      {
        changeId: one.id,
        projectId: p,
        changedBy: 'orch',
        role: 'orchestrator',
        createdAt: one.createdAt,
        excerpt: 'Rules Always   run the e2e suite.',
        revertable: false,
      },
    ])
    expect(take().total).toBe(before + 2)
    history.reviewInstructionChange(one.id, 'enrique')
    history.revertInstructionChange(two.id, 'enrique')
    expect(take().instructionChanges).toEqual([])
    expect(take().total).toBe(before)
  })
})

describe('the stalled rows of the Overview: the span that ended last', () => {
  it('names the last closed span, so a stall with nothing open is dated by when its work ended', () => {
    const pid = project('closed span')
    const { db, schema } = dbm
    const t = ticket(pid, 'Built, then silent', {
      status: 'in_progress',
      startedAt: iso(at(7, 9)),
      createdAt: iso(at(7, 8)),
    })
    const event = (kind: 'span_start' | 'span_end', when: Date, refId: number | null = null) =>
      db
        .insert(schema.ticketEvents)
        .values({
          ticketId: t.id,
          projectId: pid,
          kind,
          agent: 'builder',
          by: 'builder',
          phase: 'build',
          refId,
          at: iso(when),
        })
        .returning()
        .get()
    const start = event('span_start', at(7, 9))
    event('span_end', at(7, 9, 30), start.id)
    const row = take(pid).needsYou.stalled.find((x) => x.ticketId === t.id)!
    expect(row.activity.spans).toEqual([])
    expect(row.activity.lastClosedSpan).toEqual({
      phase: 'build',
      agent: 'builder',
      start: iso(at(7, 9)),
      end: iso(at(7, 9, 30)),
    })
    // The why reads from it: the build ended, nothing open since.
    expect(
      summary.getSummary(pid, { now: NOW, humans: [HUMAN] }).projects[0]!.needsYou.stalled,
    ).toContainEqual(expect.objectContaining({ ticketId: t.id, lastSignalAt: iso(at(7, 9, 30)) }))
  })
})
