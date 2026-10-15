import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-complexity-'))
process.env.DATA_DIR = tmp

const LEVELS = ['low', 'mid', 'high']

let dbm: typeof import('#/db')
let handle: (request: Request) => Promise<Response>
beforeAll(async () => {
  dbm = await import('#/db')
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  // As the server answers: an HttpError becomes its status with `{error}`. A bearer token is an agent.
  const guarded = guard(({ request }: { request: Request }) =>
    api.handle(request, request.headers.has('authorization') ? 'claude' : 'enrique'),
  )
  handle = (request) => guarded({ request })
})

function newProject(name: string) {
  const id = dbm.db.insert(dbm.schema.projects).values({ name }).returning().get().id
  dbm.db
    .insert(dbm.schema.repos)
    .values({ projectId: id, name: 'api', repoPath: `/r/${name}` })
    .run()
  return id
}

const ticketCount = () => dbm.db.select().from(dbm.schema.tickets).all().length

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
/** A JSON-RPC call to the MCP server, answered as the whole body (a result or an error). */
async function rpcBody(method: string, params: Record<string, unknown> = {}) {
  const { handleMcp } = await import('./mcp')
  const res = await handleMcp(
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    }),
    'claude',
  )
  return (await res.json()) as { result?: any; error?: { message: string } }
}
async function rpc(method: string, params: Record<string, unknown> = {}) {
  return (await rpcBody(method, params)).result
}
async function tool(name: string, args: Record<string, unknown>) {
  const result = (await rpc('tools/call', { name, arguments: args })) as {
    isError?: boolean
    content: { text: string }[]
  }
  expect(result.isError, result.content[0]!.text).toBeFalsy()
  return JSON.parse(result.content[0]!.text)
}
/** The text of an MCP call that was refused: its error result, or the JSON-RPC error when it did not parse. */
async function refused(name: string, args: Record<string, unknown>) {
  const body = await rpcBody('tools/call', { name, arguments: args })
  const failed = body.error !== undefined || body.result?.isError === true
  expect(failed, `${name} ${JSON.stringify(args)} was not refused`).toBe(true)
  return JSON.stringify(body.result ?? body.error)
}

