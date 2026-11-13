import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import { z } from 'zod'

import { db, schema } from '#/db'
import {
  type AgentEventKind,
  type BoardEventKind,
  KNOWN_PHASES,
  LEASE_TTL_MINUTES,
  WAIT_REASONS,
  type WaitReason,
} from '#/lib/constants'
import { nextTask } from '#/lib/tasks'
import {
  buildTimeline,
  sumTotals,
  type TimelineEvent,
  type TimelinePost,
  type WorkTimeline,
  type WorkTotals,
} from '#/lib/workTimeline'
import { listActors } from './actors'
import { HttpError, notFound } from './http'
import { kindOf, listStages, type Stage } from './stages'

/**
 * A ticket's work timeline: what its agents record as they work it (a span of a phase, a hand-off to
 * another agent, a wait and why, a heartbeat; MCP tools and `POST /api/projects/:id/tickets/:ticketId/events`)
 * and what the board sees itself (`noteBoardEvent`: a push to its branch, its PR set or merged, its
 * preview's state, a move between stages). From these come the stalled flag and the working / waiting /
 * blocked-on-human totals (src/lib/workTimeline.ts), worked out when they are read.
 *
 * Writes are quiet: no activity row and no `updatedAt` bump, so heartbeats neither flood the Daily view
 * nor reorder the board. Every event takes the server's time.
 */

export type TicketEvent = schema.TicketEvent

/** Who did the work and what about it; `agent` defaults to the caller. */
export type EventBase = { agent?: string; note?: string }

/** The ticket an event is for, checked against the project the caller named. */
function scopedTicket(projectId: number, ticketId: number) {
  const project = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()
  if (!project) throw notFound('project')
  const t = db.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId)).get()
  if (!t) throw notFound('ticket')
  if (t.projectId !== projectId) throw new HttpError(403, `#${ticketId} is not a ticket of this project`)
  if (t.archivedAt) throw new HttpError(409, `#${ticketId} is archived`)
  return t
}

const clean = (s: string | undefined) => s?.trim() ?? ''

function insert(
  t: Pick<schema.Ticket, 'id' | 'projectId'>,
  actor: string,
  values: Omit<typeof schema.ticketEvents.$inferInsert, 'ticketId' | 'projectId' | 'by' | 'agent'> & {
    agent?: string
  },
) {
  return db
    .insert(schema.ticketEvents)
    .values({
      ...values,
      agent: clean(values.agent) || actor,
      ticketId: t.id,
      projectId: t.projectId,
      by: actor,
    })
    .returning()
    .get()
}

/** A known phase in its stored casing (`Build` is `build`); any other phase as given, trimmed. */
function phaseName(phase: string) {
  const p = phase.trim()
  return (KNOWN_PHASES as readonly string[]).includes(p.toLowerCase()) ? p.toLowerCase() : p
}

export function startSpan(
  projectId: number,
  ticketId: number,
  input: EventBase & { phase: string; round?: number | null },
  actor: string,
) {
  const t = scopedTicket(projectId, ticketId)
  const phase = phaseName(input.phase)
  if (!phase) throw new HttpError(400, 'phase is required')
  const event = insert(t, actor, {
    kind: 'span_start',
    agent: input.agent,
    phase,
    round: input.round ?? null,
    note: clean(input.note),
  })
  return { spanId: event.id, event }
}

/**
 * The start an end closes: `id` when given (it must be one of this ticket's and still open), else the
 * latest open start of `kind` on the ticket by that agent (of that phase, for a span).
 */
