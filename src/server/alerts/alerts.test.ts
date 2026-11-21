import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { FeedItem } from './feed'
import type { AlertCandidate, AlertContext, AlertType } from './registry'

// The alerts live in SQLite: point the db at a throwaway directory before anything loads it. Test mode,
// as Playwright drives the board: X-Test-Actor says who calls.
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-alerts-')))
process.env.DATA_DIR = path.join(tmp, 'data')
process.env.BOARD_ENV = 'test'

const HUMAN = 'human:enrique'
const CLAUDE = 'agent:claude'
const HOUR = 60 * 60_000
const DAY = 24 * HOUR

let apiModule: typeof import('./../api')
let projects: typeof import('../projects')
let registry: typeof import('./registry')
let evaluate: typeof import('./evaluate')
let jobs: typeof import('../jobs')
let handle: (ctx: { request: Request; actor: string }) => Promise<Response>
let callerOf: typeof import('../auth').callerOf
let schema: typeof import('#/db').schema
let db: typeof import('#/db').db

beforeAll(async () => {
  apiModule = await import('../api')
  projects = await import('../projects')
  registry = await import('./registry')
  evaluate = await import('./evaluate')
  jobs = await import('../jobs')
  ;({ db, schema } = await import('#/db'))
  const { api: guard } = await import('../http')
  handle = guard(({ request, actor }: { request: Request; actor: string }) =>
    apiModule.api.handle(request, actor),
  )
  callerOf = (await import('../auth')).callerOf
}, 60_000)

const cleanups: (() => void)[] = []
afterEach(() => {
  vi.useRealTimers()
  while (cleanups.length) cleanups.pop()!()
})

let count = 0
const newProject = (label: string) => projects.createProject({ name: `${label} ${++count}` }, 'human').id

