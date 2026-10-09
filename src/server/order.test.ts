import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

// The order of a stage's column: tickets placed in it come first, in placed order, then the rest,
// last updated first. Through the features, and through the API router in test mode (REST and MCP).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp
process.env.BOARD_ENV = 'test'

let features: typeof import('./features')
let needs: typeof import('./needs')
let stagesMod: typeof import('./stages')
let stageColumn: typeof import('#/lib/stages').stageColumn
let handle: (ctx: { request: Request; actor: string }) => Promise<Response>
let callerOf: typeof import('./auth').callerOf
let dbm: typeof import('#/db')

beforeAll(async () => {
  features = await import('./features')
  needs = await import('./needs')
  stagesMod = await import('./stages')
  stageColumn = (await import('#/lib/stages')).stageColumn
  dbm = await import('#/db')
  // As src/routes/api/$.ts serves it: HttpErrors become their JSON answer.
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  handle = guard(({ request, actor }: { request: Request; actor: string }) => api.handle(request, actor))
  callerOf = (await import('./auth')).callerOf
})

let projects = 0
function newProject() {
  const { db, schema } = dbm
  const p = db
    .insert(schema.projects)
    .values({ name: `p${++projects}` })
    .returning()
    .get()
  db.insert(schema.repos)
    .values({ projectId: p.id, name: 'api', repoPath: '/r/api', baseBranch: 'main' })
    .run()
  return p.id
}

/** Tickets updated in this order, so the unplaced column reads them newest first. */
function tickets(projectId: number, status: string, titles: string[]) {
  const { db, schema } = dbm
  return titles.map((title, i) => {
    const t = features.createTicket(projectId, { title, status }, 'enrique')
    const updatedAt = new Date(Date.UTC(2026, 9, 1, 10, i)).toISOString()
    db.update(schema.tickets).set({ updatedAt }).where(eq(schema.tickets.id, t.id)).run()
    return t.id
  })
}

/** A column as the board shows it: the top-level list, through `stageColumn`. */
const column = (projectId: number, status: string) =>
  stageColumn(features.listTickets(projectId, { parentId: null }), status).map((t) => t.id)

