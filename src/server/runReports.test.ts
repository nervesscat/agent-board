import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { and, count, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-run-reports-'))

const HUMAN = 'enrique'
const AGENT = 'claude'
const MIN = 60_000
const AGENTS = ['spec', 'builder', 'runner', 'env', 'verify', 'hunt', 'refute', 'merge', 'intent'] as const

let dbm: typeof import('#/db')
let features: typeof import('./features')
let needs: typeof import('./needs')
let missingReviewPhases: typeof import('./runReports').missingReviewPhases
let work: typeof import('./workTimeline')
let agentsModule: typeof import('./agents')
let projectAgents: typeof import('./projectAgents')
let defaultAgents: typeof import('./defaultAgents')
let handle: (request: Request) => Promise<Response>
beforeAll(async () => {
  dbm = await import('#/db')
  features = await import('./features')
  needs = await import('./needs')
  missingReviewPhases = (await import('./runReports')).missingReviewPhases
  work = await import('./workTimeline')
  agentsModule = await import('./agents')
  projectAgents = await import('./projectAgents')
  defaultAgents = await import('./defaultAgents')
  ;(await import('./actors')).noteActor(HUMAN, 'human')
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  const guarded = guard(({ request }: { request: Request }) =>
    api.handle(request, request.headers.has('authorization') ? AGENT : HUMAN),
  )
  handle = (request) => guarded({ request })
})

let projects = 0
/** A project with one repo: the ticket's branch checks have a path to look at (it need not exist). */
function newProject(name = `p${++projects}`) {
  const id = dbm.db.insert(dbm.schema.projects).values({ name }).returning().get().id
  dbm.db
    .insert(dbm.schema.repos)
    .values({ projectId: id, name: 'app', repoPath: `/r/${name}`, githubRepo: 'acme/app' })
    .run()
  return id
}

function newTicket(projectId: number, title = 'work', status = 'in_progress') {
  return features.createTicket(projectId, { title, status }, HUMAN)
}

async function call(method: string, pathname: string, body?: unknown, as: 'human' | 'agent' = 'human') {
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
    AGENT,
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

const reportCount = () => dbm.db.select({ n: count() }).from(dbm.schema.runReports).get()!.n

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * MIN).toISOString()

/** An event time `seconds` ago, as the timeline reads it. */
const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString()

/** A closed span of about `seconds` for `agent` in `round`: the start moved back, then the span ended. */
function closedSpan(
  projectId: number,
  ticketId: number,
  agent: string,
  round: number | null,
  seconds: number,
) {
  const started = work.startSpan(projectId, ticketId, { phase: 'review', round, agent }, AGENT)
  dbm.db
    .update(dbm.schema.ticketEvents)
    .set({ at: ago(seconds) })
    .where(eq(dbm.schema.ticketEvents.id, started.spanId))
    .run()
  return work.endSpan(projectId, ticketId, { spanId: started.spanId, agent }, AGENT)
}

/** A closed span that ran from `startAgo` to `endAgo` seconds back: two runs of one agent, at their own times. */
function timedSpan(
  projectId: number,
  ticketId: number,
  agent: string,
  round: number | null,
  startAgo: number,
  endAgo: number,
) {
  return spanBetween(projectId, ticketId, agent, round, ago(startAgo), ago(endAgo))
}

/** A closed span between two exact moments, so two runs can share one interval to the millisecond. */
function spanBetween(
  projectId: number,
  ticketId: number,
  agent: string,
  round: number | null,
  start: string,
  end: string,
) {
  const started = work.startSpan(projectId, ticketId, { phase: 'review', round, agent }, AGENT)
  dbm.db
    .update(dbm.schema.ticketEvents)
    .set({ at: start })
    .where(eq(dbm.schema.ticketEvents.id, started.spanId))
    .run()
  const ended = work.endSpan(projectId, ticketId, { spanId: started.spanId, agent }, AGENT)
  dbm.db
    .update(dbm.schema.ticketEvents)
    .set({ at: end })
    .where(eq(dbm.schema.ticketEvents.id, ended.event.id))
    .run()
  return started.spanId
}

/** A hand-off to `agent` at a chosen moment, so a test decides which run it briefs. */
function handoffAt(projectId: number, ticketId: number, agent: string, at: string) {
  const { event } = work.handoff(projectId, ticketId, { to: agent }, AGENT)
  dbm.db.update(dbm.schema.ticketEvents).set({ at }).where(eq(dbm.schema.ticketEvents.id, event.id)).run()
  return event
}

/** Move a report's written time back, so "written after the hand-off" is decided by the test, not the clock. */
function reportWrittenAt(reportId: number, at: string) {
  dbm.db
    .update(dbm.schema.runReports)
    .set({ createdAt: at })
    .where(eq(dbm.schema.runReports.id, reportId))
    .run()
}

describe('storing a run report', () => {
  it('writes one through the MCP tool and reads it by id and by ticket', async () => {
    const pid = newProject()
    const t = newTicket(pid)
    const written = await tool('write_run_report', {
      projectId: pid,
      ticketId: t.id,
      agent: 'hunt',
      round: 2,
      branch: 'feat/import',
      headSha: 'a1b2c3d4e5f6',
      model: 'claude-opus',
      effort: 'high',
      briefedBy: 'orch',
      startedAt: hoursAgo(2),
      endedAt: hoursAgo(1),
      difficulty: 4,
      confidence: 3,
      steps: [{ name: 'read the diff', done: true, note: '' }],
      counts: { candidates: 3 },
      sections: { brief: 'The brief had the spec but no runbook.', problems: 'one flaky test' },
    })
    expect(written.id).toEqual(expect.any(Number))
    expect(written).toMatchObject({
      projectId: pid,
      ticketId: t.id,
      agent: 'hunt',
      round: 2,
      branch: 'feat/import',
      headSha: 'a1b2c3d4e5f6',
      difficulty: 4,
      confidence: 3,
      counts: { candidates: 3 },
      author: AGENT,
    })
    // It reads back by id with the same fields, and by ticket through the ticket view.
    const byId = await tool('get_run_report', { projectId: pid, reportId: written.id })
    expect(byId).toEqual(written)
    const ticket = await call('GET', `/api/tickets/${t.id}`)
    expect(ticket.body.runReports.map((r: { id: number }) => r.id)).toEqual([written.id])
    expect(ticket.body.runReports[0].sections.brief).toBe('The brief had the spec but no runbook.')
    const listed = await tool('list_run_reports', { projectId: pid, ticketId: t.id })
    expect(listed.map((r: { id: number }) => r.id)).toEqual([written.id])
  })

  it('keeps one report per run: rounds are rows of their own, a repeat is a new row, none is empty', async () => {
    const pid = newProject()
    const t = newTicket(pid)
    for (const round of [1, 2, 3])
      await tool('write_run_report', { projectId: pid, ticketId: t.id, agent: 'hunt', round })
    await tool('write_run_report', { projectId: pid, ticketId: t.id, agent: 'hunt', round: 2 })
    const rows = await tool('list_run_reports', { projectId: pid, ticketId: t.id, agent: 'hunt' })
    expect(rows).toHaveLength(4)
    expect(rows.map((r: { round: number }) => r.round).sort()).toEqual([1, 2, 2, 3])
    for (const round of [1, 2, 3])
      expect(
        (
          await tool('get_run_report', {
            projectId: pid,
            reportId: rows.find((r: { round: number }) => r.round === round)!.id,
          })
        ).round,
      ).toBe(round)
    const empty = newTicket(pid, 'nothing reported')
    expect(await tool('list_run_reports', { projectId: pid, ticketId: empty.id })).toEqual([])
    expect((await call('GET', `/api/tickets/${empty.id}`)).body.runReports).toEqual([])
  })

  it('is scoped to the project and its tickets: another project sees none and writes none', async () => {
    const a = newProject('a')
    const b = newProject('b')
    const ticket = newTicket(a)
    const mine = await tool('write_run_report', { projectId: a, ticketId: ticket.id, agent: 'verify' })
    expect((await tool('list_run_reports', { projectId: b })).map((r: { id: number }) => r.id)).not.toContain(
      mine.id,
    )
    const before = reportCount()
    expect(await tool('write_run_report', { projectId: b, ticketId: ticket.id, agent: 'verify' })).toEqual({
      error: expect.stringMatching(/not a ticket of this project/),
    })
    expect(reportCount()).toBe(before)
    // Reading it by id under the wrong project is not found, and so is a report that is not there.
    expect(await tool('get_run_report', { projectId: b, reportId: mine.id })).toEqual({
      error: expect.stringMatching(/run report not found/),
    })
    expect(await tool('get_run_report', { projectId: a, reportId: mine.id })).toMatchObject({ id: mine.id })
    expect((await call('GET', `/api/projects/${b}/run-reports/${mine.id}`)).status).toBe(404)
    expect((await call('GET', `/api/projects/${a}/run-reports/${mine.id}`)).body.id).toBe(mine.id)
  })

  it('refuses a report that ends before it starts, and stores nothing', async () => {
    const pid = newProject()
    const t = newTicket(pid)
    const before = reportCount()
    const refused = await tool('write_run_report', {
      projectId: pid,
      ticketId: t.id,
      agent: 'hunt',
      round: 2,
      startedAt: hoursAgo(1),
      endedAt: hoursAgo(2),
      durationMs: 40 * MIN,
    })
    expect(refused).toEqual({ error: expect.stringMatching(/endedAt is before startedAt/) })
    expect(reportCount()).toBe(before)
    // The REST path refuses it the same way.
    const rest = await call(
      'POST',
      `/api/projects/${pid}/run-reports`,
      { ticketId: t.id, agent: 'hunt', startedAt: hoursAgo(1), endedAt: hoursAgo(2) },
      'agent',
    )
    expect(rest.status).toBe(400)
    expect(rest.body.error).toMatch(/endedAt is before startedAt/)
    expect(reportCount()).toBe(before)
    // A zero-length window is a real 0-minute self-report.
    const at = hoursAgo(1)
    const zero = await tool('write_run_report', {
      projectId: pid,
      ticketId: t.id,
      agent: 'hunt',
      startedAt: at,
      endedAt: at,
    })
    expect(zero.durationSource).toBe('self')
    expect(zero.durationMs).toBe(0)
  })

  it('keeps the numbers structured: times, duration, ratings, a boolean per step, counts', async () => {
    const pid = newProject()
    const t = newTicket(pid)
    const row = await tool('write_run_report', {
      projectId: pid,
      ticketId: t.id,
      agent: 'builder',
      durationMs: 90 * MIN,
      startedAt: hoursAgo(2),
      endedAt: hoursAgo(1),
      time: { readingMs: 10 * MIN, runningMs: 30 * MIN, writingMs: 20 * MIN, waitingMs: 5 * MIN },
      difficulty: 5,
      confidence: 2,
      steps: [
        { name: 'read the code around the change', done: true, note: '' },
        { name: 'write the e2e spec', done: false, note: 'no page to drive' },
      ],
      counts: { criteria: 14, tests: 6, failed: 0 },
      sections: { brief: 'Enough.', problems: 'none' },
    })
    expect(row.time).toEqual({
      readingMs: 10 * MIN,
      runningMs: 30 * MIN,
      writingMs: 20 * MIN,
      waitingMs: 5 * MIN,
      otherMs: 0,
    })
    expect(row.durationMs).toBe(90 * MIN)
    expect(row.durationSource).toBe('self')
    expect(row.difficulty).toBe(5)
    expect(row.confidence).toBe(2)
    expect(row.steps).toEqual([
      { name: 'read the code around the change', done: true, note: '' },
      { name: 'write the e2e spec', done: false, note: 'no page to drive' },
    ])
    // A kind of run's numbers are summed over rows, with no prose parsed.
    const rows = await tool('list_run_reports', { projectId: pid, agent: 'builder' })
    expect(rows.reduce((n: number, r: { counts: Record<string, number> }) => n + r.counts.tests, 0)).toBe(6)
    expect(rows.every((r: { sections: Record<string, string> }) => 'problems' in r.sections)).toBe(true)
  })
})

describe('an agent filter', () => {
  it('finds a report stored under a sub-identity as that agent’s, and not another agent’s', async () => {
    const pid = newProject()
    const t = newTicket(pid)
    const sub = await tool('write_run_report', {
      projectId: pid,
      ticketId: t.id,
      agent: 'orch/hunt-1',
      round: 2,
    })
    const plain = await tool('write_run_report', { projectId: pid, ticketId: t.id, agent: 'hunt', round: 3 })
    const verify = await tool('write_run_report', {
      projectId: pid,
      ticketId: t.id,
      agent: 'verify',
      round: 2,
    })
    const hunt = await tool('list_run_reports', { projectId: pid, agent: 'hunt' })
    expect(hunt.map((r: { id: number }) => r.id).sort()).toEqual([sub.id, plain.id].sort())
    const onlyVerify = await tool('list_run_reports', { projectId: pid, agent: 'verify' })
    expect(onlyVerify.map((r: { id: number }) => r.id)).toEqual([verify.id])
    // The limit counts the filtered rows: verify is newest, and a limit of one must not hide hunt's.
    const one = await tool('list_run_reports', { projectId: pid, agent: 'hunt', limit: 1 })
    expect(one.map((r: { id: number }) => r.id)).toEqual([plain.id])
  })

  it('tells a project agent named like a numbered worker apart from the default agent', async () => {
    const pid = newProject()
    const created = await call('POST', `/api/projects/${pid}/agents`, { name: 'hunt-1' })
    expect(created.status).toBe(201)
    const t = newTicket(pid)
    const mine = await tool('write_run_report', {
      projectId: pid,
      ticketId: t.id,
      agent: 'hunt-1',
      round: 2,
    })
    const plain = await tool('write_run_report', { projectId: pid, ticketId: t.id, agent: 'hunt', round: 2 })
    // Each name lists its own reports only, not the other's.
    const mineOnly = await tool('list_run_reports', { projectId: pid, agent: 'hunt-1' })
    expect(mineOnly.map((r: { id: number }) => r.id)).toEqual([mine.id])
    const plainOnly = await tool('list_run_reports', { projectId: pid, agent: 'hunt' })
    expect(plainOnly.map((r: { id: number }) => r.id)).toEqual([plain.id])
    // A run of the project agent is flagged as its own, and the default agent's report does not clear it.
    const flaggedTicket = newTicket(pid, 'numbered hunter')
    closedSpan(pid, flaggedTicket.id, 'hunt-1', 2, 60)
    const flagged = await needs.changeTicket(flaggedTicket.id, { status: 'review' }, HUMAN, {
      agent: false,
    })
    expect(flagged.missingRunReports).toEqual([
      expect.objectContaining({ agent: 'hunt-1', round: 2, runs: 1, spans: 1, reports: 0 }),
    ])
    await tool('write_run_report', { projectId: pid, ticketId: flaggedTicket.id, agent: 'hunt', round: 2 })
    await needs.changeTicket(flaggedTicket.id, { status: 'in_progress' }, HUMAN, { agent: false })
    const still = await needs.changeTicket(flaggedTicket.id, { status: 'review' }, HUMAN, { agent: false })
    expect(still.missingRunReports).toEqual([expect.objectContaining({ agent: 'hunt-1' })])
    await tool('write_run_report', {
      projectId: pid,
      ticketId: flaggedTicket.id,
      agent: 'hunt-1',
      round: 2,
    })
    await needs.changeTicket(flaggedTicket.id, { status: 'in_progress' }, HUMAN, { agent: false })
    const clean = await needs.changeTicket(flaggedTicket.id, { status: 'review' }, HUMAN, { agent: false })
    expect(clean.missingRunReports).toEqual([])
  })
})

describe('how a run duration is read back', () => {
  it('uses the measured span and keeps the agent’s own estimate beside it', async () => {
    const pid = newProject()
    const t = newTicket(pid)
    // The span measures a 90 s run; the report's own window covers it.
    timedSpan(pid, t.id, 'hunt', 2, 150, 60)
    const measured = await tool('write_run_report', {
      projectId: pid,
      ticketId: t.id,
      agent: 'hunt',
      round: 2,
      startedAt: ago(160),
      endedAt: ago(50),
      durationMs: 40 * MIN,
    })
    expect(measured.durationSource).toBe('measured')
    expect(Math.abs(measured.durationMs - 90_000)).toBeLessThan(2_000)
    expect(measured.reportedDurationMs).toBe(40 * MIN)
    expect(measured.startedAt).not.toBeNull()
    expect(measured.endedAt).not.toBeNull()
    // The same report with no span for its round: its own 40 minutes, marked self-reported.
    const own = await tool('write_run_report', {
      projectId: pid,
      ticketId: t.id,
      agent: 'hunt',
      round: 3,
      durationMs: 40 * MIN,
    })
    expect(own.durationSource).toBe('self')
    expect(own.durationMs).toBe(40 * MIN)
    expect(own.reportedDurationMs).toBe(40 * MIN)
  })

  it('matches each report to the span its own times overlap, not both to the latest', async () => {
    const pid = newProject()
    const t = newTicket(pid)
    timedSpan(pid, t.id, 'hunt', 2, 500, 410) // 90 s
    timedSpan(pid, t.id, 'hunt', 2, 1000, 600) // 400 s
    const shorter = await tool('write_run_report', {
      projectId: pid,
      ticketId: t.id,
      agent: 'hunt',
      round: 2,
      startedAt: ago(500),
      endedAt: ago(410),
    })
    const longer = await tool('write_run_report', {
      projectId: pid,
      ticketId: t.id,
      agent: 'hunt',
      round: 2,
      startedAt: ago(1000),
      endedAt: ago(600),
    })
    expect(shorter.durationSource).toBe('measured')
    expect(longer.durationSource).toBe('measured')
    expect(Math.abs(shorter.durationMs - 90_000)).toBeLessThan(2_000)
    expect(Math.abs(longer.durationMs - 400_000)).toBeLessThan(2_000)
    // And each kept its own run's times, not the other run's.
    expect(Math.abs(Date.parse(shorter.startedAt) - Date.parse(ago(500)))).toBeLessThan(2_000)
    expect(Math.abs(Date.parse(longer.startedAt) - Date.parse(ago(1000)))).toBeLessThan(2_000)
  })

  it('keeps the agent’s own duration when its times overlap no span', async () => {
    const pid = newProject()
    const t = newTicket(pid)
    closedSpan(pid, t.id, 'hunt', 2, 90)
    const start = hoursAgo(5)
    const end = hoursAgo(4)
    const far = await tool('write_run_report', {
      projectId: pid,
      ticketId: t.id,
      agent: 'hunt',
      round: 2,
      startedAt: start,
      endedAt: end,
      durationMs: 40 * MIN,
    })
    // The span measured a run minutes ago; this report's own window is hours away from it.
    expect(far.durationSource).toBe('self')
    expect(far.durationMs).toBe(40 * MIN)
    expect(far.reportedDurationMs).toBe(40 * MIN)
    expect(Date.parse(far.startedAt)).toBe(Date.parse(start))
    expect(Date.parse(far.endedAt)).toBe(Date.parse(end))
  })

  it('measures neither of two reports whose times fit two spans equally well', async () => {
    const pid = newProject()
    const t = newTicket(pid)
    const start = ago(500)
    const end = ago(400)
    spanBetween(pid, t.id, 'hunt', 2, start, end)
    spanBetween(pid, t.id, 'hunt', 2, start, end)
    const wrote: { durationSource: string; durationMs: number }[] = []
    for (const durationMs of [5 * MIN, 7 * MIN])
      wrote.push(
        await tool('write_run_report', {
          projectId: pid,
          ticketId: t.id,
          agent: 'hunt',
          round: 2,
          startedAt: start,
          endedAt: end,
          durationMs,
        }),
      )
    // Two runs cannot be told apart by identical spans and identical times: each keeps its own estimate.
    expect(wrote.map((r) => r.durationSource)).toEqual(['self', 'self'])
    expect(wrote.map((r) => r.durationMs)).toEqual([5 * MIN, 7 * MIN])
  })

  it('says the duration is unknown, not a self-reported zero, when a report gives no timing', async () => {
    const pid = newProject()
    const t = newTicket(pid)
    const untimed = await tool('write_run_report', { projectId: pid, ticketId: t.id, agent: 'hunt' })
    expect(untimed.durationSource).toBe('unknown')
    expect(untimed.durationMs).toBe(0)
    expect(untimed.reportedDurationMs).toBeNull()
    expect(untimed.startedAt).toBeNull()
    expect(untimed.endedAt).toBeNull()
  })
})

describe('the hand-off flag', () => {
  it('names a subagent run the timeline records with no report, and clears once one is written', async () => {
    const pid = newProject()
    const t = newTicket(pid)
    closedSpan(pid, t.id, 'hunt', 2, 30)
    const moved = await needs.changeTicket(t.id, { status: 'review' }, HUMAN, { agent: false })
    expect(moved.missingRunReports).toEqual([expect.objectContaining({ agent: 'hunt', round: 2, spans: 1 })])
    // The ticket page carries the same flag in a review stage.
    expect((await call('GET', `/api/tickets/${t.id}`)).body.missingRunReports).toEqual([
      expect.objectContaining({ agent: 'hunt', round: 2 }),
    ])
    await tool('write_run_report', { projectId: pid, ticketId: t.id, agent: 'hunt', round: 2 })
    await needs.changeTicket(t.id, { status: 'in_progress' }, HUMAN, { agent: false })
    const clean = await needs.changeTicket(t.id, { status: 'review' }, HUMAN, { agent: false })
    expect(clean.missingRunReports).toEqual([])
    // A ticket only the orchestrator worked has no subagent run and no flag.
    const onlyOrchestrator = newTicket(pid, 'driven')
    work.startSpan(pid, onlyOrchestrator.id, { phase: 'build', agent: 'orch' }, AGENT)
    work.endSpan(pid, onlyOrchestrator.id, { agent: 'orch' }, AGENT)
    const driven = await needs.changeTicket(onlyOrchestrator.id, { status: 'review' }, HUMAN, {
      agent: false,
    })
    expect(driven.missingRunReports).toEqual([])
  })

  it('flags a round with more recorded runs than reports', async () => {
    const pid = newProject()
    const t = newTicket(pid)
    closedSpan(pid, t.id, 'hunt', 2, 90)
    closedSpan(pid, t.id, 'hunt', 2, 400)
    await tool('write_run_report', { projectId: pid, ticketId: t.id, agent: 'hunt', round: 2 })
    const moved = await needs.changeTicket(t.id, { status: 'review' }, HUMAN, { agent: false })
    expect(moved.missingRunReports).toEqual([
      expect.objectContaining({ agent: 'hunt', round: 2, runs: 2, spans: 2, reports: 1 }),
    ])
  })

  it('counts a hand-off as a recorded run: flagged alone, one run beside its span', async () => {
    const pid = newProject()
    const onlyHandoff = newTicket(pid, 'briefed, no span')
    work.handoff(pid, onlyHandoff.id, { to: 'hunt' }, AGENT)
    const flagged = await needs.changeTicket(onlyHandoff.id, { status: 'review' }, HUMAN, {
      agent: false,
    })
    expect(flagged.missingRunReports).toEqual([
      expect.objectContaining({ agent: 'hunt', round: null, runs: 1, spans: 0, reports: 0 }),
    ])
    // A hand-off names no round, so a report that names the run's round still counts as its evidence.
    await tool('write_run_report', { projectId: pid, ticketId: onlyHandoff.id, agent: 'hunt', round: 1 })
    await needs.changeTicket(onlyHandoff.id, { status: 'in_progress' }, HUMAN, { agent: false })
    const cleared = await needs.changeTicket(onlyHandoff.id, { status: 'review' }, HUMAN, {
      agent: false,
    })
    expect(cleared.missingRunReports).toEqual([])
    // A normal run has the span and the hand-off that briefed it: one run, one report, nothing flagged.
    const normal = newTicket(pid, 'briefed and worked')
    handoffAt(pid, normal.id, 'hunt', ago(120))
    closedSpan(pid, normal.id, 'hunt', 1, 60)
    await tool('write_run_report', { projectId: pid, ticketId: normal.id, agent: 'hunt', round: 1 })
    const clean = await needs.changeTicket(normal.id, { status: 'review' }, HUMAN, { agent: false })
    expect(clean.missingRunReports).toEqual([])
  })

  it('flags a hand-off with no span as its own run, and clears it only with a later report', async () => {
    const pid = newProject()
    const t = newTicket(pid, 'reported, then briefed again')
    // A report of an earlier hunt run, written before this hand-off: it cannot cover the run it briefs.
    const earlier = await tool('write_run_report', {
      projectId: pid,
      ticketId: t.id,
      agent: 'hunt',
      round: 1,
    })
    reportWrittenAt(earlier.id, ago(300))
    handoffAt(pid, t.id, 'hunt', ago(60))
    const flagged = await needs.changeTicket(t.id, { status: 'review' }, HUMAN, { agent: false })
    expect(flagged.missingRunReports).toEqual([
      expect.objectContaining({ agent: 'hunt', round: null, runs: 1, spans: 0, reports: 0 }),
    ])
    // A report written after the hand-off is its evidence, whatever round it names.
    await tool('write_run_report', { projectId: pid, ticketId: t.id, agent: 'hunt', round: 2 })
    await needs.changeTicket(t.id, { status: 'in_progress' }, HUMAN, { agent: false })
    const cleared = await needs.changeTicket(t.id, { status: 'review' }, HUMAN, { agent: false })
    expect(cleared.missingRunReports).toEqual([])
  })

  it('one report covers one run: a round-1 report the span already counts does not clear a later hand-off', async () => {
    const pid = newProject()
    const t = newTicket(pid, 'one report, two runs')
    // A round-1 hunt run: its hand-off, the span that briefed it, and no report for it yet.
    handoffAt(pid, t.id, 'hunt', ago(1000))
    spanBetween(pid, t.id, 'hunt', 1, ago(900), ago(600))
    // A later hunt hand-off with no span after it: a run of its own.
    handoffAt(pid, t.id, 'hunt', ago(300))
    // One round-1 report, written after that later hand-off: it is the round-1 run's evidence only.
    const only = await tool('write_run_report', { projectId: pid, ticketId: t.id, agent: 'hunt', round: 1 })
    reportWrittenAt(only.id, ago(100))
    const flagged = await needs.changeTicket(t.id, { status: 'review' }, HUMAN, { agent: false })
    expect(flagged.missingRunReports).toEqual([
      expect.objectContaining({ agent: 'hunt', round: null, runs: 1, spans: 0, reports: 0 }),
    ])
    // A report of its own, written after it, clears that run.
    await tool('write_run_report', { projectId: pid, ticketId: t.id, agent: 'hunt', round: 2 })
    await needs.changeTicket(t.id, { status: 'in_progress' }, HUMAN, { agent: false })
    const cleared = await needs.changeTicket(t.id, { status: 'review' }, HUMAN, { agent: false })
    expect(cleared.missingRunReports).toEqual([])
  })

  it('briefs the run that starts after a hand-off, not the nearest round that came before', async () => {
    const pid = newProject()
    const t = newTicket(pid, 'a round, then a run that left no span')
    // A round-1 run: its hand-off, the span that started after it, and the report it wrote.
    handoffAt(pid, t.id, 'hunt', ago(600))
    spanBetween(pid, t.id, 'hunt', 1, ago(580), ago(500))
    const first = await tool('write_run_report', {
      projectId: pid,
      ticketId: t.id,
      agent: 'hunt',
      round: 1,
    })
    reportWrittenAt(first.id, ago(400))
    // A later hand-off that records a run of its own, and that run's own report, written after it.
    handoffAt(pid, t.id, 'hunt', ago(120))
    await tool('write_run_report', { projectId: pid, ticketId: t.id, agent: 'hunt', round: 2 })
    const moved = await needs.changeTicket(t.id, { status: 'review' }, HUMAN, { agent: false })
    expect(moved.missingRunReports).toEqual([])
  })
})

describe('the review phases flag', () => {
  const ticketOf = (pid: number, complexity: 'low' | 'mid' | 'high' | 'max' = 'mid') =>
    features.createTicket(pid, { title: 'work', status: 'in_progress', complexity }, HUMAN)
  const toReview = (id: number) => needs.changeTicket(id, { status: 'review' }, HUMAN, { agent: false })
  const spans = (pid: number, id: number, round: number, phases: string[]) =>
    phases.forEach((phase, i) => closedSpan(pid, id, phase, round, 600 - i * 10))

  it('names the phase the last round lacks and the hunt that ran once, and the move still succeeds', async () => {
    const pid = newProject()
    const t = ticketOf(pid)
    spans(pid, t.id, 1, ['spec', 'env', 'verify', 'hunt', 'hunt', 'refute', 'merge'])
    spans(pid, t.id, 2, ['spec', 'env', 'verify', 'hunt', 'refute'])
    const moved = await toReview(t.id)
    expect(moved.status).toBe('review')
    expect(moved.missingReviewPhases).toEqual([
      { round: 2, phase: 'hunt', expected: 2, found: 1 },
      { round: 2, phase: 'merge', expected: 1, found: 0 },
    ])
    // The ticket page carries the same flag in a review stage.
    expect((await call('GET', `/api/tickets/${t.id}`)).body.missingReviewPhases).toEqual(
      moved.missingReviewPhases,
    )
  })

  it('is empty when every phase ran in the last round, a numbered hunt worker counting as a hunt', async () => {
    const pid = newProject()
    const t = ticketOf(pid, 'high')
    spans(pid, t.id, 1, ['spec', 'env', 'verify', 'hunt-1', 'hunt-2', 'refute', 'merge'])
    expect((await toReview(t.id)).missingReviewPhases).toEqual([])
  })

  it('credits a phase with a run report alone, and counts one run with a span and a report once', async () => {
    const pid = newProject()
    const t = ticketOf(pid)
    spans(pid, t.id, 1, ['spec', 'env', 'verify', 'hunt', 'refute'])
    // A report with no span credits merge; the second hunt has a report for the same run as its span.
    await tool('write_run_report', { projectId: pid, ticketId: t.id, agent: 'merge', round: 1 })
    await tool('write_run_report', { projectId: pid, ticketId: t.id, agent: 'hunt', round: 1 })
    expect((await toReview(t.id)).missingReviewPhases).toEqual([
      { round: 1, phase: 'hunt', expected: 2, found: 1 },
    ])
    await tool('write_run_report', { projectId: pid, ticketId: t.id, agent: 'hunt-2', round: 1 })
    // Read in place: a move out of review would be a send-back, which restarts the count.
    expect(missingReviewPhases(t.id)).toEqual([])
  })

  describe('after a send-back', () => {
    const full = ['spec', 'env', 'verify', 'hunt', 'hunt', 'refute', 'merge']
    const sendBack = async (id: number) => {
      await toReview(id)
      await needs.changeTicket(id, { status: 'in_progress' }, HUMAN, { agent: false })
      // The two moves happened 300 seconds ago: the re-run's spans start after them.
      dbm.db
        .update(dbm.schema.ticketEvents)
        .set({ at: ago(300) })
        .where(and(eq(dbm.schema.ticketEvents.ticketId, id), eq(dbm.schema.ticketEvents.kind, 'stage')))
        .run()
    }
    const rerun = (pid: number, id: number, round: number, phases: string[]) =>
      phases.forEach((phase, i) => closedSpan(pid, id, phase, round, 100 - i * 5))

    it('does not let the old rounds hide a phase the re-run lacks', async () => {
      const pid = newProject()
      const t = ticketOf(pid, 'high')
      for (const round of [1, 2, 3]) spans(pid, t.id, round, full)
      await sendBack(t.id)
      rerun(pid, t.id, 1, ['spec', 'env', 'verify', 'hunt', 'refute', 'merge'])
      expect((await toReview(t.id)).missingReviewPhases).toEqual([
        { round: 1, phase: 'hunt', expected: 2, found: 1 },
      ])
    })

    it('is unchanged without a send-back: the old rounds count', async () => {
      const pid = newProject()
      const t = ticketOf(pid, 'high')
      for (const round of [1, 2, 3]) spans(pid, t.id, round, full)
      closedSpan(pid, t.id, 'hunt', 1, 50)
      expect((await toReview(t.id)).missingReviewPhases).toEqual([])
    })

    it('does not count run reports from before the send-back', async () => {
      const pid = newProject()
      const t = ticketOf(pid)
      for (const agent of ['spec', 'env', 'verify', 'hunt', 'hunt-2', 'refute', 'merge'])
        await tool('write_run_report', { projectId: pid, ticketId: t.id, agent, round: 1 })
      await sendBack(t.id)
      dbm.db
        .update(dbm.schema.runReports)
        .set({ createdAt: ago(600) })
        .where(eq(dbm.schema.runReports.ticketId, t.id))
        .run()
      rerun(pid, t.id, 1, ['spec', 'env', 'verify', 'hunt', 'hunt', 'refute'])
      expect((await toReview(t.id)).missingReviewPhases).toEqual([
        { round: 1, phase: 'merge', expected: 1, found: 0 },
      ])
    })
  })

  it('is empty for a low ticket, a ticket with no timeline activity and a project with no software kind', async () => {
    const pid = newProject()
    const low = ticketOf(pid, 'low')
    spans(pid, low.id, 1, ['spec'])
    expect((await toReview(low.id)).missingReviewPhases).toEqual([])
    const quiet = ticketOf(pid)
    expect((await toReview(quiet.id)).missingReviewPhases).toEqual([])
    const music = dbm.db
      .insert(dbm.schema.projects)
      .values({ name: 'songs', kinds: ['music'] })
      .returning()
      .get().id
    const song = features.createTicket(music, { title: 'song', status: 'in_progress' }, HUMAN)
    spans(music, song.id, 1, ['spec'])
    expect(missingReviewPhases(song.id)).toEqual([])
  })

  it('counts activity with no round as round 1, and flags every phase of it', async () => {
    const pid = newProject()
    const t = ticketOf(pid)
    work.handoff(pid, t.id, { to: 'builder' }, AGENT)
    expect((await toReview(t.id)).missingReviewPhases.map((m: { phase: string }) => m.phase)).toEqual([
      'spec',
      'env',
      'verify',
      'hunt',
      'refute',
      'merge',
    ])
  })

  it('checks only the last round: an earlier gap is not flagged once the last one is complete', async () => {
    const pid = newProject()
    const t = ticketOf(pid)
    spans(pid, t.id, 1, ['spec', 'env'])
    spans(pid, t.id, 2, ['spec', 'env', 'verify', 'hunt', 'hunt', 'refute', 'merge'])
    expect((await toReview(t.id)).missingReviewPhases).toEqual([])
  })

  it('is [] outside review: a move to another stage, and the view of a ticket in progress', async () => {
    const pid = newProject()
    const t = ticketOf(pid)
    spans(pid, t.id, 1, ['spec'])
    const moved = await needs.changeTicket(t.id, { title: 'renamed' }, HUMAN, { agent: false })
    expect(moved.missingReviewPhases).toEqual([])
    expect((await call('GET', `/api/tickets/${t.id}`)).body.missingReviewPhases).toEqual([])
  })
})

describe('the templates', () => {
  const templateDir = path.join(import.meta.dirname, 'skill', 'review', 'run-reports')
  const template = (agent: string) => fs.readFileSync(path.join(templateDir, `${agent}.md`), 'utf8')
  const commonPart = [
    'the kind of run',
    'ticket',
    'round',
    'branch and head SHA',
    'model and effort',
    'who briefed it',
    'start and end',
    'duration',
    'where the time went',
    'readingMs',
    'runningMs',
    'waitingMs',
    'writingMs',
    'the brief, and whether it was enough',
    'what you read and ran',
    'the steps, against your instructions',
    'difficulty and confidence',
    'problems',
    'what you could not check, and your assumptions',
    'what you would do with more time',
    'what would have made the run better',
    'counts',
  ]
  const specific: Record<string, string[]> = {
    spec: ['intent', 'inferences', 'questions'],
    builder: ['approach', 'alternatives', 'selfTests', 'fixPass'],
    runner: ['scheduling', 'judging'],
    env: ['provisioning', 'freshness'],
    verify: ['evidence', 'unexercised'],
    hunt: ['techniques', 'surfaces', 'candidates'],
    refute: ['disproof', 'unsettled'],
    merge: ['conflicts'],
    intent: ['asked', 'compared'],
  }

  it('ships one per default agent, in the review bundle, each different and carrying its own part', () => {
    const paths = agentsModule.reviewBundlePaths()
    const seen = new Set<string>()
    for (const agent of AGENTS) {
      expect(paths, agent).toContain(`run-reports/${agent}.md`)
      const text = template(agent)
      seen.add(text)
      for (const part of specific[agent]!)
        expect(text.toLowerCase(), `${agent} ${part}`).toContain(part.toLowerCase())
      expect(text).toContain(`run-reports/${agent}.md`)
    }
    expect(seen.size).toBe(AGENTS.length)
    // The common part too, the templates are no aliases of each other.
    expect(fs.existsSync(path.join(templateDir, 'common.md'))).toBe(true)
  })

  it('carries the whole common part in every one of the nine', () => {
    for (const agent of AGENTS) {
      const text = template(agent)
      for (const part of commonPart) expect(text, `${agent}: ${part}`).toContain(part)
      // And what the agent does, beyond the common part.
      for (const part of specific[agent]!)
        expect(text.toLowerCase(), `${agent}: ${part}`).toContain(part.toLowerCase())
    }
  })

  it('names its own template and the rule in each default agent’s instructions, never another’s', () => {
    const byName = new Map(defaultAgents.DEFAULT_AGENTS.map((a) => [a.name, a]))
    for (const agent of AGENTS) {
      const instructions = byName.get(agent)!.instructions
      expect(instructions, agent).toContain(`run-reports/${agent}.md`)
      expect(instructions, agent).toMatch(/one report per subagent run/i)
      expect(instructions, agent).toMatch(/written before the hand-off/i)
      expect(instructions, agent).toMatch(/part of\s+finishing/i)
      expect(instructions, agent).toMatch(/orchestrator writes none/i)
      for (const other of AGENTS.filter((a) => a !== agent))
        expect(instructions, `${agent} names ${other}`).not.toContain(`run-reports/${other}.md`)
    }
  })

  it('is the rule in AGENTS.md, in the served board skill, and has the templates behind it', async () => {
    const root = path.join(import.meta.dirname, '..', '..')
    const texts = [
      fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'),
      fs.readFileSync(path.join(import.meta.dirname, 'skill', 'board.md'), 'utf8'),
    ]
    for (const text of texts) {
      expect(text).toMatch(/one report per subagent run/i)
      expect(text).toMatch(/written before the hand-off/i)
      expect(text).toMatch(/part of\s+finishing/i)
      expect(text).toMatch(/orchestrator writes none/i)
      expect(text).toContain('run-reports/')
    }
    const served = await handle(
      new Request('http://localhost/api/agent-setup/skill?client=claude', { headers: {} }),
    )
    expect(served.status).toBe(200)
    const body = await served.text()
    expect(body).toMatch(/one report per subagent run/i)
    expect(body).toMatch(/written before the hand-off/i)
    expect(body).toContain('run-reports/')
  })
})

describe('a project agent’s own template', () => {
  it('starts with the common part, is saved with the agent, and reads back through get_project', async () => {
    const pid = newProject()
    const created = await call('POST', `/api/projects/${pid}/agents`, { name: 'auditor' })
    expect(created.status).toBe(201)
    expect(created.body.reportTemplate).toContain('the kind of run')
    expect(created.body.reportTemplate).toBe(projectAgents.commonRunReportTemplate)
    const own = '## The rule\n\nAudit the audit: one run report, before the hand-off.\n'
    const saved = await call('PATCH', `/api/agents/${created.body.id}`, { reportTemplate: own })
    expect(saved.body.reportTemplate).toBe(own)
    const project = await call('GET', `/api/projects/${pid}`)
    expect(project.body.agents.find((a: { name: string }) => a.name === 'auditor').reportTemplate).toBe(own)
    // A report of a project agent is kept like any other, and lists under its name.
    const t = newTicket(pid)
    await tool('write_run_report', { projectId: pid, ticketId: t.id, agent: 'auditor' })
    const listed = await tool('list_run_reports', { projectId: pid, agent: 'auditor' })
    expect(listed).toHaveLength(1)
    expect(listed[0].ticketTitle).toBe(t.title)
  })

  it('defaults every default agent added to the project to the common part', async () => {
    const pid = newProject()
    defaultAgents.addDefaultAgents(pid, HUMAN)
    const rows = projectAgents.listAgents(pid)
    expect(rows).toHaveLength(AGENTS.length)
    for (const a of rows) expect(a.reportTemplate).toBe(projectAgents.commonRunReportTemplate)
  })
})

describe('the review phases flag follows the ticket’s workflow', () => {
  const ticketOf = (pid: number, complexity: 'low' | 'mid' | 'high' | 'max' = 'mid', extra = {}) =>
    features.createTicket(pid, { title: 'work', status: 'in_progress', complexity, ...extra }, HUMAN)
  const spans = (pid: number, id: number, round: number, phases: string[]) =>
    phases.forEach((phase, i) => closedSpan(pid, id, phase, round, 600 - i * 10))
  const preset = (pid: number, id: string) => call('PUT', `/api/projects/${pid}/workflow`, { preset: id })
  const STANDARD = ['spec', 'env', 'verify', 'hunt', 'hunt', 'refute', 'merge']

  it('under Light expects one hunt and never asks for the other phases (H2)', async () => {
    const pid = newProject()
    await preset(pid, 'light')
    const t = ticketOf(pid)
    spans(pid, t.id, 1, ['hunt'])
    expect(missingReviewPhases(t.id)).toEqual([])
    // A round of only a spec ran: the hunt is what is missing, and nothing else is asked for.
    const none = ticketOf(pid)
    work.handoff(pid, none.id, { to: 'builder' }, AGENT)
    expect(missingReviewPhases(none.id)).toEqual([{ round: 1, phase: 'hunt', expected: 1, found: 0 }])
    const toReview = await needs.changeTicket(none.id, { status: 'review' }, HUMAN, { agent: false })
    expect(toReview.missingReviewPhases).toEqual([{ round: 1, phase: 'hunt', expected: 1, found: 0 }])
  })

  it('under Thorough expects three hunts (H3)', async () => {
    const pid = newProject()
    await preset(pid, 'thorough')
    const t = ticketOf(pid)
    spans(pid, t.id, 1, STANDARD)
    expect(missingReviewPhases(t.id)).toEqual([{ round: 1, phase: 'hunt', expected: 3, found: 2 }])
    closedSpan(pid, t.id, 'hunt-3', 1, 300)
    expect(missingReviewPhases(t.id)).toEqual([])
  })

  it('counts a hunt named after its checklist and Light’s reviewer, and no other near name', async () => {
    const thorough = newProject()
    await preset(thorough, 'thorough')
    const t = ticketOf(thorough)
    spans(thorough, t.id, 1, [
      'spec',
      'env',
      'verify',
      'hunt-1',
      'hunt-2',
      'hunt-security',
      'refute',
      'merge',
    ])
    expect(missingReviewPhases(t.id)).toEqual([])
    // A numbered word, and a sub-identity's last segment, count the same way.
    const other = ticketOf(thorough)
    spans(thorough, other.id, 1, [
      'spec',
      'env',
      'verify',
      'hunt-1',
      'orch/hunt-security-2',
      'hunt',
      'refute',
      'merge',
    ])
    expect(missingReviewPhases(other.id)).toEqual([])
    // Not a hunt: a name that only starts with the word, or has nothing after the dash.
    const near = ticketOf(thorough)
    spans(thorough, near.id, 1, [
      'spec',
      'env',
      'verify',
      'hunt-1',
      'hunt-2',
      'huntress',
      'hunt-',
      'refute',
      'merge',
    ])
    expect(missingReviewPhases(near.id)).toEqual([{ round: 1, phase: 'hunt', expected: 3, found: 2 }])

    const light = newProject()
    await preset(light, 'light')
    const l = ticketOf(light)
    spans(light, l.id, 1, ['reviewer'])
    expect(missingReviewPhases(l.id)).toEqual([])
    // A reviewer is a hunt only as the board names it: another word is not.
    const reviewers = ticketOf(light)
    spans(light, reviewers.id, 1, ['reviewers', 'code-reviewer'])
    expect(missingReviewPhases(reviewers.id)).toEqual([{ round: 1, phase: 'hunt', expected: 1, found: 0 }])
  })

  it('counts a span or report named reviewer as a hunt even when the project has an agent of that name', async () => {
    const pid = newProject()
    defaultAgents.addDefaultAgents(pid, HUMAN)
    projectAgents.createAgent(pid, { name: 'reviewer' }, HUMAN)
    await preset(pid, 'light')
    const flags = async (id: number) => {
      const moved = await needs.changeTicket(id, { status: 'review' }, HUMAN, { agent: false })
      await needs.changeTicket(id, { status: 'in_progress' }, HUMAN, { agent: false })
      return [moved.missingReviewPhases, moved.missingRunReports]
    }
    // Spans and reports named after the one reviewer, and after the hunt, in every pairing: neither flag.
    for (const [spanName, reportName] of [
      ['reviewer', 'reviewer'],
      ['hunt', 'hunt'],
      ['reviewer', 'hunt'],
      ['hunt', 'reviewer'],
    ] as const) {
      const t = ticketOf(pid)
      closedSpan(pid, t.id, spanName, 1, 60)
      await tool('write_run_report', { projectId: pid, ticketId: t.id, agent: reportName, round: 1 })
      expect(await flags(t.id), `${spanName} span, ${reportName} report`).toEqual([[], []])
    }
    // Without the report the run is flagged, as a hunt.
    const bare = ticketOf(pid)
    closedSpan(pid, bare.id, 'reviewer', 1, 60)
    const [phases, reports] = await flags(bare.id)
    expect(phases).toEqual([])
    expect(reports).toEqual([expect.objectContaining({ agent: 'hunt', round: 1, runs: 1, reports: 0 })])
  })

  it('under Maximum doubles each phase (H3)', async () => {
    const pid = newProject()
    await preset(pid, 'maximum')
    const t = ticketOf(pid)
    spans(pid, t.id, 1, [...STANDARD, 'hunt', ...STANDARD])
    expect(missingReviewPhases(t.id)).toEqual([{ round: 1, phase: 'hunt', expected: 6, found: 5 }])
    closedSpan(pid, t.id, 'hunt', 1, 200)
    expect(missingReviewPhases(t.id)).toEqual([])
    const bare = ticketOf(pid)
    spans(pid, bare.id, 1, ['spec', 'env'])
    expect(missingReviewPhases(bare.id).map((m) => `${m.phase}:${m.expected}`)).toEqual([
      'spec:2',
      'env:2',
      'verify:2',
      'hunt:6',
      'refute:2',
      'merge:2',
    ])
  })

  it('changes with a ticket’s own preset, and with the project’s tweaks (H3)', async () => {
    const pid = newProject()
    const t = ticketOf(pid, 'mid', { workflowPreset: 'light' })
    spans(pid, t.id, 1, ['hunt'])
    // The project is Standard; the ticket is Light.
    expect(missingReviewPhases(t.id)).toEqual([])
    const plain = ticketOf(pid)
    spans(pid, plain.id, 1, ['hunt'])
    expect(missingReviewPhases(plain.id).map((m) => m.phase)).toEqual([
      'spec',
      'env',
      'verify',
      'hunt',
      'refute',
      'merge',
    ])
    await call('PATCH', `/api/tickets/${t.id}`, { workflowPreset: null })
    expect(missingReviewPhases(t.id).map((m) => m.phase)).toContain('spec')
    // A project whose Standard has no review for mid expects nothing.
    await call('PUT', `/api/projects/${pid}/workflow/standard`, { rounds: { mid: 0 } })
    expect(missingReviewPhases(t.id)).toEqual([])
    await call('PUT', `/api/projects/${pid}/workflow/standard`, { steps: { review: { enabled: false } } })
    expect(missingReviewPhases(plain.id)).toEqual([])
  })

  it("counts by the step's role whichever Team agent a node names, and a missing pick changes nothing (B11)", async () => {
    const pid = newProject()
    projectAgents.createAgent(pid, { name: 'sec-hunter', instructions: 'Look for holes.' }, HUMAN)
    projectAgents.createAgent(pid, { name: 'acme-dev', instructions: 'Build.' }, HUMAN)
    const picked = await call('PUT', `/api/projects/${pid}/workflow/thorough`, {
      agents: {
        'review.hunt-a': 'sec-hunter',
        'review.hunt-b': 'sec-hunter',
        'review.hunt-security': 'acme-dev',
        build: 'acme-dev',
      },
    })
    expect(picked.status).toBe(200)
    await preset(pid, 'thorough')
    const t = ticketOf(pid)
    // The ticket agent names every phase by its role, as the served text says; the three hunts are hunts.
    spans(pid, t.id, 1, ['spec', 'env', 'verify', 'hunt', 'hunt', 'hunt-security', 'refute', 'merge'])
    expect(missingReviewPhases(t.id)).toEqual([])
    // A span named after the Team agent is no phase of the round: the board counts by role.
    const wrong = ticketOf(pid)
    spans(pid, wrong.id, 1, [
      'spec',
      'env',
      'verify',
      'sec-hunter',
      'sec-hunter',
      'acme-dev',
      'refute',
      'merge',
    ])
    expect(missingReviewPhases(wrong.id)).toEqual([{ round: 1, phase: 'hunt', expected: 3, found: 0 }])
    // What a round needs is the same with no pick, with picks, and with picks whose agents left the Team.
    const { ticketWorkflow } = await import('./workflow')
    const { reviewPhaseRuns } = await import('#/lib/workflow')
    const needed = () => reviewPhaseRuns(ticketWorkflow({ id: t.id, projectId: pid, complexity: 'mid' }))
    const withPicks = needed()
    for (const name of ['sec-hunter', 'acme-dev'])
      projectAgents.deleteAgent(projectAgents.findAgent(pid, name)!.id, HUMAN)
    expect(needed()).toEqual(withPicks)
    expect(missingReviewPhases(t.id)).toEqual([])
    await call('DELETE', `/api/projects/${pid}/workflow/thorough`)
    expect(needed()).toEqual(withPicks)
    expect(withPicks).toEqual([
      { phase: 'spec', expected: 1 },
      { phase: 'env', expected: 1 },
      { phase: 'verify', expected: 1 },
      { phase: 'hunt', expected: 3 },
      { phase: 'refute', expected: 1 },
      { phase: 'merge', expected: 1 },
    ])
  })

  it('reads run kinds the same with or without a Team agent bound to a hunt (B11)', async () => {
    const pid = newProject()
    projectAgents.createAgent(pid, { name: 'sec-hunter' }, HUMAN)
    await call('PUT', `/api/projects/${pid}/workflow/standard`, { agents: { 'review.hunt-a': 'sec-hunter' } })
    const t = ticketOf(pid)
    spans(pid, t.id, 1, ['spec', 'env', 'verify', 'hunt-1', 'orch/hunt-2', 'refute', 'merge'])
    expect(missingReviewPhases(t.id)).toEqual([])
    const reports = await tool('write_run_report', {
      projectId: pid,
      ticketId: t.id,
      agent: 'hunt',
      round: 1,
    })
    expect(reports.agent).toBe('hunt')
  })

  it('stays empty for a low ticket, whatever the preset, and for a project with no software kind (H3)', async () => {
    const pid = newProject()
    for (const id of ['light', 'standard', 'thorough', 'maximum']) {
      await preset(pid, id)
      const low = ticketOf(pid, 'low')
      spans(pid, low.id, 1, ['spec'])
      expect(missingReviewPhases(low.id), id).toEqual([])
    }
    const music = dbm.db
      .insert(dbm.schema.projects)
      .values({ name: 'songs2', kinds: ['music'] })
      .returning()
      .get().id
    const song = features.createTicket(music, { title: 'song', status: 'in_progress' }, HUMAN)
    spans(music, song.id, 1, ['spec'])
    expect(missingReviewPhases(song.id)).toEqual([])
  })
})
