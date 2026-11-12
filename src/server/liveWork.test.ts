import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it, vi } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-live-work-'))
process.env.DATA_DIR = tmp

const MIN = 60_000
/** The clock every read here is measured against: events are seeded relative to it. */
const NOW = new Date()
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * MIN)
const iso = (d: Date) => d.toISOString()

let liveWork: typeof import('./liveWork')
let dbm: typeof import('#/db')
let stagesMod: typeof import('./stages')

beforeAll(async () => {
  liveWork = await import('./liveWork')
  dbm = await import('#/db')
  stagesMod = await import('./stages')
})

const db = () => dbm.db

function project(name: string, values: Partial<typeof dbm.schema.projects.$inferInsert> = {}) {
  const p = db()
    .insert(dbm.schema.projects)
    .values({ name, ...values })
    .returning()
    .get()
  db()
    .insert(dbm.schema.repos)
    .values({ projectId: p.id, name: 'api', repoPath: `/r/${name}` })
    .run()
  // The default stages, so kinds mean what they say.
  stagesMod.listStages(p.id)
  return p.id
}

function ticket(
  projectId: number,
  title: string,
  values: Partial<typeof dbm.schema.tickets.$inferInsert> = {},
) {
  const created = values.createdAt ?? iso(ago(200))
  return db()
    .insert(dbm.schema.tickets)
    .values({
      projectId,
      title,
      status: 'todo',
      createdBy: 'enrique',
      createdAt: created,
      updatedAt: values.updatedAt ?? created,
      ...values,
    })
    .returning()
    .get()
}

function event(
  projectId: number,
  ticketId: number,
  values: Partial<typeof dbm.schema.ticketEvents.$inferInsert> & { at: string },
) {
  return db()
    .insert(dbm.schema.ticketEvents)
    .values({ projectId, ticketId, kind: 'heartbeat', agent: 'claude', by: 'claude', ...values })
    .returning()
    .get()
}

function post(
  ticketId: number,
  body: string,
  when: Date,
  values: Partial<typeof dbm.schema.updates.$inferInsert> = {},
) {
  return db()
    .insert(dbm.schema.updates)
    .values({ ticketId, author: 'claude', body, progress: true, createdAt: iso(when), ...values })
    .returning()
    .get()
}

function task(ticketId: number, text: string, values: Partial<typeof dbm.schema.tasks.$inferInsert> = {}) {
  return db()
    .insert(dbm.schema.tasks)
    .values({ ticketId, text, ...values })
    .returning()
    .get()
}

const read = (projectId: number, opts: { now?: Date; windowMinutes?: number } = {}) =>
  liveWork.getLiveWork(projectId, { now: NOW, ...opts })

/** A call through the API as the server answers it: an HttpError becomes its status with `{error}`. */
async function call(method: string, pathname: string) {
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  const handle = guard(({ request }: { request: Request }) => api.handle(request, 'claude'))
  return handle({
    request: new Request(`http://localhost${pathname}`, {
      method,
      headers: { accept: 'application/json, text/event-stream' },
    }),
  })
}

let rpcId = 0
async function rpc(method: string, params: Record<string, unknown> = {}) {
  const { handleMcp } = await import('./mcp')
  const res = await handleMcp(
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer gate_test',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    }),
    'claude',
  )
  return ((await res.json()) as { result: any }).result
}

/** A tool call's answer: its parsed result, or `{error}` with the message of a refused call. */
async function tool(name: string, args: Record<string, unknown>) {
  const result = (await rpc('tools/call', { name, arguments: args })) as {
    isError?: boolean
    content: { text: string }[]
  }
  return result.isError ? { error: result.content[0]!.text } : JSON.parse(result.content[0]!.text)
}

