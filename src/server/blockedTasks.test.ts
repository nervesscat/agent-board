import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp

let features: typeof import('./features')
let dbm: typeof import('#/db')
let projectId: number
beforeAll(async () => {
  features = await import('./features')
  dbm = await import('#/db')
  const { db, schema } = dbm
  projectId = db.insert(schema.projects).values({ name: 'p' }).returning().get().id
  db.insert(schema.repos).values({ projectId, name: 'api', repoPath: '/r/api', baseBranch: 'main' }).run()
})

const ticket = (title: string, tasks: import('./features').NewTask[] = [], pid = projectId) =>
  features.createTicket(pid, { title, tasks, status: 'in_progress' }, 'claude')
const tasks = (ticketId: number) => features.getTicketFull(ticketId).tasks
const byText = (ticketId: number, text: string) => tasks(ticketId).find((t) => t.text === text)!
/** Each task's tick and tag, by its text. */
const state = (ticketId: number) =>
  Object.fromEntries(
    tasks(ticketId).map((t) => [t.text, { done: t.done, blocked: t.blocked, reason: t.blockedReason }]),
  )
const row = (ticketId: number, pid = projectId) => features.listTickets(pid).find((x) => x.id === ticketId)!

type Task = {
  id: number
  text: string
  parentId: number | null
  done: boolean
  blocked: boolean
  blockedReason: string
}

async function call(method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}) {
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
      ...headers,
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
  const { result } = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } }
  return { error: !!result.isError, text: result.content[0]!.text }
}
const listed = async (ticketId: number) =>
  (await (await call('GET', `/api/tickets/${ticketId}`)).json()) as { tasks: Task[]; blockedTasks: number }