async function call(
  method: string,
  pathname: string,
  testActor: string,
  body?: unknown,
  accept = 'application/json',
) {
  const headers: Record<string, string> = { accept, 'x-test-actor': testActor }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const request = new Request(`http://localhost${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const caller = await callerOf(request)
  return handle({ request, actor: caller!.name })
}

async function mcp(method: string, params: Record<string, unknown>) {
  // Streamable HTTP asks the client to accept both; the board answers in JSON.
  const res = await call(
    'POST',
    '/api/mcp',
    'agent:claude',
    { jsonrpc: '2.0', id: 1, method, params },
    'application/json, text/event-stream',
  )
  return (await res.json()) as { result: Record<string, unknown> & { content?: { text: string }[] } }
}
const tool = async (name: string, args: Record<string, unknown>) => {
  const { result } = await mcp('tools/call', { name, arguments: args })
  expect(result.isError, result.content?.[0]?.text).toBeFalsy()
  return JSON.parse(result.content![0]!.text)
}

describe('placing a ticket in its column', () => {
  it('reads back with it at the position asked and the others in their order, unplaced or not', () => {
    const pid = newProject()
    // Unplaced, newest first: D, C, B, A.
    const [a, b, c, d] = tickets(pid, 'review', ['A', 'B', 'C', 'D'])
    expect(column(pid, 'review')).toEqual([d, c, b, a])

    features.placeTicket(a!, 2, 'enrique')
    expect(column(pid, 'review')).toEqual([d, a, c, b])
    features.placeTicket(d!, 4, 'enrique')
    expect(column(pid, 'review')).toEqual([a, c, b, d])
    features.placeTicket(b!, 99, 'enrique')
    expect(column(pid, 'review')).toEqual([a, c, d, b])
    features.placeTicket(c!, 1, 'enrique')
    expect(column(pid, 'review')).toEqual([c, a, d, b])
    // Its other columns are left alone.
    const [x, y] = tickets(pid, 'todo', ['X', 'Y'])
    expect(column(pid, 'todo')).toEqual([y, x])
  })

  it('refuses a position below 1 or not whole, and a ticket off the board', () => {
    const pid = newProject()
    const [a] = tickets(pid, 'done', ['A'])
    expect(() => features.placeTicket(a!, 0, 'enrique')).toThrow(/position/)
    expect(() => features.placeTicket(a!, 1.5, 'enrique')).toThrow(/position/)
    features.archiveTicket(a!, 'enrique')
    expect(() => features.placeTicket(a!, 1, 'enrique')).toThrow(/archived/)
  })

  it('logs each placement, with who placed it and where', () => {
    const pid = newProject()
    const [a, b, c] = tickets(pid, 'review', ['A', 'B', 'C'])
    features.placeTicket(a!, 1, 'claude')
    const { db, schema } = dbm
    const rows = db.select().from(schema.activity).where(eq(schema.activity.projectId, pid)).all()
    expect(rows.at(-1)).toMatchObject({
      actor: 'claude',
      refType: 'ticket',
      refId: a,
      text: `moved ticket #${a} A to 1 of 3 in In review`,
    })
    // Already there: nothing to log.
    features.placeTicket(a!, 1, 'claude')
    expect(db.select().from(schema.activity).where(eq(schema.activity.projectId, pid)).all()).toHaveLength(
      rows.length,
    )
    expect(column(pid, 'review')).toEqual([a, c, b])
  })

  it('does not move a placed ticket when it is edited', async () => {
    const pid = newProject()
    const [a, b] = tickets(pid, 'review', ['A', 'B'])
    features.placeTicket(a!, 2, 'enrique')
    expect(column(pid, 'review')).toEqual([b, a])
    await needs.changeTicket(a!, { title: 'A, renamed', body: 'more', tags: ['UI'] }, 'enrique', {
      agent: false,
    })
    features.addTasks(a!, ['one more step'], 'claude')
    features.postUpdate(a!, 'progress', [], 'claude')
    expect(features.getTicket(a!).updatedAt > features.getTicket(b!).updatedAt).toBe(true)
    expect(column(pid, 'review')).toEqual([b, a])
    // Setting what it needs does not reorder anything either.
    await needs.changeTicket(b!, { needs: [a!] }, 'enrique', { agent: false })
    expect(column(pid, 'review')).toEqual([b, a])
  })

  it('places a lane among its siblings in the same stage', () => {
    const pid = newProject()
    const parent = features.createTicket(pid, { title: 'parent', status: 'in_progress' }, 'enrique')
    const lane = (title: string) =>
      features.createTicket(pid, { title, status: 'todo', parentId: parent.id }, 'claude').id
    const one = lane('one')
    const two = lane('two')
    const [top] = tickets(pid, 'todo', ['top level'])
    features.placeTicket(one, 1, 'claude')
    const lanes = stageColumn(features.listTickets(pid, { parentId: parent.id }), 'todo')
    expect(lanes.map((t) => [t.id, t.rank])).toEqual([
      [one, 1],
      [two, null],
    ])
    expect(features.getTicket(top!).rank).toBeNull()
  })
})

