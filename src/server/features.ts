import { and, asc, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'

import { db, schema } from '#/db'
import { type Complexity, DEFAULT_COMPLEXITY, RESUME_TEMPLATE } from '#/lib/constants'
import { MAX_TAG_LENGTH, MAX_TAGS } from '#/lib/tags'
import { logActivity } from './activity'
import { baseChain, gitCache, type GitCache, infoOf, reachOf } from './cleanup'
import { branchHead, NO_BRANCH } from './git'
import { HttpError, notFound } from './http'
import { getProject } from './projects'
import { actingAs, findAgent, listAgents, mentions } from './projectAgents'
import { cannotStart, forgetPreview, managedPreview, stopPreviewsFor } from './managedPreview'
import { previewState, previewUrl, type PreviewState } from './preview'
import { prForTicket, refreshPrsInBackground, withMergeCheck } from './prs'
import { NO_PUSH, pushStates } from './push'
import { resolveRepo, ticketRepo } from './repos'
import { reportDueFor } from './reportDue'
import { type WithResume, type WithResumeBrief, resumeState, withoutResume } from './resume'
import {
  firstOfKind,
  kindOf,
  listStages,
  matchStages,
  resolveStage,
  startStage,
  startedPatch,
  stageOf,
} from './stages'
import { assertUnattached, attachTo, attachmentView } from './uploads'

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
 * Every ticket of a project with its own task progress, the progress rolled up over its lanes (and
 * theirs), how many of those tasks are blocked on the human, and how many lanes it has in each stage.
 * One pass over the project keeps this cheap.
 */
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
      progress: own.get(t.id)!,
      rollup: rollup(t.id),
      lanes,
    }
  })
}

/** The project agent a ticket is reserved for, or null when it is shared. */
export const reservedFor = (t: Pick<schema.Ticket, 'projectId' | 'assignee'>) =>
  findAgent(t.projectId, t.assignee)

/** A row of a ticket list as reads hand it out (`withResumeBriefs`). */
export type TicketRow = WithResumeBrief<ReturnType<typeof projectTickets>[number]>

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
 * by name first, each row saying where (`searchTickets`).
 */
