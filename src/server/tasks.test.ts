import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp

let features: typeof import('./features')
let projectId: number
beforeAll(async () => {
  features = await import('./features')
  const { db, schema } = await import('#/db')
  projectId = db.insert(schema.projects).values({ name: 'p' }).returning().get().id
  db.insert(schema.repos).values({ projectId, name: 'api', repoPath: '/r/api', baseBranch: 'main' }).run()
})

const ticket = (title = 't', tasks: import('./features').NewTask[] = []) =>
  features.createTicket(projectId, { title, tasks }, 'claude')
/** The ticket's tasks as get_ticket lists them: text, done and parent, in order. */
const tasks = (ticketId: number) => features.getTicketFull(ticketId).tasks
const byText = (ticketId: number, text: string) => tasks(ticketId).find((t) => t.text === text)!
const done = (ticketId: number) => Object.fromEntries(tasks(ticketId).map((t) => [t.text, t.done]))
const count = (ticketId: number) => tasks(ticketId).length

describe('subtasks', () => {
  it('plain texts stay top-level tasks', () => {
    const t = ticket()
    const rows = features.addTasks(t.id, ['a', 'b'], 'claude')
    expect(rows.map((r) => [r.text, r.parentId])).toEqual([
      ['a', null],
      ['b', null],
    ])
  })

  it('go under a top-level task with parentTaskId, listed right after it', () => {
    const t = ticket()
    const [a] = features.addTasks(t.id, ['a', 'b'], 'claude')
    const subs = features.addTasks(t.id, ['a1', 'a2'], 'claude', { parentTaskId: a!.id })
    expect(subs.map((r) => r.parentId)).toEqual([a!.id, a!.id])
    // Added after b, listed under a: tree order, not insertion order.
    expect(tasks(t.id).map((x) => [x.text, x.parentId])).toEqual([
      ['a', null],
      ['a1', a!.id],
      ['a2', a!.id],
      ['b', null],
    ])
  })

  it('come with their task as {text, subtasks}, mixed with plain texts, and on a new ticket', () => {
    const t = ticket()
    const rows = features.addTasks(
      t.id,
      ['a', { text: 'b', subtasks: ['b1', 'b2'] }, { text: 'c' }],
      'claude',
    )
    expect(rows.map((r) => r.text)).toEqual(['a', 'b', 'b1', 'b2', 'c'])
    const b = byText(t.id, 'b')
    expect(tasks(t.id).map((x) => [x.text, x.parentId])).toEqual([
      ['a', null],
      ['b', null],
      ['b1', b.id],
      ['b2', b.id],
      ['c', null],
    ])

    const n = ticket('new', [{ text: 'x', subtasks: ['y'] }, 'z'])
    const x = byText(n.id, 'x')
    expect(tasks(n.id).map((r) => [r.text, r.parentId])).toEqual([
      ['x', null],
      ['y', x.id],
      ['z', null],
    ])
  })

  it('go two levels deep and no more: a third level is refused and writes nothing', () => {
    const t = ticket('deep', [{ text: 'a', subtasks: ['a1'] }])
    const a1 = byText(t.id, 'a1')
    const a = byText(t.id, 'a')
    expect(() => features.addTasks(t.id, ['x'], 'claude', { parentTaskId: a1.id })).toThrow(
      expect.objectContaining({
        status: 400,
        message: expect.stringMatching(/subtask cannot have subtasks/),
      }),
    )
    expect(() =>
      features.addTasks(t.id, ['ok', { text: 'x', subtasks: ['y'] }], 'claude', { parentTaskId: a.id }),
    ).toThrow(expect.objectContaining({ status: 400, message: expect.stringMatching(/subtask cannot/) }))
    expect(count(t.id)).toBe(2)
  })

  it('refuse a parent on another ticket, or one that does not exist, and write nothing', () => {
    const t = ticket('mine', ['a'])
    const other = ticket('other', ['theirs'])
    const theirs = byText(other.id, 'theirs')
    expect(() => features.addTasks(t.id, ['x'], 'claude', { parentTaskId: theirs.id })).toThrow(
      expect.objectContaining({
        status: 400,
        message: `task ${theirs.id} is not a task of ticket ${t.id}`,
      }),
    )
    expect(() => features.addTasks(t.id, ['x'], 'claude', { parentTaskId: 999_999 })).toThrow(
      expect.objectContaining({ status: 404, message: 'task not found' }),
    )
    expect(count(t.id)).toBe(1)
    expect(count(other.id)).toBe(1)
  })

  it('go with their task when it is removed; removing a subtask leaves its task', () => {
    const t = ticket('rm', [{ text: 'a', subtasks: ['a1', 'a2'] }, 'b'])
    const row = () => features.listTickets(projectId).find((x) => x.id === t.id)!
    expect(row().progress.total).toBe(4)
    features.deleteTask(byText(t.id, 'a2').id, 'claude')
    expect(tasks(t.id).map((x) => x.text)).toEqual(['a', 'a1', 'b'])
    features.deleteTask(byText(t.id, 'a').id, 'claude')
    expect(tasks(t.id).map((x) => x.text)).toEqual(['b'])
    expect(row().progress.total).toBe(1)
  })

  it('reword without moving', () => {
    const t = ticket('words', [{ text: 'a', subtasks: ['a1'] }])
    const a1 = byText(t.id, 'a1')
    const row = features.updateTask(a1.id, { text: 'a1, properly' }, 'claude')
    expect(row).toMatchObject({ text: 'a1, properly', parentId: a1.parentId })
    expect(byText(t.id, 'a1, properly').parentId).toBe(byText(t.id, 'a').id)
  })
})

