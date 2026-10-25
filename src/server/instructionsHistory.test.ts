import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-instructions-'))
process.env.DATA_DIR = tmp
process.env.BOARD_ENV = 'test'

let dbm: typeof import('#/db')
let history: typeof import('./instructionsHistory')
let projects: typeof import('./projects')
let send: (method: string, target: string, testActor?: string, body?: unknown) => Promise<Response>
let sendWith: (
  method: string,
  target: string,
  testActor: string | undefined,
  extra: Record<string, string>,
  body?: unknown,
) => Promise<Response>
beforeAll(async () => {
  dbm = await import('#/db')
  history = await import('./instructionsHistory')
  projects = await import('./projects')
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  const { callerOf } = await import('./auth')
  const handle = guard(({ request, actor }: { request: Request; actor: string }) =>
    api.handle(request, actor),
  )
  // As the middleware hands a request on in test mode: who calls is X-Test-Actor (none: the human).
  send = (method, target, testActor, body) => sendWith(method, target, testActor, {}, body)
  sendWith = async (method, target, testActor, extra, body) => {
    const headers: Record<string, string> = { accept: 'application/json', ...extra }
    if (testActor !== undefined) headers['x-test-actor'] = testActor
    if (body !== undefined) headers['content-type'] = 'application/json'
    const request = new Request(`http://localhost${target}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const caller = await callerOf(request)
    return handle({ request, actor: caller!.name })
  }
})

const HUMAN = { name: 'enrique', role: 'human' } as const
const ORCH = { name: 'orch', role: 'orchestrator' } as const
const WORKER = { name: 'w', role: 'worker' } as const

let made = 0
const newProject = (instructions = 'v0') =>
  dbm.db
    .insert(dbm.schema.projects)
    .values({ name: `instructions ${++made}`, instructions })
    .returning()
    .get().id
const textOf = (p: number) => projects.getProject(p).instructions
const rowsOf = (p: number) =>
  dbm.db
    .select()
    .from(dbm.schema.projectInstructionChanges)
    .where(eq(dbm.schema.projectInstructionChanges.projectId, p))
    .all()
const linesOf = (p: number) =>
  dbm.db
    .select()
    .from(dbm.schema.activity)
    .where(and(eq(dbm.schema.activity.projectId, p), eq(dbm.schema.activity.refType, 'instruction-change')))
    .all()
const json = async <T = any>(res: Response | Promise<Response>) => (await res).json() as Promise<T>

describe('setInstructions', () => {
  it("applies an orchestrator's change at once, kept pending with old and new text, actor and role", () => {
    const p = newProject('first')
    const { instructions, change } = history.setInstructions(p, 'second', ORCH)
    expect(instructions).toBe('second')
    expect(textOf(p)).toBe('second')
    expect(change).toMatchObject({
      projectId: p,
      oldValue: 'first',
      newValue: 'second',
      changedBy: 'orch',
      role: 'orchestrator',
      state: 'pending',
      resolvedBy: '',
      resolvedAt: null,
      revertOf: null,
    })
    expect(linesOf(p)).toMatchObject([
      { actor: 'orch', kind: 'project', text: 'changed the project instructions', refId: change!.id },
    ])
  })

  it("keeps the human's change accepted, and the same text again records nothing", () => {
    const p = newProject('a')
    expect(history.setInstructions(p, 'b', HUMAN).change).toMatchObject({ role: 'human', state: 'accepted' })
    expect(history.setInstructions(p, 'b', HUMAN)).toEqual({ instructions: 'b', change: null })
    expect(history.setInstructions(p, 'b', ORCH)).toEqual({ instructions: 'b', change: null })
    expect(rowsOf(p)).toHaveLength(1)
    expect(linesOf(p)).toHaveLength(1)
  })

  it('refuses a worker, a sub-identity under an orchestrator token too: nothing changes', () => {
    const p = newProject('kept')
    for (const who of [WORKER, { name: 'orch/worker-1', role: 'worker' as const }]) {
      expect(() => history.setInstructions(p, 'taken over', who)).toThrow(
        `only an orchestrator or the human changes the project's instructions: ask your orchestrator (you are ${who.name}, a worker)`,
      )
    }
    expect(textOf(p)).toBe('kept')
    expect(rowsOf(p)).toEqual([])
    expect(linesOf(p)).toEqual([])
  })

  it('404s an unknown project', () => {
    expect(() => history.setInstructions(999_999, 'x', HUMAN)).toThrow('project not found')
  })
})

