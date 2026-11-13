import { and, asc, desc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm'

import { db, schema } from '#/db'
import { gist, listTickets, nextTask } from './features'
import { listRepos } from './repos'
import { getProject } from './projects'
import { listStages, type Stage } from './stages'
import { lastProgressPosts, previewsOf } from './summary'
import { timelinesFor } from './workTimeline'

/**
 * What is happening on a project right now, for a session that is starting: the tickets and lanes an
 * agent is on (an open span, an agent event inside the window, or an open wait) with who and since when,
 * the ones nothing is running on and how long they have been quiet, what waits on the human, what is in
 * review, the last posts across the project, and the clock all of it was measured against.
 *
 * This is the agents' side of the board; `getSummary` is the human's. It reads what the board already
 * holds (work timelines, posts, tasks, PRs, previews) in one query set, so a project with forty tickets
 * costs the same reads as one with a single ticket. Silence is reported as silence: a ticket with no
 * live entry is not proof that nobody is working on it, only that nobody recorded an event the board can
 * see (see `get_live_work` in mcp.ts).
 */

/** A ticket's one-line state, and the numbers that say how quiet it is, are for the last few only. */
const RECENT_TICKETS = 10
/** The last handful of posts: the same bounded count on every call. */
const RECENT_POSTS = 10

export interface LiveWorkOptions {
  /** The moment the read is taken; now unless a test pins it. */
  now?: Date
  /** How many minutes back count as live; the project's `stallMinutes` unless given. */
  windowMinutes?: number
}

/** A ticket as `listTickets` reads it (archived tickets and PR tickets are already left out). */
type Row = ReturnType<typeof listTickets>[number]

/** Where a ticket sits: its stage's key and name, and what the stage means. */
export type StageView = { key: string; name: string; kind: Stage['kind'] }

/** A ticket or lane with an agent on it, or an agent event inside the window. */
export interface LiveNowEntry {
  ticketId: number
  title: string
  status: string
  stage: StageView
  /** The ticket it is a lane of. */
  parent: { id: number; title: string } | null
  /** Who is on it: the open spans' and waits' agents, the agent a delegated wait handed the work to,
   * and the agent the last event names. */
  agents: string[]
  /** The phase and round of the open span that started last, null when nothing is open. */
  phase: string | null
  round: number | null
  /** The latest agent event (a heartbeat too), or the ticket's last signal when it has none. */
  lastHeardAt: string
  /** The agent that event names, or the assignee when no event names one. */
  lastHeardBy: string
  silentMinutes: number
  /** The open wait it is on, the earliest started; null when it runs without one. */
  waitingFor: { reason: string; note: string; agent: string; on: string | null; since: string } | null
  /** Always false here: a stalled ticket is reported under recentlyActive instead, with the same shape. */
  stalled: boolean
}

/** A ticket nothing is running on, newest word first, bounded to the last few. */
export interface RecentlyActiveEntry {
  ticketId: number
  title: string
  status: string
  stage: StageView
  parent: { id: number; title: string } | null
  /** Who holds it, from the same read as `LiveNowEntry.agents`: a quiet ticket still names who was on it. */
  agents: string[]
  /** The phase and round of the open span that started last, null when nothing is open. */
  phase: string | null
  round: number | null
  /** The latest of its work-timeline events, its start and its creation: any signal, the board's own too. */
  lastSignalAt: string
  lastHeardAt: string
  lastHeardBy: string
  silentMinutes: number
  stalled: boolean
  /** One line: its summary's first line, else its newest progress post's gist, else ''. */
  state: string
}

/** One thing a fresh session must not take on as free work. */
export interface WaitingOnHumanEntry {
  kind: 'decision' | 'blocked-task' | 'blocked-ticket'
  ticketId: number
  title: string
  /** One line: the question, the blocked step and its reason, or the ticket's state. */
  line: string
  /** When it started waiting; null where the board records no time for it (a blocked task's tag). */
  since: string | null
  /** On a decision card: the post it is asked on. */
  postId?: number
  /** On a blocked task: which task or subtask carries the tag. */
  taskId?: number
}

/** A ticket handed off for the human's read. */
export interface InReviewEntry {
  ticketId: number
  title: string
  status: string
  stage: StageView
  parent: { id: number; title: string } | null
  prNumber: number | null
  prUrl: string | null
  /** The PR queue's standing: pending, reviewed or on_hold; null without a PR row. */
  reviewStage: string | null
  /** The latest recorded review's verdict, else `reviewStage`; null when neither exists. */
  verdict: string | null
  /** The first preview registered on the ticket or a lane of it; null when none is. */
  preview: string | null
}

/** A post across the project, as one line. */
export interface RecentPost {
  ticketId: number
  ticketTitle: string
  author: string
  at: string
  line: string
}

export type LiveWork = ReturnType<typeof getLiveWork>

/**
 * The project's live work, in one read. Answering for a project that does not exist is a 404 (`getProject`).
 */
export function getLiveWork(projectId: number, opts: LiveWorkOptions = {}) {
  const now = opts.now ?? new Date()
  const project = getProject(projectId)
  const stallMinutes = project.stallMinutes
  const windowMinutes = opts.windowMinutes ?? stallMinutes
  const windowStart = now.getTime() - windowMinutes * 60_000
  const stages = listStages(projectId)
  const stageByKey = new Map(stages.map((s) => [s.key, s]))
  // A status no stage has any more reads as the first stage, as everywhere on the board.
  const stageOf = (status: string) => stageByKey.get(status) ?? stages[0]!
  const stageView = (status: string): StageView => {
    const s = stageOf(status)
    return { key: s.key, name: s.name, kind: s.kind }
  }
  const kindOf = (status: string) => stageOf(status).kind

  // Archived tickets are left out here, PR tickets with them: a PR of the queue is read on its own.
  const tickets = listTickets(projectId)
  const ids = tickets.map((t) => t.id)
  const byId = new Map(tickets.map((t) => [t.id, t]))
  const parentOf = (t: Row) => {
    const p = t.parentId ? byId.get(t.parentId) : undefined
    return p ? { id: p.id, title: p.title } : null
  }
  const timelines = timelinesFor(tickets, now)
  const timelineOf = (t: Row) => timelines.get(t.id)!.timeline
  /** When a ticket was last heard from, and by which agent: the latest event, else its last signal. */
  const heardAt = (t: Row) => {
    const { timeline } = timelines.get(t.id)!
    return {
      at: timeline.lastHeard?.at ?? timeline.lastSignalAt,
      by: timeline.lastHeard?.agent ?? t.assignee,
    }
  }
  const silent = (at: string) => Math.max(0, Math.floor((now.getTime() - Date.parse(at)) / 60_000))
  /** A ticket that is done, cancelled, or a lane of one: its work is out of the picture. */
  const closed = (t: Row | undefined): boolean =>
    !!t &&
    (kindOf(t.status) === 'done' ||
      kindOf(t.status) === 'cancelled' ||
      closed(t.parentId ? byId.get(t.parentId) : undefined))
  /**
   * Who holds a ticket and what its open span is on, from its timeline: the open spans and waits, the
   * span that started last, the wait it has been on longest, the agents (a delegated wait's `on` and the
   * last event's agent too; the assignee only when nothing names one) and that span's phase and round.
   * Both lists use it, so a stalled ticket still names who was on it and what it was doing.
   */
  const holding = (t: Row, timeline: ReturnType<typeof timelineOf>) => {
    const spans = timeline.spans.filter((s) => s.open)
    const waits = timeline.waits.filter((w) => w.open)
    const span = [...spans].sort((a, b) => Date.parse(b.start) - Date.parse(a.start))[0]
    const wait = [...waits].sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0]
    const agents = new Set<string>()
    for (const s of spans) if (s.agent) agents.add(s.agent)
    for (const w of waits) {
      if (w.agent) agents.add(w.agent)
      if (w.on) agents.add(w.on)
    }
    // The agent the last event names is on it too; only when nothing names one is the assignee all the board has.
    if (timeline.lastHeard?.agent) agents.add(timeline.lastHeard.agent)
    if (!agents.size && t.assignee) agents.add(t.assignee)
    return {
      spans,
      waits,
      wait,
      agents: [...agents],
      phase: span?.phase ?? null,
      round: span?.round ?? null,
    }
  }

  // --- live now: an open span or wait, or an agent event (a heartbeat too) inside the window ---
  // A stalled ticket is silence, not work in flight: it goes to recentlyActive whatever is still open.
  // Finished work is out too: a span an agent left open on a done or cancelled ticket is not work in
  // flight, and without this it would read as live forever.
  const liveNow: LiveNowEntry[] = []
  for (const t of tickets) {
    if (closed(t)) continue
    const timeline = timelineOf(t)
    const { spans, waits, wait, agents, phase, round } = holding(t, timeline)
    const heard = timeline.lastHeard
    const live =
      !timeline.stalled &&
      (spans.length > 0 || waits.length > 0 || (heard !== null && Date.parse(heard.at) >= windowStart))
    if (!live) continue
    const heardFrom = heardAt(t)
    liveNow.push({
      ticketId: t.id,
      title: t.title,
      status: t.status,
      stage: stageView(t.status),
      parent: parentOf(t),
      agents,
      phase,
      round,
      lastHeardAt: heardFrom.at,
      lastHeardBy: heardFrom.by,
      silentMinutes: silent(heardFrom.at),
      waitingFor: wait
        ? { reason: wait.reason, note: wait.note, agent: wait.agent, on: wait.on, since: wait.start }
        : null,
      // Never true here: a stalled ticket is listed as recently active, not as live (the live test above).
      stalled: false,
    })
  }
  liveNow.sort((a, b) => Date.parse(b.lastHeardAt) - Date.parse(a.lastHeardAt))
  const liveIds = new Set(liveNow.map((t) => t.ticketId))

  // --- recently active, nothing running: work still open, with one line of where it stands ---
  // Finished work is out (done, cancelled, or a lane of one): it is not something to pick up, and a
  // project that just closed ten tickets would push the quiet one this read exists for out of the list.
  const states = stateLines(ids)
  const recentlyActive: RecentlyActiveEntry[] = tickets
    .filter((t) => !liveIds.has(t.id) && !closed(t))
    .map((t) => {
      const heardFrom = heardAt(t)
      const timeline = timelineOf(t)
      const { agents, phase, round } = holding(t, timeline)
      return {
        ticketId: t.id,
        title: t.title,
        status: t.status,
        stage: stageView(t.status),
        parent: parentOf(t),
        agents,
        phase,
        round,
        lastSignalAt: timeline.lastSignalAt,
        lastHeardAt: heardFrom.at,
        lastHeardBy: heardFrom.by,
        silentMinutes: silent(heardFrom.at),
        stalled: !!timeline.stalled,
        state: states.get(t.id) ?? '',
      }
    })
    .sort((a, b) => Date.parse(b.lastHeardAt) - Date.parse(a.lastHeardAt))
    .slice(0, RECENT_TICKETS)

  // --- waiting on the human: cards, blocked next steps and blocked tickets, a ticket once ---
  // A PR's own ticket is not among `tickets`, but its decision cards still wait on the human.
  const prTickets = db
    .select({ id: schema.tickets.id, title: schema.tickets.title })
    .from(schema.tickets)
    .where(
      and(
        eq(schema.tickets.projectId, projectId),
        isNotNull(schema.tickets.prId),
        isNull(schema.tickets.archivedAt),
      ),
    )
    .all()
  const titleOf = new Map<number, string>([
    ...tickets.map((t) => [t.id, t.title] as const),
    ...prTickets.map((t) => [t.id, t.title] as const),
  ])
  const deciding = [...ids, ...prTickets.map((t) => t.id)]
  const decisions = deciding.length
    ? db
        .select({
          id: schema.updates.id,
          ticketId: schema.updates.ticketId,
          body: schema.updates.body,
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
        .orderBy(desc(schema.updates.createdAt), desc(schema.updates.id))
        .all()
    : []
  // Only the step a ticket (or lane) works next — its first open task with no open subtask — is one a
  // blocked tag really stops, as `get_summary` counts it.
  const blockedCandidates = tickets.filter((t) => t.blockedTasks > 0 && !closed(t)).map((t) => t.id)
  const taskRows = blockedCandidates.length
    ? db
        .select()
        .from(schema.tasks)
        .where(inArray(schema.tasks.ticketId, blockedCandidates))
        .orderBy(asc(schema.tasks.position), asc(schema.tasks.id))
        .all()
    : []
  const ownTasks = new Map<number, typeof taskRows>()
  for (const task of taskRows) ownTasks.set(task.ticketId, [...(ownTasks.get(task.ticketId) ?? []), task])
  const nextId = new Map([...ownTasks].map(([id, own]) => [id, nextTask(own)?.id ?? null]))
  const blockedSteps = taskRows.filter(
    (task) => task.blocked && !task.done && nextId.get(task.ticketId) === task.id,
  )
  const blockedTickets = tickets.filter((t) => kindOf(t.status) === 'blocked' && !closed(t))
  const waitingOnHuman: WaitingOnHumanEntry[] = []
  const listed = new Set<number>()
  // A ticket is listed once: its question first, then the step it is stopped on, then its stage.
  const list = (row: WaitingOnHumanEntry) => {
    if (listed.has(row.ticketId)) return
    listed.add(row.ticketId)
    waitingOnHuman.push(row)
  }
  for (const d of decisions)
    list({
      kind: 'decision',
      ticketId: d.ticketId,
      title: titleOf.get(d.ticketId) ?? '',
      line: gist(d.body),
      since: d.createdAt,
      postId: d.id,
    })
  for (const task of blockedSteps)
    list({
      kind: 'blocked-task',
      ticketId: task.ticketId,
      title: titleOf.get(task.ticketId) ?? '',
      line: task.blockedReason ? `${task.text} — ${task.blockedReason}` : task.text,
      // A task carries no time of its own; the board records when it was tagged, not when it was written.
      since: null,
      taskId: task.id,
    })
  for (const t of blockedTickets)
    list({
      kind: 'blocked-ticket',
      ticketId: t.id,
      title: t.title,
      line: states.get(t.id) || `Waiting in ${stageView(t.status).name}`,
      // The stretch in a blocked stage the timeline knows; null when it moved before events were recorded.
      since: [...timelineOf(t).blockedStretches].at(-1)?.start ?? null,
    })

  // --- in review: handed off with a PR, with where its reviews stand and its preview ---
  const reviewing = tickets.filter((t) => kindOf(t.status) === 'review')
  const numbers = reviewing.flatMap((t) => (t.prNumber === null ? [] : [t.prNumber]))
  const branches = reviewing.flatMap((t) => (t.branch ? [t.branch] : []))
  const match = [
    ...(numbers.length ? [inArray(schema.prs.number, numbers)] : []),
    ...(branches.length ? [inArray(schema.prs.headRef, branches)] : []),
  ]
  const prRows = match.length
    ? db
        .select()
        .from(schema.prs)
        .where(and(eq(schema.prs.projectId, projectId), or(...match)))
        .all()
    : []
  // A ticket's repo is its own, else the project's first one (as `ticketRepo` takes it). A PR is the ticket's
  // only in that repo: another repo's PR can carry the same number or the same branch name.
  const primaryRepoId = listRepos(projectId)[0]?.id ?? null
  const repoOf = (t: Row) => t.repoId ?? primaryRepoId
  // The ticket's own PR number in its own repo first, else a row on its branch; an open one over a closed.
  const prOf = (t: Row) => {
    const repo = repoOf(t)
    const own = prRows.filter(
      (p) =>
        (p.repoId === null || (repo !== null && p.repoId === repo)) &&
        (t.prNumber !== null ? p.number === t.prNumber : !!t.branch && p.headRef === t.branch),
    )
    return (
      own.sort((a, b) => Number(b.open) - Number(a.open) || b.updatedAt.localeCompare(a.updatedAt))[0] ?? null
    )
  }
  const handedOff = reviewing.flatMap((t) => {
    const pr = prOf(t)
    const number = t.prNumber ?? pr?.number ?? null
    return number === null ? [] : [{ ticket: t, pr, number }]
  })
  const reviewNumbers = [...new Set(handedOff.map((x) => x.number))]
  // The latest review recorded for that PR; one posted without a repo counts for every repo, as on the queue.
  const results = reviewNumbers.length
    ? db
        .select({
          prNumber: schema.reviewResults.prNumber,
          repoId: schema.reviewResults.repoId,
          verdict: schema.reviewResults.verdict,
        })
        .from(schema.reviewResults)
        .where(
          and(
            eq(schema.reviewResults.projectId, projectId),
            inArray(schema.reviewResults.prNumber, reviewNumbers),
          ),
        )
        .orderBy(desc(schema.reviewResults.createdAt), desc(schema.reviewResults.id))
        .all()
    : []
  const verdictOf = (number: number, repoId: number | null) =>
    results.find(
      (r) => r.prNumber === number && (r.repoId === null || repoId === null || r.repoId === repoId),
    )?.verdict ?? null
  // A preview is registered on the ticket's worktree or on one of its lanes': the first one there is.
  const lanesOf = new Map<number, number[]>()
  for (const t of tickets) if (t.parentId) lanesOf.set(t.parentId, [...(lanesOf.get(t.parentId) ?? []), t.id])
  const below = (id: number): number[] => (lanesOf.get(id) ?? []).flatMap((lane) => [lane, ...below(lane)])
  const previews = previewsOf(handedOff.flatMap(({ ticket }) => [ticket.id, ...below(ticket.id)]))
  const previewOf = (id: number): string | null =>
    previews.get(id)?.url ?? (lanesOf.get(id) ?? []).map(previewOf).find((url) => url !== null) ?? null
  const inReview: InReviewEntry[] = handedOff.map(({ ticket: t, pr, number }) => ({
    ticketId: t.id,
    title: t.title,
    status: t.status,
    stage: stageView(t.status),
    parent: parentOf(t),
    prNumber: number,
    prUrl: pr?.url ?? null,
    reviewStage: pr?.reviewStage ?? null,
    verdict: verdictOf(number, repoOf(t)) ?? pr?.reviewStage ?? null,
    preview: previewOf(t.id),
  }))

  // --- the last few posts across the project: the thread the last session left ---
  // A PR's own ticket is a ticket of the project too, so its review findings are part of the thread.
  const posting = [...ids, ...prTickets.map((t) => t.id)]
  const recentPosts: RecentPost[] = (
    posting.length
      ? db
          .select({
            ticketId: schema.updates.ticketId,
            author: schema.updates.author,
            body: schema.updates.body,
            createdAt: schema.updates.createdAt,
          })
          .from(schema.updates)
          .where(inArray(schema.updates.ticketId, posting))
          .orderBy(desc(schema.updates.createdAt), desc(schema.updates.id))
          .limit(RECENT_POSTS)
          .all()
      : []
  ).map((p) => ({
    ticketId: p.ticketId,
    ticketTitle: titleOf.get(p.ticketId) ?? '',
    author: p.author,
    at: p.createdAt,
    line: gist(p.body),
  }))

  return {
    // The clock every duration here is measured against: silentMinutes, and how long a wait has run.
    now: now.toISOString(),
    project: { id: project.id, name: project.name },
    windowMinutes,
    stallMinutes,
    liveNow,
    recentlyActive,
    waitingOnHuman,
    inReview,
    recentPosts,
    totals: {
      liveNow: liveNow.length,
      recentlyActive: recentlyActive.length,
      waitingOnHuman: waitingOnHuman.length,
      inReview: inReview.length,
      tickets: tickets.length,
    },
  }
}

/** The first non-empty line of a post, as it is: the summary's own line, or a progress post's gist. */
function firstLine(body: string) {
  return (
    body
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  )
}

/** Each ticket's newest summary's first line, else its newest progress post's gist, in one query set. */
function stateLines(ids: number[]): Map<number, string> {
  const out = new Map<number, string>()
  if (ids.length)
    for (const r of db
      .select({
        ticketId: schema.updates.ticketId,
        body: schema.updates.body,
        createdAt: schema.updates.createdAt,
      })
      .from(schema.updates)
      .where(and(inArray(schema.updates.ticketId, ids), eq(schema.updates.summary, true)))
      .orderBy(desc(schema.updates.createdAt), desc(schema.updates.id))
      .all())
      if (!out.has(r.ticketId)) out.set(r.ticketId, firstLine(r.body))
  for (const [id, post] of lastProgressPosts(ids)) if (!out.has(id)) out.set(id, post.text)
  return out
}
