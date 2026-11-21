import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { and, eq } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-answerwait-')))
process.env.DATA_DIR = path.join(tmp, 'data')

const HUMAN = 'enrique'
const AGENT = 'claude'

let dbm: typeof import('#/db')
let features: typeof import('./features')
let resume: typeof import('./resume')
let wait: typeof import('./answerWait')
let projectId: number

const script = path.join(tmp, 'agent.mjs')
fs.writeFileSync(script, `import fs from 'node:fs'\nfs.writeFileSync(process.argv[2], 'ran')\n`)
const commandFor = (out: string) => `"${process.execPath}" "${script}" "${out}"`

const rowsOf = (ticketId: number) =>
  dbm.db.select().from(dbm.schema.ticketResumes).where(eq(dbm.schema.ticketResumes.ticketId, ticketId)).all()
const repliesOf = (postId: number) =>
  dbm.db
    .select()
    .from(dbm.schema.comments)
    .where(and(eq(dbm.schema.comments.parentType, 'update'), eq(dbm.schema.comments.parentId, postId)))
    .all()
const heartbeatsOf = (ticketId: number) =>
  dbm.db
    .select()
    .from(dbm.schema.ticketEvents)
    .where(and(eq(dbm.schema.ticketEvents.ticketId, ticketId), eq(dbm.schema.ticketEvents.kind, 'heartbeat')))
    .all()

let n = 0
/** A ticket an agent holds, from a registered folder, blocked on a card. */
function asked() {
  const ticket = features.createTicket(
    projectId,
    { title: 'Pick a database', status: 'in_progress', assignee: AGENT },
    AGENT,
  )
  const folder = path.join(tmp, `wt-${++n}`)
  fs.mkdirSync(folder)
  features.addWorkspace(ticket.id, { name: 'wt', path: folder, agent: AGENT }, AGENT)
  const post = features.askDecision(
    ticket.id,
    { body: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] },
    AGENT,
  )
  // The question was asked a while ago: the agent's own signals right after it are not a live agent.
  dbm.db
    .update(dbm.schema.updates)
    .set({ createdAt: new Date(Date.now() - 5 * 60_000).toISOString() })
    .where(eq(dbm.schema.updates.id, post.id))
    .run()
  return { ticket, post }
}

const quick = { timeoutMs: 5_000, heartbeatMs: 1_000 }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  dbm = await import('#/db')
  features = await import('./features')
  resume = await import('./resume')
  wait = await import('./answerWait')
  ;(await import('./actors')).noteActor(HUMAN, 'human')
  const repoDir = path.join(tmp, 'repo')
  fs.mkdirSync(repoDir)
  projectId = dbm.db.insert(dbm.schema.projects).values({ name: 'shop' }).returning().get().id
  dbm.db.insert(dbm.schema.repos).values({ projectId, name: 'shop', repoPath: repoDir }).run()
})

afterEach(() => {
  resume.stopWatching()
  dbm.db
    .update(dbm.schema.projects)
    .set({ resumeCommand: '' })
    .where(eq(dbm.schema.projects.id, projectId))
    .run()
  // Nothing leaks, however the wait ended.
  expect(wait.waiterCount()).toBe(0)
})

