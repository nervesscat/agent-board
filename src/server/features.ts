import { and, asc, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'

import { db, schema } from '#/db'
import { retryWhileLocked } from '#/db/busy'
import { COMMENT_PARENTS, type Complexity, DEFAULT_COMPLEXITY, type FeedTab } from '#/lib/constants'
import { AUTO_PHASE_RULE, autoPhaseOf } from '#/lib/autoPhases'
import { columnOrder, placeInColumn, stageColumn } from '#/lib/stages'
import { MAX_TAG_LENGTH, MAX_TAGS } from '#/lib/tags'
import { logActivity } from './activity'
import { reconcileTicket } from './autoPhases'
import { isHumanName, lastHuman, listActors } from './actors'
import { baseChain, gitCache, type GitCache, infoOf, reachOf } from './cleanup'
import { NO_BRANCH } from './git'
import { HttpError, notFound } from './http'
import { getProject } from './projects'
import { actingAs, findAgent, listAgents, mentions } from './projectAgents'
import {
  cannotStart,
  forgetPreview,
  managedPreview,
  previewToolProblem,
  stopPreviewsFor,
} from './managedPreview'
import { previewState, previewUrl, type PreviewState } from './preview'
import { cancelSupersededPrTickets, prTicketStage } from './prTickets'
import { prForTicket, prStatus, refreshPrsInBackground, withMergeCheck } from './prs'
import { NO_PUSH, pushStates } from './push'
import {
  checkRepoRequest,
  getRepo,
  insertRequestedRepo,
  repoRequestProblem,
  requestedRepo,
  requestOrigin,
  resolveRepo,
  ticketRepo,
} from './repos'
import { reportDueFor } from './reportDue'
import { stopRunsFor } from './runs'
import {
  resolveTicketRepos,
  syncPrimaryRow,
  ticketRepoList,
  type TicketRepoInput,
  workspaceRepo,
  writeOtherRepos,
} from './ticketRepos'
import {
  firstOfKind,
  kindOf,
  listStages,
  matchStages,
  movePatch,
  projectWorkStage,
  resolveStage,
  startStage,
  startedPatch,
  stageOf,
} from './stages'
import { assertUnattached, attachTo, attachmentView } from './uploads'
import { noteBoardEvent, noteStageMove } from './workTimeline'

// --- tickets ---

type Progress = { done: number; total: number }
export type LaneCounts = {
  total: number
  approved: number
  disapproved: number
  /** Lanes per stage key. */
  byStage: Record<string, number>
}

/**
 * The ticket's tasks as one flat list in tree order: each top-level task, then its subtasks, by
 * ascending position (id breaks a tie) — the order `getTicketFull` hands them out in.
 */
function treeTasks<T extends Pick<schema.Task, 'id' | 'parentId' | 'position'>>(tasks: T[]): T[] {
  const rank = (a: T, b: T) => a.position - b.position || a.id - b.id
  return tasks
    .filter((task) => task.parentId === null)
    .sort(rank)
    .flatMap((task) => [task, ...tasks.filter((sub) => sub.parentId === task.id).sort(rank)])
}

/**
 * The task a ticket works next: the first open one in tree order that is no container. An open parent
 * with open subtasks is skipped in favour of its subtasks (its last one ticked settles it done), so a
 * blocked parent surfaces only once it is its own first open task. Null when every task is done.
 */
export function nextTask<T extends Pick<schema.Task, 'id' | 'parentId' | 'position' | 'done'>>(
  tasks: T[],
): T | null {
  const openParents = new Set(
    tasks.flatMap((task) => (!task.done && task.parentId !== null ? [task.parentId] : [])),
  )
  return treeTasks(tasks).find((task) => !task.done && !openParents.has(task.id)) ?? null
}

/**
 * Every ticket of a project with its own task progress, the progress rolled up over its lanes (and
 * theirs), how many of those tasks are blocked on the human and whether one of them is the step the
 * ticket (or a lane of it) works next, and how many lanes it has in each stage. One pass over the
 * project keeps this cheap. A PR's own ticket is left out unless `prTickets` (a ticket's own page
 * reads it that way): it lives in the PR queue, not on the features board.
 */
function projectTickets(projectId: number, opts: { prTickets?: boolean } = {}) {
  const stages = listStages(projectId)
  const rows = db
    .select()
    .from(schema.tickets)
    .where(
      and(eq(schema.tickets.projectId, projectId), opts.prTickets ? undefined : isNull(schema.tickets.prId)),
    )
    .orderBy(desc(schema.tickets.updatedAt))
    .all()
  const ids = rows.map((t) => t.id)
  const allTasks = ids.length
    ? db.select().from(schema.tasks).where(inArray(schema.tasks.ticketId, ids)).all()
    : []
  const own = new Map<number, Progress>(rows.map((t) => [t.id, { done: 0, total: 0 }]))
  const ownTasks = new Map<number, schema.Task[]>()
  for (const task of allTasks) ownTasks.set(task.ticketId, [...(ownTasks.get(task.ticketId) ?? []), task])
  const ownBlocked = new Map<number, number>()
  for (const task of allTasks) {
    const p = own.get(task.ticketId)!
    p.total++
    if (task.done) p.done++
    else if (task.blocked) ownBlocked.set(task.ticketId, (ownBlocked.get(task.ticketId) ?? 0) + 1)
  }
  const agentNames = new Set(listAgents(projectId).map((a) => a.name.toLowerCase()))
  // Decisions still waiting on the human, per ticket.
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
  // A cancelled lane's tasks are no longer part of the work.
  const workingLanes = (id: number) =>
    (children.get(id) ?? []).filter((lane) => kindOf(stages, lane.status) !== 'cancelled')
  const rollup = (id: number): Progress =>
    workingLanes(id).reduce(
      (acc, lane) => {
        const p = rollup(lane.id)
        return { done: acc.done + p.done, total: acc.total + p.total }
      },
      { ...own.get(id)! },
    )
  // Its open tasks and subtasks tagged blocked, its lanes' with them: the same scope as the rollup.
  const blockedTasks = (id: number): number =>
    workingLanes(id).reduce((n, lane) => n + blockedTasks(lane.id), ownBlocked.get(id) ?? 0)
  // Whether a blocked step is the one the ticket (or a lane of it) works next, which is what makes it
  // something the human is actually stopped by. The count above stays every blocked step.
  const nextBlocked = new Map(rows.map((t) => [t.id, nextTask(ownTasks.get(t.id) ?? [])?.blocked === true]))
  const blockedNext = (id: number): boolean =>
    workingLanes(id).some((lane) => blockedNext(lane.id)) || nextBlocked.get(id) === true
  return rows.map((t) => {
    const lanes: LaneCounts = { total: 0, approved: 0, disapproved: 0, byStage: {} }
    for (const lane of children.get(t.id) ?? []) {
      lanes.total++
      if (lane.approvedAt) lanes.approved++
      if (lane.disapprovedAt) lanes.disapproved++
      lanes.byStage[lane.status] = (lanes.byStage[lane.status] ?? 0) + 1
    }
    // Assigned to one of the project's agents: only that agent works it.
    const reserved = agentNames.has(t.assignee.toLowerCase())
    const decisions = openDecisions.get(t.id) ?? 0
    return {
      ...t,
      reserved,
      decisions,
      blockedTasks: blockedTasks(t.id),
      blockedNext: blockedNext(t.id),
      progress: own.get(t.id)!,
      rollup: rollup(t.id),
      lanes,
    }
  })
}

/** The project agent a ticket is reserved for, or null when it is shared. */
export const reservedFor = (t: Pick<schema.Ticket, 'projectId' | 'assignee'>) =>
  findAgent(t.projectId, t.assignee)

/** A row of a ticket list as reads hand it out. */
export type TicketRow = ReturnType<typeof projectTickets>[number]

/** The lanes under a ticket, all the way down, nearest first. */
export function laneTree<T extends Pick<schema.Ticket, 'id' | 'parentId'>>(all: T[], id: number): T[] {
  const out: T[] = []
  for (let queue = all.filter((t) => t.parentId === id); queue.length; ) {
    const next = queue.shift()!
    out.push(next)
    queue.push(...all.filter((t) => t.parentId === next.id))
  }
  return out
}

export interface TicketFilter {
  parentId?: number | null
  tag?: string
  /** Stage keys, names or kinds (`review` takes in every stage of that kind). */
  status?: string[]
  assignee?: string
  /** Text found in the ticket's number, title, instructions or thread (`searchTickets`). */
  q?: string
  /** Archived tickets are left out unless `include` (with the rest) or `only` (just those). */
  archived?: 'include' | 'only'
}

/**
 * Where a search found a ticket, best first: its number (`#12` or `12`) or its title, which make up its
 * name, then its instructions, one of its posts, or a reply under one of them, which are its content.
 */
export type TicketMatch = 'id' | 'title' | 'body' | 'post' | 'reply'
/** A row found by a search: where, and for a content match the words around the first hit. */
export type TicketHit = { match: TicketMatch; snippet: string | null }

type ListedTicket = ReturnType<typeof projectTickets>[number] & Partial<TicketHit>

/**
 * A project's tickets; `parentId` narrows to the lanes of one ticket (`null` to the top level), `tag`
 * to those carrying it (any casing), `status` to those stages, `assignee` to one name (`''` for
 * unassigned). Archived tickets only with `archived`. `q` keeps the tickets it is found in, those found
 * by name first, each row saying where (`searchTickets`). Last updated first, except that the tickets
 * of one column (same stage, same parent) come in the column's order among themselves: the ones placed
 * there first.
 */
export function listTickets(projectId: number, filter: TicketFilter = {}): ListedTicket[] {
  getProject(projectId)
  const tag = filter.tag?.trim().toLowerCase()
  const q = filter.q?.trim()
  const stages = filter.status?.length ? matchStages(listStages(projectId), filter.status) : null
  const rows = inColumnOrder(projectTickets(projectId)).filter(
    (t) =>
      (filter.parentId === undefined || t.parentId === filter.parentId) &&
      (!tag || t.tags.some((x) => x.toLowerCase() === tag)) &&
      (!stages || stages.has(t.status)) &&
      (filter.assignee === undefined || t.assignee === filter.assignee) &&
      (filter.archived === 'include' || (filter.archived === 'only') === Boolean(t.archivedAt)),
  )
  return q ? searchTickets(rows, q) : rows
}

/**
 * `rows` with each column's tickets (same parent, same stage) put in the column's order, in the places
 * that column's tickets held: a list where nothing was placed comes back as it was.
 */
function inColumnOrder<T extends schema.Ticket>(rows: T[]): T[] {
  const column = (t: T) => `${t.parentId ?? ''}:${t.status}`
  const columns = new Map<string, T[]>()
  for (const t of rows) columns.set(column(t), [...(columns.get(column(t)) ?? []), t])
  for (const list of columns.values()) list.sort(columnOrder)
  return rows.map((t) => columns.get(column(t))!.shift()!)
}

/**
 * The tickets among `rows` that `q` is found in, as a literal piece of text in any casing: by name (its
 * number, `#12` or `12`, or in its title) first, then by content (its instructions, or the current text
 * of one of its own posts or of a reply under one), each group in the order `rows` had. A lane's
 * thread is its own: it does not bring up its parent. Only the words around a hit leave the server.
 */
function searchTickets<T extends schema.Ticket>(rows: T[], q: string): (T & TicketHit)[] {
  const needle = q.toLowerCase()
  const number = /^#?(\d+)$/.exec(q)?.[1]
  const hits = new Map<number, TicketHit>()
  for (const t of rows) {
    if (number !== undefined && t.id === Number(number)) hits.set(t.id, { match: 'id', snippet: null })
    else if (t.title.toLowerCase().includes(needle)) hits.set(t.id, { match: 'title', snippet: null })
    else {
      const snippet = snippetOf(t.body, needle)
      if (snippet !== null) hits.set(t.id, { match: 'body', snippet })
    }
  }
  // The thread, newest first, read only for the tickets not found yet.
  const unfound = () => rows.filter((t) => !hits.has(t.id)).map((t) => t.id)
  let ids = unfound()
  if (ids.length)
    for (const p of db
      .select({ ticketId: schema.updates.ticketId, body: schema.updates.body })
      .from(schema.updates)
      .where(inArray(schema.updates.ticketId, ids))
      .orderBy(desc(schema.updates.createdAt), desc(schema.updates.id))
      .all()) {
      if (hits.has(p.ticketId)) continue
      const snippet = snippetOf(p.body, needle)
      if (snippet !== null) hits.set(p.ticketId, { match: 'post', snippet })
    }
  ids = unfound()
  if (ids.length)
    for (const r of db
      .select({ ticketId: schema.updates.ticketId, body: schema.comments.body })
      .from(schema.comments)
      .innerJoin(
        schema.updates,
        and(eq(schema.comments.parentType, 'update'), eq(schema.comments.parentId, schema.updates.id)),
      )
      .where(inArray(schema.updates.ticketId, ids))
      .orderBy(desc(schema.comments.createdAt), desc(schema.comments.id))
      .all()) {
      if (hits.has(r.ticketId)) continue
      const snippet = snippetOf(r.body, needle)
      if (snippet !== null) hits.set(r.ticketId, { match: 'reply', snippet })
    }
  const found = rows.flatMap((t) => {
    const hit = hits.get(t.id)
    return hit ? [{ ...t, ...hit }] : []
  })
  const byName = (t: TicketHit) => t.match === 'id' || t.match === 'title'
  return [...found.filter(byName), ...found.filter((t) => !byName(t))]
}

const SNIPPET = 120

/**
 * The words around the first place `needle` (lowercased) is in `text`, in any casing: one line of at
 * most 120 characters, `…` where it was cut. Null when it is not there.
 */
export function snippetOf(text: string, needle: string): string | null {
  const lower = text.toLowerCase()
  const at = lower.indexOf(needle)
  if (at < 0) return null
  let start = at
  let end = at + needle.length
  // Lowercasing makes a few characters longer (İ): find where the hit sits in the text itself.
  if (lower.length !== text.length) {
    let pos = 0
    let i = 0
    for (const ch of text) {
      if (pos <= at) start = i
      pos += ch.toLowerCase().length
      i += ch.length
      if (pos >= at + needle.length) {
        end = i
        break
      }
    }
  }
  let from = Math.max(0, Math.min(start - 40, text.length - SNIPPET))
  if (end - start >= SNIPPET) from = start
  else if (end > from + SNIPPET) from = end - SNIPPET
  let to = Math.min(text.length, from + SNIPPET)
  // Never half of a character written as two.
  if (from > 0 && /[\uDC00-\uDFFF]/.test(text[from]!)) from++
  if (to < text.length && /[\uD800-\uDBFF]/.test(text[to - 1]!)) to--
  const words = text.slice(from, to).replace(/\s+/g, ' ').trim()
  return `${from > 0 ? '…' : ''}${words}${to < text.length ? '…' : ''}`
}

export function getTicket(id: number) {
  const t = db.select().from(schema.tickets).where(eq(schema.tickets.id, id)).get()
  if (!t) throw notFound('ticket')
  return t
}

/**
 * The whole ticket page in one read: tasks, workspaces, the parent chain, its lanes with their last
 * update, and the update feed with attachments (with `laneUpdates`, the lanes' updates too, all the way
 * down).
 */
export function getTicketFull(id: number, opts: { laneUpdates?: boolean } = {}) {
  const ticket = getTicket(id)
  const all = projectTickets(ticket.projectId, { prTickets: true })
  const byId = new Map(all.map((t) => [t.id, t]))
  const self = byId.get(id)!
  const ancestors: { id: number; title: string }[] = []
  for (let p = ticket.parentId; p; p = byId.get(p)?.parentId ?? null) {
    const parent = byId.get(p)
    if (!parent) break
    ancestors.unshift({ id: parent.id, title: parent.title })
  }
  const lanes = all.filter((t) => t.parentId === id)
  const descendants = laneTree(all, id).map((t) => t.id)

  const taskRows = db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.ticketId, id))
    .orderBy(asc(schema.tasks.position), asc(schema.tasks.id))
    .all()
  // One flat list in tree order: each top-level task, then its subtasks. `auto`: a phase the board
  // ticks itself (#/lib/autoPhases), which nobody ticks by hand.
  const tasks = treeTasks(taskRows).map((task) => ({ ...task, auto: autoPhaseOf(task) !== null }))
  const workspaces = db.select().from(schema.workspaces).where(eq(schema.workspaces.ticketId, id)).all()
  const updates = db
    .select()
    .from(schema.updates)
    .where(inArray(schema.updates.ticketId, [id, ...descendants]))
    .orderBy(desc(schema.updates.createdAt), desc(schema.updates.id))
    .all()
  // Each lane's newest progress post from anywhere under it, its own lanes included.
  const laneOf = (ticketId: number) => {
    let t = byId.get(ticketId)
    while (t && t.parentId !== id) t = t.parentId ? byId.get(t.parentId) : undefined
    return t?.id
  }
  const lastUpdate = new Map<number, (typeof updates)[number]>()
  for (const u of updates) {
    const lane = u.ticketId === id ? undefined : laneOf(u.ticketId)
    if (lane && u.progress && !lastUpdate.has(lane)) lastUpdate.set(lane, u)
  }
  const feed = opts.laneUpdates ? updates : updates.filter((u) => u.ticketId === id)
  const updateIds = feed.map((u) => u.id)
  const files = updateIds.length
    ? db.select().from(schema.attachments).where(inArray(schema.attachments.updateId, updateIds)).all()
    : []
  // The ticket's conversation is its own posts: how many, and who posted last.
  const own = updates.filter((u) => u.ticketId === id)
  const ticketThread: ThreadStats = own.length
    ? { count: own.length, lastAuthor: own[0]!.author, lastAt: own[0]!.createdAt }
    : NO_THREAD
  const updateThreads = threadStats('update', updateIds)
  const instructionFiles = db
    .select()
    .from(schema.attachments)
    .where(eq(schema.attachments.ticketId, id))
    .orderBy(asc(schema.attachments.createdAt), asc(schema.attachments.id))
    .all()
  const agent = reservedFor(ticket)
  const humans = listActors().flatMap((a) => (a.kind === 'human' ? [a.name] : []))
  return {
    ...ticket,
    reserved: self.reserved,
    // The ticket's summary at the top of the feed's main tab: the newest version, or until there is one,
    // the post that stands in for it. Null when there is neither.
    summary: summaryOf(own, humans, files),
    // Set when the ticket is reserved for one of the project's agents: who to brief, and with what.
    agent: agent
      ? { id: agent.id, name: agent.name, instructions: agent.instructions, avatarUrl: agent.avatarUrl }
      : null,
    // Files that go with the instructions, each with a local path.
    attachments: instructionFiles.map((f) => attachmentView(f)),
    // The ticket's own posts (count, who posted last); each post carries the thread of its replies below.
    thread: ticketThread,
    pr: prForTicket(ticket),
    // The repos its work spans, the primary (its repoId, branch, baseBranch, prNumber) first.
    repos: ticketRepoList(ticket),
    tasks,
    // managedPreview: the preview the board builds and runs from the workspace, if it ever ran one.
    workspaces: workspaces.map((w) => ({ ...w, managedPreview: managedPreview(w.id) })),
    progress: self.progress,
    rollup: self.rollup,
    blockedTasks: self.blockedTasks,
    ancestors,
    lanes: lanes.map((l) => {
      const u = lastUpdate.get(l.id)
      return {
        ...l,
        lastUpdate: u ? { author: u.author, text: gist(u.body), createdAt: u.createdAt } : null,
      }
    }),
    updates: feed.map((u) => ({
      ...u,
      // Set on a lane's post shown in its parent's feed.
      lane: u.ticketId === id ? null : { id: u.ticketId, title: byId.get(u.ticketId)?.title ?? '' },
      attachments: files.filter((f) => f.updateId === u.id).map((f) => attachmentView(f)),
      thread: updateThreads.get(u.id) ?? NO_THREAD,
    })),
  }
}

