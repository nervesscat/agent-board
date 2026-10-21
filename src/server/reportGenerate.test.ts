import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeAll, describe, expect, it } from 'vitest'

import { DEFAULT_REPORT_TEMPLATE, templateHeadings } from '#/lib/reportTemplate'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
// claude is the tests' stand-in (e2e/fake-claude.mjs), run through node with the prompt on its stdin;
// a marker in the project's prompt picks how it answers and where it logs what it got.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-generate-'))
process.env.DATA_DIR = tmp
process.env.CLAUDE_BIN = process.execPath
process.env.CLAUDE_ARGS = JSON.stringify([
  fileURLToPath(new URL('../../e2e/fake-claude.mjs', import.meta.url)),
])

let dbm: typeof import('#/db')
let reports: typeof import('./reports')
let gen: typeof import('./reportGenerate')
let config: typeof import('./config').config
let handle: (request: Request) => Promise<Response>
beforeAll(async () => {
  dbm = await import('#/db')
  reports = await import('./reports')
  gen = await import('./reportGenerate')
  config = (await import('./config')).config
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  const guarded = guard(({ request }: { request: Request }) => api.handle(request, 'enrique'))
  handle = (request) => guarded({ request })
})

const at = (day: string, time = '12:00') => new Date(`${day}T${time}:00`)
let projects = 0
const newProject = () =>
  dbm.db
    .insert(dbm.schema.projects)
    .values({ name: `generate ${++projects}` })
    .returning()
    .get().id
/** A line of activity at a local moment. */
const happened = (projectId: number, moment: Date, text: string) =>
  dbm.db
    .insert(dbm.schema.activity)
    .values({ projectId, actor: 'enrique', kind: 'ticket', text, createdAt: moment.toISOString() })
    .run()

let logs = 0
/** A project tracked daily (or weekly) whose prompt tells the stand-in how to answer and where to log. */
function tracked(opts: { mode?: string; cadence?: 'daily' | 'weekly'; now: Date; prompt?: string }) {
  const p = newProject()
  const log = path.join(tmp, `claude-${++logs}.jsonl`)
  const prompt = [
    opts.prompt ?? 'Short bullets, for the owner.',
    `[fake-claude-log: ${log}]`,
    opts.mode ? `[fake-claude: ${opts.mode}]` : '',
  ].join('\n')
  reports.setReportSettings(p, { cadence: opts.cadence ?? 'daily', prompt }, 'enrique', {}, opts.now)
  const runs = () =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { argv: string[]; stdin: string; pid: number })
      : []
  return { p, prompt, runs }
}

