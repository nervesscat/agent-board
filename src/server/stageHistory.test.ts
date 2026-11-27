import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import type { MyGhPr } from './git'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-stage-history-'))
process.env.DATA_DIR = tmp

// gh answers from a fixture: the PR queue finds whatever `found` holds.
let found: MyGhPr[] = []
vi.mock('./git', async (original) => ({
  ...(await original<typeof import('./git')>()),
  listMyPrs: async () => found,
  currentGithubLogin: async () => 'enrique',
  prMerged: async () => false,
  prStateOf: async () => null,
}))

const HUMAN = 'enrique'
const AGENT = 'claude'

let dbm: typeof import('#/db')
let features: typeof import('./features')
let stages: typeof import('./stages')
let history: typeof import('./stageHistory')
let handle: (request: Request) => Promise<Response>
beforeAll(async () => {
  dbm = await import('#/db')
  features = await import('./features')
  stages = await import('./stages')
  history = await import('./stageHistory')
  ;(await import('./actors')).noteActor(HUMAN, 'human')
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  // As the server answers: an HttpError becomes its status with `{error}`. A bearer token is an agent.
  const guarded = guard(({ request }: { request: Request }) =>
    api.handle(request, request.headers.has('authorization') ? AGENT : HUMAN),
  )
  handle = (request) => guarded({ request })
})

let projects = 0
function newProject(name = `history-${++projects}`) {
  const id = dbm.db.insert(dbm.schema.projects).values({ name }).returning().get().id
  dbm.db
    .insert(dbm.schema.repos)
    .values({ projectId: id, name: 'app', repoPath: `/r/${name}`, githubRepo: 'acme/app' })
    .run()
  return id
}

