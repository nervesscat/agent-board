import { and, eq } from 'drizzle-orm'

import { db, schema } from '#/db'
import { periodLabel } from '#/lib/reports'
import { cleanupReport } from '../cleanup'
import { HttpError } from '../http'
import { reportDueFor } from '../reportDue'
import { generateReport, generationState } from '../reportGenerate'
import { readReportSettings } from '../reports'
import type { AlertActionContext, AlertCandidate, AlertContext, AlertType } from './registry'

/**
 * The housekeeping alerts: what the board keeps asking the human to tidy or write. Cleanup ready (14),
 * a report due (15) and a report that could not be generated (35).
 */

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS

const projectOf = (ctx: AlertContext) => ctx.projectId!

/** "the daily report for Mon, Oct 5" / "the weekly report for the week of Oct 5". */
const reportOf = (cadence: 'daily' | 'weekly', period: string) =>
  `the ${cadence} report for ${cadence === 'weekly' ? 'the ' : ''}${periodLabel(cadence, period)}`

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// 14: cleanup ready ---------------------------------------------------------------------------------

/** How long a project's cleanup count is kept: the count reads git, and the check runs every minute. */
export const CLEANUP_CACHE_MS = 5 * MINUTE_MS

interface CleanupCount {
  at: number
  branches: number
  remote: number
  workspaces: number
  worktrees: number
  previews: number
}
const cleanupCounts = new Map<number, CleanupCount>()

/** What finished tickets left behind in the project, read at most once in `CLEANUP_CACHE_MS`. */
async function leftovers(projectId: number, now: number): Promise<CleanupCount> {
  const kept = cleanupCounts.get(projectId)
  if (kept && now - kept.at >= 0 && now - kept.at < CLEANUP_CACHE_MS) return kept
  // Without the reach of each branch: the quick count the Cleanup page's header starts from.
  const { counts } = await cleanupReport(projectId, { reach: false })
  const fresh = {
    at: now,
    branches: counts.branches,
    remote: counts.remote,
    workspaces: counts.workspaces,
    worktrees: counts.worktrees,
    previews: counts.previews,
  }
  cleanupCounts.set(projectId, fresh)
  return fresh
}

export async function checkCleanup(ctx: AlertContext): Promise<AlertCandidate[]> {
  const projectId = projectOf(ctx)
  const { branches, remote, workspaces, worktrees, previews } = await leftovers(projectId, ctx.now())
  if (!branches && !remote && !workspaces && !worktrees && !previews) return []
  const parts = [
    branches && `${plural(branches, 'branch', 'branches')} here`,
    remote && `${remote} on origin`,
    workspaces && plural(workspaces, 'workspace'),
    worktrees && plural(worktrees, 'worktree'),
    previews && plural(previews, 'preview'),
  ].filter(Boolean)
  return [
    {
      severity: 'info',
      title: 'Finished tickets left work to clean up',
      body: `Tickets that are done or cancelled still have ${parts.join(', ')}. The Cleanup page checks what landed and removes it.`,
      buttons: [{ id: 'open', label: 'Open Cleanup', kind: 'link', href: `/projects/${projectId}/cleanup` }],
    },
  ]
}

// 15: report due ------------------------------------------------------------------------------------

export function checkReportDue(ctx: AlertContext): AlertCandidate[] {
  const projectId = projectOf(ctx)
  // The banner's own function, so the alert and the banner always agree.
  const due = reportDueFor(projectId, new Date(ctx.now()))
  if (!due) return []
  const missing = due.state === 'missing'
  return [
    {
      subject: `${due.cadence}:${due.period}`,
      severity: 'info',
      title: `${capital(reportOf(due.cadence, due.period))} is ${missing ? 'missing' : 'due soon'}`,
      body: missing
        ? `It was due at ${clock(due.dueAt)} and has not been written yet.`
        : `It is due at ${clock(due.dueAt)}.`,
      buttons: [{ id: 'open', label: 'Open Reports', kind: 'link', href: `/projects/${projectId}/daily` }],
    },
  ]
}

const capital = (s: string) => s[0]!.toUpperCase() + s.slice(1)

const clock = (iso: string) => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// 35: report generation failed ----------------------------------------------------------------------

export function checkReportFailed(ctx: AlertContext): AlertCandidate[] {
  const projectId = projectOf(ctx)
  const { error } = generationState(projectId)
  if (!error) return []
  const { cadence } = readReportSettings(projectId)
  if (cadence === 'off') return []
  // Written by hand since, or by a later run: nothing is left to retry.
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
  if (written) return []
  const daily = `/projects/${projectId}/daily`
  return [
    {
      subject: error.period,
      severity: 'warning',
      title: `${capital(reportOf(cadence, error.period))} could not be generated`,
      body: `${capital(reportOf(cadence, error.period))} could not be generated: ${error.message}`,
      buttons: [
        { id: 'retry', label: 'Try again', kind: 'action', primary: true },
        { id: 'write', label: 'Write it by hand', kind: 'link', href: daily },
        { id: 'open', label: 'Open Reports', kind: 'link', href: daily },
      ],
    },
  ]
}

/** The same run the Generate button starts, for the period the alert is about. */
async function retryGeneration(ctx: AlertActionContext) {
  const projectId = projectOf(ctx)
  try {
    // Bounded by the CLI's own timeout (CLAUDE_TIMEOUT_MS); one run per project at a time.
    await generateReport(projectId, { period: ctx.alert.subject }, new Date(ctx.now()))
  } catch (e) {
    const why = e instanceof HttpError || e instanceof Error ? e.message : String(e)
    return { message: `Could not generate the report: ${why}` }
  }
  return { message: 'claude wrote the report', resolve: true }
}

export const alertTypes: AlertType[] = [
  {
    type: 'cleanup-ready',
    idea: 14,
    group: 'housekeeping',
    label: 'Cleanup ready',
    description: 'Finished tickets left branches, worktrees or previews to clean up',
    scope: 'project',
    check: checkCleanup,
    snoozeOptions: [DAY_MS, 7 * DAY_MS],
  },
  {
    type: 'report-due',
    idea: 15,
    group: 'housekeeping',
    label: 'Report due',
    description: 'The daily or weekly report is due or missing',
    scope: 'project',
    check: checkReportDue,
  },
  {
    type: 'report-generation-failed',
    idea: 35,
    group: 'housekeeping',
    label: 'Report generation failed',
    description: 'claude could not write the report (not installed, not signed in, timed out)',
    scope: 'project',
    check: checkReportFailed,
    actions: { retry: retryGeneration },
  },
]