describe('ticks keep a task and its subtasks in step', () => {
  it('ticking or unticking a task does the same to its subtasks', () => {
    const t = ticket('parent', [{ text: 'a', subtasks: ['a1', 'a2'] }, 'b'])
    features.updateTask(byText(t.id, 'a').id, { done: true }, 'claude')
    expect(done(t.id)).toEqual({ a: true, a1: true, a2: true, b: false })
    features.updateTask(byText(t.id, 'a').id, { done: false }, 'claude')
    expect(done(t.id)).toEqual({ a: false, a1: false, a2: false, b: false })
  })

  it('ticking the last open subtask ticks the task; unticking one unticks it', () => {
    const t = ticket('subs', [{ text: 'a', subtasks: ['a1', 'a2'] }])
    features.updateTask(byText(t.id, 'a1').id, { done: true }, 'claude')
    expect(done(t.id)).toEqual({ a: false, a1: true, a2: false })
    features.updateTask(byText(t.id, 'a2').id, { done: true }, 'claude')
    expect(done(t.id)).toEqual({ a: true, a1: true, a2: true })
    features.updateTask(byText(t.id, 'a1').id, { done: false }, 'claude')
    expect(done(t.id)).toEqual({ a: false, a1: false, a2: true })
  })

  it('an open subtask added to a done task reopens it; removing subtasks settles it', () => {
    const t = ticket('settle', [{ text: 'a', subtasks: ['a1'] }])
    const a = byText(t.id, 'a')
    features.updateTask(a.id, { done: true }, 'claude')
    expect(done(t.id)).toEqual({ a: true, a1: true })
    features.addTasks(t.id, ['a2'], 'claude', { parentTaskId: a.id })
    expect(done(t.id)).toEqual({ a: false, a1: true, a2: false })
    // The only open one goes, and the rest are done: so is the task.
    features.deleteTask(byText(t.id, 'a2').id, 'claude')
    expect(done(t.id)).toEqual({ a: true, a1: true })
    // The last subtask goes: the task keeps its tick, a plain task again.
    features.deleteTask(byText(t.id, 'a1').id, 'claude')
    expect(done(t.id)).toEqual({ a: true })
    const b = ticket('settle open', [{ text: 'b', subtasks: ['b1'] }])
    features.deleteTask(byText(b.id, 'b1').id, 'claude')
    expect(done(b.id)).toEqual({ b: false })
  })
})

