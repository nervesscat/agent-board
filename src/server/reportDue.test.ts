import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-report-due-'))
process.env.DATA_DIR = tmp

let dbm: typeof import('#/db')
let reports: typeof import('./reports')
let due: typeof import('./reportDue')
let handle: (request: Request) => Promise<Response>
beforeAll(async () => {
  dbm = await import('#/db')
  reports = await import('./reports')
  due = await import('./reportDue')
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  const guarded = guard(({ request }: { request: Request }) =>
    api.handle(request, request.headers.has('authorization') ? 'claude' : 'enrique'),
  )
  handle = (request) => guarded({ request })
})
afterEach(() => {
  vi.useRealTimers()
})

// Every date here is local time, like the board's days. Oct 5 2026 is a Monday, Oct 10 a Saturday.
const at = (day: string, time = '12:00') => new Date(`${day}T${time}:00`)
const newProject = (name: string) => dbm.db.insert(dbm.schema.projects).values({ name }).returning().get().id
/** A daily project tracked since Oct 1, its shift 09:00 to 17:00 on weekdays, reminding from 16:30. */
const dailyProject = (name: string) => {
  const p = newProject(name)
  reports.setReportSettings(p, { cadence: 'daily' }, 'me', {}, at('2026-10-01'))
  return p
}

async function call(pathname: string, as: 'human' | 'agent' = 'human') {
  const res = await handle(
    new Request(`http://localhost${pathname}`, {
      headers: as === 'agent' ? { authorization: 'Bearer token-of-test' } : {},
    }),
  )
  return { status: res.status, body: (await res.json()) as any }
}

async function mcp(name: string, args: Record<string, unknown>) {
  const { handleMcp } = await import('./mcp')
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
  const { result } = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } }
  expect(result.isError, result.content[0]!.text).toBeFalsy()
  return JSON.parse(result.content[0]!.text)
}

describe('reportDueFor', () => {
  it('names the project and its period while the reminder is open, and is null outside it', () => {
    const p = dailyProject('due-window')
    expect(due.reportDueFor(p, at('2026-10-05', '16:29'))).toBeNull()
    expect(due.reportDueFor(p, at('2026-10-05', '16:40'))).toEqual({
      projectId: p,
      project: 'due-window',
      cadence: 'daily',
      period: '2026-10-05',
      label: 'Mon, Oct 5',
      dueAt: at('2026-10-05', '17:00').toISOString(),
      alertAt: at('2026-10-05', '16:30').toISOString(),
      state: 'due',
      minutesLeft: 20,
    })
    expect(due.reportDueFor(p, at('2026-10-05', '17:10'))).toMatchObject({
      state: 'missing',
      minutesLeft: -10,
    })
    // The day is over: yesterday's missing report is the calendar's business.
    expect(due.reportDueFor(p, at('2026-10-06', '09:00'))).toBeNull()
    // Saturday is not a workday.
    expect(due.reportDueFor(p, at('2026-10-10', '16:45'))).toBeNull()
    expect(due.reportDueFor(p, at('2026-10-10', '18:00'))).toBeNull()
  })

  it('goes away once the period has a report, and follows the settings', async () => {
    const p = dailyProject('due-report')
    reports.setReportSettings(p, { shiftEnd: '18:00', alertMinutes: 60, workdays: [6] }, 'me')
    expect(due.reportDueFor(p, at('2026-10-05', '17:30'))).toBeNull() // Monday is off now
    expect(due.reportDueFor(p, at('2026-10-10', '17:00'))).toMatchObject({ state: 'due', minutesLeft: 60 })
    await reports.postReport(p, { body: 'Done.' }, 'claude', at('2026-10-10', '17:05'))
    expect(due.reportDueFor(p, at('2026-10-10', '17:10'))).toBeNull()
    expect(due.reportDueFor(p, at('2026-10-10', '19:00'))).toBeNull()
  })

  it('is due on the weekday of a weekly report whatever the workdays, missing until the week ends', () => {
    const p = newProject('due-weekly')
    reports.setReportSettings(
      p,
      { cadence: 'weekly', weekday: 7, shiftEnd: '12:00', alertMinutes: 30 },
      'me',
      {},
      at('2026-10-05'),
    )
    expect(due.reportDueFor(p, at('2026-10-10', '12:00'))).toBeNull()
    expect(due.reportDueFor(p, at('2026-10-11', '11:45'))).toMatchObject({
      cadence: 'weekly',
      period: '2026-10-05',
      label: 'week of Oct 5',
      state: 'due',
      minutesLeft: 15,
    })
    expect(due.reportDueFor(p, at('2026-10-11', '20:00'))).toMatchObject({ state: 'missing' })
    expect(due.reportDueFor(p, at('2026-10-12', '00:00'))).toBeNull()
  })

  it('is null while reports are off, and for a project that does not exist', () => {
    const p = newProject('due-off')
    expect(due.reportDueFor(p, at('2026-10-05', '16:45'))).toBeNull()
    reports.setReportSettings(p, { cadence: 'daily' }, 'me', {}, at('2026-10-01'))
    reports.setReportSettings(p, { cadence: 'off' }, 'me', {}, at('2026-10-02'))
    expect(due.reportDueFor(p, at('2026-10-05', '16:45'))).toBeNull()
    expect(due.reportDueFor(999_999, at('2026-10-05', '16:45'))).toBeNull()
  })
})

