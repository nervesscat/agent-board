import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-search-'))
process.env.DATA_DIR = tmp

let dbm: typeof import('#/db')
let features: typeof import('./features')
beforeAll(async () => {
  dbm = await import('#/db')
  features = await import('./features')
})

/** A project with one repo, as tickets need. */
const newProject = (name: string) => {
  const id = dbm.db.insert(dbm.schema.projects).values({ name }).returning().get().id
  dbm.db
    .insert(dbm.schema.repos)
    .values({ projectId: id, name, repoPath: `/r/${name}` })
    .run()
  return id
}
const ticket = (pid: number, title: string, more: { body?: string; status?: string } = {}) =>
  features.createTicket(pid, { title, ...more }, 'enrique')
/** Last touched at `at`: the order a list keeps within each group of a search. */
const touched = (id: number, at: string) =>
  dbm.db.update(dbm.schema.tickets).set({ updatedAt: at }).where(eq(dbm.schema.tickets.id, id)).run()
const ids = (pid: number, filter: import('./features').TicketFilter) =>
  features.listTickets(pid, filter).map((t) => t.id)

describe('searching tickets', () => {
  it('finds a word in the title in any casing, and leaves out the tickets without it', () => {
    const pid = newProject('title')
    const hooks = ticket(pid, 'Stripe webhooks')
    ticket(pid, 'Other')
    expect(ids(pid, { q: 'WEBHOOK' })).toEqual([hooks.id])
    expect(features.listTickets(pid, { q: 'webhook' })[0]).toMatchObject({ match: 'title', snippet: null })
  })

  it('finds a ticket by its number, with or without #, as a name match', () => {
    const pid = newProject('number')
    const a = ticket(pid, 'alpha')
    const b = ticket(pid, 'beta', { body: `see #${a.id} for context` })
    expect(features.listTickets(pid, { q: `#${a.id}` }).map((t) => [t.id, t.match])).toEqual([
      [a.id, 'id'],
      [b.id, 'body'],
    ])
    expect(features.listTickets(pid, { q: String(a.id) }).map((t) => [t.id, t.match])).toEqual([
      [a.id, 'id'],
      [b.id, 'body'],
    ])
    // Another ticket's number does not find this one.
    expect(ids(pid, { q: `#${b.id}` })).toEqual([b.id])
  })

  it('finds a word only in the instructions', () => {
    const pid = newProject('body')
    const t = ticket(pid, 'b', { body: 'first line\n\nthen retry the WEBHOOK with backoff' })
    ticket(pid, 'c')
    expect(features.listTickets(pid, { q: 'webhook' })).toMatchObject([
      { id: t.id, match: 'body', snippet: 'first line then retry the WEBHOOK with backoff' },
    ])
  })

  it('finds a word in a post or a reply, by its current text only', () => {
    const pid = newProject('thread')
    const t = ticket(pid, 'plain', { body: 'nothing here' })
    ticket(pid, 'other')
    expect(ids(pid, { q: 'zebra' })).toEqual([])

    const post = features.postUpdate(t.id, 'saw a zebra in the logs', [], 'claude')
    expect(features.listTickets(pid, { q: 'ZEBRA' })).toMatchObject([
      { id: t.id, match: 'post', snippet: 'saw a zebra in the logs' },
    ])
    features.editPost(post.id, { body: 'saw a horse in the logs' }, 'claude')
    expect(ids(pid, { q: 'zebra' })).toEqual([])

    const reply = features.addComment(
      { parentType: 'update', parentId: post.id, body: 'that was a zebra, not a horse' },
      'enrique',
    )
    expect(features.listTickets(pid, { q: 'zebra' })).toMatchObject([
      { id: t.id, match: 'reply', snippet: 'that was a zebra, not a horse' },
    ])
    features.editComment(reply.id, 'that was a horse', 'enrique')
    expect(ids(pid, { q: 'zebra' })).toEqual([])

    // A discussion post counts as much as a progress one; deleting it takes it out.
    const talk = features.addComment({ parentType: 'ticket', parentId: t.id, body: 'zebra?' }, 'enrique')
    expect(ids(pid, { q: 'zebra' })).toEqual([t.id])
    features.deletePost(talk.id, 'enrique')
    expect(ids(pid, { q: 'zebra' })).toEqual([])

    // A deleted post takes its replies with it.
    const again = features.postUpdate(t.id, 'next step', [], 'claude')
    features.addComment({ parentType: 'update', parentId: again.id, body: 'zebra again' }, 'enrique')
    expect(ids(pid, { q: 'zebra' })).toEqual([t.id])
    features.deletePost(again.id, 'claude')
    expect(ids(pid, { q: 'zebra' })).toEqual([])
  })

  it('puts every name match before every content match, each keeping the list order', () => {
    const pid = newProject('ranking')
    const oldName = ticket(pid, 'alpha release')
    const newName = ticket(pid, 'Alpha docs')
    const newestPost = ticket(pid, 'post only')
    const newestBody = ticket(pid, 'body only', { body: 'ships with ALPHA' })
    features.postUpdate(newestPost.id, 'tried it on alpha', [], 'claude')
    touched(oldName.id, '2026-01-01T00:00:00.000Z')
    touched(newName.id, '2026-02-01T00:00:00.000Z')
    touched(newestPost.id, '2026-03-01T00:00:00.000Z')
    touched(newestBody.id, '2026-03-02T00:00:00.000Z')
    expect(features.listTickets(pid, { q: 'alpha' }).map((t) => [t.id, t.match])).toEqual([
      [newName.id, 'title'],
      [oldName.id, 'title'],
      [newestBody.id, 'body'],
      [newestPost.id, 'post'],
    ])
  })

  it('takes the query literally, in any casing, and an empty one as no filter', () => {
    const pid = newProject('literal')
    const pct = ticket(pid, 'raise it 50%')
    const under = ticket(pid, 'a_c helper')
    const abc = ticket(pid, 'abc')
    const slash = ticket(pid, 'path', { body: 'C:\\Users' })
    const tree = ticket(pid, 'árbol')
    const bird = ticket(pid, 'otro', { body: 'el ñandú corre' })
    expect(ids(pid, { q: '%' })).toEqual([pct.id])
    expect(ids(pid, { q: 'a_c' })).toEqual([under.id])
    expect(ids(pid, { q: '_' })).toEqual([under.id])
    expect(ids(pid, { q: '\\u' })).toEqual([slash.id])
    expect(ids(pid, { q: 'ÁRBOL' })).toEqual([tree.id])
    expect(features.listTickets(pid, { q: 'ÑANDÚ' })).toMatchObject([
      { id: bird.id, match: 'body', snippet: 'el ñandú corre' },
    ])
    expect(ids(pid, { q: '   ' })).toEqual(ids(pid, {}))
    expect(ids(pid, { q: '' })).toEqual(ids(pid, {}))
    expect(ids(pid, {})).toContain(abc.id)
  })

  it('combines with the other filters', () => {
    const pid = newProject('filters')
    const open = ticket(pid, 'kiwi open', { status: 'todo' })
    const blocked = ticket(pid, 'kiwi blocked', { status: 'blocked' })
    const shipped = ticket(pid, 'shipped', { status: 'done' })
    features.postUpdate(shipped.id, 'kiwi is out', [], 'claude')
    features.archiveTicket(shipped.id, 'enrique')
    const lane = features.createTicket(pid, { title: 'kiwi lane', parentId: open.id }, 'enrique')
    features.updateTicket(blocked.id, { tags: ['ui'] }, 'enrique')

    expect(ids(pid, { q: 'kiwi', parentId: null }).sort()).toEqual([open.id, blocked.id].sort())
    expect(ids(pid, { q: 'kiwi', parentId: null, archived: 'only' })).toEqual([shipped.id])
    expect(ids(pid, { q: 'kiwi', status: ['blocked'] })).toEqual([blocked.id])
    expect(ids(pid, { q: 'kiwi', tag: 'UI' })).toEqual([blocked.id])
    expect(ids(pid, { q: 'kiwi', parentId: open.id })).toEqual([lane.id])
    expect(ids(pid, { q: 'kiwi', assignee: 'nobody' })).toEqual([])
  })

  it('cuts the words around a hit in a long text', () => {
    const long = `${'lorem ipsum '.repeat(30)}needle${' dolor sit'.repeat(30)}`
    const s = features.snippetOf(long, 'needle')!
    expect(s).toContain('needle')
    expect(s.startsWith('…')).toBe(true)
    expect(s.endsWith('…')).toBe(true)
    expect(s.length).toBeLessThanOrEqual(122)
    // A character lowercasing to two does not shift the window off the hit.
    expect(features.snippetOf(`${'İ'.repeat(200)} needle`, 'needle')).toMatch(/needle$/)
    expect(features.snippetOf('short', 'zzz')).toBeNull()
  })

  it('answers the same over REST and MCP, thread matches included, without the thread', async () => {
    const { api } = await import('./api')
    const { handleMcp } = await import('./mcp')
    const pid = newProject('parity')
    const named = ticket(pid, 'mango page')
    const replied = ticket(pid, 'other')
    const post = features.postUpdate(replied.id, 'a long post that never says it', [], 'claude')
    features.addComment({ parentType: 'update', parentId: post.id, body: 'the MANGO bug is back' }, 'enrique')
    ticket(pid, 'unrelated')

    const rest = async (query: string) =>
      (await (
        await api.handle(new Request(`http://localhost/api/projects/${pid}/tickets?${query}`), 'enrique')
      ).json()) as Record<string, unknown>[]
    const mcp = async (args: Record<string, unknown>) => {
      const res = await handleMcp(
        new Request('http://localhost/api/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'list_tickets', arguments: { projectId: pid, ...args } },
          }),
        }),
        'claude',
      )
      const body = (await res.json()) as { result: { content: { text: string }[] } }
      return JSON.parse(body.result.content[0]!.text) as Record<string, unknown>[]
    }

    const overRest = await rest('parent=root&q=mango')
    const overMcp = await mcp({ parentId: null, q: 'mango' })
    expect(overRest.map((t) => [t.id, t.match, t.snippet])).toEqual([
      [named.id, 'title', null],
      [replied.id, 'reply', 'the MANGO bug is back'],
    ])
    expect(overMcp.map((t) => [t.id, t.match, t.snippet])).toEqual(
      overRest.map((t) => [t.id, t.match, t.snippet]),
    )
    for (const row of [...overRest, ...overMcp]) {
      expect(row).not.toHaveProperty('updates')
      expect(row).not.toHaveProperty('comments')
      expect(JSON.stringify(row)).not.toContain('a long post that never says it')
    }
    // Without q, rows say nothing about a match.
    expect((await rest('parent=root'))[0]).not.toHaveProperty('match')
  })
})
