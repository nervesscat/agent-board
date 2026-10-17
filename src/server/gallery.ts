import { type SQL, and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import { z } from 'zod'

import { db, schema } from '#/db'
import { postAnchor, replyAnchor } from '#/lib/anchors'
import {
  DOCUMENT_EXTENSIONS,
  DOCUMENT_MIMES,
  FILE_KINDS,
  type FileKind,
  GALLERY_SORTS,
  type GallerySort,
  TEXT_EXTENSIONS,
  TEXT_MIMES,
} from '#/lib/fileKinds'
import { isDay } from '#/lib/reports'
import { dayBounds } from './activity'
import { HttpError } from './http'
import { getProject } from './projects'
import { attachmentView } from './uploads'

/**
 * A project's gallery: every file on its tickets' posts, on the replies under those posts and with
 * their instructions, newest first unless asked otherwise. A lane's files are listed under its top-level ticket, with the lane
 * that holds them as `lane`. Report files, agents'
 * pictures, replies on PRs and review results, and uploads nothing holds are not on a ticket, so they
 * are not here. It only reads: browsing it holds no upload (src/server/unattached.ts).
 */

export const GALLERY_PAGE = 60
export const GALLERY_MAX_PAGE = 200

const Day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
  .refine(isDay, 'not a day')

/** The filters, as MCP's list_gallery takes them; REST's query parameters are the same. */
export const galleryShape = {
  type: z
    .array(z.enum(FILE_KINDS))
    .optional()
    .describe(
      'only files of these kinds: image, video, pdf, docs (documents and text), other; all by default',
    ),
  from: Day.optional().describe('uploaded on or after this local day, YYYY-MM-DD'),
  to: Day.optional().describe('uploaded on or before this local day, YYYY-MM-DD'),
  sort: z
    .enum(GALLERY_SORTS)
    .optional()
    .describe(
      'newest (the default) or oldest first by upload time; name or name-desc, A to Z or Z to A ignoring case; largest or smallest first by size; type: by kind (image, video, pdf, docs, other), then name. Ties go by id',
    ),
  archived: z
    .enum(['hide', 'include'])
    .optional()
    .describe('include: also the files of archived tickets, which are left out by default'),
  cursor: z.string().optional().describe('the next of the previous page, for the page after it'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(GALLERY_MAX_PAGE)
    .optional()
    .describe(`files per page, ${GALLERY_PAGE} by default, ${GALLERY_MAX_PAGE} at most`),
}
export const GalleryQuery = z.object(galleryShape)
export type GalleryQuery = z.infer<typeof GalleryQuery>

const a = schema.attachments
const t = schema.tickets
const post = schema.updates
const reply = alias(schema.comments, 'reply')
const replyPost = alias(schema.updates, 'reply_post')

// The kind of a file, in SQL, by the rules of fileKind (src/lib/fileKinds.ts): GLOB is case-sensitive
// like startsWith, and the name is lowercased like the extension there.
const mimeStarts = (prefixes: string[]) => prefixes.map((p) => sql`${a.mime} GLOB ${`${p}*`}`)
const nameEnds = (extensions: string[]) => extensions.map((e) => sql`lower(${a.name}) GLOB ${`*.${e}`}`)
export const kindSql: SQL<FileKind> = sql<FileKind>`CASE
  WHEN ${a.mime} GLOB 'image/*' THEN 'image'
  WHEN ${a.mime} GLOB 'video/*' THEN 'video'
  WHEN ${a.mime} = 'application/pdf' THEN 'pdf'
  WHEN ${or(
    ...mimeStarts(TEXT_MIMES),
    ...nameEnds(TEXT_EXTENSIONS),
    ...mimeStarts(DOCUMENT_MIMES),
    ...nameEnds(DOCUMENT_EXTENSIONS),
  )} THEN 'docs'
  ELSE 'other' END`

const nameSql = sql<string>`lower(${a.name})`
const kindRankSql = sql<number>`CASE ${kindSql} ${sql.join(
  FILE_KINDS.map((k, i) => sql`WHEN ${k} THEN ${i}`),
  sql` `,
)} END`

/**
 * What each order sorts by, all in one direction, before the id that breaks ties: the keyset compares
 * the row (keys, id) with the last one handed out.
 */
const ORDERS: Record<GallerySort, { keys: SQL[]; descending: boolean }> = {
  newest: { keys: [sql`${a.createdAt}`], descending: true },
  oldest: { keys: [sql`${a.createdAt}`], descending: false },
  name: { keys: [nameSql], descending: false },
  'name-desc': { keys: [nameSql], descending: true },
  largest: { keys: [sql`${a.size}`], descending: true },
  smallest: { keys: [sql`${a.size}`], descending: false },
  type: { keys: [kindRankSql, nameSql], descending: false },
}

type Key = string | number

/** Where a page ended: its order, the last file's sort keys (as SQL gave them) and id, opaque to the caller. */
const encodeCursor = (sort: GallerySort, keys: Key[], id: number) =>
  Buffer.from(JSON.stringify([sort, ...keys, id])).toString('base64url')

function decodeCursor(cursor: string, sort: GallerySort): { keys: Key[]; id: number } {
  let parts: unknown
  try {
    parts = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    // falls through to the refusal
  }
  if (Array.isArray(parts)) {
    const [from, ...rest] = parts as unknown[]
    // A cursor of another order points into a different sequence: paging on with it would skip or repeat.
    if (from !== sort && GALLERY_SORTS.includes(from as GallerySort))
      throw new HttpError(400, `cursor: handed out for sort ${String(from)}, not ${sort}`)
    const id = rest.pop()
    const keys = rest.filter((k): k is Key => typeof k === 'string' || Number.isFinite(k))
    if (
      from === sort &&
      Number.isInteger(id) &&
      keys.length === ORDERS[sort].keys.length &&
      keys.length === rest.length
    )
      return { keys, id: id as number }
  }
  throw new HttpError(400, 'cursor: not one this list handed out')
}

export function listGallery(projectId: number, q: GalleryQuery = {}) {
  getProject(projectId)
  const limit = q.limit ?? GALLERY_PAGE
  const sort = q.sort ?? 'newest'
  const { keys, descending } = ORDERS[sort]
  const where = [eq(t.projectId, projectId)]
  if (q.archived !== 'include') where.push(isNull(t.archivedAt))
  if (q.from) where.push(gte(a.createdAt, dayBounds(q.from).from))
  if (q.to) where.push(lt(a.createdAt, dayBounds(q.to).to))
  if (q.type?.length) where.push(inArray(kindSql, q.type))
  if (q.cursor) {
    // Keyset: the files after the last one handed out, so files that arrive meanwhile move nothing.
    const c = decodeCursor(q.cursor, sort)
    where.push(
      sql`(${sql.join([...keys, sql`${a.id}`], sql`, `)}) ${descending ? sql`<` : sql`>`} (${sql.join(
        [...c.keys, c.id].map((v) => sql`${v}`),
        sql`, `,
      )})`,
    )
  }
  const order = descending ? desc : asc
  const rows = db
    .select({
      file: a,
      kind: kindSql,
      // The sort keys as SQL computed them, for the cursor: lower() is SQLite's, not JavaScript's.
      sortKeys: sql<string>`json_array(${sql.join(keys, sql`, `)})`,
      postId: sql<number | null>`coalesce(${a.updateId}, ${reply.parentId})`,
      owner: { id: t.id, title: t.title, parentId: t.parentId },
    })
    .from(a)
    .leftJoin(post, eq(post.id, a.updateId))
    // A reply counts only under a ticket's post: replies on a PR or a review result name no ticket.
    .leftJoin(reply, and(eq(reply.id, a.commentId), eq(reply.parentType, 'update')))
    .leftJoin(replyPost, eq(replyPost.id, reply.parentId))
    .innerJoin(t, eq(t.id, sql`coalesce(${post.ticketId}, ${replyPost.ticketId}, ${a.ticketId})`))
    .where(and(...where))
    .orderBy(...keys.map((k) => order(k)), order(a.id))
    .limit(limit + 1)
    .all()
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  const topOf = topLevelTickets(
    projectId,
    page.some((r) => r.owner.parentId !== null),
  )
  return {
    items: page.map(({ file, kind, postId, owner }) => {
      const source = file.commentId
        ? { kind: 'reply' as const, postId: postId!, commentId: file.commentId }
        : file.updateId
          ? { kind: 'post' as const, postId: file.updateId }
          : { kind: 'instructions' as const }
      return {
        ...attachmentView(file),
        kind,
        // A lane's file is under its top-level ticket; the lane is where on it the file is.
        ticket: owner.parentId === null ? { id: owner.id, title: owner.title } : topOf(owner),
        lane: owner.parentId === null ? null : { id: owner.id, title: owner.title },
        source,
        // Where the ticket's page lands on the file's post or reply (src/lib/reveal.ts); none for instructions.
        anchor:
          source.kind === 'reply'
            ? replyAnchor(postAnchor(source.postId), source.commentId)
            : source.kind === 'post'
              ? postAnchor(source.postId)
              : null,
      }
    }),
    next:
      rows.length > limit && last
        ? encodeCursor(sort, JSON.parse(last.sortKeys) as Key[], last.file.id)
        : null,
  }
}

/**
 * The top-level ticket over a lane, however deep it is nested. Read only when the page has a lane's
 * file. The archived filter reads the lane's own mark, which is its top-level ticket's: a lane is
 * archived and restored along with it.
 */
function topLevelTickets(projectId: number, needed: boolean) {
  const byId = new Map(
    needed
      ? db
          .select({ id: t.id, title: t.title, parentId: t.parentId })
          .from(t)
          .where(eq(t.projectId, projectId))
          .all()
          .map((row) => [row.id, row])
      : [],
  )
  return (lane: { id: number; title: string; parentId: number | null }) => {
    let top = lane
    const seen = new Set<number>()
    while (top.parentId !== null && !seen.has(top.id)) {
      seen.add(top.id)
      const up = byId.get(top.parentId)
      if (!up) break
      top = up
    }
    return { id: top.id, title: top.title }
  }
}

export type Gallery = ReturnType<typeof listGallery>
export type GalleryFile = Gallery['items'][number]