function openStart(
  ticketId: number,
  kind: 'span_start' | 'wait_start',
  opts: { id?: number; agent: string; phase?: string },
) {
  const what = kind === 'span_start' ? 'span' : 'wait'
  const endKind = kind === 'span_start' ? 'span_end' : 'wait_end'
  const ended = (id: number) =>
    !!db
      .select({ id: schema.ticketEvents.id })
      .from(schema.ticketEvents)
      .where(
        and(
          eq(schema.ticketEvents.ticketId, ticketId),
          eq(schema.ticketEvents.kind, endKind),
          eq(schema.ticketEvents.refId, id),
        ),
      )
      .get()
  if (opts.id !== undefined) {
    const start = db
      .select()
      .from(schema.ticketEvents)
      .where(
        and(
          eq(schema.ticketEvents.id, opts.id),
          eq(schema.ticketEvents.ticketId, ticketId),
          eq(schema.ticketEvents.kind, kind),
        ),
      )
      .get()
    if (!start) throw new HttpError(409, `no open ${what} ${opts.id} on #${ticketId}`)
    if (ended(start.id)) throw new HttpError(409, `${what} ${opts.id} on #${ticketId} has already ended`)
    return start
  }
  const phase = opts.phase ? phaseName(opts.phase) : ''
  const candidates = db
    .select()
    .from(schema.ticketEvents)
    .where(
      and(
        eq(schema.ticketEvents.ticketId, ticketId),
        eq(schema.ticketEvents.kind, kind),
        eq(schema.ticketEvents.agent, opts.agent),
        phase ? eq(schema.ticketEvents.phase, phase) : undefined,
      ),
    )
    .orderBy(desc(schema.ticketEvents.at), desc(schema.ticketEvents.id))
    .all()
  const open = candidates.find((c) => !ended(c.id))
  if (!open)
    throw new HttpError(
      409,
      `no open ${what} on #${ticketId} by ${opts.agent}${phase ? ` of phase ${phase}` : ''}`,
    )
  return open
}

const duration = (start: TicketEvent, end: TicketEvent) => ({
  start: start.at,
  end: end.at,
  durationMs: Math.max(0, Date.parse(end.at) - Date.parse(start.at)),
})

export function endSpan(
  projectId: number,
  ticketId: number,
  input: EventBase & { spanId?: number; phase?: string },
  actor: string,
) {
  const t = scopedTicket(projectId, ticketId)
  const agent = clean(input.agent) || actor
  const start = openStart(t.id, 'span_start', { id: input.spanId, agent, phase: input.phase })
  const event = insert(t, actor, {
    kind: 'span_end',
    agent,
    phase: start.phase,
    round: start.round,
    refId: start.id,
    note: clean(input.note),
  })
  return { event, span: { id: start.id, phase: start.phase, round: start.round, ...duration(start, event) } }
}

export function handoff(
  projectId: number,
  ticketId: number,
  input: EventBase & { from?: string; to: string },
  actor: string,
) {
  const t = scopedTicket(projectId, ticketId)
  const agent = clean(input.agent) || actor
  const to = clean(input.to)
  if (!to) throw new HttpError(400, 'to is required: the agent the work goes to')
  const event = insert(t, actor, {
    kind: 'handoff',
    agent,
    fromAgent: clean(input.from) || agent,
    toAgent: to,
    note: clean(input.note),
  })
  return { event }
}

/**
 * A wait on the ticket. `on` names the agent the work was handed to (a delegated wait: the time counts as
 * working); left out, the wait reads as it always did.
 */
export function startWait(
  projectId: number,
  ticketId: number,
  input: EventBase & { reason: WaitReason; on?: string },
  actor: string,
) {
  const t = scopedTicket(projectId, ticketId)
  const event = insert(t, actor, {
    kind: 'wait_start',
    agent: input.agent,
    reason: input.reason,
    on: clean(input.on) || null,
    note: clean(input.note),
  })
  return { waitId: event.id, event }
}

export function endWait(
  projectId: number,
  ticketId: number,
  input: EventBase & { waitId?: number },
  actor: string,
) {
  const t = scopedTicket(projectId, ticketId)
  const agent = clean(input.agent) || actor
  const start = openStart(t.id, 'wait_start', { id: input.waitId, agent })
  const event = insert(t, actor, {
    kind: 'wait_end',
    agent,
    reason: start.reason,
    refId: start.id,
    note: clean(input.note),
  })
  return { event, wait: { id: start.id, reason: start.reason, ...duration(start, event) } }
}

export function heartbeat(projectId: number, ticketId: number, input: EventBase, actor: string) {
  const t = scopedTicket(projectId, ticketId)
  const event = insert(t, actor, { kind: 'heartbeat', agent: input.agent, note: clean(input.note) })
  const lastSignalAt = [t.createdAt, t.startedAt, event.at]
    .filter((x): x is string => !!x)
    .reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a))
  const leaseUntil = new Date(Date.parse(event.at) + LEASE_TTL_MINUTES * 60_000).toISOString()
  return { at: event.at, lastSignalAt, leaseUntil }
}

// --- what the board sees itself ---