async function rest(method: string, pathname: string, body?: unknown) {
  const res = await handle(
    new Request(`http://localhost${pathname}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
  return { status: res.status, body: (await res.json()) as any }
}

const errorOf = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected it to fail')
    },
    (e: { status?: number; message: string }) => ({ status: e.status, message: e.message }),
  )

describe('generating a report', () => {
  it('writes the current day from the prompt, the template and the day’s activity, as a version by claude', async () => {
    const now = at('2026-10-06', '16:00')
    const { p, prompt, runs } = tracked({ now })
    const other = newProject()
    happened(p, at('2026-10-06', '09:15'), 'moved Export to done')
    happened(p, at('2026-10-05', '15:00'), 'yesterday’s work')
    happened(other, at('2026-10-06', '10:00'), 'another project’s work')

    const first = await gen.generateReport(p, {}, now)
    expect(first).toMatchObject({ projectId: p, cadence: 'daily', period: '2026-10-06', author: 'claude' })
    expect(templateHeadings(first.body).map((h) => h.text)).toEqual(
      templateHeadings(DEFAULT_REPORT_TEMPLATE).map((h) => h.text),
    )

    // What claude got: the prompt, the template, the day's activity and nothing else's; on stdin only.
    const [run] = runs()
    expect(run!.argv).toEqual(['-p', '--output-format', 'text'])
    expect(run!.stdin).toContain(prompt)
    for (const h of templateHeadings(DEFAULT_REPORT_TEMPLATE)) expect(run!.stdin).toContain(`## ${h.text}`)
    expect(run!.stdin).toContain('2026-10-06 09:15 enrique: moved Export to done')
    expect(run!.stdin).not.toContain('yesterday’s work')
    expect(run!.stdin).not.toContain('another project’s work')

    // Again: a newer version, the first one kept.
    happened(p, at('2026-10-06', '16:30'), 'one more thing')
    const second = await gen.generateReport(p, {}, at('2026-10-06', '17:00'))
    expect(reports.reportVersions(p, '2026-10-06').map((r) => r.id)).toEqual([second.id, first.id])
    expect(reports.reportVersions(p, '2026-10-06').map((r) => r.body)).toEqual([second.body, first.body])
    expect(reports.listReports(p, {}, at('2026-10-06', '17:00')).periods[0]).toMatchObject({
      period: '2026-10-06',
      status: 'done',
      versions: 2,
      report: { id: second.id, author: 'claude' },
    })
  })

  it('writes a week from every day of it so far, kept under its Monday', async () => {
    const now = at('2026-10-07', '15:00') // a Wednesday
    const { p, runs } = tracked({ now, cadence: 'weekly' })
    happened(p, at('2026-10-04', '18:00'), 'last Sunday')
    happened(p, at('2026-10-05', '09:00'), 'on Monday')
    happened(p, at('2026-10-07', '11:00'), 'on Wednesday')

    const report = await gen.generateReport(p, {}, now)
    expect(report).toMatchObject({ cadence: 'weekly', period: '2026-10-05' })
    const [run] = runs()
    expect(run!.stdin).toContain('2026-10-05 09:00 enrique: on Monday')
    expect(run!.stdin).toContain('2026-10-07 11:00 enrique: on Wednesday')
    expect(run!.stdin).not.toContain('last Sunday')
  })

  it('sends a period far past the command line’s limit through stdin', async () => {
    const now = at('2026-10-06', '20:00')
    const { p, runs } = tracked({ now })
    const words = 'reviewed the parser, the exporter and every one of their tests '.repeat(2)
    for (let i = 0; i < 400; i++) happened(p, at('2026-10-06', '10:00'), `${i} ${words}`)

    const report = await gen.generateReport(p, {}, now)
    expect(report.author).toBe('claude')
    const [run] = runs()
    expect(run!.stdin.length).toBeGreaterThan(40_000)
    expect(run!.argv.join(' ')).not.toContain('reviewed the parser')
    expect(run!.stdin).toContain(`399 ${words}`)
  })

  it('takes a past period, and any day of it', async () => {
    const now = at('2026-10-08', '10:00')
    const { p } = tracked({ now: at('2026-10-01'), cadence: 'weekly' })
    happened(p, at('2026-10-01', '10:00'), 'last week')
    expect(await gen.generateReport(p, { period: '2026-10-02' }, now)).toMatchObject({ period: '2026-09-28' })
  })

  it('refuses while reports are off or are files, with nothing to report, and for a period not begun', async () => {
    const now = at('2026-10-06', '16:00')
    const off = newProject()
    happened(off, at('2026-10-06', '10:00'), 'work')
    expect(await errorOf(gen.generateReport(off, {}, now))).toMatchObject({
      status: 400,
      message: expect.stringMatching(/set a cadence first/),
    })

    const { p: files } = tracked({ now })
    reports.setReportSettings(files, { format: 'file' }, 'enrique', {}, now)
    happened(files, at('2026-10-06', '10:00'), 'work')
    expect(await errorOf(gen.generateReport(files, {}, now))).toMatchObject({
      status: 400,
      message: expect.stringMatching(/reports are files/),
    })

    const { p: quiet, runs } = tracked({ now })
    // Setting the prompt and the cadence logged two lines, on the day the test runs, not on Oct 6.
    expect(await errorOf(gen.generateReport(quiet, {}, now))).toMatchObject({
      status: 400,
      message: 'nothing happened in Tue, Oct 6',
    })
    happened(quiet, at('2026-10-06', '10:00'), 'work')
    expect(await errorOf(gen.generateReport(quiet, { period: '2026-10-07' }, now))).toMatchObject({
      status: 400,
    })
    expect(await errorOf(gen.generateReport(quiet, { period: 'soon' }, now))).toMatchObject({ status: 400 })
    expect(runs()).toEqual([])
    expect(gen.generationState(quiet)).toEqual({ period: null, error: null })
  })
})

