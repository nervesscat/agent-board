import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp

let features: typeof import('./features')
let projectId: number
let otherRepo: number
beforeAll(async () => {
  features = await import('./features')
  const { db, schema } = await import('#/db')
  projectId = db.insert(schema.projects).values({ name: 'p' }).returning().get().id
  db.insert(schema.repos).values({ projectId, name: 'api', repoPath: '/r/api', baseBranch: 'main' }).run()
  otherRepo = db
    .insert(schema.repos)
    .values({ projectId, name: 'web', repoPath: '/r/web', baseBranch: 'develop' })
    .returning()
    .get().id
})

describe('gist', () => {
  it('skips markdown markers and bare labels', () => {
    expect(features.gist('**Evidence:**\n- webhook retries now back off\n- more')).toBe(
      'webhook retries now back off',
    )
    expect(features.gist('## Done\n\nShipped the `api` lane.')).toBe('Done')
    expect(features.gist('Notes:')).toBe('Notes:')
  })
})

describe('lanes', () => {
  it('branch off the parent, roll progress up and count by status', () => {
    expect(features.listTickets(projectId)).toEqual([])
    const parent = features.createTicket(
      projectId,
      { title: 'checkout', branch: 'feat/checkout', repoId: otherRepo - 1, tasks: ['plan'] },
      'me',
    )
    const api = features.createTicket(
      projectId,
      { title: 'api', parentId: parent.id, tasks: ['a', 'b'], status: 'in_progress' },
      'claude',
    )
    const web = features.createTicket(
      projectId,
      { title: 'web', parentId: parent.id, repoId: otherRepo },
      'codex',
    )
    const hooks = features.createTicket(
      projectId,
      { title: 'webhooks', parentId: api.id, tasks: ['c'] },
      'claude',
    )

    // Same repo: off the parent's branch. Other repo: that repo's base. Nested: off the lane's base.
    expect(api.baseBranch).toBe('feat/checkout')
    expect(api.repoId).toBe(parent.repoId)
    expect(web.baseBranch).toBe('develop')
    expect(hooks.baseBranch).toBe('feat/checkout')

    const [task] = features.getTicketFull(hooks.id).tasks
    features.updateTask(task!.id, { done: true }, 'claude')

    const top = features.listTickets(projectId, { parentId: null })
    expect(top.map((t) => t.id)).toEqual([parent.id])
    expect(top[0]!.progress).toEqual({ done: 0, total: 1 })
    expect(top[0]!.rollup).toEqual({ done: 1, total: 4 })
    expect(top[0]!.lanes).toEqual({
      total: 2,
      approved: 0,
      disapproved: 0,
      byStage: { in_progress: 1, todo: 1 },
    })

    features.postUpdate(hooks.id, 'signature check in', [], 'claude')
    const full = features.getTicketFull(hooks.id)
    expect(full.ancestors.map((a) => a.id)).toEqual([parent.id, api.id])

    const p = features.getTicketFull(parent.id)
    expect(p.lanes.map((l) => l.id).sort()).toEqual([api.id, web.id].sort())
    expect(p.updates).toEqual([])
    expect(features.getTicketFull(parent.id, { laneUpdates: true }).updates[0]!.lane).toEqual({
      id: hooks.id,
      title: 'webhooks',
    })
    // A sub-lane's update is the newest news of the lane above it.
    expect(p.lanes.find((l) => l.id === api.id)!.lastUpdate).toMatchObject({ text: 'signature check in' })
  })

  it('refuse a parent from another project', async () => {
    const { db, schema } = await import('#/db')
    const other = db.insert(schema.projects).values({ name: 'q' }).returning().get().id
    db.insert(schema.repos).values({ projectId: other, name: 'x', repoPath: '/r/x' }).run()
    const t = features.createTicket(other, { title: 'elsewhere' }, 'me')
    expect(() =>
      features.createTicket(projectId, { title: 'x', parentId: t.id, repoId: otherRepo }, 'me'),
    ).toThrow(/not in project/)
  })

  it("show their workspaces in the parent's git panel, tagged with the lane", async () => {
    const parent = features.createTicket(projectId, { title: 'panel', repoId: otherRepo }, 'me')
    const lane = features.createTicket(projectId, { title: 'lane', parentId: parent.id }, 'me')
    const sub = features.createTicket(projectId, { title: 'sub', parentId: lane.id }, 'me')
    features.addWorkspace(parent.id, { name: 'main-wt' }, 'me')
    features.addWorkspace(sub.id, { name: 'sub-wt', branch: 'feat/sub' }, 'codex')
    const git = await features.ticketGit(parent.id)
    expect(git.workspaces.map((w) => [w.name, w.lane?.id ?? null])).toEqual([
      ['main-wt', null],
      ['sub-wt', sub.id],
    ])
    expect((await features.ticketGit(sub.id)).workspaces.map((w) => w.lane)).toEqual([null])
  })

  it("carry the human's verdict; disapproving cancels, taking it back reopens", () => {
    const parent = features.createTicket(projectId, { title: 'verdicts', repoId: otherRepo }, 'me')
    const a = features.createTicket(projectId, { title: 'a', parentId: parent.id, tasks: ['x'] }, 'claude')
    const b = features.createTicket(projectId, { title: 'b', parentId: parent.id, tasks: ['y'] }, 'claude')
    const row = () => features.listTickets(projectId).find((t) => t.id === parent.id)!

    const approved = features.setVerdict(a.id, 'approved', 'enrique')
    expect(approved).toMatchObject({ approvedBy: 'enrique', disapprovedAt: null })
    expect(features.getTicketFull(parent.id).lanes.find((l) => l.id === a.id)!.approvedBy).toBe('enrique')

    const rejected = features.setVerdict(b.id, 'disapproved', 'enrique')
    expect(rejected).toMatchObject({ status: 'cancelled', disapprovedBy: 'enrique', approvedAt: null })
    expect(row().lanes).toMatchObject({ approved: 1, disapproved: 1, byStage: { cancelled: 1 } })
    // The cancelled lane's task is no longer part of the work.
    expect(row().rollup).toEqual({ done: 0, total: 1 })

    // Switching straight to approved clears the disapproval and reopens it.
    expect(features.setVerdict(b.id, 'approved', 'enrique')).toMatchObject({
      status: 'todo',
      disapprovedAt: null,
      approvedBy: 'enrique',
    })
    // An undo puts back the stage and the call the lane had before.
    features.updateTicket(b.id, { status: 'review' }, 'claude')
    features.setVerdict(b.id, 'disapproved', 'enrique')
    expect(features.setVerdict(b.id, 'approved', 'enrique', { reopenTo: 'review' })).toMatchObject({
      status: 'review',
      approvedBy: 'enrique',
    })
    features.setVerdict(a.id, null, 'enrique')
    expect(features.getTicket(a.id)).toMatchObject({ approvedAt: null, approvedBy: '', status: 'todo' })
    expect(row().lanes).toMatchObject({ approved: 1, disapproved: 0 })
  })

  it('carry tags: cleaned up, filterable in any casing', () => {
    expect(features.cleanTags(['  High ', 'high', '', 'Forms  UI', 'x'.repeat(50)])).toEqual([
      'High',
      'Forms UI',
      'x'.repeat(40),
    ])
    const parent = features.createTicket(projectId, { title: 'audit', repoId: otherRepo }, 'me')
    const a = features.createTicket(projectId, { title: 'a', parentId: parent.id, tags: ['High'] }, 'claude')
    const b = features.createTicket(projectId, { title: 'b', parentId: parent.id, tags: ['Low'] }, 'claude')
    features.updateTicket(b.id, { tags: ['Cosmetic', 'cosmetic', 'Forms'] }, 'claude')
    expect(features.getTicket(b.id).tags).toEqual(['Cosmetic', 'Forms'])
    const tagged = (tag: string) =>
      features.listTickets(projectId, { parentId: parent.id, tag }).map((t) => t.id)
    expect(tagged('high')).toEqual([a.id])
    expect(tagged('FORMS')).toEqual([b.id])
    expect(tagged('Low')).toEqual([])
  })

  it('go with the ticket, or move up a level with keepLanes', () => {
    const a = features.createTicket(projectId, { title: 'a', repoId: otherRepo }, 'me')
    const b = features.createTicket(projectId, { title: 'b', parentId: a.id }, 'me')
    const c = features.createTicket(projectId, { title: 'c', parentId: b.id }, 'me')
    features.deleteTicket(b.id, 'me', { keepLanes: true })
    expect(features.getTicket(c.id).parentId).toBe(a.id)
    features.deleteTicket(a.id, 'me')
    expect(() => features.getTicket(c.id)).toThrow()
  })
})

