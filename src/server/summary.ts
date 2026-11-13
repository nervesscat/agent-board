import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, max, ne } from 'drizzle-orm'

import { db, schema } from '#/db'
import type { StageKind } from '#/lib/constants'
import { mergeLayout, shownIn } from '#/lib/layout'
import { askingHuman } from '#/lib/needsYou'
import { stageColumn } from '#/lib/stages'
import { activityOf } from '#/lib/workTimeline'
import { dayBounds } from './activity'
import { listActors } from './actors'
import { today } from './daily'
import { gist, listHumanThreads, listTickets, nextTask } from './features'
import { pendingInstructionChanges } from './instructionsHistory'
import { getProject } from './projects'
import { refreshPrsInBackground } from './prs'
import { listAgents } from './projectAgents'
import { listRepos } from './repos'
import { reportDueFor } from './reportDue'
import { listStages, type Stage } from './stages'
import { timelinesFor } from './workTimeline'

/**
 * The one-glance picture of a project (or of every project): what waits on the human, what is in
 * progress, what got done today, what is next, and what carries over from before today. Read by the
 * Home and Overview pages and by agents starting a session (`get_summary`).
 */

const DAY_MS = 86_400_000
/** In progress with no progress post for this long reads as stalled. */
const STALE_MS = DAY_MS

/** Worked on, waiting on the human, or handed off: a ticket in any of these is in progress. */
const IN_PROGRESS: StageKind[] = ['active', 'blocked', 'review']
const inProgress = (kind: StageKind | undefined) => !!kind && IN_PROGRESS.includes(kind)

/** A stage that parks work for later instead of lining it up next (Backlog, Icebox, Someday…). */
const BACKLOG = /backlog|icebox|someday|later|parking/i
export const isBacklog = (s: Pick<Stage, 'key' | 'name'>) => BACKLOG.test(s.key) || BACKLOG.test(s.name)

/** A ticket as `listTickets` reads it. */
type Row = ReturnType<typeof listTickets>[number]

/** A ticket that was already in progress before today. */
export interface CarryOver {
  id: number
  title: string
  status: string
  kind: StageKind
  assignee: string
  since: string
  /** Calendar days since it started. */
  days: number
  lastPost: Post | null
  stale: boolean
}

export interface SummaryOptions {
  /** The names the human signs in under; every human the board has seen when left out. */
  humans?: string[]
  /** The moment the summary is taken; now unless a test pins it. */
  now?: Date
  /** Refresh stale PR queues from GitHub in the background (the next read sees them). */
  refreshPrs?: boolean
}

export type Post = { ticketId: number; author: string; text: string; createdAt: string }

/** One project's summary, or every project's (one block each, by name). */
export function getSummary(projectId: number | undefined, opts: SummaryOptions = {}) {
  const now = opts.now ?? new Date()
  const date = today(now)
  const humans = opts.humans ?? listActors().flatMap((a) => (a.kind === 'human' ? [a.name] : []))
  const projects = projectId
    ? [getProject(projectId)]
    : db.select().from(schema.projects).orderBy(asc(schema.projects.name)).all()
  if (opts.refreshPrs) for (const p of projects) refreshPrsInBackground(p.id)
  return {
    date,
    generatedAt: now.toISOString(),
    projects: projects.map((p) => projectSummary(p, { now, date, humans })),
  }
}

export type Summary = ReturnType<typeof getSummary>
export type ProjectSummary = Summary['projects'][number]

