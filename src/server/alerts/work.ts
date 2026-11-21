import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'

import { db, schema } from '#/db'
import { lastHuman, listActors } from '../actors'
import { today } from '../daily'
import { decide, getPost, postUpdate } from '../features'
import { notFound } from '../http'
import { getPr, prForTicket, setPrHold } from '../prs'
import { pushStates, unpushed } from '../push'
import { ticketRepo } from '../repos'
import { readReportSettings } from '../reports'
import { kindOf, listStages, startStage } from '../stages'
import { getSummary } from '../summary'
import {
  type AlertActionContext,
  type AlertButton,
  type AlertCandidate,
  type AlertContext,
  type AlertType,
} from './registry'

/**
 * The alerts about work that waits on the human or is going wrong (ideas 6 to 9, 24 to 29 and 33). Each
 * reads what the board already keeps (the project's summary and work timeline, the PR rows of the last
 * refresh, the archive requests, the actors' last calls, the push states): a check never calls GitHub
 * and never waits on the network.
 */

// Not imported from the registry: it imports this file, so its constants are not set yet when this one loads.
const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS

/** A decision card unanswered for this long is raised again as an alert (idea 6). */
export const DECISION_WAIT_HOURS = 8
/** A task blocked on the human for this long on a ticket being worked (idea 24). */
export const BLOCKED_TASK_HOURS = 4
/** A ticket in review with green checks and no verdict for this many days, and when it turns a warning (idea 25). */
export const READY_WAIT_DAYS = 2
export const READY_WARNING_DAYS = 7
/** The Needs-you list longer than this raises the digest before the workday starts it (idea 27). */
export const DIGEST_ITEMS = 8
/** A PR waiting on the human with nothing happening for this long (idea 28). */
export const PR_WAIT_HOURS = 4
/** No agent has called the board for this long while tickets wait in To do (idea 29). */
export const NO_AGENT_HOURS = 6
/** A ticket in review or blocked whose branch has been only on this machine for this long (idea 33). */
export const UNPUSHED_HOURS = 4

const projectOf = (ctx: AlertContext) => {
  if (ctx.projectId === null) throw new Error('a work alert is checked per project')
  return ctx.projectId
}

const ticketHref = (projectId: number, ticketId: number) => `/projects/${projectId}/features/${ticketId}`
const label = (id: number, title: string) => `#${id} ${title}`
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const openTicket = (projectId: number, ticketId: number): AlertButton => ({
  id: 'open',
  label: 'Open the ticket',
  kind: 'link',
  href: ticketHref(projectId, ticketId),
})

