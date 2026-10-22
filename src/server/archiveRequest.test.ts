import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { and, eq, isNotNull } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-archive-request-'))
process.env.DATA_DIR = tmp

const HUMAN = 'enrique'
const AGENT = 'claude'

let dbm: typeof import('#/db')
let features: typeof import('./features')
let summary: typeof import('./summary')
let handle: (request: Request) => Promise<Response>
beforeAll(async () => {
  dbm = await import('#/db')
  features = await import('./features')
  summary = await import('./summary')
  // The human signed in: who a relayed archive goes to.
  ;(await import('./actors')).noteActor(HUMAN, 'human')
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  // As the server answers: an HttpError becomes its status with `{error}`. A bearer token is an agent.
  const guarded = guard(({ request }: { request: Request }) =>
    api.handle(request, request.headers.has('authorization') ? AGENT : HUMAN),
  )
  handle = (request) => guarded({ request })
})

function newProject(name: string) {
  const id = dbm.db.insert(dbm.schema.projects).values({ name }).returning().get().id
  dbm.db
    .insert(dbm.schema.repos)
    .values({ projectId: id, name: 'app', repoPath: `/r/${name}` })
    .run()
  return id
}

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
async function rpc(method: string, params: Record<string, unknown> = {}, as: 'human' | 'agent' = 'agent') {
  const { handleMcp } = await import('./mcp')
  const res = await handleMcp(
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(as === 'agent' ? { authorization: 'Bearer gate_test' } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    }),
    as === 'agent' ? AGENT : HUMAN,
  )
  return ((await res.json()) as { result: any }).result
}
/** A tool call's answer: its parsed result, or `{error}` with the message of a refused call. */
async function tool(name: string, args: Record<string, unknown>, as: 'human' | 'agent' = 'agent') {
  const result = (await rpc('tools/call', { name, arguments: args }, as)) as {
    isError?: boolean
    content: { text: string }[]
  }
  return result.isError ? { error: result.content[0]!.text } : JSON.parse(result.content[0]!.text)
}

/** What a refused call says: its status and message. */
function refusal(run: () => unknown) {
  try {
    run()
  } catch (err) {
    const e = err as { status?: number; message: string }
    return { status: e.status, message: e.message }
  }
  throw new Error('the call went through')
}

const decisionsOn = (ticketId: number) =>
  dbm.db
    .select()
    .from(dbm.schema.updates)
    .where(and(eq(dbm.schema.updates.ticketId, ticketId), isNotNull(dbm.schema.updates.decision)))
    .all()
const activity = (projectId: number) =>
  dbm.db.select().from(dbm.schema.activity).where(eq(dbm.schema.activity.projectId, projectId)).all()
const replies = (postId: number) =>
  dbm.db
    .select()
    .from(dbm.schema.comments)
    .where(and(eq(dbm.schema.comments.parentType, 'update'), eq(dbm.schema.comments.parentId, postId)))
    .all()

