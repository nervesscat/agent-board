import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm'
import { z } from 'zod'

import { db, schema } from '#/db'
import { REPORT_CADENCES, REPORT_FORMATS } from '#/lib/constants'
import { localDate, shiftDate } from '#/lib/format'
import {
  DAY,
  DUE_TIME,
  describeSchedule,
  dueAt,
  periodLabel,
  periodOf,
  periodsBetween,
  reportStatus,
  type TrackedCadence,
} from '#/lib/reports'
import { logActivity } from './activity'
import { HttpError } from './http'
import { getProject } from './projects'
import { attachTo, attachmentView, saveFromPath } from './uploads'

/**
 * A project's reports: the prompt saying what each must contain, when one is due (daily, or weekly on
 * a weekday, by a time), and the reports posted for each period. A period is done once it has a
 * report, missing once it is due without one, upcoming until then. For a daily project whose reports
 * are text, the daily summary of a day counts as that day's report when nobody posted one.
 */

/** What the settings take, for the REST body and the MCP tool alike. */
export const reportSettingsShape = {
  prompt: z
    .string()
    .max(50_000)
    .optional()
    .describe(
      'markdown: what the report must contain and how (by the hour, sections, audience, tone, a short text or a PDF)',
    ),
  cadence: z
    .enum(REPORT_CADENCES)
    .optional()
    .describe('off (not tracked), daily, or weekly (once a week, due on weekday)'),
  weekday: z
    .number()
    .int()
    .min(1)
    .max(7)
    .optional()
    .describe('the day a weekly report is due, 1 (Monday) to 7 (Sunday)'),
  dueTime: z
    .string()
    .regex(DUE_TIME, 'HH:MM, 24-hour')
    .or(z.literal(''))
    .nullable()
    .optional()
    .describe('local HH:MM the report is due by on its day; null or "" for by the end of that day'),
  format: z
    .enum(REPORT_FORMATS)
    .optional()
    .describe('text (written on the board) or file (an attached file, e.g. a PDF, is required)'),
}
export const ReportSettingsPatch = z.object(reportSettingsShape)
export type ReportSettingsPatch = z.infer<typeof ReportSettingsPatch>

const defaults = (projectId: number): schema.ReportSettings => ({
  projectId,
  prompt: '',
  cadence: 'off',
  weekday: 5,
  dueTime: null,
  format: 'text',
  since: '',
  updatedBy: '',
  updatedAt: '',
})

export function getReportSettings(projectId: number): schema.ReportSettings {
  getProject(projectId)
  return (
    db.select().from(schema.reportSettings).where(eq(schema.reportSettings.projectId, projectId)).get() ??
    defaults(projectId)
  )
}

/** Anyone may change them, agents included; every change is a line in the activity feed. */
export function setReportSettings(
  projectId: number,
  patch: ReportSettingsPatch,
  actor: string,
  now = new Date(),
) {
  const parsed = ReportSettingsPatch.safeParse(patch)
  if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error))
  const before = getReportSettings(projectId)
  const { dueTime, ...rest } = parsed.data
  const next = {
    ...before,
    ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
    ...(dueTime !== undefined ? { dueTime: dueTime || null } : {}),
  } as schema.ReportSettings
  // Periods before tracking began are not missing: they were never asked for.
  if (next.cadence !== before.cadence) next.since = next.cadence === 'off' ? '' : periodOf(next.cadence, now)

  const changed: string[] = []
  if (next.prompt !== before.prompt) changed.push('prompt')
  if (
    next.cadence !== before.cadence ||
    next.weekday !== before.weekday ||
    next.dueTime !== before.dueTime ||
    next.format !== before.format
  )
    changed.push(`schedule (${describeSchedule(next)})`)
  if (!changed.length && before.updatedAt) return before

  const values = { ...next, updatedBy: actor, updatedAt: now.toISOString() }
  const row = db
    .insert(schema.reportSettings)
    .values(values)
    .onConflictDoUpdate({ target: schema.reportSettings.projectId, set: values })
    .returning()
    .get()
  if (changed.length)
    logActivity({
      projectId,
      actor,
      kind: 'report',
      text: `changed the report ${changed.join(' and ')}`,
      refType: 'project',
      refId: projectId,
    })
  return row
}

const tracked = (s: schema.ReportSettings): TrackedCadence => {
  if (s.cadence === 'off')
    throw new HttpError(400, 'reports are off for this project: set a cadence first (report settings)')
  return s.cadence
}

const checkDay = (day: string, what: string) => {
  if (!DAY.test(day) || Number.isNaN(new Date(`${day}T00:00:00`).getTime()))
    throw new HttpError(400, `${what} must be a date, YYYY-MM-DD`)
  return day
}

function withFiles(rows: schema.Report[]) {
  const ids = rows.map((r) => r.id)
  const files = ids.length
    ? db.select().from(schema.attachments).where(inArray(schema.attachments.reportId, ids)).all()
    : []
  return rows.map((r) => ({
    ...r,
    source: 'report' as 'report' | 'summary',
    attachments: files.filter((f) => f.reportId === r.id).map((f) => attachmentView(f)),
  }))
}

export type ReportView = ReturnType<typeof withFiles>[number]