type Post = schema.Update

/** One version of a ticket's summary, as reads hand it out. */
function summaryVersion(u: Post, files: schema.Attachment[]) {
  return {
    postId: u.id,
    body: u.body,
    change: u.summaryChange,
    at: u.createdAt,
    by: u.author,
    via: u.via,
    attachments: files.filter((f) => f.updateId === u.id).map((f) => attachmentView(f)),
  }
}

/**
 * The summary of a ticket, from its own posts newest first: the newest summary version, with how many
 * there are. Until one is written, the post that stands in for it (`fallback`, summaryStandIn), read as
 * it is and never copied. Null with neither.
 */
function summaryOf(own: Post[], humans: string[], files: schema.Attachment[]) {
  const versions = own.filter((u) => u.summary)
  const current = versions[0] ?? summaryStandIn(own, humans)
  if (!current) return null
  return { ...summaryVersion(current, files), versions: versions.length, fallback: !current.summary }
}

/**
 * The post shown as the summary of a ticket that has none yet, from its posts newest first: the newest
 * progress post by an agent. The Summary phase goes by the same post until a summary is written.
 */
export const summaryStandIn = <T extends Pick<Post, 'author' | 'progress' | 'summary'>>(
  own: T[],
  humans: string[],
) => own.find((u) => u.progress && !u.summary && !humans.includes(u.author))

export type TicketSummary = NonNullable<ReturnType<typeof summaryOf>>

/** Every version of a ticket's summary, newest first, each with its files: its history. */
export function summaryHistory(ticketId: number) {
  getTicket(ticketId)
  const rows = db
    .select()
    .from(schema.updates)
    .where(and(eq(schema.updates.ticketId, ticketId), eq(schema.updates.summary, true)))
    .orderBy(desc(schema.updates.createdAt), desc(schema.updates.id))
    .all()
  const ids = rows.map((r) => r.id)
  const files = ids.length
    ? db.select().from(schema.attachments).where(inArray(schema.attachments.updateId, ids)).all()
    : []
  return rows.map((u) => summaryVersion(u, files))
}

/** A ticket in full as reads hand it out. */
export type TicketFull = ReturnType<typeof getTicketFull>

/** Where a new ticket goes: its parent (in the same project), its repo, and the branch it starts from. */
export function placement(
  projectId: number,
  input: { repoId?: number | null; parentId?: number | null; baseBranch?: string },
) {
  getProject(projectId)
  const parent = input.parentId ? getTicket(input.parentId) : null
  if (parent && parent.projectId !== projectId)
    throw new HttpError(400, `ticket ${parent.id} is not in project ${projectId}`)
  const repo = resolveRepo(projectId, input.repoId ?? parent?.repoId ?? (parent && ticketRepo(parent)?.id))
  // A lane branches off its parent's branch when they share a repo, so its PR goes back into it.
  const parentBase = parent && ticketRepo(parent)?.id === repo.id ? parent.branch || parent.baseBranch : ''
  return { parent, repo, baseBranch: input.baseBranch || parentBase || repo.baseBranch }
}

/**
 * `getTicketFull` with whether each branch is on origin: `push` on the ticket (its branch) and on each
 * of its workspaces, from one batch of git in the ticket's checkout. A branch gone from origin counts
 * as merged once it is in the ticket's base. Its PR's merge state is checked in the checkout against
 * origin's base as just read, and the project's PRs are refreshed in the background when they are as
 * stale as the queue would refresh them.
 */
export async function getTicketWithPush(id: number, opts: { laneUpdates?: boolean } = {}) {
  let t = getTicketFull(id, opts)
  const repo = ticketRepo(t)
  const branches = [t.branch, ...t.workspaces.map((w) => w.branch)]
  const push = repo
    ? await pushStates(repo.repoPath, branches, new Map(branches.map((b) => [b, t.baseBranch])))
    : null
  if (t.prNumber || t.branch) refreshPrsInBackground(t.projectId)
  // The phases the board ticks follow what was just read, before the tasks are handed out (and a ticket
  // seeded before Merged was built in is looked at for it once).
  if (
    (t.tasks.some((task) => task.auto) || !t.mergedPhaseChecked) &&
    (await reconcileTicket(t, push ? (push.get(t.branch) ?? null) : null, t.workspaces))
  )
    t = getTicketFull(id, opts)
  return {
    ...t,
    pr: await withMergeCheck(t.pr),
    push: push?.get(t.branch) ?? NO_PUSH,
    workspaces: t.workspaces.map((w) => ({ ...w, push: push?.get(w.branch) ?? NO_PUSH })),
  }
}

/**
 * A new ticket's own fields as `createTicket` stores them: with `repos`, the first is the primary, its
 * repo, and its branch, base and PR where the input gives none. What a create into a done stage
 * judges its needs against too.
 */
export function newTicketPrimary<
  T extends {
    repoId?: number | null
    branch?: string
    baseBranch?: string
    prNumber?: number | null
    repos?: TicketRepoInput[]
  },
>(input: T): T {
  const first = input.repos?.[0]
  if (input.repos && !first) throw new HttpError(400, 'repos: a ticket has at least one repo')
  if (!first) return input
  return {
    ...input,
    repoId: first.repoId,
    branch: input.branch || first.branch,
    baseBranch: input.baseBranch || first.baseBranch,
    prNumber: input.prNumber !== undefined ? input.prNumber : first.prNumber,
  }
}

export function createTicket(
  projectId: number,
  input: {
    title: string
    body?: string
    /** A stage key, name or kind; the project's last open stage when left out. */
    status?: string
    /** How much review it gets; a lane's parent's when left out, else the default. */
    complexity?: Complexity
    assignee?: string
    branch?: string
    baseBranch?: string
    repoId?: number | null
    parentId?: number | null
    tags?: string[]
    /** Top-level tasks, each with its subtasks when given as `{ text, subtasks }`. */
    tasks?: NewTask[]
    prNumber?: number | null
    /** Uploads (POST /api/uploads) that go with the instructions. */
    attachmentIds?: number[]
    /** The repos its work spans, each with its branch; the first is the primary (repoId, branch…). */
    repos?: TicketRepoInput[]
  },
  actor: string,
) {
  input = newTicketPrimary(input)
  const { parent, repo, baseBranch } = placement(projectId, input)
  // Checked before the ticket exists: a bad repo does not leave a ticket behind without them.
  if (input.repos)
    resolveTicketRepos(
      { id: 0, projectId, repoId: repo.id, branch: '', baseBranch, prNumber: null },
      input.repos,
    )
  if (parent?.prId) throw new HttpError(400, `ticket ${parent.id} is a PR's: it has no lanes`)
  // Checked before the ticket exists, so a bad file does not leave a ticket behind without its files.
  const attachmentIds = input.attachmentIds ?? []
  assertUnattached(attachmentIds)
  // So is each task's tag: a bad one would otherwise leave the ticket behind without its tasks.
  if (input.tasks) newTaskTags(input.tasks)
  const stages = listStages(projectId)
  const status = (
    input.status
      ? resolveStage(stages, input.status, projectWorkStage(projectId, stages))
      : startStage(stages)
  ).key
  // The ticket and everything a create writes with it land together, and a create that lost the
  // database's write lock to another connection tries again rather than answering a 500: neither a
  // burst of creates nor a failed one leaves a ticket without its rows or its rows without a ticket.
  // `IMMEDIATE` takes the lock before the first read, so a competing writer is waited out instead of
  // making the transaction's snapshot stale.
  return retryWhileLocked(() =>
    db.transaction(
      () => {
        const row = db
          .insert(schema.tickets)
          .values({
            projectId,
            repoId: repo.id,
            parentId: parent?.id ?? null,
            title: input.title,
            body: input.body ?? '',
            status,
            ...startedPatch(stages, null, status),
            // A lane copies its parent's level as it is now; a later change to the parent does not reach it.
            complexity: input.complexity ?? parent?.complexity ?? DEFAULT_COMPLEXITY,
            assignee: input.assignee ?? '',
            branch: input.branch ?? '',
            baseBranch,
            tags: cleanTags(input.tags ?? []),
            prNumber: input.prNumber ?? null,
            createdBy: actor,
            // Seeded with the phases in effect now: Merged is not added to it later.
            mergedPhaseChecked: true,
          })
          .returning()
          .get()
        syncPrimaryRow(row)
        if (input.repos) writeOtherRepos(row.id, resolveTicketRepos(row, input.repos))
        noteStageMove(row.id, null, row.status)
        if (row.prNumber) noteBoardEvent(row.id, 'pr', { note: `PR #${row.prNumber}` })
        if (input.tasks?.length) addTasks(row.id, input.tasks, actor, { quiet: true })
        if (attachmentIds.length) attachTo(attachmentIds, { ticketId: row.id })
        if (parent) touch(parent.id)
        logActivity({
          projectId,
          actor,
          kind: 'ticket',
          text: parent
            ? `opened lane #${row.id} ${row.title} under #${parent.id} ${parent.title}`
            : `created ticket #${row.id} ${row.title}`,
          refType: 'ticket',
          refId: row.id,
        })
        if (row.prNumber || row.branch) takeOverPrTickets(row, actor)
        return row
      },
      { behavior: 'immediate' },
    ),
  )
}