describe('asking to archive', () => {
  it('posts one Archive / Keep card naming the tickets over MCP, one ticket or a list, moving none', async () => {
    const pid = newProject('mcp-ask')
    const a = features.createTicket(pid, { title: 'shipped', status: 'done' }, HUMAN)
    const b = features.createTicket(pid, { title: 'dropped', status: 'cancelled' }, HUMAN)
    const c = features.createTicket(pid, { title: 'alone', status: 'done' }, HUMAN)

    const card = await tool('request_archive', { ticketIds: [a.id, b.id] })
    expect(card).toMatchObject({
      ticketId: a.id,
      author: AGENT,
      tab: 'main',
      decidedAt: null,
      archiveTickets: [a.id, b.id],
      decision: [{ label: 'Archive' }, { label: 'Keep' }],
    })
    expect(card.body.split('\n')[0]).toBe(`Archive #${a.id}, #${b.id}?`)
    expect(card.body).toContain(`#${a.id} shipped (Done)`)
    expect(card.body).toContain(`#${b.id} dropped (Cancelled)`)
    // The card does not block: a finished ticket stays where it is.
    expect(features.getTicket(a.id).status).toBe('done')
    expect(features.getTicket(b.id).status).toBe('cancelled')
    expect(features.getTicket(a.id).archivedAt).toBeNull()

    const one = await tool('request_archive', { ticketIds: c.id })
    expect(one).toMatchObject({ ticketId: c.id, archiveTickets: [c.id] })
    expect(one.body.split('\n')[0]).toBe(`Archive #${c.id}?`)

    // The activity says the agent asked, naming the tickets.
    expect(activity(pid)).toContainEqual(
      expect.objectContaining({
        actor: AGENT,
        text: `asked to archive #${a.id} shipped, #${b.id} dropped`,
      }),
    )
  })

  it('is an agent’s over MCP and REST: the human archives directly', async () => {
    const pid = newProject('human-asks')
    const t = features.createTicket(pid, { title: 'done', status: 'done' }, HUMAN)
    expect(await tool('request_archive', { ticketIds: [t.id] }, 'human')).toEqual({
      error: 'the human archives tickets directly; agents ask here',
    })
    const rest = await call(
      'POST',
      `/api/projects/${pid}/tickets/archive-request`,
      { ticketIds: [t.id] },
      'human',
    )
    expect(rest.status).toBe(403)
    expect(decisionsOn(t.id)).toEqual([])
  })

  it('has a REST route for agents that does the same, and refuses the same', async () => {
    const pid = newProject('rest-ask')
    const other = newProject('rest-other')
    const a = features.createTicket(pid, { title: 'a', status: 'done' }, HUMAN)
    const open = features.createTicket(pid, { title: 'open', status: 'in_progress' }, HUMAN)
    const elsewhere = features.createTicket(other, { title: 'elsewhere', status: 'done' }, HUMAN)

    const asked = await call('POST', `/api/projects/${pid}/tickets/archive-request`, { ticketIds: [a.id] })
    expect(asked.status).toBe(201)
    expect(asked.body).toMatchObject({
      ticketId: a.id,
      archiveTickets: [a.id],
      decision: [{ label: 'Archive' }, { label: 'Keep' }],
    })

    const refused = await call('POST', `/api/projects/${pid}/tickets/archive-request`, {
      ticketIds: [open.id],
    })
    expect(refused.status).toBe(409)
    expect(refused.body.error).toContain(`#${open.id} is in In progress`)
    const foreign = await call('POST', `/api/projects/${pid}/tickets/archive-request`, {
      ticketIds: [elsewhere.id],
    })
    expect(foreign.status).toBe(400)
    expect(
      await call('POST', `/api/projects/${pid}/tickets/archive-request`, { ticketIds: [] }),
    ).toMatchObject({
      status: 400,
    })
    expect(decisionsOn(open.id)).toEqual([])
    expect(decisionsOn(elsewhere.id)).toEqual([])
  })

  it('shows in Needs you, counted', async () => {
    const pid = newProject('needs-you')
    const t = features.createTicket(pid, { title: 'shipped', status: 'done' }, HUMAN)
    const card = features.requestArchive([t.id], {}, AGENT)
    const needsYou = summary.getSummary(pid, { humans: [HUMAN] }).projects[0]!.needsYou
    expect(needsYou.decisions).toEqual([
      expect.objectContaining({ postId: card.id, ticketId: t.id, question: `Archive #${t.id}?`, options: 2 }),
    ])
    // Nothing else waits on the human in this project: the card is what the total counts.
    expect(needsYou.total).toBe(1)
    features.decide(card.id, 1, '', HUMAN)
    expect(summary.getSummary(pid, { humans: [HUMAN] }).projects[0]!.needsYou.decisions).toEqual([])
  })
})