describe('one read of what is happening', () => {
  it('answers in one call with every part, the clock it measured against and the totals', async () => {
    const pid = project('one-read')
    const live = ticket(pid, 'Build the parser', { status: 'in_progress' })
    event(pid, live.id, { kind: 'heartbeat', agent: 'opencode/ticket-846', at: iso(ago(5)) })

    const answer = await tool('get_live_work', { projectId: pid })
    expect(answer.error).toBeUndefined()
    expect(Object.keys(answer).sort()).toEqual(
      [
        'inReview',
        'liveNow',
        'now',
        'project',
        'recentPosts',
        'recentlyActive',
        'stallMinutes',
        'totals',
        'waitingOnHuman',
        'windowMinutes',
      ].sort(),
    )
    expect(answer.now).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(answer.project).toEqual({ id: pid, name: 'one-read' })
    expect(answer.windowMinutes).toBe(30)
    expect(answer.stallMinutes).toBe(30)
    expect(answer.liveNow.map((t: { ticketId: number }) => t.ticketId)).toContain(live.id)
    expect(answer.totals).toEqual({
      liveNow: answer.liveNow.length,
      recentlyActive: answer.recentlyActive.length,
      waitingOnHuman: answer.waitingOnHuman.length,
      inReview: answer.inReview.length,
      tickets: 1,
    })
  })
})

describe('live now', () => {
  it('carries the ticket, its agent names, phase and round, when it was last heard from and its wait', () => {
    const pid = project('live')
    const t = ticket(pid, 'Wire the parser', { status: 'in_progress', assignee: 'claude' })
    event(pid, t.id, {
      kind: 'span_start',
      agent: 'opencode/ticket-846',
      phase: 'build',
      round: 2,
      at: iso(ago(20)),
    })
    event(pid, t.id, { kind: 'heartbeat', agent: 'opencode/ticket-846', at: iso(ago(5)) })
    const wait = event(pid, t.id, {
      kind: 'wait_start',
      agent: 'opencode/ticket-846',
      reason: 'builder',
      note: 'waiting for the review to come back',
      at: iso(ago(10)),
    })

    const entry = read(pid).liveNow.find((x) => x.ticketId === t.id)!
    expect(entry).toMatchObject({
      title: 'Wire the parser',
      status: 'in_progress',
      stage: { key: 'in_progress', name: 'In progress', kind: 'active' },
      parent: null,
      phase: 'build',
      round: 2,
      lastHeardAt: iso(ago(5)),
      lastHeardBy: 'opencode/ticket-846',
      silentMinutes: 5,
      stalled: false,
      waitingFor: {
        reason: 'builder',
        note: 'waiting for the review to come back',
        agent: 'opencode/ticket-846',
        on: null,
        since: iso(ago(10)),
      },
    })
    expect(entry.agents).toContain('opencode/ticket-846')

    // Its wait ended: still live (the span is open), with no wait to show.
    event(pid, t.id, {
      kind: 'wait_end',
      agent: 'opencode/ticket-846',
      reason: 'builder',
      refId: wait.id,
      at: iso(ago(4)),
    })
    const after = read(pid).liveNow.find((x) => x.ticketId === t.id)!
    expect(after.waitingFor).toBeNull()
    expect(after.lastHeardAt).toBe(iso(ago(4)))
  })

  it('includes a lane and the assignee when no event names an agent', () => {
    const pid = project('live-lane')
    const parent = ticket(pid, 'The whole change', { status: 'in_progress', assignee: 'codex' })
    const lane = ticket(pid, 'Its docs', { status: 'in_progress', parentId: parent.id, assignee: 'codex' })
    event(pid, lane.id, { kind: 'heartbeat', at: iso(ago(3)) })
    // A wait nobody signed: the assignee is the only name the board has.
    event(pid, parent.id, { kind: 'wait_start', agent: '', reason: 'lock', at: iso(ago(2)) })

    const entries = read(pid).liveNow
    const entry = entries.find((x) => x.ticketId === lane.id)!
    expect(entry.parent).toEqual({ id: parent.id, title: 'The whole change' })
    // The heartbeat's agent is on it; lastHeardBy names the same one.
    expect(entry.agents).toEqual(['claude'])
    expect(entry.lastHeardBy).toBe('claude')
    const waited = entries.find((x) => x.ticketId === parent.id)!
    expect(waited.agents).toEqual(['codex'])
    expect(waited.waitingFor).toMatchObject({ reason: 'lock', agent: '' })
  })
})