function projectSummary(project: schema.Project, ctx: { now: Date; date: string; humans: string[] }) {
  const { now, date, humans } = ctx
  const { from, to } = dayBounds(date)
  const stages = listStages(project.id)
  const stageByKey = new Map(stages.map((s) => [s.key, s]))
  const kind = (status: string) => stageByKey.get(status)?.kind
  // Archived tickets are left out here, lanes of archived tickets with them.
  const tickets = listTickets(project.id)
  const byId = new Map(tickets.map((t) => [t.id, t]))
  const ids = tickets.map((t) => t.id)
  const top = tickets.filter((t) => t.parentId === null)
  const children = new Map<number, Row[]>()
  for (const t of tickets) if (t.parentId) children.set(t.parentId, [...(children.get(t.parentId) ?? []), t])
  const below = (id: number): number[] =>
    (children.get(id) ?? []).flatMap((lane) => [lane.id, ...below(lane.id)])
  const parentOf = (t: Row) => {
    const p = t.parentId ? byId.get(t.parentId) : undefined
    return p ? { id: p.id, title: p.title } : null
  }
  const parse = moveParser(stages)

  // --- needs you ---
  // A PR's own ticket is not in the lists above: its decisions and threads show here as PR rows (`prTicket`).
  const prTicketRows = db
    .select()
    .from(schema.tickets)
    .where(
      and(
        eq(schema.tickets.projectId, project.id),
        isNotNull(schema.tickets.prId),
        isNull(schema.tickets.archivedAt),
      ),
    )
    .all()
  const prTicketById = new Map(prTicketRows.map((t) => [t.id, t]))
  /** A ticket's stage kind, a PR's own ticket included: what decides whether its entries ask the human. */
  const kindOfTicket = (ticketId: number): StageKind | undefined => {
    const t = byId.get(ticketId) ?? prTicketById.get(ticketId)
    return t ? kind(t.status) : undefined
  }
  const deciding = [...ids, ...prTicketRows.map((t) => t.id)]
  const decisions = deciding.length
    ? askingHuman(
        db
          .select({
            id: schema.updates.id,
            ticketId: schema.updates.ticketId,
            author: schema.updates.author,
            body: schema.updates.body,
            decision: schema.updates.decision,
            archiveTickets: schema.updates.archiveTickets,
            createdAt: schema.updates.createdAt,
          })
          .from(schema.updates)
          .where(
            and(
              inArray(schema.updates.ticketId, deciding),
              isNotNull(schema.updates.decision),
              isNull(schema.updates.decidedAt),
            ),
          )
          .orderBy(desc(schema.updates.createdAt))
          .all(),
        kindOfTicket,
        // An archive request is only ever asked on a finished ticket: it must stay answerable.
        (d) => !!d.archiveTickets,
      ).map((d) => ({
        postId: d.id,
        ticketId: d.ticketId,
        ticketTitle: (byId.get(d.ticketId) ?? prTicketById.get(d.ticketId))?.title ?? '',
        prTicket: prTicketById.has(d.ticketId),
        question: gist(d.body),
        options: d.decision?.length ?? 0,
        author: d.author,
        createdAt: d.createdAt,
      }))
    : []
  const repos = listRepos(project.id)
  const repoName = (id: number | null) => repos.find((r) => r.id === id)?.name ?? null
  // Someone else's open PRs the human has not approved and has no comments waiting on.
  const prsToReview = db
    .select()
    .from(schema.prs)
    .where(
      and(
        eq(schema.prs.projectId, project.id),
        eq(schema.prs.open, true),
        eq(schema.prs.waitingOn, 'me'),
        eq(schema.prs.reviewStage, 'pending'),
        eq(schema.prs.hold, false),
      ),
    )
    .orderBy(desc(schema.prs.updatedAt))
    .all()
    .map((p) => ({
      id: p.id,
      number: p.number,
      title: p.title,
      url: p.url,
      repo: repos.length > 1 ? repoName(p.repoId) : null,
      author: p.author,
      isDraft: p.isDraft,
      updatedAt: p.updatedAt,
    }))
  const threads = humans.length
    ? askingHuman(
        listHumanThreads(project.id, humans).filter(
          (th) => th.ticketId === null || byId.has(th.ticketId) || prTicketById.has(th.ticketId),
        ),
        kindOfTicket,
      ).map(({ as: _as, ...th }) => ({
        ...th,
        prTicket: th.ticketId !== null && prTicketById.has(th.ticketId),
      }))
    : []
  // Tasks and subtasks tagged blocked on the human, on work still going: not on a done or cancelled
  // ticket, nor under one (a cancelled lane's tasks are out of the work, as in the rollup).
  const closed = (t: Row | undefined): boolean =>
    !!t &&
    (kind(t.status) === 'done' ||
      kind(t.status) === 'cancelled' ||
      closed(t.parentId ? byId.get(t.parentId) : undefined))
  const live = tickets.filter((t) => t.blockedTasks > 0 && !closed(t)).map((t) => t.id)
  const taskRows = live.length
    ? db
        .select()
        .from(schema.tasks)
        .where(inArray(schema.tasks.ticketId, live))
        .orderBy(asc(schema.tasks.position), asc(schema.tasks.id))
        .all()
    : []
  const taskText = new Map(taskRows.map((task) => [task.id, task.text]))
  // Only the step a ticket (or lane) works next — its first open task with no open subtask — is one
  // a blocked tag really stops. A blocked step further down stays counted on the ticket, not surfaced.
  const ownTasks = new Map<number, typeof taskRows>()
  for (const task of taskRows) ownTasks.set(task.ticketId, [...(ownTasks.get(task.ticketId) ?? []), task])
  const nextId = new Map([...ownTasks].map(([id, own]) => [id, nextTask(own)?.id ?? null]))
  const order = new Map(live.map((id, i) => [id, i]))
  const blockedTasks = askingHuman(
    taskRows
      .filter((task) => task.blocked && !task.done && nextId.get(task.ticketId) === task.id)
      .sort((a, b) => order.get(a.ticketId)! - order.get(b.ticketId)!)
      .map((task) => {
        const t = byId.get(task.ticketId)!
        return {
          taskId: task.id,
          text: task.text,
          reason: task.blockedReason,
          // The task it is a step of, when it is a subtask.
          parentTask: task.parentId ? (taskText.get(task.parentId) ?? null) : null,
          ticketId: t.id,
          ticketTitle: t.title,
          status: t.status,
          // The ticket it is a lane of.
          parent: parentOf(t),
        }
      }),
    kindOfTicket,
  )
  // Active tickets and lanes nobody was heard from on for longer than the project allows (the work timeline).
  const timelines = timelinesFor(tickets, now)
  const stalled = tickets
    .flatMap((t) => {
      const s = timelines.get(t.id)!.timeline.stalled
      return s
        ? [
            {
              ticketId: t.id,
              title: t.title,
              status: t.status,
              assignee: t.assignee,
              parent: parentOf(t),
              lastSignalAt: s.since,
              lastAgent: s.lastAgent,
              lastBy: s.lastBy,
              lastFrom: s.lastFrom,
              // The open spans and waits and the last heard, so the stall says why (the same read as `stalled`).
              activity: activityOf(timelines.get(t.id)!.timeline),
            },
          ]
        : []
    })
    .sort((a, b) => Date.parse(a.lastSignalAt) - Date.parse(b.lastSignalAt))
  const reviews = tickets
    .filter((t) => kind(t.status) === 'review' && !t.approvedAt)
    .map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      parent: parentOf(t),
      assignee: t.assignee,
      prNumber: t.prNumber,
      updatedAt: t.updatedAt,
    }))
  // Open waits on the human on work still going. A ticket already asking with an open decision card
  // is listed once, as that card.
  const decided = new Set(decisions.map((d) => d.ticketId))
  const humanWaits = tickets
    .filter((t) => kind(t.status) === 'active' && !closed(t) && !decided.has(t.id))
    .flatMap((t) =>
      timelines
        .get(t.id)!
        .timeline.waits.filter((w) => w.open && w.reason === 'human')
        .map((w) => ({
          waitId: w.id,
          ticketId: t.id,
          ticketTitle: t.title,
          status: t.status,
          assignee: t.assignee,
          parent: parentOf(t),
          agent: w.agent,
          note: w.note,
          since: w.start,
        })),
    )
    .sort((a, b) => Date.parse(a.since) - Date.parse(b.since))

  // --- in progress: since when and the last progress post, for every ticket in progress ---
  const working = top.filter((t) => inProgress(kind(t.status)))
  // When the work started is on the ticket; only tickets that predate that are read from the log.
  const unstarted = working.filter((t) => !t.startedAt).map((t) => t.id)
  const events = unstarted.length
    ? db
        .select()
        .from(schema.activity)
        .where(
          and(
            eq(schema.activity.refType, 'ticket'),
            eq(schema.activity.kind, 'ticket'),
            inArray(schema.activity.refId, unstarted),
          ),
        )
        .orderBy(asc(schema.activity.createdAt), asc(schema.activity.id))
        .all()
    : []
  const scope = new Map(working.map((t) => [t.id, [t.id, ...below(t.id)]]))
  const lastPosts = lastProgressPosts([...scope.values()].flat())
  const lastPost = (id: number): Post | null =>
    (scope.get(id) ?? [])
      .map((x) => lastPosts.get(x))
      .filter((p) => p !== undefined)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
  const previews = previewsOf([...scope.values()].flat())
  const preview = (id: number) =>
    (scope.get(id) ?? []).map((x) => previews.get(x)).find((p) => p !== undefined) ?? null
  const rank = (status: string) => {
    const i = stages.findIndex((s) => s.key === status)
    return i < 0 ? stages.length : i
  }
  const startOfToday = new Date(`${date}T00:00:00`).getTime()
  const progress = working
    .map((t) => {
      const since =
        t.startedAt ??
        progressSince(
          t,
          events.filter((e) => e.refId === t.id),
          parse,
        )
      const post = lastPost(t.id)
      return {
        id: t.id,
        title: t.title,
        status: t.status,
        kind: kind(t.status)!,
        assignee: t.assignee,
        reserved: t.reserved,
        decisions: t.decisions,
        blockedTasks: t.blockedTasks,
        blockedNext: t.blockedNext,
        rollup: t.rollup,
        lanes: t.lanes.total,
        lastPost: post,
        preview: preview(t.id),
        since,
        // Calendar days since it started, 0 when it started today.
        days: Math.round((startOfToday - new Date(`${today(new Date(since))}T00:00:00`).getTime()) / DAY_MS),
        // Handed off for review, it waits on the human rather than on its own posts.
        // Active and silent past the project's threshold (the work timeline's rule).
        stalled: !!timelines.get(t.id)!.timeline.stalled,
        // The open spans and waits, and who was last heard from (the same read as `stalled`).
        activity: activityOf(timelines.get(t.id)!.timeline),
        stale:
          kind(t.status) !== 'review' &&
          now.getTime() - new Date(post?.createdAt ?? since).getTime() > STALE_MS,
        updatedAt: t.updatedAt,
      }
    })
    .sort((a, b) => rank(a.status) - rank(b.status) || b.updatedAt.localeCompare(a.updatedAt))

  // --- done today ---
  const todays = db
    .select()
    .from(schema.activity)
    .where(
      and(
        eq(schema.activity.projectId, project.id),
        eq(schema.activity.refType, 'ticket'),
        eq(schema.activity.kind, 'ticket'),
        gte(schema.activity.createdAt, from),
        lt(schema.activity.createdAt, to),
      ),
    )
    .orderBy(asc(schema.activity.createdAt), asc(schema.activity.id))
    .all()
  const doneAt = new Map<number, string>()
  for (const e of todays) {
    const t = e.refId === null ? undefined : byId.get(e.refId)
    if (t && kind(t.status) === 'done' && parse(e.text)?.to.kind === 'done') doneAt.set(t.id, e.createdAt)
  }
  const doneTickets = [...doneAt]
    .map(([id, at]) => {
      const t = byId.get(id)!
      return { id, title: t.title, status: t.status, parent: parentOf(t), assignee: t.assignee, doneAt: at }
    })
    .sort((a, b) => b.doneAt.localeCompare(a.doneAt))
  // A PR leaves the open queue when it is merged or closed, once: fetching it merged again on a later
  // day does not move when it left.
  const closedPrs = db
    .select()
    .from(schema.prs)
    .where(
      and(
        eq(schema.prs.projectId, project.id),
        eq(schema.prs.open, false),
        gte(schema.prs.closedAt, from),
        lt(schema.prs.closedAt, to),
      ),
    )
    .orderBy(desc(schema.prs.closedAt))
    .all()
    .map((p) => ({
      id: p.id,
      number: p.number,
      title: p.title,
      url: p.url,
      repo: repos.length > 1 ? repoName(p.repoId) : null,
      closedAt: p.closedAt!,
      tickets: tickets
        .filter(
          (t) =>
            (t.repoId ?? repos[0]?.id) === p.repoId &&
            (t.prNumber === p.number || (t.prNumber === null && !!t.branch && t.branch === p.headRef)),
        )
        .map((t) => ({ id: t.id, title: t.title })),
    }))
  const activity =
    db
      .select({ n: count() })
      .from(schema.activity)
      .where(
        and(
          eq(schema.activity.projectId, project.id),
          gte(schema.activity.createdAt, from),
          lt(schema.activity.createdAt, to),
        ),
      )
      .get()?.n ?? 0

  // Orchestrators' changes of the project's instructions, applied and waiting on the human's review.
  const instructionChanges = pendingInstructionChanges(project.id).map((c) => ({
    changeId: c.id,
    projectId: c.projectId,
    changedBy: c.changedBy,
    role: c.role,
    createdAt: c.createdAt,
    excerpt: excerpt(c.newValue),
    revertable: c.revertable,
  }))

  // --- next: the head of the first open column that lines work up (not a backlog) ---
  const open = stages.filter((s) => s.kind === 'open')
  const nextStage = open.find((s) => !isBacklog(s)) ?? open.at(-1) ?? null
  const column = nextStage ? stageColumn(top, nextStage.key) : []

  return {
    // `overview`: the cards its Overview shows, in order (the project's layout), for Home too.
    project: {
      id: project.id,
      name: project.name,
      overview: shownIn(mergeLayout(project.layout), 'overview'),
    },
    stages: stages.map(({ key, name, kind, color }) => ({ key, name, kind, color })),
    agents: listAgents(project.id).map((a) => ({ name: a.name, avatarUrl: a.avatarUrl })),
    needsYou: {
      decisions,
      humanWaits,
      prs: prsToReview,
      threads,
      reviews,
      blockedTasks,
      instructionChanges,
      stalled,
      total:
        decisions.length +
        humanWaits.length +
        prsToReview.length +
        threads.length +
        reviews.length +
        blockedTasks.length +
        instructionChanges.length +
        stalled.length,
    },
    inProgress: progress.filter((t) => t.kind !== 'review'),
    doneToday: { tickets: doneTickets, prs: closedPrs, activity },
    next: {
      stage: nextStage ? { key: nextStage.key, name: nextStage.name } : null,
      tickets: column.slice(0, 5).map((t) => ({
        id: t.id,
        title: t.title,
        assignee: t.assignee,
        reserved: t.reserved,
        tags: t.tags,
        rollup: t.rollup,
        updatedAt: t.updatedAt,
      })),
      total: column.length,
      blocked: top.filter((t) => kind(t.status) === 'blocked').length,
      backlog: top.filter((t) => kind(t.status) === 'open' && t.status !== nextStage?.key).length,
    },
    carryingOver: progress.filter((t) => new Date(t.since).getTime() < startOfToday),
    // The project's report, while the board is reminding about it (due soon, or missing): null otherwise.
    reportDue: reportDueFor(project.id, now),
  }
}