describe('the rules of a request', () => {
  let pid: number
  beforeAll(() => {
    pid = newProject('rules')
  })

  it('refuses a ticket not in a done or cancelled stage, naming it and its stage', () => {
    const t = features.createTicket(pid, { title: 'in review', status: 'review' }, HUMAN)
    expect(refusal(() => features.requestArchive([t.id], {}, AGENT))).toEqual({
      status: 409,
      message: `nothing was asked: #${t.id} is in In review; only done or cancelled tickets are archived`,
    })
    expect(decisionsOn(t.id)).toEqual([])
  })

  it('refuses a ticket already archived', () => {
    const t = features.createTicket(pid, { title: 'gone', status: 'done' }, HUMAN)
    features.archiveTicket(t.id, HUMAN)
    expect(refusal(() => features.requestArchive([t.id], {}, AGENT))).toEqual({
      status: 409,
      message: `nothing was asked: #${t.id} is already archived`,
    })
    expect(decisionsOn(t.id)).toEqual([])
  })

  it('refuses a lane: saying its parent is still open, or to ask for the parent', () => {
    const parent = features.createTicket(pid, { title: 'parent', status: 'in_progress' }, HUMAN)
    const lane = features.createTicket(pid, { title: 'lane', parentId: parent.id, status: 'done' }, AGENT)
    expect(refusal(() => features.requestArchive([lane.id], {}, AGENT))).toEqual({
      status: 409,
      message: `nothing was asked: #${lane.id} is a lane of #${parent.id}, which is still open (In progress): a lane is archived with its ticket`,
    })
    features.updateTicket(parent.id, { status: 'done' }, HUMAN)
    expect(refusal(() => features.requestArchive([lane.id], {}, AGENT))).toEqual({
      status: 409,
      message: `nothing was asked: #${lane.id} is a lane: it is archived with its ticket #${parent.id}, so ask for #${parent.id} instead`,
    })
    expect(decisionsOn(lane.id)).toEqual([])
    expect(decisionsOn(parent.id)).toEqual([])
  })

  it('refuses a list with any ineligible ticket whole, naming every failing one', () => {
    const ok = features.createTicket(pid, { title: 'ok', status: 'done' }, HUMAN)
    const open = features.createTicket(pid, { title: 'open', status: 'todo' }, HUMAN)
    const gone = features.createTicket(pid, { title: 'gone too', status: 'cancelled' }, HUMAN)
    features.archiveTicket(gone.id, HUMAN)
    const before = [ok, open, gone].map((t) => decisionsOn(t.id).length)
    const refused = refusal(() => features.requestArchive([ok.id, open.id, gone.id], {}, AGENT))
    expect(refused.status).toBe(409)
    expect(refused.message).toContain(`#${open.id} is in To do`)
    expect(refused.message).toContain(`#${gone.id} is already archived`)
    expect(refused.message).not.toContain(`#${ok.id} `)
    expect([ok, open, gone].map((t) => decisionsOn(t.id).length)).toEqual(before)
  })

  it('refuses tickets of two projects, an empty list, and an unknown ticket', () => {
    const other = newProject('rules-other')
    const here = features.createTicket(pid, { title: 'here', status: 'done' }, HUMAN)
    const there = features.createTicket(other, { title: 'there', status: 'done' }, HUMAN)
    expect(refusal(() => features.requestArchive([here.id, there.id], {}, AGENT))).toMatchObject({
      status: 400,
    })
    expect(refusal(() => features.requestArchive([], {}, AGENT))).toMatchObject({ status: 400 })
    expect(refusal(() => features.requestArchive([999_999], {}, AGENT))).toMatchObject({ status: 404 })
    expect(decisionsOn(here.id)).toEqual([])
  })
})

