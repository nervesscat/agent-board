#!/usr/bin/env node
// Check that the drizzle migrations folder and its journal agree, so a deploy applies every migration:
//
//   pnpm check:migrations            # ./drizzle
//   node scripts/check-migrations.mjs <folder>
//
// - every NNNN_name.sql has a number of its own;
// - every journal entry has its .sql file, and every .sql file its journal entry;
// - an entry's idx is its file's number, and its place in the journal;
// - `when` grows strictly down the journal. Drizzle applies only the migrations newer than the last
//   one applied, by `when`: one dated before it (a branch merged after a later migration) is skipped
//   on every database that already has the later one, without an error.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The problems in a migrations folder (its .sql files and meta/_journal.json); empty when it is sound. */
export function checkMigrations(dir) {
  const problems = []
  const sql = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  const byNumber = new Map()
  for (const file of sql) {
    const m = /^(\d{4})_[\w-]+\.sql$/.exec(file)
    if (!m) {
      problems.push(`${file}: not named NNNN_name.sql`)
      continue
    }
    const number = Number(m[1])
    if (byNumber.has(number)) problems.push(`${file}: number ${m[1]} is also ${byNumber.get(number)}`)
    else byNumber.set(number, file)
  }

  const journalPath = path.join(dir, 'meta', '_journal.json')
  let entries
  try {
    entries = JSON.parse(fs.readFileSync(journalPath, 'utf8')).entries
  } catch (err) {
    problems.push(`meta/_journal.json: ${err instanceof Error ? err.message : err}`)
    return problems
  }
  if (!Array.isArray(entries)) return [...problems, 'meta/_journal.json: no entries list']

  const tags = new Set()
  entries.forEach((entry, i) => {
    const { tag, idx, when } = entry ?? {}
    const name = `journal entry ${i} (${tag ?? 'no tag'})`
    tags.add(tag)
    if (!sql.includes(`${tag}.sql`)) problems.push(`${name}: ${tag}.sql is missing`)
    const number = /^(\d{4})_/.exec(tag ?? '')?.[1]
    if (number !== undefined && idx !== Number(number))
      problems.push(`${name}: idx ${idx} is not the file's number ${number}`)
    if (idx !== i) problems.push(`${name}: idx ${idx} is not its place in the journal (${i})`)
    if (typeof when !== 'number') problems.push(`${name}: when is not a number`)
    else if (i > 0 && typeof entries[i - 1]?.when === 'number' && when <= entries[i - 1].when)
      problems.push(
        `${name}: when ${when} is not after the entry before it (${entries[i - 1].when}); ` +
          'drizzle would skip it on a database that has the earlier one',
      )
  })
  for (const file of sql)
    if (!tags.has(file.replace(/\.sql$/, ''))) problems.push(`${file}: no journal entry`)
  return problems
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.argv[2] ?? 'drizzle')
  const problems = checkMigrations(dir)
  if (problems.length) {
    console.error(`Migrations in ${dir}:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    process.exit(1)
  }
  console.log(`Migrations in ${dir}: ok`)
}
