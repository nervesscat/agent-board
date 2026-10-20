import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-tag-suggestions-'))
process.env.DATA_DIR = tmp

let dbm: typeof import('#/db')
let handle: (request: Request) => Promise<Response>
beforeAll(async () => {
  dbm = await import('#/db')
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  // As the server answers: an HttpError becomes its status with `{error}`. A bearer token is an agent.
  const guarded = guard(({ request }: { request: Request }) =>
    api.handle(request, request.headers.has('authorization') ? 'claude' : 'enrique'),
  )
  handle = (request) => guarded({ request })
})

/** A project made as one that existed before the column: the defaults stored. */
function newProject(name: string) {
  const id = dbm.db.insert(dbm.schema.projects).values({ name }).returning().get().id
  dbm.db
    .insert(dbm.schema.repos)
    .values({ projectId: id, name: 'api', repoPath: `/r/${name}` })
    .run()
  return id
}

async function call(method: string, pathname: string, body?: unknown, as: 'human' | 'agent' = 'human') {
  const res = await handle(
    new Request(`http://localhost${pathname}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(as === 'agent' ? { authorization: 'Bearer token-of-test' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
  return { status: res.status, body: (await res.json()) as any }
}

let rpcId = 0
async function rpc(method: string, params: Record<string, unknown> = {}) {
  const { handleMcp } = await import('./mcp')
  const res = await handleMcp(
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    }),
    'claude',
  )
  return ((await res.json()) as { result: any }).result
}
async function tool(name: string, args: Record<string, unknown>) {
  const result = (await rpc('tools/call', { name, arguments: args })) as {
    isError?: boolean
    content: { text: string }[]
  }
  expect(result.isError, result.content[0]!.text).toBeFalsy()
  return JSON.parse(result.content[0]!.text)
}

const DEFAULTS = ['Bug', 'UI', 'Implementation', 'Report']
const suggestions = async (projectId: number) =>
  (await call('GET', `/api/projects/${projectId}`)).body.tagSuggestions as string[]

describe("a project's tag suggestions", () => {
  it('are Bug, UI, Implementation, Report on a project that never set them, over REST and MCP', async () => {
    const p = newProject('defaults')
    expect(await suggestions(p)).toEqual(DEFAULTS)
    expect((await tool('get_project', { projectId: p })).tagSuggestions).toEqual(DEFAULTS)
    const made = await call('POST', '/api/projects', { name: 'made' })
    expect(made.body.tagSuggestions).toEqual(DEFAULTS)
    const listed = (await call('GET', '/api/projects')).body as { id: number; tagSuggestions: string[] }[]
    expect(listed.find((x) => x.id === p)!.tagSuggestions).toEqual(DEFAULTS)
  })

  it('are saved trimmed, whitespace runs joined, repeats in any casing dropped, and [] stays empty', async () => {
    const p = newProject('set')
    const set = await call('PATCH', `/api/projects/${p}`, {
      tagSuggestions: [' Auth ', 'login   form', 'AUTH', 'auth', 'MCP'],
    })
    expect(set.status, JSON.stringify(set.body)).toBe(200)
    expect(set.body.tagSuggestions).toEqual(['Auth', 'login form', 'MCP'])
    expect(await suggestions(p)).toEqual(['Auth', 'login form', 'MCP'])
    expect((await tool('get_project', { projectId: p })).tagSuggestions).toEqual([
      'Auth',
      'login form',
      'MCP',
    ])

    expect((await call('PATCH', `/api/projects/${p}`, { tagSuggestions: [] })).body.tagSuggestions).toEqual(
      [],
    )
    expect(await suggestions(p)).toEqual([])
  })

  it('refuse a blank one, one longer than a tag, one with a comma, or null (400), and leave the list as it was', async () => {
    const p = newProject('refused')
    for (const tagSuggestions of [['ok', '  '], ['x'.repeat(41)], ['a, b'], null]) {
      const res = await call('PATCH', `/api/projects/${p}`, { tagSuggestions })
      expect(res.status, JSON.stringify(tagSuggestions)).toBe(400)
    }
    expect(await suggestions(p)).toEqual(DEFAULTS)
  })

  it('can be set by an agent too', async () => {
    const p = newProject('agent')
    const res = await call('PATCH', `/api/projects/${p}`, { tagSuggestions: ['Board'] }, 'agent')
    expect(res.status).toBe(200)
    expect(await suggestions(p)).toEqual(['Board'])
  })
})

describe('set_tag_suggestions', () => {
  it('replaces the suggestions over MCP as PATCH does, and answers with them and the tags in use', async () => {
    const p = newProject('mcp')
    expect((await call('POST', `/api/projects/${p}/tickets`, { title: 't', tags: ['Board'] })).status).toBe(
      201,
    )
    const set = await tool('set_tag_suggestions', {
      projectId: p,
      tags: [' Auth ', 'login   form', 'AUTH', 'MCP'],
    })
    expect(set).toEqual({ tagSuggestions: ['Auth', 'login form', 'MCP'], usedTags: ['Board'] })
    expect(await suggestions(p)).toEqual(['Auth', 'login form', 'MCP'])
    expect((await tool('get_project', { projectId: p })).tagSuggestions).toEqual([
      'Auth',
      'login form',
      'MCP',
    ])
    expect((await tool('set_tag_suggestions', { projectId: p, tags: [] })).tagSuggestions).toEqual([])
    expect(await suggestions(p)).toEqual([])
  })

  it('refuses what PATCH refuses, and an unknown project, leaving the list as it was', async () => {
    const p = newProject('mcp-refused')
    const refused = async (args: Record<string, unknown>) =>
      ((await rpc('tools/call', { name: 'set_tag_suggestions', arguments: args })) as { isError?: boolean })
        .isError
    for (const tags of [
      ['ok', '  '],
      ['x'.repeat(41)],
      ['a, b'],
      null,
      Array.from({ length: 51 }, (_, i) => `t${i}`),
    ])
      expect(await refused({ projectId: p, tags }), JSON.stringify(tags)).toBe(true)
    expect(await refused({ projectId: 999_999, tags: ['Auth'] })).toBe(true)
    expect(await suggestions(p)).toEqual(DEFAULTS)
  })
})

describe("a project's used tags", () => {
  it('are the tags its tickets carry, most used first, once each in the casing used most', async () => {
    const p = newProject('used')
    const other = newProject('other')
    for (const tags of [['Forms', 'ui'], ['UI', 'Login'], ['UI'], ['forms']])
      expect((await call('POST', `/api/projects/${p}/tickets`, { title: 't', tags })).status).toBe(201)
    await call('POST', `/api/projects/${other}/tickets`, { title: 't', tags: ['Elsewhere'] })
    expect((await call('GET', `/api/projects/${p}`)).body.usedTags).toEqual(['UI', 'Forms', 'Login'])
    expect((await tool('get_project', { projectId: p })).usedTags).toEqual(['UI', 'Forms', 'Login'])
    expect((await call('GET', `/api/projects/${other}`)).body.usedTags).toEqual(['Elsewhere'])
  })
})