describe('answering a request', () => {
  let pid: number
  beforeAll(() => {
    pid = newProject('answers')
  })

  it('Archive on the board archives every ticket and its lanes, by the human, in their stage', () => {
    const a = features.createTicket(pid, { title: 'a', status: 'done' }, HUMAN)
    const lane = features.createTicket(pid, { title: 'a lane', parentId: a.id, status: 'review' }, AGENT)
    const b = features.createTicket(pid, { title: 'b', status: 'cancelled' }, HUMAN)
    const card = features.requestArchive([a.id, b.id], {}, AGENT)
    // Asking alone archives nothing.
    for (const id of [a.id, lane.id, b.id]) expect(features.getTicket(id).archivedAt).toBeNull()

    const answered = features.decide(card.id, 0, '', HUMAN)
    expect(answered.archive).toEqual({ archived: [a.id, b.id], already: [], skipped: [] })
    for (const id of [a.id, lane.id, b.id])
      expect(features.getTicket(id)).toMatchObject({ archivedAt: expect.any(String), archivedBy: HUMAN })
    expect(features.getTicket(a.id).status).toBe('done')
    expect(features.getTicket(b.id).status).toBe('cancelled')
    expect(features.getTicket(lane.id).status).toBe('review')
    const listed = features.listTickets(pid).map((t) => t.id)
    for (const id of [a.id, lane.id, b.id]) expect(listed).not.toContain(id)
    expect(features.getPost(card.id)).toMatchObject({ decidedOption: 0, decidedBy: HUMAN })

    // The archive lines are the human's and say the agent asked.
    const log = activity(pid)
    expect(log).toContainEqual(
      expect.objectContaining({
        actor: HUMAN,
        text: `archived ticket #${a.id} a (with 1 lane), as ${AGENT} asked`,
      }),
    )
    expect(log).toContainEqual(
      expect.objectContaining({ actor: HUMAN, text: `archived ticket #${b.id} b, as ${AGENT} asked` }),
    )
    expect(replies(card.id).map((r) => r.body)).toEqual([
      `Decided: **Archive**\n\nArchived #${a.id}, #${b.id}.`,
    ])
  })

  it('Keep changes nothing; changing it to Archive then archives', () => {
    const t = features.createTicket(pid, { title: 'kept', status: 'done' }, HUMAN)
    const card = features.requestArchive([t.id], {}, AGENT)
    const kept = features.decide(card.id, 1, '', HUMAN)
    expect(kept.archive).toBeNull()
    expect(features.getTicket(t.id)).toMatchObject({ archivedAt: null, archivedBy: '', status: 'done' })
    expect(features.getPost(card.id)).toMatchObject({ decidedOption: 1, decidedBy: HUMAN })

    features.decide(card.id, 0, '', HUMAN)
    expect(features.getTicket(t.id)).toMatchObject({ archivedBy: HUMAN, status: 'done' })
    // Back to Keep restores nothing: that stays the human's own restore.
    features.decide(card.id, 1, '', HUMAN)
    expect(features.getTicket(t.id).archivedAt).not.toBeNull()
  })

  it('a relayed Archive archives in the human’s name, never the relaying agent’s', () => {
    const t = features.createTicket(pid, { title: 'relayed', status: 'done' }, HUMAN)
    const card = features.requestArchive([t.id], {}, AGENT)
    const relay = (input: { option: number; words: string; as?: string }, actor = AGENT, agent = true) =>
      features.relayDecision(card.id, input, actor, { agent })

    // The relay's refusals still hold, and archive nothing.
    expect(refusal(() => relay({ option: 0, words: 'archive it', as: 'builder' }))).toMatchObject({
      status: 403,
    })
    expect(refusal(() => relay({ option: 0, words: 'archive it' }, HUMAN, false))).toMatchObject({
      status: 403,
    })
    expect(features.getTicket(t.id).archivedAt).toBeNull()

    const row = relay({ option: 0, words: 'yes, archive it' })
    expect(row).toMatchObject({
      decidedBy: '',
      relayedBy: AGENT,
      archive: { archived: [t.id], already: [], skipped: [] },
    })
    expect(features.getTicket(t.id)).toMatchObject({ archivedAt: expect.any(String), archivedBy: HUMAN })
    expect(activity(pid)).toContainEqual(
      expect.objectContaining({
        actor: HUMAN,
        text: `archived ticket #${t.id} relayed, as ${AGENT} asked (answered in chat, relayed by ${AGENT})`,
      }),
    )
    // Decided already: a second relay is refused.
    expect(refusal(() => relay({ option: 0, words: 'again' }))).toMatchObject({ status: 409 })
  })

  it('skips a ticket no longer finished, counts one archived meanwhile as archived, and says so', () => {
    const reopened = features.createTicket(pid, { title: 'reopened', status: 'done' }, HUMAN)
    const archived = features.createTicket(pid, { title: 'archived meanwhile', status: 'done' }, HUMAN)
    const still = features.createTicket(pid, { title: 'still done', status: 'done' }, HUMAN)
    const card = features.requestArchive([reopened.id, archived.id, still.id], {}, AGENT)
    features.updateTicket(reopened.id, { status: 'in_progress' }, HUMAN)
    features.archiveTicket(archived.id, HUMAN)

    const answered = features.decide(card.id, 0, '', HUMAN)
    expect(answered.archive).toEqual({
      archived: [still.id],
      already: [archived.id],
      skipped: [
        {
          id: reopened.id,
          why: `#${reopened.id} is in In progress; only done or cancelled tickets are archived`,
        },
      ],
    })
    expect(features.getTicket(reopened.id)).toMatchObject({ archivedAt: null, status: 'in_progress' })
    expect(features.getTicket(still.id).archivedBy).toBe(HUMAN)
    expect(features.getPost(card.id).decidedOption).toBe(0)
    expect(replies(card.id).at(-1)!.body).toBe(
      `Decided: **Archive**\n\nArchived #${still.id}.\n\nAlready archived: #${archived.id}.\n\nNot archived: #${reopened.id} is in In progress; only done or cancelled tickets are archived.`,
    )
  })

  it('an ordinary card with an Archive option archives nothing', () => {
    const t = features.createTicket(pid, { title: 'plain card', status: 'done' }, HUMAN)
    const card = features.askDecision(
      t.id,
      { body: 'Archive it?', options: [{ label: 'Archive' }, { label: 'Keep' }], block: false },
      AGENT,
    )
    expect(card.archiveTickets).toBeNull()
    expect(features.decide(card.id, 0, '', HUMAN).archive).toBeNull()
    expect(features.getTicket(t.id).archivedAt).toBeNull()
  })

  it('every Archive archives: a ticket restored since goes back, one still archived is not an error', () => {
    const a = features.createTicket(pid, { title: 'restored since', status: 'done' }, HUMAN)
    const b = features.createTicket(pid, { title: 'still archived', status: 'done' }, HUMAN)
    const card = features.requestArchive([a.id, b.id], {}, AGENT)
    expect(features.decide(card.id, 0, '', HUMAN).archive).toEqual({
      archived: [a.id, b.id],
      already: [],
      skipped: [],
    })
    const archivedAt = features.getTicket(b.id).archivedAt
    features.restoreTicket(a.id, HUMAN)
    expect(features.getTicket(a.id).archivedAt).toBeNull()

    const again = features.decide(card.id, 0, '', HUMAN)
    expect(again.archive).toEqual({ archived: [a.id], already: [b.id], skipped: [] })
    expect(features.getTicket(a.id)).toMatchObject({ archivedAt: expect.any(String), archivedBy: HUMAN })
    expect(features.getTicket(b.id).archivedAt).toBe(archivedAt)
    expect(replies(card.id).at(-1)!.body).toBe(
      `Changed the decision to: **Archive**\n\nArchived #${a.id}.\n\nAlready archived: #${b.id}.`,
    )
  })

  it('the human’s Archive after a relayed Archive reports the tickets as archived already, not as an error', () => {
    const t = features.createTicket(pid, { title: 'relayed then picked', status: 'done' }, HUMAN)
    const card = features.requestArchive([t.id], {}, AGENT)
    features.relayDecision(card.id, { option: 0, words: 'archive it' }, AGENT, { agent: true })
    const archivedAt = features.getTicket(t.id).archivedAt
    expect(archivedAt).not.toBeNull()

    const picked = features.decide(card.id, 0, '', HUMAN)
    expect(picked.archive).toEqual({ archived: [], already: [t.id], skipped: [] })
    expect(features.getPost(card.id)).toMatchObject({ decidedOption: 0, decidedBy: HUMAN, relayedBy: '' })
    expect(features.getTicket(t.id).archivedAt).toBe(archivedAt)
    expect(
      replies(card.id)
        .map((r) => r.body)
        .join('\n'),
    ).not.toContain('Not archived')
    expect(replies(card.id).at(-1)!.body).toBe(
      `Changed the decision to: **Archive**\n\nAlready archived: #${t.id}.`,
    )
  })
})