describe('review and revert', () => {
  it('review accepts a pending change, idempotent, and is refused on a reverted one', () => {
    const p = newProject()
    const { change } = history.setInstructions(p, 'v1', ORCH)
    const reviewed = history.reviewInstructionChange(change!.id, 'enrique')
    expect(reviewed).toMatchObject({
      state: 'accepted',
      resolvedBy: 'enrique',
      resolvedAt: expect.any(String),
    })
    expect(history.reviewInstructionChange(change!.id, 'someone')).toEqual(reviewed)

    const other = history.setInstructions(p, 'v2', ORCH).change!
    history.revertInstructionChange(other.id, 'enrique')
    expect(() => history.reviewInstructionChange(other.id, 'enrique')).toThrow('this change was reverted')
  })

  it("puts the text back and records the revert as the human's own change pointing at it", () => {
    const p = newProject('v0')
    const change = history.setInstructions(p, 'v1', ORCH).change!
    const { change: reverted, revert, instructions } = history.revertInstructionChange(change.id, 'enrique')
    expect(instructions).toBe('v0')
    expect(textOf(p)).toBe('v0')
    expect(reverted).toMatchObject({ id: change.id, state: 'reverted', resolvedBy: 'enrique' })
    expect(revert).toMatchObject({
      oldValue: 'v1',
      newValue: 'v0',
      changedBy: 'enrique',
      role: 'human',
      state: 'accepted',
      revertOf: change.id,
    })
    expect(rowsOf(p)).toHaveLength(2)
    expect(linesOf(p).map((l) => l.text)).toEqual([
      'changed the project instructions',
      "reverted orch's change of the project instructions",
    ])
    expect(() => history.revertInstructionChange(change.id, 'enrique')).toThrow(
      'this change was already reverted',
    )
  })

  it('refuses a revert while a later change stands, or once the text is something else', () => {
    const p = newProject('v0')
    const first = history.setInstructions(p, 'v1', ORCH).change!
    const second = history.setInstructions(p, 'v2', HUMAN).change!
    expect(() => history.revertInstructionChange(first.id, 'enrique')).toThrow(/changed again since/)
    expect(history.pendingInstructionChanges(p)).toMatchObject([{ id: first.id, revertable: false }])
    // Undone newest first: the later one, then the first.
    history.revertInstructionChange(second.id, 'enrique')
    expect(history.pendingInstructionChanges(p)).toMatchObject([{ id: first.id, revertable: true }])
    history.revertInstructionChange(first.id, 'enrique')
    expect(textOf(p)).toBe('v0')

    // The text set some other way (a project created later, a write outside the history).
    const q = newProject('v0')
    const change = history.setInstructions(q, 'v1', ORCH).change!
    dbm.db
      .update(dbm.schema.projects)
      .set({ instructions: 'elsewhere' })
      .where(eq(dbm.schema.projects.id, q))
      .run()
    expect(() => history.revertInstructionChange(change.id, 'enrique')).toThrow(/changed again since/)
    expect(textOf(q)).toBe('elsewhere')
  })

  it('lists the changes newest first, and 404s an unknown one', () => {
    const p = newProject('v0')
    const ids = ['v1', 'v2', 'v3'].map((v) => history.setInstructions(p, v, ORCH).change!.id)
    expect(history.listInstructionChanges(p).map((c) => c.id)).toEqual([...ids].reverse())
    // Only the newest standing one can be reverted now.
    expect(history.listInstructionChanges(p).map((c) => c.revertable)).toEqual([true, false, false])
    history.revertInstructionChange(ids[2]!, 'enrique')
    expect(history.listInstructionChanges(p).map((c) => [c.newValue, c.state, c.revertable])).toEqual([
      // The revert's own record can be reverted too: that puts v3 back.
      ['v2', 'accepted', true],
      ['v3', 'reverted', false],
      ['v2', 'pending', true],
      ['v1', 'pending', false],
    ])
    expect(history.getInstructionChange(ids[0]!)).toMatchObject({ newValue: 'v1' })
    expect(() => history.getInstructionChange(999_999)).toThrow('no instructions change 999999')
  })
})

