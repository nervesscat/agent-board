import { and, asc, desc, eq, inArray } from 'drizzle-orm'

import { db, schema } from '#/db'
import { logActivity } from './activity'
import { branchInfo, listWorktrees } from './git'
import { HttpError, notFound } from './http'
import { getProject } from './projects'
import { attachTo, attachmentUrl } from './uploads'

type TicketStatus = schema.TicketStatus

// --- tickets ---

export function listTickets(projectId: number) {
  getProject(projectId)
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
  return rows.map((t) => {
    const mine = allTasks.filter((x) => x.ticketId === t.id)
    return { ...t, progress: { done: mine.filter((x) => x.done).length, total: mine.length } }
  })
}

export function getTicket(id: number) {
  const t = db.select().from(schema.tickets).where(eq(schema.tickets.id, id)).get()
  if (!t) throw notFound('ticket')
  return t
}

/** The whole ticket page in one read: tasks, workspaces, updates with their attachments. */
export function getTicketFull(id: number) {
  const ticket = getTicket(id)
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
    .where(eq(schema.updates.ticketId, id))
    .orderBy(desc(schema.updates.createdAt))
    .all()
  const updateIds = updates.map((u) => u.id)
  const files = updateIds.length
    ? db.select().from(schema.attachments).where(inArray(schema.attachments.updateId, updateIds)).all()
    : []
  return {
    ...ticket,
    tasks,
    workspaces,
    progress: { done: tasks.filter((t) => t.done).length, total: tasks.length },
    updates: updates.map((u) => ({
      ...u,
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
    tasks?: string[]
  },
  actor: string,
) {
  const project = getProject(projectId)
  const row = db
    .insert(schema.tickets)
    .values({
      projectId,
      title: input.title,
      body: input.body ?? '',
      status: input.status ?? 'todo',
      assignee: input.assignee ?? '',
      branch: input.branch ?? '',
      baseBranch: input.baseBranch || project.baseBranch,
      createdBy: actor,
    })
    .returning()
    .get()
  if (input.tasks?.length) addTasks(row.id, input.tasks, actor, { quiet: true })
  logActivity({
    projectId,
    actor,
    kind: 'ticket',
    text: `created ticket #${row.id} ${row.title}`,
    refType: 'ticket',
    refId: row.id,
  })
  return row
}

const touch = (ticketId: number) =>
  db
    .update(schema.tickets)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(schema.tickets.id, ticketId))
    .run()

export function updateTicket(
  id: number,
  patch: Partial<Pick<schema.Ticket, 'title' | 'body' | 'status' | 'assignee' | 'branch' | 'baseBranch'>>,
  actor: string,
) {
  const before = getTicket(id)
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

export function deleteTicket(id: number, actor: string) {
  const t = getTicket(id)
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

/** Live, read-only git state for the ticket's branch and each workspace. */
export async function ticketGit(id: number) {
  const ticket = getTicket(id)
  const project = getProject(ticket.projectId)
  const workspaces = db.select().from(schema.workspaces).where(eq(schema.workspaces.ticketId, id)).all()
  const [branch, worktrees, ...wsBranches] = await Promise.all([
    branchInfo(project.repoPath, ticket.branch, ticket.baseBranch),
    listWorktrees(project.repoPath).catch(() => []),
    ...workspaces.map((w) => branchInfo(project.repoPath, w.branch, ticket.branch || ticket.baseBranch)),
  ])
  return {
    branch: ticket.branch,
    baseBranch: ticket.baseBranch,
    info: branch,
    workspaces: workspaces.map((w, i) => ({
      ...w,
      info: wsBranches[i],
      worktree:
        worktrees.find((t) => (w.path && samePath(t.path, w.path)) || (w.branch && t.branch === w.branch)) ??
        null,
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
