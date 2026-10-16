import { type SQL, and, asc, desc, eq, gt, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import { z } from 'zod'

import { db, schema } from '#/db'
import { postAnchor, replyAnchor } from '#/lib/anchors'
import {
  DOCUMENT_EXTENSIONS,
  DOCUMENT_MIMES,
  FILE_KINDS,
  type FileKind,
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
 * their instructions, lanes' included (each under its own lane), newest first. Report files, agents'
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
  sort: z.enum(['newest', 'oldest']).optional().describe('newest first by default'),
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

/** Where a page ended: the last file's time and id, opaque to the caller. */
const encodeCursor = (createdAt: string, id: number) =>
  Buffer.from(JSON.stringify([createdAt, id])).toString('base64url')

function decodeCursor(cursor: string): { createdAt: string; id: number } {
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown[]
    if (typeof createdAt === 'string' && Number.isInteger(id)) return { createdAt, id: id as number }
  } catch {
    // falls through to the refusal
  }
  throw new HttpError(400, 'cursor: not one this list handed out')
}

export function listGallery(projectId: number, q: GalleryQuery = {}) {
  getProject(projectId)
  const limit = q.limit ?? GALLERY_PAGE
  const oldest = q.sort === 'oldest'
  const where = [eq(t.projectId, projectId)]
  if (q.archived !== 'include') where.push(isNull(t.archivedAt))
  if (q.from) where.push(gte(a.createdAt, dayBounds(q.from).from))
  if (q.to) where.push(lt(a.createdAt, dayBounds(q.to).to))
  if (q.type?.length) where.push(inArray(kindSql, q.type))
  if (q.cursor) {
    // Keyset: the files after the last one handed out, so files that arrive meanwhile move nothing.
    const c = decodeCursor(q.cursor)
    const after = oldest ? gt : lt
    where.push(or(after(a.createdAt, c.createdAt), and(eq(a.createdAt, c.createdAt), after(a.id, c.id)))!)
  }
  const order = oldest ? asc : desc
  const rows = db
    .select({
      file: a,
      kind: kindSql,
      postId: sql<number | null>`coalesce(${a.updateId}, ${reply.parentId})`,
      ticket: { id: t.id, title: t.title, parentId: t.parentId },
    })
    .from(a)
    .leftJoin(post, eq(post.id, a.updateId))
    // A reply counts only under a ticket's post: replies on a PR or a review result name no ticket.
    .leftJoin(reply, and(eq(reply.id, a.commentId), eq(reply.parentType, 'update')))
    .leftJoin(replyPost, eq(replyPost.id, reply.parentId))
    .innerJoin(t, eq(t.id, sql`coalesce(${post.ticketId}, ${replyPost.ticketId}, ${a.ticketId})`))
    .where(and(...where))
    .orderBy(order(a.createdAt), order(a.id))
    .limit(limit + 1)
    .all()
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    items: page.map(({ file, kind, postId, ticket }) => {
      const source = file.commentId
        ? { kind: 'reply' as const, postId: postId!, commentId: file.commentId }
        : file.updateId
          ? { kind: 'post' as const, postId: file.updateId }
          : { kind: 'instructions' as const }
      return {
        ...attachmentView(file),
        kind,
        ticket,
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
    next: rows.length > limit && last ? encodeCursor(last.file.createdAt, last.file.id) : null,
  }
}

export type Gallery = ReturnType<typeof listGallery>
export type GalleryFile = Gallery['items'][number]