describe('updateProject', () => {
  it('records an instructions patch as setInstructions does, and refuses a worker the whole patch', () => {
    const p = newProject('v0')
    projects.updateProject(p, { instructions: 'v1', name: 'renamed' }, 'enrique', HUMAN)
    expect(projects.getProject(p)).toMatchObject({ instructions: 'v1', name: 'renamed' })
    expect(rowsOf(p)).toMatchObject([{ oldValue: 'v0', newValue: 'v1', role: 'human', state: 'accepted' }])

    expect(() => projects.updateProject(p, { instructions: 'v2', name: 'worker' }, 'w', WORKER)).toThrow(
      /ask your orchestrator/,
    )
    // Without a role the caller is taken for a worker.
    expect(() => projects.updateProject(p, { instructions: 'v2' }, 'w')).toThrow(/ask your orchestrator/)
    expect(projects.getProject(p)).toMatchObject({ instructions: 'v1', name: 'renamed' })
    // The rest of a project's settings stay open to a worker.
    projects.updateProject(p, { name: 'by worker' }, 'w', WORKER)
    expect(projects.getProject(p).name).toBe('by worker')
  })
})

describe('through the API router (test mode)', () => {
  it('PUT /api/projects/:id/instructions: the human and an orchestrator, never a worker', async () => {
    const p = newProject('v0')
    const target = `/api/projects/${p}/instructions`
    const human = await send('PUT', target, 'human:enrique', { instructions: 'by human' })
    expect(human.status).toBe(200)
    expect(await human.json()).toMatchObject({ instructions: 'by human', change: { role: 'human' } })
    const orch = await send('PUT', target, 'orchestrator:orch', { instructions: 'by orch' })
    expect(orch.status).toBe(200)
    expect(await orch.json()).toMatchObject({
      instructions: 'by orch',
      change: { changedBy: 'orch', role: 'orchestrator', state: 'pending' },
    })
    const worker = await send('PUT', target, 'agent:w', { instructions: 'by worker' })
    expect(worker.status).toBe(403)
    expect(await worker.json()).toEqual({
      error:
        "only an orchestrator or the human changes the project's instructions: ask your orchestrator (you are w, a worker)",
    })
    expect(textOf(p)).toBe('by orch')
    expect(rowsOf(p)).toHaveLength(2)
  })

  it('PATCH /api/projects/:id with instructions follows the same rules; name alone stays open', async () => {
    const p = newProject('v0')
    const target = `/api/projects/${p}`
    expect((await send('PATCH', target, 'agent:w', { instructions: 'x' })).status).toBe(403)
    expect((await send('PATCH', target, 'agent:w', { instructions: 'x', name: 'n' })).status).toBe(403)
    expect(projects.getProject(p).name).toBe(`instructions ${made}`)
    expect((await send('PATCH', target, 'agent:w', { name: 'worker named it' })).status).toBe(200)
    expect((await send('PATCH', target, 'agent:w', { tagSuggestions: ['Auth'] })).status).toBe(200)
    expect((await send('PATCH', target, 'orchestrator:orch', { instructions: 'orch' })).status).toBe(200)
    expect((await send('PATCH', target, undefined, { instructions: 'human' })).status).toBe(200)
    expect(rowsOf(p).map((r) => [r.changedBy, r.role, r.state])).toEqual([
      ['orch', 'orchestrator', 'pending'],
      ['human', 'human', 'accepted'],
    ])
    expect(projects.getProject(p)).toMatchObject({ name: 'worker named it', instructions: 'human' })
  })

  it("lists and reads changes; review and revert are the human's alone", async () => {
    const p = newProject('v0')
    await send('PUT', `/api/projects/${p}/instructions`, 'orchestrator:orch', { instructions: 'v1' })
    await send('PUT', `/api/projects/${p}/instructions`, 'orchestrator:orch', { instructions: 'v2' })
    const list = await json<any[]>(send('GET', `/api/projects/${p}/instructions/changes`, 'agent:w'))
    expect(list.map((c) => c.newValue)).toEqual(['v2', 'v1'])
    const [second, first] = list
    expect(await json(send('GET', `/api/instructions/changes/${first.id}`, 'agent:w'))).toMatchObject({
      newValue: 'v1',
    })
    expect((await send('GET', '/api/instructions/changes/999999')).status).toBe(404)

    for (const actor of ['agent:w', 'orchestrator:orch'])
      for (const action of ['review', 'revert']) {
        const res = await send('POST', `/api/instructions/changes/${second.id}/${action}`, actor)
        expect(res.status, `${actor} ${action}`).toBe(403)
      }
    expect(textOf(p)).toBe('v2')

    expect((await send('POST', `/api/instructions/changes/${first.id}/revert`)).status).toBe(409)
    const reviewed = await send('POST', `/api/instructions/changes/${first.id}/review`)
    expect(await reviewed.json()).toMatchObject({ state: 'accepted', resolvedBy: 'human' })
    const reverted = await send('POST', `/api/instructions/changes/${second.id}/revert`)
    expect(reverted.status).toBe(200)
    expect(await reverted.json()).toMatchObject({
      instructions: 'v1',
      change: { id: second.id, state: 'reverted' },
      revert: { revertOf: second.id, changedBy: 'human', role: 'human', state: 'accepted' },
    })
    expect((await send('POST', `/api/instructions/changes/${second.id}/revert`)).status).toBe(409)
    expect((await send('POST', `/api/instructions/changes/${second.id}/review`)).status).toBe(409)
    expect(textOf(p)).toBe('v1')
  })
})