describe('the blocked tag on a task', () => {
  it('reads as not blocked on every task never tagged, one written before the columns too', async () => {
    const { db } = dbm
    const { sql } = await import('drizzle-orm')
    const t = ticket('untagged', [{ text: 'a', subtasks: ['a1'] }, 'b'])
    // As a row from before the tag existed: written without its columns.
    db.run(sql`insert into tasks (ticket_id, text, done, position) values (${t.id}, 'old', 0, 9)`)
    const read = await listed(t.id)
    expect(read.tasks.map((x) => [x.text, x.blocked, x.blockedReason])).toEqual([
      ['a', false, ''],
      ['a1', false, ''],
      ['b', false, ''],
      ['old', false, ''],
    ])
    expect(read.blockedTasks).toBe(0)
  })

  it('PATCH /api/tasks/:id tags a task or a subtask, with or without a reason, and clears it', async () => {
    const t = ticket('tag', [{ text: 'a', subtasks: ['a1'] }, 'b'])
    const a = byText(t.id, 'a')
    const a1 = byText(t.id, 'a1')
    const b = byText(t.id, 'b')

    const tagged = await call('PATCH', `/api/tasks/${a.id}`, {
      blocked: true,
      blockedReason: 'Log in to Stripe',
    })
    expect(tagged.status).toBe(200)
    expect(await tagged.json()).toMatchObject({ id: a.id, blocked: true, blockedReason: 'Log in to Stripe' })
    const sub = await call('PATCH', `/api/tasks/${a1.id}`, {
      blocked: true,
      blockedReason: 'Approve the DNS change',
    })
    expect(sub.status).toBe(200)
    // Without a reason.
    const bare = await call('PATCH', `/api/tasks/${b.id}`, { blocked: true })
    expect(bare.status).toBe(200)
    expect(await bare.json()).toMatchObject({ blocked: true, blockedReason: '' })
    expect((await listed(t.id)).tasks.map((x) => [x.text, x.blocked, x.blockedReason])).toEqual([
      ['a', true, 'Log in to Stripe'],
      ['a1', true, 'Approve the DNS change'],
      ['b', true, ''],
    ])

    // A reason alone rewrites a tagged task's; blocked: true alone keeps it.
    await call('PATCH', `/api/tasks/${a.id}`, { blockedReason: 'Log in to Stripe, live account' })
    await call('PATCH', `/api/tasks/${a.id}`, { blocked: true })
    expect(state(t.id).a).toEqual({ done: false, blocked: true, reason: 'Log in to Stripe, live account' })

    const cleared = await call('PATCH', `/api/tasks/${a.id}`, { blocked: false })
    expect(cleared.status).toBe(200)
    expect(await cleared.json()).toMatchObject({ blocked: false, blockedReason: '' })
    expect(state(t.id).a).toEqual({ done: false, blocked: false, reason: '' })
  })

  it('refuses a reason too long, a blocked that is not a boolean, or a reason on an untagged task, and writes nothing', async () => {
    const t = ticket('bad', ['a', 'b'])
    const a = byText(t.id, 'a')
    await call('PATCH', `/api/tasks/${a.id}`, { blocked: true, blockedReason: 'before' })
    const before = state(t.id)
    const long = await call('PATCH', `/api/tasks/${a.id}`, { blocked: true, blockedReason: 'x'.repeat(501) })
    expect(long.status).toBe(400)
    const notBool = await call('PATCH', `/api/tasks/${a.id}`, { blocked: 'yes' })
    expect(notBool.status).toBe(400)
    const untagged = await call('PATCH', `/api/tasks/${byText(t.id, 'b').id}`, { blockedReason: 'why' })
    expect(untagged.status).toBe(400)
    expect(await untagged.text()).toMatch(/blockedReason goes with blocked: true/)
    // An empty one there writes nothing, and is no error.
    const empty = await call('PATCH', `/api/tasks/${byText(t.id, 'b').id}`, { blockedReason: '' })
    expect(empty.status).toBe(200)
    expect(await empty.json()).toMatchObject({ text: 'b', blocked: false, blockedReason: '' })
    expect(state(t.id)).toEqual(before)
    // 500 characters is the limit, as for a task's text; MCP goes by the same rule.
    expect((await call('PATCH', `/api/tasks/${a.id}`, { blockedReason: 'x'.repeat(500) })).status).toBe(200)
    expect(() => features.updateTask(a.id, { blockedReason: 'x'.repeat(501) }, 'claude')).toThrow(
      expect.objectContaining({ status: 400 }),
    )

    // Adding tasks: a bad tag on one item refuses them all.
    const add = await call('POST', `/api/tickets/${t.id}/tasks`, {
      tasks: ['c', { text: 'd', blocked: true, blockedReason: 'x'.repeat(501) }],
    })
    expect(add.status).toBe(400)
    expect(tasks(t.id)).toHaveLength(2)
  })

  it('POST /api/tickets/:id/tasks takes tagged items, as phases or under one; plain texts come untagged', async () => {
    const t = ticket('add')
    const res = await call('POST', `/api/tickets/${t.id}/tasks`, {
      tasks: ['plain', { text: 'needs a key', blocked: true, blockedReason: 'Create the API key' }],
    })
    expect(res.status).toBe(201)
    const rows = (await res.json()) as Task[]
    expect(rows.map((r) => [r.text, r.blocked, r.blockedReason])).toEqual([
      ['plain', false, ''],
      ['needs a key', true, 'Create the API key'],
    ])
    const plain = rows[0]!
    const sub = await call('POST', `/api/tickets/${t.id}/tasks`, {
      tasks: [{ text: 'sign off', blocked: true }, 'step'],
      parentTaskId: plain.id,
    })
    expect(sub.status).toBe(201)
    expect(
      ((await sub.json()) as Task[]).map((r) => [r.text, r.parentId, r.blocked, r.blockedReason]),
    ).toEqual([
      ['sign off', plain.id, true, ''],
      ['step', plain.id, false, ''],
    ])
    expect((await listed(t.id)).blockedTasks).toBe(2)
  })

  it('works the same over MCP: update_task and add_tasks set it, get_ticket and list_tickets show it', async () => {
    const t = ticket('mcp', ['a'])
    const a = byText(t.id, 'a')
    const set = await tool('update_task', { taskId: a.id, blocked: true, blockedReason: 'Rotate the token' })
    expect(set.error).toBe(false)
    expect(JSON.parse(set.text)).toMatchObject({ id: a.id, blocked: true, blockedReason: 'Rotate the token' })
    const added = await tool('add_tasks', {
      ticketId: t.id,
      tasks: [{ text: 'b', blocked: true, blockedReason: 'Pick a name' }, 'c'],
    })
    expect(added.error).toBe(false)
    expect((JSON.parse(added.text) as Task[]).map((r) => [r.text, r.blocked, r.blockedReason])).toEqual([
      ['b', true, 'Pick a name'],
      ['c', false, ''],
    ])
    const got = JSON.parse((await tool('get_ticket', { ticketId: t.id })).text) as {
      tasks: Task[]
      blockedTasks: number
    }
    expect(got.tasks.map((r) => [r.text, r.blocked, r.blockedReason])).toEqual([
      ['a', true, 'Rotate the token'],
      ['b', true, 'Pick a name'],
      ['c', false, ''],
    ])
    expect(got.blockedTasks).toBe(2)
    const list = JSON.parse((await tool('list_tickets', { projectId })).text) as {
      id: number
      blockedTasks: number
    }[]
    expect(list.find((x) => x.id === t.id)!.blockedTasks).toBe(2)

    // The same refusals, as tool errors.
    const both = await tool('update_task', { taskId: a.id, done: true, blocked: true })
    expect(both).toMatchObject({ error: true, text: expect.stringMatching(/a done task cannot be blocked/) })
    const long = await tool('update_task', { taskId: a.id, blockedReason: 'x'.repeat(501) })
    expect(long.error).toBe(true)
    expect((await tool('update_task', { taskId: a.id, blocked: false })).error).toBe(false)
    expect(state(t.id).a).toEqual({ done: false, blocked: false, reason: '' })
    // set_task_done ticks and clears it.
    expect((await tool('set_task_done', { taskId: byText(t.id, 'b').id })).error).toBe(false)
    expect(state(t.id).b).toEqual({ done: true, blocked: false, reason: '' })
  })

  it('an agent sets and clears it over REST as the human does', async () => {
    const t = ticket('agent', ['a'])
    const a = byText(t.id, 'a')
    const asAgent = { authorization: 'Bearer gate_test' }
    const me = (await (await call('GET', '/api/me', undefined, asAgent)).json()) as { agent: boolean }
    expect(me.agent).toBe(true)
    const set = await call(
      'PATCH',
      `/api/tasks/${a.id}`,
      { blocked: true, blockedReason: 'Sign in' },
      asAgent,
    )
    expect(set.status).toBe(200)
    const add = await call(
      'POST',
      `/api/tickets/${t.id}/tasks`,
      { tasks: [{ text: 'b', blocked: true }] },
      asAgent,
    )
    expect(add.status).toBe(201)
    expect(row(t.id).blockedTasks).toBe(2)
    expect((await call('PATCH', `/api/tasks/${a.id}`, { blocked: false }, asAgent)).status).toBe(200)
    expect(row(t.id).blockedTasks).toBe(1)
  })
})