describe('a task write and the sync it causes are one transaction', () => {
  it('a sync that fails after the write leaves nothing written', async () => {
    const { db } = await import('#/db')
    const { sql } = await import('drizzle-orm')
    const t = ticket('atomic', [{ text: 'a', subtasks: ['a1', 'a2'] }])
    const a = byText(t.id, 'a')
    const snapshot = () => tasks(t.id).map((x) => [x.text, x.done, x.parentId])
    const before = snapshot()
    // Each write below changes a subtask first, then settles its task: that second statement fails.
    db.run(
      sql.raw(`create trigger fail_settle before update on tasks
        when new.parent_id is null and new.ticket_id = ${t.id}
        begin select raise(abort, 'settle failed'); end`),
    )
    try {
      expect(() => features.addTasks(t.id, ['a3'], 'claude', { parentTaskId: a.id })).toThrow(/settle failed/)
      expect(() => features.updateTask(byText(t.id, 'a1').id, { done: true }, 'claude')).toThrow(
        /settle failed/,
      )
      expect(() => features.deleteTask(byText(t.id, 'a2').id, 'claude')).toThrow(/settle failed/)
    } finally {
      db.run(sql`drop trigger fail_settle`)
    }
    expect(snapshot()).toEqual(before)
  })
})

describe('counts', () => {
  it('take in every task and subtask: progress, rollup over lanes, get_ticket and the summary', async () => {
    const { db, schema } = await import('#/db')
    const { getSummary } = await import('./summary')
    const pid = db.insert(schema.projects).values({ name: 'counts' }).returning().get().id
    db.insert(schema.repos).values({ projectId: pid, name: 'api', repoPath: '/r/counts' }).run()
    const t = features.createTicket(
      pid,
      { title: 'count me', status: 'in_progress', tasks: [{ text: 'a', subtasks: ['a1', 'a2'] }, 'b'] },
      'claude',
    )
    features.updateTask(byText(t.id, 'a1').id, { done: true }, 'claude')
    const row = () => features.listTickets(pid).find((x) => x.id === t.id)!
    expect(row().progress).toEqual({ done: 1, total: 4 })
    expect(row().rollup).toEqual({ done: 1, total: 4 })
    expect(features.getTicketFull(t.id)).toMatchObject({
      progress: { done: 1, total: 4 },
      rollup: { done: 1, total: 4 },
    })

    // A lane's subtasks add to its parent's rollup, unless the lane is cancelled.
    const lane = features.createTicket(
      pid,
      { title: 'lane', parentId: t.id, tasks: [{ text: 'l', subtasks: ['l1'] }] },
      'claude',
    )
    expect(row().rollup).toEqual({ done: 1, total: 6 })
    const inProgress = () => getSummary(pid, { humans: [] }).projects[0]!.inProgress
    expect(inProgress().find((x) => x.id === t.id)!.rollup).toEqual({ done: 1, total: 6 })
    features.updateTicket(lane.id, { status: 'cancelled' }, 'claude')
    expect(row().rollup).toEqual({ done: 1, total: 4 })
    expect(row().progress).toEqual({ done: 1, total: 4 })
  })
})

