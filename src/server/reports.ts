import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm'
import { z } from 'zod'

import { db, schema } from '#/db'
import { REPORT_CADENCES, REPORT_FORMATS } from '#/lib/constants'
import { localDate, shiftDate } from '#/lib/format'
import {
  DAY,
  TIME,
  describeSchedule,
  dueAt,
  periodLabel,
  periodOf,
  periodsBetween,
  reportStatus,
  type ReportStatus,
  type TrackedCadence,
} from '#/lib/reports'
import { DEFAULT_REPORT_TEMPLATE, effectiveTemplate } from '#/lib/reportTemplate'
import { logActivity } from './activity'
import { HttpError } from './http'
import { getProject } from './projects'
import { generationState } from './reportGenerate'
import { pendingChanges, recordSettingsChanges } from './reportSettingsHistory'
import { attachTo, attachmentView, saveFromPath } from './uploads'

/**
 * A project's reports: the prompt saying what each must contain, the template fixing its shape, the
 * shift whose end it is due at (daily on workdays, or weekly on a weekday), and the reports posted
 * for each period. A period is done once it has a report, missing once it is due without one,
 * upcoming until then.
 */

const Time = z.string().regex(TIME, 'HH:MM, 24-hour')

/** What the settings take, for the REST body and the MCP tool alike. */
export const reportSettingsShape = {
  prompt: z
    .string()
    .max(50_000)
    .optional()
    .describe(
      'markdown: what the report must say and how (audience, tone, what to stress, a short text or a PDF)',
    ),
  template: z
    .string()
    .max(50_000)
    .optional()
    .describe(
      'markdown skeleton a generated report must fill: its headings, in order, are the sections; "" goes back to the default',
    ),
  cadence: z
    .enum(REPORT_CADENCES)
    .optional()
    .describe('off (not tracked), daily (on workdays), or weekly (once a week, due on weekday)'),
  weekday: z
    .number()
    .int()
    .min(1)
    .max(7)
    .optional()
    .describe('the day a weekly report is due, 1 (Monday) to 7 (Sunday)'),
  shiftStart: Time.optional().describe('local HH:MM the shift starts'),
  shiftEnd: Time.optional().describe('local HH:MM the shift ends, after shiftStart: the report is due then'),
  workdays: z
    .array(z.number().int().min(1).max(7))
    .min(1)
    .refine((days) => new Set(days).size === days.length, 'each workday once')
    .optional()
    .describe('the days a daily report is asked for, ISO weekdays 1 (Monday) to 7 (Sunday)'),
  alertMinutes: z
    .number()
    .int()
    .min(0)
    .max(720)
    .optional()
    .describe('how many minutes before the shift ends the board starts reminding that the report is due'),
  format: z
    .enum(REPORT_FORMATS)
    .optional()
    .describe('text (written on the board) or file (an attached file, e.g. a PDF, is required)'),
}
// Strict: a field the board does not take (the old dueTime, say) is refused rather than ignored.
export const ReportSettingsPatch = z.object(reportSettingsShape).strict()
export type ReportSettingsPatch = z.infer<typeof ReportSettingsPatch>

/** The settings as the API answers them: the template in force, and agents' changes waiting on the human. */
export interface ReportSettingsView extends Omit<schema.ReportSettings, 'template'> {
  template: string
  templateIsDefault: boolean
  pending: schema.ReportSettingsChange[]
}

const defaults = (projectId: number): schema.ReportSettings => ({
  projectId,
  prompt: '',
  template: '',
  cadence: 'off',
  weekday: 5,
  shiftStart: '09:00',
  shiftEnd: '17:00',
  workdays: [1, 2, 3, 4, 5],
  alertMinutes: 30,
  format: 'text',
  since: '',
  updatedBy: '',
  updatedAt: '',
})

/** The stored row (the template as stored: '' for the default), or the defaults. */
export function readReportSettings(projectId: number): schema.ReportSettings {
  getProject(projectId)
  return (
    db.select().from(schema.reportSettings).where(eq(schema.reportSettings.projectId, projectId)).get() ??
    defaults(projectId)
  )
}