async function call(method: string, pathname: string, body?: unknown, as: 'human' | 'agent' = 'human') {
  const res = await handle(
    new Request(`http://localhost${pathname}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(as === 'agent' ? { authorization: 'Bearer gate_test' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
  return { status: res.status, body: (await res.json()) as any }
}

let rpcId = 0
/** An agent's MCP tool call: its parsed result, or `{error}` with the message of a refused call. */
async function tool(name: string, args: Record<string, unknown>) {
  const { handleMcp } = await import('./mcp')
  const res = await handleMcp(
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer gate_test',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }),
    AGENT,
  )
  const result = ((await res.json()) as { result: { isError?: boolean; content: { text: string }[] } }).result
  return result.isError ? { error: result.content[0]!.text } : JSON.parse(result.content[0]!.text)
}

const ghPr = (number: number, head: string, mergedAt: string | null): MyGhPr => ({
  number,
  title: `pr ${number}`,
  url: `https://github.com/acme/app/pull/${number}`,
  author: { login: 'enrique' },
  headRefName: head,
  baseRefName: 'main',
  headRefOid: 'a1b2c3',
  isDraft: false,
  reviewDecision: '',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  statusCheckRollup: [],
  updatedAt: '2026-10-01T10:00:00Z',
  mergedAt,
  reviews: [],
  comments: [],
  reviewRequests: [],
  requested: false,
  assigned: false,
  involvesMe: true,
})

const stageRows = (ticketId: number) =>
  dbm.db
    .select()
    .from(dbm.schema.ticketEvents)
    .where(eq(dbm.schema.ticketEvents.ticketId, ticketId))
    .orderBy(dbm.schema.ticketEvents.id)
    .all()
    .filter((e) => e.kind === 'stage')
/** Each move as [from, to, by, how]. */
const moves = (ticketId: number) => history.stageHistoryOf(ticketId).map((e) => [e.from, e.to, e.by, e.how])
const last = (ticketId: number) => moves(ticketId).at(-1)
const row = (ticketId: number) => features.getTicket(ticketId)

describe('every stage change is an event with who and how', () => {
  it('creation, the human’s and an agent’s moves and claims, the verdict and decision cards', async () => {
    const pid = newProject()
    const t = features.createTicket(pid, { title: 'moves' }, HUMAN)
    expect(last(t.id)).toEqual([null, 'todo', HUMAN, 'human'])
    expect((await tool('claim_ticket', { ticketId: t.id })).status).toBe('in_progress')
    expect(last(t.id)).toEqual(['todo', 'in_progress', AGENT, 'agent'])
    expect((await tool('update_ticket', { ticketId: t.id, status: 'review' })).status).toBe('review')
    expect(last(t.id)).toEqual(['in_progress', 'review', AGENT, 'agent'])
    expect((await call('PATCH', `/api/tickets/${t.id}`, { status: 'blocked' })).status).toBe(200)
    expect(last(t.id)).toEqual(['review', 'blocked', HUMAN, 'human'])
    await call('PATCH', `/api/tickets/${t.id}`, { status: 'review' })
    expect((await call('PUT', `/api/tickets/${t.id}/approval`, { verdict: 'approved' })).status).toBe(200)
    expect(last(t.id)).toEqual(['review', 'approved', HUMAN, 'verdict'])
    await call('PUT', `/api/tickets/${t.id}/approval`, { verdict: null })
    expect(last(t.id)).toEqual(['approved', 'review', HUMAN, 'verdict'])
    await call('PUT', `/api/tickets/${t.id}/approval`, { verdict: 'disapproved' })
    expect(last(t.id)).toEqual(['review', 'cancelled', HUMAN, 'verdict'])
    await call('PUT', `/api/tickets/${t.id}/approval`, { verdict: null, reopenTo: 'in_progress' })
    expect(last(t.id)).toEqual(['cancelled', 'in_progress', HUMAN, 'verdict'])
    const card = features.askDecision(
      t.id,
      { body: 'Which?', options: [{ label: 'A' }, { label: 'B' }] },
      AGENT,
    )
    expect(last(t.id)).toEqual(['in_progress', 'blocked', 'board', 'board'])
    features.decide(card.id, 0, '', HUMAN)
    expect(last(t.id)).toEqual(['blocked', 'in_progress', 'board', 'board'])
    // An agent's create is the agent's.
    const made = await tool('create_ticket', { projectId: pid, title: 'by an agent' })
    expect(moves(made.id)).toEqual([[null, 'todo', AGENT, 'agent']])
  })

  it('tells the four ways apart, and adds no event for a write that keeps the stage', async () => {
    const pid = newProject()
    const t = features.createTicket(pid, { title: 'kept', status: 'review' }, HUMAN)
    const before = stageRows(t.id).length
    await call('PATCH', `/api/tickets/${t.id}`, { title: 'renamed' })
    await call('PATCH', `/api/tickets/${t.id}`, { status: 'review' })
    await tool('update_ticket', { ticketId: t.id, tags: ['x'] })
    expect(stageRows(t.id)).toHaveLength(before)
    // The rows stay the board's: a move never reads as an agent's word on the timeline.
    for (const e of stageRows(t.id)) expect([e.agent, e.by]).toEqual(['board', 'board'])
    const { STAGE_HOWS } = await import('#/lib/constants')
    expect(new Set(STAGE_HOWS).size).toBe(4)
  })

  it('the board’s own moves: a PR’s own ticket, a superseded one, and a deleted stage’s tickets', async () => {
    const pid = newProject()
    const prs = await import('./prs')
    found = [ghPr(8, 'feat/nobody', null)]
    await prs.refreshPrs(pid)
    const own = dbm.db
      .select()
      .from(dbm.schema.tickets)
      .where(eq(dbm.schema.tickets.projectId, pid))
      .all()
      .find((r) => r.prNumber === 8)!
    expect(moves(own.id)).toEqual([[null, own.status, 'board', 'board']])
    found = [ghPr(8, 'feat/nobody', new Date().toISOString())]
    await prs.refreshPrs(pid)
    expect(last(own.id)).toEqual([own.status, row(own.id).status, 'board', 'board'])
    found = []

    found = [ghPr(9, 'feat/taken', null)]
    await prs.refreshPrs(pid)
    const own9 = dbm.db
      .select()
      .from(dbm.schema.tickets)
      .where(eq(dbm.schema.tickets.projectId, pid))
      .all()
      .find((r) => r.prNumber === 9)!
    features.createTicket(pid, { title: 'takes it', branch: 'feat/taken' }, HUMAN)
    expect(last(own9.id)).toEqual([own9.status, 'cancelled', 'board', 'board'])
    found = []

    const parked = stages.createStage(pid, { name: 'Parked', kind: 'open' }, HUMAN)
    const t = features.createTicket(pid, { title: 'parked', status: parked.key }, HUMAN)
    stages.deleteStage(pid, parked.id, { moveTo: 'review' }, HUMAN)
    expect(last(t.id)).toEqual([parked.key, 'review', HUMAN, 'board'])
  })
})

describe('the approval fields follow the stage', () => {
  it('a human’s move into Approved sets them, as the ticket found in Approved without them lacked', async () => {
    const pid = newProject()
    const t = features.createTicket(pid, { title: 'dragged', status: 'review' }, AGENT)
    const res = await call('PATCH', `/api/tickets/${t.id}`, { status: 'approved' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'approved', approvedBy: HUMAN, closedByApproval: false })
    expect(Date.parse(res.body.approvedAt)).not.toBeNaN()
    expect(last(t.id)).toEqual(['review', 'approved', HUMAN, 'human'])
  })

  it('clears a disapproval when the human moves the ticket into Approved', async () => {
    const pid = newProject()
    const t = features.createTicket(pid, { title: 'rejected', status: 'review' }, AGENT)
    features.setVerdict(t.id, 'disapproved', HUMAN)
    const res = await call('PATCH', `/api/tickets/${t.id}`, { status: 'approved' })
    expect(res.body).toMatchObject({ approvedBy: HUMAN, disapprovedAt: null, disapprovedBy: '' })
  })

  it('the verdict still sets them, and so does the board: a ticket created there, a deleted stage moved there', () => {
    const pid = newProject()
    const judged = features.createTicket(pid, { title: 'judged', status: 'review' }, AGENT)
    expect(features.setVerdict(judged.id, 'approved', HUMAN)).toMatchObject({
      status: 'approved',
      approvedBy: HUMAN,
    })
    const created = features.createTicket(pid, { title: 'made there', status: 'approved' }, HUMAN)
    expect(created).toMatchObject({ status: 'approved', approvedBy: HUMAN })
    expect(created.approvedAt).not.toBeNull()

    const hold = stages.createStage(pid, { name: 'Hold', kind: 'review' }, HUMAN)
    const held = features.createTicket(pid, { title: 'held', status: hold.key }, AGENT)
    const lane = features.createTicket(pid, { title: 'lane', parentId: held.id, status: hold.key }, AGENT)
    stages.deleteStage(pid, hold.id, { moveTo: 'approved' }, HUMAN)
    expect(row(held.id)).toMatchObject({ status: 'approved', approvedBy: HUMAN })
    expect(row(held.id).approvedAt).not.toBeNull()
    expect(last(held.id)).toEqual([hold.key, 'approved', HUMAN, 'board'])
    // A lane has no call of its own: its stage is the call.
    expect(row(lane.id)).toMatchObject({ status: 'approved', approvedAt: null, approvedBy: '' })
  })

  it('clear when the approval is taken back: the verdict withdrawn, or a move out of Approved but to done', async () => {
    const pid = newProject()
    const withdrawn = features.createTicket(pid, { title: 'withdrawn', status: 'review' }, AGENT)
    features.setVerdict(withdrawn.id, 'approved', HUMAN)
    expect(features.setVerdict(withdrawn.id, null, HUMAN)).toMatchObject({ approvedAt: null, approvedBy: '' })

    for (const to of ['review', 'in_progress', 'todo', 'blocked']) {
      const t = features.createTicket(pid, { title: `back to ${to}`, status: 'review' }, AGENT)
      await call('PATCH', `/api/tickets/${t.id}`, { status: 'approved' })
      const res = await call('PATCH', `/api/tickets/${t.id}`, { status: to })
      expect(res.body).toMatchObject({
        status: to,
        approvedAt: null,
        approvedBy: '',
        closedByApproval: false,
      })
    }
    // An agent's move out of Approved (back to work on a conflict) takes it back too.
    const fixed = features.createTicket(pid, { title: 'conflict', status: 'review' }, AGENT)
    features.setVerdict(fixed.id, 'approved', HUMAN)
    expect(await tool('update_ticket', { ticketId: fixed.id, status: 'in_progress' })).toMatchObject({
      approvedAt: null,
      approvedBy: '',
    })

    const merged = features.createTicket(pid, { title: 'merged', status: 'review' }, AGENT)
    const approved = features.setVerdict(merged.id, 'approved', HUMAN)
    expect(await tool('update_ticket', { ticketId: merged.id, status: 'done' })).toMatchObject({
      status: 'done',
      approvedAt: approved.approvedAt,
      approvedBy: HUMAN,
    })
  })
})

describe('the human’s send-backs', () => {
  it('a human’s move from review or Approved back to work is one, with a stage event; an agent’s or the board’s is not', async () => {
    const pid = newProject()
    const t = features.createTicket(pid, { title: 'sent back', status: 'review' }, AGENT)
    await call('PATCH', `/api/tickets/${t.id}`, { status: 'in_progress' })
    const [back] = history.sendBacksOf(t.id)
    expect(back).toMatchObject({ from: 'review', to: 'in_progress', by: HUMAN, reason: null })
    expect(back!.eventId).toBe(history.stageHistoryOf(t.id).at(-1)!.id)
    // From Approved to the start stage counts as well.
    await call('PATCH', `/api/tickets/${t.id}`, { status: 'review' })
    await call('PATCH', `/api/tickets/${t.id}`, { status: 'approved' })
    await call('PATCH', `/api/tickets/${t.id}`, { status: 'todo' })
    expect(history.sendBacksOf(t.id).map((b) => [b.from, b.to])).toEqual([
      ['review', 'in_progress'],
      ['approved', 'todo'],
    ])
    // Review to blocked or cancelled is not one.
    await call('PATCH', `/api/tickets/${t.id}`, { status: 'review' })
    await call('PATCH', `/api/tickets/${t.id}`, { status: 'blocked' })
    expect(history.sendBacksOf(t.id)).toHaveLength(2)

    const agents = features.createTicket(pid, { title: 'agent moves', status: 'review' }, AGENT)
    await tool('update_ticket', { ticketId: agents.id, status: 'in_progress' })
    const boards = features.createTicket(pid, { title: 'board moves', status: 'review' }, AGENT)
    features.askDecision(boards.id, { body: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }, AGENT)
    expect(history.sendBacksOf(agents.id)).toEqual([])
    expect(history.sendBacksOf(boards.id)).toEqual([])
  })

  it('carries an optional reason, given with the move or set afterwards; any other value is a 400', async () => {
    const pid = newProject()
    const t = features.createTicket(pid, { title: 'reasons', status: 'review' }, AGENT)
    const moved = await call('PATCH', `/api/tickets/${t.id}`, {
      status: 'in_progress',
      sendBackReason: 'defect',
    })
    expect(moved.status).toBe(200)
    const [back] = history.sendBacksOf(t.id)
    expect(back).toMatchObject({ reason: 'defect', reasonBy: HUMAN })
    const changed = await call('PUT', `/api/tickets/${t.id}/send-backs/${back!.id}`, { reason: 'new-ask' })
    expect(changed).toMatchObject({ status: 200, body: { reason: 'new-ask' } })
    expect(
      (await call('PUT', `/api/tickets/${t.id}/send-backs/${back!.id}`, { reason: null })).body.reason,
    ).toBe(null)
    expect(
      (await call('PUT', `/api/tickets/${t.id}/send-backs/${back!.id}`, { reason: 'other' })).status,
    ).toBe(400)
    expect(
      (await call('PUT', `/api/tickets/${t.id}/send-backs/${back!.id}`, { reason: 'defect' }, 'agent'))
        .status,
    ).toBe(403)
    expect(history.sendBacksOf(t.id)[0]!.reason).toBe(null)

    await call('PATCH', `/api/tickets/${t.id}`, { status: 'review' })
    const refused = await call('PATCH', `/api/tickets/${t.id}`, {
      status: 'in_progress',
      sendBackReason: 'other',
    })
    expect(refused.status).toBe(400)
    // A reason with a move that is not a send-back is refused, and nothing moves.
    const notBack = await call('PATCH', `/api/tickets/${t.id}`, {
      status: 'blocked',
      sendBackReason: 'defect',
    })
    expect(notBack.status).toBe(400)
    expect(row(t.id).status).toBe('review')
  })

  it('a human comment naming exactly one reason fills a reason-less latest send-back; a pick wins', async () => {
    const pid = newProject()
    const t = features.createTicket(pid, { title: 'commented', status: 'review' }, AGENT)
    await call('PATCH', `/api/tickets/${t.id}`, { status: 'in_progress' })
    // Two values named, or an agent's words: nothing is taken.
    await call('POST', `/api/tickets/${t.id}/updates`, { body: 'a defect or a new-ask?', progress: false })
    await call('POST', `/api/tickets/${t.id}/updates`, { body: 'looks like a defect' }, 'agent')
    expect(history.sendBacksOf(t.id)[0]!.reason).toBe(null)
    // A word inside another one is not the value.
    await call('POST', '/api/comments', { parentType: 'ticket', parentId: t.id, body: 'no defects here' })
    expect(history.sendBacksOf(t.id)[0]!.reason).toBe(null)
    await call('POST', '/api/comments', {
      parentType: 'ticket',
      parentId: t.id,
      body: 'Changed-Mind: drop the toggle',
    })
    expect(history.sendBacksOf(t.id)[0]).toMatchObject({ reason: 'changed-mind', reasonBy: HUMAN })
    // It has a reason now: a later comment does not replace it.
    await call('POST', '/api/comments', { parentType: 'ticket', parentId: t.id, body: 'well, a defect' })
    expect(history.sendBacksOf(t.id)[0]!.reason).toBe('changed-mind')

    // The next send-back, picked with the move: a comment never replaces a pick.
    await call('PATCH', `/api/tickets/${t.id}`, { status: 'review' })
    await call('PATCH', `/api/tickets/${t.id}`, { status: 'in_progress', sendBackReason: 'new-ask' })
    const post = await call('POST', `/api/tickets/${t.id}/updates`, { body: 'context', progress: false })
    await call('POST', '/api/comments', { parentType: 'update', parentId: post.body.id, body: 'defect' })
    expect(history.sendBacksOf(t.id).map((b) => b.reason)).toEqual(['changed-mind', 'new-ask'])
  })

  it('get_ticket lists them and counts them; a ticket with none reads 0 and an empty list', async () => {
    const pid = newProject()
    const t = features.createTicket(pid, { title: 'counted', status: 'review' }, HUMAN)
    const none = await tool('get_ticket', { ticketId: t.id })
    expect(none).toMatchObject({ sendBacks: [], sendBackCount: 0, mergedAt: null })
    await call('PATCH', `/api/tickets/${t.id}`, { status: 'in_progress', sendBackReason: 'defect' })
    await call('PATCH', `/api/tickets/${t.id}`, { status: 'review' })
    await call('PATCH', `/api/tickets/${t.id}`, { status: 'todo' })
    const view = await tool('get_ticket', { ticketId: t.id })
    expect(view.sendBackCount).toBe(2)
    expect(view.sendBacks.map((b: any) => [b.from, b.to, b.by, b.reason])).toEqual([
      ['review', 'in_progress', HUMAN, 'defect'],
      ['review', 'todo', HUMAN, null],
    ])
    expect(view.stageHistory.map((e: any) => [e.from, e.to, e.by, e.how])).toEqual([
      [null, 'review', HUMAN, 'human'],
      ['review', 'in_progress', HUMAN, 'human'],
      ['in_progress', 'review', HUMAN, 'human'],
      ['review', 'todo', HUMAN, 'human'],
    ])
    for (const e of view.stageHistory) expect(Date.parse(e.at)).not.toBeNaN()
  })
})

describe('the merge time', () => {
  it('is GitHub’s mergedAt, stored on the tickets naming the PR when the board first sees the merge', async () => {
    const pid = newProject()
    const t = features.createTicket(pid, { title: 'merging', status: 'review', branch: 'feat/m' }, HUMAN)
    const prs = await import('./prs')
    found = [ghPr(7, 'feat/m', null)]
    await prs.refreshPrs(pid)
    expect(row(t.id).mergedAt).toBeNull()
    const mergedAt = '2026-10-02T08:30:00Z'
    found = [ghPr(7, 'feat/m', mergedAt)]
    await prs.refreshPrs(pid)
    expect(row(t.id).mergedAt).toBe(mergedAt)
    expect((await tool('get_ticket', { ticketId: t.id })).mergedAt).toBe(mergedAt)
    found = []
  })
})

describe('a ticket with no history', () => {
  it('reads everywhere: no events at all, or only stage rows from before who and how were kept', async () => {
    const pid = newProject()
    const bare = features.createTicket(pid, { title: 'bare' }, HUMAN)
    dbm.db.delete(dbm.schema.ticketEvents).where(eq(dbm.schema.ticketEvents.ticketId, bare.id)).run()
    const old = features.createTicket(pid, { title: 'old' }, HUMAN)
    dbm.db.delete(dbm.schema.ticketEvents).where(eq(dbm.schema.ticketEvents.ticketId, old.id)).run()
    // The shape a stage row had before: the board's, with no who and no how.
    dbm.db
      .insert(dbm.schema.ticketEvents)
      .values({
        ticketId: old.id,
        projectId: pid,
        kind: 'stage',
        agent: 'board',
        by: 'board',
        toStage: 'todo',
      })
      .run()
    for (const t of [bare, old]) {
      const view = await tool('get_ticket', { ticketId: t.id })
      expect(view).toMatchObject({ sendBacks: [], sendBackCount: 0, mergedAt: null })
      expect((await call('GET', `/api/tickets/${t.id}`)).status).toBe(200)
      expect((await call('GET', `/api/tickets/${t.id}/events`)).status).toBe(200)
    }
    expect((await tool('get_ticket', { ticketId: bare.id })).stageHistory).toEqual([])
    expect((await tool('get_ticket', { ticketId: old.id })).stageHistory).toMatchObject([
      { from: null, to: 'todo', by: null, how: null },
    ])
    expect((await call('GET', `/api/projects/${pid}/tickets`)).status).toBe(200)
    expect(Array.isArray(await tool('list_tickets', { projectId: pid }))).toBe(true)
  })
})

describe('the texts agents read', () => {
  it('name the history, the send-backs, the merge time and when the approval fields change', async () => {
    const { handleMcp } = await import('./mcp')
    const res = await handleMcp(
      new Request('http://localhost/api/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer gate_test',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list', params: {} }),
      }),
      AGENT,
    )
    const tools = ((await res.json()) as { result: { tools: { name: string; description: string }[] } })
      .result.tools
    const text = (name: string) => tools.find((t) => t.name === name)!.description
    for (const word of ['stageHistory', 'sendBacks', 'sendBackCount', 'mergedAt', 'changed-mind', 'how'])
      expect(text('get_ticket')).toContain(word)
    expect(text('get_ticket')).toMatch(/set whenever the ticket reaches an approved stage/)
    expect(text('get_ticket')).toMatch(/cleared when the approval is taken back/)
    expect(text('list_tickets')).toContain('mergedAt')
    expect(text('update_ticket')).toContain('stageHistory')
    const agentsMd = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'AGENTS.md'), 'utf8')
    expect(agentsMd.replace(/\s+/g, ' ')).toContain(
      '`approvedBy` are set whenever a ticket reaches an approved stage',
    )
  })
})