describe('recently active, nothing running', () => {
  it('lists what was heard from before the window with the summary line', () => {
    const pid = project('recent')
    const summarised = ticket(pid, 'Reviewed already', { status: 'in_progress' })
    const span = event(pid, summarised.id, { kind: 'span_start', phase: 'build', at: iso(ago(150)) })
    event(pid, summarised.id, {
      kind: 'span_end',
      phase: 'build',
      refId: span.id,
      at: iso(ago(130)),
    })
    post(summarised.id, 'Waiting on the parser review\n\nmore detail below', ago(120), {
      summary: true,
      progress: false,
      tab: 'main',
    })

    const posted = ticket(pid, 'Progress only', { status: 'in_progress' })
    event(pid, posted.id, { kind: 'heartbeat', at: iso(ago(90)) })
    post(posted.id, 'Step two done\n\nthe rest is next', ago(85))
    // Finished work is not something to pick up, so it is in neither list.
    const finished = ticket(pid, 'Already done', { status: 'done' })
    event(pid, finished.id, { kind: 'heartbeat', at: iso(ago(180)) })

    const payload = read(pid)
    const liveIds = payload.liveNow.map((x) => x.ticketId)
    expect(liveIds).not.toContain(summarised.id)
    expect(liveIds).not.toContain(posted.id)

    const one = payload.recentlyActive.find((x) => x.ticketId === summarised.id)!
    expect(one).toMatchObject({
      title: 'Reviewed already',
      lastHeardAt: iso(ago(130)),
      lastSignalAt: iso(ago(130)),
      silentMinutes: 130,
      state: 'Waiting on the parser review',
    })
    const two = payload.recentlyActive.find((x) => x.ticketId === posted.id)!
    expect(two).toMatchObject({ lastHeardAt: iso(ago(90)), silentMinutes: 90, state: 'Step two done' })
    // Newest word first.
    expect(payload.recentlyActive.map((x) => x.ticketId)).toEqual([posted.id, summarised.id])
    expect(payload.recentlyActive.map((x) => x.ticketId)).not.toContain(finished.id)
  })

  it('leaves the state empty when the ticket has neither a summary nor a progress post', () => {
    const pid = project('no-state')
    const t = ticket(pid, 'Nothing said yet', { status: 'in_progress' })
    event(pid, t.id, { kind: 'heartbeat', at: iso(ago(90)) })
    expect(read(pid).recentlyActive.find((x) => x.ticketId === t.id)).toMatchObject({ state: '' })
  })
})

describe('waiting on the human', () => {
  it('lists decisions, blocked next steps and blocked tickets, one row a ticket', () => {
    const pid = project('waiting')
    // A question, and a blocked task on the same ticket: the question is the one row.
    const asking = ticket(pid, 'Choose the cache', { status: 'in_progress' })
    const card = post(asking.id, 'Which cache should we use?', ago(30), {
      progress: false,
      decision: [{ label: 'Redis' }, { label: 'Memory' }],
    })
    task(asking.id, 'Set up the cache', { position: 0, blocked: true, blockedReason: 'Pick one' })
    // A blocked next step with its reason.
    const stepping = ticket(pid, 'Needs the key', { status: 'in_progress' })
    const impl = task(stepping.id, 'Implementation', { position: 0 })
    const step = task(stepping.id, 'Get the Stripe key', {
      parentId: impl.id,
      position: 1,
      blocked: true,
      blockedReason: 'Log in to Stripe and copy the live key',
    })
    // A ticket in a blocked stage, since the stage move the timeline knows.
    const parked = ticket(pid, 'Parked on the human', { status: 'blocked' })
    event(pid, parked.id, {
      kind: 'stage',
      agent: 'board',
      by: 'board',
      toStage: 'blocked',
      at: iso(ago(60)),
    })

    const payload = read(pid)
    expect(payload.waitingOnHuman).toHaveLength(3)
    expect(payload.waitingOnHuman.filter((x) => x.ticketId === asking.id)).toHaveLength(1)
    expect(payload.waitingOnHuman.find((x) => x.ticketId === asking.id)).toMatchObject({
      kind: 'decision',
      title: 'Choose the cache',
      line: 'Which cache should we use?',
      since: iso(ago(30)),
      postId: card.id,
    })
    expect(payload.waitingOnHuman.find((x) => x.ticketId === stepping.id)).toMatchObject({
      kind: 'blocked-task',
      title: 'Needs the key',
      line: 'Get the Stripe key — Log in to Stripe and copy the live key',
      taskId: step.id,
    })
    expect(payload.waitingOnHuman.find((x) => x.ticketId === parked.id)).toMatchObject({
      kind: 'blocked-ticket',
      title: 'Parked on the human',
      line: 'Waiting in Blocked',
      since: iso(ago(60)),
    })
    expect(payload.totals.waitingOnHuman).toBe(3)
  })
})