describe('one generation at a time', () => {
  it('answers 409 while one runs for the project, and says which period is being written', async () => {
    const now = at('2026-10-06', '16:00')
    const { p } = tracked({ now, mode: 'slow 1500' })
    happened(p, at('2026-10-06', '10:00'), 'work')

    const running = gen.generateReport(p, {}, now)
    expect(gen.generationState(p).period).toBe('2026-10-06')
    expect(reports.listReports(p, {}, now).generating).toBe('2026-10-06')
    expect(await errorOf(gen.generateReport(p, {}, now))).toMatchObject({ status: 409 })

    await running
    expect(gen.generationState(p)).toEqual({ period: null, error: null })
    expect(reports.listReports(p, {}, now)).toMatchObject({ generating: null, generateError: null })
    expect(reports.reportVersions(p, '2026-10-06')).toHaveLength(1)
  })

  it('stops a run that outlives the timeout and stores nothing', async () => {
    const now = at('2026-10-06', '16:00')
    const { p, runs } = tracked({ now, mode: 'slow 20000' })
    happened(p, at('2026-10-06', '10:00'), 'work')
    const timeout = config.claudeTimeoutMs
    config.claudeTimeoutMs = 1000
    try {
      expect(await errorOf(gen.generateReport(p, {}, now))).toMatchObject({
        status: 502,
        message: 'claude did not answer within 1 s and was stopped',
      })
    } finally {
      config.claudeTimeoutMs = timeout
    }
    expect(reports.reportVersions(p, '2026-10-06')).toEqual([])
    expect(reports.listReports(p, {}, now)).toMatchObject({
      generating: null,
      generateError: { period: '2026-10-06', message: expect.stringMatching(/did not answer/) },
    })
    // The stand-in is gone, not left running.
    const { pid } = runs()[0]!
    await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false)
  })

  it('fails the same way when claude exits non-zero, with what it said', async () => {
    const now = at('2026-10-06', '16:00')
    const { p } = tracked({ now, mode: 'fail' })
    happened(p, at('2026-10-06', '10:00'), 'work')
    expect(await errorOf(gen.generateReport(p, {}, now))).toMatchObject({
      status: 502,
      message: 'claude exited with 3: fake-claude: asked to fail',
    })
    expect(reports.reportVersions(p, '2026-10-06')).toEqual([])
    expect(gen.generationState(p).period).toBeNull()
  })

  it('fails when claude is not found, saying so and how to set CLAUDE_BIN', async () => {
    const now = at('2026-10-06', '16:00')
    const { p } = tracked({ now })
    happened(p, at('2026-10-06', '10:00'), 'work')
    const bin = config.claudeBin
    const missing = path.join(tmp, 'no-such-claude')
    config.claudeBin = missing
    try {
      const err = await errorOf(gen.generateReport(p, {}, now))
      expect(err).toMatchObject({ status: 502 })
      expect(err.message).toBe(
        `claude was not found: CLAUDE_BIN is ${missing}: install Claude Code ` +
          '(https://docs.claude.com/en/docs/claude-code/setup), or set CLAUDE_BIN in .env (config.env for ' +
          'the desktop app) to its full path, then restart the board',
      )
      expect(err.message).not.toMatch(/ENOENT|spawn/)
      // The Daily page shows the same where the Generate button shows its error.
      expect(gen.generationState(p).error?.message).toBe(err.message)
    } finally {
      config.claudeBin = bin
    }
    expect(gen.generationState(p).period).toBeNull()
  })
})

describe('the template check', () => {
  it('asks once more when the first answer misses the template, and keeps only the second', async () => {
    const now = at('2026-10-06', '16:00')
    const { p, runs } = tracked({ now, mode: 'bad-then-good' })
    happened(p, at('2026-10-06', '10:00'), 'work')

    const report = await gen.generateReport(p, {}, now)
    expect(runs()).toHaveLength(2)
    expect(runs()[1]!.stdin).toContain('did not fill the template (missing: Next)')
    expect(reports.reportVersions(p, '2026-10-06').map((r) => r.body)).toEqual([report.body])
    expect(report.body).toMatch(/## Next/)
  })

  it('stores nothing after two misses and keeps why for the Daily page until one succeeds', async () => {
    const now = at('2026-10-06', '16:00')
    const { p, runs } = tracked({ now, mode: 'bad' })
    happened(p, at('2026-10-06', '10:00'), 'work')

    expect(await errorOf(gen.generateReport(p, {}, now))).toMatchObject({
      status: 502,
      message: expect.stringMatching(/did not fill the template twice \(missing: Next\)/),
    })
    expect(runs()).toHaveLength(2)
    expect(reports.reportVersions(p, '2026-10-06')).toEqual([])
    expect(reports.listReports(p, {}, now).generateError).toMatchObject({
      period: '2026-10-06',
      message: expect.stringMatching(/missing: Next/),
    })

    reports.setReportSettings(p, { prompt: 'Short bullets.' }, 'enrique', {}, now)
    await gen.generateReport(p, {}, now)
    expect(reports.listReports(p, {}, now).generateError).toBeNull()
  })
})

describe('POST /api/projects/:id/reports/generate', () => {
  it('answers 201 with the stored report, 409 while one runs, 502 when the check fails twice', async () => {
    const { p } = tracked({ now: new Date(), mode: 'slow 1000' })
    happened(p, new Date(), 'work')
    const url = `/api/projects/${p}/reports/generate`

    const first = rest('POST', url)
    await expect.poll(() => gen.generationState(p).period).not.toBeNull()
    expect((await rest('POST', url, {})).status).toBe(409)
    expect((await rest('GET', `/api/projects/${p}/reports`)).body.generating).toBe(
      reports.listReports(p).current,
    )
    const done = await first
    expect(done.status).toBe(201)
    expect(done.body).toMatchObject({ author: 'claude', period: reports.listReports(p).current })

    reports.setReportSettings(p, { prompt: '[fake-claude: bad]' }, 'enrique')
    const failed = await rest('POST', url, {})
    expect(failed.status).toBe(502)
    expect(failed.body.error).toMatch(/missing: Next/)
    expect((await rest('GET', `/api/projects/${p}/reports`)).body).toMatchObject({
      generating: null,
      generateError: { message: failed.body.error },
    })
    expect((await rest('POST', url, { period: 'soon' })).status).toBe(400)
  })
})

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
