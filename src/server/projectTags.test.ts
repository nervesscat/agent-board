import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'

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

type Page = { tags: string[]; next: string | null }
async function page(target: string): Promise<Page> {
  const res = await send(target)
  expect(res.status, target).toBe(200)
  return res.json()
}

const MANY = Array.from({ length: 50 }, (_, i) => `Module ${i + 1}`)
/** Tags by name, case-insensitive: the order of those no ticket used lately. */
const byName = (tags: string[]) => [...tags].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
const NAMED = byName(MANY)

function newProject(name: string, tagSuggestions: string[]) {
  return dbm.db.insert(dbm.schema.projects).values({ name, tagSuggestions }).returning().get().id
}
function newTicket(projectId: number, tags: string[], updatedAt?: string) {
  dbm.db
    .insert(dbm.schema.tickets)
    .values({ projectId, title: 'A ticket', createdBy: 'claude', tags, ...(updatedAt && { updatedAt }) })
    .run()
}
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()

/** `target` with the page `cursor` asks for (none: the first) and `limit`. */
function at(target: string, cursor: string | null, limit?: number) {
  const params = new URLSearchParams()
  if (cursor) params.set('cursor', cursor)
  if (limit) params.set('limit', String(limit))
  const sep = target.includes('?') ? '&' : '?'
  return params.size ? `${target}${sep}${params}` : target
}

