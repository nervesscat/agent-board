import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

import { DEFAULT_REPORT_TEMPLATE } from '#/lib/reportTemplate'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp

let reports: typeof import('./reports')
let dbm: typeof import('#/db')
beforeAll(async () => {
  reports = await import('./reports')
  dbm = await import('#/db')
})

const at = (day: string, time = '12:00') => new Date(`${day}T${time}:00`)
const newProject = (name: string) => dbm.db.insert(dbm.schema.projects).values({ name }).returning().get().id
const activity = (projectId: number) =>
  dbm.db.select().from(dbm.schema.activity).where(eq(dbm.schema.activity.projectId, projectId)).all()

describe('report settings', () => {
  it('start off with the default template and shift, and anyone (an agent too) can change them', () => {
    const p = newProject('settings')
    const fresh = reports.getReportSettings(p)
    expect(fresh).toMatchObject({
      cadence: 'off',
      prompt: '',
      format: 'text',
      template: DEFAULT_REPORT_TEMPLATE,
      templateIsDefault: true,
      shiftStart: '09:00',
      shiftEnd: '17:00',
      workdays: [1, 2, 3, 4, 5],
      alertMinutes: 30,
      pending: [],
    })
    expect(fresh).not.toHaveProperty('dueTime')

    const s = reports.setReportSettings(
      p,
      { prompt: '## By the hour\nWhat was done each hour.', cadence: 'daily', shiftEnd: '18:00' },
      'claude',
      { agent: true },
      at('2026-10-04'),
    )
    expect(s).toMatchObject({ cadence: 'daily', shiftEnd: '18:00', since: '2026-10-04', updatedBy: 'claude' })
    expect(reports.getReportSettings(p).prompt).toBe('## By the hour\nWhat was done each hour.')
    expect(activity(p).map((a) => a.text)).toEqual([
      'changed the report prompt',
      'changed the report schedule (daily by 18:00, text)',
    ])

    // Only what changed is logged; nothing changed logs nothing.
    reports.setReportSettings(p, { prompt: 'Two lines.' }, 'me', {}, at('2026-10-05'))
    reports.setReportSettings(p, { prompt: 'Two lines.' }, 'me', {}, at('2026-10-05'))
    reports.setReportSettings(
      p,
      { workdays: [5, 1, 2, 3, 4, 6], alertMinutes: 45 },
      'me',
      {},
      at('2026-10-05'),
    )
    expect(activity(p).map((a) => a.text)).toEqual([
      'changed the report prompt',
      'changed the report schedule (daily by 18:00, text)',
      'changed the report prompt',
      'changed the report schedule (daily by 18:00, text)',
    ])
    // Tracking starts again only when the cadence changes; workdays are kept in order.
    expect(reports.getReportSettings(p)).toMatchObject({
      since: '2026-10-04',
      workdays: [1, 2, 3, 4, 5, 6],
      alertMinutes: 45,
    })
    reports.setReportSettings(p, { cadence: 'weekly', weekday: 1 }, 'me', {}, at('2026-10-08'))
    expect(reports.getReportSettings(p).since).toBe('2026-10-05')
  })

  it("keep a template of the project's own verbatim, and go back to the default on ''", () => {
    const p = newProject('template')
    const mine = '# Weekly\n\n## Shipped\n\n## Risks\n'
    reports.setReportSettings(p, { template: mine }, 'me')
    expect(reports.getReportSettings(p)).toMatchObject({ template: mine, templateIsDefault: false })
    reports.setReportSettings(p, { template: '' }, 'me')
    expect(reports.getReportSettings(p)).toMatchObject({
      template: DEFAULT_REPORT_TEMPLATE,
      templateIsDefault: true,
    })
  })

  it('reject a cadence, weekday, time, workday, alert, format or field the board does not know', () => {
    const p = newProject('validation')
    reports.setReportSettings(p, { cadence: 'daily' }, 'me')
    const before = reports.getReportSettings(p)
    const bad = [
      { cadence: 'monthly' },
      { weekday: 0 },
      { weekday: 8 },
      { shiftEnd: '25:00' },
      { shiftEnd: '6pm' },
      { shiftStart: '9:00' },
      { shiftStart: '' },
      { shiftStart: '18:00', shiftEnd: '09:00' },
      { shiftEnd: '09:00' },
      { workdays: [] },
      { workdays: [0] },
      { workdays: [8] },
      { workdays: [1, 1] },
      { workdays: [1.5] },
      { alertMinutes: -1 },
      { alertMinutes: 721 },
      { alertMinutes: 2.5 },
      { format: 'docx' },
      { template: 'x'.repeat(50_001) },
      { dueTime: '18:00' },
    ]
    for (const patch of bad)
      expect(() => reports.setReportSettings(p, patch as never, 'claude'), JSON.stringify(patch)).toThrow(
        expect.objectContaining({ status: 400 }),
      )
    expect(reports.getReportSettings(p)).toEqual(before)
  })
})

