import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-default-phases-'))
process.env.DATA_DIR = tmp

const BUILT_IN = ['Implementation', 'Pushed', 'PR', 'CI', 'Preview', 'Merged', 'Hand-off post']

let dbm: typeof import('#/db')
let features: typeof import('./features')
let handle: (request: Request) => Promise<Response>
beforeAll(async () => {
  dbm = await import('#/db')
  features = await import('./features')
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  // As the server answers: an HttpError becomes its status with `{error}`. A bearer token is an agent.
  const guarded = guard(({ request }: { request: Request }) =>
    api.handle(request, request.headers.has('authorization') ? 'claude' : 'enrique'),
  )
  handle = (request) => guarded({ request })
})

/** A project as one that existed before the column: nothing stored, so the built-in list. */
function newProject(name: string) {
  const id = dbm.db.insert(dbm.schema.projects).values({ name }).returning().get().id
  dbm.db
    .insert(dbm.schema.repos)
    .values({ projectId: id, name: 'api', repoPath: `/r/${name}` })
    .run()
  return id
}

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
async function rpc(method: string, params: Record<string, unknown> = {}) {
  const { handleMcp } = await import('./mcp')
  const res = await handleMcp(
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    }),
    'claude',
  )
  return ((await res.json()) as { result: any }).result
}
async function tool(name: string, args: Record<string, unknown>) {
  const result = (await rpc('tools/call', { name, arguments: args })) as {
    isError?: boolean
    content: { text: string }[]
  }
  expect(result.isError, result.content[0]!.text).toBeFalsy()
  return JSON.parse(result.content[0]!.text)
}

type Row = { id: number; text: string; parentId: number | null; done: boolean }
type Ticket = { id: number; tasks: Row[]; progress: { done: number; total: number } }

const phases = async (projectId: number, as: 'human' | 'agent' = 'human') =>
  (await call('GET', `/api/projects/${projectId}`, undefined, as)).body.defaultPhases as string[]
/** A ticket created over REST, read back as GET /api/tickets/:id has it. */
async function created(projectId: number, body: Record<string, unknown>, as: 'human' | 'agent' = 'human') {
  const res = await call('POST', `/api/projects/${projectId}/tickets`, body, as)
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return (await call('GET', `/api/tickets/${res.body.id}`)).body as Ticket
}
/** The task tree as text: each top-level task, with its subtasks after an arrow. */
const tree = (tasks: Row[]) =>
  tasks
    .filter((t) => t.parentId === null)
    .map((t) => {
      const subs = tasks.filter((s) => s.parentId === t.id).map((s) => s.text)
      return subs.length ? `${t.text} → ${subs.join(', ')}` : t.text
    })