describe('a change of stage', () => {
  /** In Review holds X and Y, placed; Z is placed first in its own column. */
  function setup(from: string) {
    const pid = newProject()
    const [x, y] = tickets(pid, 'review', ['X', 'Y'])
    features.placeTicket(x!, 1, 'enrique')
    features.placeTicket(y!, 2, 'enrique')
    const [other, z] = tickets(pid, from, ['other', 'Z'])
    features.placeTicket(z!, 2, 'enrique')
    expect(features.getTicket(z!).rank).toBe(2)
    return { pid, x: x!, y: y!, z: z!, other: other! }
  }

  it('by PATCH clears its place: it arrives below the placed ones, and comes back unplaced', async () => {
    const { pid, x, y, z } = setup('in_progress')
    await needs.changeTicket(z, { status: 'review' }, 'claude', { agent: true })
    expect(column(pid, 'review')).toEqual([x, y, z])
    expect(features.getTicket(z).rank).toBeNull()
    await needs.changeTicket(z, { status: 'in_progress' }, 'claude', { agent: true })
    expect(features.getTicket(z).rank).toBeNull()
  })

  it('by claim, by asking a decision and by deciding it clears its place', () => {
    const { pid, z } = setup('todo')
    features.claimTicket(z, 'claude')
    expect(features.getTicket(z)).toMatchObject({ status: 'in_progress', rank: null })

    features.placeTicket(z, 1, 'claude')
    const post = features.askDecision(
      z,
      { body: 'Which?', options: [{ label: 'a' }, { label: 'b' }] },
      'claude',
    )
    expect(features.getTicket(z)).toMatchObject({ status: 'blocked', rank: null })

    features.placeTicket(z, 1, 'claude')
    // Back in progress it lands below the ticket placed there, though it was updated last.
    const [w] = tickets(pid, 'in_progress', ['W'])
    features.placeTicket(w!, 1, 'enrique')
    features.decide(post.id, 0, '', 'enrique')
    expect(features.getTicket(z)).toMatchObject({ status: 'in_progress', rank: null })
    expect(column(pid, 'in_progress')).toEqual([w, z])
  })

  it('by a claim that does not move it keeps its place', () => {
    const { z } = setup('in_progress')
    features.claimTicket(z, 'claude', { branch: 'feat/z' })
    expect(features.getTicket(z)).toMatchObject({ status: 'in_progress', rank: 2 })
  })

  it('by the human’s verdict clears its place', () => {
    const { z } = setup('review')
    features.setVerdict(z, 'disapproved', 'enrique')
    expect(features.getTicket(z)).toMatchObject({ status: 'cancelled', rank: null })

    const { pid, x, y, z: pr, other } = setup('review')
    dbm.db
      .update(dbm.schema.tickets)
      .set({ tags: ['PR'] })
      .where(eq(dbm.schema.tickets.id, pr))
      .run()
    features.setVerdict(pr, 'approved', 'enrique')
    expect(features.getTicket(pr)).toMatchObject({ status: 'done', rank: null })
    expect(column(pid, 'review')).toEqual([x, y, other])
  })

  it('by deleting its stage clears its place, and archiving clears it too', () => {
    const { pid, x, y, z, other } = setup('blocked')
    const blocked = stagesMod.listStages(pid).find((s) => s.key === 'blocked')!
    stagesMod.deleteStage(pid, blocked.id, { moveTo: 'review' }, 'enrique')
    expect(features.getTicket(z).rank).toBeNull()
    expect(column(pid, 'review').slice(0, 2)).toEqual([x, y])
    expect(column(pid, 'review').slice(2).sort()).toEqual([z, other].sort())

    const [d] = tickets(pid, 'done', ['shipped'])
    features.placeTicket(d!, 1, 'enrique')
    features.archiveTicket(d!, 'enrique')
    features.restoreTicket(d!, 'enrique')
    expect(features.getTicket(d!).rank).toBeNull()
  })

  it('leaves a new ticket unplaced, at the end of the merge queue', () => {
    const { pid, x, y } = setup('todo')
    const t = features.createTicket(pid, { title: 'new', status: 'review' }, 'claude')
    expect(column(pid, 'review')).toEqual([x, y, t.id])
  })
})

