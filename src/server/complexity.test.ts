import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-complexity-'))
process.env.DATA_DIR = tmp

const LEVELS = ['low', 'mid', 'high', 'max']

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
        ...(as === 'agent' ? { authorization: 'Bearer token-of-test' } : {}),
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
    const atMax = await call('POST', `/api/projects/${p}/tickets`, {
      title: 'max at once',
      complexity: 'max',
    })
    expect(atMax.status).toBe(201)
    expect(atMax.body.complexity).toBe('max')
    const agent = await call(
      'POST',
      `/api/projects/${p}/tickets`,
      { title: 'by agent', complexity: 'low' },
      'agent',
    )
    expect(agent.status).toBe(201)
    expect(agent.body.complexity).toBe('low')
    // An agent token sets the top level too: nothing refuses it, and the level reads back.
    const agentMax = await call(
      'POST',
      `/api/projects/${p}/tickets`,
      { title: 'max by agent', complexity: 'max' },
      'agent',
    )
    expect(agentMax.status).toBe(201)
    expect(agentMax.body.complexity).toBe('max')

    const plain = await call('POST', `/api/projects/${p}/tickets`, { title: 'raised later' })
    expect(plain.body.complexity).toBe('mid')
    const patched = await call('PATCH', `/api/tickets/${plain.body.id}`, { complexity: 'high' })
    expect(patched.status).toBe(200)
    expect(patched.body.complexity).toBe('high')
    expect((await call('GET', `/api/tickets/${plain.body.id}`)).body.complexity).toBe('high')

    // mid to max, and high to max: both answer 200 and stay max, over a re-read and the list.
    const toMax = await call('PATCH', `/api/tickets/${plain.body.id}`, { complexity: 'max' })
    expect(toMax.status).toBe(200)
    expect(toMax.body.complexity).toBe('max')
    expect((await call('GET', `/api/tickets/${plain.body.id}`)).body.complexity).toBe('max')
    const raised = await call('PATCH', `/api/tickets/${made.body.id}`, { complexity: 'max' })
    expect(raised.status).toBe(200)
    expect(raised.body.complexity).toBe('max')
    expect((await call('GET', `/api/tickets/${made.body.id}`)).body.complexity).toBe('max')

    const rows = (await call('GET', `/api/projects/${p}/tickets`)).body as {
      id: number
      complexity: string
    }[]
    expect(rows.find((t) => t.id === made.body.id)?.complexity).toBe('max')
    expect(rows.find((t) => t.id === plain.body.id)?.complexity).toBe('max')
    expect(rows.find((t) => t.id === atMax.body.id)?.complexity).toBe('max')
    expect(rows.find((t) => t.id === agentMax.body.id)?.complexity).toBe('max')
    expect(rows.find((t) => t.id === agent.body.id)?.complexity).toBe('low')
  })

  it('is refused over REST unless it is exactly low, mid, high or max, naming the four, and nothing is stored', async () => {
    const p = newProject('refused rest')
    const kept = await call('POST', `/api/projects/${p}/tickets`, { title: 'kept as it is' })
    const before = ticketCount()
    for (const complexity of ['extreme', 'High', 'Max', 'maximum', '']) {
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

  it('is refused over MCP with an error that names the four, and nothing is stored', async () => {
    const p = newProject('refused mcp')
    const kept = await tool('create_ticket', { projectId: p, title: 'kept as it is' })
    const before = ticketCount()
    for (const complexity of ['extreme', 'High', 'Max', 'maximum', '']) {
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

  it("a lane copies its parent's level when it is made, max included; a later change to the parent does not reach it", async () => {
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

    // A max parent hands its level down the same way, and changing it later does not reach its lanes.
    const top = await call('POST', `/api/projects/${p}/tickets`, {
      title: 'max parent',
      complexity: 'max',
    })
    const maxLane = await call('POST', `/api/projects/${p}/tickets`, {
      title: 'max lane',
      parentId: top.body.id,
    })
    expect(maxLane.body.complexity).toBe('max')
    const lowGivenMaxLane = await call('POST', `/api/projects/${p}/tickets`, {
      title: 'max lane given low',
      parentId: top.body.id,
      complexity: 'low',
    })
    expect(lowGivenMaxLane.body.complexity).toBe('low')
    const mcpMaxLane = await tool('create_ticket', {
      projectId: p,
      title: 'mcp max lane',
      parentId: top.body.id,
    })
    expect(mcpMaxLane.complexity).toBe('max')

    expect((await call('PATCH', `/api/tickets/${top.body.id}`, { complexity: 'high' })).status).toBe(200)
    expect((await call('GET', `/api/tickets/${maxLane.body.id}`)).body.complexity).toBe('max')
    expect((await call('GET', `/api/tickets/${lowGivenMaxLane.body.id}`)).body.complexity).toBe('low')
    expect((await tool('get_ticket', { ticketId: mcpMaxLane.id })).complexity).toBe('max')
    // A lane made after the change copies the parent as it is then, over both surfaces.
    const afterChange = await call('POST', `/api/projects/${p}/tickets`, {
      title: 'lane after the change',
      parentId: top.body.id,
    })
    expect(afterChange.body.complexity).toBe('high')
    const mcpAfterChange = await tool('create_ticket', {
      projectId: p,
      title: 'mcp lane after the change',
      parentId: top.body.id,
    })
    expect(mcpAfterChange.complexity).toBe('high')
  })

  it('is returned by MCP get_ticket and list_tickets, with the same rows as REST', async () => {
    const p = newProject('mcp reads')
    const made = await tool('create_ticket', { projectId: p, title: 'high over MCP', complexity: 'high' })
    expect(made.complexity).toBe('high')
    expect((await tool('get_ticket', { ticketId: made.id })).complexity).toBe('high')
    const atMax = await tool('create_ticket', { projectId: p, title: 'max over MCP', complexity: 'max' })
    expect(atMax.complexity).toBe('max')
    expect((await tool('get_ticket', { ticketId: atMax.id })).complexity).toBe('max')

    const listed = (await tool('list_tickets', { projectId: p })) as { id: number; complexity: string }[]
    const rest = (await call('GET', `/api/projects/${p}/tickets`)).body as {
      id: number
      complexity: string
    }[]
    expect(listed.find((t) => t.id === made.id)?.complexity).toBe('high')
    expect(listed.find((t) => t.id === atMax.id)?.complexity).toBe('max')
    expect(listed.map((t) => [t.id, t.complexity])).toEqual(rest.map((t) => [t.id, t.complexity]))
  })

  it('is an optional enum of exactly low, mid, high and max on MCP create_ticket and update_ticket, with a description', async () => {
    const tools = (await rpc('tools/list')).tools as { name: string; description: string; inputSchema: any }[]
    for (const name of ['create_ticket', 'update_ticket']) {
      const tool = tools.find((t) => t.name === name)!
      const field = tool.inputSchema.properties.complexity
      expect(field.enum, name).toEqual(LEVELS)
      expect(tool.inputSchema.required ?? [], name).not.toContain('complexity')
      expect(field.description, name).toMatch(/\S/)
      expect(field.description, name).not.toContain('\n')
      expect(field.description, name).toContain('max up to ten')
      expect(field.description, name).toContain('never max')
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
  const featureReview = read(path.join(skills, 'skills', 'feature-review', 'SKILL.md'))
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

  describe('the intent check and the full cycle', () => {
    const intentAgent = read(path.join(skills, 'agents', 'feature-review-intent.md'))
    const intentTemplate = read(path.join(skills, 'run-reports', 'intent.md'))
    const intentNotes = async () => {
      const { DEFAULT_AGENTS } = await import('./defaultAgents')
      return DEFAULT_AGENTS.find((a) => a.name === 'intent')!
    }

    it('the intent agent runs at low effort and reads only the human’s words and the result, never the plan, spec or findings', () => {
      const t = flat(intentAgent)
      expect(t).toContain('You run at **low effort**')
      expect(t).toContain("The human's own words and attachments")
      expect(t).toContain('every post and reply by the human, newest last')
      expect(t).toContain('The latest comment that sent the ticket back weighs most')
      expect(t).toContain('the preview (its link), the screenshots or recordings, and the diff')
      expect(t).toContain("You must NOT read the builder's plan, the spec, the review's findings")
      expect(t).toContain('never asks the human, and never answers a decision (`answer_decision`)')
      expect(t).toContain('you build and edit nothing')
    })

    it('the intent agent answers one line per ask and a verdict, with the words beside what was built', () => {
      const t = flat(intentAgent)
      expect(t).toContain('done as asked | done differently (<how>) | not done')
      expect(t).toContain('Evidence: <a screenshot region, or a line of the diff')
      expect(t).toContain('matches | does not match')
      expect(t).toContain("the human's words next to what was built")
      expect(intentTemplate).toContain('run-reports/intent.md')
      expect(intentTemplate).toContain('`asked`')
      expect(intentTemplate).toContain('`compared`')
    })

    it('the default intent agent carries both triggers, the effort, the input rule and where the verdicts go', async () => {
      const { delegation, instructions } = await intentNotes()
      const d = flat(delegation)
      expect(instructions).toContain('You run at **low effort**')
      expect(d).toContain(
        'after the last review round passes and before every hand-off, on every ticket of any complexity',
      )
      expect(d).toContain('a low ticket included')
      expect(d).toContain('again after any human comment that sent the ticket back')
      expect(d).toContain("(the Agent tool's `effort: low`) for every complexity")
      expect(d).toContain("Never the builder's plan, the spec or the review's findings")
      expect(d).toContain('done as asked, done differently with how, or not done')
      expect(d).toContain('`matches` hands off')
      expect(d).toContain(
        "`does not match` goes back to **builder** with the intent check's lines as the brief, then the gate, then one more full review round (above low; numbering continues, all six phases run again), then the intent check again",
      )
      expect(d).toContain(
        "A `does not match` is outside the complexity's round budget; after the second one on a ticket the ticket agent stops and asks the human (`ask_decision`: keep going, ship as is, drop) with the intent check's lines and the human's words on the card",
      )
      expect(d).toContain(
        'the result (the preview link, its screenshots or recordings, the diff at the current head). The preview is started, and its screenshots taken, before this check',
      )
      expect(d).toContain(
        'A commit after a `matches` (a CI fix, a rebase or a merge of the base) changes the head, so it runs again on the new head',
      )
      expect(d).toContain('the human is asked only when two readings of their words are both plausible')
      expect(d).toContain('with both readings on the card (`ask_decision`)')
    })

    it('feature-review, todo-review and the ticket agent each place the intent phase, its low effort and its input rule', () => {
      for (const [name, text] of [
        ['feature-review', featureReview],
        ['ticket agent', ticketAgent],
        ['todo-review', todoReview],
      ] as const) {
        const t = flat(text)
        expect(t, name).toContain('intent')
        expect(t, name).toContain('`low` effort')
        expect(t, name).toMatch(/builder's plan, the spec or the review's findings/i)
        expect(t, name).toContain('`does not match`')
        expect(t, name).toContain('`matches`')
      }
      const ticket = flat(between(ticketAgent, '### 6b. The intent check', '### 7. Hand off'))
      expect(ticket).toContain(
        'before every hand-off, on every ticket of any complexity, low included: a low ticket skips the review, never the intent check',
      )
      expect(ticket).toContain('again after any human comment that sent the ticket back')
      expect(ticket).toContain('at `effort: low`, whatever the complexity')
      expect(ticket).toContain('`done as asked`, `done differently (how)` or `not done`')
      expect(ticket).toContain(
        "`does not match`: back to the builder (step 3) with the intent check's lines as the brief, then your gate (step 4), then ONE more full review round (mid, high and max; numbering continues from the last round, all six phases run again with two hunts; a low ticket has no review, only the gate), then the intent check again",
      )
      expect(ticket).toContain(
        "A `does not match` is not a gate return and is outside the complexity's round budget (step 5). After the SECOND `does not match` on one ticket, stop and ask the human with `ask_decision` (keep going, ship as is, drop), with the intent check's lines and the human's words on the card",
      )
      expect(ticket).toContain(
        'the result: the preview link (started in step 6), its screenshots or recordings, and the diff at the current head',
      )
      expect(ticket).toContain(
        'Any commit after a `matches` (a CI fix, a rebase or a merge of the base) changes the head, so the intent check runs again on the new head before the hand-off stands',
      )
      expect(flat(between(ticketAgent, '### 6. Evidence', '### 6b.'))).toContain(
        'Start the preview here, before the intent check: it is the one build of this head for the preview',
      )
      const handoff = flat(between(ticketAgent, '### 7. Hand off', '## Review depth'))
      expect(handoff).toContain(
        'the one step 6 already started and kept running, reused here, not built again',
      )
      expect(handoff).toContain(
        'A fix commit changes the head, so the intent check (step 6b) runs again on the new head before the hand-off stands',
      )
      expect(flat(between(ticketAgent, '**The budget**', '**The full cycle'))).toContain(
        'An intent return (`does not match`, step 6b) is not a gate return and is outside this budget',
      )
      expect(ticket).toContain('both readings on the card (`ask_decision`), never otherwise')
      expect(flat(ticketAgent)).toContain('it runs at `low` effort whatever the complexity')
      expect(flat(between(ticketAgent, '### 7. Hand off', '## Review depth'))).toContain(
        'Only after the intent check (step 6b) returned `matches`',
      )
      expect(flat(featureReview)).toContain('again after any human comment that sent the ticket back')
      expect(flat(todoReview)).toContain(
        'the intent agent, which runs at `low` effort whatever the complexity',
      )
    })

    it('the board skill and AGENTS.md name the intent check in the hand-off and the cycle', () => {
      for (const [name, text] of [
        ['board skill', boardSkill],
        ['AGENTS.md', agentsDoc],
      ] as const) {
        const t = flat(text)
        expect(t, name).toContain(
          'The intent check comes first, on every ticket of any complexity (low included)',
        )
        expect(t, name).toContain('at `low` effort whatever the complexity')
        expect(t, name).toContain("never the builder's plan, the spec or the review's findings")
        expect(t, name).toContain('`matches` hands off; `does not match` goes back to the builder')
        expect(t, name).toContain(
          "then the gate, then one more full review round (above low; the numbering continues, all six phases run again), then the intent check again. A `does not match` is outside the complexity's round budget; after the second one on a ticket the ticket agent stops and asks the human (`ask_decision`: keep going, ship as is, drop) with the intent check's lines and the human's words on the card",
        )
        expect(t, name).toContain(
          'the preview is started first, with its screenshots, and the check reads it at the current head; a commit after a `matches`, such as a CI fix, changes the head, so the check runs again on it',
        )
        expect(t.replaceAll('**intent**', 'intent'), name).toContain(
          'the intent check at `low` effort (every complexity) → hand off',
        )
      }
      expect(flat(readme)).toContain('hunt, refute, merge, intent)')
    })

    it('above low the full cycle is mandatory, in every text that describes a round', () => {
      const full =
        'every review round runs spec, env, verify, two independent hunts, refute and the merge check'
      for (const [name, text] of [
        ['feature-review', featureReview],
        ['ticket agent', ticketAgent],
        ['board skill', boardSkill],
        ['AGENTS.md', agentsDoc],
      ] as const) {
        const t = flat(text)
        expect(t.toLowerCase(), name).toContain(full)
      }
      const fr = flat(featureReview)
      expect(fr).toContain(
        'None is skipped because the findings look obvious, the change looks small or a finding was already reproduced, and each phase posts its result, so a skipped phase is visible',
      )
      expect(flat(ticketAgent)).toContain(
        'None is skipped because the findings look obvious, the change looks small or a finding was already reproduced, and each phase posts its result, so a skipped phase is visible',
      )
      expect(flat(todoReview)).toContain(
        'every round of a mid, high or max ticket runs spec, env, verify, two independent hunts, refute and the merge check, `light` included',
      )
      expect(flat(boardSkill)).toContain(
        'None is skipped because findings look obvious, the change looks small or a finding was already reproduced',
      )
      expect(flat(agentsDoc)).toContain(
        'None is skipped because findings look obvious, the change looks small or a finding was already reproduced',
      )
      expect(fr).toContain('Refute always runs, also when `03-all-candidates.md` has no candidate at all')
      expect(fr).toContain('**Two independent hunts always run.**')
      expect(fr).toContain(
        '`light` | a depth name only: it has no effect on the phases, every round runs all of them',
      )
    })

    it('no text lets a phase be skipped any more: no light second-hunt drop, no trust in a clean first hunt, no skipped refute', async () => {
      const report = read(path.join(skills, 'skills', 'feature-review', 'report-template.md'))
      const summary = read(path.join(skills, 'skills', 'feature-review', 'summary-template.md'))
      const { DEFAULT_AGENTS } = await import('./defaultAgents')
      const notes = flat(DEFAULT_AGENTS.map((a) => a.delegation).join('\n'))
      const gone = [
        'A clean first hunt is not trusted',
        'a clean first hunt gets no second hunt',
        'a clean first hunt gets a second hunt',
        '**Light mode**',
        'In light mode',
        'light mode: no second hunt',
        'One hunt ran (light mode)',
        'skip Phase 3',
        'Skip Phase 3',
        'The one thing dropped is the second hunt',
        'except in a light review',
        'when there is at least one candidate',
        'when there is at least one',
        'at least one candidate or FAIL',
        'one hunt, refute',
      ]
      const texts = [featureReview, ticketAgent, todoReview, report, summary, boardSkill, agentsDoc, notes]
      for (const phrase of gone) for (const text of texts) expect(flat(text), phrase).not.toContain(phrase)
      expect(flat(report)).toContain('Hunts: two (independent, always)')
      expect(notes).toContain('Two independent hunts always run')
      expect(notes).toContain('every round, also when there is no candidate or FAIL')
      const depths = flat(between(ticketAgent, '| Depth | When |', 'The depth only moves up'))
      expect(depths).toContain('with `light`: the same full cycle, no phase dropped')
      expect(depths).not.toContain('one hunt')
    })

    it('a low ticket keeps its path: no rounds, no depth, and the intent check still runs', () => {
      const low = flat(between(ticketAgent, '**Low: no review.**', '**Mid, high and max.**'))
      expect(low).toContain('Run no `/feature-review`')
      expect(flat(ticketAgent)).toContain('DEPTH: <light | standard | deep>')
      expect(flat(ticketAgent)).toContain('none (low: no review)')
      expect(flat(ticketAgent)).toContain('a low ticket skips the review, never the intent check')
    })

    it('the hand-off reads missingReviewPhases: the ticket agent, the board skill, AGENTS.md and the tool descriptions', async () => {
      const step7 = flat(between(ticketAgent, '7. `update_ticket` to `review`', '## Review depth'))
      expect(step7).toContain('read `missingReviewPhases`')
      expect(step7).toContain('Run each missing phase, with a fix round through the builder if it needs code')
      expect(step7).toContain('before the hand-off stands')
      expect(flat(boardSkill)).toContain('`missingReviewPhases`')
      expect(flat(boardSkill)).toContain('It is a flag, not a refusal: run each missing phase')
      expect(flat(agentsDoc)).toContain('`missingReviewPhases`')
      expect(flat(todoReview)).toContain('`missingReviewPhases` is empty')
      const { tools } = await served()
      for (const name of ['update_ticket', 'get_ticket'])
        expect(tools.find((x) => x.name === name)!.description, name).toContain('missingReviewPhases')
    })
  })

  it('todo-review takes no rounds setting, and its brief to each ticket agent passes COMPLEXITY', () => {
    expect(todoReview).not.toContain('rounds=')
    expect(todoReview).not.toContain('ROUNDS=<n>')
    expect(todoReview).toContain('COMPLEXITY=<low, mid, high or max>')
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
    expect(text).toContain('`COMPLEXITY` (`low`, `mid`, `high` or `max`')
    expect(ticketAgent).not.toContain('`ROUNDS`')
    expect(text).toContain('low none, mid one round, high three, max up to ten')
    expect(text).toContain(
      'Round 1 is the first build with its gate and its review; rounds 2 and 3 are fix passes',
    )
  })

  it('todo-review-ticket ends the cycle at a round that survives, and asks the human after the last round that does not', () => {
    const text = flat(ticketAgent)
    expect(text).toContain('A surviving round ends the cycle')
    expect(text).toContain('(ship as is, keep going, drop) and stop: `BLOCKER: decision`')
  })

  it('mid runs one build-and-review round, with no fix pass after its review: a round that does not survive goes to a decision', async () => {
    const text = flat(ticketAgent)
    expect(text).toContain('low none, mid one round, high three, max up to ten.')
    expect(text).toContain(
      'When a round does not survive and no round is left: post what is still open, `ask_decision` (ship as is, keep going, drop) and stop: `BLOCKER: decision`.',
    )
    // No other sentence gives mid a second round.
    for (const phrase of [
      'mid two',
      'mid, two',
      'mid gets',
      'two rounds',
      'a second round',
      'another round',
    ]) {
      expect(text, phrase).not.toContain(phrase)
    }
    const { instructions } = await served()
    expect(flat(instructions)).toContain('a mid ticket stops after its review')
  })

  it('high runs up to three build-and-review rounds: a surviving round ends the cycle, and there is no fourth round', () => {
    const text = flat(ticketAgent)
    expect(text).toContain('low none, mid one round, high three, max up to ten.')
    expect(text).toContain(
      'Round 1 is the first build with its gate and its review; rounds 2 and 3 are fix passes, each followed by the gate and a review.',
    )
    expect(text).toContain('A surviving round ends the cycle: go on to step 6.')
    expect(text).toContain('Never start one more round on your own.')
    expect(text).toContain('a `deep` review earns no extra round')
    expect(text).not.toContain('fourth')
    expect(text).not.toContain('round 4')
  })

  it('max runs up to ten rounds: round 1 the first build, rounds 2 to 10 fix passes, a decision after the tenth and never an eleventh', () => {
    const text = flat(ticketAgent)
    expect(ticketAgent).toMatch(/^description: .*max up to ten/m)
    expect(text).toContain('low none, mid one round, high three, max up to ten.')
    expect(text).toContain(
      "a max ticket's rounds 2 to 10 are fix passes the same way, each followed by the gate and a review, and the ten are a ceiling, not a quota",
    )
    expect(text).toContain('A surviving round ends the cycle at every level.')
    // Running out: the tenth round is the last, the decision the only human check-in, and no eleventh round.
    const budget = flat(between(ticketAgent, '**The budget**', '**The effort**'))
    expect(budget).toContain('after round 10, and there is never an eleventh round')
    expect(budget).toContain('`ask_decision` (ship as is, keep going, drop) and stop: `BLOCKER: decision`')
    expect(budget).not.toContain('before round')
    expect(budget).not.toContain('check in with the human')
    // Max is for work built from scratch, and a feature is never max.
    expect(budget).toContain('built from scratch')
    expect(budget).toContain('a feature in an existing codebase is never max, however difficult')
    expect(budget).toContain('The complexity sets the budget at every review depth')
  })

  it('Review depth keeps the size rule for max, and nothing claims max forces a deeper review', () => {
    const depth = flat(between(ticketAgent, '## Review depth', '## Escalation'))
    expect(depth).toContain('This section is for mid, high and max')
    expect(depth).toContain('The depth only moves up')
    expect(depth).toContain("The round budget is the complexity's (step 5) at every depth.")
    for (const claim of ['forces deep', 'always deep', 'deep on every round', 'max runs at deep']) {
      expect(depth, claim).not.toContain(claim)
      expect(flat(reviewQueue), claim).not.toContain(claim)
    }
    // The queue hands max its ten rounds too, at the depth the size rule picks.
    expect(flat(reviewQueue)).toContain('a max ticket up to ten')
  })

  it('todo-review-ticket runs a low ticket with no spec agent and no review, and the builder verifies it itself', () => {
    const text = flat(ticketAgent)
    expect(text).toContain('A low ticket has no spec and no spec agent')
    expect(text).toContain('Low: no review.')
    expect(text).toContain('Low: the builder codes and verifies itself.')
    expect(text).toContain('Its return gives the evidence per criterion')
  })

  it("low survives on the gate and the builder's evidence, a criterion without evidence is a gate return, and steps 6 and 7 follow as for any ticket", () => {
    const text = flat(ticketAgent)
    expect(text).toContain(
      "The change survives when the gate passed (step 4) and the builder's evidence covers every criterion",
    )
    expect(text).toContain(
      'A criterion without that evidence goes back to the builder (step 3) as a gate return (step 4).',
    )
    expect(text).toContain('Then go on to step 6.')
    // The low path reaches step 6 only through a gate that passed with that evidence for every criterion.
    const low = flat(between(ticketAgent, '**Low: no review.**', '**Mid, high and max.**'))
    expect(low).toContain(
      'After the second return, a criterion that still has no evidence is the decision in step 4, never a hand-off.',
    )
    expect(low).toContain(
      'Only a gate that passed with that evidence for every criterion may go on. Then go on to step 6.',
    )
    expect(flat(between(ticketAgent, '### 4. Your own gate', '### 5. Review'))).toContain(
      'when the checks still fail, or, for a low ticket, when a criterion still has no evidence (step 5)',
    )
    // Step 6 (evidence) and step 7 (hand-off) come next, in order; step 6 names the low case.
    expect(text).toContain('A low ticket has no review folder, so its screenshots come from the preview.')
    expect(text.indexOf('### 6. Evidence')).toBeGreaterThan(text.indexOf('Then go on to step 6.'))
    expect(text.indexOf('### 7. Hand off')).toBeGreaterThan(text.indexOf('### 6. Evidence'))
    expect(text).toContain("Every item, in order, as the board skill's hand-off checklist says")
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
    expect(text).toContain('"How it was tested" names the level (`low`, `mid`, `high` or `max`)')
    expect(text).toContain('Only when a review ran (mid, high or max)')
  })

  it('the default builder note names the review rounds each level gets; the spec note names the low exception', async () => {
    const { DEFAULT_AGENTS } = await import('./defaultAgents')
    const byName = Object.fromEntries(DEFAULT_AGENTS.map((a) => [a.name, flat(a.delegation)]))
    expect(byName.builder).toContain(
      "The review rounds its ticket's complexity allows are none for low, one for mid, three for high, up to ten for max, round 1 being the first build and its review.",
    )
    expect(byName.builder).toContain('Mid has one: a review that does not survive then goes to the human')
    expect(byName.builder).toContain('High has three: two fix passes follow the first build')
    expect(byName.builder).toContain('Low has no review: its checks return the build at most twice')
    expect(byName.builder).toContain(
      'after the second return, when the checks still fail or a criterion still has no evidence, the human decides (keep going or drop).',
    )
    expect(byName.builder).toContain(
      'after every review (**runner**) whose verdict is not SHIP, while the ticket has a round left.',
    )
    expect(byName.spec).toContain('Not on a low ticket')
  })

  it("the builder and runner delegation notes send a low ticket's build to hand-off with no runner, and no note says three fix rounds", async () => {
    const { DEFAULT_AGENTS } = await import('./defaultAgents')
    const byName = Object.fromEntries(DEFAULT_AGENTS.map((a) => [a.name, flat(a.delegation)]))
    expect(byName.builder).toContain(
      "except for a low ticket: its build goes to hand-off on the project's checks and the builder's evidence, with no runner",
    )
    expect(byName.runner).toContain(
      "except a low ticket's build, which goes to hand-off on the project's checks and the builder's evidence, with no runner",
    )
    // A review that does not survive the last round goes to a human decision, not to another builder.
    expect(byName.runner).toContain(
      'with the findings while the ticket has a round left, and with none left the human decides (ship as is, keep going, or drop).',
    )
    for (const [name, text] of Object.entries(byName)) expect(text, name).not.toContain('three fix rounds')
  })

  it('board.md, the MCP instructions and AGENTS.md give the rounds as the complexity sets them, never "at most three rounds"', async () => {
    const { instructions } = await served()
    for (const [name, text] of Object.entries({
      'board.md': boardSkill,
      'MCP instructions': instructions,
      'AGENTS.md': agentsDoc,
    })) {
      expect(flat(text), name).toContain('none for low, one for mid, three for high, up to ten for max')
      expect(flat(text), name).not.toContain('at most three rounds')
    }
  })

  it('board.md, the MCP instructions and AGENTS.md say the counts are review rounds, and a mid ticket stops after its review', async () => {
    const { instructions } = await served()
    for (const [name, text] of Object.entries({
      'board.md': boardSkill,
      'MCP instructions': instructions,
      'AGENTS.md': agentsDoc,
    })) {
      expect(flat(text), name).toContain(
        "review rounds as the ticket's complexity allows: none for low, one for mid, three for high, up to ten for max",
      )
      expect(flat(text), name).toContain('a mid ticket stops after its review')
    }
  })

  it('the MCP get_ticket and list_tickets descriptions say that complexity is returned, low, mid or high', async () => {
    const { tools } = await served()
    for (const name of ['get_ticket', 'list_tickets']) {
      expect(tools.find((t) => t.name === name)?.description, name).toContain(
        'complexity (low, mid, high or max',
      )
    }
  })

  it('README and board.md name complexity where the ticket fields are listed', () => {
    const row = readme
      .split('\n')
      .find((l) => l.includes('`/api/projects/:id/tickets`') && l.includes('`/api/tickets/:id`'))
    expect(row, 'the README row for tickets').toBeDefined()
    expect(row).toContain('`complexity` on create and PATCH')
    expect(row).toContain('`max`')
    expect(between(boardSkill, 'Creating a top-level ticket', '\n\n')).toContain('`complexity`')
  })

  it('every text that lists the levels lists all four, and no shipped text still gives only three', async () => {
    const { instructions, tools } = await served()
    const texts: Record<string, string> = {
      'board.md': boardSkill,
      'MCP instructions': instructions,
      'MCP tool descriptions': tools.map((t) => t.description).join('\n'),
      'AGENTS.md': agentsDoc,
      'README.md': readme,
      'todo-review': todoReview,
      'todo-review-ticket': ticketAgent,
      'review-queue': reviewQueue,
      'feature-review': featureReview,
      'defaultAgents.ts': read(path.join(import.meta.dirname, 'defaultAgents.ts')),
    }
    for (const [name, text] of Object.entries(texts)) {
      const flatText = flat(text)
      expect(flatText, name).not.toContain('low, mid or high')
      expect(flatText, name).not.toMatch(/none for low, one for mid, three for high(?!, up to ten for max)/)
    }
    // Each place that gives the budget says what max is and how many rounds it may take.
    expect(flat(boardSkill)).toContain('none for low, one for mid, three for high, up to ten for max')
    expect(flat(instructions)).toContain('none for low, one for mid, three for high, up to ten for max')
    expect(flat(agentsDoc)).toContain('none for low, one for mid, three for high, up to ten for max')
    expect(flat(todoReview)).toContain('max up to ten for work built from scratch')
    expect(flat(reviewQueue)).toContain('a max ticket up to ten')
    expect(flat(readme)).toContain('up to ten for work built from scratch')
    // Max is for work built from scratch, and a feature in an existing codebase is at most high.
    for (const [name, text] of Object.entries({
      'board.md': boardSkill,
      'MCP instructions': instructions,
      'AGENTS.md': agentsDoc,
      'todo-review-ticket': ticketAgent,
    }))
      expect(flat(text), name).toMatch(/at most high|never max/)
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
  it("sets the agents' effort from the complexity: low for low, medium for mid and high", async () => {
    const { COMPLEXITY_EFFORT } = await import('#/lib/constants')
    expect(COMPLEXITY_EFFORT).toEqual({ low: 'low', mid: 'medium', high: 'medium', max: 'high' })
    const rule =
      "low for a low ticket, medium for mid and high, high for max; the orchestrator passes it as the Agent tool's"
    const { instructions } = await served()
    for (const [name, text] of Object.entries({
      'board.md': boardSkill,
      'MCP instructions': instructions,
      'AGENTS.md': agentsDoc,
    }))
      expect(flat(text).replace(/`/g, ''), name).toContain(rule)
    expect(flat(readme)).toContain(
      "the agents' effort, `low` for low, `medium` for mid and high and `high` for max",
    )
    expect(flat(todoReview)).toContain(
      "Pass `effort` on the Agent call as the ticket's complexity sets it: `low` for low, `medium` for mid and high, `high` for max",
    )
    expect(flat(ticketAgent)).toContain(
      '**The effort** is set by the complexity too: `low` for low, `medium` for mid and high, `high` for max.',
    )
    expect(ticketAgent).toContain('browser=<BROWSER> effort=<the effort>`')
    expect(featureReview).toContain(
      "high>` | the thinking effort of every phase agent, passed as the Agent tool's `effort`",
    )
    expect(featureReview).toContain("pass it as `effort` on every phase agent's Agent call")
    expect(flat(reviewQueue)).toContain(
      "pass `effort` on the Agent call and `effort=` to the runner as the ticket's complexity sets it (`low` for low, `medium` for mid and high, `high` for max)",
    )
    expect(flat(reviewQueue)).toContain('runs at the effort the complexity sets')
    const { DEFAULT_AGENTS } = await import('./defaultAgents')
    const builder = DEFAULT_AGENTS.find((a) => a.name === 'builder')!
    expect(flat(builder.delegation)).toContain(
      'runs at the effort its complexity sets: low for low, medium for mid and high, high for max',
    )
  })

  it('splits heavy runs from light ones: only a build, e2e or the full unit suite takes a test slot', () => {
    const text = flat(ticketAgent)
    expect(text).toContain(
      "**Heavy**: a build (your gate's end-to-end build, a preview build), the end-to-end tests, scoped or full, and the full unit suite.",
    )
    expect(text).toContain(
      '**Not heavy**: the typecheck, lint, the formatter (`prettier`), the migration check (`check:migrations`), the unit tests scoped to the changed files, and a targeted probe test.',
    )
    expect(text).toContain('The light ones take no slot, and nothing waits on one for them.')
    expect(text).not.toContain("Heavy runs are the project's checks")
    const review = flat(todoReview)
    expect(review).toContain('a heavy run holds one slot, a light one none')
    expect(review).toContain(
      'the typecheck, lint, formatter, migration check, scoped unit tests and probe tests take none',
    )
  })

  it('uses N = 2 slots, and caps parallel one above the slot count with that same number', () => {
    expect(flat(ticketAgent)).toContain('has N = 2 of them, and a light run holds none')
    const review = flat(todoReview)
    expect(review).toContain('`QUEUE/locks/tests-<repo id>-1` … `-N` (N = 2, the measured count)')
    expect(review).toContain(
      'maximum tickets in flight, 1 to N+1 (so 1 to 3 with N = 2; the cap is one more than the repo',
    )
    expect(review).toContain('With N = 2 that is 3 in flight.')
    // The measured number is named once; no other slot count or cap appears in the served bundle.
    for (const text of [flat(ticketAgent), review]) {
      expect(text).not.toContain('tests-<repo id>-3')
      expect(text).not.toContain('tests-<REPO_ID>-3')
    }
  })

  it('takes a slot with a plain mkdir and a holder line, releases it with rm -r, and never deletes another holder', () => {
    const text = flat(ticketAgent)
    expect(text).toContain(
      '`mkdir SLOTS/tests-<REPO_ID>-<n>` for n from 1 to N (a plain `mkdir`, never `mkdir -p`: the create must fail when the folder exists)',
    )
    expect(text).toContain('`SLOTS/tests-<REPO_ID>-<n>/holder.txt` with `#<TICKET> <step> <ISO time>`')
    expect(text).toContain('**Release it** with `rm -r` on that folder as soon as the heavy command ends')
    expect(text).toContain('Never keep a slot from one check through the next')
    expect(text).toContain('Never delete a folder whose `holder.txt` names another ticket.')
    expect(text).toContain('only its holder removes it, and the orchestrator once that holder')
    expect(flat(todoReview)).toContain(
      "You are the only one besides the holder who clears a dead run's slot, and only when its `holder.txt` names that ticket.",
    )
  })

  it('runs a full suite alone: it takes tests-<repo id>-full first, and a scoped run that sees it gives its slot back', () => {
    const text = flat(ticketAgent)
    expect(text).toContain(
      'take `mkdir SLOTS/tests-<REPO_ID>-full` first (a plain `mkdir`; when it fails, a full run is in flight: wait and try again), then wait until every `tests-<REPO_ID>-<n>` slot is free',
    )
    expect(text).toContain(
      'then checks for `tests-<REPO_ID>-full`: when that folder appeared, release its slot and wait for the full run to end before taking a slot again.',
    )
    expect(flat(todoReview)).toContain('`QUEUE/locks/tests-<repo id>-full` for a full suite')
  })

  it('writes one build record for the head and reuses it in the review only at that same SHA', () => {
    const text = flat(ticketAgent)
    expect(text).toContain('write `WORKDIR/02-build.md` with the head SHA')
    expect(text).toContain('the artifact path (`<worktree>/.output-e2e`) and the ISO time')
    expect(text).toContain('build=<WORKDIR/02-build.md>')
    const review = flat(read(path.join(skills, 'skills', 'feature-review', 'SKILL.md')))
    expect(review).toContain('| `build=<path>` |')
    expect(review).toContain('| `slots=<dir>` |')
    expect(review).toContain('records `E2E_SKIP_BUILD=1`')
    expect(review).toContain(
      'A different SHA is stale: the record is ignored and the env agent builds once at this commit.',
    )
    expect(review).toContain('Nothing is reused across heads.')
    const env = flat(read(path.join(skills, 'agents', 'feature-review-env.md')))
    expect(env).toContain('record `E2E_SKIP_BUILD=1` in `00-env.md`')
    expect(env).toContain('a different SHA is stale, so ignore the record, build once here and record that')
    const verify = flat(read(path.join(skills, 'agents', 'feature-review-verify.md')))
    expect(verify).toContain('records a reused build (`E2E_SKIP_BUILD=1`), run the end-to-end command')
  })

  it('warms node_modules by hardlink copy, never a symlink or junction, and installs offline only on a lockfile difference', () => {
    const env = flat(read(path.join(skills, 'agents', 'feature-review-env.md')))
    expect(env).toContain('`cp -al MAIN/node_modules WORKTREE/node_modules`')
    expect(env).toContain('never a symlink or a junction')
    expect(env).toContain("breaks the board's preview install, which cannot purge through one")
    expect(env).toContain('only when a lockfile differs from the prepared copy')
    expect(env).toContain('Copy its `node_modules` with `cp -al` into a real directory')
    const text = flat(ticketAgent)
    expect(text).toContain('`cp -al <prepared>/node_modules <path>/node_modules`')
    expect(text).toContain('never a symlink or a junction')
    // Nothing served still offers the symlink it replaced.
    const reviewFiles = fs
      .readdirSync(skills, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.md'))
    for (const file of reviewFiles) {
      expect(read(path.join(skills, file)), file).not.toContain('junction or symlink')
    }
  })

  it('reruns only what a fix pass touches, and leaves the full suites to CI', () => {
    const text = flat(ticketAgent)
    expect(text).toContain(
      'A fix pass reruns only what its findings touch: the failed end-to-end spec file(s) and the unit files related to the changed files (`vitest related <changed files>`, or the project',
    )
    expect(text).toContain('never the whole gate')
    expect(text).toContain('the full unit and end-to-end suites stay in CI')
    expect(text).toContain(
      'A fix pass reruns the failed end-to-end spec file(s), the unit files related to the changed files (`vitest related <changed files>`, or the project',
    )
  })

  it('hands the context pack, 00-context.md, to every phase', () => {
    for (const file of [
      'feature-review-spec.md',
      'feature-review-env.md',
      'feature-review-verify.md',
      'feature-review-hunt.md',
      'feature-review-refute.md',
      'feature-review-merge.md',
    ]) {
      expect(flat(read(path.join(skills, 'agents', file))), file).toContain('00-context.md')
    }
    const review = flat(read(path.join(skills, 'skills', 'feature-review', 'SKILL.md')))
    expect(review).toContain(
      '`00-context.md` as the context pack (every phase reads it: spec, env, verify, hunt, refute and merge)',
    )
    expect(review).toContain(
      'the spec phase extends it with the changed files, their tests, their direct callers, the decisions and their answers, and the runbook',
    )
    const spec = flat(read(path.join(skills, 'agents', 'feature-review-spec.md')))
    expect(spec).toContain(
      'the changed files and their tests and callers, the decisions and their answers, and the runbook',
    )
    expect(spec).toContain('write into `00-context.md` what you established')
  })

  it('gives the next free slot to the ticket closest to hand-off, and never waits on a slot nothing needs', () => {
    const text = flat(ticketAgent)
    expect(text).toContain('The next free slot goes to the ticket closest to hand-off')
    expect(text).toContain('a ticket still in its first build')
    expect(text).toContain('never wait on one you do not need')
    const review = flat(todoReview)
    expect(review).toContain('the ticket closest to hand-off')
    expect(review).toContain('never waits on one it does not need')
    expect(review).toContain('Fill every free ticket slot with the pending ticket closest to hand-off')
  })

  it('takes a slot only around a heavy run in each phase: verify and merge yes, hunt and refute never', () => {
    const phase = (file: string) => flat(read(path.join(skills, 'agents', file)))
    expect(phase('feature-review-verify.md')).toContain(
      'Only the heavy runs take a test slot, from the exact `Test slots:` folders in `00-env.md` (or the `SLOTS` folder and repo id the prompt gives)',
    )
    expect(phase('feature-review-merge.md')).toContain('Take a test slot only for a heavy run')
    for (const file of ['feature-review-hunt.md', 'feature-review-refute.md']) {
      expect(phase(file), file).toContain(
        'Targeted unit tests and probe tests are light and take no test slot',
      )
    }
    const review = flat(read(path.join(skills, 'skills', 'feature-review', 'SKILL.md')))
    expect(review).toContain(
      'Only the heavy runs take a test slot, from the exact `Test slots:` folders in `00-env.md`',
    )
    expect(review).toContain('Its heavy part')
    expect(review).toContain('and neither do the hunt')
  })

  it('builds on the merged tree for the merge check, and never labels an old artifact with a new head', () => {
    const merge = flat(read(path.join(skills, 'agents', 'feature-review-merge.md')))
    expect(merge).toContain(
      "Do not reuse the caller's build here, even when `00-env.md` records `E2E_SKIP_BUILD=1`",
    )
    expect(merge).toContain('Build the merged tree once in a test slot')
    expect(merge).toContain('`BOARD_BUILD_DIR=.output-e2e pnpm build`')
    expect(merge).toContain('running the recorded end-to-end command with `E2E_SKIP_BUILD=1` removed')
    expect(merge).toContain(
      'Never run it with the flag on the merged tree, and never build the merged tree twice',
    )
    expect(merge).toContain('releases its slot and waits for the full suite, as the gate does')
    expect(merge).toContain(
      'The recorded build is reused only when the base was already an ancestor (step 2)',
    )
    const review = flat(read(path.join(skills, 'skills', 'feature-review', 'SKILL.md')))
    expect(review).toContain(
      "Because it merged the base, it never reuses the caller's build record, `E2E_SKIP_BUILD=1` or not",
    )
    expect(review).toContain('It builds the merged tree once')
    expect(review).toContain('Never with the flag on the merged tree, and never two builds')
    expect(review).toContain('releases its slot and waits for the full suite, as the gate does')
    const text = flat(ticketAgent)
    expect(text).toContain(
      'a fix pass that built nothing deletes the record, and the next review builds once at the new head',
    )
    expect(text).toContain(
      'rewrites `WORKDIR/02-build.md` at the new head only when it ran the end-to-end run',
    )
  })

  it('takes a test slot for a targeted end-to-end run in the hunt and refute phases too', () => {
    const phase = (file: string) => flat(read(path.join(skills, 'agents', file)))
    for (const file of ['feature-review-hunt.md', 'feature-review-refute.md']) {
      const text = phase(file)
      expect(text, file).toContain('Targeted unit tests and probe tests are light and take no test slot')
      expect(text, file).toContain(
        'A targeted end-to-end spec is heavy like any end-to-end run and takes a test slot',
      )
      expect(text, file).toContain('releases its slot and waits for the full suite, as the gate does')
    }
    expect(phase('feature-review-hunt.md')).toContain('write `holder.txt` with `#<TICKET> hunt <ISO time>`')
    expect(phase('feature-review-refute.md')).toContain(
      'write `holder.txt` with `#<TICKET> refute <ISO time>`',
    )
    const ticket = flat(ticketAgent)
    expect(ticket).toContain(
      'its hunt and refute phases only for a targeted end-to-end run; their unit and probe tests take none',
    )
    expect(ticket).toContain("the hunt's and refute's targeted unit and probe tests take none")
  })

  it('passes the slot folder to every phase, and verify and merge also read it from 00-env.md', () => {
    const review = flat(read(path.join(skills, 'skills', 'feature-review', 'SKILL.md')))
    expect(review).toContain(
      'the `SLOTS` directory when `slots=` was given (its record is the `Test slots:` line in `00-env.md`)',
    )
    expect(review).toContain(
      'the ticket id (`TICKET`) when the review is on a ticket — every phase that takes a test slot writes it in its `holder.txt`',
    )
    for (const file of ['feature-review-verify.md', 'feature-review-merge.md']) {
      expect(flat(read(path.join(skills, 'agents', file))), file).toContain(
        'exact `Test slots:` folders in `00-env.md` (or the `SLOTS` folder and repo id',
      )
    }
    expect(review).toContain('| `repoId=<id>` |')
    expect(flat(ticketAgent)).toContain('repoId=<REPO_ID>')
    expect(flat(read(path.join(skills, 'agents', 'feature-review-env.md')))).toContain(
      '`REPO_ID` (only when the caller gave `repoId=`)',
    )
    expect(flat(read(path.join(skills, 'agents', 'feature-review-env.md')))).toContain(
      'the exact folders with the repo id filled in',
    )
  })

  it("serves the gate artifact through the board's preview run only where its base matches, and otherwise builds the preview's own", () => {
    const text = flat(ticketAgent)
    expect(text).toContain('The preview, from at most one build of this head for the preview')
    expect(text).toContain("Prefer the board's own preview run")
    expect(text).toContain("Its build is the preview's one build for this head")
    expect(text).toContain('it lives on after your session')
    expect(text).toContain('When the artifact was built for the base the preview is served under')
    expect(text).toContain(
      "A checkout served under the board's preview base (the board's own case) builds its own",
    )
    expect(text).toContain('`test -d .output-e2e`')
    expect(text).toContain('put back the run')
    expect(text).toContain('a commit is built twice overall where the preview must build')
    expect(text).toContain('`BOARD_ENV=development`, `AUTH=off`, `STORAGE=local`')
    expect(text).toContain('`HOST=127.0.0.1`')
    expect(text).toContain('`DATA_DIR` a copy of the data (never the live one)')
    expect(text).toContain('That preview lives in your session, so it stops when the session ends')
    expect(text).toContain('Keep the preview running while the ticket is in review')
    expect(text).toContain('clear the link (`set_preview` with `""`)')
    expect(text).toContain('In the summary say which of the three ran (the artifact through the board')
    expect(text).toContain('how many times this head was built')
  })
})