export function listTickets(projectId: number, filter: TicketFilter = {}): ListedTicket[] {
  getProject(projectId)
  const tag = filter.tag?.trim().toLowerCase()
  const q = filter.q?.trim()
  const stages = filter.status?.length ? matchStages(listStages(projectId), filter.status) : null
  const rows = projectTickets(projectId).filter(
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
  const all = projectTickets(ticket.projectId)
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
  // One flat list in tree order: each top-level task, then its subtasks.
  const tasks = taskRows
    .filter((task) => !task.parentId)
    .flatMap((task) => [task, ...taskRows.filter((sub) => sub.parentId === task.id)])
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
  return {
    ...ticket,
    reserved: self.reserved,
    // Set when the ticket is reserved for one of the project's agents: who to brief, and with what.
    agent: agent
      ? { id: agent.id, name: agent.name, instructions: agent.instructions, avatarUrl: agent.avatarUrl }
      : null,
    // Files that go with the instructions, each with a local path.
    attachments: instructionFiles.map((f) => attachmentView(f)),
    // The ticket's own posts (count, who posted last); each post carries the thread of its replies below.
    thread: ticketThread,
    pr: prForTicket(ticket),
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
        ...withoutResume(l),
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

/** A ticket in full as reads hand it out (`withResume`): its resume note and state under `resume`. */
export type TicketFull = WithResume<ReturnType<typeof getTicketFull>>

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
  const t = getTicketFull(id, opts)
  const repo = ticketRepo(t)
  const branches = [t.branch, ...t.workspaces.map((w) => w.branch)]
  const push = repo
    ? await pushStates(repo.repoPath, branches, new Map(branches.map((b) => [b, t.baseBranch])))
    : null
  if (t.prNumber || t.branch) refreshPrsInBackground(t.projectId)
  return {
    ...t,
    pr: await withMergeCheck(t.pr),
    push: push?.get(t.branch) ?? NO_PUSH,
    workspaces: t.workspaces.map((w) => ({ ...w, push: push?.get(w.branch) ?? NO_PUSH })),
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
  },
  actor: string,
) {
  const { parent, repo, baseBranch } = placement(projectId, input)
  // Checked before the ticket exists, so a bad file does not leave a ticket behind without its files.
  const attachmentIds = input.attachmentIds ?? []
  assertUnattached(attachmentIds)
  // So is each task's tag: a bad one would otherwise leave the ticket behind without its tasks.
  if (input.tasks) newTaskTags(input.tasks)
  const stages = listStages(projectId)
  const status = (input.status ? resolveStage(stages, input.status) : startStage(stages)).key
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
    })
    .returning()
    .get()
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
  return row
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

export function updateTicket(
  id: number,
  patch: Partial<
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
  >,
  actor: string,
  opts: { agent?: boolean } = {},
) {
  const before = getTicket(id)
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
  if (patch.status) patch = { ...patch, status: resolveStage(stages, patch.status).key }
  const row = db
    .update(schema.tickets)
    .set({
      ...patch,
      ...(patch.status ? startedPatch(stages, before.status, patch.status, before.startedAt) : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.tickets.id, id))
    .returning()
    .get()!
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
  if (patch.tags && patch.tags.join('\n') !== before.tags.join('\n'))
    changes.push(`tags → ${patch.tags.join(', ') || 'none'}`)
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
  return row
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
 * blocked stage moves to the project's first active stage, if it has one.
 */
export function claimTicket(id: number, actor: string, opts: { branch?: string; as?: string } = {}) {
  const before = getTicket(id)
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
  const assignee = as?.name ?? actor
  const active = firstOfKind(stages, 'active')
  const start = (from.kind === 'open' || from.kind === 'blocked') && active ? active : null
  const row = db
    .update(schema.tickets)
    .set({
      assignee,
      ...(start ? { status: start.key } : {}),
      ...startedPatch(stages, before.status, start?.key ?? before.status, before.startedAt),
      ...(opts.branch !== undefined ? { branch: opts.branch } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(schema.tickets.id, id), eq(schema.tickets.assignee, before.assignee)))
    .returning()
    .get()
  if (!row) throw new HttpError(409, `ticket ${id} was reassigned while claiming it; read it again`)
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
    ? resolveStage(stages, opts.reopenTo)
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
      ...startedPatch(stages, t.status, status, t.startedAt),
      updatedAt: now,
    })
    .where(eq(schema.tickets.id, id))
    .returning()
    .get()!
  if (t.parentId) touch(t.parentId)
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
  // Its workspaces go with it (and its lanes', unless they are kept).
  const all = db.select().from(schema.tickets).where(eq(schema.tickets.projectId, t.projectId)).all()
  const gone = [id, ...(opts.keepLanes ? [] : laneTree(all, id).map((l) => l.id))]
  for (const w of db.select().from(schema.workspaces).where(inArray(schema.workspaces.ticketId, gone)).all())
    forgetPreview(w.id, actor)
  if (opts.keepLanes)
    db.update(schema.tickets).set({ parentId: t.parentId }).where(eq(schema.tickets.parentId, id)).run()
  db.delete(schema.tickets).where(eq(schema.tickets.id, id)).run()
  logActivity({ projectId: t.projectId, actor, kind: 'ticket', text: `deleted ticket #${id} ${t.title}` })
}

// --- archive (the human puts finished tickets away; their lanes go with them) ---

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Set or clear the archive mark on these tickets and every lane under them, in one write. */
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
      .set({ archivedAt, archivedBy: archivedAt ? actor : '' })
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
  const stage = resolveStage(listStages(projectId), status)
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
 * own tick. Run inside the transaction that changed the subtasks.
 */
function settleParent(parentId: number) {
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
  input: { name: string; branch?: string; path?: string; agent?: string; previewUrl?: string | null },
  actor: string,
) {
  const ticket = getTicket(ticketId)
  const preview = previewUrl(input.previewUrl)
  const row = db
    .insert(schema.workspaces)
    .values({
      ticketId,
      name: input.name,
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
 */
export async function workspacePreview(id: number) {
  const ws = getWorkspace(id)
  const state: PreviewState = ws.previewUrl
    ? await previewState(ws.previewUrl)
    : { running: false, checkedAt: new Date().toISOString() }
  return { ...state, url: ws.previewUrl, managed: managedPreview(id), cannotStart: cannotStart(id) }
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
    rows.filter((w) => w.ticketId === owner.id).map((w) => ({ w, owner, repo: ticketRepo(owner) })),
  )
  const repo = ticketRepo(ticket)
  const byId = new Map(all.map((t) => [t.id, t]))
  const [branch, ...wsState] = await Promise.all([
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
    workspaces: workspaces.map(({ w, owner }, i) => ({
      ...w,
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
 * A post on a ticket. `progress` (the default, what `post_update` means) marks a step of the work: lane
 * summaries and the Daily view pick those out. Without it, it is discussion: a question, an answer.
 */
export function postUpdate(
  ticketId: number,
  body: string,
  attachmentIds: number[],
  actor: string,
  opts: { as?: string; progress?: boolean; handoff?: boolean } = {},
) {
  const ticket = getTicket(ticketId)
  const { author, via } = signer(ticket.projectId, actor, opts.as)
  const progress = opts.progress ?? true
  const handoff = opts.handoff ?? false
  const row = db
    .insert(schema.updates)
    .values({ ticketId, author, via, body, progress, handoff })
    .returning()
    .get()
  attachTo(attachmentIds, { updateId: row.id })
  touch(ticketId)
  logActivity({
    projectId: ticket.projectId,
    actor: author,
    kind: handoff ? 'handoff' : progress ? 'update' : 'comment',
    text: `${handoff ? 'left a resume note on' : progress ? 'posted an update on' : 'posted on'} #${ticketId} ${ticket.title}${via ? ` (via ${via})` : ''}: ${handoff ? gist(body) : firstLine(body)}`,
    refType: 'ticket',
    refId: ticketId,
  })
  return row
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

// --- the resume note ("Where we left off") ---

/**
 * Write the ticket's resume note, for whoever picks it up next: `actor`, or with `as` one of the project's
 * agents (via `actor`). It records the ticket branch's head (when the branch is here locally) so later
 * commits show up as commits since the note. Each new version is also a handoff post in the feed, so
 * the earlier ones stay readable; saving the same note again only marks it as still current.
 */
export async function setResumeNote(
  ticketId: number,
  note: string,
  actor: string,
  opts: { as?: string } = {},
) {
  const ticket = getTicket(ticketId)
  const text = note.trim()
  if (!text) throw new HttpError(400, 'the resume note is empty')
  if (text === RESUME_TEMPLATE) throw new HttpError(400, 'fill in the template before saving it')
  const { author } = signer(ticket.projectId, actor, opts.as)
  const repo = ticketRepo(ticket)
  const sha = repo ? await branchHead(repo.repoPath, ticket.branch) : null
  const row = db
    .update(schema.tickets)
    .set({ resumeNote: text, resumeAt: new Date().toISOString(), resumeBy: author, resumeSha: sha })
    .where(eq(schema.tickets.id, ticketId))
    .returning()
    .get()!
  const post =
    text === ticket.resumeNote
      ? null
      : postUpdate(ticketId, text, [], actor, { as: opts.as, progress: true, handoff: true })
  return { resume: await resumeState(row), postId: post?.id ?? null }
}

// --- comments (threads on tickets, updates, PRs, review results) ---

/**
 * A thread. On a ticket that is its posts, oldest first, shaped like comments (with `progress`); on a
 * post, its replies; on a PR or a review result, its comments.
 */
export function listComments(parentType: schema.CommentParent, parentId: number) {
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

  // owners: whose subject it is (a ticket's assignee and opener, a post's author).
  type Subject = { ticketId: number | null; title: string; owners: string[] }
  const subjects = new Map<string, Subject>()
  for (const t of tickets)
    subjects.set(`ticket:${t.id}`, {
      ticketId: t.id,
      title: t.title,
      owners: [t.assignee, t.createdBy],
    })
  for (const u of updates)
    subjects.set(`update:${u.id}`, {
      ticketId: u.ticketId,
      title: `post on #${u.ticketId} ${ticketById.get(u.ticketId)?.title ?? ''}: ${gist(u.body, 60)}`,
      owners: [u.author],
    })
  for (const p of prs)
    subjects.set(`pr:${p.id}`, {
      ticketId: null,
      title: `PR #${p.number} ${p.title}`,
      owners: [p.author],
    })
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
  const out = []
  for (const [key, list] of threads) {
    const subject = subjects.get(key)!
    const last = list[list.length - 1]!
    const entry = (who: (name: string) => boolean, as: string | null) => ({
      parentType: last.parentType,
      parentId: last.parentId,
      ticketId: subject.ticketId,
      title: subject.title,
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
  },
  actor: string,
): schema.Comment | schema.Update {
  // On a ticket, a comment is a post (not progress); with replyTo, a reply under that post.
  if (input.parentType === 'ticket') {
    if (!input.replyTo)
      return postUpdate(input.parentId, input.body, input.attachmentIds ?? [], actor, {
        as: input.as,
        progress: false,
      })
    const post = getPost(input.replyTo)
    if (post.ticketId !== input.parentId)
      throw new HttpError(400, `post ${input.replyTo} is not on ticket ${input.parentId}`)
    return addComment({ ...input, parentType: 'update', parentId: post.id, replyTo: null }, actor)
  }
  const projectId = commentProject(input.parentType, input.parentId)
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
export function askDecision(
  ticketId: number,
  input: { body: string; options: schema.DecisionOption[]; as?: string; block?: boolean },
  actor: string,
) {
  const options = input.options
    .map((o) => ({ ...o, label: o.label.trim(), detail: o.detail?.trim() || undefined }))
    .filter((o) => o.label)
  if (options.length < 2 || options.length > 5) throw new HttpError(400, 'give 2 to 5 options')
  if (options.filter((o) => o.recommended).length > 1)
    throw new HttpError(400, 'recommend at most one option')
  const post = postUpdate(ticketId, input.body, [], actor, { as: input.as, progress: false })
  const row = db
    .update(schema.updates)
    .set({ decision: options })
    .where(eq(schema.updates.id, post.id))
    .returning()
    .get()!
  const ticket = getTicket(ticketId)
  const stages = listStages(ticket.projectId)
  const blocked = firstOfKind(stages, 'blocked')
  if ((input.block ?? true) && blocked && ticket.status !== blocked.key) {
    db.update(schema.tickets)
      .set({ status: blocked.key, ...startedPatch(stages, ticket.status, blocked.key, ticket.startedAt) })
      .where(eq(schema.tickets.id, ticketId))
      .run()
  }
  logActivity({
    projectId: ticket.projectId,
    actor: post.author,
    kind: 'ticket',
    text: `asked for a decision on #${ticketId} ${ticket.title}: ${firstLine(input.body, 80)}`,
    refType: 'ticket',
    refId: ticketId,
  })
  return row
}

/**
 * The human's answer to a decision: the option picked, and an optional note. It is posted as a reply
 * under the decision too, so the agent that asked finds it in its threads. A blocked ticket goes back
 * to the project's first active stage once no decision on it is left open. Deciding again changes
 * the answer.
 */
export function decide(postId: number, option: number, note: string, actor: string) {
  const post = getPost(postId)
  if (!post.decision) throw new HttpError(400, `post ${postId} is not a decision`)
  const picked = post.decision[option]
  if (!picked) throw new HttpError(400, `no option ${option}; there are ${post.decision.length}`)
  const changed = post.decidedAt !== null
  const row = db
    .update(schema.updates)
    .set({ decidedOption: option, decidedBy: actor, decidedAt: new Date().toISOString() })
    .where(eq(schema.updates.id, postId))
    .returning()
    .get()!
  const words = `${changed ? 'Changed the decision to' : 'Decided'}: **${picked.label}**${note.trim() ? `\n\n${note.trim()}` : ''}`
  addComment({ parentType: 'update', parentId: postId, body: words }, actor)
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
  const active = firstOfKind(stages, 'active')
  if (!stillOpen && active && kindOf(stages, ticket.status) === 'blocked')
    db.update(schema.tickets)
      .set({ status: active.key, ...startedPatch(stages, ticket.status, active.key, ticket.startedAt) })
      .where(eq(schema.tickets.id, ticket.id))
      .run()
  touch(ticket.id)
  logActivity({
    projectId: ticket.projectId,
    actor,
    kind: 'ticket',
    text: `decided "${picked.label}" on #${ticket.id} ${ticket.title}`,
    refType: 'ticket',
    refId: ticket.id,
  })
  return row
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

export function editPost(
  id: number,
  patch: { body?: string; progress?: boolean },
  actor: string,
  opts: { human?: boolean } = {},
) {
  const before = getPost(id)
  mayChange(before, actor, opts.human ?? false)
  const edited = patch.body !== undefined && patch.body !== before.body
  const row = db
    .update(schema.updates)
    .set({ ...patch, ...(edited ? { editedAt: new Date().toISOString() } : {}) })
    .where(eq(schema.updates.id, id))
    .returning()
    .get()!
  const ticket = getTicket(row.ticketId)
  const mark =
    patch.progress === undefined || patch.progress === before.progress
      ? ''
      : patch.progress
        ? ' (marked as progress)'
        : ' (no longer progress)'
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
  mayChange(before, actor, opts.human ?? false)
  const row = db
    .update(schema.comments)
    .set({ body, ...(body !== before.body ? { editedAt: new Date().toISOString() } : {}) })
    .where(eq(schema.comments.id, id))
    .returning()
    .get()!
  logActivity({
    projectId: commentProject(row.parentType, row.parentId),
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
  mayChange(c, actor, opts.human ?? false)
  db.delete(schema.comments).where(eq(schema.comments.replyTo, id)).run()
  db.delete(schema.comments).where(eq(schema.comments.id, id)).run()
  logActivity({
    projectId: commentProject(c.parentType, c.parentId),
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
    case 'pr': {
      const pr = db.select().from(schema.prs).where(eq(schema.prs.id, parentId)).get()
      if (!pr) throw notFound('PR')
      return pr.projectId
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