describe('ticks and the tag', () => {
  it('ticking clears it: on the task, on the subtasks a tick reaches, and on a parent its last subtask ticks', () => {
    const t = ticket('ticks', [
      { text: 'a', subtasks: ['a1', 'a2'] },
      { text: 'b', subtasks: ['b1', 'b2'] },
      'c',
    ])
    const tag = (text: string, reason = `do ${text}`) =>
      features.updateTask(byText(t.id, text).id, { blocked: true, blockedReason: reason }, 'claude')
    for (const x of ['a', 'a1', 'a2', 'b', 'b1', 'c']) tag(x)

    features.updateTask(byText(t.id, 'c').id, { done: true }, 'claude')
    expect(state(t.id).c).toEqual({ done: true, blocked: false, reason: '' })

    // Ticking a task ticks its subtasks, and clears the tag on each.
    features.updateTask(byText(t.id, 'a').id, { done: true }, 'claude')
    for (const x of ['a', 'a1', 'a2'])
      expect(state(t.id)[x]).toEqual({ done: true, blocked: false, reason: '' })

    // Ticking the last open subtask ticks its parent, which clears the parent's tag.
    features.updateTask(byText(t.id, 'b2').id, { done: true }, 'claude')
    expect(state(t.id).b).toEqual({ done: false, blocked: true, reason: 'do b' })
    features.updateTask(byText(t.id, 'b1').id, { done: true }, 'claude')
    expect(state(t.id).b).toEqual({ done: true, blocked: false, reason: '' })
    expect(state(t.id).b1).toEqual({ done: true, blocked: false, reason: '' })

    // Unticking brings no tag back.
    features.updateTask(byText(t.id, 'a').id, { done: false }, 'claude')
    features.updateTask(byText(t.id, 'c').id, { done: false }, 'claude')
    for (const x of ['a', 'a1', 'a2', 'c'])
      expect(state(t.id)[x]).toEqual({ done: false, blocked: false, reason: '' })
  })

  it('a parent ticked by removing its last open subtask loses its tag too', () => {
    const t = ticket('remove', [{ text: 'a', subtasks: ['a1', 'a2'] }])
    features.updateTask(byText(t.id, 'a1').id, { done: true }, 'claude')
    features.updateTask(byText(t.id, 'a').id, { blocked: true }, 'claude')
    features.deleteTask(byText(t.id, 'a2').id, 'claude')
    expect(state(t.id).a).toEqual({ done: true, blocked: false, reason: '' })
  })

  it('tagging a done task reopens it, and its parent; ticking and tagging at once is refused', async () => {
    const t = ticket('reopen', [{ text: 'a', subtasks: ['a1', 'a2'] }, 'b'])
    const a = byText(t.id, 'a')
    features.updateTask(a.id, { done: true }, 'claude')
    features.updateTask(byText(t.id, 'b').id, { done: true }, 'claude')

    const res = await call('PATCH', `/api/tasks/${byText(t.id, 'b').id}`, {
      blocked: true,
      blockedReason: 'Check',
    })
    expect(res.status).toBe(200)
    expect(state(t.id).b).toEqual({ done: false, blocked: true, reason: 'Check' })

    // A done subtask tagged: open again, and so is its parent.
    features.updateTask(byText(t.id, 'a1').id, { blocked: true }, 'claude')
    expect(state(t.id)).toMatchObject({
      a: { done: false, blocked: false },
      a1: { done: false, blocked: true },
      a2: { done: true, blocked: false },
    })

    const before = state(t.id)
    const both = await call('PATCH', `/api/tasks/${byText(t.id, 'a2').id}`, { done: true, blocked: true })
    expect(both.status).toBe(400)
    expect(await both.text()).toMatch(/a done task cannot be blocked/)
    const onTagged = await call('PATCH', `/api/tasks/${byText(t.id, 'b').id}`, {
      done: true,
      blockedReason: 'x',
    })
    expect(onTagged.status).toBe(400)
    expect(state(t.id)).toEqual(before)
  })
})

