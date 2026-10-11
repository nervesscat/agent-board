import fs from 'node:fs'
import path from 'node:path'

import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, max, ne, sql } from 'drizzle-orm'

import { db, schema } from '#/db'
import { localDate } from '#/lib/format'
import { stageColumn } from '#/lib/stages'
import { dayBounds } from './activity'
import { listActors } from './actors'
import { today } from './daily'
import { gist, type LaneCounts } from './features'
import { getProject } from './projects'
import { listAgents } from './projectAgents'
import { listRepos } from './repos'
import { type ResumeTicket } from './resume'
import { isWorking, kindOf, listStages, type Stage } from './stages'
import {
  excerpt,
  getSummary,
  isBacklog,
  moveParser,
  progressSince,
  type CarryOver,
  type Post,
} from './summary'

/**
 * The summary as it was built before it was read in batches: one project at a time, about thirty
 * statements each, with its own copies of the ticket list, the human's threads and the handoff state
 * it read them through. Tests only: the batched `getSummary` must give exactly the same answer.
 */

/** The migration that added the indexes the batched reads go by. */
function indexMigration() {
  const folder = path.resolve(process.cwd(), 'drizzle')
  const file = fs.readdirSync(folder).find((f) => /^\d{4}_summary_lookup_indexes\.sql$/.test(f))
  if (!file) throw new Error('no summary_lookup_indexes migration')
  const statements = fs
    .readFileSync(path.join(folder, file), 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean)
  return { file, statements }
}

