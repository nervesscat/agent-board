#!/usr/bin/env node
// Check that the drizzle migrations folder and its journal agree, so a deploy applies every migration:
//
//   pnpm check:migrations            # ./drizzle
//   node scripts/check-migrations.mjs <folder>
//
// - new migrations are named YYYYMMDDHHMMSS_slug.sql (UTC, as drizzle-kit's timestamp prefix writes them), so
//   branches that add one at the same time do not pick the same name. The NNNN_name.sql files that predate
//   that are frozen at 0000..0066: each has a number of its own, and an entry's idx is its number and its
//   place in the journal;
// - every journal entry has its .sql file, and every .sql file its journal entry;
// - idx is unique across the journal, and `when` is an integer unique across it: the loader (src/db/migrate.ts)
//   applies by `when` and records it as the migration's key, so two entries sharing one would be told apart by nothing;
// - no two snapshots in meta/ follow the same snapshot (prevId): a merge of two branches that each generated one from
//   the same parent forks the chain, and drizzle-kit then refuses to generate the next migration.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The last migration numbered NNNN_name.sql; new ones are named by timestamp. */
const LAST_NUMBERED = 66

/** The problems with the snapshots in meta/: an unreadable one, or two that follow the same snapshot. */
function snapshotProblems(metaDir) {
  const problems = []
  let names
  try {
    names = fs.readdirSync(metaDir)
  } catch {
    return problems // no meta folder: the journal check reports it
  }
  const files = names.filter((f) => f.endsWith('_snapshot.json')).sort()
  const followerOf = new Map()
  for (const file of files) {
    let snapshot
    try {
      snapshot = JSON.parse(fs.readFileSync(path.join(metaDir, file), 'utf8'))
    } catch (err) {
      problems.push(`meta/${file}: ${err instanceof Error ? err.message : err}`)
      continue
    }
    const prevId = snapshot?.prevId
    if (typeof prevId !== 'string') continue
    if (followerOf.has(prevId)) {
      problems.push(
        `meta/${followerOf.get(prevId)} and meta/${file} both follow snapshot ${prevId}: a merge forked the snapshot chain (see CONTRIBUTING.md, Database changes)`,
      )
    } else followerOf.set(prevId, file)
  }
  return problems
}

/** The problems in a migrations folder (its .sql files, meta/_journal.json and snapshots); empty when it is sound. */
export function checkMigrations(dir) {
  const problems = []
  const sql = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  const byNumber = new Map()
  for (const file of sql) {
    if (/^\d{14}_[\w-]+\.sql$/.test(file)) continue
    const m = /^(\d{4})_[\w-]+\.sql$/.exec(file)
    if (!m) {
      problems.push(
        /^\d/.test(file) ? `${file}: not named YYYYMMDDHHMMSS_slug.sql` : `${file}: not named NNNN_name.sql`,
      )
      continue
    }
    const number = Number(m[1])
    if (number > LAST_NUMBERED) {
      problems.push(`${file}: new migrations are named YYYYMMDDHHMMSS_slug.sql`)
      continue
    }
    if (byNumber.has(number)) problems.push(`${file}: number ${m[1]} is also ${byNumber.get(number)}`)
    else byNumber.set(number, file)
  }

  problems.push(...snapshotProblems(path.join(dir, 'meta')))

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
  const idxOf = new Map()
  const whenOf = new Map()
  entries.forEach((entry, i) => {
    const { tag, idx, when } = entry ?? {}
    const name = `journal entry ${i} (${tag ?? 'no tag'})`
    tags.add(tag)
    if (!sql.includes(`${tag}.sql`)) problems.push(`${name}: ${tag}.sql is missing`)
    const number = /^(\d{4})_/.exec(tag ?? '')?.[1]
    if (number !== undefined && idx !== Number(number))
      problems.push(`${name}: idx ${idx} is not the file's number ${number}`)
    if (number !== undefined && idx !== i)
      problems.push(`${name}: idx ${idx} is not its place in the journal (${i})`)
    if (!Number.isInteger(idx)) problems.push(`${name}: idx ${idx} is not an integer`)
    else if (idxOf.has(idx)) problems.push(`${name}: idx ${idx} is also used by ${idxOf.get(idx)}`)
    else idxOf.set(idx, name)
    if (typeof when !== 'number') problems.push(`${name}: when is not a number`)
    else if (!Number.isInteger(when)) problems.push(`${name}: when ${when} is not an integer`)
    else if (whenOf.has(when))
      problems.push(
        `${name}: when ${when} is also used by ${whenOf.get(when)}; the loader keys each migration by it`,
      )
    else whenOf.set(when, name)
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