describe('what the tag leaves alone', () => {
  it('counts as open: progress, rollup and the hand-off are as for an untagged open task', async () => {
    const { handoffOf } = await import('./handoff')
    const t = ticket('open', [{ text: 'a', subtasks: ['a1', 'a2'] }])
    features.updateTask(byText(t.id, 'a1').id, { done: true }, 'claude')
    const counts = () => {
      const full = features.getTicketFull(t.id)
      return { progress: full.progress, rollup: full.rollup, row: row(t.id).rollup }
    }
    const before = counts()
    expect(before.progress).toEqual({ done: 1, total: 3 })
    // Its only open task is blocked.
    features.updateTask(byText(t.id, 'a2').id, { blocked: true, blockedReason: 'Sign the release' }, 'claude')
    expect(counts()).toEqual(before)
    const handoff = handoffOf({
      branch: 'b',
      tasks: features.getTicketFull(t.id).rollup,
      pr: { number: 1, ci: 'passing', merged: false },
      push: { state: 'pushed', ahead: 0 },
      previews: [{ url: 'http://localhost:47101', running: true }],
      lastCommitAt: null,
      since: '2026-01-01T00:00:00.000Z',
      posts: [{ author: 'claude', progress: true, handoff: false, createdAt: '2026-01-02T00:00:00.000Z' }],
      humans: [],
    })
    expect(handoff.missing.map((m) => m.code)).toContain('tasks_open')
  })

  it('never moves the ticket nor opens or answers a decision', () => {
    const { db, schema } = dbm
    const t = ticket('still', ['a'])
    const a = byText(t.id, 'a')
    const decisions = () =>
      db
        .select()
        .from(schema.updates)
        .all()
        .filter((u) => u.ticketId === t.id && u.decision !== null)
    features.updateTask(a.id, { blocked: true, blockedReason: 'Merge the config PR' }, 'claude')
    expect(features.getTicket(t.id).status).toBe('in_progress')
    features.updateTask(a.id, { blocked: false }, 'claude')
    expect(features.getTicket(t.id).status).toBe('in_progress')
    expect(decisions()).toEqual([])
    expect(row(t.id).decisions).toBe(0)

    features.updateTicket(t.id, { status: 'blocked' }, 'claude')
    features.updateTask(a.id, { blocked: true }, 'claude')
    features.updateTask(a.id, { blocked: false }, 'claude')
    expect(features.getTicket(t.id).status).toBe('blocked')
  })
})

