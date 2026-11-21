import { and, eq } from 'drizzle-orm'

import { db, schema } from '#/db'
import { localDate, shiftDate } from '#/lib/format'
import { isDay, periodLabel, periodOf, type TrackedCadence } from '#/lib/reports'
import { checkTemplate, effectiveTemplate, unwrapReport } from '#/lib/reportTemplate'
import { listActivity } from './activity'
import { runClaude } from './claude'
import { HttpError } from './http'
import { getProject } from './projects'
import { postReport, readReportSettings, type ReportView } from './reports'

/**
 * A project's report for a period, written by claude from the project's prompt, its template and the
 * period's activity, checked against the template and stored as a new version by `claude`. One run per
 * project at a time; the state of the last one is kept for the Daily page.
 */

export interface GenerationState {
  /** The period being generated right now, or null. */
  period: string | null
  /** Why the last run for a period failed, until a later one succeeds. */
  error: { period: string; message: string; at: string } | null
}

/**
 * What claude (the agent CLI) printed when it was refused for want of a sign-in: only errors that signing
 * in again fixes. A credit balance, an expired token the CLI refreshes itself or any other failure is no
 * login problem.
 */
const LOGIN_FAILURE =
  /invalid (api )?key|please run \/login|not logged in|not authenticated|authentication (failed|required)|\b401 unauthori[sz]ed|login required/i

export const needsLogin = (message: string) => LOGIN_FAILURE.test(message)

/** The author of every generated report. */
export const GENERATED_BY = 'claude'

// Kept in memory, like the run itself: a restart ends both.
const running = new Map<number, string>()
const failed = new Map<number, NonNullable<GenerationState['error']>>()

/** What the prompt says when the project has none of its own. */
const DEFAULT_PROMPT =
  'Report the period at the highest level, for the human who owns the project and has a minute: what got done, what is in progress, what is blocked or needs them, and what comes next. Plain words, short bullets.'

/**
 * Generates the report of `period` (any day of it; the current period by default) and stores it.
 * Refuses (400) while reports are off, are files, or nothing happened in the period; 409 while one is
 * being written for the project. A run whose output does not fill the template is asked once more; a
 * second miss, or a run that fails, is a 502 kept as `generationState(…).error` until one succeeds.
 */
export async function generateReport(
  projectId: number,
  input: { period?: string } = {},
  now = new Date(),
): Promise<ReportView> {
  const project = getProject(projectId)
  const settings = readReportSettings(projectId)
  if (settings.cadence === 'off')
    throw new HttpError(400, 'reports are off for this project: set a cadence first (report settings)')
  if (settings.format === 'file')
    throw new HttpError(400, "this project's reports are files: claude only writes text reports")
  const cadence = settings.cadence
  const current = periodOf(cadence, now)
  if (input.period !== undefined && !isDay(input.period))
    throw new HttpError(400, 'period must be a date, YYYY-MM-DD')
  const period = input.period ? periodOf(cadence, input.period) : current
  if (period > current) throw new HttpError(400, `the period ${period} has not started yet`)
  if (running.has(projectId))
    throw new HttpError(
      409,
      `claude is already writing the report for ${periodLabel(cadence, running.get(projectId)!)}`,
    )

  const lines = periodDays(cadence, period, now).flatMap((day) =>
    listActivity(day, projectId).map((a) => `${day} ${hhmm(a.createdAt)} ${a.actor}: ${a.text}`),
  )
  if (!lines.length) throw new HttpError(400, `nothing happened in ${periodLabel(cadence, period)}`)

  const template = effectiveTemplate(settings.template)
  const prompt = reportPrompt({
    project: project.name,
    cadence,
    label: periodLabel(cadence, period),
    instructions: settings.prompt.trim() || DEFAULT_PROMPT,
    template,
    lines,
  })

  // Nothing is awaited between the check above and here, so two requests cannot both get past it.
  running.set(projectId, period)
  try {
    let body = unwrapReport(await runClaude(prompt))
    let check = checked(template, body)
    if (!check.ok) {
      body = unwrapReport(await runClaude(retryPrompt(prompt, check.reason)))
      check = checked(template, body)
    }
    if (!check.ok)
      throw new HttpError(502, `claude's report did not fill the template twice (${check.reason})`)
    const report = await postReport(projectId, { period, body }, GENERATED_BY, now)
    failed.delete(projectId)
    return report
  } catch (e) {
    failed.set(projectId, {
      period,
      message: e instanceof Error ? e.message : String(e),
      at: new Date().toISOString(),
    })
    throw e
  } finally {
    running.delete(projectId)
  }
}

/**
 * The failure of the project's last run that still stands: nothing is left to retry once reports are off
 * or the report of the failed period was written since (by hand, or by a later run). Null then. The alerts
 * about a failed generation share it, so they agree on when it is over.
 */
export function standingFailure(projectId: number): NonNullable<GenerationState['error']> | null {
  const error = failed.get(projectId)
  if (!error) return null
  const { cadence } = readReportSettings(projectId)
  if (cadence === 'off') return null
  const written = db
    .select({ id: schema.reports.id })
    .from(schema.reports)
    .where(
      and(
        eq(schema.reports.projectId, projectId),
        eq(schema.reports.cadence, cadence),
        eq(schema.reports.period, error.period),
      ),
    )
    .get()
  return written ? null : error
}

export function generationState(projectId: number): GenerationState {
  return { period: running.get(projectId) ?? null, error: failed.get(projectId) ?? null }
}

/** The template check, with an empty answer a miss of its own. */
const checked = (template: string, body: string) =>
  body ? checkTemplate(template, body) : ({ ok: false, reason: 'the answer was empty' } as const)

/** The days of a period up to today: the day itself, or a week's days from its Monday. */
function periodDays(cadence: TrackedCadence, period: string, now: Date): string[] {
  if (cadence === 'daily') return [period]
  const today = localDate(now)
  return Array.from({ length: 7 }, (_, i) => shiftDate(period, i)).filter((d) => d <= today)
}

/** Local `HH:MM` of a stored moment. */
const hhmm = (iso: string) => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** What claude is asked: the project's own prompt says what and how, the template fixes the shape. */
export function reportPrompt(p: {
  project: string
  cadence: TrackedCadence
  label: string
  instructions: string
  template: string
  lines: string[]
}): string {
  return [
    `You write the ${p.cadence} report of the project "${p.project}" for ${p.label}, on a work board shared by a developer and their AI agents.`,
    '',
    'What the report must say and how (the project owner wrote this):',
    '<instructions>',
    p.instructions,
    '</instructions>',
    '',
    'The report must fill this template: keep each of its headings, at the same level and in the same order, add no other heading at those levels, and write each section under its heading (deeper headings are fine).',
    '<template>',
    p.template.trim(),
    '</template>',
    '',
    'Answer with the report only, in markdown: no preamble, nothing after it, no code fence around it.',
    '',
    `Everything that happened on the project in ${p.label}, one line per action (local date and time, who, what):`,
    '<activity>',
    ...p.lines,
    '</activity>',
  ].join('\n')
}

function retryPrompt(prompt: string, reason: string): string {
  return [
    prompt,
    '',
    `Your previous answer did not fill the template (${reason}). Write the report again with exactly the template's headings, in its order.`,
  ].join('\n')
}
