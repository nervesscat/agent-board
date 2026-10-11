import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-reports-overview-'))
process.env.DATA_DIR = tmp

let dbm: typeof import('#/db')
let reports: typeof import('./reports')
let overview: typeof import('./reportsOverview')
let handle: (request: Request) => Promise<Response>
beforeAll(async () => {
  dbm = await import('#/db')
  reports = await import('./reports')
  overview = await import('./reportsOverview')
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  // As the server answers: an HttpError becomes its status with `{error}`. A bearer token is an agent.
  const guarded = guard(({ request }: { request: Request }) =>
    api.handle(request, request.headers.has('authorization') ? 'claude' : 'enrique'),
  )
  handle = (request) => guarded({ request })
})

// Every date here is local time, like the board's days. Oct 5 2026 is a Monday, Oct 10 a Saturday.
const at = (day: string, time = '12:00') => new Date(`${day}T${time}:00`)
const newProject = (name: string) => dbm.db.insert(dbm.schema.projects).values({ name }).returning().get().id
/** A project tracking reports since Oct 1, on the default 09:00 to 17:00 shift on weekdays. */
const tracked = (name: string, patch: Parameters<typeof reports.setReportSettings>[1]) => {
  const p = newProject(name)
  reports.setReportSettings(p, patch, 'enrique', {}, at('2026-10-01'))
  return p
}
const entry = (o: ReturnType<typeof overview.reportsOverview>, id: number) =>
  o.projects.find((p) => p.id === id)

async function get(pathname: string, as: 'human' | 'agent' = 'human') {
  const res = await handle(
    new Request(`http://localhost${pathname}`, {
      headers: as === 'agent' ? { authorization: 'Bearer gate_test' } : {},
    }),
  )
  return { status: res.status, body: (await res.json()) as any }
}

describe('the reports overview', () => {
  it("lists every tracked project's period holding the day, by name, with its latest report and versions", async () => {
    const daily = tracked('Overview b daily', { cadence: 'daily' })
    const weekly = tracked('Overview a weekly', { cadence: 'weekly', weekday: 5 })
    const off = newProject('Overview c off')
    reports.setReportSettings(off, { prompt: 'Only a prompt.' }, 'enrique')

    await reports.postReport(daily, { period: '2026-10-06', body: 'First take.' }, 'claude')
    await reports.postReport(daily, { period: '2026-10-06', body: '## Done\n- shipped' }, 'enrique')
    // Any day of the week finds the week's report, kept under its Monday.
    await reports.postReport(weekly, { period: '2026-10-07', body: 'The week.' }, 'claude')

    const o = overview.reportsOverview('2026-10-06', at('2026-10-08'))
    expect(o.date).toBe('2026-10-06')
    const ids = o.projects.map((p) => p.id)
    expect(ids).not.toContain(off)
    expect(ids.indexOf(weekly)).toBeLessThan(ids.indexOf(daily))

    expect(entry(o, daily)).toMatchObject({
      name: 'Overview b daily',
      cadence: 'daily',
      period: '2026-10-06',
      label: 'Tue, Oct 6',
      status: 'done',
      due: at('2026-10-06', '17:00').toISOString(),
      versions: 2,
      report: { body: '## Done\n- shipped', author: 'enrique', attachments: [] },
    })
    expect(entry(o, weekly)).toMatchObject({
      cadence: 'weekly',
      period: '2026-10-05',
      label: 'week of Oct 5',
      status: 'done',
      due: at('2026-10-09', '17:00').toISOString(),
      versions: 1,
      report: { body: 'The week.', author: 'claude' },
    })
  })

  it('gives a period without a report its status: missing, upcoming, off on a day off or before tracking', () => {
    const p = tracked('Overview statuses', { cadence: 'daily' })
    const status = (day: string, now: Date) => entry(overview.reportsOverview(day, now), p)
    expect(status('2026-10-06', at('2026-10-06', '17:30'))).toMatchObject({
      status: 'missing',
      report: null,
      versions: 0,
    })
    expect(status('2026-10-06', at('2026-10-06', '16:00'))).toMatchObject({ status: 'upcoming' })
    // Saturday is not a workday; September 30 is before the project began tracking.
    expect(status('2026-10-10', at('2026-10-11'))).toMatchObject({ status: 'off' })
    expect(status('2026-09-30', at('2026-10-11'))).toMatchObject({ status: 'off', report: null })
  })

  it('is what GET /api/reports/overview answers, with local file paths for agents', async () => {
    const p = tracked('Overview files', { cadence: 'daily', format: 'file' })
    const file = path.join(tmp, 'overview.pdf')
    fs.writeFileSync(file, '%PDF-1.4 overview')
    const posted = await reports.postReport(p, { period: '2026-10-06', files: [file] }, 'claude')

    const res = await get('/api/reports/overview?date=2026-10-06', 'agent')
    expect(res.status).toBe(200)
    const mine = res.body.projects.find((x: { id: number }) => x.id === p)
    expect(mine).toMatchObject({ period: '2026-10-06', status: 'done', versions: 1 })
    expect(mine.report.id).toBe(posted.id)
    const a = mine.report.attachments[0]
    expect(a.path).toBeTruthy()
    expect(fs.readFileSync(a.path, 'utf8')).toBe('%PDF-1.4 overview')

    expect((await get('/api/reports/overview?date=2026-13-45')).status).toBe(400)
  })
})
