import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-reports-api-'))
process.env.DATA_DIR = tmp

let dbm: typeof import('#/db')
let handle: (request: Request) => Promise<Response>
let reports: typeof import('./reports')
beforeAll(async () => {
  dbm = await import('#/db')
  reports = await import('./reports')
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  // As the server answers: an HttpError becomes its status with `{error}`. A bearer token is an agent.
  const guarded = guard(({ request }: { request: Request }) =>
    api.handle(request, request.headers.has('authorization') ? 'claude' : 'enrique'),
  )
  handle = (request) => guarded({ request })
})

const newProject = (name: string) => dbm.db.insert(dbm.schema.projects).values({ name }).returning().get().id

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
async function mcp(method: string, params: Record<string, unknown> = {}) {
  const { handleMcp } = await import('./mcp')
  const res = await handleMcp(
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    }),
    'claude',
  )
  return ((await res.json()) as { result: any }).result
}
const tool = async (name: string, args: Record<string, unknown>) => {
  const result = await mcp('tools/call', { name, arguments: args })
  expect(result.isError, result.content[0].text).toBeFalsy()
  return JSON.parse(result.content[0].text)
}
const toolList = async () =>
  (await mcp('tools/list')).tools as { name: string; description: string; inputSchema: any }[]

describe('the daily summary is gone', () => {
  it('has no summary routes, and the day carries no summaries', async () => {
    const p = newProject('no-summaries')
    expect((await call('POST', '/api/daily/summaries', { projectId: p, body: 'hi' })).status).toBe(404)
    expect((await call('POST', '/api/daily/summaries/generate', { projectId: p })).status).toBe(404)
    const day = await call('GET', `/api/daily?date=2026-10-04&projectId=${p}`)
    expect(day.status).toBe(200)
    expect(Object.keys(day.body).sort()).toEqual(['activity', 'date', 'projects'])
  })

  it('daily_report returns the activity without summaries', async () => {
    const p = newProject('daily-report')
    await call('PATCH', `/api/projects/${p}/report-settings`, { cadence: 'daily' })
    const day = await tool('daily_report', { projectId: p })
    expect(day.activity.map((a: { text: string }) => a.text)).toContain(
      'changed the report schedule (daily by 17:00, text)',
    )
    expect(day).not.toHaveProperty('summaries')
    const described = (await toolList()).find((t) => t.name === 'daily_report')!
    expect(described.description).not.toMatch(/summar/i)
  })

  it('post_daily_summary posts the current period’s report, like post_report', async () => {
    const p = newProject('alias')
    await call('PATCH', `/api/projects/${p}/report-settings`, { cadence: 'daily' })
    const posted = await tool('post_daily_summary', { projectId: p, body: 'Shipped the export.' })
    const current = reports.listReports(p).current!
    expect(posted).toMatchObject({
      projectId: p,
      period: current,
      body: 'Shipped the export.',
      author: 'claude',
    })
    expect(reports.reportVersions(p, current).map((r) => r.body)).toEqual(['Shipped the export.'])
    const described = (await toolList()).find((t) => t.name === 'post_daily_summary')!
    expect(described.description).toMatch(/post_report/)
  })
})

describe('report settings over REST', () => {
  it('answer every field, take any subset, and no longer know dueTime', async () => {
    const p = newProject('rest-settings')
    const fresh = await call('GET', `/api/projects/${p}/report-settings`)
    expect(fresh.body).toMatchObject({
      projectId: p,
      cadence: 'off',
      weekday: 5,
      shiftStart: '09:00',
      shiftEnd: '17:00',
      workdays: [1, 2, 3, 4, 5],
      alertMinutes: 30,
      format: 'text',
      templateIsDefault: true,
      pending: [],
    })
    expect(fresh.body).not.toHaveProperty('dueTime')

    const patched = await call('PATCH', `/api/projects/${p}/report-settings`, {
      cadence: 'weekly',
      weekday: 4,
      shiftStart: '08:30',
      shiftEnd: '16:45',
      workdays: [1, 2, 3, 4],
      alertMinutes: 0,
    })
    expect(patched.status).toBe(200)
    const read = await call('GET', `/api/projects/${p}/report-settings`)
    expect(read.body).toEqual(patched.body)
    expect(read.body).toMatchObject({
      cadence: 'weekly',
      weekday: 4,
      shiftStart: '08:30',
      shiftEnd: '16:45',
      workdays: [1, 2, 3, 4],
      alertMinutes: 0,
    })
  })

  it('refuse invalid shift settings with a 400 and change nothing', async () => {
    const p = newProject('rest-invalid')
    const before = (await call('GET', `/api/projects/${p}/report-settings`)).body
    for (const patch of [
      { shiftStart: '7:00' },
      { shiftEnd: '24:00' },
      { workdays: [] },
      { workdays: [0, 1] },
      { workdays: [1, 8] },
      { alertMinutes: -5 },
      { shiftStart: '17:00', shiftEnd: '09:00' },
      { dueTime: '18:00' },
    ]) {
      const res = await call('PATCH', `/api/projects/${p}/report-settings`, patch)
      expect(res.status, JSON.stringify(patch)).toBe(400)
    }
    expect((await call('GET', `/api/projects/${p}/report-settings`)).body).toEqual(before)
  })

  it('store a template verbatim', async () => {
    const p = newProject('rest-template')
    const template = '## Shipped\n\n- what went out\n\n## Next\n'
    await call('PATCH', `/api/projects/${p}/report-settings`, { template })
    expect((await call('GET', `/api/projects/${p}/report-settings`)).body).toMatchObject({
      template,
      templateIsDefault: false,
    })
  })
})