describe('the card stays as asked', () => {
  let pid: number
  beforeAll(() => {
    pid = newProject('card-stays')
  })

  it('refuses editing its body over REST, to the agent and the human, and Archive archives just the named tickets', async () => {
    const a = features.createTicket(pid, { title: 'a', status: 'done' }, HUMAN)
    const b = features.createTicket(pid, { title: 'b', status: 'done' }, HUMAN)
    const asked = await call('POST', `/api/projects/${pid}/tickets/archive-request`, {
      ticketIds: [a.id, b.id],
    })
    expect(asked.status).toBe(201)
    const body = asked.body.body as string

    for (const as of ['agent', 'human'] as const) {
      const edit = await call('PATCH', `/api/updates/${asked.body.id}`, { body: `Archive #${a.id}?` }, as)
      expect(edit.status, as).toBe(409)
      expect(edit.body.error).toContain("an archive request's card names the tickets it archives")
    }
    // Moving it to another tab of the feed leaves its words as they were.
    expect((await call('PATCH', `/api/updates/${asked.body.id}`, { tab: 'agents' })).status).toBe(200)
    expect(features.getPost(asked.body.id)).toMatchObject({
      body,
      editedAt: null,
      archiveTickets: [a.id, b.id],
    })

    const answered = await call('PUT', `/api/updates/${asked.body.id}/decision`, { option: 0 }, 'human')
    expect(answered.body.archive).toEqual({ archived: [a.id, b.id], already: [], skipped: [] })
  })

  it('refuses editing its body over MCP, and Archive archives just the named tickets', async () => {
    const a = features.createTicket(pid, { title: 'mcp a', status: 'done' }, HUMAN)
    const b = features.createTicket(pid, { title: 'mcp b', status: 'cancelled' }, HUMAN)
    const other = features.createTicket(pid, { title: 'not named', status: 'done' }, HUMAN)
    const card = await tool('request_archive', { ticketIds: [a.id, b.id] })
    const edit = await tool('edit_post', { id: card.id, body: `Archive #${other.id}?` })
    expect(edit.error).toContain("an archive request's card names the tickets it archives")
    expect(features.getPost(card.id).body).toBe(card.body)

    expect(features.decide(card.id, 0, '', HUMAN).archive).toEqual({
      archived: [a.id, b.id],
      already: [],
      skipped: [],
    })
    expect(features.getTicket(other.id).archivedAt).toBeNull()
  })
})

