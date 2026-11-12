import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import { db, schema } from '#/db'
import {
  RUN_REPORT_AGENTS,
  RUN_REPORT_TIME_KEYS,
  type RunReport,
  type RunReportRow,
  type RunReportStep,
  type RunReportTime,
} from '#/lib/runReports'
import { HttpError, notFound } from './http'
import { listAgents } from './projectAgents'
import { ticketTimeline } from './workTimeline'

/**
 * Run reports: what a subagent records about how it did one run, before it hands back (the templates
 * ship under src/server/skill/review/run-reports). One row per run, so a ticket with three rounds has
 * three hunt reports, each with its round.
 *
 * The duration is the work timeline's measured span when one covers the run (agent and round, matched
 * by the report's own times when it gives them), and the agent's own estimate kept beside it; without a
 * span the estimate stands and says so, and a report that gives no time at all says the duration is
 * unknown rather than claiming zero. Writes are quiet: no activity row, as for the timeline itself.
 */

const clean = (s: string | undefined) => s?.trim() ?? ''

/** A ticket of the project the caller named; another project's is refused and nothing is written. */
function scopedTicket(projectId: number, ticketId: number) {
  const project = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()
  if (!project) throw notFound('project')
  const t = db.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId)).get()
  if (!t) throw notFound('ticket')
  if (t.projectId !== projectId) throw new HttpError(403, `#${ticketId} is not a ticket of this project`)
  return t
}

/** A name as it is compared: the last segment of a sub-identity (`orch/hunt-1` is `hunt-1`), lowercased. */
const segment = (name: string) => name.trim().toLowerCase().split('/').at(-1) ?? ''

/** The kind of run a name stands for: a known agent (`hunt`) or that agent's numbered worker (`hunt-1`). */
function runKindOf(name: string, known: Set<string>) {
  const seg = segment(name)
  if (!seg) return null
  const base = seg.replace(/-\d+$/, '')
  for (const kind of known) if (seg === kind || base === kind) return kind
  return null
}

/** The run kinds a ticket's timeline can name: the default subagents and the project's own agents. */
function knownKinds(projectId: number) {
  return new Set<string>([...RUN_REPORT_AGENTS, ...listAgents(projectId).map((a) => a.name.toLowerCase())])
}

/**
 * The closed span that measured a run of `agent` in `round`, if the work timeline has one: the one the
 * report's own times overlap most (two runs of one agent in one round each find their own), else the
 * latest. With no times from the report, the latest is all there is.
 */
function measuredRun(
  ticketId: number,
  agent: string,
  round: number | null,
  own: { start: number | null; end: number | null } = { start: null, end: null },
) {
  const t = db.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId)).get()
  if (!t) return null
  const known = knownKinds(t.projectId)
  const kind = runKindOf(agent, known) ?? segment(agent)
  const spans = ticketTimeline(ticketId)
    .timeline.spans.filter(
      (s) => !s.open && (s.round ?? null) === round && runKindOf(s.agent, known) === kind,
    )
    .sort((a, b) => a.start.localeCompare(b.start) || a.id - b.id)
  if (!spans.length) return null
  let chosen = spans.at(-1)!
  if (own.start !== null || own.end !== null) {
    const from = own.start ?? own.end!
    const to = own.end ?? own.start!
    let bestOverlap = 0
    for (const span of spans) {
      const overlap = Math.min(to, Date.parse(span.end)) - Math.max(from, Date.parse(span.start))
      if (overlap > 0 && overlap >= bestOverlap) {
        bestOverlap = overlap
        chosen = span
      }
    }
  }
  return {
    start: chosen.start,
    end: chosen.end,
    durationMs: Math.max(0, Date.parse(chosen.end) - Date.parse(chosen.start)),
  }
}

// --- what the MCP tools and the REST body take ---

const Millis = z
  .number()
  .int()
  .min(0)
  .max(30 * 24 * 60 * 60 * 1000)
const Moment = z
  .string()
  .trim()
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)), 'an ISO time, such as 2026-11-12T09:30:00Z')
const Rating = z.number().int().min(1).max(5)

/** Where the run's time went; the fields left out count as 0. */
export const RunReportTimeInput = z.object({
  readingMs: Millis.optional().describe('reading the spec, the code, the diff'),
  runningMs: Millis.optional().describe('running commands, tests, probes, the browser'),
  waitingMs: Millis.optional().describe('waiting on a lock, a build, another agent'),
  writingMs: Millis.optional().describe('writing the change, the findings, the report'),
  otherMs: Millis.optional().describe('anything else'),
})

const StepInput = z.object({
  name: z.string().trim().min(1).max(200).describe('the step your instructions prescribe'),
  done: z.boolean().default(true),
  note: z.string().max(2_000).default('').describe('why it was skipped, or what it found'),
})