describe('wait_for_answer: waiting', () => {
  it('returns the answer at once for a card already answered', async () => {
    const { ticket, post } = asked()
    features.decide(post.id, 1, 'managed please', HUMAN)
    const got = await wait.waitForAnswer({ ticketId: ticket.id, postId: post.id, ...quick })
    expect(got).toMatchObject({
      answered: true,
      postId: post.id,
      option: 1,
      label: 'Postgres',
      text: 'managed please',
      by: HUMAN,
    })
    expect(Date.parse((got as { at: string }).at)).toBeGreaterThan(0)
  })

  it('blocks on an open card and returns the answer when the human answers', async () => {
    const { ticket, post } = asked()
    let settled = false
    const p = wait.waitForAnswer({ ticketId: ticket.id, ...quick }).then((r) => ((settled = true), r))
    await sleep(40)
    expect(settled).toBe(false)
    expect(wait.hasWaiter(ticket.id, post.id)).toBe(true)
    features.decide(post.id, 0, 'the simple one', HUMAN)
    expect(await p).toMatchObject({ answered: true, option: 0, label: 'SQLite', text: 'the simple one' })
    expect(wait.hasWaiter(ticket.id, post.id)).toBe(false)
  })

  it('returns a relayed answer too, with the words as given', async () => {
    const { ticket, post } = asked()
    const p = wait.waitForAnswer({ ticketId: ticket.id, postId: post.id, ...quick })
    features.relayDecision(post.id, { option: 1, words: 'go with postgres' }, 'orch', { agent: true })
    expect(await p).toMatchObject({
      answered: true,
      option: 1,
      text: 'go with postgres',
      by: 'orch',
      relayedBy: 'orch',
    })
  })

  it('times out with timedOut and the postId to ask again with', async () => {
    const { ticket, post } = asked()
    const got = await wait.waitForAnswer({ ticketId: ticket.id, timeoutMs: 40, heartbeatMs: 1_000 })
    expect(got).toEqual({ answered: false, timedOut: true, postId: post.id })
  })

  it('a wait that ended just before the answer finds it on the next call', async () => {
    const { ticket, post } = asked()
    expect(
      await wait.waitForAnswer({ ticketId: ticket.id, timeoutMs: 20, heartbeatMs: 1_000 }),
    ).toMatchObject({
      timedOut: true,
    })
    features.decide(post.id, 0, '', HUMAN)
    expect(await wait.waitForAnswer({ ticketId: ticket.id, postId: post.id, ...quick })).toMatchObject({
      answered: true,
      option: 0,
    })
  })

  it('picks the newest open card, and says plainly when there is none', async () => {
    const { ticket, post } = asked()
    const newer = features.askDecision(
      ticket.id,
      { body: 'And the ORM?', options: [{ label: 'drizzle' }, { label: 'raw' }] },
      AGENT,
    )
    const p = wait.waitForAnswer({ ticketId: ticket.id, ...quick })
    expect(wait.hasWaiter(ticket.id, newer.id)).toBe(true)
    expect(wait.hasWaiter(ticket.id, post.id)).toBe(false)
    features.decide(newer.id, 1, '', HUMAN)
    expect(await p).toMatchObject({ postId: newer.id, label: 'raw' })
    features.decide(post.id, 0, '', HUMAN)
    expect(() => wait.waitForAnswer({ ticketId: ticket.id, ...quick })).toThrow(/no open decision card/)
  })

  it('refuses a card of another ticket, a post that is not a card and an unknown ticket', () => {
    const a = asked()
    const b = asked()
    expect(() => wait.waitForAnswer({ ticketId: a.ticket.id, postId: b.post.id, ...quick })).toThrow(
      /not a decision card/,
    )
    expect(() => wait.waitForAnswer({ ticketId: 999_999, ...quick })).toThrow()
  })

  it('two waiters on one card both get the answer', async () => {
    const { ticket, post } = asked()
    const one = wait.waitForAnswer({ ticketId: ticket.id, postId: post.id, ...quick })
    const two = wait.waitForAnswer({ ticketId: ticket.id, postId: post.id, ...quick })
    expect(wait.waiterCount()).toBe(2)
    features.decide(post.id, 1, 'both', HUMAN)
    expect(await one).toMatchObject({ answered: true, label: 'Postgres', text: 'both' })
    expect(await two).toMatchObject({ answered: true, label: 'Postgres', text: 'both' })
  })
})