/**
 * A feature ticket that names a PR (by its number, or its branch as the PR's head) takes the PR over from the
 * PR's own ticket: that one is cancelled, and its feed says where the PR went.
 */
function takeOverPrTickets(t: schema.Ticket, actor: string) {
  for (const own of cancelSupersededPrTickets(t, actor))
    postUpdate(
      own.id,
      `PR #${own.number} has a feature ticket now, #${t.id} ${t.title}, so this ticket is cancelled.`,
      [],
      actor,
    )
}

/** Bump a ticket and its parents, so a busy lane keeps its parent near the top of the board. */
function touch(ticketId: number) {
  const row = db
    .update(schema.tickets)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(schema.tickets.id, ticketId))
    .returning({ parentId: schema.tickets.parentId })
    .get()
  if (row?.parentId) touch(row.parentId)
}

/** Trimmed, cut to `MAX_TAG_LENGTH` characters each, no repeats in any casing, at most `MAX_TAGS`. */
export function cleanTags(tags: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags) {
    const tag = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LENGTH)
    if (!tag || seen.has(tag.toLowerCase())) continue
    seen.add(tag.toLowerCase())
    out.push(tag)
  }
  return out.slice(0, MAX_TAGS)
}

type TicketFieldsPatch = Partial<
  Pick<
    schema.Ticket,
    | 'title'
    | 'body'
    | 'status'
    | 'complexity'
    | 'assignee'
    | 'branch'
    | 'baseBranch'
    | 'repoId'
    | 'tags'
    | 'prNumber'
  >
>

/**
 * What an update writes to a ticket's primary: the repos list it produces (null when its repos stay as
 * they are) and the fields with the new primary's own repo, branch, base and PR filled in. The needs
 * check judges a ticket against the same primary the write produces.
 */
export function plannedPrimary(
  before: schema.Ticket,
  reposGiven: TicketRepoInput[] | undefined,
  fields: TicketFieldsPatch,
): { repos: ReturnType<typeof resolveTicketRepos> | null; patch: TicketFieldsPatch } {
  const reposBefore = ticketRepoList(before)
  // A repoId alone naming another repo the ticket spans makes that one the primary, with its own
  // branch, base and PR; the old primary stays as one of its other repos, with its own. Any other
  // repoId replaces the primary's repo, keeping the ticket's branch.
  const reposInput =
    reposGiven ??
    (fields.repoId != null && !before.prId && reposBefore.slice(1).some((e) => e.repoId === fields.repoId)
      ? reposBefore.map((e) => ({ repoId: e.repoId }))
      : undefined)
  let repos: ReturnType<typeof resolveTicketRepos> | null = null
  let patch = fields
  if (reposInput) {
    if (before.prId)
      throw new HttpError(400, `ticket ${before.id} is PR #${before.prNumber}'s: its repos cannot change`)
    // Refused as such before a repoId given with it is looked for in it.
    if (!reposInput.length) throw new HttpError(400, 'repos: a ticket has at least one repo')
    // A repoId given with the list names its primary: that entry goes first, the rest keep their order.
    let ordered = reposInput
    if (fields.repoId !== undefined) {
      const at = reposInput.findIndex((e) => e.repoId === fields.repoId)
      if (at < 0) throw new HttpError(400, `repoId: repo ${fields.repoId} is not one of the repos listed`)
      ordered = [reposInput[at]!, ...reposInput.filter((_, i) => i !== at)]
    }
    repos = resolveTicketRepos(before, ordered)
    const primary = repos[0]!
    // The list says what the primary is; a field given alongside it still has the last word.
    patch = {
      repoId: primary.repoId,
      branch: primary.branch,
      baseBranch: primary.baseBranch,
      prNumber: primary.prNumber,
      ...patch,
    }
  }
  return { repos, patch }
}

