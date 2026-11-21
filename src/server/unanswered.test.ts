import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-unanswered-'))
process.env.DATA_DIR = tmp

const HUMAN = 'enrique'
const AGENT = 'claude'

let dbm: typeof import('#/db')
let features: typeof import('./features')
let handle: (request: Request) => Promise<Response>
beforeAll(async () => {
  dbm = await import('#/db')
  features = await import('./features')
  ;(await import('./actors')).noteActor(HUMAN, 'human')
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  const guarded = guard(({ request }: { request: Request }) =>
    api.handle(request, request.headers.has('authorization') ? AGENT : HUMAN),
  )
  handle = (request) => guarded({ request })
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
// Pin when something was said, so the order is exact. A post is an update, a reply a comment.
function said<R extends object & { id: number }>(row: R, at: string): R {
  const { db, schema } = dbm
  if ('ticketId' in row)
    db.update(schema.updates).set({ createdAt: at }).where(eq(schema.updates.id, row.id)).run()
  else db.update(schema.comments).set({ createdAt: at }).where(eq(schema.comments.id, row.id)).run()
  return row
}
const humanPost = (ticketId: number, body: string, at: string) =>
  said(features.addComment({ parentType: 'ticket', parentId: ticketId, body }, HUMAN), at)
const humanReply = (postId: number, body: string, at: string) =>
  said(features.addComment({ parentType: 'update', parentId: postId, body }, HUMAN), at)
const agentReply = (postId: number, body: string, at: string, as = AGENT) =>
  said(features.addComment({ parentType: 'update', parentId: postId, body }, as), at)

async function latest(projectId: number) {
  const res = await handle(
    new Request(`http://localhost/api/projects/${projectId}/latest-actions`, {
      headers: { authorization: 'Bearer gate_test' },
    }),
  )
  return (await res.json()) as {
    count: number
    comments: { id: number; kind: string; ticketId: number; text: string }[]
  }
}
const ids = async (projectId: number) => (await latest(projectId)).comments.map((c) => c.id)

describe('the human’s comments no agent has addressed', () => {
  it('lists a top-level post and a reply by the human, oldest first, and drops each once an agent replies under it', async () => {
    const pid = newProject('plain')
    const t = features.createTicket(pid, { title: 'header', assignee: AGENT }, HUMAN)
    const progress = said(features.postUpdate(t.id, 'first pass', [], AGENT), T(8))
    const ask = humanPost(t.id, 'please make it bigger\nand bolder', T(9))
    const reply = humanReply(progress.id, 'off on mobile', T(10))

    const first = await latest(pid)
    expect(first.count).toBe(2)
    expect(first.comments).toMatchObject([
      {
        id: ask.id,
        kind: 'post',
        ticketId: t.id,
        title: 'header',
        stage: 'todo',
        assignee: AGENT,
        parentType: 'ticket',
        parentId: t.id,
        author: HUMAN,
        createdAt: T(9),
      },
      {
        id: reply.id,
        kind: 'reply',
        ticketId: t.id,
        parentType: 'update',
        parentId: progress.id,
        author: HUMAN,
        text: 'off on mobile',
        createdAt: T(10),
      },
    ])
    expect(first.comments[0]!.text).toContain('please make it bigger')
    // The same call gives the same answer.
    expect(await ids(pid)).toEqual([ask.id, reply.id])

    // An agent's reply under the reply takes it off; the top-level post stays until it is answered.
    agentReply(progress.id, 'fixed on mobile', T(11))
    expect(await ids(pid)).toEqual([ask.id])
    // A reply under the post answers it.
    agentReply(ask.id, 'plan: bigger font', T(12))
    expect(await ids(pid)).toEqual([])
    // The human speaking again after the agent is a new comment waiting.
    const again = humanReply(ask.id, 'and the footer', T(13))
    expect(await ids(pid)).toEqual([again.id])
  })

  it('counts a later discussion post by an agent as the answer, but not a progress post or a summary', async () => {
    const pid = newProject('feed')
    const t = features.createTicket(pid, { title: 'feed', assignee: AGENT }, HUMAN)
    const ask = humanPost(t.id, 'status?', T(9))
    said(features.postUpdate(t.id, 'working on it', [], AGENT, { progress: true }), T(10))
    const summary = features.setSummary(t.id, { body: 'state now' }, AGENT)
    said({ id: summary.postId, ticketId: t.id }, T(11))
    expect(await ids(pid)).toEqual([ask.id])
    // The human's own later post does not answer it.
    const second = humanPost(t.id, 'hello?', T(12))
    expect(await ids(pid)).toEqual([ask.id, second.id])
    said(features.postUpdate(t.id, 'sorry, on it', [], AGENT, { progress: false }), T(13))
    expect(await ids(pid)).toEqual([])
    // A human post before the agent's answer stays answered; one after it waits.
    const later = humanPost(t.id, 'thanks, and one more', T(14))
    expect(await ids(pid)).toEqual([later.id])
  })

  it('shows a comment on a ticket assigned to another agent or to nobody, and a persona’s reply answers it', async () => {
    const agents = await import('./projectAgents')
    const pid = newProject('others')
    agents.createAgent(pid, { name: 'Designer' }, HUMAN)
    const mine = features.createTicket(pid, { title: 'mine', assignee: AGENT }, HUMAN)
    const theirs = features.createTicket(pid, { title: 'theirs', assignee: 'codex' }, HUMAN)
    const nobody = features.createTicket(pid, { title: 'nobody' }, HUMAN)
    const a = humanPost(mine.id, 'a', T(9))
    const b = humanPost(theirs.id, 'b', T(10))
    const c = humanPost(nobody.id, 'c', T(11))
    expect(await ids(pid)).toEqual([a.id, b.id, c.id])
    // A project agent's persona answering through a connected agent addresses it.
    agentReply(c.id, 'on it', T(12), 'Designer')
    expect(await ids(pid)).toEqual([a.id, b.id])
  })

  it('never shows another project’s comments', async () => {
    const one = newProject('one')
    const two = newProject('two')
    const t1 = features.createTicket(one, { title: 'one' }, HUMAN)
    const t2 = features.createTicket(two, { title: 'two' }, HUMAN)
    const a = humanPost(t1.id, 'in one', T(9))
    const b = humanPost(t2.id, 'in two', T(10))
    expect(await ids(one)).toEqual([a.id])
    expect(await ids(two)).toEqual([b.id])
  })

  it('leaves out archived and cancelled tickets and their lanes, and keeps a done one', async () => {
    const pid = newProject('closed')
    const done = features.createTicket(pid, { title: 'shipped', status: 'done' }, HUMAN)
    const dropped = features.createTicket(pid, { title: 'dropped', status: 'cancelled' }, HUMAN)
    const archived = features.createTicket(pid, { title: 'old', status: 'done' }, HUMAN)
    const lane = features.createTicket(pid, { title: 'lane', parentId: dropped.id }, HUMAN)
    const live = features.createTicket(pid, { title: 'live' }, HUMAN)
    const a = humanPost(done.id, 'broke after merge', T(9))
    humanPost(dropped.id, 'dropped', T(10))
    humanPost(archived.id, 'archived', T(11))
    humanPost(lane.id, 'lane of dropped', T(12))
    const e = humanPost(live.id, 'live', T(13))
    features.archiveTicket(archived.id, HUMAN)
    expect(await ids(pid)).toEqual([a.id, e.id])
  })

  it('does not count an answered decision card, and the human only: an agent’s words never wait', async () => {
    const pid = newProject('cards')
    const t = features.createTicket(pid, { title: 'cards', assignee: AGENT }, HUMAN)
    const card = features.askDecision(
      t.id,
      { body: 'which?', options: [{ label: 'a' }, { label: 'b' }] },
      AGENT,
    )
    said(card, T(9))
    // An agent posts and replies; nothing is the human's.
    said(features.postUpdate(t.id, 'q for you', [], AGENT, { progress: false }), T(10))
    agentReply(card.id, 'more detail', T(11))
    expect(await ids(pid)).toEqual([])
  })

  it('carries a comment’s attachments with a local path, and is an MCP tool', async () => {
    const pid = newProject('files')
    const t = features.createTicket(pid, { title: 'pics' }, HUMAN)
    const post = humanPost(t.id, 'see the picture', T(9))
    const uploads = await import('./uploads')
    const file = path.join(tmp, 'shot.png')
    fs.writeFileSync(file, 'png-bytes')
    const att = await uploads.saveFromPath(file, HUMAN)
    uploads.attachTo([att.id], { updateId: post.id })

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
          id: 1,
          method: 'tools/call',
          params: { name: 'latest_actions', arguments: { projectId: pid } },
        }),
      }),
      AGENT,
    )
    const result = (await res.json()) as { result: { content: { text: string }[] } }
    const out = JSON.parse(result.result.content[0]!.text)
    expect(out.count).toBe(1)
    expect(out.comments[0]).toMatchObject({
      id: post.id,
      attachments: [{ name: 'shot.png', path: expect.any(String) }],
    })
    expect(fs.existsSync(out.comments[0].attachments[0].path)).toBe(true)
  })
})
