import { and, asc, desc, eq, inArray, or } from 'drizzle-orm'

import { db, schema } from '#/db'
import { logActivity } from './activity'
import { baseChain, gitCache, reachOf } from './cleanup'
import { branchInfo } from './git'
import { HttpError, notFound } from './http'
import { getProject } from './projects'
import { prForTicket } from './prs'
import { resolveRepo, ticketRepo } from './repos'
import { firstOfKind, kindOf, listStages, matchStages, resolveStage, startStage, stageOf } from './stages'
import { attachTo, attachmentView } from './uploads'

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
 * theirs), and how many lanes it has in each stage. One pass over the project keeps this cheap.
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
  for (const task of allTasks) {
    const p = own.get(task.ticketId)!
    p.total++
    if (task.done) p.done++
  }
  const children = new Map<number, schema.Ticket[]>()
  for (const t of rows) if (t.parentId) children.set(t.parentId, [...(children.get(t.parentId) ?? []), t])
  // A cancelled lane's tasks are no longer part of the work.
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
    return { ...t, progress: own.get(t.id)!, rollup: rollup(t.id), lanes }
  })
}

export type TicketRow = ReturnType<typeof projectTickets>[number]

/** The lanes under a ticket, all the way down, nearest first. */
function laneTree<T extends Pick<schema.Ticket, 'id' | 'parentId'>>(all: T[], id: number): T[] {
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
  q?: string
}

/**
 * A project's tickets; `parentId` narrows to the lanes of one ticket (`null` to the top level), `tag`
 * to those carrying it (any casing), `status` to those stages, `assignee` to one name (`''` for
 * unassigned), `q` to a text match in the title or instructions.
 */
export function listTickets(projectId: number, filter: TicketFilter = {}) {
  getProject(projectId)
  const tag = filter.tag?.trim().toLowerCase()
  const q = filter.q?.trim().toLowerCase()
  const stages = filter.status?.length ? matchStages(listStages(projectId), filter.status) : null
  return projectTickets(projectId).filter(
    (t) =>
      (filter.parentId === undefined || t.parentId === filter.parentId) &&
      (!tag || t.tags.some((x) => x.toLowerCase() === tag)) &&
      (!stages || stages.has(t.status)) &&
      (filter.assignee === undefined || t.assignee === filter.assignee) &&
      (!q || t.title.toLowerCase().includes(q) || t.body.toLowerCase().includes(q)),
  )
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

  const tasks = db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.ticketId, id))
    .orderBy(asc(schema.tasks.position), asc(schema.tasks.id))
    .all()
  const workspaces = db.select().from(schema.workspaces).where(eq(schema.workspaces.ticketId, id)).all()
  const updates = db
    .select()
    .from(schema.updates)
    .where(inArray(schema.updates.ticketId, [id, ...descendants]))
    .orderBy(desc(schema.updates.createdAt))
    .all()
  // Each lane's newest update from anywhere under it, its own lanes included.
  const laneOf = (ticketId: number) => {
    let t = byId.get(ticketId)
    while (t && t.parentId !== id) t = t.parentId ? byId.get(t.parentId) : undefined
    return t?.id
  }
  const lastUpdate = new Map<number, (typeof updates)[number]>()
  for (const u of updates) {
    const lane = u.ticketId === id ? undefined : laneOf(u.ticketId)
    if (lane && !lastUpdate.has(lane)) lastUpdate.set(lane, u)
  }
  const feed = opts.laneUpdates ? updates : updates.filter((u) => u.ticketId === id)
  const updateIds = feed.map((u) => u.id)
  const files = updateIds.length
    ? db.select().from(schema.attachments).where(inArray(schema.attachments.updateId, updateIds)).all()
    : []
  const ticketThread = threadStats('ticket', [id]).get(id) ?? NO_THREAD
  const updateThreads = threadStats('update', updateIds)
  return {
    ...ticket,
    // The ticket's own thread; each update carries its own below.
    thread: ticketThread,
    pr: prForTicket(ticket),
    tasks,
    workspaces,
    progress: self.progress,
    rollup: self.rollup,
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
      // Set on a lane's update shown in its parent's feed.
      lane: u.ticketId === id ? null : { id: u.ticketId, title: byId.get(u.ticketId)?.title ?? '' },
      attachments: files.filter((f) => f.updateId === u.id).map((f) => attachmentView(f)),
      thread: updateThreads.get(u.id) ?? NO_THREAD,
    })),
  }
}

export type TicketFull = ReturnType<typeof getTicketFull>