describe('reportsDue', () => {
  it('lists every project whose reminder is open, by name, and only those', () => {
    const now = at('2026-10-06', '16:50')
    const b = dailyProject('zz due b')
    const a = dailyProject('zz due a')
    const early = dailyProject('zz due later')
    reports.setReportSettings(early, { shiftEnd: '18:00' }, 'me')
    const mine = due.reportsDue(now).filter((d) => d.project.startsWith('zz due'))
    expect(mine.map((d) => [d.project, d.projectId, d.state])).toEqual([
      ['zz due a', a, 'due'],
      ['zz due b', b, 'due'],
    ])
  })
})

describe('reportDue over the API and MCP', () => {
  it('rides on /api/report-due, the summary and the inbox, as the board clock says', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(at('2026-10-07', '17:05'))
    const p = dailyProject('due-api')
    const expected = {
      projectId: p,
      project: 'due-api',
      cadence: 'daily',
      period: '2026-10-07',
      state: 'missing',
      minutesLeft: -5,
    }

    const items = (await call('/api/report-due')).body.items as { projectId: number }[]
    expect(items.find((i) => i.projectId === p)).toMatchObject(expected)
    expect((await call(`/api/summary?projectId=${p}`)).body.projects[0].reportDue).toMatchObject(expected)
    expect((await call(`/api/projects/${p}/inbox`, 'agent')).body).toMatchObject({
      count: 0,
      reportDue: expected,
    })
    expect((await mcp('get_summary', { projectId: p })).projects[0].reportDue).toMatchObject(expected)
    expect(await mcp('check_inbox', { projectId: p })).toMatchObject({ reportDue: expected })

    // Before the window it is null everywhere, and it stays null once the report is in.
    vi.setSystemTime(at('2026-10-07', '16:00'))
    expect((await call(`/api/summary?projectId=${p}`)).body.projects[0].reportDue).toBeNull()
    expect(
      (await call('/api/report-due')).body.items.map((i: { projectId: number }) => i.projectId),
    ).not.toContain(p)
    vi.setSystemTime(at('2026-10-07', '16:45'))
    expect((await call(`/api/projects/${p}/inbox`, 'agent')).body.reportDue).toMatchObject({
      state: 'due',
      minutesLeft: 15,
    })
    await reports.postReport(p, { body: 'Done.' }, 'claude')
    expect((await call(`/api/projects/${p}/inbox`, 'agent')).body.reportDue).toBeNull()
    expect(await mcp('check_inbox', { projectId: p })).toMatchObject({ reportDue: null })
  })
})
