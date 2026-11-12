import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
// Test mode: who calls is X-Test-Actor, as Playwright and CI drive it (human, worker, orchestrator).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-notes-'))
process.env.DATA_DIR = tmp
process.env.BOARD_ENV = 'test'

let dbm: typeof import('#/db')
let serve: (request: Request) => Promise<Response>
beforeAll(async () => {
  dbm = await import('#/db')
  const { admit, rememberActor } = await import('./auth')
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  const handle = guard(({ request, actor }: { request: Request; actor: string }) =>
    api.handle(request, actor),
  )
  serve = async (request) => {
    const admission = await admit(request, new URL(request.url).pathname)
    if (admission.kind === 'refuse') return admission.response
    if (admission.kind === 'page') throw new Error('an API call got a page')
    if (admission.kind === 'actor') rememberActor(request, admission.caller)
    return handle({ request, actor: admission.kind === 'actor' ? admission.actor : 'unknown' })
  }
  // Loading the whole API router takes a while on a cold transform, as in the other server tests.
}, 60_000)

type As = 'human' | 'agent' | 'orchestrator'
const actorHeader = (as: As, name: string) => `${as}:${name}`

async function call(method: string, pathname: string, body?: unknown, as: As = 'human', name = 'tester') {
  const res = await serve(
    new Request(`http://localhost:47101${pathname}`, {
      method,
      headers: {
        host: 'localhost:47101',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        'x-test-actor': actorHeader(as, name),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : null) as any }
}

let rpcId = 0
async function rpc(method: string, params: Record<string, unknown> = {}, as: As = 'human', name = 'tester') {
  const res = await serve(
    new Request('http://localhost:47101/api/mcp', {
      method: 'POST',
      headers: {
        host: 'localhost:47101',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-test-actor': actorHeader(as, name),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    }),
  )
  return ((await res.json()) as { result: any }).result
}

async function tool(name: string, args: Record<string, unknown>, as: As = 'agent', actor = 'worker-a') {
  const result = (await rpc('tools/call', { name, arguments: args }, as, actor)) as {
    isError?: boolean
    content: { text: string }[]
  }
  expect(result.isError, result.content[0]!.text).toBeFalsy()
  return JSON.parse(result.content[0]!.text)
}

function newProject(name: string) {
  return dbm.db.insert(dbm.schema.projects).values({ name }).returning().get().id
}

const notesOf = (projectId: number) =>
  dbm.db.select().from(dbm.schema.projectNotes).where(eq(dbm.schema.projectNotes.projectId, projectId)).all()

const create = async (projectId: number, label: string, body: string, as: As = 'human', name = 'tester') =>
  call('POST', `/api/projects/${projectId}/notes`, { label, body }, as, name)

describe("a project's notes", () => {
  it('are created, listed, changed and deleted, with the author and a later updatedAt', async () => {
    const p = newProject('crud')
    const made = await create(p, 'Release command', 'pnpm release 0.2.5')
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    expect(made.body).toMatchObject({
      projectId: p,
      label: 'Release command',
      body: 'pnpm release 0.2.5',
      createdBy: 'tester',
      position: 0,
    })
    expect(made.body.id).toBeGreaterThan(0)
    expect(made.body.createdAt).toBeTruthy()
    expect(made.body.updatedAt).toBeTruthy()

    const listed = await call('GET', `/api/projects/${p}/notes`)
    expect(listed.status).toBe(200)
    expect(listed.body).toHaveLength(1)
    expect(listed.body[0].id).toBe(made.body.id)
    // The project itself carries them, as get_project does.
    expect((await call('GET', `/api/projects/${p}`)).body.notes.map((n: { id: number }) => n.id)).toEqual([
      made.body.id,
    ])
    expect((await call('GET', `/api/projects/${p}/notes`)).body).toHaveLength(1)

    const changed = await call('PATCH', `/api/projects/${p}/notes/${made.body.id}`, {
      label: 'Release command (dev)',
      body: 'pnpm release 0.2.5 --dev',
    })
    expect(changed.status, JSON.stringify(changed.body)).toBe(200)
    expect(changed.body).toMatchObject({
      label: 'Release command (dev)',
      body: 'pnpm release 0.2.5 --dev',
      createdBy: 'tester',
    })
    expect(Date.parse(changed.body.updatedAt)).toBeGreaterThan(Date.parse(made.body.updatedAt))

    const deleted = await call('DELETE', `/api/projects/${p}/notes/${made.body.id}`)
    expect(deleted.status).toBe(200)
    expect((await call('GET', `/api/projects/${p}/notes`)).body).toEqual([])
    expect((await tool('get_project', { projectId: p })).notes).toEqual([])

    expect((await call('PATCH', `/api/projects/${p}/notes/999999`, { label: 'x' })).status).toBe(404)
    expect((await call('DELETE', `/api/projects/${p}/notes/999999`)).status).toBe(404)
  })

  it('keeps label to 60 and body to 500 characters, trimmed, and writes nothing on a failure', async () => {
    const p = newProject('limits')
    const label60 = 'l'.repeat(60)
    const body500 = 'b'.repeat(500)
    const long = await create(p, ` ${label60} `, ` ${body500} `)
    expect(long.status, JSON.stringify(long.body)).toBe(201)
    expect(long.body.label).toBe(label60)
    expect(long.body.body).toBe(body500)

    for (const [input, error] of [
      [{ label: 'x'.repeat(61), body: 'ok' }, /label.*60/i],
      [{ label: 'ok', body: 'x'.repeat(501) }, /body.*500/i],
      [{ label: '   ', body: 'ok' }, /label.*60/i],
      [{ label: 'ok', body: '\n\t ' }, /body.*500/i],
    ] as const) {
      const res = await call('POST', `/api/projects/${p}/notes`, input)
      expect(res.status, JSON.stringify(input)).toBe(400)
      expect(res.body.error).toMatch(error)
    }
    expect(notesOf(p)).toHaveLength(1)

    // A refused PATCH leaves the note as it was.
    const refused = await call('PATCH', `/api/projects/${p}/notes/${long.body.id}`, {
      label: 'changed',
      body: 'x'.repeat(501),
    })
    expect(refused.status).toBe(400)
    expect(refused.body.error).toMatch(/body.*500/i)
    const [unchanged] = (await call('GET', `/api/projects/${p}/notes`)).body
    expect(unchanged.label).toBe(label60)
    expect(unchanged.body).toBe(body500)
  })

  it('are project-scoped everywhere, and go with their project', async () => {
    const a = newProject('scope-a')
    const b = newProject('scope-b')
    const made = await create(a, 'Only A', 'a fact for A')
    expect(made.status).toBe(201)
    expect((await call('GET', `/api/projects/${b}/notes`)).body).toEqual([])
    expect((await tool('get_project', { projectId: b })).notes).toEqual([])
    expect((await tool('list_notes', { projectId: b })).length).toBe(0)
    expect(
      (await tool('get_project', { projectId: a })).notes.map((n: { label: string }) => n.label),
    ).toEqual(['Only A'])
    expect((await tool('list_notes', { projectId: a })).map((n: { label: string }) => n.label)).toEqual([
      'Only A',
    ])
    // A note is not reachable through another project's route.
    expect((await call('PATCH', `/api/projects/${b}/notes/${made.body.id}`, { label: 'x' })).status).toBe(404)
    expect((await call('DELETE', `/api/projects/${b}/notes/${made.body.id}`)).status).toBe(404)

    dbm.db.delete(dbm.schema.projects).where(eq(dbm.schema.projects.id, a)).run()
    expect(notesOf(a)).toEqual([])
  })

  it('let any agent add one, but only its author, an orchestrator or the human change or delete it', async () => {
    const p = newProject('permissions')
    const made = await create(p, 'Mine', 'learned by worker-a', 'agent', 'worker-a')
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    expect(made.body.createdBy).toBe('worker-a')

    const other = await call(
      'PATCH',
      `/api/projects/${p}/notes/${made.body.id}`,
      { body: 'hijacked' },
      'agent',
      'worker-b',
    )
    expect(other.status).toBe(403)
    expect(
      (await call('DELETE', `/api/projects/${p}/notes/${made.body.id}`, undefined, 'agent', 'worker-b'))
        .status,
    ).toBe(403)
    expect((await call('GET', `/api/projects/${p}/notes`)).body[0].body).toBe('learned by worker-a')

    expect(
      (
        await call(
          'PATCH',
          `/api/projects/${p}/notes/${made.body.id}`,
          { body: 'mine now' },
          'agent',
          'worker-a',
        )
      ).status,
    ).toBe(200)
    expect(
      (
        await call(
          'PATCH',
          `/api/projects/${p}/notes/${made.body.id}`,
          { body: 'orchestrator edit' },
          'orchestrator',
          'orch',
        )
      ).status,
    ).toBe(200)
    expect(
      (
        await call(
          'PATCH',
          `/api/projects/${p}/notes/${made.body.id}`,
          { body: 'human edit' },
          'human',
          'enrique',
        )
      ).status,
    ).toBe(200)
    expect(
      (await call('DELETE', `/api/projects/${p}/notes/${made.body.id}`, undefined, 'orchestrator', 'orch'))
        .status,
    ).toBe(200)
    expect((await call('GET', `/api/projects/${p}/notes`)).body).toEqual([])
  })

  it('come in position order, a pinned note first and an unpinned one back after the rest, over REST and MCP', async () => {
    const p = newProject('order')
    const first = await create(p, 'First', 'one')
    const second = await create(p, 'Second', 'two')
    const third = await create(p, 'Third', 'three')
    expect([first.body.position, second.body.position, third.body.position]).toEqual([0, 1, 2])
    const labels = async () =>
      (await call('GET', `/api/projects/${p}/notes`)).body.map((n: { label: string }) => n.label)
    expect(await labels()).toEqual(['First', 'Second', 'Third'])

    const pinned = await call('PATCH', `/api/projects/${p}/notes/${third.body.id}`, { pinned: true })
    expect(pinned.status).toBe(200)
    expect(pinned.body.position).toBeLessThan(0)
    expect(await labels()).toEqual(['Third', 'First', 'Second'])
    expect((await tool('list_notes', { projectId: p })).map((n: { label: string }) => n.label)).toEqual([
      'Third',
      'First',
      'Second',
    ])
    expect(
      (await tool('get_project', { projectId: p })).notes.map((n: { label: string }) => n.label),
    ).toEqual(['Third', 'First', 'Second'])

    const unpinned = await call('PATCH', `/api/projects/${p}/notes/${third.body.id}`, { pinned: false })
    expect(unpinned.body.position).toBe(2)
    expect(await labels()).toEqual(['First', 'Second', 'Third'])
    // The MCP tool pins and unpins the same way.
    await tool('update_note', { projectId: p, noteId: second.body.id, pinned: true }, 'orchestrator', 'orch')
    expect(await labels()).toEqual(['Second', 'First', 'Third'])
    await tool('update_note', { projectId: p, noteId: second.body.id, pinned: false }, 'orchestrator', 'orch')
    expect(await labels()).toEqual(['First', 'Third', 'Second'])
  })

  it('are the MCP tools list_notes, add_note, update_note and delete_note, and an added note shows in get_project', async () => {
    const p = newProject('mcp')
    const tools = ((await rpc('tools/list')).tools as { name: string }[]).map((t) => t.name)
    for (const name of ['list_notes', 'add_note', 'update_note', 'delete_note']) expect(tools).toContain(name)

    const added = await tool('add_note', {
      projectId: p,
      label: 'Migrations',
      body: 'run on startup; never hand-edit drizzle/meta',
    })
    expect(added).toMatchObject({ projectId: p, label: 'Migrations', createdBy: 'worker-a' })
    const project = await tool('get_project', { projectId: p })
    expect(project.notes.map((n: { id: number }) => n.id)).toEqual([added.id])
    expect((await tool('list_notes', { projectId: p })).map((n: { id: number }) => n.id)).toEqual([added.id])

    const changed = await tool('update_note', {
      projectId: p,
      noteId: added.id,
      body: 'they run when the board starts',
    })
    expect(changed.body).toBe('they run when the board starts')
    expect((await tool('get_project', { projectId: p })).notes[0].body).toBe('they run when the board starts')

    const removed = await tool('delete_note', { projectId: p, noteId: added.id })
    expect(removed.id).toBe(added.id)
    expect((await tool('get_project', { projectId: p })).notes).toEqual([])
    expect(await tool('list_notes', { projectId: p })).toEqual([])
  })
})

describe('the board skill', () => {
  it('tells every client to read the notes before starting and to add one for what must not be rediscovered', async () => {
    const { renderSkill } = await import('./agents')
    const skill = renderSkill('claude')
    expect(skill).not.toMatch(/\{\{[A-Z_]+\}\}/)
    expect(skill).toMatch(/notes/i)
    expect(skill).toMatch(/read them before starting/i)
    expect(skill).toMatch(/must not rediscover/i)
    expect(skill).toMatch(/one short fact/i)
    expect(skill).toMatch(/never a document/i)
    expect(skill).toContain('list_notes')
    expect(skill).toContain('add_note')
  })
})
