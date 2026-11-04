import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

/**
 * GET /api/projects/:id/tags, the tag filter's pages, as src/start.ts serves a request: `admit` (a
 * signed-in caller or a 401), then the guard and the API router. The caller is an agent by its token.
 */

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-tags-'))
process.env.DATA_DIR = tmp

const TOKEN = 'token-of-claude'

let dbm: typeof import('#/db')
let serve: (request: Request) => Promise<Response>
beforeAll(async () => {
  dbm = await import('#/db')
  const { admit, rememberActor } = await import('./auth')
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  const { hashSecret } = await import('./credentials')
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
  // A board set up already (an account), and an agent's token.
  dbm.db.insert(dbm.schema.account).values({ id: 1, name: 'Enrique', userHandle: 'aGFuZGxl' }).run()
  dbm.db
    .insert(dbm.schema.agentTokens)
    .values({ tokenHash: hashSecret(TOKEN), name: 'claude', expiresAt: '2099-01-01T00:00:00.000Z' })
    .run()
  // Loading the whole API router takes a while on a cold transform, as in the other server tests.
}, 60_000)

/** A request on this machine, with the agent's token unless `token` is null. */
function send(target: string, token: string | null = TOKEN) {
  const request = new Request(`http://localhost:47100${target}`, {
    headers: {
      host: 'localhost:47100',
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  })
  // How srvx's Node request carries the connection the request came on.
  return serve(
    Object.assign(request, { runtime: { node: { req: { socket: { remoteAddress: '127.0.0.1' } } } } }),
  )
}

type Page = { tags: string[]; next: number | null }
async function page(target: string): Promise<Page> {
  const res = await send(target)
  expect(res.status, target).toBe(200)
  return res.json()
}

const MANY = Array.from({ length: 50 }, (_, i) => `Module ${i + 1}`)

function newProject(name: string, tagSuggestions: string[]) {
  return dbm.db.insert(dbm.schema.projects).values({ name, tagSuggestions }).returning().get().id
}
function newTicket(projectId: number, tags: string[]) {
  dbm.db.insert(dbm.schema.tickets).values({ projectId, title: 'A ticket', createdBy: 'claude', tags }).run()
}

/** Every page of `target` (no `offset` in it), following `next`, with `limit` each. */
async function allPages(target: string, limit?: number) {
  const pages: Page[] = []
  let offset: number | null = 0
  while (offset !== null) {
    const sep = target.includes('?') ? '&' : '?'
    const p = await page(`${target}${sep}offset=${offset}${limit ? `&limit=${limit}` : ''}`)
    pages.push(p)
    offset = p.next
  }
  return pages
}

describe('GET /api/projects/:id/tags', () => {
  let main: number
  let other: number
  beforeAll(() => {
    main = newProject('Main', MANY)
    // Carried by tickets: offered after the suggestions, most used first, in the casing used most.
    newTicket(main, ['UI', 'Bug'])
    newTicket(main, ['ui'])
    newTicket(main, ['ui'])
    other = newProject('Other', ['Elsewhere'])
    newTicket(other, ['Secret', 'Module 1'])
  })

  const everyTag = () => [...MANY, 'ui', 'Bug']

  it('pages through every tag in the order the filter shows them, without gaps or repeats', async () => {
    const first = await page(`/api/projects/${main}/tags`)
    expect(first).toEqual({ tags: MANY.slice(0, 20), next: 20 })
    const second = await page(`/api/projects/${main}/tags?offset=20`)
    expect(second).toEqual({ tags: MANY.slice(20, 40), next: 40 })
    const last = await page(`/api/projects/${main}/tags?offset=40`)
    expect(last).toEqual({ tags: [...MANY.slice(40), 'ui', 'Bug'], next: null })
    // Past the end: nothing, and no more.
    expect(await page(`/api/projects/${main}/tags?offset=60`)).toEqual({ tags: [], next: null })

    for (const limit of [7, 20, 50]) {
      const pages = await allPages(`/api/projects/${main}/tags`, limit)
      const tags = pages.flatMap((p) => p.tags)
      expect(tags, `limit ${limit}`).toEqual(everyTag())
      expect(new Set(tags).size).toBe(tags.length)
      expect(pages.slice(0, -1).every((p) => p.tags.length === limit)).toBe(true)
    }
  })

  it('searches every tag, past the first page, in any casing', async () => {
    expect(await page(`/api/projects/${main}/tags?q=BUG`)).toEqual({ tags: ['Bug'], next: null })
    expect(await page(`/api/projects/${main}/tags?q=module%2050`)).toEqual({
      tags: ['Module 50'],
      next: null,
    })
    const mod = await allPages(`/api/projects/${main}/tags?q=MOD`)
    expect(mod.map((p) => p.tags.length)).toEqual([20, 20, 10])
    expect(mod.flatMap((p) => p.tags)).toEqual(MANY)
    expect(await page(`/api/projects/${main}/tags?q=${encodeURIComponent('  Ui ')}`)).toEqual({
      tags: ['ui'],
      next: null,
    })
    expect(await page(`/api/projects/${main}/tags?q=zzzz`)).toEqual({ tags: [], next: null })
  })

  it('puts a tag the project does not offer first when it is included, and a known one where it is', async () => {
    expect((await page(`/api/projects/${main}/tags?include=Zeta`)).tags.slice(0, 2)).toEqual([
      'Zeta',
      'Module 1',
    ])
    expect((await allPages(`/api/projects/${main}/tags?include=Zeta`)).flatMap((p) => p.tags)).toEqual([
      'Zeta',
      ...everyTag(),
    ])
    // Known in another casing: not offered twice.
    expect((await allPages(`/api/projects/${main}/tags?include=BUG`)).flatMap((p) => p.tags)).toEqual(
      everyTag(),
    )
    // The search applies to it too.
    expect(await page(`/api/projects/${main}/tags?include=Zeta&q=zet`)).toEqual({
      tags: ['Zeta'],
      next: null,
    })
    expect(await page(`/api/projects/${main}/tags?include=Zeta&q=bug`)).toEqual({ tags: ['Bug'], next: null })
  })

  it("gives only the project's own tags", async () => {
    const tags = (await allPages(`/api/projects/${main}/tags`)).flatMap((p) => p.tags)
    expect(tags).not.toContain('Secret')
    expect(tags).not.toContain('Elsewhere')
    expect(await page(`/api/projects/${main}/tags?q=secret`)).toEqual({ tags: [], next: null })
    expect(await page(`/api/projects/${other}/tags`)).toEqual({
      tags: ['Elsewhere', 'Secret', 'Module 1'],
      next: null,
    })
  })

  it('clamps the limit to 50 and refuses what is no page', async () => {
    const big = await page(`/api/projects/${main}/tags?limit=1000`)
    expect(big.tags).toEqual(MANY)
    expect(big.next).toBe(50)
    expect((await page(`/api/projects/${main}/tags?limit=1`)).tags).toEqual(['Module 1'])
    for (const bad of [
      'limit=0',
      'limit=-3',
      'limit=2.5',
      'limit=ten',
      'offset=-1',
      'offset=1.5',
      'offset=x',
    ]) {
      const res = await send(`/api/projects/${main}/tags?${bad}`)
      expect(res.status, bad).toBe(400)
      expect((await res.json()).error, bad).toMatch(/^query: /)
    }
    const long = await send(`/api/projects/${main}/tags?q=${'a'.repeat(201)}`)
    expect(long.status).toBe(400)
  })

  it('refuses a caller not signed in, and answers 404 for a project there is not', async () => {
    for (const token of [null, 'made-up']) {
      const res = await send(`/api/projects/${main}/tags`, token)
      expect(res.status, String(token)).toBe(401)
    }
    const missing = await send('/api/projects/999999/tags')
    expect(missing.status).toBe(404)
    expect((await send('/api/projects/abc/tags')).status).toBe(400)
  })
})