/** The fields of a report, apart from the project and ticket it is scoped to. */
export const runReportFields = {
  agent: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .describe(
      `the kind of run: ${RUN_REPORT_AGENTS.join(', ')}, or one of the project's own agents. A ticket with several runs of one agent is told apart by round`,
    ),
  round: z
    .number()
    .int()
    .min(1)
    .max(20)
    .nullable()
    .optional()
    .describe('the review round the run belongs to; null or left out outside a review'),
  branch: z.string().max(300).optional().describe('the branch the run worked'),
  headSha: z.string().max(64).optional().describe('the commit the run worked at'),
  model: z.string().max(120).optional().describe('the model the run used'),
  effort: z.string().max(40).optional().describe('the thinking effort the run used: low, medium or high'),
  briefedBy: z.string().max(80).optional().describe('the orchestrator or agent that briefed this run'),
  startedAt: Moment.optional().describe('when the run began'),
  endedAt: Moment.optional().describe('when the run ended'),
  durationMs: Millis.optional().describe(
    "your own estimate of the run's duration; the work timeline's measured span replaces it when one covers the run, and yours is kept as reportedDurationMs",
  ),
  time: RunReportTimeInput.optional().describe('where the time went, in milliseconds'),
  difficulty: Rating.nullable().optional().describe('how hard the run was for you, 1 (easy) to 5 (hard)'),
  confidence: Rating.nullable().optional().describe('your confidence in your own result, 1 to 5'),
  steps: z
    .array(StepInput)
    .max(60)
    .optional()
    .describe('one entry per step your instructions prescribe: {name, done, note}'),
  counts: z
    .record(z.string().max(60), z.number().int())
    .refine((counts) => Object.keys(counts).length <= 40, 'at most 40 counts')
    .optional()
    .describe('the numbers the run produced, so they can be added up'),
  sections: z
    .record(z.string().trim().min(1).max(60), z.string().max(20_000))
    .refine((sections) => Object.keys(sections).length <= 40, 'at most 40 sections')
    .optional()
    .describe(
      'the prose, one named field per section: brief, readRan, problems, gaps, moreTime, improvements, then the ones of your agent',
    ),
}

/** `POST /api/projects/:id/run-reports` and the `write_run_report` tool's shape. */
export const RunReportBody = z.object({
  ticketId: z.number().int(),
  ...runReportFields,
})

/** The run report's measured or self-reported duration and where each part went, filled to every key. */
function fullTime(time: z.infer<typeof RunReportTimeInput> | undefined): RunReportTime {
  return Object.fromEntries(RUN_REPORT_TIME_KEYS.map((k) => [k, time?.[k] ?? 0])) as RunReportTime
}

/** Store one run report and answer it as it reads back. */
export function writeReport(
  projectId: number,
  input: z.infer<typeof RunReportBody>,
  actor: string,
): RunReport {
  const t = scopedTicket(projectId, input.ticketId)
  const agent = clean(input.agent)
  const round = input.round ?? null
  const ownStart = input.startedAt ? Date.parse(input.startedAt) : null
  const ownEnd = input.endedAt ? Date.parse(input.endedAt) : null
  const measured = measuredRun(t.id, agent, round, { start: ownStart, end: ownEnd })
  const own =
    input.durationMs ?? (ownStart !== null && ownEnd !== null ? Math.max(0, ownEnd - ownStart) : null)
  const row = db
    .insert(schema.runReports)
    .values({
      projectId,
      ticketId: t.id,
      agent,
      round,
      branch: clean(input.branch),
      headSha: clean(input.headSha),
      model: clean(input.model),
      effort: clean(input.effort),
      briefedBy: clean(input.briefedBy),
      startedAt: measured?.start ?? (ownStart !== null ? new Date(ownStart).toISOString() : null),
      endedAt: measured?.end ?? (ownEnd !== null ? new Date(ownEnd).toISOString() : null),
      durationMs: measured?.durationMs ?? own ?? 0,
      durationSource: measured ? 'measured' : own !== null ? 'self' : 'unknown',
      reportedDurationMs: own,
      time: fullTime(input.time),
      difficulty: input.difficulty ?? null,
      confidence: input.confidence ?? null,
      steps: (input.steps ?? []) as RunReportStep[],
      counts: input.counts ?? {},
      sections: input.sections ?? {},
      author: actor,
    })
    .returning()
    .get()
  return row
}

/** One report in full, scoped to its project: another project's is not found. */
export function getReport(projectId: number, reportId: number): RunReport {
  const row = db.select().from(schema.runReports).where(eq(schema.runReports.id, reportId)).get()
  if (!row || row.projectId !== projectId) throw notFound('run report')
  return row
}

export type RunReportFilter = { agent?: string; ticketId?: number; round?: number }

/**
 * A project's reports, newest first, each with its ticket's title. `agent` matches any casing and by
 * kind: a report written as `hunt`, `orch/hunt` or `opencode/hunt-1` is `hunt`'s. The limit applies to
 * those rows, so a kind's reports are not cut short by another kind's.
 */