describe('a new project with instructions', () => {
  const REFUSAL =
    "only an orchestrator or the human changes the project's instructions: ask your orchestrator (you are w, a worker)"
  const named = (prefix: string) => {
    const name = `${prefix} ${++made}`
    const p = () => projects.listProjects().find((row) => row.name === name)
    return { name, p }
  }

  it('createProject: their first change from nothing, pending for an orchestrator; a worker makes nothing', async () => {
    const { getSummary } = await import('./summary')
    const orch = projects.createProject({ name: `by orch ${++made}`, instructions: 'rules' }, 'orch', ORCH)
    expect(orch.instructions).toBe('rules')
    expect(textOf(orch.id)).toBe('rules')
    expect(rowsOf(orch.id)).toMatchObject([
      { oldValue: '', newValue: 'rules', changedBy: 'orch', role: 'orchestrator', state: 'pending' },
    ])
    expect(linesOf(orch.id)).toHaveLength(1)
    const [summary] = getSummary(orch.id).projects
    expect(summary!.needsYou.instructionChanges).toMatchObject([
      { changeId: rowsOf(orch.id)[0]!.id, changedBy: 'orch', role: 'orchestrator', excerpt: 'rules' },
    ])

    const human = projects.createProject({ name: `by human ${++made}`, instructions: 'h' }, 'enrique', HUMAN)
    expect(rowsOf(human.id)).toMatchObject([
      { oldValue: '', newValue: 'h', role: 'human', state: 'accepted' },
    ])
    expect(getSummary(human.id).projects[0]!.needsYou.instructionChanges).toEqual([])

    const before = projects.listProjects().length
    expect(() => projects.createProject({ name: 'by worker', instructions: 'x' }, 'w', WORKER)).toThrow(
      REFUSAL,
    )
    // Without a role the caller is taken for a worker.
    expect(() => projects.createProject({ name: 'by nobody', instructions: 'x' }, 'w')).toThrow(REFUSAL)
    expect(projects.listProjects()).toHaveLength(before)
    // Without instructions it stays open to anyone, and records no change.
    const plain = projects.createProject({ name: `plain ${++made}`, instructions: '' }, 'w', WORKER)
    expect(plain.instructions).toBe('')
    expect(rowsOf(plain.id)).toEqual([])
  })

  it('POST /api/projects: a worker, a sub-identity too, gets the same 403; an orchestrator and the human make it', async () => {
    for (const [actor, headers] of [
      ['agent:w', {}],
      ['orchestrator:orch', { 'x-agent-name': 'orch/w' }],
    ] as const) {
      const { name, p } = named('refused')
      const res = await sendWith('POST', '/api/projects', actor, headers, { name, instructions: 'x' })
      expect(res.status, actor).toBe(403)
      const who = 'x-agent-name' in headers ? 'orch/w' : 'w'
      expect(await res.json()).toEqual({ error: REFUSAL.replace('you are w,', `you are ${who},`) })
      expect(p()).toBeUndefined()
    }

    const orch = named('orch made')
    const made1 = await send('POST', '/api/projects', 'orchestrator:orch', {
      name: orch.name,
      instructions: 'o',
    })
    expect(made1.status).toBe(201)
    expect(await made1.json()).toMatchObject({ name: orch.name, instructions: 'o' })
    expect(rowsOf(orch.p()!.id)).toMatchObject([
      { oldValue: '', newValue: 'o', role: 'orchestrator', state: 'pending' },
    ])

    const human = named('human made')
    expect(
      (await send('POST', '/api/projects', 'human:enrique', { name: human.name, instructions: 'h' })).status,
    ).toBe(201)
    expect(rowsOf(human.p()!.id)).toMatchObject([{ changedBy: 'enrique', role: 'human', state: 'accepted' }])

    // Empty instructions, or none: open to a worker, as before.
    for (const body of [{ instructions: '' }, {}]) {
      const plain = named('worker made')
      const res = await send('POST', '/api/projects', 'agent:w', { name: plain.name, ...body })
      expect(res.status).toBe(201)
      expect(rowsOf(plain.p()!.id)).toEqual([])
    }
  })
})