/**
 * Record an event the board saw on a ticket (agent and by `board`). It never fails its caller: a push,
 * a merge or a stage move goes through whether or not its event could be written.
 */
export function noteBoardEvent(
  ticketId: number,
  kind: BoardEventKind,
  fields: { note?: string; fromStage?: string; toStage?: string } = {},
) {
  try {
    const t = db
      .select({ id: schema.tickets.id, projectId: schema.tickets.projectId })
      .from(schema.tickets)
      .where(eq(schema.tickets.id, ticketId))
      .get()
    if (!t) return
    insert(t, 'board', {
      kind,
      note: (fields.note ?? '').slice(0, 500),
      fromStage: fields.fromStage ?? '',
      toStage: fields.toStage ?? '',
    })
  } catch (err) {
    console.error(`could not record the ${kind} event of ticket ${ticketId}:`, err)
  }
}

/** A ticket's move between stages (`from` null: it was created), when it moved at all. */
export function noteStageMove(ticketId: number, from: string | null, to: string) {
  if (from === to) return
  noteBoardEvent(ticketId, 'stage', { fromStage: from ?? '', toStage: to })
}

// --- reads ---

type TimelineTicket = Pick<
  schema.Ticket,
  'id' | 'projectId' | 'status' | 'archivedAt' | 'prId' | 'assignee' | 'createdAt' | 'startedAt' | 'parentId'
>

const asTimelineEvent = ({ ticketId: _t, projectId: _p, ...e }: TicketEvent): TimelineEvent => e

/**
 * Each ticket's timeline, from one read of their events, posts, decisions and tasks; the tickets may be
 * of several projects. An agent's post refreshes the lease a heartbeat does; a human's does not. A
 * pending decision card, or a blocked task that is the step the ticket (or one of its lanes) works next,
 * makes it wait on the human.
 */