describe("a project's default phases", () => {
  it('are the built-in list while the project keeps none, over REST and MCP, and on every project read', async () => {
    const p = newProject('built-in')
    expect(
      dbm.db
        .select()
        .from(dbm.schema.projects)
        .all()
        .find((x) => x.id === p)!.defaultPhases,
    ).toBeNull()
    expect(await phases(p)).toEqual(BUILT_IN)
    expect((await tool('get_project', { projectId: p })).defaultPhases).toEqual(BUILT_IN)
    // A project made through the API too, and in the projects list.
    const made = await call('POST', '/api/projects', { name: 'made' })
    expect(made.status).toBe(201)
    expect(made.body.defaultPhases).toEqual(BUILT_IN)
    expect(await phases(made.body.id)).toEqual(BUILT_IN)
    const listed = (await call('GET', '/api/projects')).body as { id: number; defaultPhases: string[] }[]
    expect(listed.find((x) => x.id === p)!.defaultPhases).toEqual(BUILT_IN)
  })

  it('are set by the human: trimmed, [] for none, null for the built-in list again', async () => {
    const p = newProject('set')
    const set = await call('PATCH', `/api/projects/${p}`, { defaultPhases: ['  Design ', 'Build'] })
    expect(set.status).toBe(200)
    expect(set.body.defaultPhases).toEqual(['Design', 'Build'])
    expect(await phases(p)).toEqual(['Design', 'Build'])
    expect((await tool('get_project', { projectId: p })).defaultPhases).toEqual(['Design', 'Build'])

    expect((await call('PATCH', `/api/projects/${p}`, { defaultPhases: [] })).body.defaultPhases).toEqual([])
    expect(await phases(p)).toEqual([])

    expect((await call('PATCH', `/api/projects/${p}`, { defaultPhases: null })).body.defaultPhases).toEqual(
      BUILT_IN,
    )
    expect(await phases(p)).toEqual(BUILT_IN)
    // Stored as null, so a change to the built-in list reaches it.
    expect(
      dbm.db
        .select()
        .from(dbm.schema.projects)
        .all()
        .find((x) => x.id === p)!.defaultPhases,
    ).toBeNull()
  })

  it("are the human's only (403 for an agent), and refuse an empty or long name or too many (400)", async () => {
    const p = newProject('guarded')
    await call('PATCH', `/api/projects/${p}`, { defaultPhases: ['Keep'] })
    for (const defaultPhases of [['Mine'], [], null]) {
      const res = await call('PATCH', `/api/projects/${p}`, { defaultPhases }, 'agent')
      expect(res.status).toBe(403)
      expect(res.body.error).toMatch(/only the human/)
    }
    // Not even along with a field the agent may change: nothing of it is written.
    const both = await call('PATCH', `/api/projects/${p}`, { name: 'renamed', defaultPhases: [] }, 'agent')
    expect(both.status).toBe(403)
    expect((await call('GET', `/api/projects/${p}`)).body).toMatchObject({
      name: 'guarded',
      defaultPhases: ['Keep'],
    })

    const tooMany = Array.from({ length: 21 }, (_, i) => `phase ${i}`)
    for (const defaultPhases of [[''], ['   '], ['ok', 'x'.repeat(501)], tooMany, 'Build', [3]]) {
      const res = await call('PATCH', `/api/projects/${p}`, { defaultPhases })
      expect(res.status, JSON.stringify(defaultPhases)).toBe(400)
    }
    expect(await phases(p)).toEqual(['Keep'])
    // The limits themselves are fine.
    const twenty = tooMany.slice(0, 20)
    twenty[0] = 'x'.repeat(500)
    expect((await call('PATCH', `/api/projects/${p}`, { defaultPhases: twenty })).status).toBe(200)
    expect(await phases(p)).toEqual(twenty)

    // The name and the instructions are patched as before, by either.
    expect((await call('PATCH', `/api/projects/${p}`, { name: 'by agent' }, 'agent')).status).toBe(200)
    expect((await call('PATCH', `/api/projects/${p}`, { instructions: 'run it' }, 'agent')).status).toBe(200)
    expect((await call('PATCH', `/api/projects/${p}`, { name: 'by human' })).status).toBe(200)
    expect((await call('GET', `/api/projects/${p}`)).body).toMatchObject({
      name: 'by human',
      instructions: 'run it',
      defaultPhases: twenty,
    })
  })
})