/**
 * A report for a period (a day, or any day of a week: the week's Monday is kept), by default the
 * current one. A text report needs a body or a file, a file report a file. Posting again for a period
 * adds a newer version; the latest is the period's report and the earlier ones stay as its history.
 */
export async function postReport(
  projectId: number,
  input: { period?: string; body?: string; attachmentIds?: number[]; files?: string[] },
  actor: string,
  now = new Date(),
) {
  const settings = getReportSettings(projectId)
  const cadence = tracked(settings)
  const current = periodOf(cadence, now)
  const period = input.period ? periodOf(cadence, checkDay(input.period, 'period')) : current
  if (period > current) throw new HttpError(400, `the period ${period} has not started yet`)
  const body = (input.body ?? '').trim()
  const fileCount = (input.attachmentIds?.length ?? 0) + (input.files?.length ?? 0)
  if (settings.format === 'file' && !fileCount)
    throw new HttpError(400, "this project's reports are files: attach the report (files)")
  if (!body && !fileCount) throw new HttpError(400, 'a report needs a body or a file')

  const saved = await Promise.all((input.files ?? []).map((f) => saveFromPath(f, actor)))
  const ids = [...(input.attachmentIds ?? []), ...saved.map((a) => a.id)]
  const row = db.transaction(() => {
    const r = db
      .insert(schema.reports)
      .values({ projectId, cadence, period, body, author: actor })
      .returning()
      .get()
    attachTo(ids, { reportId: r.id })
    return r
  })
  logActivity({
    projectId,
    actor,
    kind: 'report',
    text: `posted the ${cadence} report for ${periodLabel(cadence, period)}`,
    refType: 'report',
    refId: row.id,
  })
  return withFiles([row])[0]!
}

/** Every version posted for one period, newest first (the first is the report). */
export function reportVersions(projectId: number, period: string) {
  const cadence = tracked(getReportSettings(projectId))
  const key = periodOf(cadence, checkDay(period, 'period'))
  return withFiles(
    db
      .select()
      .from(schema.reports)
      .where(
        and(
          eq(schema.reports.projectId, projectId),
          eq(schema.reports.cadence, cadence),
          eq(schema.reports.period, key),
        ),
      )
      .orderBy(desc(schema.reports.createdAt), desc(schema.reports.id))
      .all(),
  )
}

/**
 * The project's periods from `from` to `to` (days; by default the last two weeks of a daily cadence or
 * eight weeks of a weekly one, up to today), newest first, each with when it is due, its status and
 * its latest report. Periods before tracking began are left out unless they have a report.
 */
export function listReports(projectId: number, range: { from?: string; to?: string } = {}, now = new Date()) {
  const settings = getReportSettings(projectId)
  const { prompt: _prompt, ...schedule } = settings
  if (settings.cadence === 'off') return { ...schedule, current: null, periods: [] }
  const cadence = settings.cadence
  const today = localDate(now)
  const to = range.to ? checkDay(range.to, 'to') : today
  const end = to > today ? today : to
  const from = range.from ? checkDay(range.from, 'from') : shiftDate(end, cadence === 'daily' ? -13 : -7 * 7)
  const periods = periodsBetween(cadence, from, end)
  const first = periods.at(-1) ?? end
  const last = periods[0] ?? end

  const rows = db
    .select()
    .from(schema.reports)
    .where(
      and(
        eq(schema.reports.projectId, projectId),
        eq(schema.reports.cadence, cadence),
        gte(schema.reports.period, first),
        lte(schema.reports.period, last),
      ),
    )
    .orderBy(desc(schema.reports.createdAt), desc(schema.reports.id))
    .all()
  const latest = new Map<string, schema.Report>()
  const versions = new Map<string, number>()
  for (const r of rows) {
    if (!latest.has(r.period)) latest.set(r.period, r)
    versions.set(r.period, (versions.get(r.period) ?? 0) + 1)
  }
  const views = new Map(withFiles([...latest.values()]).map((v) => [v.period, v]))

  // A daily text report and the day's summary are the same thing: a summary stands in for a missing report.
  const summaries = new Map<string, ReportView>()
  if (cadence === 'daily' && settings.format === 'text') {
    const found = db
      .select()
      .from(schema.dailySummaries)
      .where(
        and(
          eq(schema.dailySummaries.projectId, projectId),
          gte(schema.dailySummaries.date, first),
          lte(schema.dailySummaries.date, last),
        ),
      )
      .orderBy(desc(schema.dailySummaries.createdAt), desc(schema.dailySummaries.id))
      .all()
    for (const s of found)
      if (!summaries.has(s.date))
        summaries.set(s.date, {
          id: s.id,
          projectId,
          cadence,
          period: s.date,
          body: s.body,
          author: s.author,
          createdAt: s.createdAt,
          source: 'summary',
          attachments: [],
        })
  }

  return {
    ...schedule,
    current: periodOf(cadence, now),
    periods: periods.flatMap((period) => {
      const report = views.get(period) ?? summaries.get(period) ?? null
      if (!report && settings.since && period < settings.since) return []
      return [
        {
          period,
          label: periodLabel(cadence, period),
          due: dueAt(settings, period).toISOString(),
          status: reportStatus(settings, period, Boolean(report), now),
          report,
          versions: versions.get(period) ?? 0,
        },
      ]
    }),
  }
}

export type ReportList = ReturnType<typeof listReports>
export type ReportPeriod = ReportList['periods'][number]