export function timelinesFor(
  tickets: TimelineTicket[],
  now: Date = new Date(),
): Map<number, { events: TicketEvent[]; timeline: WorkTimeline }> {
  const ids = tickets.map((t) => t.id)
  const rows = ids.length
    ? db.select().from(schema.ticketEvents).where(inArray(schema.ticketEvents.ticketId, ids)).all()
    : []
  const byTicket = new Map<number, TicketEvent[]>()
  for (const r of rows) byTicket.set(r.ticketId, [...(byTicket.get(r.ticketId) ?? []), r])
  // Posts: an agent's (or the board's own) refresh the lease; a human's do not.
  const humans = new Set(listActors().flatMap((a) => (a.kind === 'human' ? [a.name] : [])))
  const posts = new Map<number, TimelinePost[]>()
  const postRows = ids.length
    ? db
        .select({
          ticketId: schema.updates.ticketId,
          author: schema.updates.author,
          createdAt: schema.updates.createdAt,
        })
        .from(schema.updates)
        .where(inArray(schema.updates.ticketId, ids))
        .all()
    : []
  for (const p of postRows)
    posts.set(p.ticketId, [
      ...(posts.get(p.ticketId) ?? []),
      { at: p.createdAt, agent: p.author, human: humans.has(p.author) },
    ])
  const deciding = new Set(
    ids.length
      ? db
          .select({ ticketId: schema.updates.ticketId })
          .from(schema.updates)
          .where(
            and(
              inArray(schema.updates.ticketId, ids),
              isNotNull(schema.updates.decision),
              isNull(schema.updates.decidedAt),
            ),
          )
          .all()
          .map((r) => r.ticketId)
      : [],
  )
  const projects = new Map<number, { stages: Stage[]; stallMinutes: number }>()
  const projectOf = (id: number) => {
    let p = projects.get(id)
    if (!p) {
      const row = db
        .select({ stallMinutes: schema.projects.stallMinutes })
        .from(schema.projects)
        .where(eq(schema.projects.id, id))
        .get()
      p = { stages: listStages(id), stallMinutes: row?.stallMinutes ?? 30 }
      projects.set(id, p)
    }
    return p
  }
  // Whether the step a ticket works next is blocked on the human: its own next step's, and a lane's own
  // next step rolled up into its parent, as the card's badge and Needs you count them. A lane reads its
  // own tree alone: its parent's blocked step is not the lane's, so a lane's row and its page agree.
  const lanes = new Map<number, { id: number; status: string; projectId: number }[]>()
  const family = new Set(ids)
  // Every child is registered in its parent's `lanes` once, whether or not the read already loaded it as
  // a row: a lane that is itself a row still rolls its next step up into its parent. The sets only decide
  // what to expand next, never what to register.
  const registered = new Set<number>()
  const expanded = new Set<number>()
  let level = [...ids]
  while (level.length) {
    const parents = level.filter((id) => !expanded.has(id))
    if (!parents.length) break
    for (const id of parents) expanded.add(id)
    const children = db
      .select({
        id: schema.tickets.id,
        parentId: schema.tickets.parentId,
        status: schema.tickets.status,
        projectId: schema.tickets.projectId,
      })
      .from(schema.tickets)
      .where(inArray(schema.tickets.parentId, parents))
      .all()
    level = []
    for (const lane of children) {
      family.add(lane.id)
      if (!registered.has(lane.id)) {
        registered.add(lane.id)
        lanes.set(lane.parentId!, [...(lanes.get(lane.parentId!) ?? []), lane])
      }
      if (!expanded.has(lane.id)) level.push(lane.id)
    }
  }
  const ownTasks = new Map<number, (typeof schema.tasks.$inferSelect)[]>()
  if (family.size)
    for (const task of db
      .select()
      .from(schema.tasks)
      .where(inArray(schema.tasks.ticketId, [...family]))
      .all())
      ownTasks.set(task.ticketId, [...(ownTasks.get(task.ticketId) ?? []), task])
  const nextBlocked = new Map(
    [...family].map((id) => [id, nextTask(ownTasks.get(id) ?? [])?.blocked === true]),
  )
  // A cancelled or done lane's tasks are out of the work, as they are out of the rolled-up progress.
  const closedLane = (lane: { status: string; projectId: number }) => {
    const kind = kindOf(projectOf(lane.projectId).stages, lane.status)
    return kind === 'cancelled' || kind === 'done'
  }
  const blockedNext = (id: number): boolean =>
    nextBlocked.get(id) === true ||
    (lanes.get(id) ?? []).some((lane) => !closedLane(lane) && blockedNext(lane.id))
  // The latest progress post on a ticket or any of its lanes: what a parent's day-long quiet counts from.
  const progressPosts = family.size
    ? db
        .select({ ticketId: schema.updates.ticketId, createdAt: schema.updates.createdAt })
        .from(schema.updates)
        .where(and(inArray(schema.updates.ticketId, [...family]), eq(schema.updates.progress, true)))
        .all()
    : []
  const progressOf = new Map<number, string>()
  for (const p of progressPosts) {
    const seen = progressOf.get(p.ticketId)
    if (!seen || Date.parse(p.createdAt) > Date.parse(seen)) progressOf.set(p.ticketId, p.createdAt)
  }
  const familyProgress = new Map<number, string | null>()
  const progressAt = (id: number): string | null => {
    if (familyProgress.has(id)) return familyProgress.get(id)!
    let at = progressOf.get(id) ?? null
    for (const lane of lanes.get(id) ?? []) {
      const child = progressAt(lane.id)
      if (child && (!at || Date.parse(child) > Date.parse(at))) at = child
    }
    familyProgress.set(id, at)
    return at
  }
  return new Map(
    tickets.map((t) => {
      const events = byTicket.get(t.id) ?? []
      const { stages, stallMinutes } = projectOf(t.projectId)
      const timeline = buildTimeline(events.map(asTimelineEvent), {
        now,
        stages,
        ticket: t,
        stallMinutes,
        posts: posts.get(t.id) ?? [],
        waiting: { decision: deciding.has(t.id), blockedTask: blockedNext(t.id) },
        progressAt: progressAt(t.id),
      })
      return [t.id, { events, timeline }] as const
    }),
  )
}

/** One ticket's events, newest first (every kind), and its timeline. */
export function ticketTimeline(ticketId: number, now: Date = new Date()) {
  const t = db.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId)).get()
  if (!t) throw notFound('ticket')
  const { events, timeline } = timelinesFor([t], now).get(t.id)!
  const newest = [...events].sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id)
  return { events: newest, timeline }
}