export function createTicket(
  projectId: number,
  input: {
    title: string
    body?: string
    /** A stage key, name or kind; the project's last open stage when left out. */
    status?: string
    assignee?: string
    branch?: string
    baseBranch?: string
    repoId?: number | null
    parentId?: number | null
    tags?: string[]
    tasks?: string[]
    prNumber?: number | null
  },
  actor: string,
) {
  getProject(projectId)
  const parent = input.parentId ? getTicket(input.parentId) : null
  if (parent && parent.projectId !== projectId)
    throw new HttpError(400, `ticket ${parent.id} is not in project ${projectId}`)
  const repo = resolveRepo(projectId, input.repoId ?? parent?.repoId ?? (parent && ticketRepo(parent)?.id))
  // A lane branches off its parent's branch when they share a repo, so its PR goes back into it.
  const parentBase = parent && ticketRepo(parent)?.id === repo.id ? parent.branch || parent.baseBranch : ''
  const stages = listStages(projectId)
  const row = db
    .insert(schema.tickets)
    .values({
      projectId,
      repoId: repo.id,
      parentId: parent?.id ?? null,
      title: input.title,
      body: input.body ?? '',
      status: (input.status ? resolveStage(stages, input.status) : startStage(stages)).key,
      assignee: input.assignee ?? '',
      branch: input.branch ?? '',
      baseBranch: input.baseBranch || parentBase || repo.baseBranch,
      tags: cleanTags(input.tags ?? []),
      prNumber: input.prNumber ?? null,
      createdBy: actor,
    })
    .returning()
    .get()
  if (input.tasks?.length) addTasks(row.id, input.tasks, actor, { quiet: true })
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

/** Trimmed, at most 40 characters each, no repeats in any casing, at most 20. */
export function cleanTags(tags: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags) {
    const tag = raw.replace(/\s+/g, ' ').trim().slice(0, 40)
    if (!tag || seen.has(tag.toLowerCase())) continue
    seen.add(tag.toLowerCase())
    out.push(tag)
  }
  return out.slice(0, 20)
}

export function updateTicket(
  id: number,
  patch: Partial<
    Pick<
      schema.Ticket,
      'title' | 'body' | 'status' | 'assignee' | 'branch' | 'baseBranch' | 'repoId' | 'tags' | 'prNumber'
    >
  >,
  actor: string,
  opts: { guardClaim?: boolean } = {},
) {
  const before = getTicket(id)
  // An agent assigning itself a ticket someone else holds would silently take it from them.
  if (opts.guardClaim && patch.assignee === actor && before.assignee && before.assignee !== actor)
    throw new HttpError(409, `ticket ${id} is assigned to ${before.assignee}; ask in its thread first`)
  if (patch.repoId) resolveRepo(before.projectId, patch.repoId)
  if (patch.tags) patch = { ...patch, tags: cleanTags(patch.tags) }
  const stages = listStages(before.projectId)
  if (patch.status) patch = { ...patch, status: resolveStage(stages, patch.status).key }
  const row = db
    .update(schema.tickets)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(schema.tickets.id, id))
    .returning()
    .get()!
  const changes: string[] = []
  if (patch.status && patch.status !== before.status)
    changes.push(`status ${stageOf(stages, before.status).name} → ${stageOf(stages, patch.status).name}`)
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

/**
 * Take a ticket for `actor`: it must be unassigned or already theirs, and not in a done or cancelled
 * stage. The check and the write are one statement, so two agents claiming at once cannot both win. A
 * ticket waiting in an open or blocked stage moves to the project's first active stage, if it has one.
 */