async function rest(method: string, pathname: string, testActor = HUMAN, body?: unknown) {
  const headers: Record<string, string> = { accept: 'application/json', 'x-test-actor': testActor }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const request = new Request(`http://localhost${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const caller = await callerOf(request)
  const res = await handle({ request, actor: caller!.name })
  return { status: res.status, body: (await res.json()) as any }
}

const feed = async (projectId: number, actor = HUMAN) =>
  (await rest('GET', `/api/projects/${projectId}/notifications`, actor)).body as FeedItem[]
const titles = async (projectId: number) => (await feed(projectId)).map((i) => i.title)

/** A type whose check answers whatever `state.found` holds right now. */
function typeWith(over: Partial<AlertType> = {}) {
  const state: { found: AlertCandidate[]; asked: (number | null)[] } = { found: [], asked: [] }
  const type: AlertType = {
    type: `t-${++count}`,
    idea: 99,
    group: 'work',
    label: 'A test type',
    description: 'Raised by the tests',
    scope: 'project',
    check: (ctx: AlertContext) => {
      state.asked.push(ctx.projectId)
      return state.found
    },
    ...over,
  }
  cleanups.push(registry.registerForTest(type))
  return { type, state }
}

const candidate = (over: Partial<AlertCandidate> = {}): AlertCandidate => ({
  severity: 'warning',
  title: 'Something is off',
  body: 'Look at it',
  buttons: [{ id: 'go', label: 'Open', kind: 'link', href: '/projects/1' }],
  ...over,
})

describe('registry and evaluator', () => {
  it('shows a found alert in the feed with severity, buttons and isNew, and seen makes it not new', async () => {
    const projectId = newProject('feed')
    const { type, state } = typeWith()
    state.found = [candidate({ severity: 'problem', details: ['one', 'two'] })]
    const out = await evaluate.evaluateAlerts({ projectId })
    expect(out.started).toHaveLength(1)

    const [item] = await feed(projectId)
    expect(item).toMatchObject({
      key: `alert-${out.started[0]!.id}`,
      source: 'alert',
      type: type.type,
      severity: 'problem',
      title: 'Something is off',
      body: 'Look at it',
      isNew: true,
      group: 'work',
      details: ['one', 'two'],
      buttons: [{ id: 'go', label: 'Open', kind: 'link', href: '/projects/1' }],
      dismissible: true,
      snoozeOptions: [HOUR, DAY, 7 * DAY],
    })
    expect(JSON.parse(JSON.stringify(item))).toEqual(item)

    expect((await rest('POST', `/api/projects/${projectId}/notifications/seen`)).body).toEqual({ seen: 1 })
    expect((await feed(projectId))[0]!.isNew).toBe(false)
  })

  it('updates the words of a known alert and keeps what the human did with it', async () => {
    const projectId = newProject('update')
    const { state } = typeWith()
    state.found = [candidate({ title: 'Before' })]
    const first = await evaluate.evaluateAlerts({ projectId })
    const id = first.started[0]!.id
    await rest('POST', `/api/alerts/${id}/seen`)
    const seenAt = db
      .select()
      .from(schema.alerts)
      .all()
      .find((r) => r.id === id)!.seenAt

    state.found = [candidate({ title: 'After', severity: 'info' })]
    const second = await evaluate.evaluateAlerts({ projectId })
    expect(second.started).toEqual([])
    expect(second.updated.map((r) => r.id)).toEqual([id])
    const [item] = await feed(projectId)
    expect(item).toMatchObject({ title: 'After', severity: 'info', isNew: false })
    expect(
      db
        .select()
        .from(schema.alerts)
        .all()
        .find((r) => r.id === id)!.seenAt,
    ).toBe(seenAt)
    // Nothing changed: nothing is reported.
    expect((await evaluate.evaluateAlerts({ projectId })).updated).toEqual([])
  })

  it('keeps one alert per subject of a type and resolves each on its own', async () => {
    const projectId = newProject('subjects')
    const { state } = typeWith()
    state.found = [candidate({ subject: 'a', title: 'A' }), candidate({ subject: 'b', title: 'B' })]
    await evaluate.evaluateAlerts({ projectId })
    expect((await titles(projectId)).sort()).toEqual(['A', 'B'])
    state.found = [candidate({ subject: 'b', title: 'B' })]
    const out = await evaluate.evaluateAlerts({ projectId })
    expect(out.resolved.map((r) => r.subject)).toEqual(['a'])
    expect(await titles(projectId)).toEqual(['B'])
  })

  it('resolves an alert whose condition ended, and a return starts it again as new', async () => {
    const projectId = newProject('resolve')
    const { state } = typeWith()
    state.found = [candidate()]
    const id = (await evaluate.evaluateAlerts({ projectId })).started[0]!.id
    await rest('POST', `/api/alerts/${id}/seen`)
    await rest('POST', `/api/alerts/${id}/snooze`, HUMAN, { ms: HOUR })

    state.found = []
    expect((await evaluate.evaluateAlerts({ projectId })).resolved.map((r) => r.id)).toEqual([id])
    expect(await feed(projectId)).toEqual([])

    state.found = [candidate()]
    const back = await evaluate.evaluateAlerts({ projectId })
    expect(back.started.map((r) => r.id)).toEqual([id])
    const [item] = await feed(projectId)
    expect(item).toMatchObject({ key: `alert-${id}`, isNew: true })
  })

  it('a dismissal holds while the condition holds, ends with the alert, and a sticky type keeps it', async () => {
    const projectId = newProject('dismiss')
    const plain = typeWith()
    const sticky = typeWith({ stickyDismiss: true })
    for (const t of [plain, sticky]) t.state.found = [candidate({ title: t.type.type })]
    const out = await evaluate.evaluateAlerts({ projectId })
    for (const ref of out.started)
      expect((await rest('POST', `/api/alerts/${ref.id}/dismiss`)).status).toBe(200)
    expect(await feed(projectId)).toEqual([])

    // The condition still holds: still hidden, and not started again.
    expect((await evaluate.evaluateAlerts({ projectId })).started).toEqual([])
    expect(await feed(projectId)).toEqual([])

    // The condition ends and returns.
    for (const t of [plain, sticky]) t.state.found = []
    await evaluate.evaluateAlerts({ projectId })
    for (const t of [plain, sticky]) t.state.found = [candidate({ title: t.type.type })]
    await evaluate.evaluateAlerts({ projectId })
    expect(await titles(projectId)).toEqual([plain.type.type])
    expect((await feed(projectId))[0]!.isNew).toBe(true)
  })

  it('refuses to dismiss an alert of a type that cannot be dismissed', async () => {
    const projectId = newProject('keep')
    const { state } = typeWith({ dismissible: false })
    state.found = [candidate()]
    const id = (await evaluate.evaluateAlerts({ projectId })).started[0]!.id
    expect((await feed(projectId))[0]!.dismissible).toBe(false)
    expect((await rest('POST', `/api/alerts/${id}/dismiss`)).status).toBe(409)
    expect(await feed(projectId)).toHaveLength(1)
  })

  it('checks a project type once per project and a board type once, in every project', async () => {
    const a = newProject('scope a')
    const b = newProject('scope b')
    const projectType = typeWith()
    projectType.state.found = [candidate({ title: 'per project' })]
    const boardType = typeWith({ scope: 'board' })
    boardType.state.found = [candidate({ title: 'whole board' })]
    await evaluate.evaluateAlerts()
    expect(boardType.state.asked).toEqual([null])
    expect(projectType.state.asked).toEqual(expect.arrayContaining([a, b]))
    expect(await titles(a)).toContain('whole board')
    expect(await titles(b)).toContain('whole board')

    // A run narrowed to one project asks only it, and no board type.
    projectType.state.asked.length = boardType.state.asked.length = 0
    await evaluate.evaluateAlerts({ projectId: a })
    expect(projectType.state.asked).toEqual([a])
    expect(boardType.state.asked).toEqual([])
    await evaluate.evaluateAlerts({ projectId: a, type: boardType.type.type })
    expect(boardType.state.asked).toEqual([null])
  })

  it('shows a project alert in its own project only', async () => {
    const a = newProject('own a')
    const b = newProject('own b')
    const { state } = typeWith()
    state.found = [candidate({ title: 'only a' })]
    await evaluate.evaluateAlerts({ projectId: a })
    expect(await titles(a)).toContain('only a')
    expect(await titles(b)).not.toContain('only a')
  })

  it('never evaluates or lists a type that does not apply', async () => {
    const projectId = newProject('applies')
    const { type, state } = typeWith({ applies: () => false })
    state.found = [candidate()]
    await evaluate.evaluateAlerts({ projectId })
    expect(state.asked).toEqual([])
    const list = (await rest('GET', `/api/projects/${projectId}/alert-types`)).body as any[]
    expect(list.find((t) => t.type === type.type)).toMatchObject({ applies: false })
  })

  it('uses the injected clock', async () => {
    const projectId = newProject('clock')
    const { state } = typeWith()
    state.found = [candidate()]
    const at = Date.parse('2030-01-02T03:04:05.000Z')
    await evaluate.evaluateAlerts({ projectId, now: () => at })
    expect((await feed(projectId))[0]!.at).toBe('2030-01-02T03:04:05.000Z')
  })
})

describe('snooze, mute and what the human does', () => {
  it('hides a snoozed alert until its time, only for the options the type offers', async () => {
    const projectId = newProject('snooze')
    const { state } = typeWith({ snoozeOptions: [HOUR] })
    state.found = [candidate()]
    const id = (await evaluate.evaluateAlerts({ projectId })).started[0]!.id
    expect((await rest('POST', `/api/alerts/${id}/snooze`, HUMAN, { ms: 5 })).status).toBe(400)
    const snoozed = await rest('POST', `/api/alerts/${id}/snooze`, HUMAN, { ms: HOUR })
    expect(snoozed.status).toBe(200)
    expect(await feed(projectId)).toEqual([])

    // After the time, with the clock moved on, it shows again.
    expect(Date.parse(snoozed.body.snoozedUntil)).toBeGreaterThan(Date.now())
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse(snoozed.body.snoozedUntil) + 1)
    expect(await titles(projectId)).toEqual(['Something is off'])
  })

  it('mutes a type in one project only, and unmuting shows it again', async () => {
    const a = newProject('mute a')
    const b = newProject('mute b')
    const { type, state } = typeWith({ scope: 'board' })
    state.found = [candidate({ title: 'board wide' })]
    await evaluate.evaluateAlerts({ type: type.type })

    expect((await rest('PUT', `/api/projects/${a}/alert-mutes/${type.type}`)).status).toBe(200)
    expect(await titles(a)).not.toContain('board wide')
    expect(await titles(b)).toContain('board wide')
    const types = (await rest('GET', `/api/projects/${a}/alert-types`)).body as any[]
    expect(types.find((t) => t.type === type.type)).toMatchObject({
      group: 'work',
      label: 'A test type',
      description: 'Raised by the tests',
      idea: 99,
      muted: true,
      applies: true,
    })
    const other = (await rest('GET', `/api/projects/${b}/alert-types`)).body as any[]
    expect(other.find((t) => t.type === type.type).muted).toBe(false)

    expect((await rest('DELETE', `/api/projects/${a}/alert-mutes/${type.type}`)).status).toBe(200)
    expect(await titles(a)).toContain('board wide')
    expect((await rest('PUT', `/api/projects/${a}/alert-mutes/nope`)).status).toBe(404)
  })

  it('runs the handler of an action button and resolves when it says so', async () => {
    const projectId = newProject('action')
    const seen: string[] = []
    const { state } = typeWith({
      actions: {
        fix: (ctx) => {
          seen.push(`${ctx.alert.subject}@${ctx.projectId}`)
          return { message: 'Fixed', resolve: true }
        },
        boom: () => {
          throw new Error('it broke')
        },
      },
    })
    state.found = [
      candidate({
        subject: 's1',
        buttons: [
          { id: 'fix', label: 'Fix it', kind: 'action', primary: true },
          { id: 'boom', label: 'Break', kind: 'action' },
        ],
      }),
    ]
    const id = (await evaluate.evaluateAlerts({ projectId })).started[0]!.id
    expect((await rest('POST', `/api/alerts/${id}/actions/missing`)).status).toBe(404)
    const failed = await rest('POST', `/api/alerts/${id}/actions/boom`)
    expect(failed.status).toBe(500)
    expect(failed.body.error).toMatch(/it broke/)
    expect(await feed(projectId)).toHaveLength(1)

    const ran = await rest('POST', `/api/alerts/${id}/actions/fix`)
    expect(ran.body).toEqual({ ok: true, message: 'Fixed', resolved: true })
    expect(seen).toEqual([`s1@${projectId}`])
    expect(await feed(projectId)).toEqual([])
  })

  it('answers 403 to an agent on every mutating route and changes nothing', async () => {
    const projectId = newProject('agent')
    const { type, state } = typeWith({ actions: { fix: () => ({ resolve: true }) } })
    state.found = [candidate({ buttons: [{ id: 'fix', label: 'Fix', kind: 'action' }] })]
    const id = (await evaluate.evaluateAlerts({ projectId })).started[0]!.id
    const calls: [string, string, unknown?][] = [
      ['POST', `/api/alerts/${id}/seen`],
      ['POST', `/api/projects/${projectId}/notifications/seen`],
      ['POST', `/api/alerts/${id}/dismiss`],
      ['POST', `/api/alerts/${id}/snooze`, { ms: HOUR }],
      ['POST', `/api/alerts/${id}/actions/fix`],
      ['PUT', `/api/projects/${projectId}/alert-mutes/${type.type}`],
      ['DELETE', `/api/projects/${projectId}/alert-mutes/${type.type}`],
    ]
    for (const [method, url, body] of calls)
      expect((await rest(method, url, CLAUDE, body)).status, `${method} ${url}`).toBe(403)
    const [item] = await feed(projectId)
    expect(item).toMatchObject({ isNew: true })
    expect(
      db
        .select()
        .from(schema.alertMutes)
        .all()
        .some((m) => m.type === type.type),
    ).toBe(false)
    // An agent reads no alerts: they are the human's.
    expect((await feed(projectId, CLAUDE)).filter((i) => i.source === 'alert')).toEqual([])
  })
})

describe('the unified feed', () => {
  it('puts jobs, tracked cards and notices in one shape, newest first, and leaves the old endpoints alone', async () => {
    const projectId = newProject('unified')
    const job = jobs.startJob({
      kind: 'test',
      title: 'A job',
      projectId,
      actor: 'human',
      total: 4,
      href: `/projects/${projectId}/cleanup`,
    })
    jobs.progress(job.id, { done: 1, step: 'Step 1' })
    const failed = jobs.startJob({ kind: 'test', title: 'A failed job', projectId, actor: 'human', total: 2 })
    jobs.fail(failed.id, 'no space left')
    const cards = await import('../agentCards')
    const caller = { name: 'claude', agent: true }
    const tracked = cards.startTracked(caller, projectId, { title: 'Watch it', request: 'show me', total: 3 })
    cards.progressTracked(caller, projectId, tracked.id, { done: 2 })
    const notice = cards.postNotice(caller, projectId, {
      title: 'Heads up',
      body: 'It broke',
      reason: 'it matters',
    })
    const { state } = typeWith()
    state.found = [candidate({ title: 'An alert' })]
    await evaluate.evaluateAlerts({ projectId })

    const items = await feed(projectId)
    const by = (title: string) => items.find((i) => i.title === title)!
    expect(by('A job')).toMatchObject({
      key: `job-${job.id}`,
      source: 'job',
      severity: 'info',
      state: 'running',
      progress: { done: 1, total: 4 },
      href: `/projects/${projectId}/cleanup`,
      isNew: false,
      buttons: [],
    })
    expect(by('A failed job')).toMatchObject({ severity: 'problem', state: 'failed', body: 'no space left' })
    expect(by('Watch it')).toMatchObject({
      key: `card-${tracked.id}`,
      source: 'tracked',
      severity: 'info',
      state: 'running',
      progress: { done: 2, total: 3 },
    })
    expect(by('Heads up')).toMatchObject({
      key: `card-${notice.id}`,
      source: 'notice',
      severity: 'warning',
      state: 'notice',
      body: 'It broke',
    })
    expect(by('An alert')).toMatchObject({ source: 'alert' })
    expect(items.map((i) => i.at)).toEqual(
      items
        .map((i) => i.at)
        .sort()
        .reverse(),
    )
    // The job and card ride along whole, for what the panel shows of them.
    expect(by('A job').job).toMatchObject({ id: job.id, step: 'Step 1' })
    expect((by('Watch it').card as { request: string }).request).toBe('show me')

    const oldJobs = (await rest('GET', `/api/projects/${projectId}/jobs`)).body as any[]
    expect(oldJobs.map((j) => j.title).sort()).toEqual(['A failed job', 'A job'])
    const oldCards = (await rest('GET', `/api/projects/${projectId}/agent-cards`)).body as any[]
    expect(oldCards.map((c) => c.title).sort()).toEqual(['Heads up', 'Watch it'])
  })

  it('shows an agent only its own jobs and cards', async () => {
    const projectId = newProject('agent feed')
    jobs.startJob({ kind: 'test', title: 'Human job', projectId, actor: 'human', total: 1 })
    jobs.startJob({ kind: 'test', title: 'Claude job', projectId, actor: 'claude', total: 1 })
    expect((await feed(projectId, CLAUDE)).map((i) => i.title)).toEqual(['Claude job'])
  })

  it('404s an unknown project', async () => {
    expect((await rest('GET', '/api/projects/999999/notifications')).status).toBe(404)
  })
})

describe('a check that fails', () => {
  it('logs a throwing check, leaves its alerts as they are and goes on to the other types', async () => {
    const projectId = newProject('throws')
    const bad = typeWith()
    const good = typeWith()
    bad.state.found = [candidate({ title: 'stays' })]
    good.state.found = [candidate({ title: 'good one' })]
    await evaluate.evaluateAlerts({ projectId })

    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    cleanups.push(() => error.mockRestore())
    bad.type.check = () => {
      throw new Error('the disk is gone')
    }
    good.state.found = [candidate({ title: 'good two' })]
    const out = await evaluate.evaluateAlerts({ projectId })
    expect(out.failed).toEqual([{ type: bad.type.type, projectId, error: 'the disk is gone' }])
    expect(error).toHaveBeenCalledWith(expect.stringContaining('the disk is gone'))
    expect(out.resolved).toEqual([])
    const shown = await titles(projectId)
    expect(shown).toContain('stays')
    expect(shown).toContain('good two')
    expect(shown).not.toContain('good one')
  })

  it('gives up on a check that never returns after the timeout and leaves its alerts', async () => {
    const projectId = newProject('hangs')
    const { type, state } = typeWith()
    state.found = [candidate({ title: 'still here' })]
    await evaluate.evaluateAlerts({ projectId })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    cleanups.push(() => error.mockRestore())
    type.check = () => new Promise<AlertCandidate[]>(() => {})

    const started = Date.now()
    const out = await evaluate.evaluateAlerts({ projectId, timeoutMs: 50 })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(out.failed).toHaveLength(1)
    expect(out.failed[0]!.error).toMatch(/took longer than 50 ms/)
    expect(await titles(projectId)).toContain('still here')
  })
})

describe('the background run', () => {
  it('evaluates after the first delay and then on every interval, and stops when told', async () => {
    const projectId = newProject('loop')
    const { state } = typeWith()
    state.found = [candidate()]
    vi.useFakeTimers()
    const stop = evaluate.startAlertEvaluator({ first: 1000, every: 5000 })
    expect(state.asked).toEqual([])
    await vi.advanceTimersByTimeAsync(1000)
    expect(state.asked).toContain(projectId)
    const asked = state.asked.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(state.asked.length).toBeGreaterThan(asked)
    stop()
    const after = state.asked.length
    await vi.advanceTimersByTimeAsync(20_000)
    expect(state.asked.length).toBe(after)
  })
})

describe('the test seeding route', () => {
  it('writes an alert of a registered test type only a test-mode board allows', async () => {
    const projectId = newProject('seed')
    const made = await rest('POST', '/api/test/alerts', HUMAN, { projectId, title: 'Seeded' })
    expect(made.status).toBe(201)
    expect(await titles(projectId)).toEqual(['Seeded'])
    expect(apiModule.testOnlyAllowed('production')).toBe(false)
  })
})