/** Every page of `target` (no `cursor` in it), following `next`, with `limit` each. */
async function allPages(target: string, limit?: number) {
  const pages: Page[] = [await page(at(target, null, limit))]
  while (pages.at(-1)!.next !== null) pages.push(await page(at(target, pages.at(-1)!.next, limit)))
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

  // Used in the last week: ui 3 tickets, Bug 1, then the suggestions no ticket used, by name.
  const everyTag = () => ['ui', 'Bug', ...NAMED]

  it('pages through every tag in the order the filter shows them, without gaps or repeats', async () => {
    const first = await page(`/api/projects/${main}/tags`)
    expect(first.tags).toEqual(everyTag().slice(0, 20))
    expect(first.next).toMatch(/^[\w-]+$/)
    const second = await page(at(`/api/projects/${main}/tags`, first.next))
    expect(second.tags).toEqual(everyTag().slice(20, 40))
    const last = await page(at(`/api/projects/${main}/tags`, second.next))
    expect(last).toEqual({ tags: everyTag().slice(40), next: null })

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
    expect(mod.flatMap((p) => p.tags)).toEqual(NAMED)
    expect(await page(`/api/projects/${main}/tags?q=${encodeURIComponent('  Ui ')}`)).toEqual({
      tags: ['ui'],
      next: null,
    })
    expect(await page(`/api/projects/${main}/tags?q=zzzz`)).toEqual({ tags: [], next: null })
  })

  it('puts a tag the project does not offer first when it is included, and a known one where it is', async () => {
    expect((await page(`/api/projects/${main}/tags?include=Zeta`)).tags.slice(0, 2)).toEqual(['Zeta', 'ui'])
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

  it('follows next without a repeat or a gap while the order moves under it', async () => {
    // Used tags only, most used in the week first: high 3, Bug 2, then the others by name.
    const moving = newProject('Moving', [])
    for (const tags of [
      ['high', 'Bug', 'Extra A'],
      ['high', 'Bug', 'UI'],
      ['high', 'Extra B', 'critical'],
      ['Extra C', 'low'],
    ])
      newTicket(moving, tags)
    const target = `/api/projects/${moving}/tags`
    const before = ['high', 'Bug', 'critical', 'Extra A', 'Extra B', 'Extra C', 'low', 'UI']
    expect((await allPages(target)).flatMap((p) => p.tags)).toEqual(before)

    const first = await page(at(target, null, 3))
    expect(first.tags).toEqual(['high', 'Bug', 'critical'])
    // Between the pages, tags of the next page and further on move up past the first page's end,
    // and one in another casing moves up most.
    newTicket(moving, ['Extra C', 'UI', 'EXTRA b'])
    newTicket(moving, ['Extra C', 'extra b'])
    newTicket(moving, ['extra b'])
    const rest = [first]
    while (rest.at(-1)!.next !== null) rest.push(await page(at(target, rest.at(-1)!.next, 3)))
    const tags = rest.flatMap((p) => p.tags)
    expect(new Set(tags.map((t) => t.toLowerCase())).size).toBe(tags.length)
    const keys = (list: string[]) => list.map((t) => t.toLowerCase()).sort()
    expect(keys(tags)).toEqual(keys(before))
    // The pages after the first hold the rest in the order the list has now.
    expect(tags.slice(3)).toEqual(['extra b', 'Extra C', 'UI', 'Extra A', 'low'])
    // A tag new since the first page comes too, once, in its place by name among those not given yet.
    newTicket(moving, ['brand new'])
    expect(await page(at(target, rest[1].next, 50))).toEqual({
      tags: ['brand new', 'Extra A', 'low'],
      next: null,
    })
  })

  it("gives only the project's own tags", async () => {
    const tags = (await allPages(`/api/projects/${main}/tags`)).flatMap((p) => p.tags)
    expect(tags).not.toContain('Secret')
    expect(tags).not.toContain('Elsewhere')
    expect(await page(`/api/projects/${main}/tags?q=secret`)).toEqual({ tags: [], next: null })
    expect(await page(`/api/projects/${other}/tags`)).toEqual({
      tags: ['Module 1', 'Secret', 'Elsewhere'],
      next: null,
    })
  })

  it('orders by the tickets updated in the last week, one updated longer ago not counted', async () => {
    const lately = newProject('Lately', ['Zed', 'Alpha'])
    for (let i = 0; i < 3; i++) newTicket(lately, ['Zed'], daysAgo(10))
    newTicket(lately, ['Alpha'])
    newTicket(lately, ['Mod B'])
    newTicket(lately, ['Mod B'])
    newTicket(lately, ['Mod A'], daysAgo(10))
    const target = `/api/projects/${lately}/tags`
    expect((await page(target)).tags).toEqual(['Mod B', 'Alpha', 'Mod A', 'Zed'])
    // The search keeps that order, and finds a tag by its letters in order.
    expect((await page(`${target}?q=mod`)).tags).toEqual(['Mod B', 'Mod A'])
    expect((await page(`${target}?q=zd`)).tags).toEqual(['Zed'])
  })

  it('clamps the limit to 50 and refuses what is no page', async () => {
    const big = await page(`/api/projects/${main}/tags?limit=1000`)
    expect(big.tags).toEqual(everyTag().slice(0, 50))
    expect(big.next).not.toBeNull()
    expect((await page(`/api/projects/${main}/tags?limit=1`)).tags).toEqual(['ui'])
    for (const bad of [
      'limit=0',
      'limit=-3',
      'limit=2.5',
      'limit=ten',
      'cursor=x',
      'cursor=%21%21',
      `cursor=${Buffer.from('[1]').toString('base64url')}`,
      `cursor=${deflateRawSync('{"tags":["a"]}').toString('base64url')}`,
      `cursor=${deflateRawSync('[1]').toString('base64url')}`,
    ]) {
      const res = await send(`/api/projects/${main}/tags?${bad}`)
      expect(res.status, bad).toBe(400)
      expect((await res.json()).error, bad).toMatch(/^query: /)
    }
    const long = await send(`/api/projects/${main}/tags?q=${'a'.repeat(201)}`)
    expect(long.status).toBe(400)
  })

  it('gives the tag counts of the last week with the project, a ticket once per tag', async () => {
    const counted = newProject('Counted', [])
    newTicket(counted, ['UI', 'ui'], daysAgo(1))
    newTicket(counted, ['Bug'], daysAgo(8))
    const res = await send(`/api/projects/${counted}`)
    expect(res.status).toBe(200)
    expect((await res.json()).tagWeek).toEqual({ '#ui': 1 })
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
