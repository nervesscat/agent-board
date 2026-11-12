import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { count, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import type { MyGhPr } from './git'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-work-timeline-'))
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
const MIN = 60_000

let dbm: typeof import('#/db')
let features: typeof import('./features')
let summary: typeof import('./summary')
let work: typeof import('./workTimeline')
let handle: (request: Request) => Promise<Response>
beforeAll(async () => {
  dbm = await import('#/db')
  features = await import('./features')
  summary = await import('./summary')
  work = await import('./workTimeline')
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
function newProject(name = `p${++projects}`) {
  const id = dbm.db.insert(dbm.schema.projects).values({ name }).returning().get().id
  dbm.db
    .insert(dbm.schema.repos)
    .values({ projectId: id, name: 'app', repoPath: `/r/${name}`, githubRepo: 'acme/app' })
    .run()
  return id
}

async function call(method: string, pathname: string, body?: unknown, as: 'human' | 'agent' = 'agent') {
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
async function rpc(method: string, params: Record<string, unknown> = {}, as: 'human' | 'agent' = 'agent') {
  const { handleMcp } = await import('./mcp')
  const res = await handleMcp(
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(as === 'agent' ? { authorization: 'Bearer gate_test' } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    }),
    as === 'agent' ? AGENT : HUMAN,
  )
  return ((await res.json()) as { result: any }).result
}
/** A tool call's answer: its parsed result, or `{error}` with the message of a refused call. */
async function tool(name: string, args: Record<string, unknown>, as: 'human' | 'agent' = 'agent') {
  const result = (await rpc('tools/call', { name, arguments: args }, as)) as {
    isError?: boolean
    content: { text: string }[]
  }
  return result.isError ? { error: result.content[0]!.text } : JSON.parse(result.content[0]!.text)
}

const events = (ticketId: number) =>
  dbm.db
    .select()
    .from(dbm.schema.ticketEvents)
    .where(eq(dbm.schema.ticketEvents.ticketId, ticketId))
    .orderBy(dbm.schema.ticketEvents.id)
    .all()
const agentEvents = (ticketId: number) => events(ticketId).filter((e) => e.agent !== 'board')
const boardEvents = (ticketId: number, kind: string) =>
  events(ticketId).filter((e) => e.agent === 'board' && e.kind === kind)
const eventCount = () => dbm.db.select({ n: count() }).from(dbm.schema.ticketEvents).get()!.n
const ago = (minutes: number) => new Date(Date.now() - minutes * MIN).toISOString()

/** Move a ticket's whole past back: its events, its creation and its start. */
function age(ticketId: number, minutes: number) {
  const { db, schema } = dbm
  for (const e of events(ticketId))
    db.update(schema.ticketEvents)
      .set({ at: new Date(Date.parse(e.at) - minutes * MIN).toISOString() })
      .where(eq(schema.ticketEvents.id, e.id))
      .run()
  db.update(schema.tickets)
    .set({ createdAt: ago(minutes), startedAt: ago(minutes) })
    .where(eq(schema.tickets.id, ticketId))
    .run()
}

/** A PR as gh lists it, open until `mergedAt` is set. */
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
})

function activeTicket(pid: number, title = 'work') {
  return features.createTicket(pid, { title, status: 'in_progress', branch: `feat/${title}` }, HUMAN)
}

describe('the agent tools', () => {
  it('are listed with their scoping and the wait reasons', async () => {
    const { tools } = (await rpc('tools/list')) as { tools: { name: string; description: string }[] }
    const names = tools.map((t) => t.name)
    for (const name of ['start_span', 'end_span', 'handoff', 'start_wait', 'end_wait', 'heartbeat']) {
      expect(names).toContain(name)
      expect(tools.find((t) => t.name === name)!.description).toMatch(/projectId and ticketId/)
    }
    expect(tools.find((t) => t.name === 'start_wait')!.description).toMatch(
      /lock.*builder.*mcp.*human.*other/s,
    )
  })

  it('start_span stores a span_start by the token name and answers its id', async () => {
    const pid = newProject()
    const t = activeTicket(pid)
    const started = await tool('start_span', { projectId: pid, ticketId: t.id, phase: 'review', round: 2 })
    expect(started.spanId).toEqual(expect.any(Number))
    const [row] = agentEvents(t.id)
    expect(row).toMatchObject({
      id: started.spanId,
      kind: 'span_start',
      phase: 'review',
      round: 2,
      agent: AGENT,
      by: AGENT,
      projectId: pid,
    })
    // A known phase in any casing is stored lowercased; another phase as given.
    await tool('start_span', { projectId: pid, ticketId: t.id, phase: ' Build ' })
    await tool('start_span', { projectId: pid, ticketId: t.id, phase: 'Docs pass', agent: 'writer' })
    expect(agentEvents(t.id).map((e) => [e.phase, e.agent, e.by])).toEqual([
      ['review', AGENT, AGENT],
      ['build', AGENT, AGENT],
      ['Docs pass', 'writer', AGENT],
    ])
    expect(
      await tool('start_span', { projectId: pid, ticketId: t.id, phase: 'x', round: 21 }),
    ).toHaveProperty('error')
  })

  it('end_span closes by id or the agent’s latest open span, and refuses a second end', async () => {
    const pid = newProject()
    const t = activeTicket(pid)
    const a = await tool('start_span', { projectId: pid, ticketId: t.id, phase: 'build' })
    const b = await tool('start_span', { projectId: pid, ticketId: t.id, phase: 'verify' })
    const other = await tool('start_span', { projectId: pid, ticketId: t.id, phase: 'build', agent: 'sub' })

    const ended = await tool('end_span', { projectId: pid, ticketId: t.id, spanId: a.spanId })
    expect(ended.span.durationMs).toBeGreaterThanOrEqual(0)
    expect(ended.event).toMatchObject({ kind: 'span_end', refId: a.spanId, phase: 'build' })
    expect(await tool('end_span', { projectId: pid, ticketId: t.id, spanId: a.spanId })).toEqual({
      error: expect.stringMatching(/already ended/),
    })

    // Without an id: the latest open one by the caller (of the phase, when given), not the sub-agent's.
    expect(await tool('end_span', { projectId: pid, ticketId: t.id, phase: 'build' })).toEqual({
      error: expect.stringMatching(/no open span/),
    })
    const latest = await tool('end_span', { projectId: pid, ticketId: t.id })
    expect(latest.event.refId).toBe(b.spanId)
    expect(await tool('end_span', { projectId: pid, ticketId: t.id })).toEqual({
      error: expect.stringMatching(/no open span/),
    })
    const sub = await tool('end_span', { projectId: pid, ticketId: t.id, agent: 'sub' })
    expect(sub.event).toMatchObject({ refId: other.spanId, agent: 'sub', by: AGENT })
    // An id that is not a span of this ticket.
    expect(await tool('end_span', { projectId: pid, ticketId: t.id, spanId: 999999 })).toEqual({
      error: expect.stringMatching(/no open span/),
    })
  })

  it('handoff stores from (the agent by default) and to, a sub-agent’s free name included', async () => {
    const pid = newProject()
    const t = activeTicket(pid)
    await tool('handoff', {
      projectId: pid,
      ticketId: t.id,
      agent: 'orchestrator',
      to: 'builder-sub-1',
      note: 'build it',
    })
    await tool('handoff', { projectId: pid, ticketId: t.id, from: 'builder-sub-1', to: 'orchestrator' })
    expect(agentEvents(t.id).map((e) => [e.kind, e.fromAgent, e.toAgent, e.agent, e.note])).toEqual([
      ['handoff', 'orchestrator', 'builder-sub-1', 'orchestrator', 'build it'],
      ['handoff', 'builder-sub-1', 'orchestrator', AGENT, ''],
    ])
    expect(await tool('handoff', { projectId: pid, ticketId: t.id })).toHaveProperty('error')
  })

  it('start_wait takes only the known reasons, and end_wait closes it', async () => {
    const pid = newProject()
    const t = activeTicket(pid)
    const w = await tool('start_wait', { projectId: pid, ticketId: t.id, reason: 'lock' })
    expect(agentEvents(t.id)[0]).toMatchObject({ id: w.waitId, kind: 'wait_start', reason: 'lock' })
    const coffee = await tool('start_wait', { projectId: pid, ticketId: t.id, reason: 'coffee' })
    expect(coffee.error).toMatch(/reason/)
    expect(agentEvents(t.id)).toHaveLength(1)

    const ended = await tool('end_wait', { projectId: pid, ticketId: t.id })
    expect(ended.event).toMatchObject({ kind: 'wait_end', refId: w.waitId, reason: 'lock' })
    expect(ended.wait.durationMs).toBeGreaterThanOrEqual(0)
    expect(await tool('end_wait', { projectId: pid, ticketId: t.id, waitId: w.waitId })).toEqual({
      error: expect.stringMatching(/already ended/),
    })
    expect(await tool('end_wait', { projectId: pid, ticketId: t.id })).toEqual({
      error: expect.stringMatching(/no open wait/),
    })
  })

  it('start_wait stores on, through MCP and REST, and refuses a bad one', async () => {
    const pid = newProject()
    const t = activeTicket(pid)
    const w = await tool('start_wait', { projectId: pid, ticketId: t.id, reason: 'builder', on: 'builder' })
    expect(agentEvents(t.id)[0]).toMatchObject({ id: w.waitId, reason: 'builder', on: 'builder' })
    expect(w.event).toMatchObject({ on: 'builder' })

    const rest = await call('POST', `/api/projects/${pid}/tickets/${t.id}/events`, {
      kind: 'wait_start',
      reason: 'builder',
      on: 'orch/builder-1',
    })
    expect(rest.status).toBe(201)
    expect(rest.body.event).toMatchObject({ on: 'orch/builder-1' })

    // Left out, the wait reads as it always did: on is null.
    const plain = await tool('start_wait', { projectId: pid, ticketId: t.id, reason: 'lock' })
    expect(agentEvents(t.id).find((e) => e.id === plain.waitId)!.on).toBeNull()

    for (const on of ['', '   ', 'x'.repeat(61)]) {
      expect(
        await tool('start_wait', { projectId: pid, ticketId: t.id, reason: 'builder', on }),
      ).toHaveProperty('error')
      const bad = await call('POST', `/api/projects/${pid}/tickets/${t.id}/events`, {
        kind: 'wait_start',
        reason: 'builder',
        on,
      })
      expect(bad.status).toBe(400)
    }
    expect(agentEvents(t.id)).toHaveLength(3)
  })

  it('heartbeat stores a row and answers lastSignalAt as its time', async () => {
    const pid = newProject()
    const t = activeTicket(pid)
    const beat = await tool('heartbeat', { projectId: pid, ticketId: t.id })
    const row = agentEvents(t.id)[0]!
    expect(row.kind).toBe('heartbeat')
    expect(beat).toEqual({
      at: row.at,
      lastSignalAt: row.at,
      leaseUntil: new Date(Date.parse(row.at) + 10 * MIN).toISOString(),
    })
  })
})

describe('delegated waits, lastHeard and activity', () => {
  it('counts a wait with on as working and a plain one as waiting, on the ticket and on the REST read', async () => {
    const pid = newProject()
    const delegated = activeTicket(pid, 'delegated')
    const plain = activeTicket(pid, 'plain')
    await tool('start_wait', { projectId: pid, ticketId: delegated.id, reason: 'builder', on: 'builder' })
    await tool('start_wait', { projectId: pid, ticketId: plain.id, reason: 'builder' })
    age(delegated.id, 30)
    age(plain.id, 30)
    const d = work.ticketTimeline(delegated.id).timeline.totals
    const p = work.ticketTimeline(plain.id).timeline.totals
    expect(d.workingMs).toBeGreaterThanOrEqual(30 * MIN - 1000)
    expect(d.waitingMs).toBe(0)
    expect(p.waitingMs).toBeGreaterThanOrEqual(30 * MIN - 1000)
    expect(p.workingMs).toBe(0)
    const rest = await call('GET', `/api/tickets/${delegated.id}/events`)
    expect(rest.body.timeline.waits[0]).toMatchObject({ reason: 'builder', on: 'builder' })
  })

  it('answers lastHeard as the latest agent event with its note, on the events, the timeline and get_ticket', async () => {
    const pid = newProject()
    const t = activeTicket(pid)
    await tool('start_span', { projectId: pid, ticketId: t.id, phase: 'build', agent: 'builder' })
    await tool('heartbeat', { projectId: pid, ticketId: t.id, agent: 'builder', note: 'checks running' })
    const rest = await call('GET', `/api/tickets/${t.id}/events`)
    const expected = {
      kind: 'heartbeat',
      agent: 'builder',
      by: AGENT,
      phase: '',
      reason: '',
      note: 'checks running',
    }
    expect(rest.body.timeline.lastHeard).toMatchObject(expected)
    expect((await tool('get_ticket', { ticketId: t.id })).work.lastHeard).toMatchObject(expected)
  })

  it('is none for a ticket that only the board has recorded events on', async () => {
    const pid = newProject()
    const t = features.createTicket(pid, { title: 'quiet', status: 'todo' }, HUMAN)
    const rest = await call('GET', `/api/tickets/${t.id}/events`)
    expect(rest.body.events.every((e: { agent: string }) => e.agent === 'board')).toBe(true)
    expect(rest.body.timeline.lastHeard).toBeNull()
  })

  it('gives list rows and the Overview the same activity: open spans, open waits and lastHeard', async () => {
    const pid = newProject()
    const t = activeTicket(pid, 'busy')
    const span = await tool('start_span', { projectId: pid, ticketId: t.id, phase: 'build' })
    await tool('start_wait', { projectId: pid, ticketId: t.id, reason: 'builder', on: 'builder' })
    const [row] = (await tool('list_tickets', { projectId: pid })).filter(
      (r: { id: number }) => r.id === t.id,
    )
    const started = agentEvents(t.id).find((e) => e.kind === 'span_start')!
    expect(row.activity).toEqual({
      spans: [{ phase: 'build', agent: AGENT, since: started.at }],
      waits: [{ reason: 'builder', agent: AGENT, on: 'builder', since: expect.any(String) }],
      lastHeard: {
        at: expect.any(String),
        agent: AGENT,
        by: AGENT,
        kind: 'wait_start',
        phase: '',
        reason: 'builder',
        note: '',
      },
      lastClosedSpan: null,
      now: expect.any(String),
      liveness: {
        state: 'working',
        agent: AGENT,
        phase: 'build',
        since: started.at,
        lastSignalAt: expect.any(String),
        lastWordAt: expect.any(String),
        silentMinutes: 0,
        spans: [
          {
            phase: 'build',
            agent: AGENT,
            since: started.at,
            lastWordAt: expect.any(String),
            silentMinutes: 0,
          },
        ],
      },
    })
    expect(span.spanId).toBe(started.id)
    const overview = (await tool('get_summary', { projectId: pid })).projects[0]
    // Each read is at its own time: the same activity, read at the Overview's now.
    expect(overview.inProgress.find((p: { id: number }) => p.id === t.id).activity).toEqual({
      ...row.activity,
      now: expect.any(String),
    })

    // Once they close, the open lists are empty; lastHeard stays at the latest event.
    await tool('end_span', { projectId: pid, ticketId: t.id, spanId: span.spanId })
    await tool('end_wait', { projectId: pid, ticketId: t.id })
    const after = (await tool('list_tickets', { projectId: pid })).find((r: { id: number }) => r.id === t.id)
    expect(after.activity).toMatchObject({ spans: [], waits: [], lastHeard: { kind: 'wait_end' } })
    expect(after.activity.lastClosedSpan).toEqual({
      phase: 'build',
      agent: AGENT,
      start: started.at,
      end: expect.any(String),
    })
  })
})

describe('scoping', () => {
  it('refuses a ticket of another project, an unknown one and an archived one, over MCP and REST', async () => {
    const pid = newProject()
    const other = newProject()
    const theirs = activeTicket(other)
    const before = eventCount()
    for (const [name, args] of [
      ['start_span', { phase: 'build' }],
      ['end_span', {}],
      ['handoff', { to: 'x' }],
      ['start_wait', { reason: 'lock' }],
      ['end_wait', {}],
      ['heartbeat', {}],
    ] as const)
      expect(await tool(name, { projectId: pid, ticketId: theirs.id, ...args })).toEqual({
        error: `#${theirs.id} is not a ticket of this project`,
      })
    const rest = await call('POST', `/api/projects/${pid}/tickets/${theirs.id}/events`, { kind: 'heartbeat' })
    expect(rest).toEqual({ status: 403, body: { error: `#${theirs.id} is not a ticket of this project` } })
    expect(eventCount()).toBe(before)

    expect(
      (await call('POST', `/api/projects/${pid}/tickets/999999/events`, { kind: 'heartbeat' })).status,
    ).toBe(404)
    expect(
      (await call('POST', `/api/projects/999999/tickets/${theirs.id}/events`, { kind: 'heartbeat' })).status,
    ).toBe(404)
    const done = features.createTicket(pid, { title: 'done', status: 'done' }, HUMAN)
    features.archiveTicket(done.id, HUMAN)
    const archived = eventCount()
    expect(
      (await call('POST', `/api/projects/${pid}/tickets/${done.id}/events`, { kind: 'heartbeat' })).status,
    ).toBe(409)
    expect(eventCount()).toBe(archived)
  })
})

describe('REST', () => {
  it('takes each agent kind with the tool’s fields, refuses the board’s kinds, and takes the human too', async () => {
    const pid = newProject()
    const t = activeTicket(pid)
    const post = (body: unknown, as: 'human' | 'agent' = 'agent') =>
      call('POST', `/api/projects/${pid}/tickets/${t.id}/events`, body, as)

    const span = await post({ kind: 'span_start', phase: 'build' })
    expect(span.status).toBe(201)
    expect(span.body.spanId).toEqual(expect.any(Number))
    expect((await post({ kind: 'span_end', spanId: span.body.spanId })).status).toBe(201)
    expect((await post({ kind: 'handoff', to: 'sub' })).status).toBe(201)
    const wait = await post({ kind: 'wait_start', reason: 'mcp' })
    expect(wait.status).toBe(201)
    expect((await post({ kind: 'wait_end' })).body.wait.id).toBe(wait.body.waitId)
    expect((await post({ kind: 'heartbeat' })).status).toBe(201)
    expect((await post({ kind: 'heartbeat' }, 'human')).body).toMatchObject({ at: expect.any(String) })
    expect(agentEvents(t.id).at(-1)).toMatchObject({ by: HUMAN, agent: HUMAN })

    for (const kind of ['push', 'pr', 'preview', 'merge', 'stage', 'nap'])
      expect((await post({ kind })).status).toBe(400)
    expect((await post({ kind: 'wait_start', reason: 'coffee' })).status).toBe(400)
    expect((await post({ kind: 'heartbeat', note: 'x'.repeat(501) })).status).toBe(400)
    expect((await post({ kind: 'heartbeat', agent: 'y'.repeat(61) })).status).toBe(400)
  })

  it('answers a ticket’s events newest first with its timeline, and the project’s totals', async () => {
    const pid = newProject()
    const a = activeTicket(pid, 'a')
    const b = activeTicket(pid, 'b')
    const archived = features.createTicket(pid, { title: 'old', status: 'done' }, HUMAN)
    for (const t of [a, b, archived]) {
      await tool('start_span', { projectId: pid, ticketId: t.id, phase: 'build' })
      await tool('start_wait', { projectId: pid, ticketId: t.id, reason: 'lock' })
      age(t.id, 20)
      await tool('end_wait', { projectId: pid, ticketId: t.id })
    }
    features.archiveTicket(archived.id, HUMAN)

    const read = await call('GET', `/api/tickets/${a.id}/events`)
    expect(read.status).toBe(200)
    const ats = read.body.events.map((e: { at: string }) => e.at)
    expect(ats).toEqual([...ats].sort().reverse())
    expect(read.body.events.map((e: { kind: string }) => e.kind)).toEqual(
      expect.arrayContaining(['stage', 'span_start', 'wait_start', 'wait_end']),
    )
    expect(read.body.timeline).toMatchObject({
      live: true,
      spans: [expect.objectContaining({ phase: 'build', open: true })],
      waits: [expect.objectContaining({ reason: 'lock', open: false })],
      stalled: null,
    })
    // The lock wait ran under the open build span: work went on, so it counts as working.
    expect(read.body.timeline.totals.workingMs).toBeGreaterThanOrEqual(20 * MIN - 1000)
    expect(read.body.timeline.totals.waitingMs).toBe(0)

    const project = await call('GET', `/api/projects/${pid}/work`)
    expect(project.body.stallMinutes).toBe(30)
    expect(project.body.tickets.map((t: { id: number }) => t.id).sort()).toEqual([a.id, b.id].sort())
    const sum = (k: string) =>
      project.body.tickets.reduce((n: number, t: { totals: Record<string, number> }) => n + t.totals[k]!, 0)
    for (const k of ['workingMs', 'waitingMs', 'blockedOnHumanMs'])
      expect(project.body.totals[k]).toBe(sum(k))
  })
})

describe('the stalled flag', () => {
  it('follows the project’s threshold, which only the human sets', async () => {
    const pid = newProject()
    const t = activeTicket(pid)
    await tool('heartbeat', { projectId: pid, ticketId: t.id })
    age(t.id, 11)
    const row = async () =>
      (await call('GET', `/api/projects/${pid}/tickets`)).body.find((r: { id: number }) => r.id === t.id)
    expect((await row()).stalled).toBeNull()

    expect(await call('PATCH', `/api/projects/${pid}`, { stallMinutes: 10 })).toEqual({
      status: 403,
      body: { error: 'only the human sets when a ticket reads as stalled' },
    })
    for (const bad of [0, 1441, 2.5])
      expect((await call('PATCH', `/api/projects/${pid}`, { stallMinutes: bad }, 'human')).status).toBe(400)
    const patched = await call('PATCH', `/api/projects/${pid}`, { stallMinutes: 10 }, 'human')
    expect(patched.body.stallMinutes).toBe(10)
    expect((await call('GET', `/api/projects/${pid}`)).body.stallMinutes).toBe(10)
    expect((await tool('get_project', { projectId: pid })).stallMinutes).toBe(10)

    const stalled = await row()
    expect(stalled.stalled).toMatchObject({ minutes: 11, lastAgent: AGENT })
    expect(stalled.stalled.since).toBe(stalled.lastSignalAt)
    // A fresh heartbeat clears it.
    await tool('heartbeat', { projectId: pid, ticketId: t.id })
    expect((await row()).stalled).toBeNull()
  })

  it('a run killed mid-span reads lost on list_tickets and get_ticket, and in lostContact not stalled', async () => {
    const pid = newProject()
    const t = activeTicket(pid)
    const span = await tool('start_span', { projectId: pid, ticketId: t.id, phase: 'build' })
    age(t.id, 31)
    const [row] = (await tool('list_tickets', { projectId: pid })).filter(
      (r: { id: number }) => r.id === t.id,
    )
    // The lease ran out with the span still open: the agent is gone, which is not a stall.
    expect(row.stalled).toBeNull()
    expect(row.liveness).toMatchObject({
      state: 'lost',
      agent: AGENT,
      phase: 'build',
      lastSignalAt: row.lastSignalAt,
      lastWordAt: expect.any(String),
      silentMinutes: 31,
      spans: [{ phase: 'build', agent: AGENT }],
    })

    const full = await tool('get_ticket', { ticketId: t.id })
    expect(full.stalled).toBeNull()
    expect(full.work).toMatchObject({
      liveness: {
        state: 'lost',
        agent: AGENT,
        phase: 'build',
        lastSignalAt: row.lastSignalAt,
        silentMinutes: 31,
      },
      lastSignalAt: row.lastSignalAt,
      lastWordAt: expect.any(String),
      open: { spans: [expect.objectContaining({ id: span.spanId, phase: 'build' })], waits: [] },
    })
    expect(full.work.totals.workingMs).toBeGreaterThanOrEqual(31 * MIN - 1000)
    const rest = await call('GET', `/api/tickets/${t.id}`)
    expect(rest.body.work.open.spans).toHaveLength(1)

    // Needs you is the human's turn: the lost run has its own block, outside it and its total.
    const summary = (await tool('get_summary', { projectId: pid })).projects[0]
    expect(summary.needsYou.stalled).toEqual([])
    expect(summary.lostContact).toMatchObject([
      {
        ticketId: t.id,
        agent: AGENT,
        phase: 'build',
        lastSignalAt: row.lastSignalAt,
        lastWordAt: expect.any(String),
        spans: [{ phase: 'build', agent: AGENT }],
      },
    ])
    expect(summary.needsYou.total).toBe(0)
  })

  it("an agent post refreshes the lease; a person's post does not prove the run is alive", async () => {
    const pid = newProject()
    const { db, schema } = dbm
    const posted = activeTicket(pid, 'posted')
    await tool('start_span', { projectId: pid, ticketId: posted.id, phase: 'review' })
    age(posted.id, 49)
    // The post comes now, well after the span opened: it is the lease.
    db.insert(schema.updates)
      .values({ ticketId: posted.id, author: AGENT, body: 'verify: 25/25 pass', progress: true })
      .run()
    const rows = async (id: number) =>
      (await tool('list_tickets', { projectId: pid })).find((r: { id: number }) => r.id === id)

    const live = await rows(posted.id)
    expect(live.liveness).toMatchObject({ state: 'working', agent: AGENT, phase: 'review' })
    expect(live.stalled).toBeNull()

    const quiet = activeTicket(pid, 'quiet')
    await tool('start_span', { projectId: pid, ticketId: quiet.id, phase: 'review' })
    age(quiet.id, 49)
    db.insert(schema.updates)
      .values({ ticketId: quiet.id, author: HUMAN, body: 'any news?', progress: false })
      .run()
    const lost = await rows(quiet.id)
    expect(lost.liveness).toMatchObject({ state: 'lost', silentMinutes: 49 })
    expect(lost.stalled).toBeNull()
  })

  it('waits on the human from each fact: a human wait, a pending decision and an open blocked task', async () => {
    const pid = newProject()
    const { db, schema } = dbm
    const byWait = activeTicket(pid, 'wait')
    await tool('start_wait', { projectId: pid, ticketId: byWait.id, reason: 'human' })
    const byDecision = activeTicket(pid, 'decision')
    db.insert(schema.updates)
      .values({
        ticketId: byDecision.id,
        author: AGENT,
        body: 'Which cache?',
        decision: [{ label: 'Redis' }, { label: 'Memory' }],
      })
      .run()
    const byTask = activeTicket(pid, 'task')
    const [task] = features.addTasks(byTask.id, ['Get the API key'], AGENT)
    features.updateTask(task!.id, { blocked: true, blockedReason: 'the human gets the key' }, AGENT)
    for (const t of [byWait, byDecision, byTask]) age(t.id, 60)
    // Their events and posts are old too: only the human facts keep them from reading lost or stalled.
    db.update(schema.updates)
      .set({ createdAt: new Date(Date.now() - 60 * MIN).toISOString() })
      .where(eq(schema.updates.ticketId, byDecision.id))
      .run()

    const rows = (await tool('list_tickets', { projectId: pid })) as {
      id: number
      liveness: { state: string } | null
      stalled: unknown
    }[]
    for (const t of [byWait, byDecision, byTask]) {
      const row = rows.find((r) => r.id === t.id)!
      expect(row.liveness?.state, `#${t.id}`).toBe('waiting')
      expect(row.stalled).toBeNull()
    }
    const summary = (await tool('get_summary', { projectId: pid })).projects[0]
    expect(summary.needsYou.stalled).toEqual([])
    expect(summary.lostContact).toEqual([])
  })

  it('waits on a blocked step of its own, never on its parent’s, and says so on both reads', async () => {
    const pid = newProject()
    const parent = activeTicket(pid, 'parent')
    const lane = features.createTicket(pid, { title: 'lane', status: 'in_progress', parentId: parent.id }, HUMAN)
    const [keys] = features.addTasks(parent.id, ['keys'], AGENT)
    features.updateTask(keys!.id, { blocked: true, blockedReason: 'the human gets the key' }, AGENT)
    const [draft] = features.addTasks(lane.id, ['draft the docs'], AGENT)
    // Fresh on both, so the state is about the blocked step and nothing else.
    await tool('heartbeat', { projectId: pid, ticketId: lane.id })

    const reads = async (id: number) => {
      const row = ((await tool('list_tickets', { projectId: pid })) as { id: number; liveness: { state: string } | null }[]).find(
        (r) => r.id === id,
      )!
      const full = await tool('get_ticket', { ticketId: id })
      return { list: row.liveness?.state, get: full.work.liveness?.state }
    }

    // The parent works a blocked step next: it waits on the human.
    expect(await reads(parent.id)).toMatchObject({ list: 'waiting', get: 'waiting' })
    // Its lane's own next step is open: the lane is working, not waiting on a task that is not its own.
    // The list row and the ticket's own page agree on it.
    expect(await reads(lane.id)).toMatchObject({ list: 'working', get: 'working' })

    // A blocked step of its own: now the lane waits, and both reads say so.
    features.updateTask(draft!.id, { blocked: true, blockedReason: 'the human reviews the draft' }, AGENT)
    expect(await reads(lane.id)).toMatchObject({ list: 'waiting', get: 'waiting' })
    expect(await reads(parent.id)).toMatchObject({ list: 'waiting', get: 'waiting' })
  })

  it('is not raised in a blocked or review stage, nor while waiting on the human', async () => {
    const pid = newProject()
    const blocked = features.createTicket(pid, { title: 'blocked', status: 'blocked' }, HUMAN)
    const review = features.createTicket(pid, { title: 'review', status: 'review' }, HUMAN)
    const waiting = activeTicket(pid, 'waiting')
    await tool('start_wait', { projectId: pid, ticketId: waiting.id, reason: 'human' })
    for (const t of [blocked, review, waiting]) age(t.id, 120)
    const rows = (await tool('list_tickets', { projectId: pid })) as { id: number; stalled: unknown }[]
    expect(rows.map((r) => r.stalled)).toEqual([null, null, null])
  })

  it('lists stalled tickets and lanes in Needs you, counted, and flags the in-progress rows', async () => {
    const pid = newProject()
    const t = activeTicket(pid, 'top')
    const lane = features.createTicket(pid, { title: 'lane', status: 'in_progress', parentId: t.id }, HUMAN)
    const fresh = activeTicket(pid, 'fresh')
    await tool('heartbeat', { projectId: pid, ticketId: lane.id, agent: 'builder' })
    const before = summary.getSummary(pid, { humans: [HUMAN] }).projects[0]!
    expect(before.needsYou.stalled).toEqual([])
    age(t.id, 90)
    age(lane.id, 45)
    const after = (await tool('get_summary', { projectId: pid })).projects[0]
    const signal = Object.fromEntries(
      ((await tool('list_tickets', { projectId: pid })) as { id: number; lastSignalAt: string }[]).map(
        (r) => [r.id, r.lastSignalAt],
      ),
    )
    expect(after.needsYou.stalled).toEqual([
      expect.objectContaining({ ticketId: t.id, lastSignalAt: signal[t.id], parent: null }),
      expect.objectContaining({
        ticketId: lane.id,
        lastAgent: 'builder',
        lastBy: AGENT,
        lastFrom: 'event',
        lastSignalAt: signal[lane.id],
        parent: { id: t.id, title: 'top' },
      }),
    ])
    // Moments only, no minutes counted up to the read: the summary reads the same at any hour of its day.
    for (const s of after.needsYou.stalled) expect(s).not.toHaveProperty('minutes')
    expect(after.needsYou.total).toBe(before.needsYou.total + 2)
    const progress = Object.fromEntries(
      after.inProgress.map((p: { id: number; stalled: boolean }) => [p.id, p.stalled]),
    )
    expect(progress).toEqual({ [t.id]: true, [fresh.id]: false })
  })
})

describe('quiet writes', () => {
  it('add no activity and leave the ticket’s updatedAt alone', async () => {
    const pid = newProject()
    const t = activeTicket(pid)
    const activity = () =>
      dbm.db
        .select({ n: count() })
        .from(dbm.schema.activity)
        .where(eq(dbm.schema.activity.projectId, pid))
        .get()!.n
    const before = { n: activity(), updatedAt: features.getTicket(t.id).updatedAt }
    for (let i = 0; i < 5; i++) await tool('heartbeat', { projectId: pid, ticketId: t.id })
    const s = await tool('start_span', { projectId: pid, ticketId: t.id, phase: 'build' })
    await tool('end_span', { projectId: pid, ticketId: t.id, spanId: s.spanId })
    expect({ n: activity(), updatedAt: features.getTicket(t.id).updatedAt }).toEqual(before)
  })
})

describe('what the board records itself', () => {
  it('a stage event on every status change', async () => {
    const pid = newProject()
    const t = features.createTicket(pid, { title: 'moves' }, HUMAN)
    features.claimTicket(t.id, AGENT)
    features.updateTicket(t.id, { status: 'review' }, HUMAN)
    features.updateTicket(t.id, { title: 'renamed' }, HUMAN)
    features.setVerdict(t.id, 'disapproved', HUMAN)
    features.setVerdict(t.id, null, HUMAN, { reopenTo: 'in_progress' })
    const card = features.askDecision(
      t.id,
      { body: 'Which?', options: [{ label: 'A' }, { label: 'B' }] },
      AGENT,
    )
    features.decide(card.id, 0, '', HUMAN)
    expect(boardEvents(t.id, 'stage').map((e) => [e.fromStage, e.toStage, e.by])).toEqual([
      ['', 'todo', 'board'],
      ['todo', 'in_progress', 'board'],
      ['in_progress', 'review', 'board'],
      ['review', 'cancelled', 'board'],
      ['cancelled', 'in_progress', 'board'],
      ['in_progress', 'blocked', 'board'],
      ['blocked', 'in_progress', 'board'],
    ])
  })

  it('blocked time from stage events counts as blocked on the human', async () => {
    const pid = newProject()
    const t = activeTicket(pid)
    features.updateTicket(t.id, { status: 'blocked' }, HUMAN)
    age(t.id, 30)
    features.updateTicket(t.id, { status: 'in_progress' }, HUMAN)
    const { timeline } = work.ticketTimeline(t.id)
    expect(timeline.blockedStretches).toHaveLength(1)
    expect(Math.round(timeline.totals.blockedOnHumanMs / MIN)).toBe(30)
  })

  it('a stage event for the tickets a deleted stage moves', async () => {
    const pid = newProject()
    const stages = await import('./stages')
    const extra = stages.createStage(pid, { name: 'Parked', kind: 'open' }, HUMAN)
    const t = features.createTicket(pid, { title: 'parked', status: extra.key }, HUMAN)
    stages.deleteStage(pid, extra.id, { moveTo: 'todo' }, HUMAN)
    expect(boardEvents(t.id, 'stage').at(-1)).toMatchObject({ fromStage: extra.key, toStage: 'todo' })
  })

  it('a pr event when the ticket’s PR is set', async () => {
    const pid = newProject()
    const t = activeTicket(pid)
    features.updateTicket(t.id, { prNumber: 12 }, AGENT)
    features.updateTicket(t.id, { prNumber: 12, title: 'again' }, AGENT)
    features.updateTicket(t.id, { prNumber: null }, AGENT)
    expect(boardEvents(t.id, 'pr').map((e) => [e.note, e.agent, e.by])).toEqual([
      ['PR #12', 'board', 'board'],
    ])
  })

  it('a push event when origin’s branch of a ticket moves', async () => {
    const pid = newProject('pushes')
    const t = activeTicket(pid, 'pushed')
    const other = activeTicket(pid, 'elsewhere')
    const { noteOriginRefs } = await import('./pushedToday')
    const refs = (remote: [string, string][]) => ({
      local: new Map<string, string>(),
      remote: new Map(remote),
      symrefs: new Map<string, string>(),
    })
    noteOriginRefs('/r/pushes', refs([['main', 'aaaaaaa1']]), new Date(), { fetched: true })
    noteOriginRefs(
      '/r/pushes',
      refs([
        ['main', 'aaaaaaa1'],
        ['feat/pushed', 'abc1234def5678'],
      ]),
    )
    noteOriginRefs('/r/pushes', refs([['main', 'aaaaaaa1']]))
    expect(boardEvents(t.id, 'push').map((e) => [e.note, e.agent])).toEqual([['pushed abc1234', 'board']])
    expect(boardEvents(other.id, 'push')).toEqual([])
  })

  it('a merge event once, when a PR’s merge is first seen, on its tickets', async () => {
    const pid = newProject('merges')
    const t = features.createTicket(pid, { title: 'merging', status: 'review', branch: 'feat/m' }, HUMAN)
    const prs = await import('./prs')
    const gh = (mergedAt: string | null) => ghPr(7, 'feat/m', mergedAt)
    found = [gh(null)]
    await prs.refreshPrs(pid)
    expect(boardEvents(t.id, 'merge')).toEqual([])
    found = [gh(new Date().toISOString())]
    await prs.refreshPrs(pid)
    await prs.refreshPrs(pid)
    expect(boardEvents(t.id, 'merge').map((e) => e.note)).toEqual(['PR #7 merged'])
    found = []
  })

  it('a stage event when the board opens a PR’s own ticket and when it moves it', async () => {
    const pid = newProject('pr-tickets')
    const prs = await import('./prs')
    found = [ghPr(8, 'feat/nobody', null)]
    await prs.refreshPrs(pid)
    const own = dbm.db
      .select()
      .from(dbm.schema.tickets)
      .where(eq(dbm.schema.tickets.projectId, pid))
      .all()
      .find((r) => r.prNumber === 8)!
    expect(boardEvents(own.id, 'stage').map((e) => [e.fromStage, e.toStage])).toEqual([['', own.status]])
    found = [ghPr(8, 'feat/nobody', new Date().toISOString())]
    await prs.refreshPrs(pid)
    const moved = dbm.db.select().from(dbm.schema.tickets).where(eq(dbm.schema.tickets.id, own.id)).get()!
    expect(moved.status).not.toBe(own.status)
    expect(boardEvents(own.id, 'stage').map((e) => [e.fromStage, e.toStage])).toEqual([
      ['', own.status],
      [own.status, moved.status],
    ])
    found = []
  })

  it('never fails the write it rides on', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // A kind the table refuses: the recorder logs it and returns.
    expect(() => work.noteBoardEvent(1, 'nap' as never)).not.toThrow()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('the docs and prompts', () => {
  const root = path.resolve('.')
  const files = [
    'AGENTS.md',
    'README.md',
    'src/server/skill/board.md',
    'src/server/skill/review/skills/todo-review/SKILL.md',
    'src/server/skill/review/agents/todo-review-ticket.md',
  ]
  it('tell agents to heartbeat and record spans, waits and hand-offs', async () => {
    const mcp = fs.readFileSync(path.join(root, 'src/server/mcp.ts'), 'utf8')
    const instructions = mcp.slice(mcp.indexOf('const INSTRUCTIONS'), mcp.indexOf('const STATUS'))
    for (const [name, text] of [
      ['INSTRUCTIONS', instructions],
      ...files.map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8')]),
    ] as const)
      for (const word of ['heartbeat', 'start_span', 'start_wait', 'handoff'])
        expect(text.includes(word), `${name} names ${word}`).toBe(true)
  })

  it('tell agents the lease, the four states and the runtime beat', () => {
    const mcp = fs.readFileSync(path.join(root, 'src/server/mcp.ts'), 'utf8')
    const instructions = mcp.slice(mcp.indexOf('const INSTRUCTIONS'), mcp.indexOf('const STATUS'))
    // The model's words are the board's own docs and served skill; the review skills' texts are out of
    // this change, and still carry their heartbeat lines (the test above).
    for (const f of ['AGENTS.md', 'README.md', 'src/server/skill/board.md']) {
      const text = fs.readFileSync(path.join(root, f), 'utf8')
      for (const word of ['Lost contact', 'Stalled', 'Working', 'Waiting on you'])
        expect(text.includes(word), `${f} names ${word}`).toBe(true)
      expect(/lease/i.test(text), `${f} says the lease`).toBe(true)
    }
    for (const word of ['Lost contact', 'Stalled', 'Working', 'Waiting on you'])
      expect(instructions.includes(word), `INSTRUCTIONS names ${word}`).toBe(true)
    expect(/lease/i.test(instructions), 'INSTRUCTIONS says the lease').toBe(true)
    // The served skill and the repo docs name the beater the runtime runs.
    for (const f of ['src/server/skill/board.md', 'AGENTS.md', 'README.md'])
      expect(fs.readFileSync(path.join(root, f), 'utf8'), `${f} names the beater`).toContain('board-beat')
    // The MCP tool texts say an open span with an expired lease is Lost contact, never stalled.
    for (const name of ['heartbeat', 'get_summary', 'get_ticket', 'list_tickets']) {
      const start = mcp.indexOf(`'${name}'`)
      expect(start, `the ${name} tool`).toBeGreaterThan(-1)
      const text = mcp.slice(start, start + 4000)
      expect(text, `the ${name} tool describes liveness`).toMatch(/Lost contact|liveness/)
    }
    expect(mcp).toContain('an open span whose lease expired reads Lost contact')
  })

  it('serve the new model in the skill over both transports, and the beater at its route', async () => {
    for (const transport of ['mcp', 'rest']) {
      const res = await handle(
        new Request(`http://localhost/api/agent-setup/skill?client=claude&transport=${transport}`, {
          headers: { authorization: 'Bearer gate_test' },
        }),
      )
      expect(res.status).toBe(200)
      const text = await res.text()
      for (const word of ['Lost contact', 'Stalled', 'Working', 'Waiting on you'])
        expect(text.includes(word), `${transport} skill names ${word}`).toBe(true)
      expect(text).toMatch(/lease/i)
      expect(text).toContain('board-beat')
      expect(text).toMatch(/every two minutes/)
    }
    const res = await handle(
      new Request('http://localhost/api/agent-setup/board-beat', {
        headers: { authorization: 'Bearer gate_test' },
      }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('board-beat.mjs')
    const script = await res.text()
    expect(script).toContain('--project')
    expect(script).toContain('--ticket')
    expect(script).toContain('/events')
  })
})
