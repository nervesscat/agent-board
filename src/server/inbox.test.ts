import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-inbox-'))
process.env.DATA_DIR = tmp

let features: typeof import('./features')
let dbm: typeof import('#/db')
beforeAll(async () => {
  features = await import('./features')
  dbm = await import('#/db')
})

const T = (h: number, m = 0) =>
  `2026-01-01T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`

function newProject(name: string) {
  const { db, schema } = dbm
  const pid = db.insert(schema.projects).values({ name }).returning().get().id
  db.insert(schema.repos)
    .values({ projectId: pid, name, repoPath: `/r/${name}` })
    .run()
  return pid
}
// Pin when something was said, so "after since" is exact.
function said(row: object & { id: number }, at: string) {
  const { db, schema } = dbm
  // A post on a ticket is an update; a reply is a comment.
  if ('ticketId' in row)
    db.update(schema.updates).set({ createdAt: at }).where(eq(schema.updates.id, row.id)).run()
  else db.update(schema.comments).set({ createdAt: at }).where(eq(schema.comments.id, row.id)).run()
}

describe('watching for new comments', () => {
  it('keeps only the threads with a new word from someone else after since, with a cursor', () => {
    const pid = newProject('since')
    const t1 = features.createTicket(pid, { title: 'header', assignee: 'claude' }, 'enrique')
    const u = features.postUpdate(t1.id, 'first pass', [], 'claude')
    said(u, T(9))
    said(
      features.addComment({ parentType: 'update', parentId: u.id, body: 'off on mobile' }, 'enrique'),
      T(10),
    )
    const t2 = features.createTicket(pid, { title: 'footer', assignee: 'claude' }, 'enrique')
    said(
      features.addComment({ parentType: 'ticket', parentId: t2.id, body: 'and the footer?' }, 'enrique'),
      T(11),
    )

    // No since: everything waiting, cursor at the newest.
    const all = features.myThreads(pid, 'claude')
    expect(all.cursor).toBe(T(11))
    expect(all.threads.map((t) => [t.parentType, t.parentId])).toEqual([
      ['ticket', t2.id],
      ['update', u.id],
    ])
    // Older since: both; since at the reply under the update: only what came strictly after it.
    expect(features.myThreads(pid, 'claude', T(8)).threads).toHaveLength(2)
    expect(features.myThreads(pid, 'claude', T(10))).toMatchObject({
      cursor: T(11),
      threads: [{ parentType: 'ticket', parentId: t2.id, last: { author: 'enrique' } }],
    })
    // Nothing newer: no threads, and the cursor stays where it was (normalized to ISO).
    expect(features.myThreads(pid, 'claude', '2026-01-01T12:00:00Z')).toEqual({
      cursor: T(12),
      threads: [],
    })

    // The caller's own words never count, and answering takes a thread off the list.
    const t3 = features.createTicket(pid, { title: 'mine', assignee: 'claude' }, 'enrique')
    said(
      features.addComment({ parentType: 'ticket', parentId: t3.id, body: 'note to self' }, 'claude'),
      T(13),
    )
    said(
      features.addComment({ parentType: 'update', parentId: u.id, body: 'fixed in abc123' }, 'claude'),
      T(14),
    )
    expect(features.myThreads(pid, 'claude', T(11))).toEqual({ cursor: T(11), threads: [] })
    expect(features.myThreads(pid, 'claude').threads.map((t) => t.parentId)).toEqual([t2.id])
    // Another agent's word counts as someone else's.
    said(features.addComment({ parentType: 'update', parentId: u.id, body: 'still off' }, 'codex'), T(15))
    expect(features.myThreads(pid, 'claude', T(11))).toMatchObject({
      cursor: T(15),
      threads: [{ parentType: 'update', parentId: u.id, last: { author: 'codex' } }],
    })

    expect(() => features.myThreads(pid, 'claude', 'yesterday-ish')).toThrow(/since must be an ISO time/)
  })

  it('returns the threads waiting on a project agent with as', async () => {
    const agents = await import('./projectAgents')
    const pid = newProject('persona')
    agents.createAgent(pid, { name: 'Designer' }, 'enrique')
    const t = features.createTicket(pid, { title: 'logo' }, 'enrique')
    said(
      features.addComment({ parentType: 'ticket', parentId: t.id, body: '@designer have a look' }, 'enrique'),
      T(10),
    )

    expect(features.myThreads(pid, 'codex', T(9))).toMatchObject({
      cursor: T(10),
      threads: [{ ticketId: t.id, as: 'Designer', last: { author: 'enrique' } }],
    })
    expect(features.checkInbox(pid, 'codex', T(10))).toEqual({
      count: 0,
      cursor: T(10),
      threads: [],
      reportDue: null,
    })
    // Answered as the agent: off the list, even with an old since.
    said(
      features.addComment({ parentType: 'ticket', parentId: t.id, body: 'On it.', as: 'Designer' }, 'codex'),
      T(11),
    )
    expect(features.myThreads(pid, 'codex', T(9))).toEqual({ cursor: T(9), threads: [] })
    said(features.addComment({ parentType: 'ticket', parentId: t.id, body: 'thanks!' }, 'enrique'), T(12))
    expect(features.checkInbox(pid, 'codex', T(10)).threads).toMatchObject([
      { as: 'Designer', lastAt: T(12) },
    ])
  })

  it('moves the cursor only forward, poll after poll', () => {
    const pid = newProject('cursor')
    const t = features.createTicket(pid, { title: 'polled', assignee: 'claude' }, 'enrique')
    let cursor: string | null = null
    const seen: (string | null)[] = []
    const poll = () => {
      const inbox = features.checkInbox(pid, 'claude', cursor)
      if (cursor) expect(inbox.cursor! >= cursor).toBe(true)
      cursor = inbox.cursor
      seen.push(cursor)
      return inbox.count
    }
    expect(poll()).toBe(0)
    expect(cursor).toBeNull()
    said(features.addComment({ parentType: 'ticket', parentId: t.id, body: 'one' }, 'enrique'), T(10))
    expect(poll()).toBe(1)
    expect(poll()).toBe(0)
    said(features.addComment({ parentType: 'ticket', parentId: t.id, body: 'answer' }, 'claude'), T(11))
    expect(poll()).toBe(0)
    said(features.addComment({ parentType: 'ticket', parentId: t.id, body: 'two' }, 'enrique'), T(12))
    expect(poll()).toBe(1)
    expect(poll()).toBe(0)
    expect(seen).toEqual([null, T(10), T(10), T(10), T(12), T(12)])
  })

  it('check_inbox lists where each new thread is, without bodies', () => {
    const pid = newProject('inbox')
    // A project whose reports are off has no report due.
    expect(features.checkInbox(pid, 'claude')).toEqual({
      count: 0,
      cursor: null,
      threads: [],
      reportDue: null,
    })
    const t = features.createTicket(pid, { title: 'nav', assignee: 'claude' }, 'enrique')
    const post = features.addComment(
      { parentType: 'ticket', parentId: t.id, body: 'the menu jumps' },
      'enrique',
    )
    said(post, T(10))
    expect(features.checkInbox(pid, 'claude', T(9))).toEqual({
      count: 1,
      cursor: T(10),
      threads: [
        {
          ticketId: t.id,
          title: 'nav',
          parentType: 'ticket',
          parentId: t.id,
          as: null,
          lastAuthor: 'enrique',
          lastAt: T(10),
        },
      ],
      reportDue: null,
    })
    expect(JSON.stringify(features.checkInbox(pid, 'claude'))).not.toContain('menu jumps')
  })

  it('answers the same over REST and MCP', async () => {
    const { api } = await import('./api')
    const { handleMcp } = await import('./mcp')
    const pid = newProject('parity')
    const t = features.createTicket(pid, { title: 'parity', assignee: 'claude' }, 'enrique')
    said(features.addComment({ parentType: 'ticket', parentId: t.id, body: 'old' }, 'enrique'), T(10))
    const t2 = features.createTicket(pid, { title: 'parity 2', assignee: 'claude' }, 'enrique')
    said(features.addComment({ parentType: 'ticket', parentId: t2.id, body: 'new' }, 'enrique'), T(11))

    const rest = async (route: string) =>
      (await api.handle(new Request(`http://localhost/api/projects/${pid}/${route}`), 'claude')).json()
    const mcp = async (name: string, args: Record<string, unknown>) => {
      const res = await handleMcp(
        new Request('http://localhost/api/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name, arguments: args },
          }),
        }),
        'claude',
      )
      const body = (await res.json()) as { result: { content: { text: string }[] } }
      return JSON.parse(body.result.content[0]!.text)
    }

    const since = T(10)
    const threads = features.myThreads(pid, 'claude', since)
    expect(threads.threads).toHaveLength(1)
    expect(await rest(`threads?since=${encodeURIComponent(since)}`)).toEqual(threads)
    expect(await mcp('list_my_threads', { projectId: pid, since })).toEqual(threads)
    expect(await rest('threads')).toEqual(features.myThreads(pid, 'claude'))

    const inbox = features.checkInbox(pid, 'claude', since)
    expect(await rest(`inbox?since=${encodeURIComponent(since)}`)).toEqual(inbox)
    expect(await mcp('check_inbox', { projectId: pid, since })).toEqual(inbox)
    expect(await mcp('check_inbox', { projectId: pid })).toEqual(features.checkInbox(pid, 'claude'))

    await expect(
      api.handle(new Request(`http://localhost/api/projects/${pid}/threads?since=nope`), 'claude'),
    ).rejects.toThrow(/since must be an ISO time/)
  })
})