describe('wait_for_answer: heartbeats and timers', () => {
  it('beats at the interval while it waits and stops on timeout', async () => {
    const { ticket } = asked()
    let beats = 0
    await wait.waitForAnswer({
      ticketId: ticket.id,
      timeoutMs: 130,
      heartbeatMs: 25,
      onHeartbeat: () => void beats++,
    })
    expect(beats).toBeGreaterThanOrEqual(4)
    const after = beats
    await sleep(80)
    expect(beats).toBe(after)
  })

  it('stops its timers on an answer and on abort', async () => {
    const answered = asked()
    let beats = 0
    const p = wait.waitForAnswer({
      ticketId: answered.ticket.id,
      timeoutMs: 5_000,
      heartbeatMs: 20,
      onHeartbeat: () => void beats++,
    })
    await sleep(70)
    features.decide(answered.post.id, 0, '', HUMAN)
    await p
    const afterAnswer = beats
    expect(afterAnswer).toBeGreaterThanOrEqual(2)

    const aborted = asked()
    const ctl = new AbortController()
    let beats2 = 0
    const q = wait.waitForAnswer({
      ticketId: aborted.ticket.id,
      timeoutMs: 5_000,
      heartbeatMs: 20,
      signal: ctl.signal,
      onHeartbeat: () => void beats2++,
    })
    await sleep(50)
    ctl.abort()
    expect(await q).toEqual({ answered: false, aborted: true, postId: aborted.post.id })
    const afterAbort = beats2
    await sleep(80)
    expect(beats2).toBe(afterAbort)
    expect(beats).toBe(afterAnswer)
    // An already aborted request never registers.
    expect(
      await wait.waitForAnswer({ ticketId: aborted.ticket.id, ...quick, signal: ctl.signal }),
    ).toMatchObject({ aborted: true })
  })

  it('a failing heartbeat does not end the wait', async () => {
    const { ticket } = asked()
    const got = await wait.waitForAnswer({
      ticketId: ticket.id,
      timeoutMs: 80,
      heartbeatMs: 20,
      onHeartbeat: () => {
        throw new Error('lease')
      },
    })
    expect(got).toMatchObject({ timedOut: true })
  })
})

describe('wait_for_answer: one answer is delivered or resumed, never both and never neither', () => {
  it('an answer delivered to a waiting agent starts no resume: the row is skipped and the reply says so', async () => {
    const out = path.join(tmp, 'delivered.txt')
    dbm.db
      .update(dbm.schema.projects)
      .set({ resumeCommand: commandFor(out) })
      .where(eq(dbm.schema.projects.id, projectId))
      .run()
    const { ticket, post } = asked()
    const p = wait.waitForAnswer({ ticketId: ticket.id, postId: post.id, ...quick })
    features.decide(post.id, 0, 'sqlite', HUMAN)
    expect(await p).toMatchObject({ answered: true, text: 'sqlite' })
    const rows = rowsOf(ticket.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      state: 'skipped',
      pid: null,
      reason: 'an agent is waiting for this answer',
    })
    expect(repliesOf(post.id).at(-1)!.body).toContain('Delivered to the agent waiting for it')
    await sleep(150)
    expect(fs.existsSync(out)).toBe(false)
  })

  it('with no waiter and a command set, exactly one resume starts', async () => {
    const out = path.join(tmp, 'resumed.txt')
    dbm.db
      .update(dbm.schema.projects)
      .set({ resumeCommand: commandFor(out) })
      .where(eq(dbm.schema.projects.id, projectId))
      .run()
    const { ticket, post } = asked()
    features.decide(post.id, 0, '', HUMAN)
    const rows = rowsOf(ticket.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.state).not.toBe('skipped')
    const end = Date.now() + 10_000
    while (!fs.existsSync(out) && Date.now() < end) await sleep(20)
    expect(fs.existsSync(out)).toBe(true)
  })

  it('a wait that ended before the answer is resumed, and the next call returns the answer', async () => {
    const out = path.join(tmp, 'late.txt')
    dbm.db
      .update(dbm.schema.projects)
      .set({ resumeCommand: commandFor(out) })
      .where(eq(dbm.schema.projects.id, projectId))
      .run()
    const { ticket, post } = asked()
    await wait.waitForAnswer({ ticketId: ticket.id, postId: post.id, timeoutMs: 20, heartbeatMs: 1_000 })
    features.decide(post.id, 1, '', HUMAN)
    expect(rowsOf(ticket.id)).toHaveLength(1)
    expect(rowsOf(ticket.id)[0]!.state).not.toBe('skipped')
    expect(await wait.waitForAnswer({ ticketId: ticket.id, postId: post.id, ...quick })).toMatchObject({
      answered: true,
      option: 1,
    })
  })

  it('an answer after an aborted wait is resumed: the wait own heartbeat is not a live agent', async () => {
    const out = path.join(tmp, 'aborted.txt')
    dbm.db
      .update(dbm.schema.projects)
      .set({ resumeCommand: commandFor(out) })
      .where(eq(dbm.schema.projects.id, projectId))
      .run()
    const { ticket, post } = asked()
    const ctl = new AbortController()
    const p = wait.waitAndReport({
      ticketId: ticket.id,
      postId: post.id,
      timeoutSeconds: 60,
      signal: ctl.signal,
      actor: AGENT,
    })
    expect(heartbeatsOf(ticket.id)).toHaveLength(1)
    ctl.abort()
    expect(await p).toMatchObject({ aborted: true })
    features.decide(post.id, 0, '', HUMAN)
    const rows = rowsOf(ticket.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.state).not.toBe('skipped')
    const end = Date.now() + 10_000
    while (!fs.existsSync(out) && Date.now() < end) await sleep(20)
    expect(fs.existsSync(out)).toBe(true)
  })

  it('a relayed answer reaches the waiter and starts no resume', async () => {
    const { ticket, post } = asked()
    const p = wait.waitForAnswer({ ticketId: ticket.id, postId: post.id, ...quick })
    features.relayDecision(post.id, { option: 0, words: 'sqlite' }, 'orch', { agent: true })
    expect(await p).toMatchObject({ answered: true })
    expect(rowsOf(ticket.id)).toHaveLength(0)
  })
})