describe('a new ticket', () => {
  it('starts with the phases as open top-level tasks, in order, over REST', async () => {
    const p = newProject('rest')
    for (const as of ['human', 'agent'] as const) {
      const t = await created(p, { title: `plain ${as}` }, as)
      expect(t.tasks.map((x) => [x.text, x.parentId, x.done])).toEqual(BUILT_IN.map((x) => [x, null, false]))
      expect(t.progress).toEqual({ done: 0, total: 7 })
    }
    // In any starting stage.
    const done = await created(p, { title: 'straight to done', status: 'done' })
    expect(tree(done.tasks)).toEqual(BUILT_IN)
  })

  it('starts with them over MCP create_ticket too', async () => {
    const p = newProject('mcp')
    const t = await tool('create_ticket', { projectId: p, title: 'mcp' })
    const full = await tool('get_ticket', { ticketId: t.id })
    expect(full.tasks.map((x: Row) => [x.text, x.parentId, x.done])).toEqual(
      BUILT_IN.map((x) => [x, null, false]),
    )
    expect(full.progress).toEqual({ done: 0, total: 7 })
  })

  it('puts the given plain tasks under the first phase, and given phases right after it', async () => {
    const p = newProject('given')
    const steps = await created(p, { title: 'steps', tasks: ['a', 'b'] })
    expect(tree(steps.tasks)).toEqual([
      'Implementation → a, b',
      'Pushed',
      'PR',
      'CI',
      'Preview',
      'Merged',
      'Hand-off post',
    ])
    expect(steps.progress).toEqual({ done: 0, total: 9 })
    const implementation = steps.tasks[0]!
    expect(steps.tasks.filter((x) => x.text === 'a' || x.text === 'b').map((x) => x.parentId)).toEqual([
      implementation.id,
      implementation.id,
    ])

    const t = await tool('create_ticket', {
      projectId: p,
      title: 'mixed',
      tasks: ['a', { text: 'Docs', subtasks: ['d1'] }],
    })
    const full = await tool('get_ticket', { ticketId: t.id })
    expect(full.tasks.map((x: Row) => x.text)).toEqual([
      'Implementation',
      'a',
      'Docs',
      'd1',
      'Pushed',
      'PR',
      'CI',
      'Preview',
      'Merged',
      'Hand-off post',
    ])
    expect(tree(full.tasks)).toEqual([
      'Implementation → a',
      'Docs → d1',
      'Pushed',
      'PR',
      'CI',
      'Preview',
      'Merged',
      'Hand-off post',
    ])
  })

  it('takes its tasks exactly as given with defaultPhases false, over REST and MCP', async () => {
    const p = newProject('opted out')
    const given = ['a', { text: 'b', subtasks: ['b1'] }]
    const rest = await created(p, { title: 'rest', tasks: given, defaultPhases: false })
    expect(tree(rest.tasks)).toEqual(['a', 'b → b1'])
    const bare = await created(p, { title: 'bare', defaultPhases: false })
    expect(bare.tasks).toEqual([])
    const t = await tool('create_ticket', { projectId: p, title: 'mcp', tasks: given, defaultPhases: false })
    expect(tree((await tool('get_ticket', { ticketId: t.id })).tasks)).toEqual(['a', 'b → b1'])
  })

  it('in a project with no default phases gets only the given tasks', async () => {
    const p = newProject('none')
    await call('PATCH', `/api/projects/${p}`, { defaultPhases: [] })
    expect((await created(p, { title: 'empty' })).tasks).toEqual([])
    expect(
      tree((await created(p, { title: 'given', tasks: ['a', { text: 'b', subtasks: ['b1'] }] })).tasks),
    ).toEqual(['a', 'b → b1'])
    const t = await tool('create_ticket', { projectId: p, title: 'mcp', tasks: ['x'] })
    expect(tree((await tool('get_ticket', { ticketId: t.id })).tasks)).toEqual(['x'])
  })

  it("starts with the project's own list, the plain tasks under its first phase", async () => {
    const p = newProject('custom')
    await call('PATCH', `/api/projects/${p}`, { defaultPhases: ['Design', 'Build'] })
    expect(tree((await created(p, { title: 'custom', tasks: ['s1', 's2'] })).tasks)).toEqual([
      'Design → s1, s2',
      'Build',
    ])
    expect(tree((await created(p, { title: 'bare' })).tasks)).toEqual(['Design', 'Build'])
  })

  it('as a lane starts without them unless defaultPhases is true; the rollup counts what it has', async () => {
    const p = newProject('lanes')
    const parent = await created(p, { title: 'parent' })
    const rollup = async () => (await call('GET', `/api/tickets/${parent.id}`)).body.rollup
    expect(await rollup()).toEqual({ done: 0, total: 7 })

    const lane = await created(p, { title: 'lane', parentId: parent.id, tasks: ['l1', 'l2'] })
    expect(tree(lane.tasks)).toEqual(['l1', 'l2'])
    const bare = await created(p, { title: 'bare lane', parentId: parent.id })
    expect(bare.tasks).toEqual([])
    const mcpLane = await tool('create_ticket', {
      projectId: p,
      title: 'mcp lane',
      parentId: parent.id,
      tasks: ['m'],
    })
    expect(tree((await tool('get_ticket', { ticketId: mcpLane.id })).tasks)).toEqual(['m'])
    expect(await rollup()).toEqual({ done: 0, total: 10 })

    const seeded = await created(p, {
      title: 'seeded lane',
      parentId: parent.id,
      tasks: ['s'],
      defaultPhases: true,
    })
    expect(tree(seeded.tasks)).toEqual([
      'Implementation → s',
      'Pushed',
      'PR',
      'CI',
      'Preview',
      'Merged',
      'Hand-off post',
    ])
    expect(await rollup()).toEqual({ done: 0, total: 18 })
  })

  it('keeps its phases working like any task: ticks in step, reword, remove, steps added under one', async () => {
    const p = newProject('behave')
    const t = await created(p, { title: 'behave', tasks: ['a', 'b'] })
    const byText = async (text: string) =>
      ((await call('GET', `/api/tickets/${t.id}`)).body as Ticket).tasks.find((x) => x.text === text)!
    const done = async () =>
      Object.fromEntries(
        ((await call('GET', `/api/tickets/${t.id}`)).body as Ticket).tasks.map((x) => [x.text, x.done]),
      )
    const implementation = await byText('Implementation')

    // Ticking the phase ticks its steps; unticking unticks them.
    await tool('set_task_done', { taskId: implementation.id })
    expect(await done()).toMatchObject({ Implementation: true, a: true, b: true, Pushed: false })
    await tool('set_task_done', { taskId: implementation.id, done: false })
    expect(await done()).toMatchObject({ Implementation: false, a: false, b: false })
    // Its last open step ticked ticks it.
    await tool('set_task_done', { taskId: (await byText('a')).id })
    expect((await byText('Implementation')).done).toBe(false)
    await tool('set_task_done', { taskId: (await byText('b')).id })
    expect((await byText('Implementation')).done).toBe(true)

    // Steps go under a phase with parentTaskId, and reopen it.
    const added = await tool('add_tasks', { ticketId: t.id, tasks: ['c'], parentTaskId: implementation.id })
    expect(added.map((x: Row) => x.parentId)).toEqual([implementation.id])
    expect((await byText('Implementation')).done).toBe(false)

    // Reworded, removed (its steps with it), and one added at the end.
    await tool('update_task', { taskId: (await byText('CI')).id, text: 'CI green' })
    await tool('remove_task', { taskId: (await byText('Preview')).id })
    await tool('remove_task', { taskId: implementation.id })
    await tool('add_tasks', { ticketId: t.id, tasks: ['Benchmarks'] })
    const after = (await call('GET', `/api/tickets/${t.id}`)).body as Ticket
    expect(tree(after.tasks)).toEqual(['Pushed', 'PR', 'CI green', 'Merged', 'Hand-off post', 'Benchmarks'])
    expect(after.progress).toEqual({ done: 0, total: 6 })
  })

  it('is the only one seeded: tickets made before keep their tasks through every read', async () => {
    const p = newProject('older')
    // As a ticket written before the phases existed: straight into the table, as it was.
    const older = features.createTicket(p, { title: 'older', tasks: ['x'] }, 'claude')
    const empty = features.createTicket(p, { title: 'older, empty' }, 'claude')
    await call('GET', `/api/projects/${p}`)
    await call('GET', `/api/projects/${p}/tickets`)
    await tool('get_ticket', { ticketId: older.id })
    expect(tree((await call('GET', `/api/tickets/${older.id}`)).body.tasks)).toEqual(['x'])
    expect((await call('GET', `/api/tickets/${empty.id}`)).body.tasks).toEqual([])
    await created(p, { title: 'new one' })
    expect(tree((await call('GET', `/api/tickets/${older.id}`)).body.tasks)).toEqual(['x'])
    expect((await call('GET', `/api/tickets/${empty.id}`)).body.tasks).toEqual([])
  })
})