/** Markdown as one line of plain text: line markers, emphasis and link targets dropped, cut to `max`. */
export function excerpt(body: string, max = 200) {
  const text = body
    .split('\n')
    .map((l) =>
      l
        .replace(/^\s*(?:#+|[-*+>]|\d+\.)\s+/, '')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\*\*|__|`/g, '')
        .trim(),
    )
    .filter(Boolean)
    .join(' ')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

type Move = { from: Stage | null; to: Stage }

/**
 * Reads the stage moves the activity log spells out with stage names: an edit or a claim
 * ("(status To do → In progress)"), and the human's verdict ("approved … (Done)", "(back to …)").
 * A name the project no longer has (a renamed stage) is not recognised, and the line is skipped.
 */
export function moveParser(stages: Stage[]): (text: string) => Move | null {
  const byName = new Map(stages.map((s) => [s.name, s]))
  if (!byName.size) return () => null
  const names = [...byName.keys()]
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  const status = new RegExp(`\\(status (${names}) → (${names})(?:,|\\))`)
  const verdict = new RegExp(`^(?:approved|disapproved) .*\\((${names})\\)$`)
  const back = new RegExp(`\\(back to (${names})\\)$`)
  return (text) => {
    const m = status.exec(text)
    if (m) return { from: byName.get(m[1]!)!, to: byName.get(m[2]!)! }
    const v = verdict.exec(text) ?? back.exec(text)
    return v ? { from: null, to: byName.get(v[1]!)! } : null
  }
}

/**
 * When the ticket's current stretch in progress began, from its log (oldest first): the move into an
 * in-progress stage, or a claim while it was not known to be out of progress. Its creation when the
 * log does not say (it was created in progress, or moved before the log knew the stage's name). Only
 * for a ticket without `startedAt`, which says it directly.
 */
export function progressSince(
  t: Pick<schema.Ticket, 'createdAt'>,
  events: Pick<schema.Activity, 'text' | 'createdAt'>[],
  parse: (text: string) => Move | null,
): string {
  let since: string | null = null
  let working: boolean | null = null
  for (const e of events) {
    const move = parse(e.text)
    if (move) {
      working = inProgress(move.to.kind)
      if (!working) since = null
      else if (!since) since = move.from && inProgress(move.from.kind) ? t.createdAt : e.createdAt
    } else if (!since && working !== false && /^(?:claimed|took over) /.test(e.text)) since = e.createdAt
  }
  return since ?? t.createdAt
}

/** Each ticket's newest progress post (gist, author, when), in two reads whatever the number of tickets. */
export function lastProgressPosts(ids: number[]): Map<number, Post> {
  const out = new Map<number, Post>()
  if (!ids.length) return out
  const newest = db
    .select({ ticketId: schema.updates.ticketId, at: max(schema.updates.createdAt) })
    .from(schema.updates)
    .where(and(inArray(schema.updates.ticketId, ids), eq(schema.updates.progress, true)))
    .groupBy(schema.updates.ticketId)
    .all()
  const at = new Map(newest.map((r) => [r.ticketId, r.at]))
  if (!at.size) return out
  const rows = db
    .select({
      ticketId: schema.updates.ticketId,
      author: schema.updates.author,
      body: schema.updates.body,
      createdAt: schema.updates.createdAt,
    })
    .from(schema.updates)
    .where(
      and(
        inArray(schema.updates.ticketId, [...at.keys()]),
        inArray(
          schema.updates.createdAt,
          [...at.values()].filter((v) => v !== null),
        ),
        eq(schema.updates.progress, true),
      ),
    )
    .orderBy(desc(schema.updates.id))
    .all()
  for (const r of rows)
    if (r.createdAt === at.get(r.ticketId) && !out.has(r.ticketId))
      out.set(r.ticketId, {
        ticketId: r.ticketId,
        author: r.author,
        text: gist(r.body),
        createdAt: r.createdAt,
      })
  return out
}

/** The first workspace preview registered on each ticket, if any. */
export function previewsOf(ids: number[]) {
  const out = new Map<number, { url: string; workspace: string }>()
  if (!ids.length) return out
  const rows = db
    .select({
      ticketId: schema.workspaces.ticketId,
      name: schema.workspaces.name,
      url: schema.workspaces.previewUrl,
    })
    .from(schema.workspaces)
    .where(and(inArray(schema.workspaces.ticketId, ids), ne(schema.workspaces.previewUrl, '')))
    .orderBy(asc(schema.workspaces.id))
    .all()
  for (const r of rows) if (!out.has(r.ticketId)) out.set(r.ticketId, { url: r.url, workspace: r.name })
  return out
}