/** How long, in the words a card uses: minutes under an hour, hours under two days, else days. */
export function span(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return plural(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (hours < 48) return plural(hours, 'hour')
  return plural(Math.round(hours / 24), 'day')
}

/** How long one evaluation's summary of a project is reused by the checks that read it. */
export const SUMMARY_TTL_MS = 15_000

/** Where the summary comes from; a test wraps `build` to count the builds. */
export const summarySource = {
  build: (projectId: number, now: Date) => getSummary(projectId, { now }).projects[0]!,
}

const kept = new Map<number, { at: number; summary: ReturnType<typeof summarySource.build> }>()

/** Forgets the kept summaries (the tests start each case without them). */
export const clearSummaries = () => kept.clear()

/**
 * The project's summary at the check's clock: what the Needs-you list and the work timeline say. The
 * checks of one evaluation share one build: it is reused while the clock is within `SUMMARY_TTL_MS` after
 * it, and never across a clock that went back or jumped past the TTL.
 */
function summaryOf(ctx: AlertContext) {
  const projectId = projectOf(ctx)
  const now = ctx.now()
  const hit = kept.get(projectId)
  if (hit && now >= hit.at && now - hit.at < SUMMARY_TTL_MS) return hit.summary
  const summary = summarySource.build(projectId, new Date(now))
  kept.set(projectId, { at: now, summary })
  return summary
}

/** The name the board writes the human's actions under. */
const human = () => lastHuman() ?? 'human'

const projectTickets = (projectId: number) =>
  db
    .select()
    .from(schema.tickets)
    .where(and(eq(schema.tickets.projectId, projectId), isNull(schema.tickets.archivedAt)))
    .all()

/** The ids of the open archive requests among these posts, with the tickets each names. */
function archiveRequests(postIds: number[]) {
  if (!postIds.length) return new Map<number, number[]>()
  return new Map(
    db
      .select({ id: schema.updates.id, tickets: schema.updates.archiveTickets })
      .from(schema.updates)
      .where(and(inArray(schema.updates.id, postIds), isNotNull(schema.updates.archiveTickets)))
      .all()
      .map((r) => [r.id, r.tickets ?? []] as const),
  )
}

// --- 6: a decision waiting ---

const decisionWaiting: AlertType = {
  type: 'decision-waiting',
  idea: 6,
  group: 'work',
  label: 'Decision waiting',
  description: `A decision card has gone unanswered for more than ${DECISION_WAIT_HOURS} hours`,
  scope: 'project',
  check(ctx) {
    const projectId = projectOf(ctx)
    const { decisions } = summaryOf(ctx).needsYou
    const archive = archiveRequests(decisions.map((d) => d.postId))
    return decisions.flatMap((d): AlertCandidate[] => {
      const waited = ctx.now() - Date.parse(d.createdAt)
      if (archive.has(d.postId) || waited <= DECISION_WAIT_HOURS * HOUR_MS) return []
      return [
        {
          subject: String(d.postId),
          severity: 'warning',
          title: `A decision on ${label(d.ticketId, d.ticketTitle)} has waited ${span(waited)}`,
          body: d.question,
          details: [`Asked by ${d.author}, ${plural(d.options, 'option')}`],
          buttons: [openTicket(projectId, d.ticketId)],
        },
      ]
    })
  },
}

// --- 7: a ticket stalled, or an agent that died mid-step ---

const ticketStalled: AlertType = {
  type: 'ticket-stalled',
  idea: 7,
  group: 'work',
  label: 'Ticket stalled',
  description: "An active ticket is silent past the project's stall time, or its agent lost contact",
  scope: 'project',
  check(ctx) {
    const projectId = projectOf(ctx)
    const summary = summaryOf(ctx)
    const now = ctx.now()
    const stalled = summary.needsYou.stalled.map(
      (s): AlertCandidate => ({
        subject: String(s.ticketId),
        severity: 'warning',
        title: `${label(s.ticketId, s.title)} is stalled`,
        body: `Nothing has been heard on it for ${span(now - Date.parse(s.lastSignalAt))}, past the project's stall time.`,
        details: [`Last heard from ${s.lastAgent || 'nobody'}`],
        buttons: [openTicket(projectId, s.ticketId)],
      }),
    )
    const lost = summary.lostContact.map(
      (l): AlertCandidate => ({
        subject: String(l.ticketId),
        severity: 'problem',
        title: `Lost contact with ${l.agent || 'the agent'} on ${label(l.ticketId, l.title)}`,
        body: `The agent started a step${l.phase ? ` (${l.phase})` : ''} and has not been heard from for ${span(now - Date.parse(l.lastSignalAt))}: it probably died mid-step.`,
        details: l.spans.map((s) => `Open step: ${s.phase} by ${s.agent}`),
        buttons: [openTicket(projectId, l.ticketId)],
      }),
    )
    return [...stalled, ...lost]
  },
}

// --- 8, 9, 25: the PR of a ticket in review ---

/** A ticket in a review-kind stage with its PR as the board last stored it; the ones without an open PR are left out. */
function reviewTickets(projectId: number) {
  const stages = listStages(projectId)
  return projectTickets(projectId).flatMap((t) => {
    if (t.prId !== null || kindOf(stages, t.status) !== 'review') return []
    const pr = prForTicket(t)
    return pr?.queue?.open ? [{ ticket: t, queue: pr.queue, number: pr.number }] : []
  })
}

const failedChecks = (checks: { name: string; state: string }[]) =>
  checks.filter((c) => c.state === 'fail').map((c) => c.name)

const approvedNotMerged: AlertType = {
  type: 'approved-not-merged',
  idea: 8,
  group: 'work',
  label: 'Approved but not merged',
  description: 'A ticket in Approved has a PR that cannot merge: conflicts or failing checks',
  scope: 'project',
  check(ctx) {
    const projectId = projectOf(ctx)
    return reviewTickets(projectId).flatMap(({ ticket, queue, number }): AlertCandidate[] => {
      if (ticket.status !== 'approved') return []
      const why = [
        ...(queue.merge === 'conflicts' ? ['it conflicts with its base'] : []),
        ...(queue.ci === 'failing' && !queue.localCi ? ['its checks are failing'] : []),
      ]
      if (!why.length) return []
      return [
        {
          subject: String(ticket.id),
          severity: 'problem',
          title: `${label(ticket.id, ticket.title)} is approved but cannot merge`,
          body: `PR #${number}: ${why.join(' and ')}.`,
          details: failedChecks(queue.checks).map((n) => `Failed check: ${n}`),
          buttons: [openTicket(projectId, ticket.id)],
        },
      ]
    })
  },
}

const prChecksFailed: AlertType = {
  type: 'pr-checks-failed',
  idea: 9,
  group: 'work',
  label: 'PR checks failed or branch out of date',
  description: 'The PR of a ticket in review has failing checks, conflicts or fell behind its base',
  scope: 'project',
  check(ctx) {
    const projectId = projectOf(ctx)
    return reviewTickets(projectId).flatMap(({ ticket, queue, number }): AlertCandidate[] => {
      if (ticket.status === 'approved') return []
      // A "CI run locally: green" comment naming the head counts as green, as the board's CI phase does.
      const failing = queue.ci === 'failing' && !queue.localCi
      const conflicts = queue.merge === 'conflicts'
      const behind = queue.merge === 'behind'
      if (!failing && !conflicts && !behind) return []
      const why = [
        ...(failing ? ['its checks failed'] : []),
        ...(conflicts ? ['it conflicts with its base'] : []),
        ...(behind ? ['it is behind its base'] : []),
      ]
      return [
        {
          subject: String(ticket.id),
          severity: failing || conflicts ? 'problem' : 'warning',
          title: `The PR of ${label(ticket.id, ticket.title)} needs work`,
          body: `PR #${number}: ${why.join(', ')}.`,
          details: failedChecks(queue.checks).map((n) => `Failed check: ${n}`),
          buttons: [openTicket(projectId, ticket.id)],
        },
      ]
    })
  },
}

const readyForYou: AlertType = {
  type: 'ready-for-you',
  idea: 25,
  group: 'work',
  label: 'Ready for your verdict',
  description: `A ticket in review has green checks and an up to date branch and has had no verdict for ${READY_WAIT_DAYS} days`,
  scope: 'project',
  check(ctx) {
    const projectId = projectOf(ctx)
    const since = new Map(
      summaryOf(ctx).needsYou.reviews.map((r) => [r.id, Date.parse(r.stage?.since ?? r.updatedAt)]),
    )
    return reviewTickets(projectId).flatMap(({ ticket, queue }): AlertCandidate[] => {
      const from = since.get(ticket.id)
      if (from === undefined || ticket.approvedAt || ticket.disapprovedAt) return []
      if (queue.isDraft || queue.merge !== 'clean' || !(queue.ci === 'passing' || queue.localCi)) return []
      const waited = ctx.now() - from
      if (waited <= READY_WAIT_DAYS * DAY_MS) return []
      return [
        {
          subject: String(ticket.id),
          severity: waited > READY_WARNING_DAYS * DAY_MS ? 'warning' : 'info',
          title: `${label(ticket.id, ticket.title)} has been ready for your verdict for ${span(waited)}`,
          body: 'Checks are green and the branch is up to date.',
          buttons: [{ ...openTicket(projectId, ticket.id), label: 'Open the PR page' }],
        },
      ]
    })
  },
}

// --- 24: a task waits on you ---

/**
 * When the task was tagged blocked: the board writes a line when a task is flagged (and when a task is
 * added already blocked), so the first such line since the task was last clear is when the wait began. A task with no such line (one
 * written before the log kept it) counts from the ticket's last change.
 */
function blockedSince(ticketId: number, taskText: string, fallback: string): number {
  const lines = db
    .select({ text: schema.activity.text, createdAt: schema.activity.createdAt })
    .from(schema.activity)
    .where(
      and(
        eq(schema.activity.refType, 'ticket'),
        eq(schema.activity.refId, ticketId),
        eq(schema.activity.kind, 'task'),
      ),
    )
    .orderBy(desc(schema.activity.createdAt), desc(schema.activity.id))
    .all()
  // The wait began at the first flag of the current stretch: a later flag only rewords the reason.
  let flagged: string | undefined
  for (const l of lines) {
    if (l.text.startsWith(`flagged "${taskText}" as blocked`)) flagged = l.createdAt
    else if (
      l.text.startsWith(`cleared the blocked flag on "${taskText}"`) ||
      l.text.startsWith(`completed "${taskText}"`)
    )
      break
  }
  const added = lines.find((l) => /^added \d+ (tasks?|subtasks?) \(\d+ blocked\)/.test(l.text))
  return Date.parse(flagged ?? added?.createdAt ?? fallback)
}

const taskWaits: AlertType = {
  type: 'task-waits-on-you',
  idea: 24,
  group: 'work',
  label: 'A task waits on you',
  description: `A task has been blocked on you for more than ${BLOCKED_TASK_HOURS} hours`,
  scope: 'project',
  snoozeOptions: [DAY_MS, 7 * DAY_MS],
  check(ctx) {
    const projectId = projectOf(ctx)
    const tickets = new Map(projectTickets(projectId).map((t) => [t.id, t]))
    return summaryOf(ctx).needsYou.blockedTasks.flatMap((b): AlertCandidate[] => {
      const waited = ctx.now() - blockedSince(b.ticketId, b.text, tickets.get(b.ticketId)?.updatedAt ?? '')
      if (!(waited > BLOCKED_TASK_HOURS * HOUR_MS)) return []
      return [
        {
          subject: String(b.taskId),
          severity: 'warning',
          title: `${label(b.ticketId, b.ticketTitle)} is blocked on you for ${span(waited)}`,
          body: b.reason || b.text,
          details: [`Task: ${b.text}`],
          buttons: [openTicket(projectId, b.ticketId)],
        },
      ]
    })
  },
}

// --- 26: an agent asked to archive a ticket ---

/** The open archive requests of the project whose tickets are still there to archive. */
function openArchiveRequests(projectId: number) {
  const posts = db
    .select({ post: schema.updates })
    .from(schema.updates)
    .innerJoin(schema.tickets, eq(schema.tickets.id, schema.updates.ticketId))
    .where(
      and(
        eq(schema.tickets.projectId, projectId),
        isNotNull(schema.updates.decision),
        isNotNull(schema.updates.archiveTickets),
        isNull(schema.updates.decidedAt),
      ),
    )
    .all()
    .map((r) => r.post)
  return posts.flatMap((post) => {
    const named = db
      .select()
      .from(schema.tickets)
      .where(inArray(schema.tickets.id, post.archiveTickets ?? []))
      .all()
      .filter((t) => !t.archivedAt)
    return named.length ? [{ post, named }] : []
  })
}

/** The post an archive request's button answers, still open and in this alert's project. */
function requestOf(ctx: AlertActionContext) {
  const post = getPost(Number(ctx.alert.subject))
  const ticket = db.select().from(schema.tickets).where(eq(schema.tickets.id, post.ticketId)).get()
  if (!post.archiveTickets || !ticket || ticket.projectId !== ctx.alert.projectId)
    throw notFound('archive request')
  return post
}

const answerArchive = (option: 0 | 1, done: string) => (ctx: AlertActionContext) => {
  const post = requestOf(ctx)
  if (post.decidedAt) return { message: 'It was already answered', resolve: true }
  decide(post.id, option, '', human())
  return { message: done, resolve: true }
}

const archiveRequested: AlertType = {
  type: 'archive-requested',
  idea: 26,
  group: 'work',
  label: 'Archive requested',
  description: 'An agent asked to archive finished tickets and the request is unanswered',
  scope: 'project',
  check(ctx) {
    const projectId = projectOf(ctx)
    return openArchiveRequests(projectId).map(({ post, named }): AlertCandidate => {
      const stages = listStages(projectId)
      const first = named[0]!
      return {
        subject: String(post.id),
        severity: 'info',
        title: `${post.author} asks to archive ${named.map((t) => label(t.id, t.title)).join(', ')}`,
        body: 'Archive takes them off the board, their lanes with them; any can be restored from the Archived tab.',
        details: named.map(
          (t) => `${label(t.id, t.title)} (${stages.find((s) => s.key === t.status)?.name ?? t.status})`,
        ),
        buttons: [
          { id: 'archive', label: 'Archive', kind: 'action', primary: true },
          { id: 'keep', label: 'Keep it', kind: 'action' },
          openTicket(projectId, first.id),
        ],
      }
    })
  },
  actions: {
    archive: answerArchive(0, 'Archived'),
    keep: answerArchive(1, 'Kept'),
  },
}

// --- 27: the Needs-you digest ---

const minutesOfDay = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

const needsDigest: AlertType = {
  type: 'needs-you-digest',
  idea: 27,
  group: 'work',
  label: 'Needs-you digest',
  description: `One card a workday, or when more than ${DIGEST_ITEMS} things wait on you, counting what waits`,
  scope: 'project',
  snoozeOptions: [DAY_MS, 7 * DAY_MS],
  check(ctx) {
    const projectId = projectOf(ctx)
    const n = summaryOf(ctx).needsYou
    const archive = archiveRequests(n.decisions.map((d) => d.postId))
    const counts: [number, string, string][] = [
      [n.decisions.length - archive.size, 'decision', 'decisions'],
      [archive.size, 'archive request', 'archive requests'],
      [n.reviews.length, 'review', 'reviews'],
      [n.prs.length, 'PR to review', 'PRs to review'],
      [n.blockedTasks.length, 'blocked task', 'blocked tasks'],
      [n.threads.length, 'thread', 'threads'],
      [n.humanWaits.length, 'agent wait', 'agent waits'],
      [n.stalled.length, 'stalled ticket', 'stalled tickets'],
      [n.instructionChanges.length, 'instruction change', 'instruction changes'],
    ]
    const parts = counts
      .filter(([c]) => c > 0)
      .map(([c, one, many]) => (c === 1 ? `1 ${one}` : `${c} ${many}`))
    if (!parts.length) return []
    const at = new Date(ctx.now())
    const settings = readReportSettings(projectId)
    const weekday = at.getDay() || 7
    const started =
      settings.workdays.includes(weekday) &&
      at.getHours() * 60 + at.getMinutes() >= minutesOfDay(settings.shiftStart)
    if (!started && n.total <= DIGEST_ITEMS) return []
    return [
      {
        subject: today(at),
        severity: 'info',
        title: `Waiting on you: ${parts.join(', ')}`,
        body: `${plural(n.total, 'thing')} in the Needs you list.`,
        buttons: [{ id: 'open', label: 'Open Needs you', kind: 'link', href: `/projects/${projectId}` }],
      },
    ]
  },
}

// --- 28: a PR waiting on you in the PR queue ---

const prWaiting: AlertType = {
  type: 'pr-waiting-on-you',
  idea: 28,
  group: 'work',
  label: 'PR waiting on you',
  description: `A PR in the queue waits on your review and nothing has happened for ${PR_WAIT_HOURS} hours`,
  scope: 'project',
  check(ctx) {
    const projectId = projectOf(ctx)
    return db
      .select()
      .from(schema.prs)
      .where(
        and(
          eq(schema.prs.projectId, projectId),
          eq(schema.prs.open, true),
          eq(schema.prs.waitingOn, 'me'),
          eq(schema.prs.isDraft, false),
        ),
      )
      .all()
      .flatMap((pr): AlertCandidate[] => {
        // Reviewed already, and not held: the author's turn, not the human's.
        if (pr.reviewStage === 'reviewed' && !pr.hold) return []
        const quiet = ctx.now() - Date.parse(pr.updatedAt)
        if (!(quiet > PR_WAIT_HOURS * HOUR_MS)) return []
        return [
          {
            subject: String(pr.id),
            severity: 'info',
            title: `PR #${pr.number} ${pr.title} is waiting on you`,
            body: `${pr.hold ? 'On hold' : 'Waiting for your review'}; nothing has happened on it for ${span(quiet)}.`,
            details: [`Author: ${pr.author}`, ...(pr.hold && pr.holdNote ? [`Hold: ${pr.holdNote}`] : [])],
            buttons: [
              { id: 'open', label: 'Open the PR review', kind: 'link', href: `/projects/${projectId}/prs` },
              ...(pr.hold
                ? [{ id: 'release', label: 'Release the hold', kind: 'action', primary: true } as const]
                : []),
            ],
          },
        ]
      })
  },
  actions: {
    release(ctx) {
      const pr = getPr(Number(ctx.alert.subject))
      if (pr.projectId !== ctx.alert.projectId) throw notFound('PR')
      if (pr.hold) setPrHold(pr.id, false, '', human())
      return { message: `Released PR #${pr.number} from hold`, resolve: true }
    },
  },
}

// --- 29: no agent has called in while work waits ---

const noAgent: AlertType = {
  type: 'no-agent-calling',
  idea: 29,
  group: 'work',
  label: 'No agent has called in',
  description: `Tickets wait in To do and no agent has called the board for ${NO_AGENT_HOURS} hours`,
  scope: 'project',
  snoozeOptions: [4 * HOUR_MS, DAY_MS, 7 * DAY_MS],
  check(ctx) {
    const projectId = projectOf(ctx)
    const stages = listStages(projectId)
    const todo = startStage(stages)
    const waiting = projectTickets(projectId).filter(
      (t) => t.parentId === null && t.prId === null && t.status === todo.key,
    )
    if (!waiting.length) return []
    // Every authenticated call notes its caller (actors.ts), so the latest `lastSeenAt` of an agent is its last call.
    const calls = listActors().flatMap((a) =>
      a.kind === 'agent' && a.lastSeenAt ? [Date.parse(a.lastSeenAt)] : [],
    )
    const last = calls.length ? Math.max(...calls) : null
    const silent = last === null ? null : ctx.now() - last
    if (silent !== null && silent <= NO_AGENT_HOURS * HOUR_MS) return []
    return [
      {
        severity: 'info',
        title: `No agent has contacted the board${silent === null ? ' yet' : ` for ${span(silent)}`}`,
        body: `${plural(waiting.length, 'ticket is', 'tickets are')} in ${todo.name}. Is an agent running?`,
        buttons: [{ id: 'connect', label: 'Open Connect an agent', kind: 'link', href: '/agents' }],
      },
    ]
  },
}

// --- 33: work only on this machine ---

/** When a ticket's branch was first seen with commits origin does not have, by project and ticket; a restart starts the count again. */
const unpushedSince = new Map<string, number>()

const onlyHere: AlertType = {
  type: 'work-only-here',
  idea: 33,
  group: 'work',
  label: 'Work only on this machine',
  description: `A branch in review or blocked has had commits only on this machine for ${UNPUSHED_HOURS} hours`,
  scope: 'project',
  async check(ctx) {
    const projectId = projectOf(ctx)
    const stages = listStages(projectId)
    const tickets = projectTickets(projectId).filter(
      (t) => t.branch && t.prId === null && ['review', 'blocked'].includes(kindOf(stages, t.status)),
    )
    const byRepo = new Map<number, { repoPath: string; tickets: typeof tickets }>()
    for (const t of tickets) {
      const repo = ticketRepo(t)
      if (!repo) continue
      byRepo.set(repo.id, { repoPath: repo.repoPath, tickets: [...(byRepo.get(repo.id)?.tickets ?? []), t] })
    }
    const now = ctx.now()
    const keep = new Set<string>()
    const found: AlertCandidate[] = []
    for (const { repoPath, tickets: here } of byRepo.values()) {
      const states = await pushStates(
        repoPath,
        here.map((t) => t.branch),
        new Map(here.map((t) => [t.branch, t.baseBranch])),
      )
      for (const t of here) {
        const push = states.get(t.branch)
        if (!push || !unpushed(push)) continue
        const key = `${projectId}:${t.id}:${t.branch}`
        keep.add(key)
        const since = unpushedSince.get(key) ?? now
        unpushedSince.set(key, since)
        if (now - since <= UNPUSHED_HOURS * HOUR_MS) continue
        found.push({
          subject: String(t.id),
          severity: 'warning',
          title: `${label(t.id, t.title)} has ${plural(push.ahead, 'commit')} only on this machine`,
          body: `Branch ${t.branch} has not been on origin for ${span(now - since)}: a disk or worktree failure would lose it.`,
          buttons: [
            openTicket(projectId, t.id),
            { id: 'ask-push', label: 'Ask the agent to push', kind: 'action', primary: true },
          ],
        })
      }
    }
    for (const key of unpushedSince.keys())
      if (key.startsWith(`${projectId}:`) && !keep.has(key)) unpushedSince.delete(key)
    return found
  },
  actions: {
    'ask-push'(ctx) {
      const ticket = db
        .select()
        .from(schema.tickets)
        .where(eq(schema.tickets.id, Number(ctx.alert.subject)))
        .get()
      if (!ticket || ticket.projectId !== ctx.alert.projectId) throw notFound('ticket')
      postUpdate(
        ticket.id,
        `Please push \`${ticket.branch}\` to origin: it has commits that exist only on this machine.`,
        [],
        human(),
        { progress: false },
      )
      return { message: 'Asked the agent to push' }
    },
  },
}

export const alertTypes: AlertType[] = [
  decisionWaiting,
  ticketStalled,
  approvedNotMerged,
  prChecksFailed,
  taskWaits,
  readyForYou,
  archiveRequested,
  needsDigest,
  prWaiting,
  noAgent,
  onlyHere,
]