describe("a ticket's complexity", () => {
  it('is stored by REST create and PATCH, and read back by GET one and by the list rows', async () => {
    const p = newProject('rest')
    const made = await call('POST', `/api/projects/${p}/tickets`, {
      title: 'high at once',
      complexity: 'high',
    })
    expect(made.status).toBe(201)
    expect(made.body.complexity).toBe('high')
    const agent = await call(
      'POST',
      `/api/projects/${p}/tickets`,
      { title: 'by agent', complexity: 'low' },
      'agent',
    )
    expect(agent.status).toBe(201)
    expect(agent.body.complexity).toBe('low')

    const plain = await call('POST', `/api/projects/${p}/tickets`, { title: 'raised later' })
    expect(plain.body.complexity).toBe('mid')
    const patched = await call('PATCH', `/api/tickets/${plain.body.id}`, { complexity: 'high' })
    expect(patched.status).toBe(200)
    expect(patched.body.complexity).toBe('high')
    expect((await call('GET', `/api/tickets/${plain.body.id}`)).body.complexity).toBe('high')

    const rows = (await call('GET', `/api/projects/${p}/tickets`)).body as {
      id: number
      complexity: string
    }[]
    expect(rows.find((t) => t.id === made.body.id)?.complexity).toBe('high')
    expect(rows.find((t) => t.id === plain.body.id)?.complexity).toBe('high')
  })

  it('is refused over REST unless it is exactly low, mid or high, naming the three, and nothing is stored', async () => {
    const p = newProject('refused rest')
    const kept = await call('POST', `/api/projects/${p}/tickets`, { title: 'kept as it is' })
    const before = ticketCount()
    for (const complexity of ['extreme', 'High']) {
      const posted = await call('POST', `/api/projects/${p}/tickets`, { title: 'refused', complexity })
      expect(posted.status, complexity).toBe(400)
      const patched = await call('PATCH', `/api/tickets/${kept.body.id}`, { complexity })
      expect(patched.status, complexity).toBe(400)
      for (const level of LEVELS) {
        expect(posted.body.error).toContain(level)
        expect(patched.body.error).toContain(level)
      }
    }
    expect(ticketCount()).toBe(before)
    expect((await call('GET', `/api/tickets/${kept.body.id}`)).body.complexity).toBe('mid')
  })

  it('is refused over MCP with an error that names the three, and nothing is stored', async () => {
    const p = newProject('refused mcp')
    const kept = await tool('create_ticket', { projectId: p, title: 'kept as it is' })
    const before = ticketCount()
    for (const complexity of ['extreme', 'High']) {
      const posted = await refused('create_ticket', { projectId: p, title: 'refused', complexity })
      const patched = await refused('update_ticket', { ticketId: kept.id, complexity })
      for (const level of LEVELS) {
        expect(posted).toContain(level)
        expect(patched).toContain(level)
      }
    }
    expect(ticketCount()).toBe(before)
    expect((await tool('get_ticket', { ticketId: kept.id })).complexity).toBe('mid')
  })

  it('is mid for a ticket created without one, over REST and MCP', async () => {
    const p = newProject('default')
    const rest = await call('POST', `/api/projects/${p}/tickets`, { title: 'plain over REST' })
    expect(rest.body.complexity).toBe('mid')
    const mcp = await tool('create_ticket', { projectId: p, title: 'plain over MCP' })
    expect(mcp.complexity).toBe('mid')
    expect((await tool('get_ticket', { ticketId: mcp.id })).complexity).toBe('mid')
  })

  it("a lane copies its parent's level when it is made; a later change to the parent does not reach it", async () => {
    const p = newProject('lanes')
    const parent = await call('POST', `/api/projects/${p}/tickets`, { title: 'parent', complexity: 'high' })
    const lane = await call('POST', `/api/projects/${p}/tickets`, { title: 'lane', parentId: parent.body.id })
    expect(lane.body.complexity).toBe('high')
    const given = await call('POST', `/api/projects/${p}/tickets`, {
      title: 'lane given low',
      parentId: parent.body.id,
      complexity: 'low',
    })
    expect(given.body.complexity).toBe('low')

    expect((await call('PATCH', `/api/tickets/${parent.body.id}`, { complexity: 'low' })).status).toBe(200)
    expect((await call('GET', `/api/tickets/${lane.body.id}`)).body.complexity).toBe('high')
    expect((await call('GET', `/api/tickets/${given.body.id}`)).body.complexity).toBe('low')
    // A lane made after the change copies the parent's level as it is then.
    const later = await call('POST', `/api/projects/${p}/tickets`, {
      title: 'later',
      parentId: parent.body.id,
    })
    expect(later.body.complexity).toBe('low')
    // Over MCP too.
    const mcpLane = await tool('create_ticket', { projectId: p, title: 'mcp lane', parentId: parent.body.id })
    expect(mcpLane.complexity).toBe('low')
    expect((await tool('get_ticket', { ticketId: lane.body.id })).complexity).toBe('high')
  })

  it('is returned by MCP get_ticket and list_tickets, with the same rows as REST', async () => {
    const p = newProject('mcp reads')
    const made = await tool('create_ticket', { projectId: p, title: 'high over MCP', complexity: 'high' })
    expect(made.complexity).toBe('high')
    expect((await tool('get_ticket', { ticketId: made.id })).complexity).toBe('high')

    const listed = (await tool('list_tickets', { projectId: p })) as { id: number; complexity: string }[]
    const rest = (await call('GET', `/api/projects/${p}/tickets`)).body as {
      id: number
      complexity: string
    }[]
    expect(listed.find((t) => t.id === made.id)?.complexity).toBe('high')
    expect(listed.map((t) => [t.id, t.complexity])).toEqual(rest.map((t) => [t.id, t.complexity]))
  })

  it('is an optional enum of exactly low, mid and high on MCP create_ticket and update_ticket, with a description', async () => {
    const tools = (await rpc('tools/list')).tools as { name: string; description: string; inputSchema: any }[]
    for (const name of ['create_ticket', 'update_ticket']) {
      const tool = tools.find((t) => t.name === name)!
      const field = tool.inputSchema.properties.complexity
      expect(field.enum, name).toEqual(LEVELS)
      expect(tool.inputSchema.required ?? [], name).not.toContain('complexity')
      expect(field.description, name).toMatch(/\S/)
      expect(field.description, name).not.toContain('\n')
      expect(tool.description, name).toContain('complexity')
    }
  })
})
