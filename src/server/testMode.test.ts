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
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(['as', 'option', 'postId', 'words'])

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