describe('wait_for_answer: the MCP tool', () => {
  async function rpc(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal) {
    const { handleMcp } = await import('./mcp')
    const res = await handleMcp(
      new Request('http://localhost/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal,
      }),
      AGENT,
    )
    return (await res.json()) as { result: any }
  }
  const call = async (args: Record<string, unknown>, signal?: AbortSignal) => {
    const { result } = await rpc('tools/call', { name: 'wait_for_answer', arguments: args }, signal)
    return { isError: !!result.isError, data: result.content[0].text as string }
  }

  it('is a read tool: ticketId, postId, timeoutSeconds and agentName, and nothing that sets a resume command', async () => {
    const { result } = await rpc('tools/list')
    const tool = result.tools.find((t: { name: string }) => t.name === 'wait_for_answer')
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual([
      'agentName',
      'postId',
      'ticketId',
      'timeoutSeconds',
    ])
    expect(tool.inputSchema.properties.timeoutSeconds).toMatchObject({ default: 300, maximum: 1800 })
    expect(tool.description).toContain('only when you can stay alive')
    expect(JSON.stringify(tool)).not.toMatch(/resumeCommand/)
  })

  it('returns an answered card at once, and the answer when it lands, beating the lease', async () => {
    const done = asked()
    features.decide(done.post.id, 1, 'managed', HUMAN)
    const now = await call({ ticketId: done.ticket.id, postId: done.post.id })
    expect(now.isError).toBe(false)
    expect(JSON.parse(now.data)).toMatchObject({ answered: true, label: 'Postgres', text: 'managed' })

    const { ticket, post } = asked()
    const before = heartbeatsOf(ticket.id).length
    const p = call({ ticketId: ticket.id, timeoutSeconds: 30 })
    await sleep(100)
    expect(heartbeatsOf(ticket.id).length).toBe(before + 1)
    expect(heartbeatsOf(ticket.id).at(-1)!.by).toBe(AGENT)
    features.decide(post.id, 0, 'sqlite', HUMAN)
    const got = JSON.parse((await p).data)
    expect(got).toMatchObject({ answered: true, postId: post.id, option: 0, text: 'sqlite' })
    expect(got.message).toContain('Answered')
    expect(got.relayedBy).toBeUndefined()
  })

  it('times out saying to call again, stops on abort, and reports errors plainly', async () => {
    const { ticket, post } = asked()
    const t = await call({ ticketId: ticket.id, timeoutSeconds: 1 })
    expect(t.isError).toBe(false)
    expect(JSON.parse(t.data)).toMatchObject({ answered: false, timedOut: true, postId: post.id })
    expect(JSON.parse(t.data).message).toContain('call wait_for_answer again')

    const ctl = new AbortController()
    const p = call({ ticketId: ticket.id, postId: post.id, timeoutSeconds: 30 }, ctl.signal)
    await sleep(60)
    expect(wait.hasWaiter(ticket.id, post.id)).toBe(true)
    ctl.abort()
    await p.catch(() => {})
    await sleep(20)
    expect(wait.hasWaiter(ticket.id, post.id)).toBe(false)

    const none = await call({ ticketId: 999_999 })
    expect(none.isError).toBe(true)
  })
})