describe('in review', () => {
  it('lists the PR, where its reviews stand, the latest verdict and the preview', () => {
    const pid = project('review')
    const shipped = ticket(pid, 'Ship the parser', { status: 'review', prNumber: 7 })
    db()
      .insert(dbm.schema.prs)
      .values({
        projectId: pid,
        number: 7,
        title: 'The parser',
        url: 'https://github.com/acme/app/pull/7',
        author: 'enrique',
        headRef: 'feat/parser',
        baseRef: 'dev',
        headSha: 'abc1234',
        reviewStage: 'reviewed',
        updatedAt: iso(ago(100)),
        fetchedAt: iso(ago(100)),
      })
      .run()
    db()
      .insert(dbm.schema.reviewResults)
      .values({
        projectId: pid,
        prNumber: 7,
        sha: 'abc1234',
        verdict: 'SHIP after one fix',
        author: 'claude',
        createdAt: iso(ago(90)),
      })
      .run()
    db()
      .insert(dbm.schema.workspaces)
      .values({
        ticketId: shipped.id,
        name: 'wt',
        branch: 'feat/parser',
        previewUrl: 'http://localhost:47123',
      })
      .run()
    // A PR on its branch, with no number on the ticket; and a ticket with a number and no PR row.
    const byBranch = ticket(pid, 'Branch only', { status: 'review', branch: 'feat/docs' })
    db()
      .insert(dbm.schema.prs)
      .values({
        projectId: pid,
        number: 8,
        title: 'The docs',
        url: 'https://github.com/acme/app/pull/8',
        author: 'enrique',
        headRef: 'feat/docs',
        baseRef: 'dev',
        headSha: 'def5678',
        reviewStage: 'pending',
        updatedAt: iso(ago(80)),
        fetchedAt: iso(ago(80)),
      })
      .run()
    db()
      .insert(dbm.schema.reviewResults)
      .values({
        projectId: pid,
        prNumber: 8,
        sha: 'def5678',
        verdict: 'FIX FIRST',
        author: 'claude',
        createdAt: iso(ago(70)),
      })
      .run()
    const bare = ticket(pid, 'No row yet', { status: 'review', prNumber: 9 })

    const entries = read(pid).inReview
    expect(entries.find((x) => x.ticketId === shipped.id)).toMatchObject({
      prNumber: 7,
      prUrl: 'https://github.com/acme/app/pull/7',
      reviewStage: 'reviewed',
      verdict: 'SHIP after one fix',
      preview: 'http://localhost:47123',
    })
    expect(entries.find((x) => x.ticketId === byBranch.id)).toMatchObject({
      prNumber: 8,
      reviewStage: 'pending',
      verdict: 'FIX FIRST',
      preview: null,
    })
    // Nothing invented: the number is the ticket's, and there is no link or verdict without a PR row.
    expect(entries.find((x) => x.ticketId === bare.id)).toMatchObject({
      prNumber: 9,
      prUrl: null,
      reviewStage: null,
      verdict: null,
      preview: null,
    })
    expect(read(pid).totals.inReview).toBe(3)
  })
})