export function listReports(projectId: number, limit = 60, filter: RunReportFilter = {}): RunReportRow[] {
  const known = knownKinds(projectId)
  const wanted = filter.agent ? runKindOf(filter.agent, known) : null
  // A name no agent kind covers is still found as it was stored, whatever its casing.
  const exact = filter.agent && !wanted ? filter.agent.trim().toLowerCase() : null
  const rows = db
    .select({ report: schema.runReports, ticketTitle: schema.tickets.title })
    .from(schema.runReports)
    .innerJoin(schema.tickets, eq(schema.runReports.ticketId, schema.tickets.id))
    .where(
      and(
        eq(schema.runReports.projectId, projectId),
        filter.ticketId === undefined ? undefined : eq(schema.runReports.ticketId, filter.ticketId),
        filter.round === undefined ? undefined : eq(schema.runReports.round, filter.round),
        exact ? sql`lower(${schema.runReports.agent}) = ${exact}` : undefined,
      ),
    )
    .orderBy(desc(schema.runReports.createdAt), desc(schema.runReports.id))
    .all()
  return rows
    .filter(({ report }) => !wanted || runKindOf(report.agent, known) === wanted)
    .slice(0, limit)
    .map(({ report, ticketTitle }) => ({ ...report, ticketTitle }))
}

/** One ticket's reports, newest first (the ticket page's Agents side). */
export function ticketReports(ticketId: number): RunReport[] {
  return db
    .select()
    .from(schema.runReports)
    .where(eq(schema.runReports.ticketId, ticketId))
    .orderBy(desc(schema.runReports.createdAt), desc(schema.runReports.id))
    .all()
}

/** A subagent run the work timeline records that has no report: the hand-off's flag. */
export interface MissingRunReport {
  agent: string
  round: number | null
  /** How many runs it recorded: its spans, or its hand-offs when there are more (a run has both). */
  runs: number
  /** How many spans of them. */
  spans: number
  /** How many reports of that agent and round the ticket has: fewer than `runs` is what flags it. */
  reports: number
  /** The earliest of them. */
  since: string
}

/**
 * The subagent runs of a ticket's work timeline that no report covers, by agent and round: spans whose
 * agent is one of the default subagents or the project's own (a numbered worker counts as its agent),
 * and hand-offs to one of them, which record a run that left no span. A run has both a span and the
 * hand-off that briefed it, so a group's runs are the larger of its two counts, not their sum, and it
 * is flagged when it has fewer reports than runs. The orchestrator's own spans name no such agent, so a
 * ticket worked only by the orchestrator has an empty list. Enforcement is a flag: a move to review
 * goes through and answers with this.
 */
export function missingReports(ticketId: number): MissingRunReport[] {
  const t = db.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId)).get()
  if (!t) return []
  const known = knownKinds(t.projectId)
  type Group = { agent: string; round: number | null; spans: number; handoffs: number; since: string }
  const groups = new Map<string, Group>()
  const spansByKind = new Map<string, { round: number | null; start: string; end: string }[]>()
  const { timeline } = ticketTimeline(ticketId)
  for (const span of timeline.spans) {
    const kind = runKindOf(span.agent, known)
    if (!kind) continue
    const key = `${kind}|${span.round ?? ''}`
    const found = groups.get(key)
    if (found) {
      found.spans += 1
      if (span.start < found.since) found.since = span.start
    } else {
      groups.set(key, { agent: kind, round: span.round ?? null, spans: 1, handoffs: 0, since: span.start })
    }
    spansByKind.set(kind, [...(spansByKind.get(kind) ?? []), span])
  }
  // A hand-off briefs a run; an agent that recorded no span is recorded by it alone. It joins the span
  // of its kind it sits nearest, so a normal run (span and hand-off) is one run, not two.
  for (const handoff of timeline.handoffs) {
    const kind = runKindOf(handoff.to, known)
    if (!kind) continue
    let round: number | null = null
    let nearest = Number.POSITIVE_INFINITY
    for (const span of spansByKind.get(kind) ?? []) {
      const at = Date.parse(handoff.at)
      const gap = Math.max(0, Date.parse(span.start) - at, at - Date.parse(span.end))
      if (gap < nearest) {
        nearest = gap
        round = span.round ?? null
      }
    }
    const key = `${kind}|${round ?? ''}`
    const found = groups.get(key)
    if (found) {
      found.handoffs += 1
      if (handoff.at < found.since) found.since = handoff.at
    } else {
      groups.set(key, { agent: kind, round, spans: 0, handoffs: 1, since: handoff.at })
    }
  }
  if (!groups.size) return []
  const reported = new Map<string, number>()
  for (const r of db
    .select({ agent: schema.runReports.agent, round: schema.runReports.round })
    .from(schema.runReports)
    .where(eq(schema.runReports.ticketId, ticketId))
    .all()) {
    const key = `${runKindOf(r.agent, known) ?? segment(r.agent)}|${r.round ?? ''}`
    reported.set(key, (reported.get(key) ?? 0) + 1)
  }
  return [...groups.entries()]
    .map(([key, g]) => ({ ...g, reports: reported.get(key) ?? 0 }))
    .filter((g) => g.reports < Math.max(g.spans, g.handoffs))
    .map(({ agent, round, spans, handoffs, reports, since }) => ({
      agent,
      round,
      runs: Math.max(spans, handoffs),
      spans,
      reports,
      since,
    }))
    .sort((a, b) => a.since.localeCompare(b.since) || a.agent.localeCompare(b.agent))
}