describe('moving a repo to another project', () => {
  const newRepo = (projectId: number) =>
    dbm.db
      .insert(dbm.schema.repos)
      .values({ projectId, name: `repo ${++made}`, repoPath: path.join(tmp, `repo-${made}`) })
      .returning()
      .get().id
  const projectOf = (repo: number) =>
    dbm.db.select().from(dbm.schema.repos).where(eq(dbm.schema.repos.id, repo)).get()!.projectId

  it('PATCH /api/repos/:id with another projectId: an orchestrator and the human, never a worker', async () => {
    const from = newProject('from')
    const to = newProject('to')
    const repo = newRepo(from)
    for (const [actor, headers, who] of [
      ['agent:w', {}, 'w'],
      ['orchestrator:orch', { 'x-agent-name': 'orch/w' }, 'orch/w'],
    ] as const) {
      const res = await sendWith('PATCH', `/api/repos/${repo}`, actor, headers, {
        projectId: to,
        name: 'moved',
      })
      expect(res.status, actor).toBe(403)
      expect(await res.json()).toEqual({
        error: `only an orchestrator or the human moves a repo to another project: ask your orchestrator or the human (you are ${who}, a worker)`,
      })
      expect(projectOf(repo)).toBe(from)
    }
    // The rest of a repo's patch stays open to a worker, its own projectId again included.
    expect(
      (await send('PATCH', `/api/repos/${repo}`, 'agent:w', { name: 'renamed', projectId: from })).status,
    ).toBe(200)

    expect((await send('PATCH', `/api/repos/${repo}`, 'orchestrator:orch', { projectId: to })).status).toBe(
      200,
    )
    expect(projectOf(repo)).toBe(to)
    expect((await send('PATCH', `/api/repos/${repo}`, 'human:enrique', { projectId: from })).status).toBe(200)
    expect(projectOf(repo)).toBe(from)
  })
})

describe('with no caller remembered for the request', () => {
  it('callerInfo takes an agent request for a worker, a non-agent one for the human', async () => {
    const { callerInfo } = await import('./auth')
    const { api } = await import('./api')
    const { api: guard } = await import('./http')
    const handle = guard(({ request, actor }: { request: Request; actor: string }) =>
      api.handle(request, actor),
    )
    // Straight to the router, never through callerOf: nothing remembers who calls.
    const raw = (testActor: string | null, instructions: string) => {
      const headers: Record<string, string> = {
        accept: 'application/json',
        'content-type': 'application/json',
      }
      if (testActor) headers['x-test-actor'] = testActor
      return new Request(`http://localhost/api/projects/${p}/instructions`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ instructions }),
      })
    }
    const p = newProject('v0')
    for (const actor of ['agent:w', 'orchestrator:orch']) {
      expect(callerInfo(raw(actor, 'x'), 'w')).toMatchObject({ name: 'w', kind: 'agent', role: 'worker' })
      const res = await handle({ request: raw(actor, 'x'), actor: 'w' })
      expect(res.status, actor).toBe(403)
      // The route asks callerInfo without a name: with none remembered either, it is 'unknown'.
      expect(await res.json()).toEqual({
        error:
          "only an orchestrator or the human changes the project's instructions: ask your orchestrator (you are unknown, a worker)",
      })
    }
    expect(textOf(p)).toBe('v0')
    expect(callerInfo(raw(null, 'y'), 'enrique')).toMatchObject({ name: 'enrique', role: 'human' })
    expect((await handle({ request: raw(null, 'y'), actor: 'enrique' })).status).toBe(200)
    expect(rowsOf(p)).toMatchObject([{ changedBy: 'unknown', role: 'human', state: 'accepted' }])
  })
})
