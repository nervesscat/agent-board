import { and, eq, sql } from 'drizzle-orm'

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

/*
 * What can hold an upload is read from the database itself rather than listed here, so a table or
 * column added later (a report's files, say) can never leave its files looking unattached:
 * - an owner column on the upload's own row: every `*_id` column of attachments (post, reply,
 *   ticket, …);
 * - a foreign key from another table to attachments (an agent's picture, …);
 * - a link in any text column of any table (`/api/uploads/12`: markdown that links a file by URL).
 */
const quote = (name: string) => `"${name.replace(/"/g, '""')}"`

function tables(): string[] {
  return db
    .all<{
      name: string
    }>(
      sql`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '__drizzle%'`,
    )
    .map((r) => r.name)
}

/** What the schema says can hold an upload: the SQL of the two checks below. */
interface Holders {
  /** Held by nothing: no owner column set on its row, and no row elsewhere pointing at it. */
  loose: string
  /** Each text column's values that link an upload, in statements of at most `PER_SCAN` columns. */
  scans: string[]
}

/** Columns per statement of the text scan: SQLite allows 500 terms in a compound select. */
const PER_SCAN = 400

function readHolders(): Holders {
  const all = tables()
  const owners = db
    .all<{ name: string }>(sql`select name from pragma_table_info('attachments')`)
    .map((c) => c.name)
    .filter((c) => c.endsWith('_id'))
  const refs = all.flatMap((t) =>
    db
      .all<{ table: string; from: string }>(sql`select "table", "from" from pragma_foreign_key_list(${t})`)
      .filter((k) => k.table === 'attachments')
      .map((k) => [t, k.from] as const),
  )
  const held = [
    ...owners.map((c) => `"attachments".${quote(c)} is null`),
    ...refs.map(
      ([t, c]) => `not exists (select 1 from ${quote(t)} where ${quote(t)}.${quote(c)} = "attachments"."id")`,
    ),
  ]
  const columns = all.flatMap((t) =>
    db
      .all<{ name: string; type: string }>(sql`select name, type from pragma_table_info(${t})`)
      .filter((c) => /text|char|clob/i.test(c.type))
      .map(
        ({ name }) =>
          `select ${quote(name)} as text from ${quote(t)} where ${quote(name)} like '%/api/uploads/%'`,
      ),
  )
  const scans: string[] = []
  for (let i = 0; i < columns.length; i += PER_SCAN)
    scans.push(columns.slice(i, i + PER_SCAN).join(' union all '))
  return { loose: held.join(' and ') || '1', scans }
}

/**
 * The holders as the schema is now: read again only once a table or column was added, changed or
 * dropped (SQLite counts those in the schema version), so one added at runtime counts on the next call.
 */
let kept: { version: number; holders: Holders } | null = null

function holders(): Holders {
  const version = db.get<{ schema_version: number }>(sql`pragma schema_version`)!.schema_version
  if (kept?.version !== version) kept = { version, holders: readHolders() }
  return kept.holders
}

/** Held by nothing: no owner column set on its row, and no row elsewhere pointing at it. */
const loose = (h = holders()) => sql.raw(h.loose)

/** Every upload some text links to (`/api/uploads/12`, relative or with the board's address). */
function linkedFromText(h: Holders): Set<number> {
  const ids = new Set<number>()
  for (const scan of h.scans)
    for (const { text } of db.all<{ text: string }>(sql.raw(scan)))
      for (const m of String(text).matchAll(/\/api\/uploads\/(\d+)/g)) ids.add(Number(m[1]))
  return ids
}

function unattached() {
  const h = holders()
  const linked = linkedFromText(h)
  return db
    .select()
    .from(a)
    .where(loose(h))
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
