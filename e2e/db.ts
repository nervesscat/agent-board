import fs from 'node:fs'
import path from 'node:path'

import Database from 'better-sqlite3'

import { e2eEnv } from './env'

/**
 * Writes straight to the run's throwaway database, for the one thing no API does: putting a moment in
 * the past (a ticket started yesterday, an upload a day old). Only this run's board reads it.
 */
export function inDatabase<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(path.join(e2eEnv().dataDir, 'board.db'))
  db.pragma('busy_timeout = 5000')
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

/** Yesterday at noon, local time, as the board stores moments. */
export function yesterdayNoon(): string {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  d.setHours(12, 0, 0, 0)
  return d.toISOString()
}

/** Marks a ticket's work as started at `at` (its stage moves stay as they were). */
export function startedAt(ticketId: number, at: string) {
  inDatabase((db) => db.prepare('update tickets set started_at = ? where id = ?').run(at, ticketId))
}

/** Dates an upload `days` back (it was made just now). */
export function uploadedDaysAgo(attachmentId: number, days: number) {
  const at = new Date(Date.now() - days * 86_400_000).toISOString()
  inDatabase((db) => db.prepare('update attachments set "createdAt" = ? where id = ?').run(at, attachmentId))
}

/**
 * Runs `fn` while no other test holds `name`, for a test about something the whole board shares (old
 * unattached uploads count across projects), so copies of it running side by side cannot see each
 * other's.
 */
export async function alone<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const lock = path.join(e2eEnv().root, `${name}.lock`)
  for (let tries = 0; ; tries++) {
    try {
      fs.mkdirSync(lock)
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || tries > 600) throw err
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  try {
    return await fn()
  } finally {
    fs.rmSync(lock, { recursive: true, force: true })
  }
}
