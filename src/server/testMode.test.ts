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
  it('says who you are and that the gate is off', async () => {
    expect(await (await call('GET', '/api/me', 'agent:builder')).json()).toEqual({
      actor: 'builder',
      agent: true,
      boardEnv: 'test',
      authOff: true,
    })
    expect(await (await call('GET', '/api/me')).json()).toMatchObject({ actor: 'human', agent: false })
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