export function updateTicket(
  id: number,
  patch: TicketFieldsPatch & {
    /** Replaces the ticket's repos; the first is the primary, which the fields above also write. */
    repos?: TicketRepoInput[]
  },
  actor: string,
  opts: { agent?: boolean } = {},
) {
  const before = getTicket(id)
  const { repos: reposGiven, ...fields } = patch
  const reposBefore = ticketRepoList(before)
  const planned = plannedPrimary(before, reposGiven, fields)
  const repos = planned.repos
  patch = planned.patch
  if (before.prId) {
    // A PR's own ticket is for that PR, in that repo, and has no branch of its own.
    if (
      (patch.prNumber !== undefined && patch.prNumber !== before.prNumber) ||
      (patch.repoId !== undefined && patch.repoId !== before.repoId)
    )
      throw new HttpError(400, `ticket ${id} is PR #${before.prNumber}'s: its PR and repo cannot change`)
    if (patch.branch !== undefined && patch.branch !== before.branch)
      throw new HttpError(400, `ticket ${id} is PR #${before.prNumber}'s: it has no branch of its own`)
  }
  if (patch.assignee !== undefined && patch.assignee !== before.assignee) {
    // Tickets are shared between agents, except one the human reserved for one of the project's agents.
    const holder = opts.agent ? reservedFor(before) : null
    if (holder)
      throw new HttpError(409, `ticket ${id} is reserved for ${holder.name}; only the human reassigns it`)
    const agent = findAgent(before.projectId, patch.assignee)
    if (agent) patch = { ...patch, assignee: agent.name }
  }
  if (patch.repoId) resolveRepo(before.projectId, patch.repoId)
  if (patch.tags) patch = { ...patch, tags: cleanTags(patch.tags) }
  const stages = listStages(before.projectId)
  if (patch.status)
    patch = {
      ...patch,
      status: resolveStage(stages, patch.status, projectWorkStage(before.projectId, stages)).key,
    }
  const row = db
    .update(schema.tickets)
    .set({
      ...patch,
      ...(patch.status ? movePatch(stages, before.status, patch.status, before.startedAt) : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.tickets.id, id))
    .returning()
    .get()!
  noteStageMove(id, before.status, row.status)
  if (row.prNumber !== null && row.prNumber !== before.prNumber)
    noteBoardEvent(id, 'pr', { note: `PR #${row.prNumber}` })
  const changes: string[] = []
  if (patch.status && patch.status !== before.status) {
    changes.push(`status ${stageOf(stages, before.status).name} → ${stageOf(stages, patch.status).name}`)
    stopIfClosed(row, stages, actor)
  }
  if (patch.assignee !== undefined && patch.assignee !== before.assignee)
    changes.push(`assignee → ${patch.assignee || 'nobody'}`)
  if (patch.branch !== undefined && patch.branch !== before.branch)
    changes.push(`branch → ${patch.branch || 'none'}`)
  if (patch.prNumber !== undefined && patch.prNumber !== before.prNumber)
    changes.push(`PR → ${patch.prNumber ? `#${patch.prNumber}` : 'none'}`)
  if (patch.repoId && patch.repoId !== before.repoId) {
    const from = ticketRepo(before)
    if (from?.id !== patch.repoId)
      changes.push(`moved to repo ${getRepo(patch.repoId).name} from ${from?.name ?? 'none'}`)
  }
  if (patch.baseBranch !== undefined && patch.baseBranch !== before.baseBranch)
    changes.push(`base branch → ${patch.baseBranch}`)
  if (patch.tags && patch.tags.join('\n') !== before.tags.join('\n'))
    changes.push(`tags → ${patch.tags.join(', ') || 'none'}`)
  if (
    repos ||
    patch.repoId !== undefined ||
    patch.branch !== undefined ||
    patch.baseBranch !== undefined ||
    patch.prNumber !== undefined
  )
    syncPrimaryRow(row)
  if (repos) writeOtherRepos(id, repos)
  const reposAfter = ticketRepoList(row)
  const names = (list: typeof reposAfter) => list.map((r) => r.name).join(', ')
  if (names(reposAfter) !== names(reposBefore)) changes.push(`repos → ${names(reposAfter)}`)
  // A repo the ticket no longer spans has nothing of its left to run for it.
  for (const gone of reposBefore.filter((b) => !reposAfter.some((a) => a.repoId === b.repoId)))
    stopRunsFor([id], `${gone.name} was removed from the ticket`, actor, {
      repoId: gone.repoId,
      lanes: false,
    })
  if (patch.title && patch.title !== before.title) changes.push('renamed')
  if (patch.body !== undefined && patch.body !== before.body) changes.push('edited the instructions')
  logActivity({
    projectId: row.projectId,
    actor,
    kind: 'ticket',
    text: `updated ticket #${id} ${row.title}${changes.length ? ` (${changes.join(', ')})` : ''}`,
    refType: 'ticket',
    refId: id,
  })
  if (!row.prId && (patch.prNumber !== undefined || patch.branch !== undefined || patch.repoId !== undefined))
    takeOverPrTickets(row, actor)
  return row
}

/**
 * Put a ticket at `position` (1-based; past the end is last) in its stage's column: the tickets on the
 * board in its stage with the same parent (top-level tickets are the board's columns). The tickets
 * above it are placed with it, so the column reads back with it there and every other ticket in the
 * order it had (`placeInColumn`). In a review stage this is the merge order, top first; nothing
 * enforces it. A change of stage clears it. Any caller may place any ticket of the project; logged.
 * Only the ranks are written: a placement is not an edit of the ticket.
 */
export function placeTicket(id: number, position: number, actor: string) {
  const t = getTicket(id)
  checkPlacement(t, position)
  const placed = db.transaction(() => {
    const siblings = listTickets(t.projectId, { parentId: t.parentId })
    const column = stageColumn(siblings, t.status)
    const ranks = placeInColumn(column, id, position)
    const at = ranks.findIndex((r) => r.id === id)
    // Already placed right there: nothing changes.
    if (column[at]?.id === id && column[at].rank !== null) return null
    for (const r of ranks)
      db.update(schema.tickets).set({ rank: r.rank }).where(eq(schema.tickets.id, r.id)).run()
    return { at: at + 1, of: column.length }
  })
  if (placed) {
    const stage = stageOf(listStages(t.projectId), t.status)
    logActivity({
      projectId: t.projectId,
      actor,
      kind: 'ticket',
      text: `moved ${t.parentId ? 'lane' : 'ticket'} #${id} ${t.title} to ${placed.at} of ${placed.of} in ${stage.name}`,
      refType: 'ticket',
      refId: id,
    })
  }
  return getTicket(id)
}

/**
 * Refuse a position that is not a whole number from 1, or a ticket with no column on the board: one
 * archived, or a PR's own ticket (it lives in the PR queue).
 */
export function checkPlacement(t: Pick<schema.Ticket, 'id' | 'archivedAt' | 'prId'>, position: number) {
  if (!Number.isInteger(position) || position < 1)
    throw new HttpError(400, 'position is a whole number from 1 (the top of the column)')
  if (t.archivedAt) throw new HttpError(409, `ticket ${t.id} is archived: it has no place on the board`)
  if (t.prId) throw new HttpError(409, `ticket ${t.id} is a PR's: it has no place on the board`)
}

/**
 * A ticket moved onto another repo of its own project, at once: its branch is then looked for in that
 * checkout, and its base branch becomes that repo's (or `baseBranch`, when given; it stays as it is when
 * the repo does not change). A repo the ticket already spans as one of its other repos becomes its
 * primary instead, with that repo's own branch, base and PR (updateTicket's plannedPrimary), the old
 * primary staying as one of its other repos. A repo of another project is refused (resolveRepo), and so
 * is a PR's own ticket, as updateTicket refuses it. Its lanes keep their own repos.
 */
export function setTicketRepo(
  id: number,
  input: { repoId: number; baseBranch?: string },
  actor: string,
  opts: { agent?: boolean } = {},
) {
  const before = getTicket(id)
  const repo = resolveRepo(before.projectId, input.repoId)
  const same = ticketRepo(before)?.id === repo.id
  const spanned = !same && ticketRepoList(before).some((e) => !e.primary && e.repoId === repo.id)
  const given = input.baseBranch?.trim()
  // An other repo of the ticket keeps its own base when none is given; a new one starts on the repo's.
  const baseBranch = given || (same ? before.baseBranch : spanned ? undefined : repo.baseBranch)
  return updateTicket(id, { repoId: repo.id, ...(baseBranch ? { baseBranch } : {}) }, actor, opts)
}

/** A ticket that reached a done or cancelled stage has nothing left to preview. */
function stopIfClosed(t: schema.Ticket, stages: ReturnType<typeof listStages>, actor: string) {
  const stage = stageOf(stages, t.status)
  if (stage.kind === 'done' || stage.kind === 'cancelled')
    stopPreviewsFor([t.id], `the ticket moved to ${stage.name}`, actor)
}

/**
 * Take a ticket, for `actor` or, with `as`, for one of the project's agents that `actor` works it as. A
 * shared ticket can be taken over from whoever holds it; one reserved for a project agent only by acting
 * as that agent. Not in a done or cancelled stage, nor archived. The write only lands if nobody reassigned the ticket
 * since it was read, so two agents claiming at once cannot both win. A ticket waiting in an open or
 * blocked stage moves to the project's work stage (`workStage`), if it has an active one.
 */
export function claimTicket(
  id: number,
  actor: string,
  opts: { branch?: string; as?: string; repos?: { repoId: number; branch: string }[] } = {},
) {
  const before = getTicket(id)
  // Each repo's branch, the primary's as `branch` (which wins when both name it); a repo of the project
  // the ticket does not span yet is added to it.
  const listed = ticketRepoList(before)
  const primaryId = listed[0]?.repoId
  if (opts.repos?.length) {
    if (before.prId)
      throw new HttpError(400, `ticket ${id} is PR #${before.prNumber}'s: its repos cannot change`)
    resolveTicketRepos(before, [
      ...listed,
      ...opts.repos.filter((r) => !listed.some((l) => l.repoId === r.repoId)),
    ])
    const own = opts.repos.find((r) => r.repoId === primaryId)
    if (own && opts.branch === undefined) opts = { ...opts, branch: own.branch }
  }
  const stages = listStages(before.projectId)
  const from = stageOf(stages, before.status)
  if (from.kind === 'done' || from.kind === 'cancelled')
    throw new HttpError(409, `ticket ${id} is ${from.kind} (${from.name})`)
  if (before.archivedAt) throw new HttpError(409, `ticket ${id} is archived`)
  const as = opts.as ? actingAs(before.projectId, opts.as) : null
  const holder = reservedFor(before)
  if (holder && holder.id !== as?.id)
    throw new HttpError(
      409,
      as
        ? `ticket ${id} is reserved for ${holder.name}, not ${as.name}`
        : `ticket ${id} is reserved for ${holder.name}: claim it with as: "${holder.name}" and work it as that agent, briefed with its instructions`,
    )
  if (before.prId && opts.branch !== undefined && opts.branch !== before.branch)
    throw new HttpError(400, `ticket ${id} is PR #${before.prNumber}'s: it has no branch of its own`)
  const assignee = as?.name ?? actor
  const active = projectWorkStage(before.projectId, stages)
  // A PR's own ticket keeps its stage: its PR's status is what sets it.
  const start = !before.prId && (from.kind === 'open' || from.kind === 'blocked') && active ? active : null
  const row = db
    .update(schema.tickets)
    .set({
      assignee,
      ...(start ? { status: start.key } : {}),
      ...movePatch(stages, before.status, start?.key ?? before.status, before.startedAt),
      ...(opts.branch !== undefined ? { branch: opts.branch } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(schema.tickets.id, id), eq(schema.tickets.assignee, before.assignee)))
    .returning()
    .get()
  if (!row) throw new HttpError(409, `ticket ${id} was reassigned while claiming it; read it again`)
  if (opts.branch !== undefined) syncPrimaryRow(row)
  const others = (opts.repos ?? []).filter((r) => r.repoId !== primaryId)
  if (others.length) {
    const next = ticketRepoList(row).map((e) => ({
      ...e,
      branch: others.find((r) => r.repoId === e.repoId)?.branch ?? e.branch,
    }))
    for (const r of others)
      if (!next.some((e) => e.repoId === r.repoId))
        next.push({ ...r, name: '', baseBranch: '', prNumber: null, primary: false })
    writeOtherRepos(id, resolveTicketRepos(row, next))
  }
  noteStageMove(id, before.status, row.status)
  if (row.parentId) touch(row.parentId)
  const tookOver = before.assignee && before.assignee !== assignee ? ` from ${before.assignee}` : ''
  if (before.assignee !== assignee || start)
    logActivity({
      projectId: row.projectId,
      actor: assignee,
      kind: 'ticket',
      text: `${tookOver ? 'took over' : 'claimed'} ${row.parentId ? 'lane' : 'ticket'} #${id} ${row.title}${tookOver}${as ? ` (via ${actor})` : ''}${start ? ` (status ${from.name} → ${start.name})` : ''}`,
      refType: 'ticket',
      refId: id,
    })
  if (!row.prId && opts.branch !== undefined) takeOverPrTickets(row, assignee)
  return row
}

export type Verdict = 'approved' | 'disapproved' | null

export const verdictOf = (t: Pick<schema.Ticket, 'approvedAt' | 'disapprovedAt'>): Verdict =>
  t.approvedAt ? 'approved' : t.disapprovedAt ? 'disapproved' : null

/**
 * The human's call on a ticket or lane: approve it, disapprove it (which moves it to the project's
 * first cancelled stage), or clear the call. Approving a PR review (a ticket tagged `PR`) also moves
 * it to the first done stage; taking that back returns it to `reopenTo` or the first review stage. Taking back a disapproval puts a cancelled ticket back
 * to `reopenTo` (the stage it had, when an undo knows it) or the stage new tickets start in. Callers make sure
 * the actor is the human.
 */
export function setVerdict(id: number, verdict: Verdict, actor: string, opts: { reopenTo?: string } = {}) {
  const t = getTicket(id)
  if (t.prId && verdict !== null)
    throw new HttpError(
      409,
      `ticket ${id} is PR #${t.prNumber}'s: a PR is reviewed on the PR queue, not approved`,
    )
  const before = verdictOf(t)
  if (before === verdict) return t
  const now = new Date().toISOString()
  const stages = listStages(t.projectId)
  const cancel = firstOfKind(stages, 'cancelled')
  // A PR review (tagged PR) is finished by the call: approving it closes it as done.
  const pr = t.tags.some((tag) => tag.toLowerCase() === 'pr')
  const finish = verdict === 'approved' && pr ? firstOfKind(stages, 'done') : undefined
  const kind = kindOf(stages, t.status)
  const reopen =
    (before === 'disapproved' && kind === 'cancelled') ||
    (before === 'approved' && pr && kind === 'done' && verdict === null)
  const reopenTo = opts.reopenTo
    ? resolveStage(stages, opts.reopenTo, projectWorkStage(t.projectId, stages))
    : before === 'approved'
      ? (firstOfKind(stages, 'review') ?? startStage(stages))
      : startStage(stages)
  const status =
    verdict === 'disapproved' && cancel ? cancel.key : finish ? finish.key : reopen ? reopenTo.key : t.status
  const row = db
    .update(schema.tickets)
    .set({
      approvedAt: verdict === 'approved' ? now : null,
      approvedBy: verdict === 'approved' ? actor : '',
      disapprovedAt: verdict === 'disapproved' ? now : null,
      disapprovedBy: verdict === 'disapproved' ? actor : '',
      status,
      ...movePatch(stages, t.status, status, t.startedAt),
      updatedAt: now,
    })
    .where(eq(schema.tickets.id, id))
    .returning()
    .get()!
  if (t.parentId) touch(t.parentId)
  noteStageMove(id, t.status, row.status)
  if (row.status !== t.status) stopIfClosed(row, stages, actor)
  const what = `${t.parentId ? 'lane' : 'ticket'} #${id} ${t.title}`
  logActivity({
    projectId: t.projectId,
    actor,
    kind: 'ticket',
    text:
      verdict === 'approved'
        ? `approved ${what}${finish ? ` (${finish.name})` : ''}`
        : verdict === 'disapproved'
          ? `disapproved ${what}${cancel ? ` (${cancel.name})` : ''}`
          : `withdrew the ${before === 'approved' ? 'approval' : 'disapproval'} of ${what}${reopen ? ` (back to ${reopenTo.name})` : ''}`,
    refType: 'ticket',
    refId: id,
  })
  return row
}

/** Lanes go with the ticket unless `keepLanes`, which moves them up to the ticket's own parent. */
export function deleteTicket(id: number, actor: string, opts: { keepLanes?: boolean } = {}) {
  const t = getTicket(id)
  // A PR's ticket is kept, not deleted: while its PR is open the next refresh would open it again, and the
  // human archives it like any finished ticket.
  if (t.prId) throw new HttpError(409, `PR #${t.prNumber}'s ticket cannot be deleted: archive it instead`)
  // Its workspaces go with it (and its lanes', unless they are kept).
  const all = db.select().from(schema.tickets).where(eq(schema.tickets.projectId, t.projectId)).all()
  const gone = [id, ...(opts.keepLanes ? [] : laneTree(all, id).map((l) => l.id))]
  for (const w of db.select().from(schema.workspaces).where(inArray(schema.workspaces.ticketId, gone)).all())
    forgetPreview(w.id, actor)
  if (opts.keepLanes)
    // In their new column (the ticket's siblings) they arrive unplaced.
    db.update(schema.tickets)
      .set({ parentId: t.parentId, rank: null })
      .where(eq(schema.tickets.parentId, id))
      .run()
  db.delete(schema.tickets).where(eq(schema.tickets.id, id)).run()
  logActivity({ projectId: t.projectId, actor, kind: 'ticket', text: `deleted ticket #${id} ${t.title}` })
}

// --- archive (the human puts finished tickets away, or answers an agent's request to; lanes go with them) ---

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * Set or clear the archive mark on these tickets and every lane under them, in one write. Off the board
 * they keep no place in their column: one restored comes back unplaced.
 */
function markArchived(projectId: number, roots: number[], archivedAt: string | null, actor: string) {
  const all = db
    .select({ id: schema.tickets.id, parentId: schema.tickets.parentId })
    .from(schema.tickets)
    .where(eq(schema.tickets.projectId, projectId))
    .all()
  const lanes = roots.flatMap((id) => laneTree(all, id).map((t) => t.id))
  const ids = [...roots, ...lanes]
  if (ids.length)
    db.update(schema.tickets)
      .set({ archivedAt, archivedBy: archivedAt ? actor : '', ...(archivedAt ? { rank: null } : {}) })
      .where(inArray(schema.tickets.id, ids))
      .run()
  return lanes.length
}

/** A top-level ticket, as archive and restore take them; a lane follows its ticket. */
function topLevel(id: number) {
  const t = getTicket(id)
  if (t.parentId)
    throw new HttpError(400, `#${id} is a lane: it is archived and restored with its ticket #${t.parentId}`)
  return t
}

/**
 * Take a finished ticket (in a done or cancelled stage) off the board and out of the default lists,
 * its lanes with it. Its page still opens. Callers make sure the actor is the human.
 */
export function archiveTicket(id: number, actor: string) {
  const t = topLevel(id)
  if (t.archivedAt) return t
  const stage = stageOf(listStages(t.projectId), t.status)
  if (stage.kind !== 'done' && stage.kind !== 'cancelled')
    throw new HttpError(409, `ticket ${id} is in ${stage.name}; only done or cancelled tickets are archived`)
  const lanes = markArchived(t.projectId, [id], new Date().toISOString(), actor)
  stopPreviewsFor([id], 'the ticket was archived', actor)
  logActivity({
    projectId: t.projectId,
    actor,
    kind: 'ticket',
    text: `archived ticket #${id} ${t.title}${lanes ? ` (with ${plural(lanes, 'lane')})` : ''}`,
    refType: 'ticket',
    refId: id,
  })
  return getTicket(id)
}

/**
 * Archive every top-level ticket in one done or cancelled stage (a key, name or kind), lanes included.
 * Callers make sure the actor is the human.
 */
export function archiveStage(projectId: number, status: string, actor: string) {
  getProject(projectId)
  const stages = listStages(projectId)
  const stage = resolveStage(stages, status, projectWorkStage(projectId, stages))
  if (stage.kind !== 'done' && stage.kind !== 'cancelled')
    throw new HttpError(409, `${stage.name} is not a done or cancelled stage`)
  const ids = db
    .select({ id: schema.tickets.id })
    .from(schema.tickets)
    .where(
      and(
        eq(schema.tickets.projectId, projectId),
        eq(schema.tickets.status, stage.key),
        isNull(schema.tickets.parentId),
        isNull(schema.tickets.archivedAt),
      ),
    )
    .all()
    .map((t) => t.id)
  if (!ids.length) return { stage: stage.key, ids }
  const lanes = markArchived(projectId, ids, new Date().toISOString(), actor)
  stopPreviewsFor(ids, 'the ticket was archived', actor)
  logActivity({
    projectId,
    actor,
    kind: 'ticket',
    text: `archived ${plural(ids.length, 'ticket')} from ${stage.name} (${ids.map((id) => `#${id}`).join(', ')})${lanes ? `, with ${plural(lanes, 'lane')}` : ''}`,
    refType: 'project',
    refId: projectId,
  })
  return { stage: stage.key, ids }
}

/** Put an archived ticket back on the board, its lanes with it. Callers make sure the actor is the human. */
export function restoreTicket(id: number, actor: string) {
  const t = topLevel(id)
  if (!t.archivedAt) return t
  const lanes = markArchived(t.projectId, [id], null, actor)
  logActivity({
    projectId: t.projectId,
    actor,
    kind: 'ticket',
    text: `restored ticket #${id} ${t.title} from the archive${lanes ? ` (with ${plural(lanes, 'lane')})` : ''}`,
    refType: 'ticket',
    refId: id,
  })
  return getTicket(id)
}

/** How many tickets one archive request names at most. */
export const MAX_ARCHIVE_REQUEST = 50
/** The options of an archive request's card, in order: answering the first archives. */
const ARCHIVE_OPTIONS: schema.DecisionOption[] = [
  { label: 'Archive', detail: 'Take them off the board, their lanes with them' },
  { label: 'Keep', detail: 'Leave them where they are' },
]

/**
 * Why `t` cannot be archived now, or null when it can: a top-level ticket in a done or cancelled stage,
 * not archived yet. A lane goes with its ticket.
 */
function notArchivable(t: schema.Ticket, stages: schema.Stage[]): string | null {
  if (t.archivedAt) return `#${t.id} is already archived`
  if (t.parentId) {
    const parent = db.select().from(schema.tickets).where(eq(schema.tickets.id, t.parentId)).get()
    const kind = parent && kindOf(stages, parent.status)
    if (parent && kind !== 'done' && kind !== 'cancelled')
      return `#${t.id} is a lane of #${parent.id}, which is still open (${stageOf(stages, parent.status).name}): a lane is archived with its ticket`
    return `#${t.id} is a lane: it is archived with its ticket #${t.parentId}, so ask for #${t.parentId} instead`
  }
  const stage = stageOf(stages, t.status)
  if (stage.kind !== 'done' && stage.kind !== 'cancelled')
    return `#${t.id} is in ${stage.name}; only done or cancelled tickets are archived`
  return null
}

/**
 * An agent's request to archive finished tickets: a decision card for the human, "Archive #12, #15?"
 * with Archive and Keep, on the first ticket named (in its Main tab; it does not block). Nothing is
 * archived until the human answers Archive (decide, or the orchestrator's relay of their chat answer).
 * Every ticket must be in one project, top-level, in a done or cancelled stage and not archived yet; one
 * that is not refuses the whole request, naming each failing ticket and why.
 */
export function requestArchive(
  ticketIds: number[],
  input: { as?: string; projectId?: number },
  actor: string,
) {
  if (input.projectId !== undefined) getProject(input.projectId)
  const ids = [...new Set(ticketIds)]
  if (!ids.length || ids.length > MAX_ARCHIVE_REQUEST)
    throw new HttpError(400, `name 1 to ${MAX_ARCHIVE_REQUEST} tickets to archive`)
  const tickets = ids.map(getTicket)
  const projectId = tickets[0]!.projectId
  if (tickets.some((t) => t.projectId !== (input.projectId ?? projectId)))
    throw new HttpError(
      400,
      input.projectId === undefined
        ? 'an archive request names tickets of one project'
        : `an archive request names tickets of project ${input.projectId} only`,
    )
  const stages = listStages(projectId)
  const refused = tickets.map((t) => notArchivable(t, stages)).filter((why) => why !== null)
  if (refused.length) throw new HttpError(409, `nothing was asked: ${refused.join('; ')}`)
  const body = [
    `Archive ${ids.map((id) => `#${id}`).join(', ')}?`,
    '',
    ...tickets.map((t) => `- #${t.id} ${t.title} (${stageOf(stages, t.status).name})`),
    '',
    'Archive takes them off the board, their lanes with them; any of them can be restored from the Archived tab.',
  ].join('\n')
  return postDecision(
    ids[0]!,
    { body, options: ARCHIVE_OPTIONS, as: input.as, block: false, tab: 'main' },
    actor,
    {
      archiveTickets: ids,
      did: `asked to archive ${tickets.map((t) => `#${t.id} ${t.title}`).join(', ')}`,
    },
  )
}

/**
 * An archive request answered Archive: the tickets it names that can still be archived are, by `human`
 * (who confirmed it), as archiveTicket does it, lanes and previews included; the activity says which
 * agent asked (and who relayed the answer from the chat). One archived already (by an earlier Archive
 * on this card, or by the human meanwhile) is as asked: `already`, not an error. The others (reopened,
 * gone) are skipped, each with why.
 */
function archiveRequested(post: schema.Update, human: string, relayedBy = '') {
  const archived: number[] = []
  const already: number[] = []
  const skipped: { id: number; why: string }[] = []
  const at = new Date().toISOString()
  for (const id of post.archiveTickets ?? []) {
    const t = db.select().from(schema.tickets).where(eq(schema.tickets.id, id)).get()
    if (!t) {
      skipped.push({ id, why: `#${id} no longer exists` })
      continue
    }
    if (t.archivedAt) {
      already.push(id)
      continue
    }
    const why = notArchivable(t, listStages(t.projectId))
    if (why) {
      skipped.push({ id, why })
      continue
    }
    const lanes = markArchived(t.projectId, [id], at, human)
    archived.push(id)
    logActivity({
      projectId: t.projectId,
      actor: human,
      kind: 'ticket',
      text: `archived ticket #${id} ${t.title}${lanes ? ` (with ${plural(lanes, 'lane')})` : ''}, as ${post.author} asked${relayedBy ? ` (answered in chat, relayed by ${relayedBy})` : ''}`,
      refType: 'ticket',
      refId: id,
    })
  }
  if (archived.length) stopPreviewsFor(archived, 'the ticket was archived', human)
  return { archived, already, skipped }
}

type ArchiveResult = ReturnType<typeof archiveRequested>

/** What an answered archive request did, for the reply under its card. */
function archiveWords(result: ArchiveResult | null) {
  if (!result) return ''
  const done = result.archived.length
    ? `\n\nArchived ${result.archived.map((id) => `#${id}`).join(', ')}.`
    : ''
  const already = result.already.length
    ? `\n\nAlready archived: ${result.already.map((id) => `#${id}`).join(', ')}.`
    : ''
  const not = result.skipped.length ? `\n\nNot archived: ${result.skipped.map((s) => s.why).join('; ')}.` : ''
  return done + already + not
}

/** The options of a repo request's card, in order: answering the first adds the repo. */
const REPO_OPTIONS: schema.DecisionOption[] = [
  { label: 'Add', detail: 'Register the checkout as a repo of this project' },
  { label: "Don't add", detail: 'Leave the project as it is' },
]

/**
 * `text` (one line) as a markdown code span, which shows it literally: its fence is one backtick longer
 * than the longest run of backticks in it, since a span opened by N backticks closes only on N
 * (CommonMark), with a space inside each end when it starts or ends with a backtick or a space (one is
 * stripped from each end).
 */
function codeSpan(text: string) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(longest + 1)
  const pad = /^[` ]|[` ]$/.test(text) ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

/**
 * An agent's request to add a repo to the project of the ticket it names: a decision card for the human,
 * "Add repo shop?" with Add and Don't add, on that ticket (in its Main tab; it does not block). The repo
 * is checked first (`checkRepoRequest`: a git checkout whose origin is `githubRepo` on github.com, a name
 * and a path no repo has yet); one that fails posts no card. Nothing is added until the human answers Add
 * (decide, or the orchestrator's relay of their chat answer), which checks it all again.
 */
export async function requestRepo(
  ticketId: number,
  input: { name: string; repoPath: string; githubRepo: string; baseBranch?: string; as?: string },
  actor: string,
) {
  const ticket = getTicket(ticketId)
  if (input.as !== undefined) actingAs(ticket.projectId, input.as)
  const req = await checkRepoRequest(ticket.projectId, input)
  // Every value is the agent's: each is a code span, so none can close its formatting or add markdown.
  const body = [
    `Add repo ${codeSpan(req.name)}?`,
    '',
    `- Name: ${codeSpan(req.name)}`,
    `- GitHub: ${codeSpan(req.githubRepo)}`,
    `- Path: ${codeSpan(req.repoPath)}`,
    `- Base branch: ${codeSpan(req.baseBranch)}`,
    '',
    `Add registers this checkout as a repo of ${getProject(ticket.projectId).name}, checked again first; Don't add changes nothing.`,
  ].join('\n')
  return postDecision(
    ticketId,
    { body, options: REPO_OPTIONS, as: input.as, block: false, tab: 'main' },
    actor,
    { repoRequest: req, did: `asked to add repo ${req.name} (${req.githubRepo}) at ${req.repoPath}` },
  )
}

/**
 * What a repo request's Add has to read before it is answered: the checkout's origin (git answers
 * asynchronously), for decide and relayDecision to check the request against. Undefined for any other
 * post or option, or a post that does not exist (the answer then says so itself).
 */
export async function answerOrigin(postId: number, option: number): Promise<string | null | undefined> {
  const post = db.select().from(schema.updates).where(eq(schema.updates.id, postId)).get()
  if (!post?.repoRequest || option !== 0) return undefined
  return requestOrigin(post.repoRequest.repoPath)
}

/**
 * A repo request answered Add: the repo is created as asked, by `human` (who confirmed it), once it passes
 * the request's checks again (`origin` is the checkout's origin as read just before: answerOrigin); the
 * activity says which agent asked (and who relayed the answer from the chat). A repo this card added
 * already (the same name and path in the project) is as asked: `already`, not an error. A check that
 * fails now adds nothing, and `refused` says why.
 */
function repoRequested(
  post: schema.Update,
  human: string,
  origin: string | null | undefined,
  relayedBy = '',
) {
  const req = post.repoRequest!
  const already = requestedRepo(req)
  if (already) return { added: null, already, refused: '' }
  const problem =
    origin === undefined
      ? new HttpError(500, "the checkout's origin was not read")
      : repoRequestProblem(req, origin)
  if (problem) return { added: null, already: null, refused: problem.message }
  const added = insertRequestedRepo(req)
  logActivity({
    projectId: req.projectId,
    actor: human,
    kind: 'project',
    text: `added repo ${added.name} (${added.githubRepo}), as ${post.author} asked${relayedBy ? ` (answered in chat, relayed by ${relayedBy})` : ''}`,
    refType: 'ticket',
    refId: post.ticketId,
  })
  return { added, already: null, refused: '' }
}

type RepoResult = ReturnType<typeof repoRequested>

/** What an answered repo request did, for the reply under its card. */
function repoWords(result: RepoResult | null) {
  if (!result) return ''
  if (result.added) return `\n\nAdded repo ${result.added.name} (repo ${result.added.id}).`
  if (result.already) return `\n\nAlready added: repo ${result.already.name} (repo ${result.already.id}).`
  return `\n\nNot added: ${result.refused}.`
}

// --- tasks ---

/**
 * A task to add: its text, or a top-level task with the subtasks that go under it. `blocked` tags it
 * as waiting on the human, `blockedReason` says what they must do.
 */
export type NewTask =
  | string
  | { text: string; subtasks?: string[]; blocked?: boolean; blockedReason?: string }

/** How long a blocked task's reason can be, as long as a task's text. */
export const MAX_BLOCKED_REASON = 500

/** A task's tag as a write asks for it: whether it waits on the human, and what for. */
type BlockedTag = { blocked?: boolean; blockedReason?: string }

/**
 * The tag a write leaves on a task (`current`, null for a new one), or null when it does not touch it.
 * `blocked: false` clears the reason with the tag; a reason goes only on a task that is or becomes
 * blocked, and replaces the one it had; `blocked: true` alone keeps the one it had.
 */
function blockedTag(
  input: BlockedTag,
  current: Pick<schema.Task, 'blocked' | 'blockedReason'> | null,
): { blocked: boolean; blockedReason: string } | null {
  const reason = input.blockedReason?.trim()
  if (reason !== undefined && reason.length > MAX_BLOCKED_REASON)
    throw new HttpError(400, `blockedReason is longer than ${MAX_BLOCKED_REASON} characters`)
  if (input.blocked === false) return { blocked: false, blockedReason: '' }
  const blocked = input.blocked ?? current?.blocked ?? false
  if (reason && !blocked) throw new HttpError(400, 'blockedReason goes with blocked: true')
  if (!blocked || (input.blocked === undefined && reason === undefined)) return null
  return { blocked: true, blockedReason: reason ?? (current?.blocked ? current.blockedReason : '') }
}

/** What a tick writes besides `done`: a done task waits on nobody, so its tag goes. */
const ticked = (done: boolean) => (done ? { done, blocked: false, blockedReason: '' } : { done })

/** Each new task's tag, null for a plain text; one bad tag refuses them all. */
function newTaskTags(items: NewTask[]) {
  return items.map((i) => (typeof i === 'string' ? null : blockedTag(i, null)))
}

function getTask(id: number) {
  const task = db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()
  if (!task) throw notFound('task')
  return task
}

/**
 * A task with subtasks is done exactly when all of them are; one whose last subtask went keeps its
 * own tick. A phase the board ticks follows its own fact, never its subtasks. Run inside the
 * transaction that changed the subtasks.
 */
function settleParent(parentId: number) {
  const parent = db.select().from(schema.tasks).where(eq(schema.tasks.id, parentId)).get()
  if (!parent || autoPhaseOf(parent)) return
  const subtasks = db
    .select({ done: schema.tasks.done })
    .from(schema.tasks)
    .where(eq(schema.tasks.parentId, parentId))
    .all()
  if (subtasks.length)
    db.update(schema.tasks)
      .set(ticked(subtasks.every((s) => s.done)))
      .where(eq(schema.tasks.id, parentId))
      .run()
}

/**
 * Append tasks to a ticket: top-level ones (each with its subtasks, given as `{ text, subtasks }`), or
 * with `parentTaskId` subtasks of that top-level task of the ticket. Tasks go two levels deep, so a
 * subtask takes no subtasks of its own; a refused call writes nothing. A done parent that gains an open
 * subtask is open again. An item given as an object can come tagged blocked, with its reason. Returns
 * the new rows, each followed by its subtasks.
 */
export function addTasks(
  ticketId: number,
  items: NewTask[],
  actor: string,
  opts: { quiet?: boolean; parentTaskId?: number | null } = {},
) {
  const ticket = getTicket(ticketId)
  const parent = opts.parentTaskId ? getTask(opts.parentTaskId) : null
  if (parent && parent.ticketId !== ticketId)
    throw new HttpError(400, `task ${parent.id} is not a task of ticket ${ticketId}`)
  if (parent && (parent.parentId || items.some((i) => typeof i !== 'string' && i.subtasks?.length)))
    throw new HttpError(400, 'a subtask cannot have subtasks: tasks go two levels deep')
  const tags = newTaskTags(items)
  const rows = db.transaction(() => {
    const last = db
      .select({ position: schema.tasks.position })
      .from(schema.tasks)
      .where(eq(schema.tasks.ticketId, ticketId))
      .orderBy(desc(schema.tasks.position))
      .get()
    let position = (last?.position ?? -1) + 1
    const insert = (texts: string[], parentId: number | null, tag: BlockedTag | null = null) =>
      texts.length
        ? db
            .insert(schema.tasks)
            .values(texts.map((text) => ({ ticketId, parentId, text, position: position++, ...tag })))
            .returning()
            .all()
        : []
    const out: schema.Task[] = []
    items.forEach((item, i) => {
      const { text, subtasks = [] } = typeof item === 'string' ? { text: item } : item
      const [row] = insert([text], parent?.id ?? null, tags[i])
      out.push(row!, ...insert(subtasks, row!.id))
    })
    if (parent) settleParent(parent.id)
    return out
  })
  touch(ticketId)
  const blocked = rows.filter((r) => r.blocked).length
  const tagged = blocked ? ` (${blocked} blocked)` : ''
  if (!opts.quiet)
    logActivity({
      projectId: ticket.projectId,
      actor,
      kind: 'task',
      text: parent
        ? `added ${plural(rows.length, 'subtask')}${tagged} to "${parent.text}" on #${ticketId} ${ticket.title}`
        : `added ${plural(rows.length, 'task')}${tagged} to #${ticketId} ${ticket.title}`,
      refType: 'ticket',
      refId: ticketId,
    })
  return rows
}

/**
 * Reword a task, tick or untick it, or tag it blocked on the human (with what they must do) or clear
 * that. A tick keeps each parent equal to "all its subtasks done": ticking or unticking a task does the
 * same to its subtasks, and ticking a subtask settles its parent. A done task waits on nobody: ticking
 * clears the tag (on the subtasks it ticks, and on a parent its last subtask ticks, too), and tagging a
 * done task reopens it as unticking would. A patch that both ticks and tags is refused.
 */
export function updateTask(id: number, patch: { done?: boolean; text?: string } & BlockedTag, actor: string) {
  const task = getTask(id)
  const tag = blockedTag(patch, task)
  // An automatic phase, or a task this patch rewords into one.
  const phase =
    autoPhaseOf(task) ?? (patch.text === undefined ? null : autoPhaseOf({ ...task, text: patch.text }))
  if (phase && (patch.done !== undefined || (tag?.blocked && task.done)))
    throw new HttpError(
      400,
      `"${phase}" is ticked by the board ${AUTO_PHASE_RULE[phase]}; it cannot be ticked by hand${patch.done === undefined ? ', or reopened by tagging it blocked' : ''}`,
    )
  if (patch.done && tag?.blocked)
    throw new HttpError(400, 'a done task cannot be blocked: tick it once the human has done their part')
  const done = patch.done ?? (tag?.blocked && task.done ? false : undefined)
  // Nothing to write (an empty reason on a task that is not blocked): the task as it is.
  if (patch.text === undefined && !tag && done === undefined) return task
  const row = db.transaction(() => {
    const r = db
      .update(schema.tasks)
      .set({ text: patch.text, ...tag, ...(done === undefined ? {} : ticked(done)) })
      .where(eq(schema.tasks.id, id))
      .returning()
      .get()!
    if (done !== undefined) {
      if (task.parentId) settleParent(task.parentId)
      else db.update(schema.tasks).set(ticked(done)).where(eq(schema.tasks.parentId, id)).run()
    }
    return r
  })
  const ticket = getTicket(task.ticketId)
  touch(ticket.id)
  const log = (text: string) =>
    logActivity({
      projectId: ticket.projectId,
      actor,
      kind: 'task',
      text,
      refType: 'ticket',
      refId: ticket.id,
    })
  const on = `on #${ticket.id} ${ticket.title}`
  if (patch.text !== undefined && patch.text !== task.text)
    log(`reworded "${task.text}" to "${row.text}" ${on}`)
  if (done !== undefined && done !== task.done) log(`${done ? 'completed' : 'reopened'} "${row.text}" ${on}`)
  if (tag?.blocked && (!task.blocked || tag.blockedReason !== task.blockedReason))
    log(`flagged "${row.text}" as blocked ${on}${tag.blockedReason ? `: ${tag.blockedReason}` : ''}`)
  if (tag && !tag.blocked && task.blocked) log(`cleared the blocked flag on "${row.text}" ${on}`)
  return row
}

/** Remove a task, its subtasks with it; a parent left with only done subtasks is done. */
export function deleteTask(id: number, actor: string) {
  const task = getTask(id)
  db.transaction(() => {
    db.delete(schema.tasks).where(eq(schema.tasks.id, id)).run()
    if (task.parentId) settleParent(task.parentId)
  })
  touch(task.ticketId)
  const ticket = getTicket(task.ticketId)
  logActivity({
    projectId: ticket.projectId,
    actor,
    kind: 'task',
    text: `removed "${task.text}" from #${ticket.id} ${ticket.title}`,
    refType: 'ticket',
    refId: ticket.id,
  })
}

// --- workspaces (a worktree, a sub-branch, a subagent's sandbox) ---

export function addWorkspace(
  ticketId: number,
  input: {
    name: string
    branch?: string
    path?: string
    agent?: string
    previewUrl?: string | null
    /** The repo of the ticket its worktree is of; the ticket's primary when left out. */
    repoId?: number | null
  },
  actor: string,
) {
  const ticket = getTicket(ticketId)
  const repos = ticketRepoList(ticket)
  if (input.repoId && !repos.some((r) => r.repoId === input.repoId))
    throw new HttpError(
      400,
      `repo ${input.repoId} is not one of ticket ${ticketId}'s repos (${repos.map((r) => `${r.repoId} ${r.name}`).join(', ') || 'none'})`,
    )
  const preview = previewUrl(input.previewUrl)
  const row = db
    .insert(schema.workspaces)
    .values({
      ticketId,
      name: input.name,
      repoId: input.repoId || repos[0]?.repoId || null,
      branch: input.branch ?? '',
      path: input.path ?? '',
      agent: input.agent ?? actor,
      previewUrl: preview,
    })
    .returning()
    .get()
  touch(ticketId)
  logActivity({
    projectId: ticket.projectId,
    actor,
    kind: 'workspace',
    text: `opened workspace ${row.name}${row.branch ? ` on ${row.branch}` : ''} for #${ticketId}${preview ? `, preview at ${preview}` : ''}`,
    refType: 'ticket',
    refId: ticketId,
  })
  return row
}

function getWorkspace(id: number) {
  const ws = db.select().from(schema.workspaces).where(eq(schema.workspaces.id, id)).get()
  if (!ws) throw notFound('workspace')
  return ws
}

/** Set the link where the workspace's branch runs for the human to try, or clear it ('' or null). */
export function setWorkspacePreview(id: number, value: string | null, actor: string) {
  const ws = getWorkspace(id)
  const preview = previewUrl(value)
  const row = db
    .update(schema.workspaces)
    .set({ previewUrl: preview })
    .where(eq(schema.workspaces.id, id))
    .returning()
    .get()
  touch(ws.ticketId)
  const ticket = getTicket(ws.ticketId)
  logActivity({
    projectId: ticket.projectId,
    actor,
    kind: 'workspace',
    text: preview
      ? `preview of workspace ${ws.name} on #${ticket.id} at ${preview}`
      : `stopped the preview of workspace ${ws.name} on #${ticket.id}`,
    refType: 'ticket',
    refId: ticket.id,
  })
  return row
}

/**
 * Whether the workspace's preview answers right now (checked on this machine, cached a few seconds;
 * `running: false` without a link), the preview the board runs from it (`managed`, null when it never
 * ran one), and `cannotStart`: why the board would refuse to start one, null when it would.
 * `toolProblem` is set when that is a tool missing on this machine (pnpm or node): the workspace could
 * run one once it is fixed, so the Previews page shows it with the reason.
 */
export async function workspacePreview(id: number) {
  const ws = getWorkspace(id)
  const state: PreviewState = ws.previewUrl
    ? await previewState(ws.previewUrl)
    : { running: false, checkedAt: new Date().toISOString() }
  const refused = cannotStart(id)
  const tools = previewToolProblem()
  return {
    ...state,
    url: ws.previewUrl,
    managed: managedPreview(id),
    cannotStart: refused,
    toolProblem: refused !== null && refused === tools ? tools : null,
  }
}

export type WorkspacePreview = Awaited<ReturnType<typeof workspacePreview>>

export function deleteWorkspace(id: number, actor: string) {
  const ws = getWorkspace(id)
  forgetPreview(id, actor)
  db.delete(schema.workspaces).where(eq(schema.workspaces.id, id)).run()
  const ticket = getTicket(ws.ticketId)
  logActivity({
    projectId: ticket.projectId,
    actor,
    kind: 'workspace',
    text: `closed workspace ${ws.name} on #${ticket.id}`,
    refType: 'ticket',
    refId: ticket.id,
  })
}

/**
 * Live, read-only git state for the ticket's branch and each workspace: its own, then its lanes'
 * (all the way down, each tagged with its lane). A workspace is compared against the branch of the
 * ticket it belongs to, in that ticket's repo. Each branch carries `reach`: whether its work is in
 * the base chain (a lane's parent branch, then dev), so it can be deleted, and `push`: whether it is
 * on origin. Read from the repos' ref and worktree listings of the last few seconds (`repoGit`), and
 * answers kept by the commits they were worked out for: what did not move is not asked of git again.
 */
export async function ticketGit(id: number, repoGit: GitCache = gitCache({ recent: true })) {
  const ticket = getTicket(id)
  const all = db.select().from(schema.tickets).where(eq(schema.tickets.projectId, ticket.projectId)).all()
  const owners = [ticket, ...laneTree(all, id)]
  const rows = db
    .select()
    .from(schema.workspaces)
    .where(
      inArray(
        schema.workspaces.ticketId,
        owners.map((t) => t.id),
      ),
    )
    .all()
  const workspaces = owners.flatMap((owner) =>
    rows
      .filter((w) => w.ticketId === owner.id)
      .map((w) => {
        const r = workspaceRepo(w, owner)
        // In another repo of its ticket than the primary: compared with that repo's branch.
        const entry =
          r && r.id !== ticketRepo(owner)?.id ? ticketRepoList(owner).find((e) => e.repoId === r.id) : null
        return {
          w,
          owner: entry
            ? { ...owner, repoId: r!.id, branch: entry.branch, baseBranch: entry.baseBranch }
            : owner,
          repo: r,
        }
      }),
  )
  const repo = ticketRepo(ticket)
  const entries = ticketRepoList(ticket)
  const byId = new Map(all.map((t) => [t.id, t]))
  // The other repos', each against its own base.
  const othersGit = Promise.all(
    entries.slice(1).map(async (e) => {
      const r = getRepo(e.repoId)
      const subject = { ...ticket, repoId: r.id, branch: e.branch, baseBranch: e.baseBranch }
      const [{ refs }, push] = await Promise.all([
        repoGit(r.repoPath),
        pushStates(r.repoPath, [e.branch], new Map([[e.branch, e.baseBranch]])),
      ])
      const [info, reach] = await Promise.all([
        infoOf(r.repoPath, e.branch, e.baseBranch, refs),
        reachOf(r.repoPath, e.branch, baseChain(subject, byId, r), refs),
      ])
      return { ...info, reach, push: push.get(e.branch) ?? NO_PUSH }
    }),
  )
  const [others, branch, ...wsState] = await Promise.all([
    othersGit,
    (async () => {
      if (!repo) return { ...NO_BRANCH, reach: null, push: NO_PUSH }
      const [{ refs }, push] = await Promise.all([
        repoGit(repo.repoPath),
        pushStates(repo.repoPath, [ticket.branch], new Map([[ticket.branch, ticket.baseBranch]])),
      ])
      const chain = baseChain(ticket, byId, repo)
      const [info, reach] = await Promise.all([
        infoOf(repo.repoPath, ticket.branch, ticket.baseBranch, refs),
        reachOf(repo.repoPath, ticket.branch, chain, refs),
      ])
      return { ...info, reach, push: push.get(ticket.branch) ?? NO_PUSH }
    })(),
    ...workspaces.map(async ({ w, owner, repo: r }) => {
      if (!r) return { info: { ...NO_BRANCH, reach: null, push: NO_PUSH }, worktree: null }
      const [{ refs, worktrees }, push] = await Promise.all([
        repoGit(r.repoPath),
        pushStates(r.repoPath, [w.branch], new Map([[w.branch, owner.baseBranch]])),
      ])
      const chain = baseChain(owner, byId, r)
      const into = w.branch === owner.branch || !owner.branch ? chain : [owner.branch, ...chain]
      const worktree =
        worktrees.find((t) => (w.path && samePath(t.path, w.path)) || (w.branch && t.branch === w.branch)) ??
        null
      const [info, reach] = await Promise.all([
        infoOf(r.repoPath, w.branch, owner.branch || owner.baseBranch, refs),
        reachOf(r.repoPath, w.branch, into, refs),
      ])
      return { info: { ...info, reach, push: push.get(w.branch) ?? NO_PUSH }, worktree }
    }),
  ])
  return {
    repo: repo ? { id: repo.id, name: repo.name } : null,
    branch: ticket.branch,
    baseBranch: ticket.baseBranch,
    info: branch,
    // Every repo of the ticket, the primary (the fields above) first, each with its branch, git state and PR.
    repos: entries.map((e, i) => ({
      repo: { id: e.repoId, name: e.name },
      primary: e.primary,
      branch: e.branch,
      baseBranch: e.baseBranch,
      info: i === 0 ? branch : others[i - 1]!,
      pr: i === 0 ? prForTicket(ticket) : prForTicket({ ...ticket, ...e }),
    })),
    workspaces: workspaces.map(({ w, owner, repo: r }, i) => ({
      ...w,
      repo: r ? { id: r.id, name: r.name } : null,
      ...wsState[i]!,
      // Set on a lane's workspace shown in its parent's panel.
      lane: owner.id === id ? null : { id: owner.id, title: owner.title },
    })),
  }
}

const samePath = (a: string, b: string) =>
  a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()

// --- posts (the ticket's feed; stored in `updates`) and their replies ---

/** Who a post is signed with: `actor`, or with `as` one of the project's agents, posted via `actor`. */
function signer(projectId: number, actor: string, as?: string) {
  if (!as) return { author: actor, via: '' }
  return { author: actingAs(projectId, as).name, via: actor }
}

/**
 * The tab of the ticket's feed a new post goes to when its writer names none, by the first rule that
 * fits: a decision card, main; the human's post, main; the summary, main; a progress post or one made
 * as one of the project's agents (`via` set: the review phases, the builder), agents; anything else
 * (a question to the human, an answer), main.
 */
export function tabOf(p: {
  decision: boolean
  human: boolean
  summary: boolean
  progress: boolean
  via: string
}): FeedTab {
  if (p.decision) return 'main'
  if (p.human || p.summary) return 'main'
  if (p.progress || p.via) return 'agents'
  return 'main'
}

/**
 * A post on a ticket. `progress` (the default, what `post_update` means) marks a step of the work: lane
 * summaries and the Daily view pick those out. Without it, it is discussion: a question, an answer.
 * `tab` puts it in that tab of the feed; left out, tabOf picks it. `summary` makes it a new
 * version of the ticket's summary (setSummary), never progress.
 */
export function postUpdate(
  ticketId: number,
  body: string,
  attachmentIds: number[],
  actor: string,
  opts: {
    as?: string
    progress?: boolean
    tab?: FeedTab
    decision?: boolean
    summary?: { change: string; first: boolean }
  } = {},
) {
  const ticket = getTicket(ticketId)
  const { author, via } = signer(ticket.projectId, actor, opts.as)
  const summary = Boolean(opts.summary)
  const progress = !summary && (opts.progress ?? true)
  const tab =
    opts.tab ??
    tabOf({
      decision: opts.decision ?? false,
      human: !via && isHumanName(author),
      summary,
      progress,
      via,
    })
  // A file that is not there or already attached is refused before anything is written, and the post
  // and its files land together: a refused file never leaves a post (a summary's version) behind.
  assertUnattached(attachmentIds)
  const row = db.transaction(() => {
    const inserted = db
      .insert(schema.updates)
      .values({
        ticketId,
        author,
        via,
        body,
        progress,
        tab,
        summary,
        summaryChange: opts.summary?.change ?? '',
      })
      .returning()
      .get()
    attachTo(attachmentIds, { updateId: inserted.id })
    return inserted
  })
  touch(ticketId)
  const on = `#${ticketId} ${ticket.title}${via ? ` (via ${via})` : ''}`
  logActivity({
    projectId: ticket.projectId,
    actor: author,
    kind: summary ? 'summary' : progress ? 'update' : 'comment',
    text: opts.summary
      ? `${opts.summary.first ? 'wrote the summary of' : 'updated the summary of'} ${on}: ${opts.summary.change || gist(body)}`
      : `${progress ? 'posted an update on' : 'posted on'} ${on}: ${firstLine(body)}`,
    refType: 'ticket',
    refId: ticketId,
  })
  return row
}

/** The longest "what changed" line a summary version keeps. */
export const MAX_SUMMARY_CHANGE = 200

/**
 * Write the ticket's summary: the one post at the top of the feed's main tab that says what the change
 * does, where it stands, each review round's verdict, the PR, the preview and what to try there, and
 * the proofs (files). Each write is a new version, kept with the earlier ones as its history; `change`
 * says in one line what changed since the last one (needed from the second version on). Like a new
 * post by its writer it bumps the ticket and reaches the inboxes, so a rewrite is never silent. It is
 * what the Summary phase the board ticks reads (autoPhases.summaryWritten).
 */
export function setSummary(
  ticketId: number,
  input: { body: string; change?: string; attachmentIds?: number[]; as?: string },
  actor: string,
) {
  getTicket(ticketId)
  const body = input.body.trim()
  if (!body) throw new HttpError(400, 'the summary is empty')
  const change = (input.change ?? '').replace(/\s+/g, ' ').trim()
  if (change.length > MAX_SUMMARY_CHANGE)
    throw new HttpError(400, `say what changed in one line of at most ${MAX_SUMMARY_CHANGE} characters`)
  const first = !db
    .select({ id: schema.updates.id })
    .from(schema.updates)
    .where(and(eq(schema.updates.ticketId, ticketId), eq(schema.updates.summary, true)))
    .get()
  if (!first && !change)
    throw new HttpError(400, 'say what changed since the last version, in change (one line)')
  postUpdate(ticketId, body, input.attachmentIds ?? [], actor, {
    as: input.as,
    progress: false,
    summary: { change, first },
  })
  return getTicketFull(ticketId).summary!
}

/** The first line that says something: markdown markers stripped, bare labels ("Evidence:") skipped. */
export function gist(body: string, max = 120) {
  const lines = body
    .split('\n')
    .map((l) =>
      l
        .replace(/^\s*(?:#+|[-*+>]|\d+\.)\s+/, '')
        .replace(/\*\*|__|`/g, '')
        .trim(),
    )
    .filter(Boolean)
  const line = lines.find((l) => !/^[^.!?]{0,40}:$/.test(l)) ?? lines[0] ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export const firstLine = (s: string, max = 120) => {
  const line = s.trim().split('\n')[0] ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

// --- comments (threads on tickets, updates, PRs, review results) ---

/** The parent types a thread can have. The comments a PR once had stay in the database, unread. */
function assertThreadParent(parentType: string) {
  if (!(COMMENT_PARENTS as readonly string[]).includes(parentType))
    throw new HttpError(400, `${parentType} has no thread`)
}

/**
 * A thread. On a ticket that is its posts, oldest first, shaped like comments (with `progress`); on a
 * post, its replies; on a review result, its comments.
 */
export function listComments(parentType: schema.CommentParent, parentId: number) {
  assertThreadParent(parentType)
  if (parentType === 'ticket') {
    const posts = db
      .select()
      .from(schema.updates)
      .where(eq(schema.updates.ticketId, parentId))
      .orderBy(asc(schema.updates.createdAt), asc(schema.updates.id))
      .all()
    const ids = posts.map((p) => p.id)
    const files = ids.length
      ? db.select().from(schema.attachments).where(inArray(schema.attachments.updateId, ids)).all()
      : []
    return posts.map(({ ticketId, ...p }) => ({
      ...p,
      parentType: 'ticket' as const,
      parentId: ticketId,
      replyTo: null,
      attachments: files.filter((f) => f.updateId === p.id).map((f) => attachmentView(f)),
    }))
  }
  const rows = db
    .select()
    .from(schema.comments)
    .where(and(eq(schema.comments.parentType, parentType), eq(schema.comments.parentId, parentId)))
    .orderBy(asc(schema.comments.createdAt))
    .all()
  const ids = rows.map((c) => c.id)
  const files = ids.length
    ? db.select().from(schema.attachments).where(inArray(schema.attachments.commentId, ids)).all()
    : []
  return rows.map((c) => ({
    ...c,
    attachments: files.filter((f) => f.commentId === c.id).map((f) => attachmentView(f)),
  }))
}

export type ThreadStats = { count: number; lastAuthor: string | null; lastAt: string | null }
const NO_THREAD: ThreadStats = { count: 0, lastAuthor: null, lastAt: null }

/** How many comments hang under each of these parents, and who spoke last. */
function threadStats(parentType: schema.CommentParent, ids: number[]) {
  const out = new Map<number, ThreadStats>()
  if (!ids.length) return out
  const rows = db
    .select({
      parentId: schema.comments.parentId,
      author: schema.comments.author,
      at: schema.comments.createdAt,
    })
    .from(schema.comments)
    .where(and(eq(schema.comments.parentType, parentType), inArray(schema.comments.parentId, ids)))
    .orderBy(asc(schema.comments.createdAt), asc(schema.comments.id))
    .all()
  for (const c of rows) {
    const t = out.get(c.parentId) ?? { ...NO_THREAD }
    out.set(c.parentId, { count: t.count + 1, lastAuthor: c.author, lastAt: c.at })
  }
  return out
}

/**
 * The threads in a project waiting on `actor`: ones they spoke in or whose subject is theirs (a ticket
 * assigned to or opened by them, their update, their review), where someone else spoke last. Threads
 * waiting on one of the project's agents come too, with `as` set to it, for `actor` to answer as that
 * agent. Newest first; `waiting` counts the comments since the actor (or agent) last spoke.
 */
export function listOpenThreads(projectId: number, actor: string) {
  return openThreads(projectId, [actor], { agents: true, discussion: false })
}

/**
 * The threads in a project waiting on the human, who may sign in under several names (one per
 * device). A ticket's feed counts only its discussion here: progress posts are reports, not
 * questions, and a feed ending on an open decision is left to the decision itself.
 */
export function listHumanThreads(projectId: number, names: string[]) {
  return openThreads(projectId, names, { agents: false, discussion: true })
}

function openThreads(projectId: number, me: string[], opts: { agents: boolean; discussion: boolean }) {
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
          tab: schema.updates.tab,
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

  // owners: whose subject it is (a ticket's assignee and opener, a post's author). A PR's own ticket is
  // its PR's author's.
  const authors = new Map(
    db
      .select({ id: schema.prs.id, author: schema.prs.author })
      .from(schema.prs)
      .where(eq(schema.prs.projectId, projectId))
      .all()
      .map((p) => [p.id, p.author]),
  )
  type Subject = { ticketId: number | null; title: string; owners: string[] }
  const subjects = new Map<string, Subject>()
  for (const t of tickets)
    subjects.set(`ticket:${t.id}`, {
      ticketId: t.id,
      title: t.title,
      owners: t.prId === null ? [t.assignee, t.createdBy] : [authors.get(t.prId) ?? ''],
    })
  for (const u of updates)
    subjects.set(`update:${u.id}`, {
      ticketId: u.ticketId,
      title: `post on #${u.ticketId} ${ticketById.get(u.ticketId)?.title ?? ''}: ${gist(u.body, 60)}`,
      owners: [u.author],
    })
  for (const r of reviews)
    subjects.set(`review:${r.id}`, {
      ticketId: null,
      title: `review of PR #${r.prNumber} (${r.verdict})`,
      owners: [r.author],
    })

  const ids = (type: string) =>
    [...subjects.keys()].filter((k) => k.startsWith(`${type}:`)).map((k) => Number(k.split(':')[1]))
  const comments = (['update', 'review'] as const).flatMap((type) => {
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
  // A ticket's conversation is its posts, in order; a post's, PR's or review's is its comments.
  const posts = opts.discussion ? updates.filter((u) => !u.progress) : updates
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

  const agents = listAgents(projectId)
  const postTab = new Map(updates.map((u) => [u.id, u.tab]))
  const out = []
  for (const [key, list] of threads) {
    const subject = subjects.get(key)!
    const last = list[list.length - 1]!
    const entry = (who: (name: string) => boolean, as: string | null) => ({
      parentType: last.parentType,
      parentId: last.parentId,
      ticketId: subject.ticketId,
      title: subject.title,
      // The tab of the ticket's feed it is in: the last post's, or the post a reply is under; null off a ticket.
      tab:
        last.parentType === 'ticket'
          ? (postTab.get(last.id) ?? null)
          : last.parentType === 'update'
            ? (postTab.get(last.parentId) ?? null)
            : null,
      // Set when the thread waits on one of the project's agents: answer with comment as: <that name>.
      as,
      waiting: list.length - 1 - list.map((c) => who(c.author)).lastIndexOf(true),
      last: { id: last.id, author: last.author, text: gist(last.body), createdAt: last.createdAt },
    })
    if (opts.discussion && last.parentType === 'ticket' && openDecisions.has(last.id)) continue
    const spoke = list.some((c) => isMe(c.author))
    if (!isMe(last.author) && (spoke || subject.owners.some(isMe))) {
      out.push(entry(isMe, null))
      continue
    }
    if (!opts.agents) continue
    // Else it may wait on one of the project's agents: mentioned last, or it spoke there, or it is its subject.
    const named = mentions(last.body)
    const lower = (s: string) => s.toLowerCase()
    const agent = agents.find((a) => {
      const n = lower(a.name)
      if (lower(last.author) === n) return false
      return (
        named.includes(n) ||
        list.some((c) => lower(c.author) === n) ||
        subject.owners.some((o) => lower(o) === n)
      )
    })
    if (agent) out.push(entry((name) => name === agent.name, agent.name))
  }
  return out.sort((a, b) => b.last.createdAt.localeCompare(a.last.createdAt))
}

/**
 * The threads waiting on `actor`, from a cursor the caller keeps: with `since` (an ISO time), only the
 * ones whose last word, by someone else, came after it. `cursor` is the newest last word seen, or
 * `since` when nothing new came (null until there is one): pass it as `since` next time. Read-only;
 * nothing is stored per caller.
 */
export function myThreads(projectId: number, actor: string, since?: string | null) {
  const from = since ? sinceTime(since) : null
  const all = listOpenThreads(projectId, actor)
  const threads = from === null ? all : all.filter((t) => Date.parse(t.last.createdAt) > from)
  // Newest first, and each one after `since`, so the cursor only moves forward.
  const cursor = threads[0]?.last.createdAt ?? (from === null ? null : new Date(from).toISOString())
  return { cursor, threads }
}

function sinceTime(since: string) {
  const t = Date.parse(since)
  if (Number.isNaN(t)) throw new HttpError(400, `since must be an ISO time, not "${since}"`)
  return t
}

/** The cheap poll for new comments: what myThreads finds, without bodies. */
export function checkInbox(projectId: number, actor: string, since?: string | null) {
  const { cursor, threads } = myThreads(projectId, actor, since)
  return {
    count: threads.length,
    cursor,
    // The project's report, while the board is reminding about it: write it with the human's go-ahead.
    reportDue: reportDueFor(projectId),
    threads: threads.map((t) => ({
      ticketId: t.ticketId,
      title: t.title,
      parentType: t.parentType,
      parentId: t.parentId,
      as: t.as,
      lastAuthor: t.last.author,
      lastAt: t.last.createdAt,
    })),
  }
}

export function addComment(
  input: {
    parentType: schema.CommentParent
    parentId: number
    replyTo?: number | null
    body: string
    attachmentIds?: number[]
    /** One of the project's agents, answering through the connected agent `actor`. */
    as?: string
    /** On a ticket without replyTo, the tab of the feed the post goes to (tabOf when left out). */
    tab?: FeedTab
  },
  actor: string,
): schema.Comment | schema.Update {
  assertThreadParent(input.parentType)
  // On a ticket, a comment is a post (not progress); with replyTo, a reply under that post, in its tab.
  if (input.parentType === 'ticket') {
    if (!input.replyTo)
      return postUpdate(input.parentId, input.body, input.attachmentIds ?? [], actor, {
        as: input.as,
        progress: false,
        tab: input.tab,
      })
    const post = getPost(input.replyTo)
    if (post.ticketId !== input.parentId)
      throw new HttpError(400, `post ${input.replyTo} is not on ticket ${input.parentId}`)
    return addComment({ ...input, parentType: 'update', parentId: post.id, replyTo: null }, actor)
  }
  const projectId = commentProject(input.parentType, input.parentId)
  // A reply nests under a comment of the same thread: one elsewhere would be stored where no thread shows it.
  if (input.replyTo) {
    const to = db.select().from(schema.comments).where(eq(schema.comments.id, input.replyTo)).get()
    if (!to || to.parentType !== input.parentType || to.parentId !== input.parentId)
      throw new HttpError(
        400,
        `comment ${input.replyTo} is not in this thread (${input.parentType} ${input.parentId})`,
      )
  }
  const { author, via } = signer(projectId, actor, input.as)
  const row = db
    .insert(schema.comments)
    .values({
      parentType: input.parentType,
      parentId: input.parentId,
      replyTo: input.replyTo ?? null,
      author,
      via,
      body: input.body,
    })
    .returning()
    .get()
  attachTo(input.attachmentIds ?? [], { commentId: row.id })
  logActivity({
    projectId,
    actor: author,
    kind: 'comment',
    text: `commented on ${input.parentType} #${input.parentId}${via ? ` (via ${via})` : ''}: ${firstLine(input.body)}`,
    refType: input.parentType,
    refId: input.parentId,
  })
  return row
}

/** Files go with the ticket's instructions, alongside what is written there. */
export function attachToTicket(ticketId: number, attachmentIds: number[], actor: string) {
  const ticket = getTicket(ticketId)
  attachTo(attachmentIds, { ticketId })
  touch(ticketId)
  logActivity({
    projectId: ticket.projectId,
    actor,
    kind: 'ticket',
    text: `attached ${attachmentIds.length} file${attachmentIds.length === 1 ? '' : 's'} to #${ticketId} ${ticket.title}`,
    refType: 'ticket',
    refId: ticketId,
  })
  return getTicketFull(ticketId).attachments
}

export function removeTicketFile(ticketId: number, attachmentId: number, actor: string) {
  const ticket = getTicket(ticketId)
  const a = db.select().from(schema.attachments).where(eq(schema.attachments.id, attachmentId)).get()
  if (!a || a.ticketId !== ticketId) throw notFound('file on this ticket')
  db.delete(schema.attachments).where(eq(schema.attachments.id, attachmentId)).run()
  logActivity({
    projectId: ticket.projectId,
    actor,
    kind: 'ticket',
    text: `removed ${a.name} from #${ticketId} ${ticket.title}`,
    refType: 'ticket',
    refId: ticketId,
  })
}

/**
 * A decision only the human should make, as a post on the ticket: `body` is the question, `options` the
 * answers to pick from (one may be recommended). With `block` (the default) the ticket moves to the
 * project's blocked stage until it is decided.
 */
export function askDecision(ticketId: number, input: DecisionInput, actor: string) {
  return postDecision(ticketId, input, actor)
}

type DecisionInput = {
  body: string
  options: schema.DecisionOption[]
  as?: string
  block?: boolean
  tab?: FeedTab
}

/**
 * askDecision, and an archive or repo request's card: `archiveTickets` are the tickets its first option
 * archives, `repoRequest` the repo it adds, `did` the activity line (asked for a decision, by default).
 */
function postDecision(
  ticketId: number,
  input: DecisionInput,
  actor: string,
  extra: { archiveTickets?: number[]; repoRequest?: schema.RepoRequest; did?: string } = {},
) {
  const options = input.options
    .map((o) => ({ ...o, label: o.label.trim(), detail: o.detail?.trim() || undefined }))
    .filter((o) => o.label)
  if (options.length < 2 || options.length > 5) throw new HttpError(400, 'give 2 to 5 options')
  if (options.filter((o) => o.recommended).length > 1)
    throw new HttpError(400, 'recommend at most one option')
  const post = postUpdate(ticketId, input.body, [], actor, {
    as: input.as,
    progress: false,
    decision: true,
    tab: input.tab,
  })
  const row = db
    .update(schema.updates)
    .set({
      decision: options,
      archiveTickets: extra.archiveTickets ?? null,
      repoRequest: extra.repoRequest ?? null,
    })
    .where(eq(schema.updates.id, post.id))
    .returning()
    .get()!
  const ticket = getTicket(ticketId)
  const stages = listStages(ticket.projectId)
  const blocked = firstOfKind(stages, 'blocked')
  if ((input.block ?? true) && blocked && ticket.status !== blocked.key) {
    db.update(schema.tickets)
      .set({ status: blocked.key, ...movePatch(stages, ticket.status, blocked.key, ticket.startedAt) })
      .where(eq(schema.tickets.id, ticketId))
      .run()
    noteStageMove(ticketId, ticket.status, blocked.key)
  }
  logActivity({
    projectId: ticket.projectId,
    actor: post.author,
    kind: 'ticket',
    text: extra.did ?? `asked for a decision on #${ticketId} ${ticket.title}: ${firstLine(input.body, 80)}`,
    refType: 'ticket',
    refId: ticketId,
  })
  return row
}

/**
 * The human's answer to a decision: the option picked, and an optional note. It is posted as a reply
 * under the decision too, so the agent that asked finds it in its threads. A blocked ticket goes back
 * to the project's work stage (`workStage`) once no decision on it is left open, except a PR's ticket, which
 * goes to the stage its PR's status gives. Deciding again changes the answer, and drops a relayed one:
 * the card then shows only the human's own decision.
 */
export function decide(
  postId: number,
  option: number,
  note: string,
  actor: string,
  opts: { origin?: string | null } = {},
) {
  const post = getPost(postId)
  if (!post.decision) throw new HttpError(400, `post ${postId} is not a decision`)
  const picked = post.decision[option]
  if (!picked) throw new HttpError(400, `no option ${option}; there are ${post.decision.length}`)
  const changed = post.decidedAt !== null
  const row = db
    .update(schema.updates)
    .set({
      decidedOption: option,
      decidedBy: actor,
      decidedAt: new Date().toISOString(),
      relayedBy: '',
      relayedText: '',
    })
    .where(eq(schema.updates.id, postId))
    .returning()
    .get()!
  // An archive request answered Archive archives, every time it is: also when the answer changes to it,
  // and again on a card already answered Archive (a ticket restored since goes back to the archive).
  // Changing it to Keep restores nothing (the human restores from the Archived tab).
  const archive = row.archiveTickets && option === 0 ? archiveRequested(row, actor) : null
  // A repo request answered Add adds the repo, every time it is (`opts.origin`: answerOrigin).
  const repo = row.repoRequest && option === 0 ? repoRequested(row, actor, opts.origin) : null
  const words = `${changed ? 'Changed the decision to' : 'Decided'}: **${picked.label}**${note.trim() ? `\n\n${note.trim()}` : ''}${archiveWords(archive)}${repoWords(repo)}`
  settleDecision(row, actor, words, `decided "${picked.label}"`)
  return { ...row, archive, repo }
}

/**
 * The orchestrator's record of the human's answer to a decision, given in the chat: the card is decided
 * with the human's pick, `relayedBy` the connected agent `actor` and `relayedText` the words as the
 * human gave them. The board cannot see the chat, so it trusts the connected agent's account of it. The
 * relay is refused to a human, to any call with `as` (one of the project's agents), and to a card
 * already decided, and to a sub-identity (`delegated`: a worker that said who it is). A delegated
 * subagent that calls with the orchestrator's token and names no sub-identity looks the same as the
 * orchestrator here: only the instructions keep it from relaying. The check and the
 * write are one statement, so two relays cannot both land.
 */
export function relayDecision(
  postId: number,
  input: { option: number; words: string; as?: string },
  actor: string,
  opts: { agent: boolean; delegated?: boolean; origin?: string | null },
) {
  if (!opts.agent)
    throw new HttpError(403, 'only a connected agent relays a decision: the human answers the card')
  // A sub-identity (X-Agent-Name, agentName) is a delegated worker, never the session with the human.
  if (opts.delegated) throw new HttpError(403, 'only the session that talks to the human relays an answer')
  if (input.as !== undefined)
    throw new HttpError(403, "a decision is relayed by the orchestrator, not as one of the project's agents")
  const words = input.words.trim()
  if (!words || words.length > 5_000)
    throw new HttpError(400, "give the human's answer as they gave it: 1 to 5000 characters")
  const post = getPost(postId)
  if (!post.decision) throw new HttpError(400, `post ${postId} is not a decision`)
  const picked = post.decision[input.option]
  if (!picked) throw new HttpError(400, `no option ${input.option}; there are ${post.decision.length}`)
  const alreadyDecided = `decision ${postId} is already decided; the human changes it on the card`
  if (post.decidedAt !== null) throw new HttpError(409, alreadyDecided, 'decided')
  const row = db
    .update(schema.updates)
    .set({
      decidedOption: input.option,
      decidedBy: '',
      decidedAt: new Date().toISOString(),
      relayedBy: actor,
      relayedText: words,
    })
    .where(and(eq(schema.updates.id, postId), isNull(schema.updates.decidedAt)))
    .returning()
    .get()
  // Nothing matched: another answer landed between the read above and this write.
  if (!row) throw new HttpError(409, alreadyDecided, 'decided')
  // The archive is the human's, never the relaying agent's: it goes to the human the board last saw sign in.
  const archive =
    row.archiveTickets && input.option === 0 ? archiveRequested(row, lastHuman() ?? 'human', actor) : null
  // So is a requested repo.
  const repo =
    row.repoRequest && input.option === 0
      ? repoRequested(row, lastHuman() ?? 'human', opts.origin, actor)
      : null
  settleDecision(
    row,
    actor,
    `Decided in chat: **${picked.label}**\n\n${words}${archiveWords(archive)}${repoWords(repo)}`,
    `relayed the decision "${picked.label}"`,
  )
  return { ...row, archive, repo }
}

/**
 * What answering a decision does once its row is set, for the human's answer and a relayed one alike:
 * the reply under the card (`reply`, by `actor`), a blocked ticket back to the project's first active
 * stage once no decision on it is left open, the touch, and the activity line (`did` is what was done,
 * with the option's label).
 */
function settleDecision(post: { id: number; ticketId: number }, actor: string, reply: string, did: string) {
  addComment({ parentType: 'update', parentId: post.id, body: reply }, actor)
  const ticket = getTicket(post.ticketId)
  const stages = listStages(ticket.projectId)
  const stillOpen = db
    .select({ id: schema.updates.id })
    .from(schema.updates)
    .where(
      and(
        eq(schema.updates.ticketId, ticket.id),
        isNotNull(schema.updates.decision),
        isNull(schema.updates.decidedAt),
      ),
    )
    .get()
  if (!stillOpen && kindOf(stages, ticket.status) === 'blocked') {
    // A PR's ticket goes to the stage its PR's status gives. Otherwise (any other ticket, or the PR's stage or
    // row missing), to where the project's work starts (the first active stage unless it chose one).
    const pr = ticket.prId
      ? db.select().from(schema.prs).where(eq(schema.prs.id, ticket.prId)).get()
      : undefined
    const back = (pr && prTicketStage(stages, prStatus(pr))) ?? projectWorkStage(ticket.projectId, stages)
    if (back && back.key !== ticket.status) {
      db.update(schema.tickets)
        .set({ status: back.key, ...movePatch(stages, ticket.status, back.key, ticket.startedAt) })
        .where(eq(schema.tickets.id, ticket.id))
        .run()
      noteStageMove(ticket.id, ticket.status, back.key)
    }
  }
  touch(ticket.id)
  logActivity({
    projectId: ticket.projectId,
    actor,
    kind: 'ticket',
    text: `${did} on #${ticket.id} ${ticket.title}`,
    refType: 'ticket',
    refId: ticket.id,
  })
}

export function getPost(id: number) {
  const p = db.select().from(schema.updates).where(eq(schema.updates.id, id)).get()
  if (!p) throw notFound('post')
  return p
}

function getComment(id: number) {
  const c = db.select().from(schema.comments).where(eq(schema.comments.id, id)).get()
  if (!c) throw notFound('comment')
  return c
}

/**
 * Its author changes a post or reply (a connected agent also what it posted as one of the project's
 * agents, via it); the human changes anything.
 */
function mayChange(row: { author: string; via: string }, actor: string, human: boolean) {
  if (human || row.author === actor || row.via === actor) return
  throw new HttpError(403, `only ${row.author} or the human can change this`)
}

/** A summary's versions are its history: a new version is written (setSummary), never an edit. */
function keepSummary(post: Post) {
  if (post.summary)
    throw new HttpError(
      409,
      'a version of the summary is kept as it was written: write a new version (set_ticket_summary) instead',
    )
}

/** Its body, whether it is progress, and the tab of the feed it shows in (`tab`: only moved this way). */
export function editPost(
  id: number,
  patch: { body?: string; progress?: boolean; tab?: FeedTab },
  actor: string,
  opts: { human?: boolean } = {},
) {
  const before = getPost(id)
  mayChange(before, actor, opts.human ?? false)
  if (patch.body === undefined && patch.progress === undefined && patch.tab === undefined)
    throw new HttpError(400, 'give the new body, progress or tab')
  if (patch.body !== undefined || patch.progress !== undefined) keepSummary(before)
  // An archive request's card shows the tickets its Archive archives (archiveTickets): its words stay as
  // they were posted, so the card can never name other tickets than the ones it archives.
  if (patch.body !== undefined && before.archiveTickets)
    throw new HttpError(
      409,
      "an archive request's card names the tickets it archives and is not edited: ask again with request_archive instead",
    )
  // So does a repo request's card, with the repo its Add adds.
  if (patch.body !== undefined && before.repoRequest)
    throw new HttpError(
      409,
      "a repo request's card names the repo it adds and is not edited: ask again with add_repo instead",
    )
  const edited = patch.body !== undefined && patch.body !== before.body
  const row = db
    .update(schema.updates)
    .set({ ...patch, ...(edited ? { editedAt: new Date().toISOString() } : {}) })
    .where(eq(schema.updates.id, id))
    .returning()
    .get()!
  const ticket = getTicket(row.ticketId)
  const mark =
    (patch.progress === undefined || patch.progress === before.progress
      ? ''
      : patch.progress
        ? ' (marked as progress)'
        : ' (no longer progress)') +
    (patch.tab === undefined || patch.tab === before.tab
      ? ''
      : ` (moved to ${patch.tab === 'main' ? 'Main' : 'Agents'})`)
  logActivity({
    projectId: ticket.projectId,
    actor,
    kind: 'update',
    text: `edited a post on #${ticket.id} ${ticket.title}${mark}`,
    refType: 'ticket',
    refId: ticket.id,
  })
  return row
}

/** Its replies and files go with it. */
export function deletePost(id: number, actor: string, opts: { human?: boolean } = {}) {
  const post = getPost(id)
  mayChange(post, actor, opts.human ?? false)
  keepSummary(post)
  db.delete(schema.comments)
    .where(and(eq(schema.comments.parentType, 'update'), eq(schema.comments.parentId, id)))
    .run()
  db.delete(schema.updates).where(eq(schema.updates.id, id)).run()
  const ticket = getTicket(post.ticketId)
  logActivity({
    projectId: ticket.projectId,
    actor,
    kind: 'update',
    text: `deleted a post by ${post.author} on #${ticket.id} ${ticket.title}: ${firstLine(post.body, 60)}`,
    refType: 'ticket',
    refId: ticket.id,
  })
}

export function editComment(id: number, body: string, actor: string, opts: { human?: boolean } = {}) {
  const before = getComment(id)
  // Checked before the write: a comment on a thread that no longer exists is not changed.
  const projectId = commentProject(before.parentType, before.parentId)
  mayChange(before, actor, opts.human ?? false)
  const row = db
    .update(schema.comments)
    .set({ body, ...(body !== before.body ? { editedAt: new Date().toISOString() } : {}) })
    .where(eq(schema.comments.id, id))
    .returning()
    .get()!
  logActivity({
    projectId,
    actor,
    kind: 'comment',
    text: `edited a reply on ${row.parentType} #${row.parentId}`,
    refType: row.parentType,
    refId: row.parentId,
  })
  return row
}

/** Replies nested under it go with it, and their files. */
export function deleteComment(id: number, actor: string, opts: { human?: boolean } = {}) {
  const c = getComment(id)
  // Checked before the delete: a comment on a thread that no longer exists is not removed.
  const projectId = commentProject(c.parentType, c.parentId)
  mayChange(c, actor, opts.human ?? false)
  db.delete(schema.comments).where(eq(schema.comments.replyTo, id)).run()
  db.delete(schema.comments).where(eq(schema.comments.id, id)).run()
  logActivity({
    projectId,
    actor,
    kind: 'comment',
    text: `deleted a reply by ${c.author} on ${c.parentType} #${c.parentId}: ${firstLine(c.body, 60)}`,
    refType: c.parentType,
    refId: c.parentId,
  })
}

function commentProject(parentType: schema.CommentParent, parentId: number): number {
  switch (parentType) {
    case 'ticket':
      return getTicket(parentId).projectId
    case 'update': {
      const u = db.select().from(schema.updates).where(eq(schema.updates.id, parentId)).get()
      if (!u) throw notFound('update')
      return getTicket(u.ticketId).projectId
    }
    case 'review': {
      const r = db.select().from(schema.reviewResults).where(eq(schema.reviewResults.id, parentId)).get()
      if (!r) throw notFound('review result')
      return r.projectId
    }
    default:
      throw new HttpError(400, 'unknown parent type')
  }
}