describe('the phases the board ticks', () => {
  it('are the top-level Pushed, PR, CI, Preview and Merged, by name in any case: auto on every read', async () => {
    const p = newProject('auto')
    const t = await created(p, { title: 'auto', tasks: ['CI', 'a'] })
    // A top-level task reworded into a name is one; a subtask of that name is not.
    await tool('add_tasks', { ticketId: t.id, tasks: ['  merged '] })
    const read = (await call('GET', `/api/tickets/${t.id}`)).body as { tasks: (Row & { auto: boolean })[] }
    expect(read.tasks.map((x) => [x.text, x.parentId === null, x.auto])).toEqual([
      ['Implementation', true, false],
      ['CI', false, false],
      ['a', false, false],
      ['Pushed', true, true],
      ['PR', true, true],
      ['CI', true, true],
      ['Preview', true, true],
      ['Merged', true, true],
      ['Hand-off post', true, false],
      ['  merged ', true, true],
    ])
    const mcp = await tool('get_ticket', { ticketId: t.id })
    expect(mcp.tasks.filter((x: { auto: boolean }) => x.auto).map((x: Row) => x.text)).toEqual([
      'Pushed',
      'PR',
      'CI',
      'Preview',
      'Merged',
      '  merged ',
    ])
  })

  it('cannot be ticked or unticked by hand, over REST as the human or an agent, or over MCP', async () => {
    const p = newProject('refused')
    const t = await created(p, { title: 'refused' })
    const task = (text: string) => t.tasks.find((x) => x.text === text)!
    const stored = (id: number) =>
      dbm.db
        .select()
        .from(dbm.schema.tasks)
        .all()
        .find((x) => x.id === id)!.done
    for (const phase of ['Pushed', 'PR', 'CI', 'Preview', 'Merged']) {
      const id = task(phase).id
      for (const as of ['human', 'agent'] as const)
        for (const done of [true, false]) {
          const res = await call('PATCH', `/api/tasks/${id}`, { done }, as)
          expect(res.status).toBe(400)
          expect(res.body.error).toContain(`"${phase}" is ticked by the board`)
          expect(res.body.error).toContain('it cannot be ticked by hand')
        }
      for (const [name, args] of [
        ['set_task_done', { taskId: id }],
        ['set_task_done', { taskId: id, done: false }],
        ['update_task', { taskId: id, done: true }],
      ] as const) {
        const result = (await rpc('tools/call', { name, arguments: args })) as {
          isError?: boolean
          content: { text: string }[]
        }
        expect(result.isError).toBe(true)
        expect(result.content[0]!.text).toContain(`"${phase}" is ticked by the board`)
      }
      expect(stored(id)).toBe(false)
    }
    // The rule is in the message.
    expect((await call('PATCH', `/api/tasks/${task('CI').id}`, { done: true })).body.error).toBe(
      `"CI" is ticked by the board from GitHub (the PR's checks green, or a "CI run locally: green" comment on the head SHA); it cannot be ticked by hand`,
    )
    // Rewording into a phase's name with a tick is refused too.
    const res = await call('PATCH', `/api/tasks/${task('Hand-off post').id}`, { text: 'Preview', done: true })
    expect(res.status).toBe(400)

    // An open one can be tagged blocked and cleared; a done one cannot be tagged (that would untick it).
    const ci = task('CI').id
    expect((await call('PATCH', `/api/tasks/${ci}`, { blocked: true, blockedReason: 'token' })).status).toBe(
      200,
    )
    expect((await call('PATCH', `/api/tasks/${ci}`, { blocked: false })).status).toBe(200)
    dbm.db.update(dbm.schema.tasks).set({ done: true }).where(eq(dbm.schema.tasks.id, ci)).run()
    const tagged = await call('PATCH', `/api/tasks/${ci}`, { blocked: true }, 'agent')
    expect(tagged.status).toBe(400)
    expect(tagged.body.error).toContain('or reopened by tagging it blocked')
    expect(stored(ci)).toBe(true)

    // Reworded, it is a manual task again, ticked by hand; removing one works.
    expect((await call('PATCH', `/api/tasks/${task('PR').id}`, { text: 'PR opened' })).status).toBe(200)
    expect((await call('PATCH', `/api/tasks/${task('PR').id}`, { done: true })).status).toBe(200)
    expect(stored(task('PR').id)).toBe(true)
    expect((await call('DELETE', `/api/tasks/${task('Preview').id}`)).status).toBeLessThan(300)
    // Hand-off post and Implementation stay ticked by hand.
    for (const text of ['Implementation', 'Hand-off post'])
      expect((await call('PATCH', `/api/tasks/${task(text).id}`, { done: true }, 'agent')).status).toBe(200)
  })

  it("never follow their subtasks' ticks", async () => {
    const p = newProject('subtasks')
    const t = await created(p, { title: 'subtasks' })
    const preview = t.tasks.find((x) => x.text === 'Preview')!
    const [sub] = await tool('add_tasks', { ticketId: t.id, tasks: ['try it'], parentTaskId: preview.id })
    await tool('set_task_done', { taskId: sub.id })
    const read = (await call('GET', `/api/tickets/${t.id}`)).body as Ticket
    expect(read.tasks.find((x) => x.id === sub.id)!.done).toBe(true)
    expect(read.tasks.find((x) => x.id === preview.id)!.done).toBe(false)
  })
})

