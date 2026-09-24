import { and, asc, desc, eq, inArray } from 'drizzle-orm'

import { db, schema } from '#/db'
import { logActivity } from './activity'
import { branchInfo, listWorktrees } from './git'
import { HttpError, notFound } from './http'
import { getProject } from './projects'
import { resolveRepo, ticketRepo } from './repos'
import { attachTo, attachmentUrl } from './uploads'

type TicketStatus = schema.TicketStatus

// --- tickets ---

type Progress = { done: number; total: number }
export type LaneCounts = { total: number; approved: number } & Partial<Record<TicketStatus, number>>

/**
 * Every ticket of a project with its own task progress, the progress rolled up over its lanes (and
 * theirs), and how many lanes it has in each status. One pass over the project keeps this cheap.
 */
function projectTickets(projectId: number) {
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
  const rollup = (id: number): Progress =>
    (children.get(id) ?? []).reduce(
      (acc, lane) => {
        const p = rollup(lane.id)
        return { done: acc.done + p.done, total: acc.total + p.total }
      },
      { ...own.get(id)! },
    )
  return rows.map((t) => {
    const lanes: LaneCounts = { total: 0, approved: 0 }
    for (const lane of children.get(t.id) ?? []) {
      lanes.total++
      if (lane.approvedAt) lanes.approved++
      lanes[lane.status] = (lanes[lane.status] ?? 0) + 1
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

/** A project's tickets; `parentId` narrows to the lanes of one ticket, `null` to the top level. */
export function listTickets(projectId: number, filter: { parentId?: number | null } = {}) {
  getProject(projectId)
  const rows = projectTickets(projectId)
  return filter.parentId === undefined ? rows : rows.filter((t) => t.parentId === filter.parentId)
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
  return {
    ...ticket,
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
      attachments: files.filter((f) => f.updateId === u.id).map((f) => ({ ...f, url: attachmentUrl(f) })),
    })),
  }
}

export type TicketFull = ReturnType<typeof getTicketFull>

export function createTicket(
  projectId: number,
  input: {
    title: string
    body?: string
    status?: TicketStatus
    assignee?: string
    branch?: string
    baseBranch?: string
    repoId?: number | null
    parentId?: number | null
    tasks?: string[]
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
  const row = db
    .insert(schema.tickets)
    .values({
      projectId,
      repoId: repo.id,
      parentId: parent?.id ?? null,
      title: input.title,
      body: input.body ?? '',
      status: input.status ?? 'todo',
      assignee: input.assignee ?? '',
      branch: input.branch ?? '',
      baseBranch: input.baseBranch || parentBase || repo.baseBranch,
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

export function updateTicket(
  id: number,
  patch: Partial<
    Pick<schema.Ticket, 'title' | 'body' | 'status' | 'assignee' | 'branch' | 'baseBranch' | 'repoId'>
  >,
  actor: string,
) {
  const before = getTicket(id)
  if (patch.repoId) resolveRepo(before.projectId, patch.repoId)
  const row = db
    .update(schema.tickets)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(schema.tickets.id, id))
    .returning()
    .get()!
  const changes: string[] = []
  if (patch.status && patch.status !== before.status)
    changes.push(`status ${before.status} → ${patch.status}`)
  if (patch.assignee !== undefined && patch.assignee !== before.assignee)
    changes.push(`assignee → ${patch.assignee || 'nobody'}`)
  if (patch.branch !== undefined && patch.branch !== before.branch)
    changes.push(`branch → ${patch.branch || 'none'}`)
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

/** The human's sign-off on a ticket or lane. Callers make sure the actor is the human. */
export function setApproval(id: number, approved: boolean, actor: string) {
  const t = getTicket(id)
  if (Boolean(t.approvedAt) === approved) return t
  const row = db
    .update(schema.tickets)
    .set(
      approved
        ? { approvedAt: new Date().toISOString(), approvedBy: actor }
        : { approvedAt: null, approvedBy: '' },
    )
    .where(eq(schema.tickets.id, id))
    .returning()
    .get()!
  logActivity({
    projectId: t.projectId,
    actor,
    kind: 'ticket',
    text: `${approved ? 'approved' : 'withdrew approval of'} ${t.parentId ? 'lane' : 'ticket'} #${id} ${t.title}`,
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
  if (patch.done !== undefined && patch.done !== task.done)
    logActivity({
      projectId: ticket.projectId,
      actor,
      kind: 'task',
      text: `${patch.done ? 'completed' : 'reopened'} "${row.text}" on #${ticket.id} ${ticket.title}`,
      refType: 'ticket',
      refId: ticket.id,
    })
  return row
}

export function deleteTask(id: number) {
  const task = db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()
  if (!task) throw notFound('task')
  db.delete(schema.tasks).where(eq(schema.tasks.id, id)).run()
  touch(task.ticketId)
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
 * ticket it belongs to, in that ticket's repo.
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
  const worktreesOf = new Map<string, ReturnType<typeof listWorktrees>>()
  const worktrees = (repoPath: string) => {
    if (!worktreesOf.has(repoPath))
      worktreesOf.set(
        repoPath,
        listWorktrees(repoPath).catch(() => []),
      )
    return worktreesOf.get(repoPath)!
  }
  const [branch, ...wsState] = await Promise.all([
    repo ? branchInfo(repo.repoPath, ticket.branch, ticket.baseBranch) : none,
    ...workspaces.map(async ({ w, owner, repo: r }) => {
      if (!r) return { info: none, worktree: null }
      const [info, trees] = await Promise.all([
        branchInfo(r.repoPath, w.branch, owner.branch || owner.baseBranch),
        worktrees(r.repoPath),
      ])
      const worktree =
        trees.find((t) => (w.path && samePath(t.path, w.path)) || (w.branch && t.branch === w.branch)) ?? null
      return { info, worktree }
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
    attachments: files.filter((f) => f.commentId === c.id).map((f) => ({ ...f, url: attachmentUrl(f) })),
  }))
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