describe('reports', () => {
  it('cannot be posted while the cadence is off, nor for a period that has not started', async () => {
    const p = newProject('off')
    await expect(reports.postReport(p, { body: 'hi' }, 'claude')).rejects.toMatchObject({ status: 400 })
    reports.setReportSettings(p, { cadence: 'daily' }, 'me', {}, at('2026-10-04'))
    await expect(
      reports.postReport(p, { body: 'hi', period: '2026-10-05' }, 'claude', at('2026-10-04')),
    ).rejects.toMatchObject({ status: 400 })
    await expect(reports.postReport(p, {}, 'claude', at('2026-10-04'))).rejects.toMatchObject({ status: 400 })
  })

  it('track each day as done, missing or upcoming; a new post replaces the report and keeps history', async () => {
    const p = newProject('daily')
    // Every day a workday: Oct 3 and 4 are a weekend.
    reports.setReportSettings(
      p,
      { cadence: 'daily', shiftEnd: '18:00', workdays: [1, 2, 3, 4, 5, 6, 7] },
      'me',
      {},
      at('2026-10-01'),
    )
    const r = await reports.postReport(
      p,
      { body: 'Shipped the export.', period: '2026-10-02' },
      'claude',
      at('2026-10-04'),
    )
    expect(r).toMatchObject({ period: '2026-10-02', cadence: 'daily', author: 'claude', attachments: [] })

    const list = reports.listReports(p, {}, at('2026-10-04', '17:00'))
    expect(list.current).toBe('2026-10-04')
    // Days before tracking began (Oct 1) are left out.
    expect(list.periods.map((x) => [x.period, x.status])).toEqual([
      ['2026-10-04', 'upcoming'],
      ['2026-10-03', 'missing'],
      ['2026-10-02', 'done'],
      ['2026-10-01', 'missing'],
    ])
    expect(list.periods[0]!.due).toBe(at('2026-10-04', '18:00').toISOString())
    expect(reports.listReports(p, {}, at('2026-10-04', '18:00')).periods[0]!.status).toBe('missing')

    await reports.postReport(
      p,
      { body: 'Shipped the export and the import.', period: '2026-10-02' },
      'me',
      at('2026-10-04'),
    )
    const day = reports.listReports(p, {}, at('2026-10-04')).periods.find((x) => x.period === '2026-10-02')!
    expect(day.report?.body).toBe('Shipped the export and the import.')
    expect(day.versions).toBe(2)
    expect(reports.reportVersions(p, '2026-10-02').map((v) => v.author)).toEqual(['me', 'claude'])
    expect(activity(p).some((a) => a.text === 'posted the daily report for Fri, Oct 2')).toBe(true)
  })

  it('mark days off outside the workdays, never missing, and done when they have a report anyway', async () => {
    const p = newProject('workdays')
    reports.setReportSettings(p, { cadence: 'daily', shiftEnd: '17:00' }, 'me', {}, at('2026-10-01'))
    // Saturday Oct 10 has a report; Sunday Oct 11 none.
    await reports.postReport(p, { body: 'Weekend fix.', period: '2026-10-10' }, 'me', at('2026-10-12'))
    const list = reports.listReports(p, { from: '2026-10-08', to: '2026-10-12' }, at('2026-10-12', '17:30'))
    expect(list.periods.map((x) => [x.period, x.status])).toEqual([
      ['2026-10-12', 'missing'],
      ['2026-10-11', 'off'],
      ['2026-10-10', 'done'],
      ['2026-10-09', 'missing'],
      ['2026-10-08', 'missing'],
    ])
    // Before Friday's end it was not missing yet.
    const friday = reports.listReports(p, { from: '2026-10-09', to: '2026-10-09' }, at('2026-10-09', '16:59'))
    expect(friday.periods.map((x) => x.status)).toEqual(['upcoming'])
  })

  it('list a whole month, days after today included: upcoming on workdays, off on the others', () => {
    const p = newProject('month')
    reports.setReportSettings(p, { cadence: 'daily' }, 'me', {}, at('2026-09-01'))
    const list = reports.listReports(p, { from: '2026-10-01', to: '2026-10-31' }, at('2026-10-14', '12:00'))
    expect(list.periods).toHaveLength(31)
    expect(list.periods[0]!.period).toBe('2026-10-31')
    expect(list.periods.at(-1)!.period).toBe('2026-10-01')
    const status = new Map(list.periods.map((x) => [x.period, x.status]))
    expect(status.get('2026-10-13')).toBe('missing') // Tuesday, past
    expect(status.get('2026-10-14')).toBe('upcoming') // today, before 17:00
    expect(status.get('2026-10-15')).toBe('upcoming') // Thursday, ahead
    expect(status.get('2026-10-17')).toBe('off') // Saturday, ahead
    expect(status.get('2026-10-11')).toBe('off') // Sunday, past
    // The default range still ends today.
    expect(reports.listReports(p, {}, at('2026-10-14', '12:00')).periods[0]!.period).toBe('2026-10-14')

    // A weekly cadence gives the weeks touching the month, each due on its weekday.
    reports.setReportSettings(p, { cadence: 'weekly', weekday: 5 }, 'me', {}, at('2026-09-01'))
    const weeks = reports.listReports(p, { from: '2026-10-01', to: '2026-10-31' }, at('2026-10-14', '12:00'))
    expect(weeks.periods.map((x) => [x.period, x.status])).toEqual([
      ['2026-10-26', 'upcoming'],
      ['2026-10-19', 'upcoming'],
      ['2026-10-12', 'upcoming'],
      ['2026-10-05', 'missing'],
      ['2026-09-28', 'missing'],
    ])
  })

  it('take a file as a path, attach it to the report and hand back its local path', async () => {
    const p = newProject('pdf')
    reports.setReportSettings(
      p,
      { cadence: 'weekly', weekday: 5, format: 'file' },
      'me',
      {},
      at('2026-09-29'),
    )
    // A file report needs the file.
    await expect(
      reports.postReport(p, { body: 'see attached' }, 'claude', at('2026-10-02')),
    ).rejects.toMatchObject({ status: 400 })

    const file = path.join(tmp, 'week-40.pdf')
    fs.writeFileSync(file, '%PDF-1.4 test')
    // Any day of the week files it under the week's Monday.
    const r = await reports.postReport(p, { files: [file], period: '2026-10-01' }, 'claude', at('2026-10-02'))
    expect(r.period).toBe('2026-09-28')
    expect(r.attachments).toHaveLength(1)
    expect(r.attachments[0]).toMatchObject({ name: 'week-40.pdf', mime: 'application/pdf', reportId: r.id })
    expect(fs.readFileSync(r.attachments[0]!.path, 'utf8')).toBe('%PDF-1.4 test')

    const list = reports.listReports(p, {}, at('2026-10-02'))
    expect(list.periods.map((x) => [x.period, x.status])).toEqual([['2026-09-28', 'done']])
    expect(list.periods[0]!.report?.attachments[0]?.id).toBe(r.attachments[0]!.id)

    // An upload already attached to something cannot be attached again.
    await expect(
      reports.postReport(p, { attachmentIds: [r.attachments[0]!.id] }, 'me', at('2026-10-02')),
    ).rejects.toMatchObject({ status: 409 })
    expect(reports.reportVersions(p, '2026-09-28')).toHaveLength(1)
  })

  it('list no generation running or failed while nobody asked claude', () => {
    const p = newProject('generation')
    expect(reports.listReports(p, {}, at('2026-10-04'))).toMatchObject({
      current: null,
      periods: [],
      generating: null,
      generateError: null,
    })
    reports.setReportSettings(p, { cadence: 'daily' }, 'me', {}, at('2026-10-04'))
    const list = reports.listReports(p, {}, at('2026-10-04'))
    expect(list).toMatchObject({ current: '2026-10-04', generating: null, generateError: null })
    expect(list).not.toHaveProperty('prompt')
    expect(list).not.toHaveProperty('template')
  })
})
