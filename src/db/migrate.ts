import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'

interface Journal {
  entries: { tag: string; when: number }[]
}

/** A migration applied by applyMigrations: its journal tag and its `when`. */
export interface AppliedMigration {
  tag: string
  when: number
}

/**
 * Applies the migrations in `migrationsFolder` (drizzle's layout: meta/_journal.json and one .sql file per
 * entry) that `sqlite` does not have yet, and returns them in the order they were applied.
 *
 * Drizzle's own migrate() applies only the entries whose `when` is newer than the newest one recorded, so an
 * entry merged with an older `when` is skipped without a sign. This applies every journal entry whose `when`
 * is not recorded in __drizzle_migrations, in journal order, one transaction per migration. It writes the
 * same table and columns drizzle does (`created_at` is the entry's `when`), so a database drizzle migrated
 * is read as it is.
 */
export function applyMigrations(sqlite: Database.Database, migrationsFolder: string): AppliedMigration[] {
  sqlite.exec(
    'CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
  )
  const recorded = sqlite.prepare('SELECT created_at FROM "__drizzle_migrations"').all() as {
    created_at: number | null
  }[]
  const applied = new Set(recorded.map((row) => Number(row.created_at)))
  const record = sqlite.prepare('INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)')

  const journal = JSON.parse(
    fs.readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as Journal

  const applying: AppliedMigration[] = []
  for (const { tag, when } of journal.entries) {
    if (applied.has(when)) continue
    const file = fs.readFileSync(path.join(migrationsFolder, `${tag}.sql`))
    const hash = crypto.createHash('sha256').update(file).digest('hex')
    // The same split drizzle makes; each piece is one statement.
    const statements = file.toString().split('--> statement-breakpoint')
    sqlite.transaction(() => {
      for (const statement of statements) if (statement.trim()) sqlite.prepare(statement).run()
      record.run(hash, when)
    })()
    applied.add(when)
    applying.push({ tag, when })
  }
  return applying
}

/** The settings key of the alerts' record of the migrations the human has been told about. */
export const MIGRATIONS_SEEN = 'alertMigrationsSeen'

/**
 * Rewrites the migration marker from the old shape `{ at }` (only the newest applied time) to `{ at, announced }`,
 * where `announced` lists the migrations applied at or before `at`, the ones the old build had already told the
 * human about. Migrations newer than `at` are left out, so they stay unannounced and their alert stays until the
 * human answers it. Run before applyMigrations, so a migration the boot applies afterwards is not in `announced`
 * either, and stays unannounced across restarts. A database with no settings table yet (a fresh one), no marker,
 * or a marker whose value is not JSON is left as it is.
 */
export function upgradeLegacyMarker(sqlite: Database.Database): void {
  const tables = new Set(
    (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (t) => t.name,
    ),
  )
  if (!tables.has('settings') || !tables.has('__drizzle_migrations')) return
  const row = sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(MIGRATIONS_SEEN) as
    | { value: string }
    | undefined
  if (!row) return
  let value: { at?: unknown; announced?: unknown } | null
  try {
    value = JSON.parse(row.value) as { at?: unknown; announced?: unknown } | null
  } catch {
    // Edited outside the app: left as it is, and the alert check reads it as it did before.
    return
  }
  if (typeof value?.at !== 'number' || Array.isArray(value.announced)) return
  const at = value.at
  const announced = (
    sqlite.prepare('SELECT created_at FROM "__drizzle_migrations"').all() as { created_at: number | null }[]
  )
    .map((r) => Number(r.created_at))
    .filter((when) => when <= at)
  sqlite
    .prepare('UPDATE settings SET value = ? WHERE key = ?')
    .run(JSON.stringify({ at, announced }), MIGRATIONS_SEEN)
}