/** What `get_ticket` carries: the totals, the state, who was last heard from, and the open spans and waits. */
export function workOf(timeline: WorkTimeline) {
  return {
    totals: timeline.totals,
    liveness: timeline.liveness,
    stalled: timeline.stalled,
    lastSignalAt: timeline.lastSignalAt,
    lastWordAt: timeline.lastWordAt,
    lastHeard: timeline.lastHeard,
    stage: timeline.stage,
    progressAt: timeline.progressAt,
    waitingOnHuman: timeline.waitingOnHuman,
    open: {
      spans: timeline.spans.filter((s) => s.open),
      waits: timeline.waits.filter((w) => w.open),
    },
  }
}

export type ProjectWork = {
  /** The server's time when it was read: the browser's clock is corrected by it (see useServerOffset). */
  now: string
  stallMinutes: number
  totals: WorkTotals
  tickets: {
    id: number
    totals: WorkTotals
    liveness: WorkTimeline['liveness']
    stalled: WorkTimeline['stalled']
    stage: WorkTimeline['stage']
    progressAt: WorkTimeline['progressAt']
    waitingOnHuman: WorkTimeline['waitingOnHuman']
  }[]
}

/**
 * The project's totals: every ticket and lane added up, archived tickets and PR tickets left out; with
 * each one's totals, state and stalled flag.
 */
export function projectWork(projectId: number, now: Date = new Date()): ProjectWork {
  const project = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()
  if (!project) throw notFound('project')
  const tickets = db
    .select()
    .from(schema.tickets)
    .where(
      and(
        eq(schema.tickets.projectId, projectId),
        isNull(schema.tickets.archivedAt),
        isNull(schema.tickets.prId),
      ),
    )
    .all()
  const all = timelinesFor(tickets, now)
  const rows = tickets.map((t) => {
    const { timeline } = all.get(t.id)!
    return {
      id: t.id,
      totals: timeline.totals,
      liveness: timeline.liveness,
      stalled: timeline.stalled,
      stage: timeline.stage,
      progressAt: timeline.progressAt,
      waitingOnHuman: timeline.waitingOnHuman,
    }
  })
  return {
    now: now.toISOString(),
    stallMinutes: project.stallMinutes,
    totals: sumTotals(rows.map((r) => r.totals)),
    tickets: rows,
  }
}

// --- what the MCP tools and REST take ---

const Name = z.string().trim().min(1).max(60)
const Phase = z.string().trim().min(1).max(60)
/** The agent a wait hands the work to: a name, like `agent`. */
const On = Name
/** Every event's own fields: who did the work (a sub-agent's name too; the caller when left out) and a note. */
export const eventBase = {
  agent: Name.optional(),
  note: z.string().max(500).optional(),
}
/** Each agent kind's fields, as the tool of that name and the REST body of that kind take them. */
export const eventFields = {
  span_start: { phase: Phase, round: z.number().int().min(1).max(20).optional() },
  span_end: { spanId: z.number().int().optional(), phase: Phase.optional() },
  handoff: { from: Name.optional(), to: Name },
  wait_start: { reason: z.enum(WAIT_REASONS), on: On.optional() },
  wait_end: { waitId: z.number().int().optional() },
  heartbeat: {},
} as const satisfies Record<AgentEventKind, z.ZodRawShape>

/** `POST /api/projects/:id/tickets/:ticketId/events`: one agent event, by its kind; a board kind is refused. */
export const EventBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('span_start'), ...eventBase, ...eventFields.span_start }),
  z.object({ kind: z.literal('span_end'), ...eventBase, ...eventFields.span_end }),
  z.object({ kind: z.literal('handoff'), ...eventBase, ...eventFields.handoff }),
  z.object({ kind: z.literal('wait_start'), ...eventBase, ...eventFields.wait_start }),
  z.object({ kind: z.literal('wait_end'), ...eventBase, ...eventFields.wait_end }),
  z.object({ kind: z.literal('heartbeat'), ...eventBase }),
])

/** Record one agent event; answers as its tool does. */
export function recordEvent(
  projectId: number,
  ticketId: number,
  body: z.infer<typeof EventBody>,
  actor: string,
) {
  switch (body.kind) {
    case 'span_start':
      return startSpan(projectId, ticketId, body, actor)
    case 'span_end':
      return endSpan(projectId, ticketId, body, actor)
    case 'handoff':
      return handoff(projectId, ticketId, body, actor)
    case 'wait_start':
      return startWait(projectId, ticketId, body, actor)
    case 'wait_end':
      return endWait(projectId, ticketId, body, actor)
    case 'heartbeat':
      return heartbeat(projectId, ticketId, body, actor)
  }
}
