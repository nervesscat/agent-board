import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-work-stage-'))
process.env.DATA_DIR = tmp

const HUMAN = 'enrique'
const AGENT = 'claude'

let dbm: typeof import('#/db')
let features: typeof import('./features')
let needs: typeof import('./needs')
let stages: typeof import('./stages')
let handle: (request: Request) => Promise<Response>
beforeAll(async () => {
  dbm = await import('#/db')
  features = await import('./features')
  needs = await import('./needs')
  stages = await import('./stages')
  ;(await import('./actors')).noteActor(HUMAN, 'human')
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  // As the server answers: an HttpError becomes its status with `{error}`. A bearer token is an agent.
  const guarded = guard(({ request }: { request: Request }) =>
    api.handle(request, request.headers.has('authorization') ? AGENT : HUMAN),
  )
  handle = (request) => guarded({ request })
})

async function call(method: string, pathname: string, body?: unknown, as: 'human' | 'agent' = 'agent') {
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
/** An MCP tool call as the agent: its parsed result, or `{error}` with the message of a refused call. */
async function tool(name: string, args: Record<string, unknown>) {
  const { handleMcp } = await import('./mcp')
  const res = await handleMcp(
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer gate_test',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }),
    AGENT,
  )
  const result = ((await res.json()) as { result: any }).result as {
    isError?: boolean
    content: { text: string }[]
  }
  return result.isError ? { error: result.content[0]!.text } : JSON.parse(result.content[0]!.text)
}

let projects = 0
/** A project with the default stages and an active "Bug Found" stage before In progress. */
function bugFoundProject() {
  const name = `work-stage-${++projects}`
  const pid = dbm.db.insert(dbm.schema.projects).values({ name }).returning().get().id
  dbm.db
    .insert(dbm.schema.repos)
    .values({ projectId: pid, name: 'app', repoPath: `/r/${name}` })
    .run()
  const bug = stages.createStage(pid, { name: 'Bug Found', kind: 'active' }, HUMAN)
  const ids = stages.listStages(pid).map((s) => s.id)
  const order = ids.filter((id) => id !== bug.id)
  order.splice(order.indexOf(stages.listStages(pid).find((s) => s.key === 'in_progress')!.id), 0, bug.id)
  stages.reorderStages(pid, order, HUMAN)
  return pid
}
const setWorkStage = (pid: number, workStage: string | null) =>
  call('PATCH', `/api/projects/${pid}`, { workStage }, 'human')

describe('where work starts', () => {
  it('is the first active stage until the project chooses one', async () => {
    const pid = bugFoundProject()
    expect(stages.listStages(pid).map((s) => s.key)).toEqual([
      'backlog',
      'todo',
      'bug_found',
      'in_progress',
      'blocked',
      'review',
      'done',
      'cancelled',
    ])
    expect((await call('GET', `/api/projects/${pid}`)).body.workStage).toBeNull()
    const t = features.createTicket(pid, { title: 'claimed' }, HUMAN)
    expect(features.claimTicket(t.id, AGENT).status).toBe('bug_found')
    expect(features.createTicket(pid, { title: 'active', status: 'active' }, AGENT).status).toBe('bug_found')
  })

  it('takes claims and in_progress / active to the stage the project chose', async () => {
    const pid = bugFoundProject()
    const saved = await setWorkStage(pid, 'in_progress')
    expect(saved).toMatchObject({ status: 200, body: { workStage: 'in_progress' } })
    expect((await tool('get_project', { projectId: pid })).workStage).toBe('in_progress')

    const t = features.createTicket(pid, { title: 'claimed' }, HUMAN)
    expect((await tool('claim_ticket', { ticketId: t.id, branch: 'fix-it' })).status).toBe('in_progress')
    // From blocked too, as before.
    const b = features.createTicket(pid, { title: 'blocked', status: 'blocked' }, HUMAN)
    expect(features.claimTicket(b.id, AGENT).status).toBe('in_progress')

    for (const status of ['active', 'ACTIVE', 'in_progress'])
      expect(features.createTicket(pid, { title: status, status }, AGENT).status).toBe('in_progress')
    const moved = features.createTicket(pid, { title: 'moved' }, HUMAN)
    expect((await tool('update_ticket', { ticketId: moved.id, status: 'active' })).status).toBe('in_progress')
    expect((await needs.changeTicket(moved.id, { status: 'todo' }, HUMAN, { agent: false })).status).toBe(
      'todo',
    )
    expect((await needs.changeTicket(moved.id, { status: 'active' }, HUMAN, { agent: false })).status).toBe(
      'in_progress',
    )
    // Naming the stage itself still lands there.
    expect(features.updateTicket(moved.id, { status: 'Bug Found' }, AGENT).status).toBe('bug_found')
    expect(features.updateTicket(moved.id, { status: 'bug_found' }, AGENT).status).toBe('bug_found')
    // Other kinds keep the first stage of their kind, and open the start stage.
    expect(features.updateTicket(moved.id, { status: 'open' }, AGENT).status).toBe('todo')
    expect(features.updateTicket(moved.id, { status: 'review' }, AGENT).status).toBe('review')
  })

  it('is where a blocked ticket goes back once its last decision is answered', async () => {
    const pid = bugFoundProject()
    await setWorkStage(pid, 'in_progress')
    const t = features.createTicket(pid, { title: 'asks' }, HUMAN)
    features.claimTicket(t.id, AGENT)
    const card = features.askDecision(
      t.id,
      { body: 'Which?', options: [{ label: 'A' }, { label: 'B' }] },
      AGENT,
    )
    expect(features.getTicket(t.id).status).toBe('blocked')
    features.decide(card.id, 0, '', HUMAN)
    expect(features.getTicket(t.id).status).toBe('in_progress')
  })

  it('falls back to the first active stage when the chosen one is gone or no longer active', async () => {
    const pid = bugFoundProject()
    await setWorkStage(pid, 'in_progress')
    const inProgress = stages.listStages(pid).find((s) => s.key === 'in_progress')!
    stages.updateStage(pid, inProgress.id, { kind: 'review' }, HUMAN)
    const t = features.createTicket(pid, { title: 'claimed' }, HUMAN)
    expect(features.claimTicket(t.id, AGENT).status).toBe('bug_found')
    stages.updateStage(pid, inProgress.id, { kind: 'active' }, HUMAN)
    const u = features.createTicket(pid, { title: 'again' }, HUMAN)
    expect(features.claimTicket(u.id, AGENT).status).toBe('in_progress')
    stages.deleteStage(pid, inProgress.id, { moveTo: 'bug_found' }, HUMAN)
    const v = features.createTicket(pid, { title: 'gone' }, HUMAN)
    expect(features.claimTicket(v.id, AGENT).status).toBe('bug_found')
  })

  it('is set by the human alone, to an active stage of the project or null', async () => {
    const pid = bugFoundProject()
    expect(await call('PATCH', `/api/projects/${pid}`, { workStage: 'in_progress' })).toEqual({
      status: 403,
      body: { error: 'only the human sets the stage work starts in' },
    })
    for (const bad of ['todo', 'review', 'nowhere']) {
      const res = await setWorkStage(pid, bad)
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/^workStage: .* is not an active stage of this project/)
    }
    expect((await setWorkStage(pid, '')).status).toBe(400)
    expect((await setWorkStage(pid, 'bug_found')).body.workStage).toBe('bug_found')
    expect((await setWorkStage(pid, null)).body.workStage).toBeNull()
    expect((await call('GET', `/api/projects/${pid}`)).body.workStage).toBeNull()
  })
})
