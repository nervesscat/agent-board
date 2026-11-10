import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

// A ticket's feed in two tabs (main, agents) and its summary, through the API router and the MCP
// server in test mode, the way agents and the human reach them: who calls is X-Test-Actor.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-threads-'))
process.env.DATA_DIR = tmp
process.env.BOARD_ENV = 'test'

const HUMAN = 'human:enrique'
const AGENT = 'agent:claude'

let dbm: typeof import('#/db')
let features: typeof import('./features')
let handle: (ctx: { request: Request; actor: string }) => Promise<Response>
let projectId: number
beforeAll(async () => {
  dbm = await import('#/db')
  features = await import('./features')
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  handle = guard(({ request, actor }: { request: Request; actor: string }) => api.handle(request, actor))
  const projects = await import('./projects')
  projectId = projects.createProject({ name: 'p' }, 'enrique').id
  dbm.db
    .insert(dbm.schema.repos)
    .values({ projectId, name: 'api', repoPath: '/r/api', baseBranch: 'main' })
    .run()
  // The project's agents: posting as one of them is how a connected agent delegates.
  const agents = await import('./projectAgents')
  for (const name of ['spec', 'builder']) agents.createAgent(projectId, { name }, 'enrique')
  // Both have signed in once, as signing in would have noted them.
  await call('GET', '/api/me', HUMAN)
  await call('GET', '/api/me', AGENT)
})

