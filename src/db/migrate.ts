import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'

interface Journal {
  entries: { tag: string; when: number }[]
}

/**
 * Applies the migrations in `migrationsFolder` (drizzle's layout: meta/_journal.json and one .sql file per
 * entry) that `sqlite` does not have yet, and returns their tags in the order they were applied.
 *
 * Drizzle's own migrate() applies only the entries whose `when` is newer than the newest one recorded, so an
 * entry merged with an older `when` is skipped without a sign. This applies every journal entry whose `when`
 * is not recorded in __drizzle_migrations, in journal order, one transaction per migration. It writes the
 * same table and columns drizzle does (`created_at` is the entry's `when`), so a database drizzle migrated
 * is read as it is.
 */
export function applyMigrations(sqlite: Database.Database, migrationsFolder: string): string[] {
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

  const tags: string[] = []
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
    tags.push(tag)
  }
  return tags
}