describe('blockedTasks on ticket rows', () => {
  it('counts its own blocked tasks and subtasks and those of its lanes that are not cancelled', async () => {
    const t = ticket('rows', [{ text: 'a', subtasks: ['a1'] }, 'b', 'c'])
    features.updateTask(byText(t.id, 'a1').id, { blocked: true }, 'claude')
    features.updateTask(byText(t.id, 'b').id, { blocked: true }, 'claude')
    const lane = features.createTicket(projectId, { title: 'lane', parentId: t.id, tasks: ['l'] }, 'claude')
    features.updateTask(byText(lane.id, 'l').id, { blocked: true }, 'claude')
    const deep = features.createTicket(
      projectId,
      { title: 'deep', parentId: lane.id, tasks: ['d'] },
      'claude',
    )
    features.updateTask(byText(deep.id, 'd').id, { blocked: true }, 'claude')

    expect(row(t.id).blockedTasks).toBe(4)
    expect(row(lane.id).blockedTasks).toBe(2)
    expect(features.getTicketFull(t.id).blockedTasks).toBe(4)
    const rest = (await (await call('GET', `/api/projects/${projectId}/tickets`)).json()) as {
      id: number
      blockedTasks: number
    }[]
    expect(rest.find((x) => x.id === t.id)!.blockedTasks).toBe(4)

    features.updateTicket(lane.id, { status: 'cancelled' }, 'claude')
    expect(row(t.id).blockedTasks).toBe(2)
    expect(features.getTicketFull(t.id).blockedTasks).toBe(2)
    // Done tasks are never blocked.
    features.updateTask(byText(t.id, 'b').id, { done: true }, 'claude')
    expect(row(t.id).blockedTasks).toBe(1)
  })
})

describe('the activity log', () => {
  it('logs tagging, a new reason and clearing; a tick logs only that it was completed', () => {
    const { db, schema } = dbm
    const t = ticket('log', ['a', 'b'])
    const a = byText(t.id, 'a')
    const logged = () =>
      db
        .select()
        .from(schema.activity)
        .all()
        .filter((e) => e.refId === t.id && e.kind === 'task')
        .map((e) => e.text)
    const start = logged().length
    const since = () => logged().slice(start)
    features.updateTask(a.id, { blocked: true, blockedReason: 'Log in to Stripe' }, 'claude')
    features.updateTask(a.id, { blocked: true }, 'claude')
    features.updateTask(a.id, { blockedReason: 'Log in to Stripe live' }, 'claude')
    features.updateTask(a.id, { blocked: false }, 'claude')
    features.updateTask(a.id, { blocked: true }, 'claude')
    features.updateTask(a.id, { done: true }, 'claude')
    features.addTasks(t.id, [{ text: 'c', blocked: true }, 'd'], 'claude')
    expect(since()).toEqual([
      `flagged "a" as blocked on #${t.id} log: Log in to Stripe`,
      `flagged "a" as blocked on #${t.id} log: Log in to Stripe live`,
      `cleared the blocked flag on "a" on #${t.id} log`,
      `flagged "a" as blocked on #${t.id} log`,
      `completed "a" on #${t.id} log`,
      `added 2 tasks (1 blocked) to #${t.id} log`,
    ])
  })
})