/** A request as the middleware hands it on: the caller resolved (and noted) from the same request. */
async function call(method: string, pathname: string, testActor: string, body?: unknown) {
  const { authenticate } = await import('./auth')
  const request = new Request(`http://localhost${pathname}`, {
    method,
    headers: {
      accept: 'application/json',
      'x-test-actor': testActor,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const actor = await authenticate(request)
  const res = await handle({ request, actor: actor! })
  return { status: res.status, body: (await res.json()) as any }
}

let rpcId = 0
/** An MCP tool call as the connected agent claude; its result parsed, or the error text when it failed. */
async function tool(name: string, args: Record<string, unknown>) {
  const { handleMcp } = await import('./mcp')
  const res = await handleMcp(
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-test-actor': AGENT,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }),
    'claude',
  )
  const body = (await res.json()) as {
    result?: { isError?: boolean; content: { text: string }[] }
    error?: { message: string }
  }
  if (body.error) return { error: body.error.message }
  const text = body.result!.content[0]!.text
  return body.result!.isError ? { error: text } : JSON.parse(text)
}

const newTicket = (title = 't') => features.createTicket(projectId, { title }, 'enrique')
const tabOfPost = (id: number) =>
  features.getTicketFull(features.getPost(id).ticketId).updates.find((u) => u.id === id)!.tab

describe('the tab of the feed a post goes to', () => {
  it('agents for progress and for posts made as a project agent; main for the rest', async () => {
    const t = newTicket()
    const at = `/api/tickets/${t.id}/updates`
    // Progress (the default) by an agent, over REST and MCP.
    expect((await call('POST', at, AGENT, { body: 'step one' })).body.tab).toBe('agents')
    expect((await tool('post_update', { ticketId: t.id, body: 'step two' })).tab).toBe('agents')
    // As one of the project's agents, progress or not, a post or a comment on the ticket.
    expect(
      (await tool('post_update', { ticketId: t.id, body: 'spec', as: 'spec', progress: false })).tab,
    ).toBe('agents')
    expect(
      (await tool('comment', { parentType: 'ticket', parentId: t.id, body: 'built', as: 'builder' })).tab,
    ).toBe('agents')
    // A decision card, even as a project agent.
    const card = await tool('ask_decision', {
      ticketId: t.id,
      body: 'Which way?',
      options: [{ label: 'a' }, { label: 'b' }],
      as: 'spec',
      block: false,
    })
    expect(card.tab).toBe('main')
    // The human's post, also when it says progress (the REST default).
    expect((await call('POST', at, HUMAN, { body: 'what about x?' })).body.tab).toBe('main')
    // A question to the human: an agent's post that is not progress, made as itself.
    expect((await tool('comment', { parentType: 'ticket', parentId: t.id, body: 'shall I?' })).tab).toBe(
      'main',
    )
    expect((await call('POST', at, AGENT, { body: 'a question', progress: false })).body.tab).toBe('main')
  })

  it('takes the tab the writer names, moves a post only on purpose, and refuses any other value', async () => {
    const t = newTicket()
    const p = await tool('post_update', { ticketId: t.id, body: 'for the human', tab: 'main' })
    expect(p.tab).toBe('main')
    const c = await call('POST', '/api/comments', AGENT, {
      parentType: 'ticket',
      parentId: t.id,
      body: 'working note',
      tab: 'agents',
    })
    expect(c.body.tab).toBe('agents')
    const d = await call('POST', `/api/tickets/${t.id}/decisions`, AGENT, {
      body: 'pick',
      options: [{ label: 'a' }, { label: 'b' }],
      block: false,
      tab: 'agents',
    })
    expect(d.body.tab).toBe('agents')

    // Marking it progress later does not move it; a tab does, logged.
    expect((await tool('edit_post', { id: p.id, progress: false })).tab).toBe('main')
    expect((await call('PATCH', `/api/updates/${p.id}`, AGENT, { progress: true })).body.tab).toBe('main')
    expect((await call('PATCH', `/api/updates/${p.id}`, AGENT, { tab: 'agents' })).body.tab).toBe('agents')
    expect((await tool('edit_post', { id: p.id, tab: 'main' })).tab).toBe('main')
    const { dailyReport, today } = await import('./daily')
    expect(dailyReport(today(), projectId).activity.map((e) => e.text)).toEqual(
      expect.arrayContaining([expect.stringContaining('edited a post on #' + t.id + ' t (moved to Agents)')]),
    )
    // Only its author or the human moves it.
    const other = await call('PATCH', `/api/updates/${p.id}`, 'agent:codex', { tab: 'agents' })
    expect(other.status).toBe(403)

    for (const [method, at, body] of [
      ['POST', `/api/tickets/${t.id}/updates`, { body: 'x', tab: 'other' }],
      ['PATCH', `/api/updates/${p.id}`, { tab: 'Main' }],
      // Nothing to change: what a call naming `thread` instead of `tab` comes down to.
      ['PATCH', `/api/updates/${p.id}`, { thread: 'agents' }],
      ['POST', '/api/comments', { parentType: 'ticket', parentId: t.id, body: 'x', tab: '' }],
    ] as const)
      expect((await call(method, at, AGENT, body)).status).toBe(400)
    expect((await tool('post_update', { ticketId: t.id, body: 'x', tab: 'other' })).error).toBeDefined()
    expect(tabOfPost(p.id)).toBe('main')
  })

  it("keeps a reply under its post, in that post's tab, and returns the tab on every read of a post", async () => {
    const t = newTicket()
    const human = (
      await call('POST', `/api/tickets/${t.id}/updates`, HUMAN, { body: 'please add y', progress: false })
    ).body
    const before = features.getTicketFull(t.id).updates.length
    // The plan, then the result, under the human's post.
    await tool('comment', { parentType: 'ticket', parentId: t.id, replyTo: human.id, body: 'Plan: …' })
    await tool('comment', { parentType: 'update', parentId: human.id, body: 'Done: …' })
    const full = features.getTicketFull(t.id)
    expect(full.updates).toHaveLength(before)
    expect(full.updates[0]).toMatchObject({ id: human.id, thread: { count: 2 } })
    expect(features.getPost(human.id).tab).toBe('main')
    const view = await tool('get_ticket', { ticketId: t.id })
    expect(view.updates.map((u: { tab: string }) => u.tab)).toEqual(['main'])
    const listed = await tool('list_comments', { parentType: 'ticket', parentId: t.id })
    expect(listed.map((u: { tab: string }) => u.tab)).toEqual(['main'])
    expect((await call('GET', `/api/tickets/${t.id}`, HUMAN)).body.updates[0].tab).toBe('main')
    // The human's inbox reaches it from main; an agent's list_my_threads says which tab it is in.
    await call('POST', '/api/comments', HUMAN, {
      parentType: 'update',
      parentId: human.id,
      body: 'thanks, and z?',
    })
    const mine = await tool('list_my_threads', { projectId })
    expect(mine.threads.find((x: { parentId: number }) => x.parentId === human.id)).toMatchObject({
      parentType: 'update',
      tab: 'main',
    })
  })
})

describe('the summary', () => {
  it('is one per ticket: each write a new version, every one kept with its files, newest first', async () => {
    const t = newTicket('summed')
    expect(features.getTicketFull(t.id).summary).toBeNull()
    const upload = async (name: string) => {
      const uploads = await import('./uploads')
      return uploads.saveUpload(new File([name], name, { type: 'text/plain' }), 'claude')
    }
    const proof = await upload('proof.txt')
    const first = await call('PUT', `/api/tickets/${t.id}/summary`, AGENT, {
      body: 'Adds x. In review.',
      attachmentIds: [proof.id],
    })
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({
      body: 'Adds x. In review.',
      change: '',
      by: 'claude',
      via: '',
      versions: 1,
      fallback: false,
    })
    expect(first.body.attachments.map((a: { name: string }) => a.name)).toEqual(['proof.txt'])
    // From the second version on it says what changed.
    expect((await call('PUT', `/api/tickets/${t.id}/summary`, AGENT, { body: 'v2' })).status).toBe(400)
    expect((await tool('set_ticket_summary', { ticketId: t.id, body: 'v2' })).error).toMatch(/what changed/)
    expect(
      (await call('PUT', `/api/tickets/${t.id}/summary`, AGENT, { body: '  ', change: 'x' })).status,
    ).toBe(400)
    const second = await tool('set_ticket_summary', {
      ticketId: t.id,
      body: 'Adds x. Review round 1: survived.',
      change: 'round 1 verdict',
      as: 'builder',
    })
    expect(second).toMatchObject({ change: 'round 1 verdict', by: 'builder', via: 'claude', versions: 2 })
    await tool('set_ticket_summary', { ticketId: t.id, body: 'v3', change: 'the preview' })

    const view = await tool('get_ticket', { ticketId: t.id })
    expect(view.summary).toMatchObject({ body: 'v3', change: 'the preview', versions: 3, fallback: false })
    const history = (await call('GET', `/api/tickets/${t.id}/summary`, HUMAN)).body
    expect(history.summary.body).toBe('v3')
    expect(history.versions.map((v: { body: string; change: string }) => [v.body, v.change])).toEqual([
      ['v3', 'the preview'],
      ['Adds x. Review round 1: survived.', 'round 1 verdict'],
      ['Adds x. In review.', ''],
    ])
    expect(history.versions[2].attachments.map((a: { name: string }) => a.name)).toEqual(['proof.txt'])
    expect((await tool('get_ticket_summary', { ticketId: t.id })).versions).toHaveLength(3)
    // Its versions are posts in main, never progress, and never edited or deleted.
    const oldest = history.versions[2].postId
    expect(features.getPost(oldest)).toMatchObject({ tab: 'main', progress: false, summary: true })
    expect((await call('PATCH', `/api/updates/${oldest}`, HUMAN, { body: 'rewritten' })).status).toBe(409)
    expect((await call('DELETE', `/api/updates/${oldest}`, HUMAN)).status).toBe(409)
    expect((await tool('delete_post', { id: oldest })).error).toMatch(/kept as it was written/)
    // The hourly sweep leaves the first version's file alone.
    const { deleteUnattachedUploads } = await import('./unattached')
    await deleteUnattachedUploads({ now: Date.now() + 7 * 86_400_000 })
    const kept = (await call('GET', `/api/tickets/${t.id}/summary`, HUMAN)).body.versions[2].attachments
    expect(kept.map((a: { id: number }) => a.id)).toEqual([proof.id])
  })

  it('refuses a file that is not there or already attached without storing a version, and the retry is the first', async () => {
    const t = newTicket('refused files')
    const uploads = await import('./uploads')
    const used = await uploads.saveUpload(new File(['a'], 'a.txt', { type: 'text/plain' }), 'claude')
    const other = newTicket('holds the file')
    features.setSummary(other.id, { body: 'other', attachmentIds: [used.id] }, 'claude')
    const versions = () =>
      dbm.db
        .select()
        .from(dbm.schema.updates)
        .all()
        .filter((u) => u.ticketId === t.id).length

    const missing = await call('PUT', `/api/tickets/${t.id}/summary`, AGENT, {
      body: 'v1',
      attachmentIds: [999_999],
    })
    expect(missing.status).toBe(404)
    const attached = await call('PUT', `/api/tickets/${t.id}/summary`, AGENT, {
      body: 'v1',
      attachmentIds: [used.id],
    })
    expect(attached.status).toBe(409)
    expect((await tool('post_update', { ticketId: t.id, body: 'x', files: [] })).id).toBeDefined()
    const progressOnly = versions()
    expect(
      (await call('POST', `/api/tickets/${t.id}/updates`, AGENT, { body: 'y', attachmentIds: [999_999] }))
        .status,
    ).toBe(404)
    expect(versions()).toBe(progressOnly)
    // Nothing was stored: no summary, and the retry needs no change line, as a first version.
    const read = (await call('GET', `/api/tickets/${t.id}/summary`, HUMAN)).body
    expect(read.versions).toEqual([])
    expect(read.summary).toMatchObject({ fallback: true })
    const retry = await call('PUT', `/api/tickets/${t.id}/summary`, AGENT, { body: 'v1' })
    expect(retry.status).toBe(200)
    expect(retry.body).toMatchObject({ body: 'v1', versions: 1, fallback: false })
    // The file stays with the version it was on.
    expect(features.getTicketFull(other.id).summary!.attachments.map((a) => a.id)).toEqual([used.id])
  })

  it('is new activity on every write: the ticket bumps, the Daily view logs it, the inboxes get it', async () => {
    // The human opened the ticket; an agent works it.
    const t = newTicket('watched')
    const { getSummary } = await import('./summary')
    const needsYou = () => getSummary(projectId, { humans: ['enrique'] }).projects[0]!.needsYou
    const updatedAt = () => features.getTicket(t.id).updatedAt
    const was = updatedAt()
    await new Promise((r) => setTimeout(r, 5))
    await tool('set_ticket_summary', { ticketId: t.id, body: 'What it does', as: 'builder' })
    expect(updatedAt() > was).toBe(true)
    const thread = needsYou().threads.find((x) => x.ticketId === t.id)!
    expect(thread).toMatchObject({ parentType: 'ticket', parentId: t.id, last: { author: 'builder' } })
    const firstAt = thread.last.createdAt
    // The inbox of whoever opened the ticket has it; the writer's does not.
    const theirs = features.checkInbox(projectId, 'enrique', null)
    expect(theirs.threads.map((x) => x.ticketId)).toContain(t.id)
    const own = features.checkInbox(projectId, 'builder', null)
    expect(own.threads.filter((x) => x.ticketId === t.id && x.parentType === 'ticket')).toEqual([])

    await new Promise((r) => setTimeout(r, 5))
    await tool('set_ticket_summary', {
      ticketId: t.id,
      body: 'What it does, v2',
      change: 'the PR',
      as: 'builder',
    })
    const again = needsYou().threads.find((x) => x.ticketId === t.id)!
    expect(again.last.createdAt > firstAt).toBe(true)
    const { dailyReport, today } = await import('./daily')
    const texts = dailyReport(today(), projectId).activity.map((e) => e.text)
    expect(texts).toEqual(
      expect.arrayContaining([
        `wrote the summary of #${t.id} watched (via claude): What it does`,
        `updated the summary of #${t.id} watched (via claude): the PR`,
      ]),
    )
    // Not progress: the readers of progress posts do not see it.
    expect(features.getTicketFull(t.id).updates.every((u) => !u.progress)).toBe(true)
  })

  it('stands in, until one is written, with the newest progress post by an agent', async () => {
    const t = newTicket('older')
    features.postUpdate(t.id, 'first step', [], 'claude')
    const latest = features.postUpdate(t.id, 'Hand-off: PR, preview, how it was tested', [], 'claude')
    // Neither the human's nor a discussion post stands in.
    features.postUpdate(t.id, 'my progress', [], 'enrique')
    features.postUpdate(t.id, 'a question', [], 'claude', { progress: false })
    const count = () => dbm.db.select().from(dbm.schema.updates).all().length
    const rows = count()
    const view = await tool('get_ticket', { ticketId: t.id })
    expect(view.summary).toMatchObject({
      postId: latest.id,
      body: latest.body,
      fallback: true,
      versions: 0,
    })
    // Read, never copied; the old post stays in agents.
    expect(count()).toBe(rows)
    expect(tabOfPost(latest.id)).toBe('agents')
    features.setSummary(t.id, { body: 'Now a summary' }, 'claude')
    expect(features.getTicketFull(t.id).summary).toMatchObject({ body: 'Now a summary', fallback: false })
  })
})

describe('a reply', () => {
  it('is refused under a comment of another thread, and nests under one of its own', async () => {
    const t = newTicket('nested replies')
    const v1 = features.setSummary(t.id, { body: 'v1' }, 'claude')
    const under = await call('POST', '/api/comments', AGENT, {
      parentType: 'update',
      parentId: v1.postId,
      body: 'on v1',
    })
    const v2 = features.setSummary(t.id, { body: 'v2', change: 'again' }, 'claude')
    const stray = await call('POST', '/api/comments', HUMAN, {
      parentType: 'update',
      parentId: v2.postId,
      replyTo: under.body.id,
      body: 'an answer begun under v1',
    })
    expect(stray.status).toBe(400)
    expect(stray.body.error).toMatch(/not in this thread/)
    expect(
      (
        await call('POST', '/api/comments', HUMAN, {
          parentType: 'update',
          parentId: v2.postId,
          replyTo: 999_999,
          body: 'x',
        })
      ).status,
    ).toBe(400)
    expect(features.listComments('update', v2.postId)).toEqual([])
    const nested = await call('POST', '/api/comments', HUMAN, {
      parentType: 'update',
      parentId: v1.postId,
      replyTo: under.body.id,
      body: 'an answer under v1',
    })
    expect(nested.status).toBe(201)
    expect(features.listComments('update', v1.postId).map((c) => [c.body, c.replyTo])).toEqual([
      ['on v1', null],
      ['an answer under v1', under.body.id],
    ])
  })
})

describe('Needs you from either tab', () => {
  it('reaches the human whichever tab the post that waits on them is in', async () => {
    const { getSummary } = await import('./summary')
    const waiting = () =>
      getSummary(projectId, { humans: ['enrique'] })
        .projects[0]!.needsYou.threads.filter((x) => x.parentType === 'update')
        .map((x) => x.parentId)
    const t = newTicket('either')
    const inMain = (
      await call('POST', `/api/tickets/${t.id}/updates`, HUMAN, { body: 'main?', progress: false })
    ).body
    const inAgents = (
      await call('POST', `/api/tickets/${t.id}/updates`, HUMAN, {
        body: 'agents?',
        progress: false,
        tab: 'agents',
      })
    ).body
    expect(inAgents.tab).toBe('agents')
    for (const post of [inMain, inAgents])
      await tool('comment', { parentType: 'update', parentId: post.id, body: 'answered' })
    expect(waiting()).toEqual(expect.arrayContaining([inMain.id, inAgents.id]))
  })
})

describe('what agents are told', () => {
  const repo = path.join(import.meta.dirname, '..', '..')
  const read = (...parts: string[]) => fs.readFileSync(path.join(...parts), 'utf8').replace(/\s+/g, ' ')
  const docs = {
    'AGENTS.md': read(repo, 'AGENTS.md'),
    'board.md': read(import.meta.dirname, 'skill', 'board.md'),
    'todo-review-ticket.md': read(import.meta.dirname, 'skill', 'review', 'agents', 'todo-review-ticket.md'),
    'todo-review SKILL.md': read(import.meta.dirname, 'skill', 'review', 'skills', 'todo-review', 'SKILL.md'),
    'feature-review SKILL.md': read(
      import.meta.dirname,
      'skill',
      'review',
      'skills',
      'feature-review',
      'SKILL.md',
    ),
  }

  it('where posts go, to keep Main short, to rewrite the summary, and to reply under the human', async () => {
    const { handleMcp } = await import('./mcp')
    const res = await handleMcp(
      new Request('http://localhost/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++rpcId,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 't', version: '0' },
          },
        }),
      }),
      'claude',
    )
    const instructions = ((await res.json()) as { result: { instructions: string } }).result.instructions
    for (const [name, text] of Object.entries({ 'MCP instructions': instructions, ...docs })) {
      expect(text, name).toContain('set_ticket_summary')
      expect(text, name).toMatch(/Agents/)
      expect(text, name).toMatch(/short and to the point|Keep Main short/)
      expect(text, name).toMatch(/never (with |as )?a new top-level post/)
      expect(text, name).toMatch(/plan/)
      expect(text, name).not.toMatch(/hand-off post \(`?post_update/i)
    }
  })
})