export function claimTicket(id: number, actor: string, opts: { branch?: string } = {}) {
  const before = getTicket(id)
  const stages = listStages(before.projectId)
  const from = stageOf(stages, before.status)
  if (from.kind === 'done' || from.kind === 'cancelled')
    throw new HttpError(409, `ticket ${id} is ${from.kind} (${from.name})`)
  const active = firstOfKind(stages, 'active')
  const start = (from.kind === 'open' || from.kind === 'blocked') && active ? active : null
  const row = db
    .update(schema.tickets)
    .set({
      assignee: actor,
      ...(start ? { status: start.key } : {}),
      ...(opts.branch !== undefined ? { branch: opts.branch } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(eq(schema.tickets.id, id), or(eq(schema.tickets.assignee, ''), eq(schema.tickets.assignee, actor))),
    )
    .returning()
    .get()
  if (!row) {
    const holder = getTicket(id).assignee
    throw new HttpError(409, `ticket ${id} is already claimed by ${holder}`)
  }
  if (row.parentId) touch(row.parentId)
  if (before.assignee !== actor || start)
    logActivity({
      projectId: row.projectId,
      actor,
      kind: 'ticket',
      text: `claimed ${row.parentId ? 'lane' : 'ticket'} #${id} ${row.title}${start ? ` (status ${from.name} → ${start.name})` : ''}`,
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
  const row = db
    .update(schema.tickets)
    .set({
      approvedAt: verdict === 'approved' ? now : null,
      approvedBy: verdict === 'approved' ? actor : '',
      disapprovedAt: verdict === 'disapproved' ? now : null,
      disapprovedBy: verdict === 'disapproved' ? actor : '',
      ...(verdict === 'disapproved' && cancel
        ? { status: cancel.key }
        : finish
          ? { status: finish.key }
          : reopen
            ? { status: reopenTo.key }
            : {}),
      updatedAt: now,
    })
    .where(eq(schema.tickets.id, id))
    .returning()
    .get()!
  if (t.parentId) touch(t.parentId)
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
  if (opts.keepLanes)
    db.update(schema.tickets).set({ parentId: t.parentId }).where(eq(schema.tickets.parentId, id)).run()
  db.delete(schema.tickets).where(eq(schema.tickets.id, id)).run()
  logActivity({ projectId: t.projectId, actor, kind: 'ticket', text: `deleted ticket #${id} ${t.title}` })
}

// --- tasks ---

export function addTasks(ticketId: number, texts: string[], actor: string, opts: { quiet?: boolean } = {}) {
  const ticket = getTicket(ticketId)
  const last = db
    .select({ position: schema.tasks.position })
    .from(schema.tasks)
    .where(eq(schema.tasks.ticketId, ticketId))
    .orderBy(desc(schema.tasks.position))
    .get()
  let position = (last?.position ?? -1) + 1
  const rows = db
    .insert(schema.tasks)
    .values(texts.map((text) => ({ ticketId, text, position: position++ })))
    .returning()
    .all()
  touch(ticketId)
  if (!opts.quiet)
    logActivity({
      projectId: ticket.projectId,
      actor,
      kind: 'task',
      text: `added ${rows.length} task${rows.length === 1 ? '' : 's'} to #${ticketId} ${ticket.title}`,
      refType: 'ticket',
      refId: ticketId,
    })
  return rows
}

export function updateTask(id: number, patch: { done?: boolean; text?: string }, actor: string) {
  const task = db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()
  if (!task) throw notFound('task')
  const row = db.update(schema.tasks).set(patch).where(eq(schema.tasks.id, id)).returning().get()!
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
  if (patch.text !== undefined && patch.text !== task.text)
    log(`reworded "${task.text}" to "${row.text}" on #${ticket.id} ${ticket.title}`)
  if (patch.done !== undefined && patch.done !== task.done)
    log(`${patch.done ? 'completed' : 'reopened'} "${row.text}" on #${ticket.id} ${ticket.title}`)
  return row
}

export function deleteTask(id: number, actor: string) {
  const task = db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()
  if (!task) throw notFound('task')
  db.delete(schema.tasks).where(eq(schema.tasks.id, id)).run()
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
  input: { name: string; branch?: string; path?: string; agent?: string },
  actor: string,
) {
  const ticket = getTicket(ticketId)
  const row = db
    .insert(schema.workspaces)
    .values({
      ticketId,
      name: input.name,
      branch: input.branch ?? '',
      path: input.path ?? '',
      agent: input.agent ?? actor,
    })
    .returning()
    .get()
  touch(ticketId)
  logActivity({
    projectId: ticket.projectId,
    actor,
    kind: 'workspace',
    text: `opened workspace ${row.name}${row.branch ? ` on ${row.branch}` : ''} for #${ticketId}`,
    refType: 'ticket',
    refId: ticketId,
  })
  return row
}

export function deleteWorkspace(id: number, actor: string) {
  const ws = db.select().from(schema.workspaces).where(eq(schema.workspaces.id, id)).get()
  if (!ws) throw notFound('workspace')
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
 * the base chain (a lane's parent branch, then dev), so it can be deleted.
 */
export async function ticketGit(id: number) {
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
  const none = { exists: false, sha: null, subject: null, authoredAt: null, ahead: null, behind: null }
  const byId = new Map(all.map((t) => [t.id, t]))
  const repoGit = gitCache()
  const [branch, ...wsState] = await Promise.all([
    (async () => {
      if (!repo) return { ...none, reach: null }
      const [info, { refs }] = await Promise.all([
        branchInfo(repo.repoPath, ticket.branch, ticket.baseBranch),
        repoGit(repo.repoPath),
      ])
      const chain = baseChain(ticket, byId, repo)
      return { ...info, reach: await reachOf(repo.repoPath, ticket.branch, chain, refs) }
    })(),
    ...workspaces.map(async ({ w, owner, repo: r }) => {
      if (!r) return { info: { ...none, reach: null }, worktree: null }
      const [info, { refs, worktrees }] = await Promise.all([
        branchInfo(r.repoPath, w.branch, owner.branch || owner.baseBranch),
        repoGit(r.repoPath),
      ])
      const chain = baseChain(owner, byId, r)
      const into = w.branch === owner.branch || !owner.branch ? chain : [owner.branch, ...chain]
      const worktree =
        worktrees.find((t) => (w.path && samePath(t.path, w.path)) || (w.branch && t.branch === w.branch)) ??
        null
      return { info: { ...info, reach: await reachOf(r.repoPath, w.branch, into, refs) }, worktree }
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

// --- updates (the "advances" feed) ---

export function postUpdate(ticketId: number, body: string, attachmentIds: number[], actor: string) {
  const ticket = getTicket(ticketId)
  const row = db.insert(schema.updates).values({ ticketId, author: actor, body }).returning().get()
  attachTo(attachmentIds, { updateId: row.id })
  touch(ticketId)
  logActivity({
    projectId: ticket.projectId,
    actor,
    kind: 'update',
    text: `posted an update on #${ticketId} ${ticket.title}: ${firstLine(body)}`,
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

// --- comments (threads on tickets, updates, PRs, review results) ---

export function listComments(parentType: schema.CommentParent, parentId: number) {
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
 * assigned to or opened by them, their update, their review), where someone else spoke last. Newest
 * first; `waiting` counts the comments since the actor last spoke.
 */
export function listOpenThreads(projectId: number, actor: string) {
  getProject(projectId)
  const tickets = db.select().from(schema.tickets).where(eq(schema.tickets.projectId, projectId)).all()
  const ticketById = new Map(tickets.map((t) => [t.id, t]))
  const updates = tickets.length
    ? db
        .select({
          id: schema.updates.id,
          ticketId: schema.updates.ticketId,
          author: schema.updates.author,
          body: schema.updates.body,
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

  type Subject = { ticketId: number | null; title: string; mine: boolean }
  const subjects = new Map<string, Subject>()
  for (const t of tickets)
    subjects.set(`ticket:${t.id}`, {
      ticketId: t.id,
      title: t.title,
      mine: t.assignee === actor || t.createdBy === actor,
    })
  for (const u of updates)
    subjects.set(`update:${u.id}`, {
      ticketId: u.ticketId,
      title: `update on #${u.ticketId} ${ticketById.get(u.ticketId)?.title ?? ''}: ${gist(u.body, 60)}`,
      mine: u.author === actor,
    })
  for (const p of prs)
    subjects.set(`pr:${p.id}`, {
      ticketId: null,
      title: `PR #${p.number} ${p.title}`,
      mine: p.author === actor,
    })
  for (const r of reviews)
    subjects.set(`review:${r.id}`, {
      ticketId: null,
      title: `review of PR #${r.prNumber} (${r.verdict})`,
      mine: r.author === actor,
    })

  const ids = (type: string) =>
    [...subjects.keys()].filter((k) => k.startsWith(`${type}:`)).map((k) => Number(k.split(':')[1]))
  const comments = (['ticket', 'update', 'pr', 'review'] as const).flatMap((type) => {
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
  const threads = new Map<string, schema.Comment[]>()
  for (const c of comments) {
    const key = `${c.parentType}:${c.parentId}`
    threads.set(key, [...(threads.get(key) ?? []), c])
  }

  const out = []
  for (const [key, list] of threads) {
    const subject = subjects.get(key)!
    const last = list[list.length - 1]!
    const spoke = list.some((c) => c.author === actor)
    if (last.author === actor || !(spoke || subject.mine)) continue
    const lastMine = list.map((c) => c.author).lastIndexOf(actor)
    const c = list[0]!
    out.push({
      parentType: c.parentType,
      parentId: c.parentId,
      ticketId: subject.ticketId,
      title: subject.title,
      waiting: list.length - 1 - lastMine,
      last: { id: last.id, author: last.author, text: gist(last.body), createdAt: last.createdAt },
    })
  }
  return out.sort((a, b) => b.last.createdAt.localeCompare(a.last.createdAt))
}

export function addComment(
  input: {
    parentType: schema.CommentParent
    parentId: number
    replyTo?: number | null
    body: string
    attachmentIds?: number[]
  },
  actor: string,
) {
  const projectId = commentProject(input.parentType, input.parentId)
  const row = db
    .insert(schema.comments)
    .values({
      parentType: input.parentType,
      parentId: input.parentId,
      replyTo: input.replyTo ?? null,
      author: actor,
      body: input.body,
    })
    .returning()
    .get()
  attachTo(input.attachmentIds ?? [], { commentId: row.id })
  logActivity({
    projectId,
    actor,
    kind: 'comment',
    text: `commented on ${input.parentType} #${input.parentId}: ${firstLine(input.body)}`,
    refType: input.parentType,
    refId: input.parentId,
  })
  return row
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
