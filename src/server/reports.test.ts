import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

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
  it('start off, and anyone (an agent too) can change them, each change logged', () => {
    const p = newProject('settings')
    expect(reports.getReportSettings(p)).toMatchObject({ cadence: 'off', prompt: '', format: 'text' })

    const s = reports.setReportSettings(
      p,
      { prompt: '## By the hour\nWhat was done each hour.', cadence: 'daily', dueTime: '18:00' },
      'claude',
      at('2026-10-04'),
    )
    expect(s).toMatchObject({ cadence: 'daily', dueTime: '18:00', since: '2026-10-04', updatedBy: 'claude' })
    expect(reports.getReportSettings(p).prompt).toBe('## By the hour\nWhat was done each hour.')
    expect(activity(p).map((a) => a.text)).toEqual([
      'changed the report prompt and schedule (daily by 18:00, text)',
    ])

    // Only what changed is logged; nothing changed logs nothing. "" clears the due time.
    reports.setReportSettings(p, { prompt: 'Two lines.' }, 'me', at('2026-10-05'))
    reports.setReportSettings(p, { prompt: 'Two lines.' }, 'me', at('2026-10-05'))
    reports.setReportSettings(p, { dueTime: '' }, 'me', at('2026-10-05'))
    expect(activity(p).map((a) => a.text)).toEqual([
      'changed the report prompt and schedule (daily by 18:00, text)',
      'changed the report prompt',
      'changed the report schedule (daily, text)',
    ])
    // Tracking starts again only when the cadence changes.
    expect(reports.getReportSettings(p)).toMatchObject({ dueTime: null, since: '2026-10-04' })
    reports.setReportSettings(p, { cadence: 'weekly', weekday: 1 }, 'me', at('2026-10-08'))
    expect(reports.getReportSettings(p).since).toBe('2026-10-05')
  })

  it('reject a cadence, weekday, due time or format the board does not know', () => {
    const p = newProject('validation')
    const bad = [
      { cadence: 'monthly' },
      { weekday: 0 },
      { weekday: 8 },
      { dueTime: '25:00' },
      { dueTime: '6pm' },
      { format: 'docx' },
    ]
    for (const patch of bad)
      expect(() => reports.setReportSettings(p, patch as never, 'claude')).toThrow(
        expect.objectContaining({ status: 400 }),
      )
    expect(reports.getReportSettings(p).cadence).toBe('off')
  })
})

describe('reports', () => {
  it('cannot be posted while the cadence is off, nor for a period that has not started', async () => {
    const p = newProject('off')
    await expect(reports.postReport(p, { body: 'hi' }, 'claude')).rejects.toMatchObject({ status: 400 })
    reports.setReportSettings(p, { cadence: 'daily' }, 'me', at('2026-10-04'))
    await expect(
      reports.postReport(p, { body: 'hi', period: '2026-10-05' }, 'claude', at('2026-10-04')),
    ).rejects.toMatchObject({ status: 400 })
    await expect(reports.postReport(p, {}, 'claude', at('2026-10-04'))).rejects.toMatchObject({ status: 400 })
  })

  it('track each day as done, missing or upcoming; a new post replaces the report and keeps history', async () => {
    const p = newProject('daily')
    reports.setReportSettings(p, { cadence: 'daily', dueTime: '18:00' }, 'me', at('2026-10-01'))
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

  it('take a file as a path, attach it to the report and hand back its local path', async () => {
    const p = newProject('pdf')
    reports.setReportSettings(p, { cadence: 'weekly', weekday: 5, format: 'file' }, 'me', at('2026-09-29'))
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

  it('count a daily summary as the day’s report for a daily text project only', async () => {
    const { addSummary } = await import('./activity')
    const p = newProject('summaries')
    reports.setReportSettings(p, { cadence: 'daily' }, 'me', at('2026-10-03'))
    addSummary({ projectId: p, date: '2026-10-03', author: 'claude', body: '- export shipped' })

    let day = reports.listReports(p, {}, at('2026-10-04')).periods.find((x) => x.period === '2026-10-03')!
    expect(day.status).toBe('done')
    expect(day.report).toMatchObject({ source: 'summary', body: '- export shipped', author: 'claude' })

    // A posted report wins over the summary.
    await reports.postReport(p, { body: 'The report.', period: '2026-10-03' }, 'me', at('2026-10-04'))
    day = reports.listReports(p, {}, at('2026-10-04')).periods.find((x) => x.period === '2026-10-03')!
    expect(day.report).toMatchObject({ source: 'report', body: 'The report.' })

    // A file project's summaries are not reports.
    const q = newProject('summaries-file')
    reports.setReportSettings(q, { cadence: 'daily', format: 'file' }, 'me', at('2026-10-03'))
    addSummary({ projectId: q, date: '2026-10-03', author: 'claude', body: '- done' })
    day = reports.listReports(q, {}, at('2026-10-04')).periods.find((x) => x.period === '2026-10-03')!
    expect(day.status).toBe('missing')
  })
})