describe('recent posts', () => {
  it('lists the newest few across the project, newest first, each as one line', () => {
    const pid = project('posts')
    const tickets = [1, 2, 3].map((i) => ticket(pid, `Ticket ${i}`))
    for (let i = 1; i <= 15; i++) {
      post(tickets[(i - 1) % 3]!.id, `Post ${i}\n\nbody of post ${i}`, ago(200 - i))
    }
    const payload = read(pid)
    expect(payload.recentPosts).toHaveLength(10)
    expect(payload.recentPosts.map((p) => p.line)).toEqual(
      Array.from({ length: 10 }, (_, k) => `Post ${15 - k}`),
    )
    expect(payload.recentPosts[0]).toMatchObject({
      ticketId: tickets[14 % 3]!.id,
      ticketTitle: `Ticket ${(14 % 3) + 1}`,
      author: 'claude',
      at: iso(ago(185)),
    })
    expect(payload.recentPosts.every((p) => !p.line.includes('\n'))).toBe(true)
    // The same bounded count on every call.
    expect(read(pid).recentPosts).toHaveLength(10)
  })
})

describe('the clock and the totals', () => {
  it('names the clock and measures every duration against it', () => {
    const pid = project('clock')
    const live = ticket(pid, 'Working', { status: 'in_progress' })
    event(pid, live.id, { kind: 'heartbeat', at: iso(ago(7)) })
    const asking = ticket(pid, 'Asking', { status: 'in_progress' })
    const card = post(asking.id, 'Ship it now?', ago(12), {
      progress: false,
      decision: [{ label: 'Yes' }, { label: 'No' }],
    })

    const payload = read(pid)
    const minutes = (at: string) => (Date.parse(payload.now) - Date.parse(at)) / MIN
    expect(payload.now).toBe(iso(NOW))
    expect(payload.windowMinutes).toBe(30)
    expect(payload.stallMinutes).toBe(30)
    const entry = payload.liveNow.find((x) => x.ticketId === live.id)!
    expect(minutes(entry.lastHeardAt)).toBe(7)
    expect(entry.silentMinutes).toBe(7)
    const wait = payload.waitingOnHuman.find((x) => x.postId === card.id)!
    expect(minutes(wait.since!)).toBe(12)
    expect(payload.recentlyActive.find((x) => x.ticketId === asking.id)!.silentMinutes).toBe(
      minutes(payload.recentlyActive.find((x) => x.ticketId === asking.id)!.lastHeardAt),
    )
    expect(payload.totals).toEqual({
      liveNow: payload.liveNow.length,
      recentlyActive: payload.recentlyActive.length,
      waitingOnHuman: payload.waitingOnHuman.length,
      inReview: payload.inReview.length,
      tickets: 2,
    })
  })

  it('uses the window it is given and reports it', () => {
    const pid = project('window')
    const t = ticket(pid, 'A moment ago', { status: 'in_progress' })
    event(pid, t.id, { kind: 'heartbeat', at: iso(ago(20)) })
    expect(read(pid, { windowMinutes: 60 }).liveNow.map((x) => x.ticketId)).toEqual([t.id])
    expect(read(pid, { windowMinutes: 60 }).windowMinutes).toBe(60)
    // Outside a narrower window it is not live; its silence is still said.
    const narrow = read(pid, { windowMinutes: 5 })
    expect(narrow.liveNow).toEqual([])
    expect(narrow.recentlyActive.find((x) => x.ticketId === t.id)).toMatchObject({ silentMinutes: 20 })
  })
})

