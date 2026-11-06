import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-open-tasks-'))
process.env.DATA_DIR = tmp

let dbm: typeof import('#/db')
let features: typeof import('./features')
let needs: typeof import('./needs')
let handle: (request: Request) => Promise<Response>
beforeAll(async () => {
  dbm = await import('#/db')
  features = await import('./features')
  needs = await import('./needs')
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  // As the server answers: an HttpError becomes its status with `{error}`; a bearer token is an agent.
  const guarded = guard(({ request }: { request: Request }) =>
    api.handle(request, request.headers.has('authorization') ? 'claude' : 'enrique'),
  )
  handle = (request) => guarded({ request })
})

async function call(method: string, pathname: string, body?: unknown) {
  const res = await handle(
    new Request(`http://localhost${pathname}`, {
      method,
      headers: {
        authorization: 'Bearer token-of-test',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
  return { status: res.status, body: (await res.json()) as any }
}

let rpcId = 0
async function tool(name: string, args: Record<string, unknown>) {
  const { handleMcp } = await import('./mcp')
  const res = await handleMcp(
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }),
    'claude',
  )
  const result = ((await res.json()) as { result: { isError?: boolean; content: { text: string }[] } }).result
  expect(result.isError, result.content[0]!.text).toBeFalsy()
  return JSON.parse(result.content[0]!.text)
}

/** A project on a folder that is no git checkout: the phases that follow git and GitHub stay as they are. */
function newProject(name: string) {
  const projectId = dbm.db.insert(dbm.schema.projects).values({ name }).returning().get().id
  dbm.db
    .insert(dbm.schema.repos)
    .values({ projectId, name: 'repo', repoPath: fs.mkdtempSync(path.join(tmp, 'not-git-')) })
    .run()
  return projectId
}

const newTicket = (projectId: number, input: Parameters<typeof needs.newTicket>[1]) =>
  needs.newTicket(projectId, { status: 'in_progress', ...input }, 'claude', { agent: true })
const taskOf = (ticketId: number, text: string) =>
  dbm.db
    .select()
    .from(dbm.schema.tasks)
    .all()
    .find((x) => x.ticketId === ticketId && x.text === text)!
const tick = (ticketId: number, text: string) =>
  features.updateTask(taskOf(ticketId, text).id, { done: true }, 'claude')
/** Ticked straight in the table, as the board does for a phase that follows a fact. */
const setDone = (ticketId: number, text: string) =>
  dbm.db
    .update(dbm.schema.tasks)
    .set({ done: true })
    .where(eq(dbm.schema.tasks.id, taskOf(ticketId, text).id))
    .run()
const row = (ticketId: number, text: string, auto = false) => ({
  taskId: taskOf(ticketId, text).id,
  ticketId,
  text,
  auto,
})

describe('moving a ticket to review', () => {
  it("answers with what is still open, in tree order, its lanes' too, without Merged", async () => {
    const p = newProject('open')
    const t = await newTicket(p, { title: 't', tasks: ['code', 'test'] })
    const lane = await newTicket(p, { title: 'lane', parentId: t.id, tasks: ['lane step'] })
    const laneOfLane = await newTicket(p, { title: 'deeper', parentId: lane.id, tasks: ['deep step'] })
    const dropped = await newTicket(p, { title: 'dropped', parentId: t.id, tasks: ['never'] })
    features.updateTicket(dropped.id, { status: 'cancelled' }, 'claude')
    tick(t.id, 'code')

    // Not a review stage: no `open`.
    const renamed = await needs.changeTicket(t.id, { title: 'renamed' }, 'claude', { agent: true })
    expect(renamed).not.toHaveProperty('open')
    expect(renamed).not.toHaveProperty('handoff')
    const blocked = await needs.changeTicket(t.id, { status: 'blocked' }, 'claude', { agent: true })
    expect(blocked).not.toHaveProperty('open')
    expect((await needs.ticketView(t.id)).open).toBeNull()

    const moved = await needs.changeTicket(t.id, { status: 'review' }, 'claude', { agent: true })
    // Goes through, never refused for what is open.
    expect(moved.status).toBe('review')
    expect(moved).not.toHaveProperty('handoff')
    const open = 'open' in moved ? moved.open : null
    expect(open).toEqual([
      // Implementation is open while one of its steps is.
      row(t.id, 'Implementation'),
      row(t.id, 'test'),
      row(t.id, 'Pushed', true),
      row(t.id, 'PR', true),
      row(t.id, 'CI', true),
      row(t.id, 'Preview', true),
      row(t.id, 'Summary', true),
      // The lane before its own lane; the cancelled lane left out.
      row(lane.id, 'lane step'),
      row(laneOfLane.id, 'deep step'),
    ])

    // get_ticket and the page's read give the same while it is in review, and no `handoff`.
    const view = await needs.ticketView(t.id)
    expect(view.open).toEqual(open)
    expect(view).not.toHaveProperty('handoff')
  })

  it('answers open: [] once every task is done, Merged still open (the human merges)', async () => {
    const p = newProject('all done')
    const t = await newTicket(p, { title: 't', tasks: ['code'] })
    tick(t.id, 'code')
    // Every phase's fact holds as the board reads it: a repo it cannot read keeps Pushed, PR and CI as
    // ticked, a preview off this machine is taken on trust, and an agent wrote the summary.
    for (const phase of ['Pushed', 'PR', 'CI']) setDone(t.id, phase)
    dbm.db.delete(dbm.schema.repos).where(eq(dbm.schema.repos.projectId, p)).run()
    features.addWorkspace(t.id, { name: 'wt', previewUrl: 'https://preview.example.com' }, 'claude')
    features.setSummary(t.id, { body: 'What it does, the PR, the preview.' }, 'claude')
    const moved = await needs.changeTicket(t.id, { status: 'review' }, 'claude', { agent: true })
    expect('open' in moved && moved.open).toEqual([])
    const view = await needs.ticketView(t.id)
    expect(view.open).toEqual([])
    expect(view.tasks.find((x) => x.text === 'Merged')!.done).toBe(false)
  })

  it('answers the same over REST and MCP: update_ticket, PATCH, get_ticket and GET', async () => {
    const p = newProject('surfaces')
    const a = await newTicket(p, { title: 'a', tasks: ['code'] })
    const b = await newTicket(p, { title: 'b', tasks: ['code'] })

    const patched = await call('PATCH', `/api/tickets/${a.id}`, { status: 'review' })
    expect(patched.status).toBe(200)
    expect(patched.body.status).toBe('review')
    expect(patched.body).not.toHaveProperty('handoff')
    const expected = [
      row(a.id, 'Implementation'),
      row(a.id, 'code'),
      ...['Pushed', 'PR', 'CI', 'Preview', 'Summary'].map((x) => row(a.id, x, true)),
    ]
    expect(patched.body.open).toEqual(expected)
    const got = await call('GET', `/api/tickets/${a.id}`)
    expect(got.body.open).toEqual(expected)
    expect(got.body).not.toHaveProperty('handoff')

    const updated = await tool('update_ticket', { ticketId: b.id, status: 'review' })
    expect(updated.status).toBe('review')
    expect(updated).not.toHaveProperty('handoff')
    expect(updated.open).toEqual(expected.map((x) => ({ ...x, ...row(b.id, x.text, x.auto) })))
    const read = await tool('get_ticket', { ticketId: b.id })
    expect(read.open).toEqual(updated.open)
    expect(read).not.toHaveProperty('handoff')

    // Out of review again: null.
    expect((await tool('update_ticket', { ticketId: b.id, status: 'in_progress' })).open).toBeUndefined()
    expect((await tool('get_ticket', { ticketId: b.id })).open).toBeNull()
  })
})
