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

describe('the review texts the board ships', () => {
  const skills = path.join(import.meta.dirname, 'skill', 'review')
  const repo = path.join(import.meta.dirname, '..', '..')
  // Read as the repo holds them, with the line endings folded to \n.
  const read = (file: string) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  const todoReview = read(path.join(skills, 'skills', 'todo-review', 'SKILL.md'))
  const ticketAgent = read(path.join(skills, 'agents', 'todo-review-ticket.md'))
  const reviewQueue = read(path.join(skills, 'skills', 'review-queue', 'SKILL.md'))
  const boardSkill = read(path.join(import.meta.dirname, 'skill', 'board.md'))
  const agentsDoc = read(path.join(repo, 'AGENTS.md'))
  const readme = read(path.join(repo, 'README.md'))
  // A sentence that a line break splits still matches: the whitespace is folded first.
  const flat = (text: string) => text.replace(/\s+/g, ' ')
  /** The text from `start` up to `end`, or to the end of the text when `end` is left out. */
  const between = (text: string, start: string, end?: string) => {
    const from = text.indexOf(start)
    expect(from, start).toBeGreaterThanOrEqual(0)
    if (end === undefined) return text.slice(from)
    const to = text.indexOf(end, from + start.length)
    expect(to, end).toBeGreaterThan(from)
    return text.slice(from, to)
  }
  /** The MCP instructions and tool descriptions, as a client gets them from the server. */
  async function served() {
    const init = await rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    })
    const tools = (await rpc('tools/list')).tools as { name: string; description: string }[]
    return { instructions: init.instructions as string, tools }
  }

  it('todo-review takes no rounds setting, and its brief to each ticket agent passes COMPLEXITY', () => {
    expect(todoReview).not.toContain('rounds=')
    expect(todoReview).not.toContain('ROUNDS=<n>')
    expect(todoReview).toContain('COMPLEXITY=<low, mid or high>')
  })

  it("todo-review says the orchestrator never changes a ticket's complexity, and the ticket agent never changes its own", () => {
    expect(flat(todoReview)).toContain("The orchestrator never changes a ticket's complexity")
    expect(flat(ticketAgent)).toContain("You never change a ticket's complexity")
  })

  it('todo-review reads each ticket level from the board into plan.md, and skips the DEPTH measure for a low ticket', () => {
    const text = flat(todoReview)
    expect(text).toContain(
      'plan.md`: every ticket with its repo, its complexity (the `complexity` field of its list row)',
    )
    expect(text).toContain('A low ticket skips this measure')
  })

  it('todo-review-ticket takes COMPLEXITY as its input and no ROUNDS input, and names the budget of each level', () => {
    const text = flat(ticketAgent)
    expect(text).toContain('`COMPLEXITY` (`low`, `mid` or `high`')
    expect(ticketAgent).not.toContain('`ROUNDS`')
    expect(text).toContain('low none, mid one round, high three')
    expect(text).toContain(
      'Round 1 is the first build with its gate and its review; rounds 2 and 3 are fix passes',
    )
  })

  it('todo-review-ticket ends the cycle at a round that survives, and asks the human after the last round that does not', () => {
    const text = flat(ticketAgent)
    expect(text).toContain('A surviving round ends the cycle')
    expect(text).toContain('(ship as is, keep going, drop) and stop: `BLOCKER: decision`')
  })

  it('todo-review-ticket runs a low ticket with no spec agent and no review, and the builder verifies it itself', () => {
    const text = flat(ticketAgent)
    expect(text).toContain('A low ticket has no spec and no spec agent')
    expect(text).toContain('Low: no review.')
    expect(text).toContain('Low: the builder codes and verifies itself.')
    expect(text).toContain('Its return gives the evidence per criterion')
  })

  it('todo-review-ticket sends a failed gate back at most twice, then asks the human, and a gate return uses no review round', () => {
    const text = flat(ticketAgent)
    expect(text).toContain('A gate return uses up no review round')
    expect(text).toContain('sends the change back at most twice, on every level')
    expect(text).toContain('`ask_decision` (keep going or drop) and stop: `BLOCKER: decision`')
  })

  it('todo-review-ticket keeps the review depth rules for mid and high, and its Review depth section names no ROUNDS budget', () => {
    const depth = between(ticketAgent, '## Review depth', '## Escalation')
    expect(depth).not.toContain('ROUNDS')
    expect(depth).toContain('`light`')
    expect(depth).toContain('`standard`')
    expect(depth).toContain('`deep`')
  })

  it('todo-review-ticket keeps nine labelled output lines, with ROUNDS 0 and VERDICT and DEPTH none for a low ticket', () => {
    const lines = between(ticketAgent, '## Output').split('```')[1]!.trim().split('\n')
    expect(lines.map((line) => line.split(':')[0])).toEqual([
      'STATUS',
      'TICKET',
      'VERDICT',
      'ROUNDS',
      'DEPTH',
      'PR',
      'PREVIEW',
      'BLOCKER',
      'NOTES',
    ])
    const line = (label: string) => lines.find((l) => l.startsWith(`${label}:`))!
    expect(line('ROUNDS')).toContain('0 for low')
    expect(line('VERDICT')).toContain('(low: no review)')
    expect(line('DEPTH')).toContain('(low: no review)')
  })

  it("todo-review-ticket's hand-off names the level and what checked it, and records a review only when one ran", () => {
    const text = flat(ticketAgent)
    expect(text).toContain('"How it was tested" names the level (`low`, `mid` or `high`)')
    expect(text).toContain('Only when a review ran (mid and high)')
  })

  it('the default builder note names the review rounds each level gets; the spec note names the low exception', async () => {
    const { DEFAULT_AGENTS } = await import('./defaultAgents')
    const byName = Object.fromEntries(DEFAULT_AGENTS.map((a) => [a.name, flat(a.delegation)]))
    expect(byName.builder).toContain(
      "The review rounds its ticket's complexity allows are none for low, one for mid, three for high, round 1 being the first build and its review.",
    )
    expect(byName.builder).toContain('Mid has one: a review that does not survive then goes to the human')
    expect(byName.builder).toContain('High has three: two fix passes follow the first build')
    expect(byName.builder).toContain('Low has no review: its checks return the build at most twice')
    expect(byName.spec).toContain('Not on a low ticket')
  })

  it('board.md, the MCP instructions and AGENTS.md give the rounds as the complexity sets them, never "at most three rounds"', async () => {
    const { instructions } = await served()
    for (const [name, text] of Object.entries({
      'board.md': boardSkill,
      'MCP instructions': instructions,
      'AGENTS.md': agentsDoc,
    })) {
      expect(flat(text), name).toContain('none for low, one for mid, three for high')
      expect(flat(text), name).not.toContain('at most three rounds')
    }
  })

  it('the MCP get_ticket and list_tickets descriptions say that complexity is returned, low, mid or high', async () => {
    const { tools } = await served()
    for (const name of ['get_ticket', 'list_tickets']) {
      expect(tools.find((t) => t.name === name)?.description, name).toContain('complexity (low, mid or high')
    }
  })

  it('README and board.md name complexity where the ticket fields are listed', () => {
    const row = readme
      .split('\n')
      .find((l) => l.includes('`/api/projects/:id/tickets`') && l.includes('`/api/tickets/:id`'))
    expect(row, 'the README row for tickets').toBeDefined()
    expect(row).toContain('`complexity` on create and PATCH')
    expect(between(boardSkill, 'Creating a top-level ticket', '\n\n')).toContain('`complexity`')
  })

  it('no shipped text tells an agent to use a rounds setting', async () => {
    const { instructions, tools } = await served()
    const reviewFiles = fs
      .readdirSync(skills, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.md'))
    const texts: Record<string, string> = {
      ...Object.fromEntries(reviewFiles.map((f) => [f, read(path.join(skills, f))])),
      'skill/board.md': boardSkill,
      'AGENTS.md': agentsDoc,
      'README.md': readme,
      'defaultAgents.ts': read(path.join(import.meta.dirname, 'defaultAgents.ts')),
      'MCP instructions': instructions,
      'MCP tool descriptions': tools.map((t) => t.description).join('\n'),
    }
    const banned = /rounds=|ROUNDS=|at most three rounds|three fix rounds/
    expect(Object.keys(texts).filter((name) => banned.test(texts[name]!))).toEqual([])
  })

  it('the skill and agent descriptions, and the review-queue build paragraph, promise no review for every ticket', () => {
    expect(todoReview).toMatch(/^description: .*low none, mid one, high three/m)
    expect(ticketAgent).toMatch(/^description: .*low gets no review/m)
    const building = reviewQueue.slice(reviewQueue.indexOf('**Building**'))
    expect(flat(building)).toContain('a low ticket has no spec agent and no review')
  })
})
