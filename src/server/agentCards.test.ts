import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { AgentCard, NoticeCard, TrackedCard } from './agentCards'

// The cards live in SQLite: point the db at a throwaway directory before anything loads it. Test mode,
// as Playwright drives the board: X-Test-Actor says who calls.
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-cards-')))
const dataDir = path.join(tmp, 'data')
process.env.DATA_DIR = dataDir
process.env.BOARD_ENV = 'test'

const HUMAN = 'human:enrique'
const CLAUDE = 'agent:claude'
const CODEX = 'agent:codex'
const ORCH = 'orchestrator:orch'

let apiModule: typeof import('./api')
let projects: typeof import('./projects')
let handle: (ctx: { request: Request; actor: string }) => Promise<Response>
let callerOf: typeof import('./auth').callerOf

beforeAll(async () => {
  apiModule = await import('./api')
  projects = await import('./projects')
  const { api: guard } = await import('./http')
  handle = guard(({ request, actor }: { request: Request; actor: string }) =>
    apiModule.api.handle(request, actor),
  )
  callerOf = (await import('./auth')).callerOf
}, 60_000)

afterEach(() => vi.useRealTimers())

let projectCount = 0
const newProject = (label: string) =>
  projects.createProject({ name: `${label} ${++projectCount}` }, 'human').id

