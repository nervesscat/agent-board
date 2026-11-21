import { and, asc, eq, inArray, isNull } from 'drizzle-orm'

import { db, schema } from '#/db'

import { listActors } from './actors'
import { attachmentView } from './uploads'
import { gist } from './features'
import { getProject } from './projects'
import { kindOf, listStages } from './stages'

/**
 * The human's comments in a project that no agent has addressed yet ("latest actions"): the to-do list
 * of an orchestrator starting a session or finishing a step. Computed from what is stored, so it has no
 * cursor and nothing to mark: the same call gives the same answer until someone replies.
 *
 * What counts as a comment: a post by the human on a ticket's feed, and a reply by the human under a
 * post. Addressed means an agent spoke after it in the same thread: a reply under the post, or for a
 * top-level post a later discussion post by an agent on that ticket (progress posts and summary
 * versions are reports, not answers). The human's own later words never address anything, and a
 * decision card's answer is not a comment (it resumes the work by itself).
 *
 * Tickets: every ticket of the project but the archived ones and those in a cancelled stage (their work
 * is dropped); a done ticket's comment still counts, since a word after a merge may be a bug report.
 * `stage` says where the ticket is so the caller can judge. Oldest first: the one waiting longest is
 * the one to answer first.
 */
export function unansweredHumanComments(
  projectId: number,
  opts: { humans?: string[]; now?: Date } = {},
): { count: number; comments: UnansweredComment[] } {
  getProject(projectId)
  const humans = new Set(opts.humans ?? listActors().flatMap((a) => (a.kind === 'human' ? [a.name] : [])))
  const isHuman = (name: string) => humans.has(name)
  const now = opts.now ?? new Date()

  const stages = listStages(projectId)
  const tickets = db
    .select()
    .from(schema.tickets)
    .where(and(eq(schema.tickets.projectId, projectId), isNull(schema.tickets.archivedAt)))
    .all()
    .filter((t) => kindOf(stages, t.status) !== 'cancelled')
  const ticketById = new Map(tickets.map((t) => [t.id, t]))
  // A lane of an archived or cancelled ticket is out with it.
  const allTickets = new Map(
    db
      .select()
      .from(schema.tickets)
      .where(eq(schema.tickets.projectId, projectId))
      .all()
      .map((t) => [t.id, t]),
  )
  const out = (t: schema.Ticket | undefined): boolean =>
    !t || !ticketById.has(t.id) || (t.parentId !== null && out(allTickets.get(t.parentId)))
  const live = tickets.filter((t) => !out(t))
  if (!live.length) return { count: 0, comments: [] as UnansweredComment[] }

  const posts = db
    .select()
    .from(schema.updates)
    .where(
      inArray(
        schema.updates.ticketId,
        live.map((t) => t.id),
      ),
    )
    .orderBy(asc(schema.updates.createdAt), asc(schema.updates.id))
    .all()
  const postIds = posts.map((p) => p.id)
  const replies = postIds.length
    ? db
        .select()
        .from(schema.comments)
        .where(and(eq(schema.comments.parentType, 'update'), inArray(schema.comments.parentId, postIds)))
        .orderBy(asc(schema.comments.createdAt), asc(schema.comments.id))
        .all()
    : []

  const later = (a: { createdAt: string; id: number }, b: { createdAt: string; id: number }) =>
    a.createdAt === b.createdAt ? a.id > b.id : a.createdAt > b.createdAt

  type Found = {
    ticketId: number
    parentType: 'ticket' | 'update'
    parentId: number
    kind: 'post' | 'reply'
    id: number
    author: string
    body: string
    createdAt: string
    postId: number | null
    replyTo: number | null
  }
  const found: Found[] = []

  // A ticket's feed: a human post waits until an agent writes a discussion post after it, or replies under it.
  const repliesOf = new Map<number, typeof replies>()
  for (const r of replies) repliesOf.set(r.parentId, [...(repliesOf.get(r.parentId) ?? []), r])
  for (const t of live) {
    const feed = posts.filter((p) => p.ticketId === t.id)
    for (const p of feed) {
      if (!isHuman(p.author)) continue
      const answered =
        feed.some((q) => !isHuman(q.author) && !q.progress && !q.summary && later(q, p)) ||
        (repliesOf.get(p.id) ?? []).some((r) => !isHuman(r.author))
      if (!answered)
        found.push({
          ticketId: t.id,
          parentType: 'ticket',
          parentId: t.id,
          kind: 'post',
          id: p.id,
          author: p.author,
          body: p.body,
          createdAt: p.createdAt,
          postId: p.id,
          replyTo: null,
        })
    }
  }
  // A post's replies: a human reply waits until an agent replies after it under the same post.
  for (const p of posts) {
    const list = repliesOf.get(p.id) ?? []
    for (const r of list) {
      if (!isHuman(r.author)) continue
      if (list.some((q) => !isHuman(q.author) && later(q, r))) continue
      found.push({
        ticketId: p.ticketId,
        parentType: 'update',
        parentId: p.id,
        kind: 'reply',
        id: r.id,
        author: r.author,
        body: r.body,
        createdAt: r.createdAt,
        postId: p.id,
        replyTo: r.replyTo,
      })
    }
  }

  const postFiles = found.filter((f) => f.kind === 'post').map((f) => f.id)
  const replyFiles = found.filter((f) => f.kind === 'reply').map((f) => f.id)
  const files = [
    ...(postFiles.length
      ? db.select().from(schema.attachments).where(inArray(schema.attachments.updateId, postFiles)).all()
      : []),
    ...(replyFiles.length
      ? db.select().from(schema.attachments).where(inArray(schema.attachments.commentId, replyFiles)).all()
      : []),
  ]

  const comments = found
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id)
    .map((f) => {
      const t = ticketById.get(f.ticketId)!
      return {
        ticketId: t.id,
        title: t.title,
        stage: t.status,
        assignee: t.assignee,
        // How to read and answer it: list_comments / comment with these. A reply goes under its post
        // (parentType update, the post's id); a top-level post is answered by replying under it too.
        parentType: f.parentType,
        parentId: f.parentId,
        kind: f.kind,
        id: f.id,
        postId: f.postId,
        replyTo: f.replyTo,
        author: f.author,
        text: gist(f.body, 200),
        attachments: files
          .filter((a) => (f.kind === 'post' ? a.updateId === f.id : a.commentId === f.id))
          .map((a) => attachmentView(a)),
        createdAt: f.createdAt,
        waitingMinutes: Math.max(0, Math.floor((now.getTime() - Date.parse(f.createdAt)) / 60_000)),
      }
    })
  return { count: comments.length, comments }
}

export type UnansweredComment = {
  ticketId: number
  title: string
  stage: string
  assignee: string
  parentType: 'ticket' | 'update'
  parentId: number
  kind: 'post' | 'reply'
  id: number
  postId: number | null
  replyTo: number | null
  author: string
  text: string
  attachments: ReturnType<typeof attachmentView>[]
  createdAt: string
  waitingMinutes: number
}