/** The indexes of that migration by name; it must hold nothing but `CREATE INDEX`. */
export function summaryIndexes() {
  const { file, statements } = indexMigration()
  return statements.map((s) => {
    const name = /^CREATE INDEX `(\w+)` ON `\w+` \([`\w,]+\)(?: WHERE [\w ]+)?;$/.exec(s)?.[1]
    if (!name) throw new Error(`${file}: not an index: ${s}`)
    return { name, create: s }
  })
}

/**
 * Runs `fn` on the database as it was before that migration, without its indexes: the query plans,
 * and so the order of tied rows, that the per-project build had.
 */
export function withoutSummaryIndexes<T>(fn: () => T): T {
  const indexes = summaryIndexes()
  for (const i of indexes) db.run(sql.raw(`DROP INDEX \`${i.name}\``))
  try {
    return fn()
  } finally {
    for (const i of indexes) db.run(sql.raw(i.create))
  }
}

/**
 * Every project's summary and each project's, serialised three ways: by the reference on the
 * database without the new indexes (as it ran before them), and by `getSummary` without and with them.
 */
export function summariesBothWays(opts: { humans?: string[]; now: Date }) {
  const scopes = [
    undefined,
    ...db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .all()
      .map((p) => p.id),
  ]
  const label = (id: number | undefined) => (id === undefined ? 'every project' : `project ${id}`)
  const before = withoutSummaryIndexes(() =>
    scopes.map((id) => ({
      label: label(id),
      reference: JSON.stringify(referenceSummary(id, opts)),
      unindexed: JSON.stringify(getSummary(id, opts)),
    })),
  )
  return before.map((b, i) => ({ ...b, batched: JSON.stringify(getSummary(scopes[i], opts)) }))
}

/** Where two serialised answers first differ, with some of each around it; null when they are the same. */
export function firstDifference(a: string, b: string): string | null {
  if (a === b) return null
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  const around = (s: string) => s.slice(Math.max(0, i - 120), i + 120)
  return `differs at ${i} of ${a.length}/${b.length}:\n  ${around(a)}\n  ${around(b)}`
}

const DAY_MS = 86_400_000
const STALE_MS = DAY_MS
const inProgress = (kind: string | undefined) => kind === 'active' || kind === 'blocked' || kind === 'review'

type Progress = { done: number; total: number }

function projectTickets(projectId: number) {
  const stages = listStages(projectId)
  const rows = db
    .select()
    .from(schema.tickets)
    .where(eq(schema.tickets.projectId, projectId))
    .orderBy(desc(schema.tickets.updatedAt))
    .all()
  const ids = rows.map((t) => t.id)
  const allTasks = ids.length
    ? db.select().from(schema.tasks).where(inArray(schema.tasks.ticketId, ids)).all()
    : []
  const own = new Map<number, Progress>(rows.map((t) => [t.id, { done: 0, total: 0 }]))
  for (const task of allTasks) {
    const p = own.get(task.ticketId)!
    p.total++
    if (task.done) p.done++
  }
  const agentNames = new Set(listAgents(projectId).map((a) => a.name.toLowerCase()))
  const openDecisions = new Map<number, number>()
  if (ids.length)
    for (const u of db
      .select({ ticketId: schema.updates.ticketId })
      .from(schema.updates)
      .where(
        and(
          inArray(schema.updates.ticketId, ids),
          isNotNull(schema.updates.decision),
          isNull(schema.updates.decidedAt),
        ),
      )
      .all())
      openDecisions.set(u.ticketId, (openDecisions.get(u.ticketId) ?? 0) + 1)
  const children = new Map<number, schema.Ticket[]>()
  for (const t of rows) if (t.parentId) children.set(t.parentId, [...(children.get(t.parentId) ?? []), t])
  const rollup = (id: number): Progress =>
    (children.get(id) ?? [])
      .filter((lane) => kindOf(stages, lane.status) !== 'cancelled')
      .reduce(
        (acc, lane) => {
          const p = rollup(lane.id)
          return { done: acc.done + p.done, total: acc.total + p.total }
        },
        { ...own.get(id)! },
      )
  return rows.map((t) => {
    const lanes: LaneCounts = { total: 0, approved: 0, disapproved: 0, byStage: {} }
    for (const lane of children.get(t.id) ?? []) {
      lanes.total++
      if (lane.approvedAt) lanes.approved++
      if (lane.disapprovedAt) lanes.disapproved++
      lanes.byStage[lane.status] = (lanes.byStage[lane.status] ?? 0) + 1
    }
    const reserved = agentNames.has(t.assignee.toLowerCase())
    const decisions = openDecisions.get(t.id) ?? 0
    return { ...t, reserved, decisions, progress: own.get(t.id)!, rollup: rollup(t.id), lanes }
  })
}

/** `listTickets(projectId)`: the project's tickets off the archive. */
function listTickets(projectId: number) {
  getProject(projectId)
  return projectTickets(projectId).filter((t) => !t.archivedAt)
}

type Row = ReturnType<typeof listTickets>[number]

/** `listHumanThreads(projectId, names)`. */
function listHumanThreads(projectId: number, me: string[]) {
  getProject(projectId)
  const isMe = (name: string) => me.includes(name)
  const tickets = db.select().from(schema.tickets).where(eq(schema.tickets.projectId, projectId)).all()
  const ticketById = new Map(tickets.map((t) => [t.id, t]))
  const updates = tickets.length
    ? db
        .select({
          id: schema.updates.id,
          ticketId: schema.updates.ticketId,
          author: schema.updates.author,
          body: schema.updates.body,
          progress: schema.updates.progress,
          decision: schema.updates.decision,
          decidedAt: schema.updates.decidedAt,
          createdAt: schema.updates.createdAt,
        })
        .from(schema.updates)
        .where(
          inArray(
            schema.updates.ticketId,
            tickets.map((t) => t.id),
          ),
        )
        .all()
    : []
  const prs = db.select().from(schema.prs).where(eq(schema.prs.projectId, projectId)).all()
  const reviews = db
    .select({
      id: schema.reviewResults.id,
      prNumber: schema.reviewResults.prNumber,
      verdict: schema.reviewResults.verdict,
      author: schema.reviewResults.author,
    })
    .from(schema.reviewResults)
    .where(eq(schema.reviewResults.projectId, projectId))
    .all()

  type Subject = { ticketId: number | null; title: string; owners: string[] }
  const subjects = new Map<string, Subject>()
  for (const t of tickets)
    subjects.set(`ticket:${t.id}`, { ticketId: t.id, title: t.title, owners: [t.assignee, t.createdBy] })
  for (const u of updates)
    subjects.set(`update:${u.id}`, {
      ticketId: u.ticketId,
      title: `post on #${u.ticketId} ${ticketById.get(u.ticketId)?.title ?? ''}: ${gist(u.body, 60)}`,
      owners: [u.author],
    })
  for (const p of prs)
    subjects.set(`pr:${p.id}`, { ticketId: null, title: `PR #${p.number} ${p.title}`, owners: [p.author] })
  for (const r of reviews)
    subjects.set(`review:${r.id}`, {
      ticketId: null,
      title: `review of PR #${r.prNumber} (${r.verdict})`,
      owners: [r.author],
    })

  const ids = (type: string) =>
    [...subjects.keys()].filter((k) => k.startsWith(`${type}:`)).map((k) => Number(k.split(':')[1]))
  const comments = (['update', 'pr', 'review'] as const).flatMap((type) => {
    const parentIds = ids(type)
    return parentIds.length
      ? db
          .select()
          .from(schema.comments)
          .where(and(eq(schema.comments.parentType, type), inArray(schema.comments.parentId, parentIds)))
          .orderBy(asc(schema.comments.createdAt), asc(schema.comments.id))
          .all()
      : []
  })
  type Said = Pick<schema.Comment, 'id' | 'parentType' | 'parentId' | 'author' | 'body' | 'createdAt'>
  const threads = new Map<string, Said[]>()
  const posts = updates.filter((u) => !u.progress)
  const openDecisions = new Set(updates.filter((u) => u.decision && !u.decidedAt).map((u) => u.id))
  for (const u of [...posts].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id)) {
    const key = `ticket:${u.ticketId}`
    const said: Said = {
      id: u.id,
      parentType: 'ticket',
      parentId: u.ticketId,
      author: u.author,
      body: u.body,
      createdAt: u.createdAt,
    }
    threads.set(key, [...(threads.get(key) ?? []), said])
  }
  for (const c of comments) {
    const key = `${c.parentType}:${c.parentId}`
    threads.set(key, [...(threads.get(key) ?? []), c])
  }

  const out = []
  for (const [key, list] of threads) {
    const subject = subjects.get(key)!
    const last = list[list.length - 1]!
    if (last.parentType === 'ticket' && openDecisions.has(last.id)) continue
    const spoke = list.some((c) => isMe(c.author))
    if (!isMe(last.author) && (spoke || subject.owners.some(isMe)))
      out.push({
        parentType: last.parentType,
        parentId: last.parentId,
        ticketId: subject.ticketId,
        title: subject.title,
        as: null,
        waiting: list.length - 1 - list.map((c) => isMe(c.author)).lastIndexOf(true),
        last: { id: last.id, author: last.author, text: gist(last.body), createdAt: last.createdAt },
      })
  }
  return out.sort((a, b) => b.last.createdAt.localeCompare(a.last.createdAt))
}

const daysBetween = (from: string, to: string) =>
  Math.round((new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86_400_000)
const dayOf = (iso: string) => localDate(new Date(iso))

/** `handoffStates(tickets, now)`. */
function handoffStates(tickets: ResumeTicket[], now: Date) {
  const ids = tickets.map((t) => t.id)
  const todayKey = localDate(now)
  const todayStart = dayBounds(todayKey).from
  const lastBefore = new Map<number, string>()
  const lastProgress = new Map<number, string>()
  if (ids.length) {
    for (const a of db
      .select({ id: schema.activity.refId, at: max(schema.activity.createdAt) })
      .from(schema.activity)
      .where(
        and(
          eq(schema.activity.refType, 'ticket'),
          inArray(schema.activity.refId, ids),
          lt(schema.activity.createdAt, todayStart),
          ne(schema.activity.kind, 'handoff'),
        ),
      )
      .groupBy(schema.activity.refId)
      .all())
      if (a.id !== null && a.at) lastBefore.set(a.id, a.at)
    for (const u of db
      .select({ id: schema.updates.ticketId, at: max(schema.updates.createdAt) })
      .from(schema.updates)
      .where(
        and(
          inArray(schema.updates.ticketId, ids),
          eq(schema.updates.progress, true),
          eq(schema.updates.handoff, false),
        ),
      )
      .groupBy(schema.updates.ticketId)
      .all())
      if (u.at) lastProgress.set(u.id, u.at)
  }
  const stagesOf = new Map<number, Stage[]>()
  const stages = (projectId: number) => {
    if (!stagesOf.has(projectId)) stagesOf.set(projectId, listStages(projectId))
    return stagesOf.get(projectId)!
  }
  const out = new Map<number, { noHandoff: boolean; day: number | null; newerProgress: boolean }>()
  for (const t of tickets) {
    const working = !t.archivedAt && isWorking(stages(t.projectId), t.status)
    const startDay = working && t.startedAt ? dayOf(t.startedAt) : null
    const carried = startDay !== null && startDay < todayKey
    const lastDay = carried
      ? [startDay, lastBefore.has(t.id) ? dayOf(lastBefore.get(t.id)!) : ''].sort().at(-1)!
      : null
    out.set(t.id, {
      noHandoff: lastDay !== null && (!t.resumeAt || dayOf(t.resumeAt) < lastDay),
      day: startDay === null ? null : daysBetween(startDay, todayKey) + 1,
      newerProgress: Boolean(t.resumeAt && (lastProgress.get(t.id) ?? '') > t.resumeAt),
    })
  }
  return out
}

/** `getSummary(projectId, opts)` without the background PR refresh. */
export function referenceSummary(
  projectId: number | undefined,
  opts: { humans?: string[]; now?: Date } = {},
) {
  const now = opts.now ?? new Date()
  const date = today(now)
  const humans = opts.humans ?? listActors().flatMap((a) => (a.kind === 'human' ? [a.name] : []))
  const projects = projectId
    ? [getProject(projectId)]
    : db.select().from(schema.projects).orderBy(asc(schema.projects.name)).all()
  return {
    date,
    generatedAt: now.toISOString(),
    projects: projects.map((p) => projectSummary(p, { now, date, humans })),
  }
}

function projectSummary(project: schema.Project, ctx: { now: Date; date: string; humans: string[] }) {
  const { now, date, humans } = ctx
  const { from, to } = dayBounds(date)
  const stages = listStages(project.id)
  const stageByKey = new Map(stages.map((s) => [s.key, s]))
  const kind = (status: string) => stageByKey.get(status)?.kind
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

  const decisions = ids.length
    ? db
        .select({
          id: schema.updates.id,
          ticketId: schema.updates.ticketId,
          author: schema.updates.author,
          body: schema.updates.body,
          decision: schema.updates.decision,
          createdAt: schema.updates.createdAt,
        })
        .from(schema.updates)
        .where(
          and(
            inArray(schema.updates.ticketId, ids),
            isNotNull(schema.updates.decision),
            isNull(schema.updates.decidedAt),
          ),
        )
        .orderBy(desc(schema.updates.createdAt))
        .all()
        .map((d) => ({
          postId: d.id,
          ticketId: d.ticketId,
          ticketTitle: byId.get(d.ticketId)?.title ?? '',
          question: gist(d.body),
          options: d.decision?.length ?? 0,
          author: d.author,
          createdAt: d.createdAt,
        }))
    : []
  const repos = listRepos(project.id)
  const repoName = (id: number | null) => repos.find((r) => r.id === id)?.name ?? null
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
    ? listHumanThreads(project.id, humans)
        .filter((th) => th.ticketId === null || byId.has(th.ticketId))
        .map(({ as: _as, ...th }) => th)
    : []
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

  const working = top.filter((t) => inProgress(kind(t.status)))
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
        rollup: t.rollup,
        lanes: t.lanes.total,
        lastPost: post,
        preview: preview(t.id),
        since,
        days: Math.round((startOfToday - new Date(`${today(new Date(since))}T00:00:00`).getTime()) / DAY_MS),
        stale:
          kind(t.status) !== 'review' &&
          now.getTime() - new Date(post?.createdAt ?? since).getTime() > STALE_MS,
        updatedAt: t.updatedAt,
      }
    })
    .sort((a, b) => rank(a.status) - rank(b.status) || b.updatedAt.localeCompare(a.updatedAt))

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

  const open = stages.filter((s) => s.kind === 'open')
  const nextStage = open.find((s) => !isBacklog(s)) ?? open.at(-1) ?? null
  const column = nextStage ? stageColumn(top, nextStage.key) : []

  return {
    project: { id: project.id, name: project.name },
    stages: stages.map(({ key, name, kind, color }) => ({ key, name, kind, color })),
    agents: listAgents(project.id).map((a) => ({ name: a.name, avatarUrl: a.avatarUrl })),
    needsYou: {
      decisions,
      prs: prsToReview,
      threads,
      reviews,
      total: decisions.length + prsToReview.length + threads.length + reviews.length,
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
    carryingOver: carryOver(
      progress.filter((t) => new Date(t.since).getTime() < startOfToday),
      byId,
      now,
    ),
  }
}

function carryOver(items: Omit<CarryOver, 'resume'>[], byId: Map<number, Row>, now: Date): CarryOver[] {
  const rows = items.map((t) => byId.get(t.id)!)
  const handoffs = handoffStates(rows, now)
  return items.map(({ id, title, status, kind, assignee, since, days, lastPost, stale }, i) => {
    const t = rows[i]!
    const h = handoffs.get(id)!
    return {
      id,
      title,
      status,
      kind,
      assignee,
      since,
      days,
      lastPost,
      stale,
      resume: {
        note: excerpt(t.resumeNote),
        at: t.resumeAt,
        by: t.resumeBy,
        noHandoff: h.noHandoff,
        stale: h.newerProgress,
        day: h.day,
      },
    }
  })
}

function lastProgressPosts(ids: number[]): Map<number, Post> {
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

function previewsOf(ids: number[]) {
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