describe('an agent cannot archive without the human', () => {
  it('gets 403 on every archive route and on answering the card, and the request leaves it on the board', async () => {
    const pid = newProject('no-confirm')
    const t = features.createTicket(pid, { title: 'done', status: 'done' }, HUMAN)
    const asked = await call('POST', `/api/projects/${pid}/tickets/archive-request`, { ticketIds: [t.id] })
    expect(asked.status).toBe(201)
    expect((await call('POST', `/api/tickets/${t.id}/archive`)).status).toBe(403)
    expect((await call('POST', `/api/projects/${pid}/tickets/archive`, { status: 'done' })).status).toBe(403)
    expect((await call('PUT', `/api/updates/${asked.body.id}/decision`, { option: 0 })).status).toBe(403)
    expect(features.getTicket(t.id).archivedAt).toBeNull()
    expect(features.getPost(asked.body.id).decidedAt).toBeNull()

    // No MCP tool archives directly: request_archive is the only one about the archive.
    const { tools } = (await rpc('tools/list')) as { tools: { name: string }[] }
    expect(tools.map((x) => x.name).filter((n) => /archive/.test(n))).toEqual(['request_archive'])

    // The human's answer is what archives.
    const answered = await call('PUT', `/api/updates/${asked.body.id}/decision`, { option: 0 }, 'human')
    expect(answered.status).toBe(200)
    expect(answered.body.archive).toEqual({ archived: [t.id], already: [], skipped: [] })
    expect(features.getTicket(t.id).archivedBy).toBe(HUMAN)
  })
})
