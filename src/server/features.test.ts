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

  it('carry a preview link agents set, change and clear', () => {
    const t = features.createTicket(projectId, { title: 'preview', repoId: otherRepo }, 'me')
    expect(() =>
      features.addWorkspace(t.id, { name: 'wt', previewUrl: 'javascript:alert(1)' }, 'codex'),
    ).toThrow(/http/)
    const ws = features.addWorkspace(t.id, { name: 'wt', previewUrl: 'http://localhost:47101' }, 'codex')
    expect(ws.previewUrl).toBe('http://localhost:47101')
    expect(features.getTicketFull(t.id).workspaces.map((w) => w.previewUrl)).toEqual([
      'http://localhost:47101',
    ])
    expect(features.setWorkspacePreview(ws.id, 'http://example.com:3000', 'codex').previewUrl).toBe(
      'http://example.com:3000',
    )
    // Only links on this machine are checked.
    expect(() => features.workspacePreview(ws.id)).toThrow(/localhost/)
    expect(() => features.setWorkspacePreview(ws.id, 'ftp://localhost', 'codex')).toThrow(/http/)
    expect(features.setWorkspacePreview(ws.id, null, 'codex').previewUrl).toBe('')
    expect(() => features.workspacePreview(ws.id)).toThrow(/no preview/)
    expect(() => features.setWorkspacePreview(999_999, '', 'codex')).toThrow(/not found/)
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

  it('shares tickets: an agent claims one, another can take it over', () => {
    const t = features.createTicket(pid, { title: 'claim me' }, 'enrique')
    expect(features.claimTicket(t.id, 'claude', { branch: 'feat/claim' })).toMatchObject({
      assignee: 'claude',
      status: 'in_progress',
      branch: 'feat/claim',
    })
    // Claiming again is harmless; another agent claiming or self-assigning takes it over.
    expect(features.claimTicket(t.id, 'claude').assignee).toBe('claude')
    expect(features.claimTicket(t.id, 'codex').assignee).toBe('codex')
    expect(features.updateTicket(t.id, { assignee: 'claude' }, 'claude', { agent: true }).assignee).toBe(
      'claude',
    )
    // The human reassigning from the UI.
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

  it('shows thread counts on the ticket and its posts, and the threads waiting on an agent', () => {
    const t = features.createTicket(pid, { title: 'threads', assignee: 'claude' }, 'enrique')
    const u = features.postUpdate(t.id, 'first pass done', [], 'claude')
    const other = features.createTicket(pid, { title: 'not mine', assignee: 'codex' }, 'enrique')
    features.addComment({ parentType: 'ticket', parentId: other.id, body: 'hi codex' }, 'enrique')

    expect(features.listOpenThreads(pid, 'claude')).toEqual([])
    // The human answers under the update: the agent owns it, so it waits on the agent.
    features.addComment({ parentType: 'update', parentId: u.id, body: 'looks off on mobile' }, 'enrique')
    features.addComment({ parentType: 'update', parentId: u.id, body: 'see the header' }, 'enrique')
    const full = features.getTicketFull(t.id)
    // The ticket's own thread is its posts.
    expect(full.thread).toMatchObject({ count: 1, lastAuthor: 'claude' })
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

  it('keeps one feed of posts: progress or discussion, with replies under each', () => {
    const t = features.createTicket(pid, { title: 'one feed', assignee: 'claude' }, 'enrique')
    const step = features.postUpdate(t.id, 'did X', [], 'claude')
    expect(step.progress).toBe(true)
    // A comment on the ticket is a post, not progress; with replyTo it is a reply under that post.
    const question = features.addComment({ parentType: 'ticket', parentId: t.id, body: 'why X?' }, 'enrique')
    expect(question).toMatchObject({ ticketId: t.id, progress: false, author: 'enrique' })
    const answer = features.addComment(
      { parentType: 'ticket', parentId: t.id, replyTo: question.id, body: 'because Y' },
      'claude',
    )
    expect(answer).toMatchObject({ parentType: 'update', parentId: question.id, replyTo: null })
    const elsewhere = features.createTicket(pid, { title: 'elsewhere' }, 'enrique')
    expect(() =>
      features.addComment(
        { parentType: 'ticket', parentId: elsewhere.id, replyTo: question.id, body: 'x' },
        'claude',
      ),
    ).toThrow(/is not on ticket/)

    const full = features.getTicketFull(t.id)
    expect(full.updates.map((u) => [u.body, u.progress, u.thread.count])).toEqual([
      ['why X?', false, 1],
      ['did X', true, 0],
    ])
    expect(full.thread).toMatchObject({ count: 2, lastAuthor: 'enrique' })
    expect(features.listComments('ticket', t.id).map((c) => [c.body, 'progress' in c && c.progress])).toEqual(
      [
        ['did X', true],
        ['why X?', false],
      ],
    )
  })

  it("counts only progress posts as a lane's last update", () => {
    const parent = features.createTicket(pid, { title: 'parent' }, 'enrique')
    const lane = features.createTicket(pid, { title: 'lane', parentId: parent.id }, 'claude')
    features.postUpdate(lane.id, 'built the form', [], 'claude')
    features.postUpdate(lane.id, 'which colour?', [], 'claude', { progress: false })
    expect(features.getTicketFull(parent.id).lanes[0]!.lastUpdate).toMatchObject({ text: 'built the form' })
  })

  it('lets the author or the human edit and delete a post or reply, nobody else', () => {
    const t = features.createTicket(pid, { title: 'edits' }, 'enrique')
    const p = features.postUpdate(t.id, 'first draft', [], 'claude')
    expect(() => features.editPost(p.id, { body: 'mine now' }, 'codex')).toThrow(/only claude or the human/)
    const edited = features.editPost(p.id, { body: 'second draft' }, 'claude')
    expect(edited.body).toBe('second draft')
    expect(edited.editedAt).toBeTruthy()
    // Flipping the mark alone is not an edit of the text.
    expect(features.editPost(p.id, { progress: false }, 'enrique', { human: true })).toMatchObject({
      progress: false,
      editedAt: edited.editedAt,
    })
    const r = features.addComment({ parentType: 'update', parentId: p.id, body: 'nice' }, 'enrique')
    features.addComment({ parentType: 'update', parentId: p.id, replyTo: r.id, body: 'thanks' }, 'claude')
    expect(() => features.deleteComment(r.id, 'claude')).toThrow(/only enrique or the human/)
    expect(features.editComment(r.id, 'very nice', 'enrique').body).toBe('very nice')
    features.deleteComment(r.id, 'enrique')
    expect(features.listComments('update', p.id)).toEqual([])
    // Deleting a post takes its replies with it.
    features.addComment({ parentType: 'update', parentId: p.id, body: 'one more' }, 'enrique')
    features.deletePost(p.id, 'enrique', { human: true })
    expect(features.getTicketFull(t.id).updates).toEqual([])
    expect(features.listComments('update', p.id)).toEqual([])
  })

  it("puts a question on an agent's ticket in its threads until it answers on the ticket", () => {
    const t = features.createTicket(pid, { title: 'ask me', assignee: 'claude' }, 'enrique')
    features.postUpdate(t.id, 'started', [], 'claude')
    features.addComment({ parentType: 'ticket', parentId: t.id, body: 'can you also do Y?' }, 'enrique')
    expect(features.listOpenThreads(pid, 'claude').filter((th) => th.ticketId === t.id)).toMatchObject([
      { parentType: 'ticket', parentId: t.id, waiting: 1, last: { author: 'enrique' } },
    ])
    features.addComment({ parentType: 'ticket', parentId: t.id, body: 'yes, on it' }, 'claude')
    expect(features.listOpenThreads(pid, 'claude').filter((th) => th.ticketId === t.id)).toEqual([])
  })

  it("keeps files with a ticket's instructions, with local paths, until removed or the ticket goes", async () => {
    const uploads = await import('./uploads')
    const { db, schema } = await import('#/db')
    const t = features.createTicket(pid, { title: 'with files' }, 'enrique')
    const a = await uploads.saveBase64('spec.md', Buffer.from('# spec').toString('base64'), 'enrique')
    const b = await uploads.saveBase64('mock.png', Buffer.from([0x89, 0x50]).toString('base64'), 'enrique')
    const files = features.attachToTicket(t.id, [a.id, b.id], 'enrique')
    expect(files.map((x) => [x.name, Boolean(x.path)])).toEqual([
      ['spec.md', true],
      ['mock.png', true],
    ])
    // A file already on something else is refused.
    expect(() => features.attachToTicket(t.id, [a.id], 'enrique')).toThrow(/already attached/)
    features.removeTicketFile(t.id, a.id, 'enrique')
    expect(features.getTicketFull(t.id).attachments.map((x) => x.name)).toEqual(['mock.png'])
    const other = features.createTicket(pid, { title: 'other' }, 'enrique')
    expect(() => features.removeTicketFile(other.id, b.id, 'enrique')).toThrow(/not found/)
    // Deleting the ticket takes its files' rows with it.
    features.deleteTicket(t.id, 'enrique')
    expect(db.select().from(schema.attachments).where(eq(schema.attachments.id, b.id)).get()).toBeUndefined()
  })

  it('creates a ticket with files, and creates nothing when one of them cannot be attached', async () => {
    const uploads = await import('./uploads')
    const a = await uploads.saveBase64('shot.png', Buffer.from([0x89, 0x50]).toString('base64'), 'enrique')
    const t = features.createTicket(pid, { title: 'born with files', attachmentIds: [a.id] }, 'enrique')
    expect(features.getTicketFull(t.id).attachments.map((x) => x.name)).toEqual(['shot.png'])
    const before = features.listTickets(pid).length
    expect(() =>
      features.createTicket(pid, { title: 'reuses a file', attachmentIds: [a.id] }, 'enrique'),
    ).toThrow(/already attached/)
    expect(() =>
      features.createTicket(pid, { title: 'no such file', attachmentIds: [999_999] }, 'enrique'),
    ).toThrow(/not found/)
    expect(features.listTickets(pid)).toHaveLength(before)
  })

  it('asks the human for a decision: blocks the ticket, and unblocks it once nothing is left open', () => {
    const t = features.createTicket(pid, { title: 'decide me', assignee: 'claude' }, 'enrique')
    features.claimTicket(t.id, 'claude')
    const options = [
      { label: 'Postgres', detail: 'one more service to run' },
      { label: 'SQLite', recommended: true },
    ]
    expect(() => features.askDecision(t.id, { body: 'which db?', options: [options[0]!] }, 'claude')).toThrow(
      /2 to 5/,
    )
    expect(() =>
      features.askDecision(
        t.id,
        { body: 'which db?', options: options.map((o) => ({ ...o, recommended: true })) },
        'claude',
      ),
    ).toThrow(/at most one/)

    const q1 = features.askDecision(t.id, { body: 'which db?', options }, 'claude')
    const q2 = features.askDecision(t.id, { body: 'which cache?', options }, 'claude')
    expect(q1).toMatchObject({
      progress: false,
      decision: [{ label: 'Postgres' }, { label: 'SQLite', recommended: true }],
    })
    expect(features.getTicket(t.id).status).toBe('blocked')
    expect(features.listTickets(pid, { q: 'decide me' })[0]!.decisions).toBe(2)

    // Deciding one: answered as a reply under the card; the other keeps the ticket blocked.
    expect(() => features.decide(q1.id, 5, '', 'enrique')).toThrow(/no option 5/)
    features.decide(q1.id, 1, 'keep it simple', 'enrique')
    expect(features.getPost(q1.id)).toMatchObject({ decidedOption: 1, decidedBy: 'enrique' })
    expect(features.listComments('update', q1.id).map((c) => c.body)).toEqual([
      'Decided: **SQLite**\n\nkeep it simple',
    ])
    expect(features.getTicket(t.id).status).toBe('blocked')
    // The agent sees the answer waiting on it.
    expect(features.listOpenThreads(pid, 'claude').some((th) => th.parentId === q1.id)).toBe(true)

    features.decide(q2.id, 0, '', 'enrique')
    expect(features.getTicket(t.id).status).toBe('in_progress')
    expect(features.listTickets(pid, { q: 'decide me' })[0]!.decisions).toBe(0)
    // Changing an answer says so.
    features.decide(q2.id, 1, '', 'enrique')
    expect(features.listComments('update', q2.id).at(-1)!.body).toBe('Changed the decision to: **SQLite**')
    // A plain post is not a decision.
    const plain = features.postUpdate(t.id, 'just a note', [], 'claude')
    expect(() => features.decide(plain.id, 0, '', 'enrique')).toThrow(/not a decision/)
    // block: false leaves the stage alone.
    features.askDecision(t.id, { body: 'naming?', options, block: false }, 'claude')
    expect(features.getTicket(t.id).status).toBe('in_progress')
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
    const a = await uploads.saveFromPath(file, 'enrique')
    const view = uploads.attachmentView(a, 'kali-linux')
    expect(fs.readFileSync(view.path, 'utf8')).toBe('png')
    expect(view.url).toBe(`/api/uploads/${a.id}`)
    expect(view.windowsPath).toBe(`\\\\wsl.localhost\\kali-linux${view.path.replace(/\//g, '\\')}`)
    expect(uploads.attachmentView(a, '')).not.toHaveProperty('windowsPath')
  })
})

describe("the project's agents", () => {
  let pid: number
  beforeAll(async () => {
    const { db, schema } = await import('#/db')
    pid = db.insert(schema.projects).values({ name: 'crew' }).returning().get().id
    db.insert(schema.repos).values({ projectId: pid, name: 'site', repoPath: '/r/site' }).run()
  })

  it("reserves a ticket assigned to one of the project's agents", async () => {
    const agents = await import('./projectAgents')
    agents.createAgent(pid, { name: 'Reviewer', instructions: 'Review like a hawk.' }, 'enrique')
    // The human assigns it (any casing); the ticket carries the agent's name and instructions.
    const t = features.createTicket(pid, { title: 'review the auth flow' }, 'enrique')
    features.updateTicket(t.id, { assignee: 'reviewer' }, 'enrique')
    const full = features.getTicketFull(t.id)
    expect(full).toMatchObject({ assignee: 'Reviewer', reserved: true })
    expect(full.agent).toMatchObject({ name: 'Reviewer', instructions: 'Review like a hawk.' })
    expect(features.listTickets(pid, { q: 'auth flow' })[0]!.reserved).toBe(true)

    // No other agent takes it, as itself or as another agent, and agents cannot reassign it.
    agents.createAgent(pid, { name: 'Writer' }, 'enrique')
    expect(() => features.claimTicket(t.id, 'codex')).toThrow(
      /reserved for Reviewer: claim it with as: "Reviewer"/,
    )
    expect(() => features.claimTicket(t.id, 'codex', { as: 'Writer' })).toThrow(
      /reserved for Reviewer, not Writer/,
    )
    expect(() => features.updateTicket(t.id, { assignee: 'codex' }, 'codex', { agent: true })).toThrow(
      /only the human reassigns it/,
    )
    expect(() => features.claimTicket(t.id, 'codex', { as: 'nobody' })).toThrow(
      /not one of this project's agents/,
    )

    // Any connected agent works it as the reviewer; its posts carry the reviewer's name, via the agent.
    expect(features.claimTicket(t.id, 'codex', { as: 'reviewer' })).toMatchObject({
      assignee: 'Reviewer',
      status: 'in_progress',
    })
    expect(features.postUpdate(t.id, 'looked at it', [], 'codex', { as: 'Reviewer' })).toMatchObject({
      author: 'Reviewer',
      via: 'codex',
    })

    // The human can still hand it to anyone; a rename carries the reservation along, a removal frees it.
    const r = agents.findAgent(pid, 'reviewer')!
    agents.updateAgent(r.id, { name: 'Auditor' }, 'enrique')
    expect(features.getTicket(t.id).assignee).toBe('Auditor')
    agents.deleteAgent(r.id, 'enrique')
    expect(features.getTicketFull(t.id)).toMatchObject({ assignee: '', reserved: false, agent: null })
  })

  it("validates the project's agents' names", async () => {
    const agents = await import('./projectAgents')
    agents.createAgent(pid, { name: 'qa-bot' }, 'enrique')
    expect(() => agents.createAgent(pid, { name: 'QA-Bot' }, 'enrique')).toThrow(
      /already has an agent called/,
    )
    expect(() => agents.createAgent(pid, { name: 'two words' }, 'enrique')).toThrow(/letters, digits/)
    expect(agents.mentions('ask @QA-bot and @qa-bot, not me@mail.com or @@x')).toEqual(['qa-bot'])
  })

  it('lists the threads waiting on one of the project agents for whoever answers as it', async () => {
    const agents = await import('./projectAgents')
    agents.createAgent(pid, { name: 'Designer' }, 'enrique')
    const t = features.createTicket(pid, { title: 'new logo' }, 'enrique')
    features.addComment(
      { parentType: 'ticket', parentId: t.id, body: '@designer can you take a look?' },
      'enrique',
    )
    const waiting = () => features.listOpenThreads(pid, 'codex').filter((th) => th.ticketId === t.id)
    expect(waiting()).toMatchObject([{ as: 'Designer', waiting: 1, last: { author: 'enrique' } }])
    // A human cannot speak as an agent through the API, but a connected agent answering as it clears the thread.
    features.addComment({ parentType: 'ticket', parentId: t.id, body: 'On it.', as: 'Designer' }, 'codex')
    expect(waiting()).toEqual([])
    // Someone replying to the agent puts it back on the list.
    features.addComment({ parentType: 'ticket', parentId: t.id, body: 'thanks!' }, 'enrique')
    expect(waiting()).toMatchObject([{ as: 'Designer', waiting: 1 }])
  })
})

describe('PR reviews', () => {
  it('close as done when approved, cancelled when disapproved', async () => {
    const { db, schema } = await import('#/db')
    const pid = db.insert(schema.projects).values({ name: 'reviews' }).returning().get().id
    db.insert(schema.repos).values({ projectId: pid, name: 'app', repoPath: '/r/reviews' }).run()
    const queue = features.createTicket(pid, { title: 'Review queue', tags: ['PR'] }, 'claude')
    const ok = features.createTicket(
      pid,
      { title: 'PR #7: retries', parentId: queue.id, tags: ['pr'], prNumber: 7, status: 'review' },
      'claude',
    )
    const bad = features.createTicket(
      pid,
      { title: 'PR #8: login', parentId: queue.id, tags: ['PR'], prNumber: 8, status: 'review' },
      'claude',
    )
    expect(features.setVerdict(ok.id, 'approved', 'enrique').status).toBe('done')
    expect(features.setVerdict(bad.id, 'disapproved', 'enrique').status).toBe('cancelled')
    // Taking the approval back returns it to review; a ticket without the tag keeps its stage.
    expect(features.setVerdict(ok.id, null, 'enrique').status).toBe('review')
    const plain = features.createTicket(pid, { title: 'feature', status: 'review' }, 'me')
    expect(features.setVerdict(plain.id, 'approved', 'enrique').status).toBe('review')
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

describe('the archive', () => {
  let pid: number
  let cleanup: typeof import('./cleanup')
  beforeAll(async () => {
    cleanup = await import('./cleanup')
    const { db, schema } = await import('#/db')
    pid = db.insert(schema.projects).values({ name: 'archive' }).returning().get().id
    db.insert(schema.repos).values({ projectId: pid, name: 'app', repoPath: '/r/archive' }).run()
  })
  const titles = (filter: import('./features').TicketFilter = {}) =>
    features
      .listTickets(pid, filter)
      .map((t) => t.title)
      .sort()

  it('archives one done ticket with its lanes, and restores them', () => {
    const shipped = features.createTicket(pid, { title: 'shipped', status: 'done' }, 'me')
    const lane = features.createTicket(pid, { title: 'shipped lane', parentId: shipped.id }, 'claude')
    const sub = features.createTicket(pid, { title: 'shipped sub', parentId: lane.id }, 'claude')
    const open = features.createTicket(pid, { title: 'open' }, 'me')

    // Only finished top-level tickets: a lane goes with its ticket.
    expect(() => features.archiveTicket(open.id, 'enrique')).toThrow(/only done or cancelled/)
    expect(() => features.archiveTicket(lane.id, 'enrique')).toThrow(/is a lane/)

    const archived = features.archiveTicket(shipped.id, 'enrique')
    expect(archived.archivedAt).not.toBeNull()
    expect(archived.archivedBy).toBe('enrique')
    for (const id of [lane.id, sub.id]) expect(features.getTicket(id).archivedBy).toBe('enrique')
    expect(titles()).toEqual(['open'])
    expect(titles({ archived: 'only' })).toEqual(['shipped', 'shipped lane', 'shipped sub'])
    expect(titles({ archived: 'include', parentId: null })).toEqual(['open', 'shipped'])
    // Its page still opens, lanes and all.
    const full = features.getTicketFull(shipped.id)
    expect(full.archivedAt).toBe(archived.archivedAt)
    expect(full.lanes.map((l) => l.id)).toEqual([lane.id])
    // Nobody picks up an archived lane.
    expect(() => features.claimTicket(lane.id, 'codex')).toThrow(/archived/)

    features.restoreTicket(shipped.id, 'enrique')
    for (const id of [shipped.id, lane.id, sub.id]) {
      expect(features.getTicket(id).archivedAt).toBeNull()
      expect(features.getTicket(id).archivedBy).toBe('')
    }
    expect(titles()).toEqual(['open', 'shipped', 'shipped lane', 'shipped sub'])
    expect(titles({ archived: 'only' })).toEqual([])
  })

  it("archives every ticket in one done stage, that stage's only", async () => {
    const { db, schema } = await import('#/db')
    const { createStage } = await import('./stages')
    createStage(pid, { name: 'Released', kind: 'done' }, 'enrique')
    for (const t of features.listTickets(pid, { parentId: null })) features.deleteTicket(t.id, 'me')
    const a = features.createTicket(pid, { title: 'a', status: 'done', branch: 'feat/a' }, 'me')
    const aLane = features.createTicket(pid, { title: 'a lane', parentId: a.id, status: 'review' }, 'me')
    features.createTicket(pid, { title: 'b', status: 'done' }, 'me')
    features.createTicket(pid, { title: 'released', status: 'Released' }, 'me')
    features.createTicket(pid, { title: 'dropped', status: 'cancelled' }, 'me')
    features.createTicket(pid, { title: 'review', status: 'review' }, 'me')

    expect(() => features.archiveStage(pid, 'review', 'enrique')).toThrow(/not a done or cancelled/)
    const res = features.archiveStage(pid, 'done', 'enrique')
    expect(res.stage).toBe('done')
    expect(res.ids).toHaveLength(2)
    expect(features.getTicket(aLane.id).archivedAt).not.toBeNull()
    expect(titles({ parentId: null })).toEqual(['dropped', 'released', 'review'])
    expect(titles({ archived: 'only' })).toEqual(['a', 'a lane', 'b'])
    // Again: nothing left in that stage.
    expect(features.archiveStage(pid, 'done', 'enrique').ids).toEqual([])
    expect(features.archiveStage(pid, 'Released', 'enrique').ids).toHaveLength(1)

    const log = db
      .select()
      .from(schema.activity)
      .where(eq(schema.activity.projectId, pid))
      .all()
      .map((r) => r.text)
    expect(log).toContain(`archived 2 tickets from Done (#${res.ids.join(', #')}), with 1 lane`)

    // Archived work is still finished work for the cleanup report, whatever stage a lane was in.
    const report = await cleanup.cleanupReport(pid, { reach: false })
    expect(report.tickets).toEqual([])
    features.addWorkspace(aLane.id, { name: 'wt', branch: 'lane/a' }, 'claude')
    expect((await cleanup.cleanupReport(pid, { reach: false })).tickets.map((t) => t.id)).toEqual([aLane.id])
  })

  it("is the human's: agents get 403", async () => {
    const { api } = await import('./api')
    const t = features.createTicket(pid, { title: 'agent try', status: 'done' }, 'me')
    const call = (path: string, body?: unknown) =>
      api.handle(
        new Request(`http://board${path}`, {
          method: 'POST',
          headers: { authorization: 'Bearer gate_x', 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        'claude',
      )
    for (const [path, body] of [
      [`/api/tickets/${t.id}/archive`],
      [`/api/tickets/${t.id}/restore`],
      [`/api/projects/${pid}/tickets/archive`, { status: 'done' }],
    ] as const)
      await expect(call(path, body)).rejects.toMatchObject({ status: 403 })
    expect(features.getTicket(t.id).archivedAt).toBeNull()
  })
})