describe('report settings over MCP', () => {
  it('get_report_settings has the template and the shift', async () => {
    const p = newProject('mcp-settings')
    const s = await tool('get_report_settings', { projectId: p })
    expect(s).toMatchObject({
      shiftStart: '09:00',
      shiftEnd: '17:00',
      workdays: [1, 2, 3, 4, 5],
      alertMinutes: 30,
    })
    expect(s.template).toMatch(/## Done[\s\S]*## Next/)
  })

  it('set_report_settings takes every field and says prompt and template are the human’s call', async () => {
    const set = (await toolList()).find((t) => t.name === 'set_report_settings')!
    for (const field of [
      'prompt',
      'template',
      'cadence',
      'weekday',
      'shiftStart',
      'shiftEnd',
      'workdays',
      'alertMinutes',
      'format',
    ])
      expect(set.inputSchema.properties, field).toHaveProperty(field)
    expect(set.inputSchema.properties).not.toHaveProperty('dueTime')
    expect(set.description).toMatch(/only when the human asked for that change in this conversation/)

    const p = newProject('mcp-set')
    const s = await tool('set_report_settings', { projectId: p, template: '## A\n', shiftEnd: '18:30' })
    expect(s).toMatchObject({ template: '## A\n', shiftEnd: '18:30', updatedBy: 'claude' })
  })

  it('describe reportDue on get_summary and check_inbox, and off and generating on list_reports', async () => {
    const tools = await toolList()
    const about = (name: string) => tools.find((t) => t.name === name)!.description
    expect(about('get_summary')).toMatch(/reportDue/)
    expect(about('check_inbox')).toMatch(/reportDue/)
    expect(about('list_reports')).toMatch(/off:/)
    expect(about('list_reports')).toMatch(/generating/)
  })
})

describe('report routes the Daily page builds on', () => {
  it('answer, before their work is done, with nothing rather than something made up', async () => {
    const p = newProject('routes')
    await call('PATCH', `/api/projects/${p}/report-settings`, { cadence: 'daily' })
    expect((await call('POST', `/api/projects/${p}/reports/generate`, {})).status).toBe(501)
    expect((await call('GET', '/api/report-due')).body).toEqual({ items: [] })
    expect((await call('GET', '/api/reports/overview?date=2026-10-04')).body).toEqual({
      date: '2026-10-04',
      projects: [],
    })
    expect((await call('GET', '/api/reports/overview?date=soon')).status).toBe(400)
    expect((await call('GET', `/api/projects/${p}/pushed-today`)).body).toMatchObject({
      commits: 0,
      added: 0,
      removed: 0,
      repos: [],
    })
    expect((await call('GET', `/api/projects/${p}/report-settings/changes`)).body).toEqual([])
    expect((await call('GET', `/api/projects/${p}/report-settings/changes?field=nope`)).status).toBe(400)
    expect((await call('GET', '/api/report-settings/changes/1')).status).toBe(404)
    expect((await call('GET', `/api/projects/${p}/reports`)).body).toMatchObject({
      generating: null,
      generateError: null,
    })
  })

  it('let only the human accept or revert a change of the prompt or template', async () => {
    for (const action of ['accept', 'revert'])
      expect(
        (await call('POST', `/api/report-settings/changes/1/${action}`, undefined, 'agent')).status,
      ).toBe(403)
  })

  it('give agents the local path of a report file', async () => {
    const p = newProject('agent-files')
    await call('PATCH', `/api/projects/${p}/report-settings`, { cadence: 'daily', format: 'file' })
    const file = path.join(tmp, 'today.pdf')
    fs.writeFileSync(file, '%PDF-1.4 test')
    const posted = await reports.postReport(p, { files: [file] }, 'claude')
    const list = (await call('GET', `/api/projects/${p}/reports`, undefined, 'agent')).body
    // A report is a report: nothing says it was something else standing in for one.
    expect(list.periods[0].report).not.toHaveProperty('source')
    const fromList = list.periods[0].report.attachments[0]
    const fromVersions = (
      await call('GET', `/api/projects/${p}/reports/${posted.period}`, undefined, 'agent')
    ).body[0].attachments[0]
    for (const a of [fromList, fromVersions]) {
      expect(a.path).toBeTruthy()
      expect(fs.readFileSync(a.path, 'utf8')).toBe('%PDF-1.4 test')
    }
  })

  it('put reportDue next to the summary and the inbox', async () => {
    const p = newProject('report-due')
    expect((await call('GET', `/api/summary?projectId=${p}`)).body.projects[0]).toHaveProperty(
      'reportDue',
      null,
    )
    expect((await call('GET', `/api/projects/${p}/inbox`)).body).toMatchObject({ count: 0, reportDue: null })
  })
})
