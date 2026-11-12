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

/**
 * The kind of run a name stands for: a known agent (`hunt`) or that agent's numbered worker (`hunt-1`).
 * A known name wins before the number is stripped, so a project agent actually named `hunt-1` is not
 * folded into `hunt`.
 */
function runKindOf(name: string, known: Set<string>) {
  const seg = segment(name)
  if (!seg) return null
  if (known.has(seg)) return seg
  const base = seg.replace(/-\d+$/, '')
  return base !== seg && known.has(base) ? base : null
}

/** The run kinds a ticket's timeline can name: the default subagents and the project's own agents. */
function knownKinds(projectId: number) {
  return new Set<string>([...RUN_REPORT_AGENTS, ...listAgents(projectId).map((a) => a.name.toLowerCase())])
}

/**
 * The closed span that measured a run of `agent` in `round`, if the work timeline has one: the one the
 * report's own times overlap most (two runs of one agent in one round each find their own), else the
 * latest. With no times from the report, the latest is all there is. With times that overlap no span,
 * or two spans at least as well, there is no telling which run they belong to, so nothing is measured
 * and the report's own estimate stands.
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
    let best: (typeof spans)[number] | null = null
    let bestOverlap = 0
    let tied = false
    for (const span of spans) {
      const spanStart = Date.parse(span.start)
      const spanEnd = Date.parse(span.end)
      // One known time is a moment: it overlaps the span it falls in.
      const overlap =
        from === to
          ? from >= spanStart && from <= spanEnd
            ? 1
            : 0
          : Math.min(to, spanEnd) - Math.max(from, spanStart)
      if (overlap <= 0) continue
      if (overlap > bestOverlap) {
        best = span
        bestOverlap = overlap
        tied = false
      } else if (overlap === bestOverlap) tied = true
    }
    if (!best || tied) return null
    chosen = best
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
  // A run cannot end before it starts: storing that would read as a measured-looking 0-minute run.
  if (ownStart !== null && ownEnd !== null && ownEnd < ownStart)
    throw new HttpError(400, "endedAt is before startedAt: give the run's start and end in order")
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
  /** How many runs it recorded: its spans, plus a hand-off that no span answered. */
  runs: number
  /** How many spans of them. */
  spans: number
  /**
   * How many reports cover them: of that agent and round for the runs a span recorded; for the runs only
   * a hand-off recorded, the reports of that agent written after those hand-offs, one apiece. Fewer than
   * `runs` is what flags it.
   */
  reports: number
  /** The earliest of them. */
  since: string
}

/**
 * The subagent runs of a ticket's work timeline that no report covers, by agent and round: spans whose
 * agent is one of the default subagents or the project's own (a numbered worker counts as its agent),
 * and the hand-offs to one of them that no span answered, which record a run of their own. A hand-off
 * carries a time and an agent, never a round: it briefs the run of its agent that started next, so its
 * span is the one of that agent with the earliest start at or after it, each span briefed by one
 * hand-off, matched in time order. A hand-off that fits no span is its own run, with no round, and only
 * a report written after it covers it, one report each: a report from before it never does. A group is
 * flagged when it has fewer reports than runs. The orchestrator's own spans name no such agent, so a
 * ticket worked only by the orchestrator has an empty list. Enforcement is a flag: a move to review
 * goes through and answers with this.
 */
export function missingReports(ticketId: number): MissingRunReport[] {
  const t = db.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId)).get()
  if (!t) return []
  const known = knownKinds(t.projectId)
  type Group = { agent: string; round: number | null; spans: number; handoffs: number; since: string }
  type Span = { id: number; round: number | null; start: string }
  const groups = new Map<string, Group>()
  const spansByKind = new Map<string, Span[]>()
  const { timeline } = ticketTimeline(ticketId)
  for (const span of timeline.spans) {
    const kind = runKindOf(span.agent, known)
    if (!kind) continue
    const key = `span|${kind}|${span.round ?? ''}`
    const found = groups.get(key)
    if (found) {
      found.spans += 1
      if (span.start < found.since) found.since = span.start
    } else {
      groups.set(key, { agent: kind, round: span.round ?? null, spans: 1, handoffs: 0, since: span.start })
    }
    spansByKind.set(kind, [
      ...(spansByKind.get(kind) ?? []),
      { id: span.id, round: span.round ?? null, start: span.start },
    ])
  }
  for (const spans of spansByKind.values())
    spans.sort((a, b) => a.start.localeCompare(b.start) || a.id - b.id)
  // A hand-off briefs the run that starts next of its kind, each span briefed once, in time order; one
  // with no span left to brief records a run of its own. A briefed hand-off does not add a run.
  const briefed = new Set<number>()
  const unanswered: { agent: string; at: string }[] = []
  const handoffs = [...timeline.handoffs].sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id)
  for (const handoff of handoffs) {
    const kind = runKindOf(handoff.to, known)
    if (!kind) continue
    const span = (spansByKind.get(kind) ?? []).find((s) => !briefed.has(s.id) && s.start >= handoff.at)
    if (span) briefed.add(span.id)
    else unanswered.push({ agent: kind, at: handoff.at })
  }
  for (const { agent, at } of unanswered) {
    const key = `handoff|${agent}`
    const found = groups.get(key)
    if (found) {
      found.handoffs += 1
      if (at < found.since) found.since = at
    } else {
      groups.set(key, { agent, round: null, spans: 0, handoffs: 1, since: at })
    }
  }
  if (!groups.size) return []
  const reported = new Map<string, number>()
  const reportsByKind = new Map<string, string[]>()
  for (const r of db
    .select({
      agent: schema.runReports.agent,
      round: schema.runReports.round,
      createdAt: schema.runReports.createdAt,
    })
    .from(schema.runReports)
    .where(eq(schema.runReports.ticketId, ticketId))
    .all()) {
    const kind = runKindOf(r.agent, known) ?? segment(r.agent)
    const key = `${kind}|${r.round ?? ''}`
    reported.set(key, (reported.get(key) ?? 0) + 1)
    reportsByKind.set(kind, [...(reportsByKind.get(kind) ?? []), r.createdAt])
  }
  /**
   * How many of the runs a report covers: a group with spans counts its own round's reports; a run only
   * a hand-off recorded needs a report of that agent written after it, one apiece, taken in time order
   * so two such runs need two reports. A report in the hand-off's own millisecond counts: the two cannot
   * be put in order, and refusing it would leave a flag no later report clears.
   */
  const covered = (g: Group) => {
    if (g.spans > 0) return reported.get(`${g.agent}|${g.round ?? ''}`) ?? 0
    const written = [...(reportsByKind.get(g.agent) ?? [])].sort()
    const times = unanswered
      .filter((h) => h.agent === g.agent)
      .map((h) => h.at)
      .sort()
    let taken = 0
    for (const at of written) if (taken < times.length && at >= times[taken]!) taken += 1
    return taken
  }
  return [...groups.values()]
    .map((g) => ({ ...g, reports: covered(g) }))
    .filter((g) => g.reports < g.spans + g.handoffs)
    .map(({ agent, round, spans, handoffs, reports, since }) => ({
      agent,
      round,
      runs: spans + handoffs,
      spans,
      reports,
      since,
    }))
    .sort((a, b) => a.since.localeCompare(b.since) || a.agent.localeCompare(b.agent))
}