describe('what agents are told', () => {
  it('the MCP instructions and tools name the default phases, the opt-out, and no other top level', async () => {
    const init = await rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })
    const instructions = init.instructions as string
    expect(instructions).toContain(
      "A new ticket starts with its project's default phases as its top-level tasks (get_project's defaultPhases; built in: Implementation, then the hand-off's Pushed, PR, CI, Preview, Merged, Hand-off post)",
    )
    expect(instructions).toContain('the concrete steps of the work go under Implementation as its subtasks')
    // The board ticks the phases that follow git, GitHub and the previews; agents tick the rest.
    expect(instructions).toContain(
      'The board ticks the phases Pushed, PR, CI, Preview and Merged itself, from git, GitHub and the previews, and unticks one when its fact stops holding',
    )
    expect(instructions).toContain('"CI run locally: green on <sha>"')
    expect(instructions).toContain(
      'Nobody ticks those by hand: set_task_done and update_task done on them are refused',
    )
    expect(instructions).toContain('Hand-off post is yours')
    expect(instructions).toContain('the hand-off phases included but Merged')
    expect(instructions).not.toContain('tick each hand-off phase')
    expect(instructions).not.toContain('the board ticks nothing itself')
    expect(instructions).toContain('defaultPhases: false opts a ticket out')
    expect(instructions).toContain('then tick Hand-off post')
    // A decision is answered by the human on its card, or relayed by the orchestrator from the chat.
    expect(instructions).toContain('answer_decision')
    expect(instructions).toContain('never a delegated subagent')
    expect(instructions).toContain('a persona never answers a decision')

    const tools = (await rpc('tools/list')).tools as { name: string; description: string; inputSchema: any }[]
    const byName = (name: string) => tools.find((t) => t.name === name)!
    expect(byName('answer_decision').description).toContain('AskUserQuestion')
    expect(byName('ask_decision').description).toContain('the orchestrator records it with answer_decision')
    expect(byName('get_ticket').description).toContain('relayedBy and relayedText')
    expect(byName('get_project').description).toContain(
      'defaultPhases (the top-level phases every new ticket',
    )
    const create = byName('create_ticket')
    expect(create.description).toContain('starts without phases unless defaultPhases is true')
    expect(create.inputSchema.properties.defaultPhases.type).toBe('boolean')
    expect(create.inputSchema.properties.tasks.description).toContain('plain texts go under the first phase')
    expect(byName('add_tasks').description).toContain('such as Implementation')
    expect(byName('get_project').description).toContain('Pushed, PR, CI, Preview, Merged, Hand-off post')
    expect(byName('create_ticket').description).toContain('Pushed, PR, CI, Preview, Merged, Hand-off post')
    expect(byName('get_ticket').description).toContain('auto: true on a phase the board ticks itself')
    for (const name of ['set_task_done', 'update_task'])
      expect(byName(name).description).toMatch(/Pushed, PR, CI, Preview(,| and) Merged/)
    // Plan, code and tests are steps now, never offered as the top level.
    const all = [instructions, ...tools.map((t) => JSON.stringify(t))].join('\n')
    expect(all).not.toMatch(/plan, code, tests/)
  })
})