describe('project scope', () => {
  it("never lists another project's tickets, posts, decisions or PRs", () => {
    const mine = project('scope mine')
    const theirs = project('scope theirs')
    const ours = ticket(mine, 'Our ticket', { status: 'in_progress' })
    event(mine, ours.id, { kind: 'heartbeat', at: iso(ago(5)) })
    post(ours.id, 'Our post', ago(6))
    post(ours.id, 'Our question', ago(7), { progress: false, decision: [{ label: 'x' }] })
    const review = ticket(mine, 'Ours in review', { status: 'review', prNumber: 3 })

    const foreign = ticket(theirs, 'Their ticket', { status: 'in_progress' })
    event(theirs, foreign.id, { kind: 'heartbeat', agent: 'codex', at: iso(ago(5)) })
    post(foreign.id, 'Their post', ago(6))
    post(foreign.id, 'Their question', ago(7), { progress: false, decision: [{ label: 'y' }] })
    ticket(theirs, 'Theirs in review', { status: 'review', prNumber: 4 })

    const payload = read(mine)
    expect(payload.liveNow.map((x) => x.ticketId)).toEqual([ours.id])
    expect(payload.recentPosts.every((p) => p.ticketId === ours.id)).toBe(true)
    expect(payload.waitingOnHuman.every((x) => x.ticketId === ours.id)).toBe(true)
    expect(payload.inReview.map((x) => x.ticketId)).toEqual([review.id])
    expect(payload.totals.tickets).toBe(2)
    expect(JSON.stringify(payload)).not.toContain('Their')
    expect(JSON.stringify(payload)).not.toContain('Theirs')
  })
})

describe('one query set', () => {
  it('does not add a query per ticket', () => {
    const pid = project('queries')
    ticket(pid, 'one', { status: 'in_progress' })
    const count = () => {
      const spy = vi.spyOn(dbm.db, 'select')
      try {
        read(pid)
        return spy.mock.calls.length
      } finally {
        spy.mockRestore()
      }
    }
    const one = count()
    for (let i = 0; i < 39; i++) {
      const t = ticket(pid, `many ${i}`, { status: 'in_progress' })
      event(pid, t.id, { kind: 'heartbeat', at: iso(ago(5)) })
    }
    expect(count()).toBe(one)
    expect(one).toBeGreaterThan(0)
  })
})

describe('silence is reported as silence', () => {
  it('keeps a stalled ticket out of live work and says when it was last heard and for how long', () => {
    const pid = project('silence')
    const t = ticket(pid, 'Gone quiet', { status: 'in_progress' })
    // Nothing recorded since its creation, two hundred minutes ago: stalled past the project's half hour.
    const payload = read(pid)
    expect(payload.liveNow).toEqual([])
    expect(payload.recentlyActive.find((x) => x.ticketId === t.id)).toMatchObject({
      lastHeardAt: iso(ago(200)),
      silentMinutes: 200,
      stalled: true,
    })
    // A wider window does not turn silence into work either.
    const wide = read(pid, { windowMinutes: 240 })
    expect(wide.liveNow).toEqual([])
    // No entry claims the board is idle.
    expect(JSON.stringify(payload)).not.toMatch(/idle|nothing is happening|nobody is working/i)
  })

  it("says in the tool's own description that a quiet ticket is not proof nobody is working", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, 'mcp.ts'), 'utf8')
    const start = source.indexOf("'get_live_work'")
    expect(start).toBeGreaterThan(-1)
    const description = source.slice(start, source.indexOf('// PR queue', start))
    expect(description).toContain('a quiet ticket is not proof that nobody is working')
    expect(description).toContain('windowMinutes')
  })
})

describe('the REST route', () => {
  it('answers the same read for one project, takes the window, and 404s an unknown project', async () => {
    const pid = project('rest')
    const t = ticket(pid, 'Over REST', { status: 'in_progress' })
    event(pid, t.id, { kind: 'heartbeat', at: iso(ago(2)) })

    const res = await call('GET', `/api/projects/${pid}/live-work`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    const answer = await tool('get_live_work', { projectId: pid })
    const { now: _bodyNow, ...rest } = body
    const { now: _toolNow, ...toolRest } = answer
    expect(rest).toMatchObject(toolRest)
    expect(body.project).toEqual({ id: pid, name: 'rest' })

    const narrow = await call('GET', `/api/projects/${pid}/live-work?windowMinutes=5`)
    expect(narrow.status).toBe(200)
    expect(((await narrow.json()) as { windowMinutes: number }).windowMinutes).toBe(5)

    const missing = await call('GET', '/api/projects/99999999/live-work')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: 'project not found' })
  })
})