function view(row: schema.ReportSettings): ReportSettingsView {
  return {
    ...row,
    template: effectiveTemplate(row.template),
    templateIsDefault: !row.template.trim(),
    pending: pendingChanges(row.projectId),
  }
}

export function getReportSettings(projectId: number): ReportSettingsView {
  return view(readReportSettings(projectId))
}

/**
 * Anyone may change them, agents included. A change of the prompt or the template goes into their
 * history (an agent's waits on the human there); a change of the schedule is a line in the activity.
 */
export function setReportSettings(
  projectId: number,
  patch: ReportSettingsPatch,
  actor: string,
  opts: { agent?: boolean } = {},
  now = new Date(),
): ReportSettingsView {
  const parsed = ReportSettingsPatch.safeParse(patch)
  if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error))
  const before = readReportSettings(projectId)
  const next = {
    ...before,
    ...Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined)),
  } as schema.ReportSettings
  next.workdays = [...next.workdays].sort((a, b) => a - b)
  // The default template is kept as '', so it follows the board's default.
  if (next.template === DEFAULT_REPORT_TEMPLATE) next.template = ''
  if (next.shiftEnd <= next.shiftStart)
    throw new HttpError(400, `the shift must end after it starts (${next.shiftStart} to ${next.shiftEnd})`)
  // Periods before tracking began are not missing: they were never asked for.
  if (next.cadence !== before.cadence) next.since = next.cadence === 'off' ? '' : periodOf(next.cadence, now)

  const text = next.prompt !== before.prompt || next.template !== before.template
  const schedule =
    SCHEDULE.some((k) => next[k] !== before[k]) || next.workdays.join() !== before.workdays.join()
  if (!text && !schedule && before.updatedAt) return view(before)

  const values = { ...next, updatedBy: actor, updatedAt: now.toISOString() }
  const row = db.transaction(() => {
    const saved = db
      .insert(schema.reportSettings)
      .values(values)
      .onConflictDoUpdate({ target: schema.reportSettings.projectId, set: values })
      .returning()
      .get()
    recordSettingsChanges(projectId, before, saved, actor, { agent: opts.agent })
    return saved
  })
  if (schedule)
    logActivity({
      projectId,
      actor,
      kind: 'report',
      text: `changed the report schedule (${describeSchedule(row)})`,
      refType: 'project',
      refId: projectId,
    })
  return view(row)
}

/** The settings that say when a report is due and what it is; `workdays` is compared on its own. */
const SCHEDULE = ['cadence', 'weekday', 'shiftStart', 'shiftEnd', 'alertMinutes', 'format'] as const

const tracked = (s: Pick<schema.ReportSettings, 'cadence'>): TrackedCadence => {
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
  const settings = readReportSettings(projectId)
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
  const cadence = tracked(readReportSettings(projectId))
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

export interface ReportPeriod {
  period: string
  label: string
  due: string
  status: ReportStatus
  report: ReportView | null
  versions: number
}

export interface ReportList extends Omit<ReportSettingsView, 'prompt' | 'template' | 'pending'> {
  /** The period now falls in; null while the cadence is off. */
  current: string | null
  periods: ReportPeriod[]
  /** The period claude is writing the report of right now, or null. */
  generating: string | null
  /** Why the last generation failed, until a later one succeeds. */
  generateError: { period: string; message: string; at: string } | null
}

/**
 * The project's periods from `from` to `to` (days; by default the last two weeks of a daily cadence or
 * eight weeks of a weekly one, up to today), newest first, each with when it is due, its status and
 * its latest report. Periods before tracking began are left out unless they have a report.
 */
export function listReports(
  projectId: number,
  range: { from?: string; to?: string } = {},
  now = new Date(),
): ReportList {
  const settings = readReportSettings(projectId)
  const { prompt: _prompt, template, ...schedule } = settings
  const generation = generationState(projectId)
  const base = {
    ...schedule,
    templateIsDefault: !template.trim(),
    generating: generation.period,
    generateError: generation.error,
  }
  if (settings.cadence === 'off') return { ...base, current: null, periods: [] }
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

  return {
    ...base,
    current: periodOf(cadence, now),
    periods: periods.flatMap((period) => {
      const report = views.get(period) ?? null
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
