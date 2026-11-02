import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

// The whole API router in test mode, the way Playwright or CI drive it: who calls is X-Test-Actor.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp
process.env.BOARD_ENV = 'test'

let handle: (ctx: { request: Request; actor: string }) => Promise<Response>
let callerOf: typeof import('./auth').callerOf
let projectId: number
beforeAll(async () => {
  // As src/routes/api/$.ts serves it: HttpErrors become their JSON answer.
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  handle = guard(({ request, actor }: { request: Request; actor: string }) => api.handle(request, actor))
  callerOf = (await import('./auth')).callerOf
  const projects = await import('./projects')
  projectId = projects.createProject({ name: 'p' }, 'human').id
  const { db, schema } = await import('#/db')
  db.insert(schema.repos).values({ projectId, name: 'api', repoPath: '/r/api', baseBranch: 'main' }).run()
})

/** A request as the middleware would hand it on: the actor resolved from the same request. */
async function call(method: string, pathname: string, testActor?: string, body?: unknown) {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (testActor !== undefined) headers['x-test-actor'] = testActor
  if (body !== undefined) headers['content-type'] = 'application/json'
  const request = new Request(`http://localhost${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const caller = await callerOf(request)
  return handle({ request, actor: caller!.name })
}

describe('test mode through the API router', () => {
  it('says who you are and that sign-in is off', async () => {
    expect(await (await call('GET', '/api/me', 'agent:builder')).json()).toEqual({
      actor: 'builder',
      agent: true,
      role: 'worker',
      parent: '',
      boardEnv: 'test',
      authOff: true,
    })
    expect(await (await call('GET', '/api/me')).json()).toMatchObject({ actor: 'human', agent: false })
  })

  it('has no passkeys to sign in with: the sign-in endpoints say sign-in is off', async () => {
    for (const path of ['/api/auth/login/options', '/api/auth/setup/options', '/api/auth/enrol-links']) {
      const res = await call('POST', path, 'human:qa', { name: 'qa' })
      expect(res.status, path).toBe(409)
      expect(await res.json()).toEqual({
        error: 'sign-in is off on this board (BOARD_ENV=test)',
        code: 'auth-off',
      })
    }
  })

  it("refuses an agent: caller the project's agents, and lets a human: one write them", async () => {
    const path = `/api/projects/${projectId}/agents`
    const refused = await call('POST', path, 'agent:builder', { name: 'spec' })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: "only the human edits the project's agents" })

    const created = await call('POST', path, 'human:qa', { name: 'spec' })
    expect(created.status).toBe(201)
    // No header is the human too, so a plain browser works.
    expect((await call('POST', path, undefined, { name: 'builder' })).status).toBe(201)
  })

  it('refuses an agent: caller the archive, and lets a human: one archive', async () => {
    const features = await import('./features')
    const ticket = features.createTicket(projectId, { title: 'done', status: 'done' }, 'human')
    const refused = await call('POST', `/api/tickets/${ticket.id}/archive`, 'agent:builder')
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: 'only the human archives and restores tickets' })

    const archived = await call('POST', `/api/tickets/${ticket.id}/archive`, 'human:qa')
    expect(archived.status).toBe(200)
  })
})

describe('a decision the orchestrator relays, through the router', () => {
  const OPTIONS = [{ label: 'Local disk' }, { label: 'MinIO' }]
  const NOT_AGENT = 'only a connected agent relays a decision: the human answers the card'
  const AS = "a decision is relayed by the orchestrator, not as one of the project's agents"

  /** A card the agent asked, on a ticket of its own: the card's post and its ticket. */
  async function askCard() {
    const features = await import('./features')
    const ticket = features.createTicket(projectId, { title: 'Pick storage' }, 'human')
    const asked = await call('POST', `/api/tickets/${ticket.id}/decisions`, 'agent:claude', {
      body: 'Where should uploads live?',
      options: OPTIONS,
    })
    expect(asked.status).toBe(201)
    return { postId: ((await asked.json()) as { id: number }).id, ticketId: ticket.id }
  }
  // The orchestrator's call by default; a test that sends no header goes through `call` itself, since a
  // default parameter would turn an undefined actor into the agent.
  const relay = (postId: number, body: unknown, testActor = 'agent:claude') =>
    call('POST', `/api/updates/${postId}/decision/relay`, testActor, body)

  it('records the answer the orchestrator relays: decided, with the words as the human gave them', async () => {
    const { postId } = await askCard()
    const res = await relay(postId, { option: 1, words: '  MinIO, survives a reinstall  ' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      id: postId,
      decidedOption: 1,
      decidedBy: '',
      decidedAt: expect.any(String),
      relayedBy: 'claude',
      relayedText: 'MinIO, survives a reinstall',
    })
  })

  it('refuses a human, a call that names a persona, blank words and an unknown option; nothing changes', async () => {
    const features = await import('./features')
    const { postId, ticketId } = await askCard()
    // A human by header, and a browser with no header at all.
    const byHeader = await relay(postId, { option: 1, words: 'MinIO' }, 'human:enrique')
    const noHeader = await call('POST', `/api/updates/${postId}/decision/relay`, undefined, {
      option: 1,
      words: 'MinIO',
    })
    for (const res of [byHeader, noHeader]) {
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: NOT_AGENT })
    }
    const persona = await relay(postId, { option: 1, words: 'MinIO', as: 'builder' })
    expect(persona.status).toBe(403)
    expect(await persona.json()).toEqual({ error: AS })
    for (const words of ['', '   ']) expect((await relay(postId, { option: 1, words })).status).toBe(400)
    const unknown = await relay(postId, { option: 5, words: 'MinIO' })
    expect(unknown.status).toBe(400)
    expect(await unknown.json()).toEqual({ error: 'no option 5; there are 2' })
    // A post that is not a decision.
    const plain = features.postUpdate(ticketId, 'just a note', [], 'claude')
    const notDecision = await relay(plain.id, { option: 0, words: 'MinIO' })
    expect(notDecision.status).toBe(400)
    expect(await notDecision.json()).toEqual({ error: `post ${plain.id} is not a decision` })
    expect(features.getPost(postId)).toMatchObject({ decidedAt: null, decidedOption: null, relayedBy: '' })
  })

  it('answers 409 with its code once the card is decided, and the first answer stands', async () => {
    const features = await import('./features')
    const { postId } = await askCard()
    expect((await relay(postId, { option: 1, words: 'MinIO' })).status).toBe(200)
    const again = await relay(postId, { option: 0, words: 'Local disk' })
    expect(again.status).toBe(409)
    expect(await again.json()).toEqual({
      error: `decision ${postId} is already decided; the human changes it on the card`,
      code: 'decided',
    })
    expect(features.getPost(postId)).toMatchObject({ decidedOption: 1, relayedText: 'MinIO' })
  })

  /** An MCP call as a client sends it (streamable HTTP, answered as JSON), as the header's caller. */
  async function mcp(testActor: string, method: string, params: Record<string, unknown> = {}) {
    const request = new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-test-actor': testActor,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    const caller = await callerOf(request)
    const res = await handle({ request, actor: caller!.name })
    return ((await res.json()) as { result: any }).result
  }

  it('offers answer_decision to a connected agent, which records the answer and refuses a persona or a human', async () => {
    const features = await import('./features')
    const listed = await mcp('agent:claude', 'tools/list')
    const tool = listed.tools.find((t: { name: string }) => t.name === 'answer_decision')
    expect(tool.description).toContain('AskUserQuestion')
    expect(tool.description).toContain('subagent')
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual([
      'agentName',
      'as',
      'option',
      'postId',
      'words',
    ])

    const { postId } = await askCard()
    const answer = (testActor: string, args: Record<string, unknown>) =>
      mcp(testActor, 'tools/call', {
        name: 'answer_decision',
        arguments: { postId, option: 1, words: 'MinIO', ...args },
      })
    // A persona's call (as, even an empty one) and a human's are refused in the tool's own result.
    const persona = await answer('agent:claude', { as: 'builder' })
    expect(persona).toMatchObject({ isError: true })
    expect(persona.content[0].text).toBe(AS)
    expect((await answer('agent:claude', { as: '' })).isError).toBe(true)
    const human = await answer('human:enrique', {})
    expect(human).toMatchObject({ isError: true })
    expect(human.content[0].text).toBe(NOT_AGENT)
    expect(features.getPost(postId)).toMatchObject({ decidedAt: null, relayedBy: '' })

    // The orchestrator's own call records the answer: the result is the updated post.
    const recorded = await answer('agent:claude', {})
    expect(recorded.isError).toBeFalsy()
    expect(JSON.parse(recorded.content[0].text)).toMatchObject({
      id: postId,
      decidedOption: 1,
      decidedBy: '',
      relayedBy: 'claude',
      relayedText: 'MinIO',
    })
  })
})

describe('who is who in test mode: orchestrator:, agent: and sub-identities', () => {
  /** A request as the middleware hands it on, with any headers (X-Test-Actor, X-Agent-Name). */
  async function send(method: string, pathname: string, headers: Record<string, string>, body?: unknown) {
    const request = new Request(`http://localhost${pathname}`, {
      method,
      headers: {
        accept: 'application/json, text/event-stream',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const caller = await callerOf(request)
    return handle({ request, actor: caller!.name })
  }
  /** A tool call: its parsed result, or `{error}` with the message of a refused call. */
  async function tool(headers: Record<string, string>, name: string, args: Record<string, unknown>) {
    const res = await send('POST', '/api/mcp', headers, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    })
    const { result } = (await res.json()) as { result: any }
    const text = result.content[0].text
    return result.isError ? { error: text } : JSON.parse(text)
  }
  const ORCH = { 'x-test-actor': 'orchestrator:orch' }

  it('/api/me and whoami tell the human, an orchestrator, a worker and a sub-identity apart', async () => {
    const me = async (headers: Record<string, string>) => (await send('GET', '/api/me', headers)).json()
    expect(await me({})).toMatchObject({ actor: 'human', agent: false, role: 'human', parent: '' })
    expect(await me(ORCH)).toMatchObject({ actor: 'orch', agent: true, role: 'orchestrator', parent: '' })
    expect(await me({ 'x-test-actor': 'agent:w' })).toMatchObject({ actor: 'w', role: 'worker', parent: '' })
    expect(await me({ ...ORCH, 'x-agent-name': 'orch/worker-1' })).toMatchObject({
      actor: 'orch/worker-1',
      agent: true,
      role: 'worker',
      parent: 'orch',
    })
    expect(await tool(ORCH, 'whoami', { agentName: 'orch/worker-2' })).toEqual({
      actor: 'orch/worker-2',
      name: 'orch/worker-2',
      role: 'worker',
      parent: 'orch',
      token: 'orch',
    })
    expect(await tool({ 'x-test-actor': 'human:qa' }, 'whoami', { agentName: 'qa/x' })).toMatchObject({
      name: 'qa',
      role: 'human',
    })
    // Every tool takes agentName.
    const listed = await send('POST', '/api/mcp', ORCH, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const { tools } = ((await listed.json()) as { result: { tools: any[] } }).result
    for (const t of tools) expect(Object.keys(t.inputSchema.properties ?? {}), t.name).toContain('agentName')
  })

  it("files a sub-identity's posts, claims and comments under its own name", async () => {
    const features = await import('./features')
    const ticket = features.createTicket(projectId, { title: 'Delegated' }, 'human')
    const as = { agentName: 'orch/worker-2' }
    const claimed = await tool(ORCH, 'claim_ticket', { ticketId: ticket.id, ...as })
    expect(claimed.assignee).toBe('orch/worker-2')
    const post = await tool(ORCH, 'post_update', { ticketId: ticket.id, body: 'built it', ...as })
    expect(post.author).toBe('orch/worker-2')
    const reply = await tool(ORCH, 'comment', {
      parentType: 'update',
      parentId: post.id,
      body: 'and tested it',
      ...as,
    })
    expect(reply.author).toBe('orch/worker-2')
    const { db, schema } = await import('#/db')
    const { eq } = await import('drizzle-orm')
    const lines = db.select().from(schema.activity).where(eq(schema.activity.projectId, projectId)).all()
    expect(lines.filter((l) => l.actor === 'orch/worker-2').length).toBeGreaterThanOrEqual(3)
    const { listActors } = await import('./actors')
    expect(listActors().find((a) => a.name === 'orch/worker-2')).toEqual({
      name: 'orch/worker-2',
      kind: 'agent',
      role: 'worker',
      parent: 'orch',
      lastSeenAt: expect.any(String),
    })
    // A bad agentName refuses the call: nothing is posted.
    const before = features.listComments('ticket', ticket.id).length
    expect(await tool(ORCH, 'post_update', { ticketId: ticket.id, body: 'x', agentName: 'other/x' })).toEqual(
      {
        error: expect.stringMatching(/^agentName must be <token-name>\/<name>, here orch\/<name>/),
      },
    )
    expect(features.listComments('ticket', ticket.id).length).toBe(before)
  })

  it("records a sub-identity's work timeline under its full name, by MCP and by REST", async () => {
    const features = await import('./features')
    const ticket = features.createTicket(projectId, { title: 'Timed' }, 'human')
    const scope = { projectId, ticketId: ticket.id }
    const span = await tool(ORCH, 'start_span', { ...scope, phase: 'build', agentName: 'orch/worker-3' })
    expect(span.event).toMatchObject({ agent: 'orch/worker-3', by: 'orch/worker-3' })
    // Its own open span is found under its full name, not its parent's.
    const ended = await tool(ORCH, 'end_span', { ...scope, agentName: 'orch/worker-3' })
    expect(ended.span.id).toBe(span.event.id)
    const rest = await send(
      'POST',
      `/api/projects/${projectId}/tickets/${ticket.id}/events`,
      { ...ORCH, 'x-agent-name': 'orch/worker-4' },
      { kind: 'span_start', phase: 'review' },
    )
    expect(rest.status).toBe(201)
    expect((await rest.json()).event).toMatchObject({ agent: 'orch/worker-4', by: 'orch/worker-4' })
  })

  it("refuses a sub-identity's relay of a decision; the orchestrator's own still works", async () => {
    const features = await import('./features')
    const ticket = features.createTicket(projectId, { title: 'Pick one' }, 'human')
    const asked = features.askDecision(
      ticket.id,
      { body: 'Which?', options: [{ label: 'A' }, { label: 'B' }] },
      'orch',
    )
    const refusal = 'only the session that talks to the human relays an answer'
    const rest = await send(
      'POST',
      `/api/updates/${asked.id}/decision/relay`,
      { ...ORCH, 'x-agent-name': 'orch/worker-1' },
      {
        option: 0,
        words: 'A',
      },
    )
    expect(rest.status).toBe(403)
    expect(await rest.json()).toEqual({ error: refusal })
    expect(
      await tool(ORCH, 'answer_decision', {
        postId: asked.id,
        option: 0,
        words: 'A',
        agentName: 'orch/worker-1',
      }),
    ).toEqual({ error: refusal })
    expect(features.getPost(asked.id)).toMatchObject({ decidedAt: null, relayedBy: '' })
    const ok = await send('POST', `/api/updates/${asked.id}/decision/relay`, ORCH, { option: 1, words: 'B' })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ decidedOption: 1, relayedBy: 'orch' })
  })

  it("takes a sub-identity's repo request, refuses its relay of the Add; the orchestrator's adds the repo", async () => {
    const { execFileSync } = await import('node:child_process')
    const features = await import('./features')
    const repos = await import('./repos')
    const ticket = features.createTicket(projectId, { title: 'Needs a repo' }, 'human')
    const dir = path.join(tmp, 'sub-identity-repo')
    fs.mkdirSync(dir)
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/subrepo'], { cwd: dir })
    // Asking is open to a worker: the card carries the sub-identity's name.
    const card = await tool(ORCH, 'add_repo', {
      ticketId: ticket.id,
      name: 'subrepo',
      repoPath: dir,
      githubRepo: 'acme/subrepo',
      agentName: 'orch/worker-2',
    })
    expect(card).toMatchObject({ author: 'orch/worker-2', decidedAt: null })
    const added = () => repos.listRepos(projectId).filter((r) => r.name === 'subrepo')

    const refusal = 'only the session that talks to the human relays an answer'
    const rest = await send(
      'POST',
      `/api/updates/${card.id}/decision/relay`,
      { ...ORCH, 'x-agent-name': 'orch/worker-2' },
      { option: 0, words: 'add it' },
    )
    expect(rest.status).toBe(403)
    expect(await rest.json()).toEqual({ error: refusal })
    expect(
      await tool(ORCH, 'answer_decision', {
        postId: card.id,
        option: 0,
        words: 'add it',
        agentName: 'orch/worker-2',
      }),
    ).toEqual({ error: refusal })
    expect(features.getPost(card.id)).toMatchObject({ decidedAt: null, relayedBy: '' })
    expect(added()).toEqual([])

    const ok = await tool(ORCH, 'answer_decision', { postId: card.id, option: 0, words: 'add it' })
    expect(ok).toMatchObject({ relayedBy: 'orch', repo: { added: { name: 'subrepo' } } })
    expect(added()).toHaveLength(1)
  })

  it('set_project_instructions: an orchestrator changes them, a worker hears to ask its orchestrator', async () => {
    const projects = await import('./projects')
    const p = projects.createProject({ name: 'rules', instructions: 'old' }, 'human', {
      name: 'human',
      role: 'human',
    }).id
    expect(
      await tool({ 'x-test-actor': 'agent:w' }, 'set_project_instructions', {
        projectId: p,
        instructions: 'x',
      }),
    ).toEqual({
      error:
        "only an orchestrator or the human changes the project's instructions: ask your orchestrator (you are w, a worker)",
    })
    const done = await tool(ORCH, 'set_project_instructions', { projectId: p, instructions: 'new' })
    expect(done).toMatchObject({
      instructions: 'new',
      change: { oldValue: 'old', newValue: 'new', state: 'pending' },
    })
    expect((await tool(ORCH, 'get_project', { projectId: p })).instructions).toBe('new')
    expect(await tool(ORCH, 'set_project_instructions', { projectId: p, instructions: 'new' })).toEqual({
      instructions: 'new',
      change: null,
    })
    const summary = await tool({}, 'get_summary', { projectId: p })
    expect(summary.projects[0].needsYou.instructionChanges).toMatchObject([
      { changeId: done.change.id, changedBy: 'orch', role: 'orchestrator', excerpt: 'new' },
    ])
  })

  it("lets an orchestrator and a sub-identity write a repo's runs under their own names, as the human does", async () => {
    const { db, schema } = await import('#/db')
    const { eq } = await import('drizzle-orm')
    const repo = db.select().from(schema.repos).all()[0]!
    const SUB = { ...ORCH, 'x-agent-name': 'orch/worker-6' }
    const made = await send('POST', `/api/repos/${repo.id}/runs`, SUB, {
      name: 'web',
      type: 'preview',
      start: 'node server.js',
    })
    expect(made.status).toBe(201)
    const run = (await made.json()) as { id: number; createdBy: string }
    expect(run.createdBy).toBe('orch/worker-6')
    const human = await send(
      'POST',
      `/api/repos/${repo.id}/runs`,
      { 'x-test-actor': 'human:qa' },
      {
        name: 'worker',
        type: 'job',
        start: 'node worker.js',
      },
    )
    expect(human.status).toBe(201)
    const { id: humanRun } = (await human.json()) as { id: number }
    const changed = await send('PATCH', `/api/runs/${humanRun}`, ORCH, { start: 'node worker.js --once' })
    expect(changed.status).toBe(200)
    expect(await changed.json()).toMatchObject({ start: 'node worker.js --once', createdBy: 'qa' })
    expect(
      (await send('PUT', `/api/repos/${repo.id}/runs/order`, SUB, { ids: [humanRun, run.id] })).status,
    ).toBe(200)
    expect((await send('DELETE', `/api/runs/${run.id}`, ORCH)).status).toBe(200)
    // Over MCP too: a sub-identity passing agentName adds, changes and deletes under its name.
    const added = await tool(ORCH, 'add_run', {
      repoId: repo.id,
      name: 'Api',
      type: 'preview',
      start: 'node api.js',
      agentName: 'orch/worker-6',
    })
    expect(added).toMatchObject({ name: 'Api', createdBy: 'orch/worker-6' })
    expect(
      await tool(ORCH, 'update_run', { runId: added.id, port: 47150, agentName: 'orch/worker-6' }),
    ).toMatchObject({
      port: 47150,
    })
    expect(await tool(ORCH, 'delete_run', { runId: added.id, agentName: 'orch/worker-6' })).toMatchObject({
      id: added.id,
    })
    expect(
      await tool(ORCH, 'add_run', {
        repoId: repo.id,
        name: 'x',
        type: 'job',
        start: 'x',
        agentName: 'nobody/x',
      }),
    ).toMatchObject({
      error: expect.any(String),
    })
    const activity = db
      .select({ actor: schema.activity.actor, text: schema.activity.text })
      .from(schema.activity)
      .where(eq(schema.activity.refType, 'repo'))
      .all()
      .filter((a) => / run/.test(a.text))
    expect(activity).toEqual(
      expect.arrayContaining([
        { actor: 'orch/worker-6', text: `added the preview run web to repo ${repo.name}` },
        { actor: 'orch', text: `changed the run worker of repo ${repo.name}` },
        { actor: 'orch/worker-6', text: `reordered the runs of repo ${repo.name}` },
        { actor: 'orch', text: `removed the run web from repo ${repo.name}` },
        { actor: 'orch/worker-6', text: `added the preview run Api to repo ${repo.name}` },
        { actor: 'orch/worker-6', text: `changed the run Api of repo ${repo.name}` },
        { actor: 'orch/worker-6', text: `removed the run Api from repo ${repo.name}` },
      ]),
    )
    expect(db.select({ name: schema.runConfigs.name }).from(schema.runConfigs).all()).toEqual([
      { name: 'worker' },
    ])
    db.delete(schema.runConfigs).run()
  })

  it("files a sub-identity's multi-repo claim under its own name, and refuses the run tools a bad agentName", async () => {
    const { db, schema } = await import('#/db')
    const repo = db.select().from(schema.repos).all()[0]!
    const features = await import('./features')
    const ticket = features.createTicket(projectId, { title: 'Two repos', repoId: repo.id }, 'human')
    const as = { agentName: 'orch/worker-7' }
    const claimed = await tool(ORCH, 'claim_ticket', {
      ticketId: ticket.id,
      repos: [{ repoId: repo.id, branch: 'feat/x' }],
      ...as,
    })
    expect(claimed).toMatchObject({ assignee: 'orch/worker-7', branch: 'feat/x' })
    expect(await tool(ORCH, 'list_runs', { ticketId: ticket.id, ...as })).toMatchObject({
      repos: [{ repoId: repo.id, branch: 'feat/x' }],
    })
    expect(await tool(ORCH, 'stop_run', { ticketId: ticket.id, all: true, ...as })).toEqual({ results: [] })
    for (const name of ['list_runs', 'start_run', 'stop_run'])
      expect(await tool(ORCH, name, { ticketId: ticket.id, agentName: 'other/x' }), name).toEqual({
        error: expect.stringMatching(/^agentName must be <token-name>\/<name>, here orch\/<name>/),
      })
  })
})
