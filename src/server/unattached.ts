import { and, eq, isNull, notExists, sql } from 'drizzle-orm'
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core'

import { db, schema } from '#/db'
import { HttpError } from './http'
import { fileStore, type FileStore } from './storage'

/**
 * Uploads nothing points at: no post, reply or ticket holds them, no agent has them as its picture
 * and no text links to them (`/api/uploads/<id>`). They come from a New ticket window closed without
 * creating, a file taken off a post before sending, an upload an agent never used. Once a day old
 * (younger ones may be an upload about to be attached) they are deleted: the file first, then the row.
 */

/** How long an unattached upload is left alone. */
export const KEEP_MS = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

const a = schema.attachments

/** Held by no post, reply, ticket or agent picture. */
const loose = () =>
  and(
    isNull(a.updateId),
    isNull(a.commentId),
    isNull(a.ticketId),
    notExists(
      db
        .select({ one: sql`1` })
        .from(schema.agents)
        .where(eq(schema.agents.avatarId, a.id)),
    ),
  )

// Text that may link a file by its URL instead of attaching it: markdown in bodies and instructions.
const TEXTS: [SQLiteTable, SQLiteColumn][] = [
  [schema.projects, schema.projects.instructions],
  [schema.agents, schema.agents.instructions],
  [schema.agents, schema.agents.delegation],
  [schema.tickets, schema.tickets.body],
  [schema.updates, schema.updates.body],
  [schema.comments, schema.comments.body],
  [schema.reviewResults, schema.reviewResults.summaryMd],
  [schema.dailySummaries, schema.dailySummaries.body],
]

/** Every upload some text links to (`/api/uploads/12`, relative or with the board's address). */
function linkedFromText(): Set<number> {
  const ids = new Set<number>()
  for (const [table, column] of TEXTS) {
    const rows = db.all<{ text: string }>(
      sql`select ${column} as text from ${table} where ${column} like '%/api/uploads/%'`,
    )
    for (const { text } of rows)
      for (const m of text.matchAll(/\/api\/uploads\/(\d+)/g)) ids.add(Number(m[1]))
  }
  return ids
}

function unattached() {
  const linked = linkedFromText()
  return db
    .select()
    .from(a)
    .where(loose())
    .all()
    .filter((r) => !linked.has(r.id))
}

const cutoff = (now: number) => new Date(now - KEEP_MS).toISOString()

export interface UnattachedUploads {
  /** Older than a day: what the next run deletes. */
  count: number
  bytes: number
  /** Younger than a day, left alone for now. */
  recent: number
}

export function unattachedUploads(now = Date.now()): UnattachedUploads {
  const rows = unattached()
  const old = rows.filter((r) => r.createdAt < cutoff(now))
  return { count: old.length, bytes: old.reduce((n, r) => n + r.size, 0), recent: rows.length - old.length }
}

/**
 * `pnpm dev` runs on a copy of the database; with STORAGE=s3 it shares the bucket with the live board,
 * where a file its copy thinks unattached may have been attached since. A copy never deletes there.
 */
const sharedBucket = (store: FileStore) => store.kind === 's3' && !!process.env.BOARD_DATA_COPY

export interface SweepResult {
  deleted: number
  bytes: number
  /** Files the store could not delete; their rows stay for the next run. */
  failed: number
}

async function sweep(store: FileStore, now: number): Promise<SweepResult> {
  if (sharedBucket(store))
    throw new HttpError(
      409,
      'this board runs on a copy of the data and shares its bucket: it deletes nothing',
    )
  const result: SweepResult = { deleted: 0, bytes: 0, failed: 0 }
  for (const row of unattached().filter((r) => r.createdAt < cutoff(now))) {
    // Attached since the list was read: it stays.
    if (
      !db
        .select({ id: a.id })
        .from(a)
        .where(and(eq(a.id, row.id), loose()))
        .get()
    )
      continue
    try {
      await store.delete(row.storedAs)
    } catch (err) {
      result.failed++
      console.error(
        `unattached upload ${row.id} (${row.storedAs}) not deleted, kept for the next run:`,
        err instanceof Error ? err.message : err,
      )
      continue
    }
    const gone = db
      .delete(a)
      .where(and(eq(a.id, row.id), loose()))
      .run()
    if (!gone.changes) console.error(`upload ${row.id} was attached while its file was being deleted`)
    result.deleted++
    result.bytes += row.size
  }
  if (result.deleted || result.failed)
    console.log(
      `unattached uploads: deleted ${result.deleted} (${result.bytes} bytes), ${result.failed} failed`,
    )
  return result
}

let running: Promise<SweepResult> | null = null

/** Deletes the unattached uploads older than a day. One run at a time: a second call shares the first. */
export function deleteUnattachedUploads(opts: { store?: FileStore; now?: number } = {}) {
  return (running ??= sweep(opts.store ?? fileStore, opts.now ?? Date.now()).finally(() => {
    running = null
  }))
}

/** The hourly run in the background, first a minute after boot. Returns what stops it. */
export function startUploadSweep(store = fileStore) {
  if (sharedBucket(store)) return () => {}
  const run = () =>
    void deleteUnattachedUploads({ store }).catch((err) =>
      console.error('unattached uploads:', err instanceof Error ? err.message : err),
    )
  let every: NodeJS.Timeout | undefined
  const first = setTimeout(() => {
    run()
    every = setInterval(run, HOUR)
    every.unref()
  }, 60 * 1000)
  first.unref()
  return () => {
    clearTimeout(first)
    clearInterval(every)
  }
}