describe('the agent loop', () => {
  // A project of its own, so the other tests' tickets do not show up in its lists.
  let pid: number
  let repoId: number
  beforeAll(async () => {
    const { db, schema } = await import('#/db')
    pid = db.insert(schema.projects).values({ name: 'loop' }).returning().get().id
    repoId = db
      .insert(schema.repos)
      .values({ projectId: pid, name: 'app', repoPath: '/r/app', githubRepo: 'acme/app' })
      .returning()
      .get().id
  })

  it('lets one agent claim a ticket, and only one', () => {
    const t = features.createTicket(pid, { title: 'claim me' }, 'enrique')
    expect(features.claimTicket(t.id, 'claude', { branch: 'feat/claim' })).toMatchObject({
      assignee: 'claude',
      status: 'in_progress',
      branch: 'feat/claim',
    })
    // Claiming again is harmless; someone else claiming or self-assigning is refused.
    expect(features.claimTicket(t.id, 'claude').assignee).toBe('claude')
    expect(() => features.claimTicket(t.id, 'codex')).toThrow(/already claimed by claude/)
    expect(() => features.updateTicket(t.id, { assignee: 'codex' }, 'codex', { guardClaim: true })).toThrow(
      /assigned to claude/,
    )
    // The human reassigning from the UI is not guarded.
    expect(features.updateTicket(t.id, { assignee: 'codex' }, 'enrique').assignee).toBe('codex')
    features.updateTicket(t.id, { status: 'done' }, 'enrique')
    expect(() => features.claimTicket(t.id, 'codex')).toThrow(/is done \(Done\)/)
  })

  it('filters tickets by status, assignee and text', () => {
    const a = features.createTicket(
      pid,
      { title: 'Stripe webhooks', status: 'blocked', assignee: 'claude' },
      'me',
    )
    const b = features.createTicket(pid, { title: 'b', body: 'retry the WEBHOOK', status: 'todo' }, 'me')
    const ids = (f: import('./features').TicketFilter) => features.listTickets(pid, f).map((t) => t.id)
    expect(ids({ status: ['blocked'] })).toEqual([a.id])
    expect(ids({ status: ['todo'], assignee: '' })).toEqual([b.id])
    expect(ids({ q: 'webhook' }).sort()).toEqual([a.id, b.id].sort())
    expect(ids({ q: 'webhook', assignee: 'claude' })).toEqual([a.id])
  })

  it('rewords and removes tasks, logging both', async () => {
    const { dailyReport, today } = await import('./daily')
    const t = features.createTicket(pid, { title: 'plan', tasks: ['a', 'b'] }, 'me')
    const [a, b] = features.getTicketFull(t.id).tasks
    features.updateTask(a!.id, { text: 'a, properly' }, 'claude')
    features.deleteTask(b!.id, 'claude')
    expect(features.getTicketFull(t.id).tasks.map((x) => x.text)).toEqual(['a, properly'])
    expect(features.listTickets(pid).find((x) => x.id === t.id)!.progress).toEqual({ done: 0, total: 1 })
    const texts = JSON.stringify(dailyReport(today(), pid))
    expect(texts).toContain('reworded \\"a\\" to \\"a, properly\\"')
    expect(texts).toContain('removed \\"b\\"')
  })

  it('shows thread counts on the ticket and its updates, and the threads waiting on an agent', () => {
    const t = features.createTicket(pid, { title: 'threads', assignee: 'claude' }, 'enrique')
    const u = features.postUpdate(t.id, 'first pass done', [], 'claude')
    const other = features.createTicket(pid, { title: 'not mine', assignee: 'codex' }, 'enrique')
    features.addComment({ parentType: 'ticket', parentId: other.id, body: 'hi codex' }, 'enrique')

    expect(features.listOpenThreads(pid, 'claude')).toEqual([])
    // The human answers under the update: the agent owns it, so it waits on the agent.
    features.addComment({ parentType: 'update', parentId: u.id, body: 'looks off on mobile' }, 'enrique')
    features.addComment({ parentType: 'update', parentId: u.id, body: 'see the header' }, 'enrique')
    const full = features.getTicketFull(t.id)
    expect(full.thread).toEqual({ count: 0, lastAuthor: null, lastAt: null })
    expect(full.updates[0]!.thread).toMatchObject({ count: 2, lastAuthor: 'enrique' })
    expect(features.listOpenThreads(pid, 'claude')).toMatchObject([
      { parentType: 'update', parentId: u.id, ticketId: t.id, waiting: 2, last: { text: 'see the header' } },
    ])

    // Answering closes it; a new word from the human reopens it with one waiting.
    features.addComment({ parentType: 'update', parentId: u.id, body: 'fixed' }, 'claude')
    expect(features.listOpenThreads(pid, 'claude')).toEqual([])
    features.addComment({ parentType: 'update', parentId: u.id, body: 'thanks' }, 'enrique')
    expect(features.listOpenThreads(pid, 'claude')).toMatchObject([{ waiting: 1 }])
    // Codex's thread is codex's.
    expect(features.listOpenThreads(pid, 'codex')).toMatchObject([
      { parentType: 'ticket', parentId: other.id },
    ])
  })

  it('links a ticket to its PR both ways, by number or by branch', async () => {
    const { db, schema } = await import('#/db')
    const prs = await import('./prs')
    const reviews = await import('./reviews')
    const now = new Date().toISOString()
    const pr = (number: number, headRef: string) => ({
      projectId: pid,
      repoId,
      number,
      title: `pr ${number}`,
      url: `https://github.com/acme/app/pull/${number}`,
      author: 'claude',
      headRef,
      baseRef: 'main',
      headSha: `abc${number}def0123`,
      updatedAt: now,
      fetchedAt: now,
    })
    db.insert(schema.prs)
      .values([pr(7, 'feat/seven'), pr(8, 'feat/eight')])
      .run()

    const byNumber = features.createTicket(pid, { title: 'seven', branch: 'other', prNumber: 7 }, 'claude')
    const byBranch = features.createTicket(pid, { title: 'eight', branch: 'feat/eight' }, 'claude')
    const outside = features.createTicket(pid, { title: 'nine', prNumber: 9 }, 'claude')
    reviews.postResult(pid, { prNumber: 7, sha: 'abc7def0123', verdict: 'SHIP', summaryMd: 'ok' }, 'claude')

    expect(features.getTicketFull(byNumber.id).pr).toMatchObject({
      number: 7,
      linkedBy: 'prNumber',
      queue: { status: 'pending' },
      latestReview: { verdict: 'SHIP', fresh: true },
    })
    expect(features.getTicketFull(byBranch.id).pr).toMatchObject({ number: 8, linkedBy: 'branch' })
    expect(features.getTicketFull(outside.id).pr).toMatchObject({
      number: 9,
      url: 'https://github.com/acme/app/pull/9',
      queue: null,
    })

    // Without a GitHub slug the queue has no repo to refresh, so listPrs reads only what is stored.
    db.update(schema.repos).set({ githubRepo: null }).where(eq(schema.repos.id, repoId)).run()
    const queue = await prs.listPrs(pid)
    expect(queue.find((p) => p.number === 7)!.tickets.map((t) => t.id)).toEqual([byNumber.id])
    expect(queue.find((p) => p.number === 8)!.tickets.map((t) => t.id)).toEqual([byBranch.id])

    expect(reviews.listResults(pid, 20, { prNumber: 7, sha: 'abc7def' })).toHaveLength(1)
    expect(reviews.listResults(pid, 20, { prNumber: 7, sha: 'fff0000' })).toHaveLength(0)
  })

  it('gives attachments a path an agent can open', async () => {
    const uploads = await import('./uploads')
    const file = path.join(tmp, 'shot.png')
    fs.writeFileSync(file, 'png')
    const a = uploads.saveFromPath(file, 'enrique')
    const view = uploads.attachmentView(a, 'kali-linux')
    expect(fs.readFileSync(view.path, 'utf8')).toBe('png')
    expect(view.url).toBe(`/api/uploads/${a.id}`)
    expect(view.windowsPath).toBe(`\\\\wsl.localhost\\kali-linux${view.path.replace(/\//g, '\\')}`)
    expect(uploads.attachmentView(a, '')).not.toHaveProperty('windowsPath')
  })
})