describe('over REST and MCP', () => {
  async function call(method: string, pathname: string, body?: unknown) {
    const { api } = await import('./api')
    const { api: guard } = await import('./http')
    const handle = guard(({ request, actor }: { request: Request; actor: string }) =>
      api.handle(request, actor),
    )
    const request = new Request(`http://localhost${pathname}`, {
      method,
      headers: {
        accept: 'application/json, text/event-stream',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return handle({ request, actor: 'claude' })
  }
  const tool = async (name: string, args: Record<string, unknown>) => {
    const res = await call('POST', '/api/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    })
    const { result } = (await res.json()) as {
      result: { isError?: boolean; content: { text: string }[] }
    }
    return { error: !!result.isError, text: result.content[0]!.text }
  }
  type Row = { id: number; text: string; parentId: number | null; done: boolean }
  const listed = async (ticketId: number) =>
    ((await (await call('GET', `/api/tickets/${ticketId}`)).json()) as { tasks: Row[] }).tasks

  it('POST /api/tickets/:id/tasks takes plain texts, {text, subtasks} and parentTaskId', async () => {
    const t = ticket('rest')
    const plain = await call('POST', `/api/tickets/${t.id}/tasks`, { tasks: ['a'] })
    expect(plain.status).toBe(201)
    const [a] = (await plain.json()) as Row[]
    expect(a).toMatchObject({ text: 'a', parentId: null })

    const subs = await call('POST', `/api/tickets/${t.id}/tasks`, { tasks: ['a1'], parentTaskId: a!.id })
    expect(subs.status).toBe(201)
    expect(((await subs.json()) as Row[]).map((r) => r.parentId)).toEqual([a!.id])

    const nested = await call('POST', `/api/tickets/${t.id}/tasks`, {
      tasks: [{ text: 'b', subtasks: ['b1'] }],
    })
    expect(nested.status).toBe(201)
    const listing = await listed(t.id)
    const b = listing.find((r) => r.text === 'b')!
    expect(listing.map((r) => [r.text, r.parentId])).toEqual([
      ['a', null],
      ['a1', a!.id],
      ['b', null],
      ['b1', b.id],
    ])

    // A third level, a parent on another ticket, a missing parent: refused, nothing written.
    const a1 = listing.find((r) => r.text === 'a1')!
    const deep = await call('POST', `/api/tickets/${t.id}/tasks`, { tasks: ['x'], parentTaskId: a1.id })
    expect(deep.status).toBe(400)
    expect(await deep.text()).toMatch(/subtask cannot have subtasks/)
    const withSubs = await call('POST', `/api/tickets/${t.id}/tasks`, {
      tasks: [{ text: 'x', subtasks: ['y'] }],
      parentTaskId: a!.id,
    })
    expect(withSubs.status).toBe(400)
    const other = ticket('rest other', ['theirs'])
    const theirs = byText(other.id, 'theirs')
    const foreign = await call('POST', `/api/tickets/${t.id}/tasks`, {
      tasks: ['x'],
      parentTaskId: theirs.id,
    })
    expect(foreign.status).toBe(400)
    expect(await foreign.text()).toMatch(`task ${theirs.id} is not a task of ticket ${t.id}`)
    const missing = await call('POST', `/api/tickets/${t.id}/tasks`, { tasks: ['x'], parentTaskId: 999_999 })
    expect(missing.status).toBe(404)
    expect(await missing.text()).toMatch(/task not found/)
    // Texts are checked as before, subtasks too.
    const long = await call('POST', `/api/tickets/${t.id}/tasks`, {
      tasks: [{ text: 'c', subtasks: ['x'.repeat(501)] }],
    })
    expect(long.status).toBe(400)
    expect(await listed(t.id)).toHaveLength(4)

    // A new ticket takes the same items.
    const created = await call('POST', `/api/projects/${projectId}/tickets`, {
      title: 'rest new',
      tasks: [{ text: 'x', subtasks: ['y'] }],
    })
    expect(created.status).toBe(201)
    const { id: newId } = (await created.json()) as { id: number }
    const fresh = await listed(newId)
    expect(fresh.map((r) => [r.text, r.parentId])).toEqual([
      ['x', null],
      ['y', fresh[0]!.id],
    ])
  })

  it('add_tasks and create_ticket take the same over MCP, and refuse a third level as a tool error', async () => {
    const created = await tool('create_ticket', {
      projectId,
      title: 'mcp',
      tasks: ['a', { text: 'b', subtasks: ['b1'] }],
    })
    expect(created.error).toBe(false)
    const t = JSON.parse(created.text) as { id: number }
    const b = byText(t.id, 'b')
    const added = await tool('add_tasks', { ticketId: t.id, tasks: ['b2'], parentTaskId: b.id })
    expect(added.error).toBe(false)
    expect((JSON.parse(added.text) as Row[]).map((r) => r.parentId)).toEqual([b.id])
    const plain = await tool('add_tasks', { ticketId: t.id, tasks: ['c'] })
    expect((JSON.parse(plain.text) as Row[]).map((r) => r.parentId)).toEqual([null])

    const deep = await tool('add_tasks', {
      ticketId: t.id,
      tasks: ['x'],
      parentTaskId: byText(t.id, 'b1').id,
    })
    expect(deep).toMatchObject({ error: true, text: expect.stringMatching(/subtask cannot have subtasks/) })

    const ticketed = JSON.parse((await tool('get_ticket', { ticketId: t.id })).text) as { tasks: Row[] }
    expect(ticketed.tasks.map((r) => [r.text, r.parentId])).toEqual([
      ['a', null],
      ['b', null],
      ['b1', b.id],
      ['b2', b.id],
      ['c', null],
    ])

    expect((await tool('set_task_done', { taskId: b.id })).error).toBe(false)
    expect(done(t.id)).toEqual({ a: false, b: true, b1: true, b2: true, c: false })
    expect((await tool('remove_task', { taskId: b.id })).error).toBe(false)
    expect(tasks(t.id).map((r) => r.text)).toEqual(['a', 'c'])
  })
})