/** A request as the middleware hands it on, with the actor resolved from the same request. */
async function call(method: string, pathname: string, testActor = HUMAN, body?: unknown) {
  const headers: Record<string, string> = { accept: 'application/json, text/event-stream' }
  headers['x-test-actor'] = testActor
  if (body !== undefined) headers['content-type'] = 'application/json'
  const request = new Request(`http://localhost${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const caller = await callerOf(request)
  return handle({ request, actor: caller!.name })
}

/** One REST call: its status and its JSON answer. */
async function rest(method: string, pathname: string, testActor = HUMAN, body?: unknown) {
  const res = await call(method, pathname, testActor, body)
  return { status: res.status, body: (await res.json()) as any }
}

let rpcId = 0
async function rpc(method: string, params: Record<string, unknown> = {}, testActor = CLAUDE) {
  const res = await call('POST', '/api/mcp', testActor, { jsonrpc: '2.0', id: ++rpcId, method, params })
  const body = (await res.json()) as { result?: any }
  return body.result
}

/** One MCP tool call: whether it failed, its text, and its parsed JSON answer. */
async function tool(name: string, args: Record<string, unknown> = {}, testActor = CLAUDE) {
  const result = await rpc('tools/call', { name, arguments: args }, testActor)
  const text = result.content[0].text as string
  const error = !!result.isError
  return { error, text, value: error ? null : (JSON.parse(text) as unknown) }
}

const start = (projectId: number, args: Record<string, unknown> = {}, testActor = CLAUDE) =>
  tool(
    'start_tracked_request',
    {
      projectId,
      title: 'The e2e run',
      request: 'show me the progress of the e2e run',
      ...args,
    },
    testActor,
  ) as Promise<{ error: boolean; text: string; value: TrackedCard }>

const notice = (projectId: number, args: Record<string, unknown> = {}, testActor = CLAUDE) =>
  tool(
    'post_notice',
    {
      projectId,
      title: 'Production is down',
      body: 'The host stopped answering; the API is unreachable.',
      reason: 'the human asked to be told at once when production breaks',
      ...args,
    },
    testActor,
  ) as Promise<{ error: boolean; text: string; value: NoticeCard }>

const list = async (projectId: number, testActor = HUMAN) =>
  (await tool('list_notifications', { projectId }, testActor)).value as AgentCard[]

const ids = (entries: AgentCard[]) => entries.map((entry) => entry.id).sort((a, b) => a - b)

describe('tracked requests', () => {
  it('opens a running card with every field as plain JSON, and lists it for the human', async () => {
    const projectId = newProject('shape')
    const href = `/projects/${projectId}/cleanup`
    const answer = await start(projectId, { title: 'Delete 12 branches', total: 12, href })
    expect(answer.error).toBe(false)
    expect(answer.value).toEqual({
      id: expect.any(Number),
      kind: 'tracked',
      projectId,
      actor: 'claude',
      title: 'Delete 12 branches',
      request: 'show me the progress of the e2e run',
      total: 12,
      done: 0,
      state: 'running',
      step: null,
      reason: null,
      result: null,
      href,
      startedAt: expect.any(String),
      updatedAt: expect.any(String),
      finishedAt: null,
      stale: false,
    })
    expect(new Date(answer.value.startedAt).toISOString()).toBe(answer.value.startedAt)
    expect(JSON.parse(JSON.stringify(answer.value))).toEqual(answer.value)
    expect(await list(projectId)).toEqual([answer.value])
  })

  it("refuses a start without the human's request, empty or whitespace included, and writes nothing", async () => {
    const projectId = newProject('no request')
    for (const request of [undefined, '', '   ']) {
      const refused = await start(projectId, { request })
      expect(refused.error).toBe(true)
      expect(refused.text).toMatch(/the human's request/i)
    }
    expect(await list(projectId)).toEqual([])
  })

  it('moves a determinate card, clamps done into the total, keeps an omitted step and advances updatedAt', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T09:00:00.000Z'))
    const projectId = newProject('progress')
    const opened = (await start(projectId, { total: 12 })).value
    const moves: string[] = [opened.updatedAt]
    for (const [done, step] of [
      [3, 'a'],
      [5, undefined],
      [99, 'c'],
      [-4, undefined],
    ] as const) {
      vi.setSystemTime(Date.parse(opened.updatedAt) + moves.length * 1000)
      const moved = await tool('tracked_request_progress', {
        projectId,
        cardId: opened.id,
        done,
        ...(step === undefined ? {} : { step }),
      })
      expect(moved.error, moved.text).toBe(false)
      const card = moved.value as TrackedCard
      moves.push(card.updatedAt)
      expect(card.state).toBe('running')
    }
    const final = (await list(projectId))[0] as TrackedCard
    expect(final.done).toBe(0)
    // The omitted step kept the last one, 'c' (the -4 move left the step alone), and each move moved time.
    expect(final.step).toBe('c')
    expect(new Set(moves).size).toBe(moves.length)

    const upTo3 = await tool('tracked_request_progress', { projectId, cardId: opened.id, done: 99 })
    expect((upTo3.value as TrackedCard).done).toBe(12)
    expect(
      (await tool('tracked_request_progress', { projectId, cardId: opened.id, done: -4 })).value,
    ).toMatchObject({ done: 0, step: 'c' })
  })

  it('ends succeeded with the one-line result, every step done and the step cleared', async () => {
    const projectId = newProject('succeeded')
    const opened = (await start(projectId, { total: 12 })).value
    await tool('tracked_request_progress', { projectId, cardId: opened.id, done: 5, step: 'half' })
    const ended = await tool('finish_tracked_request', {
      projectId,
      cardId: opened.id,
      state: 'succeeded',
      result: 'Built and published',
    })
    expect(ended.error).toBe(false)
    expect(ended.value).toMatchObject({
      state: 'succeeded',
      done: 12,
      step: null,
      result: 'Built and published',
      reason: null,
    })
    expect((ended.value as TrackedCard).finishedAt).toEqual(expect.any(String))
    expect(await list(projectId)).toEqual([ended.value])
  })

  it('ends failed with the reason verbatim', async () => {
    const projectId = newProject('failed')
    const opened = (await start(projectId)).value
    const ended = await tool('finish_tracked_request', {
      projectId,
      cardId: opened.id,
      state: 'failed',
      reason: 'the e2e run timed out',
    })
    expect(ended.value).toMatchObject({
      state: 'failed',
      reason: 'the e2e run timed out',
      result: null,
      step: null,
    })
  })

  it('refuses a finish missing its result or its reason and leaves the card running', async () => {
    const projectId = newProject('finish parts')
    const opened = (await start(projectId)).value
    const noResult = await tool('finish_tracked_request', {
      projectId,
      cardId: opened.id,
      state: 'succeeded',
    })
    expect(noResult.error).toBe(true)
    expect(noResult.text).toMatch(/result/i)
    const noReason = await tool('finish_tracked_request', {
      projectId,
      cardId: opened.id,
      state: 'failed',
    })
    expect(noReason.error).toBe(true)
    expect(noReason.text).toMatch(/reason/i)
    expect((await list(projectId))[0]).toMatchObject({ state: 'running', finishedAt: null })
  })

  it('refuses progress and finish on an ended card, and changes nothing: the first finish wins', async () => {
    const projectId = newProject('first terminal')
    const opened = (await start(projectId, { total: 4 })).value
    await tool('finish_tracked_request', {
      projectId,
      cardId: opened.id,
      state: 'failed',
      reason: 'first',
    })
    const before = (await list(projectId))[0]
    const progress = await rest(
      'POST',
      `/api/projects/${projectId}/agent-cards/${opened.id}/progress`,
      CLAUDE,
      {
        done: 3,
      },
    )
    expect(progress.status).toBe(409)
    const finish = await rest('POST', `/api/projects/${projectId}/agent-cards/${opened.id}/finish`, CLAUDE, {
      state: 'succeeded',
      result: 'late',
    })
    expect(finish.status).toBe(409)
    expect((await list(projectId))[0]).toEqual(before)
  })

  it('refuses a missing title and any href but a board path or an absolute http(s) URL', async () => {
    const projectId = newProject('inputs')
    const noTitle = await start(projectId, { title: '   ' })
    expect(noTitle.error).toBe(true)
    expect(noTitle.text).toMatch(/title/i)

    for (const href of [`/projects/${projectId}`, 'https://example.com/run/7']) {
      const card = (await start(projectId, { href })).value
      expect(card.href).toBe(href)
    }
    for (const href of ['javascript:alert(1)', '//evil.example/x', 'projects/1', 'mailto:a@b.example']) {
      const refused = await start(projectId, { href })
      expect(refused.error, href).toBe(true)
      expect(refused.text).toMatch(/href/i)
    }
  })
})

describe('important notices', () => {
  it('is its own kind: a body and a reason, no state, progress or count, and no progress to move', async () => {
    const projectId = newProject('notice')
    const posted = await notice(projectId, { href: 'https://status.example.com' })
    expect(posted.error).toBe(false)
    const card = posted.value
    expect(card).toMatchObject({
      kind: 'notice',
      actor: 'claude',
      title: 'Production is down',
      body: 'The host stopped answering; the API is unreachable.',
      reason: 'the human asked to be told at once when production breaks',
      href: 'https://status.example.com',
      stale: false,
    })
    for (const field of ['state', 'step', 'done', 'total', 'request', 'result', 'finishedAt'])
      expect(card).not.toHaveProperty(field)

    const listed = (await list(projectId))[0]
    expect(listed.kind).toBe('notice')
    const progress = await rest(
      'POST',
      `/api/projects/${projectId}/agent-cards/${card.id}/progress`,
      CLAUDE,
      {
        done: 1,
      },
    )
    expect(progress.status).toBe(409)
    const finish = await rest('POST', `/api/projects/${projectId}/agent-cards/${card.id}/finish`, CLAUDE, {
      state: 'succeeded',
      result: 'x',
    })
    expect(finish.status).toBe(409)
    expect((await list(projectId))[0]).toEqual(listed)
  })

  it('refuses a notice without its reason, its title or its body, and writes nothing', async () => {
    const projectId = newProject('notice guards')
    for (const [args, word] of [
      [{ reason: '' }, /reason/i],
      [{ reason: '   ' }, /reason/i],
      [{ title: '' }, /title/i],
      [{ body: '   ' }, /body/i],
    ] as const) {
      const refused = await notice(projectId, args)
      expect(refused.error).toBe(true)
      expect(refused.text).toMatch(word)
    }
    expect((await notice(projectId, { href: 'javascript:alert(1)' })).text).toMatch(/href/i)
    expect(await list(projectId)).toEqual([])
  })

  it('is delivered once: two reads are equal, one row is written, and nothing moves it', async () => {
    const projectId = newProject('notice once')
    const posted = await notice(projectId)
    expect(await list(projectId)).toEqual([posted.value])
    expect(await list(projectId)).toEqual([posted.value])
    // Nothing may change it afterwards: progress and finish are refused and it reads as it did.
    await rest('POST', `/api/projects/${projectId}/agent-cards/${posted.value.id}/progress`, CLAUDE, {
      done: 2,
    })
    await rest('POST', `/api/projects/${projectId}/agent-cards/${posted.value.id}/finish`, CLAUDE, {
      state: 'failed',
      reason: 'late',
    })
    expect(await list(projectId)).toEqual([posted.value])
  })
})

describe('ownership, scoping and who may call', () => {
  it("shows an agent its own and its sub-identities' cards, the human every card, and no other project's", async () => {
    const projectId = newProject('owners')
    const other = newProject('owners other')
    const mine = (await start(projectId)).value
    const child = (await start(projectId, {}, CLAUDE)).value
    const sub = (
      await tool(
        'start_tracked_request',
        { projectId, title: 'child', request: 'let me know when it is ready', agentName: 'claude/builder-1' },
        CLAUDE,
      )
    ).value as TrackedCard
    const elsewhere = (await start(other, {}, CODEX)).value
    const codexCard = (await start(projectId, {}, CODEX)).value

    expect(ids(await list(projectId, CLAUDE))).toEqual(ids([mine, child, sub]))
    // The sub-identity sees only what it opened, not its orchestrator's cards.
    expect(ids(await list(projectId, HUMAN))).toEqual(ids([mine, child, sub, codexCard]))
    expect((await list(projectId, HUMAN)).some((card) => card.id === elsewhere.id)).toBe(false)

    const asSub = await tool('list_notifications', { projectId, agentName: 'claude/builder-1' }, CLAUDE)
    expect(ids(asSub.value as AgentCard[])).toEqual([sub.id])
  })

  it("refuses progress and finish on another agent's card and leaves it untouched", async () => {
    const projectId = newProject('not yours')
    const card = (await start(projectId)).value
    const before = (await list(projectId, HUMAN))[0]
    const progress = await rest('POST', `/api/projects/${projectId}/agent-cards/${card.id}/progress`, CODEX, {
      done: 3,
    })
    expect(progress.status).toBe(404)
    const finish = await rest('POST', `/api/projects/${projectId}/agent-cards/${card.id}/finish`, CODEX, {
      state: 'succeeded',
      result: 'stolen',
    })
    expect(finish.status).toBe(404)
    expect((await list(projectId, HUMAN))[0]).toEqual(before)
  })

  it('lets an orchestrator move a card its sub-identity opened, but not the reverse', async () => {
    const projectId = newProject('orchestrator')
    const child = (
      await tool(
        'start_tracked_request',
        {
          projectId,
          title: 'child',
          request: 'notify me when the preview is ready',
          total: 2,
          agentName: 'orch/builder-1',
        },
        ORCH,
      )
    ).value as TrackedCard
    const moved = await tool('tracked_request_progress', { projectId, cardId: child.id, done: 1 }, ORCH)
    expect(moved.error, moved.text).toBe(false)
    expect(moved.value).toMatchObject({ done: 1 })

    const parentCard = (
      await tool(
        'start_tracked_request',
        { projectId, title: 'parent', request: 'tell me once it is ready' },
        ORCH,
      )
    ).value as TrackedCard
    const refusal = await tool(
      'tracked_request_progress',
      { projectId, cardId: parentCard.id, done: 2, agentName: 'orch/builder-1' },
      ORCH,
    )
    expect(refusal.error).toBe(true)
    expect((await list(projectId, HUMAN)).find((card) => card.id === parentCard.id)).toMatchObject({
      done: 0,
      state: 'running',
    })
  })

  it('answers 404 for a card of another project, an unknown project and an unknown card, writing nothing', async () => {
    const projectId = newProject('scoped one')
    const other = newProject('scoped two')
    const card = (await start(projectId)).value
    const before = await list(projectId, HUMAN)

    const cross = await rest('POST', `/api/projects/${other}/agent-cards/${card.id}/progress`, CLAUDE, {
      done: 1,
    })
    expect(cross.status).toBe(404)
    const unknownProject = await rest('POST', '/api/projects/999999/agent-cards', CLAUDE, {
      title: 'x',
      request: 'show me progress',
    })
    expect(unknownProject.status).toBe(404)
    expect((await rest('GET', '/api/projects/999999/agent-cards', HUMAN)).status).toBe(404)
    const unknownCard = await rest('POST', `/api/projects/${projectId}/agent-cards/999999/progress`, CLAUDE, {
      done: 1,
    })
    expect(unknownCard.status).toBe(404)
    expect(await list(projectId, HUMAN)).toEqual(before)
  })

  it('lets only the human dismiss a card, for everybody. An agent gets 403', async () => {
    const projectId = newProject('dismiss')
    const card = (await start(projectId)).value
    const refused = await rest('DELETE', `/api/projects/${projectId}/agent-cards/${card.id}`, CLAUDE)
    expect(refused.status).toBe(403)
    expect(ids(await list(projectId, HUMAN))).toEqual([card.id])

    const dismissed = await rest('DELETE', `/api/projects/${projectId}/agent-cards/${card.id}`, HUMAN)
    expect(dismissed.status).toBe(200)
    expect(dismissed.body).toEqual({ ok: true })
    // Final and global: gone for the human and the agent, and a later call is a 404 that writes nothing.
    expect(await list(projectId, HUMAN)).toEqual([])
    expect(await list(projectId, CLAUDE)).toEqual([])
    expect(
      (await rest('POST', `/api/projects/${projectId}/agent-cards/${card.id}/progress`, CLAUDE, { done: 1 }))
        .status,
    ).toBe(404)
    expect(
      (
        await rest('POST', `/api/projects/${projectId}/agent-cards/${card.id}/finish`, CLAUDE, {
          state: 'failed',
          reason: 'late',
        })
      ).status,
    ).toBe(404)
    expect((await rest('DELETE', `/api/projects/${projectId}/agent-cards/${card.id}`, HUMAN)).status).toBe(
      404,
    )
  })

  it('refuses every authoring call from the human, and writes nothing', async () => {
    const projectId = newProject('human may not')
    const card = (await start(projectId)).value
    expect(
      (
        await rest('POST', `/api/projects/${projectId}/agent-cards/${card.id}/progress`, HUMAN, {
          done: 1,
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await rest('POST', `/api/projects/${projectId}/agent-cards/${card.id}/finish`, HUMAN, {
          state: 'succeeded',
          result: 'x',
        })
      ).status,
    ).toBe(403)
    const opened = await rest('POST', `/api/projects/${projectId}/agent-cards`, HUMAN, {
      title: 'x',
      request: 'show me progress',
    })
    expect(opened.status).toBe(403)
    const posted = await rest('POST', `/api/projects/${projectId}/agent-cards/notices`, HUMAN, {
      title: 'x',
      body: 'y',
      reason: 'z',
    })
    expect(posted.status).toBe(403)
    // A human's MCP call is refused the same way.
    for (const [name, args] of [
      ['start_tracked_request', { projectId, title: 'x', request: 'show me progress' }],
      ['post_notice', { projectId, title: 'x', body: 'y', reason: 'z' }],
    ] as const) {
      const refused = await tool(name, args, HUMAN)
      expect(refused.error).toBe(true)
      expect(refused.text).toMatch(/only an agent/i)
    }
    // Nothing the human tried wrote anything: the one card is exactly as the agent opened it.
    expect(await list(projectId, HUMAN)).toEqual([card])
  })
})

describe('staleness', () => {
  it('reads a running card stale at six silent hours, not before, and keeps it running and listed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T09:00:00.000Z'))
    const projectId = newProject('stale')
    const card = (await start(projectId)).value

    vi.setSystemTime(new Date('2026-01-01T14:59:00.000Z'))
    expect(((await list(projectId))[0] as TrackedCard).stale).toBe(false)
    vi.setSystemTime(new Date('2026-01-01T15:00:00.000Z'))
    const stale = (await list(projectId))[0] as TrackedCard
    expect(stale.stale).toBe(true)
    expect(stale.state).toBe('running')
    expect(ids(await list(projectId, CLAUDE))).toEqual([card.id])

    // A move makes it fresh again; it was never deleted or changed to failed.
    const moved = await tool('tracked_request_progress', { projectId, cardId: card.id, done: 1 })
    expect((moved.value as TrackedCard).stale).toBe(false)
    expect((await list(projectId))[0]).toMatchObject({ id: card.id, state: 'running', stale: false })
  })
})

describe('lifetime', () => {
  it('has no TTL and no cap: a card and a notice stay until dismissed, even thirty days on', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const projectId = newProject('lifetime')
    const tracked = (await start(projectId)).value
    await tool('finish_tracked_request', {
      projectId,
      cardId: tracked.id,
      state: 'succeeded',
      result: 'done',
    })
    const posted = (await notice(projectId)).value
    // Past the board's cap for jobs: agent cards keep every one.
    for (let i = 0; i < 24; i++) await start(projectId, { title: `card ${i}` })
    expect(await list(projectId)).toHaveLength(26)

    vi.setSystemTime(new Date('2026-01-31T00:00:00.000Z'))
    const monthLater = await list(projectId)
    expect(monthLater).toHaveLength(26)
    expect(monthLater.find((card) => card.id === tracked.id)).toMatchObject({
      state: 'succeeded',
      result: 'done',
    })
    expect(monthLater.find((card) => card.id === posted.id)).toEqual(posted)
  })

  it('survives a reload of the db module: running, finished and notice read back unchanged', async () => {
    const projectId = newProject('persisted')
    const running = (await start(projectId, { title: 'still running' })).value
    const finished = (await start(projectId, { title: 'already done', total: 2 })).value
    await tool('finish_tracked_request', {
      projectId,
      cardId: finished.id,
      state: 'succeeded',
      result: 'nothing left',
    })
    const posted = (await notice(projectId)).value
    const before = await list(projectId)
    expect(before).toHaveLength(3)

    vi.resetModules()
    const restarted = await import('./agentCards')
    expect(restarted.listCards(projectId)).toEqual(before)
    // The board's own jobs are still in memory: a reload starts them empty.
    const jobs = await import('./jobs')
    expect(jobs.listJobs(projectId)).toEqual([])
    // The reloaded module sees the same rows for the same ids.
    expect(
      restarted
        .listCards(projectId)
        .map((card) => card.id)
        .sort(),
    ).toEqual([running.id, finished.id, posted.id].sort())
  })
})

describe('REST mirror', () => {
  it('does each capability as its tool does, refusals included', async () => {
    const projectId = newProject('rest')
    const opened = await rest('POST', `/api/projects/${projectId}/agent-cards`, CLAUDE, {
      title: 'The release build',
      request: 'let me know when the release is built',
      total: 4,
      href: `/projects/${projectId}`,
    })
    expect(opened.status).toBe(201)
    const card = opened.body as TrackedCard
    expect(card).toMatchObject({ kind: 'tracked', actor: 'claude', state: 'running', total: 4 })

    expect((await rest('GET', `/api/projects/${projectId}/agent-cards`, HUMAN)).body).toEqual([card])
    const moved = await rest('POST', `/api/projects/${projectId}/agent-cards/${card.id}/progress`, CLAUDE, {
      done: 3,
      step: 'bundling',
    })
    expect(moved.status).toBe(200)
    expect(moved.body).toMatchObject({ done: 3, step: 'bundling' })
    const ended = await rest('POST', `/api/projects/${projectId}/agent-cards/${card.id}/finish`, CLAUDE, {
      state: 'succeeded',
      result: 'v1.2.0 is up',
    })
    expect(ended.status).toBe(200)
    expect(ended.body).toMatchObject({ state: 'succeeded', done: 4, result: 'v1.2.0 is up' })

    const posted = await rest('POST', `/api/projects/${projectId}/agent-cards/notices`, CLAUDE, {
      title: 'Host broken',
      body: 'The build host is out of disk.',
      reason: 'nothing can build until it is fixed',
    })
    expect(posted.status).toBe(201)
    expect(posted.body).toMatchObject({ kind: 'notice' })

    // The same refusals: a bad body, an agent's dismissal, the human's authoring.
    expect(
      (await rest('POST', `/api/projects/${projectId}/agent-cards`, CLAUDE, { title: 'x' })).status,
    ).toBe(400)
    expect((await rest('DELETE', `/api/projects/${projectId}/agent-cards/${card.id}`, CLAUDE)).status).toBe(
      403,
    )
    expect((await rest('DELETE', `/api/projects/${projectId}/agent-cards/${card.id}`, HUMAN)).status).toBe(
      200,
    )
  })
})

describe('the instructions agents read', () => {
  it('carries both rules in the MCP instructions and the trigger and non-trigger words in the tool descriptions', async () => {
    const init = await rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    })
    const instructions = init.instructions as string
    expect(instructions).toContain('only when the human explicitly asked to see the progress of')
    expect(instructions).toContain('something very important the human must know')
    expect(instructions).toContain('not a place to report your work')

    const tools = ((await rpc('tools/list', {})) as { tools: { name: string; description: string }[] }).tools
    const description = (name: string) => tools.find((entry) => entry.name === name)?.description ?? ''
    for (const name of ['start_tracked_request', 'tracked_request_progress', 'finish_tracked_request']) {
      const text = description(name)
      for (const phrase of [
        'show me progress',
        'let me know when',
        'notify me when',
        'tell me once it is ready',
        'start a ticket',
        'run tests in normal work',
        'an unasked long build',
        'a finished ticket',
      ])
        expect(text, `${name}: ${phrase}`).toContain(phrase)
    }
    const noticeText = description('post_notice')
    for (const phrase of [
      'data lost or at risk',
      'production or the host broken',
      'a secret exposed',
      'the wrong thing done and needing undo',
      'a deadline missed',
    ])
      expect(noticeText, phrase).toContain(phrase)
  })

  it('states the same two rules in AGENTS.md and the board skill, on both skill transports', async () => {
    const repo = path.join(import.meta.dirname, '..', '..')
    const texts = {
      'AGENTS.md': fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8'),
      'board.md': fs.readFileSync(path.join(import.meta.dirname, 'skill', 'board.md'), 'utf8'),
      'skill (mcp)': await (await call('GET', '/api/agent-setup/skill?client=claude', HUMAN)).text(),
      'skill (rest)': await (
        await call('GET', '/api/agent-setup/skill?client=claude&transport=rest', HUMAN)
      ).text(),
    }
    const flat = (text: string) => text.replace(/\s+/g, ' ')
    for (const [name, text] of Object.entries(texts)) {
      for (const phrase of [
        'show me progress',
        'let me know when',
        'notify me when',
        'tell me once it is ready',
        'start a ticket',
        'run tests in normal work',
        'an unasked long build',
        'a finished ticket',
        'data lost or at risk',
        'a secret exposed',
      ])
        expect(flat(text), `${name}: ${phrase}`).toContain(phrase)
    }
  })

  it("documents every new route in the README's REST API table", () => {
    const readme = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'README.md'), 'utf8')
    for (const route of [
      '/api/projects/:id/agent-cards',
      '/api/projects/:id/agent-cards/notices',
      '/api/projects/:id/agent-cards/:cardId/progress',
      '/api/projects/:id/agent-cards/:cardId/finish',
    ])
      expect(readme).toContain(route)
  })
})