describe('custom stages', () => {
  let stages: typeof import('./stages')
  let pid: number
  beforeAll(async () => {
    stages = await import('./stages')
    const { db, schema } = await import('#/db')
    pid = db.insert(schema.projects).values({ name: 'stages' }).returning().get().id
    db.insert(schema.repos).values({ projectId: pid, name: 'app', repoPath: '/r/stages' }).run()
  })
  const keys = () => stages.listStages(pid).map((s) => s.key)

  it('start from the defaults, with new tickets in To do', () => {
    expect(keys()).toEqual(['backlog', 'todo', 'in_progress', 'blocked', 'review', 'done', 'cancelled'])
    const t = features.createTicket(pid, { title: 'first' }, 'me')
    expect(t.status).toBe('todo')
    features.deleteTicket(t.id, 'me')
  })

  it('replace the defaults with a layout of their own', () => {
    for (const s of stages.listStages(pid)) if (s.key !== 'todo') stages.deleteStage(pid, s.id, {}, 'enrique')
    expect(() => stages.deleteStage(pid, stages.listStages(pid)[0]!.id, {}, 'enrique')).toThrow(
      /at least one/,
    )
    const add = (name: string, kind: import('#/lib/constants').StageKind) =>
      stages.createStage(pid, { name, kind }, 'enrique')
    add('Ideas', 'open')
    const build = add('Build', 'active')
    add('QA review', 'review')
    add('Ship', 'done')
    add('Dropped', 'cancelled')
    // Renaming keeps the key; the old To do becomes Spec, moved after Ideas.
    const todo = stages.listStages(pid).find((s) => s.key === 'todo')!
    stages.updateStage(pid, todo.id, { name: 'Spec' }, 'enrique')
    const byKey = new Map(stages.listStages(pid).map((s) => [s.key, s.id]))
    const order = ['ideas', 'todo', 'build', 'qa_review', 'ship', 'dropped']
    expect(() => stages.reorderStages(pid, [build.id], 'enrique')).toThrow(/every stage/)
    stages.reorderStages(
      pid,
      order.map((k) => byKey.get(k)!),
      'enrique',
    )
    expect(stages.listStages(pid).map((s) => s.name)).toEqual([
      'Ideas',
      'Spec',
      'Build',
      'QA review',
      'Ship',
      'Dropped',
    ])
    expect(add('Build', 'active').key).toBe('build_2')
  })

  it('resolve keys, names and kinds, and keep the rules by kind', () => {
    const t = features.createTicket(pid, { title: 'feature' }, 'me')
    // The last open stage is where new tickets start.
    expect(t.status).toBe('todo')
    expect(features.createTicket(pid, { title: 'idea', status: 'Ideas' }, 'me').status).toBe('ideas')
    expect(() => features.createTicket(pid, { title: 'x', status: 'nowhere' }, 'me')).toThrow(
      /no stage "nowhere"/,
    )
    expect(features.claimTicket(t.id, 'claude').status).toBe('build')
    expect(features.updateTicket(t.id, { status: 'review' }, 'claude').status).toBe('qa_review')
    expect(features.updateTicket(t.id, { status: 'qa review' }, 'claude').status).toBe('qa_review')
    const ids = (status: string[]) =>
      features
        .listTickets(pid, { status })
        .map((x) => x.title)
        .sort()
    expect(ids(['open'])).toEqual(['idea'])
    expect(ids(['review'])).toEqual(['feature'])
    features.setVerdict(t.id, 'disapproved', 'enrique')
    expect(features.getTicket(t.id).status).toBe('dropped')
    features.setVerdict(t.id, null, 'enrique', { reopenTo: 'qa_review' })
    expect(features.getTicket(t.id).status).toBe('qa_review')
    features.updateTicket(t.id, { status: 'Ship' }, 'enrique')
    expect(() => features.claimTicket(t.id, 'codex')).toThrow(/is done \(Ship\)/)
  })

  it("move a deleted stage's tickets where they are told", () => {
    const ship = stages.listStages(pid).find((s) => s.key === 'ship')!
    expect(() => stages.deleteStage(pid, ship.id, {}, 'enrique')).toThrow(/1 ticket in Ship/)
    expect(() => stages.deleteStage(pid, ship.id, { moveTo: 'ship' }, 'enrique')).toThrow(/no other stage/)
    stages.deleteStage(pid, ship.id, { moveTo: 'dropped' }, 'enrique')
    expect(features.listTickets(pid, { status: ['dropped'] }).map((t) => t.title)).toEqual(['feature'])
    expect(keys()).not.toContain('ship')
  })
})