describe('the order over REST and MCP', () => {
  it('places a ticket with position on PATCH, as the human and as an agent; the list reads it back', async () => {
    const pid = newProject()
    const [a, b, c] = tickets(pid, 'review', ['A', 'B', 'C'])
    const list = async () => {
      const res = await call('GET', `/api/projects/${pid}/tickets?status=review&parent=root`, 'human:enrique')
      return (await res.json()) as { id: number; rank: number | null }[]
    }
    expect((await list()).map((t) => t.id)).toEqual([c, b, a])

    const placed = await call('PATCH', `/api/tickets/${a}`, 'human:enrique', { position: 1 })
    expect(placed.status).toBe(200)
    expect(await placed.json()).toMatchObject({ id: a, rank: 1 })
    expect((await list()).map((t) => [t.id, t.rank])).toEqual([
      [a, 1],
      [c, null],
      [b, null],
    ])

    expect((await call('PATCH', `/api/tickets/${b}`, 'agent:claude', { position: 2 })).status).toBe(200)
    expect((await list()).map((t) => t.id)).toEqual([a, b, c])
    expect((await list()).map((t) => t.id)).toEqual(column(pid, 'review'))

    // Whatever else the list holds, one stage's rows come in its column's order.
    tickets(pid, 'todo', ['T'])
    const all = (await (await call('GET', `/api/projects/${pid}/tickets`, 'human:enrique')).json()) as {
      id: number
      status: string
    }[]
    expect(all.filter((t) => t.status === 'review').map((t) => t.id)).toEqual([a, b, c])

    const daily = await (await call('GET', `/api/daily?projectId=${pid}`, 'human:enrique')).json()
    expect(daily.activity.map((e: { text: string }) => e.text)).toEqual(
      expect.arrayContaining([`moved ticket #${a} A to 1 of 3 in In review`]),
    )
  })

  it('answers 400 for a position below 1 or not whole, 404 for no such ticket', async () => {
    const pid = newProject()
    const [a] = tickets(pid, 'review', ['A'])
    for (const position of [0, -1, 1.5, '2'])
      expect((await call('PATCH', `/api/tickets/${a}`, 'human:enrique', { position })).status).toBe(400)
    // A bad position changes nothing else in the same call.
    expect(
      (await call('PATCH', `/api/tickets/${a}`, 'human:enrique', { status: 'todo', position: 0 })).status,
    ).toBe(400)
    expect(features.getTicket(a!).status).toBe('review')
    expect((await call('PATCH', '/api/tickets/999999', 'human:enrique', { position: 1 })).status).toBe(404)
  })

  it('with status, places it in the new stage', async () => {
    const pid = newProject()
    const [x, y] = tickets(pid, 'review', ['X', 'Y'])
    features.placeTicket(x!, 1, 'enrique')
    const [z] = tickets(pid, 'in_progress', ['Z'])
    const res = await call('PATCH', `/api/tickets/${z}`, 'agent:claude', { status: 'review', position: 1 })
    expect(res.status).toBe(200)
    expect(column(pid, 'review')).toEqual([z, x, y])
  })

  it('over MCP: update_ticket takes position, alone or with status, and says what it means', async () => {
    const pid = newProject()
    const [a, b] = tickets(pid, 'review', ['A', 'B'])
    const [c] = tickets(pid, 'in_progress', ['C'])
    await tool('update_ticket', { ticketId: a, position: 1 })
    expect(column(pid, 'review')).toEqual([a, b])
    await tool('update_ticket', { ticketId: c, status: 'review', position: 1 })
    expect(column(pid, 'review')).toEqual([c, a, b])

    const rows = (await tool('list_tickets', { projectId: pid, parentId: null, status: ['review'] })) as {
      id: number
      rank: number | null
    }[]
    expect(rows.map((t) => [t.id, t.rank])).toEqual([
      [c, 1],
      [a, 2],
      [b, null],
    ])

    const { result } = await mcp('tools/list', {})
    const tools = result.tools as { name: string; description: string; inputSchema: { properties: object } }[]
    const update = tools.find((t) => t.name === 'update_ticket')!
    expect(update.inputSchema.properties).toHaveProperty('position')
    expect(update.description).toMatch(/position/)
    expect(update.description).toMatch(/merge order/)
    expect(tools.find((t) => t.name === 'list_tickets')!.description).toMatch(/rank/)
  })
})
