import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import: point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-skill-tokens-'))
process.env.DATA_DIR = tmp

let dbm: typeof import('#/db')
let skillTokens: typeof import('./skillTokens')
let hashSecret: typeof import('./credentials').hashSecret

beforeAll(async () => {
  dbm = await import('#/db')
  skillTokens = await import('./skillTokens')
  hashSecret = (await import('./credentials')).hashSecret
})

const rows = () => dbm.db.select().from(dbm.schema.skillTokens).all()

describe('a skill download credential', () => {
  it('lives ten minutes, is random, and is kept as its hash only', () => {
    const now = new Date('2020-01-01T00:00:00.000Z')
    const one = skillTokens.mintSkillToken(now)
    expect(one.token).toMatch(/^[\w-]{43}$/)
    expect(Date.parse(one.expiresAt) - now.getTime()).toBe(10 * 60_000)
    const two = skillTokens.mintSkillToken(now)
    expect(two.token).not.toBe(one.token)

    const row = rows().find((r) => r.tokenHash === hashSecret(one.token))!
    expect(row).toMatchObject({ tokenHash: hashSecret(one.token), expiresAt: one.expiresAt })
    expect(row.createdAt).toBe(now.toISOString())
    // No text column of the table holds the credential itself, and neither does the database file.
    expect(JSON.stringify(rows())).not.toContain(one.token)
    const bytes = ['board.db', 'board.db-wal', 'board.db-shm']
      .map((f) => path.join(tmp, f))
      .filter((f) => fs.existsSync(f))
      .map((f) => fs.readFileSync(f).toString('latin1'))
      .join('')
    expect(bytes).not.toContain(one.token)
  })

  it('drops the expired rows when one is purged, and keeps the live ones', () => {
    const now = new Date()
    const past = new Date(now.getTime() - 60_000).toISOString()
    const future = new Date(now.getTime() + 60 * 60_000).toISOString()
    dbm.db
      .insert(dbm.schema.skillTokens)
      .values([
        { tokenHash: hashSecret('gone-for-good'), createdAt: past, expiresAt: past },
        { tokenHash: hashSecret('still-live'), createdAt: past, expiresAt: future },
      ])
      .run()
    expect(skillTokens.purgeExpiredSkillTokens(now)).toBeGreaterThanOrEqual(1)
    const hashes = rows().map((r) => r.tokenHash)
    expect(hashes).toContain(hashSecret('still-live'))
    expect(hashes).not.toContain(hashSecret('gone-for-good'))
  })

  it('purges on the mint path too, so nothing revokes one', () => {
    const now = new Date()
    const past = new Date(now.getTime() - 60_000).toISOString()
    dbm.db
      .insert(dbm.schema.skillTokens)
      .values({ tokenHash: hashSecret('left-behind'), createdAt: past, expiresAt: past })
      .run()
    skillTokens.mintSkillToken(now)
    expect(rows().map((r) => r.tokenHash)).not.toContain(hashSecret('left-behind'))
  })

  it('prints nothing: no log statement names the credential or its hash', () => {
    for (const file of ['skillTokens.ts', 'credentials.ts']) {
      const source = fs.readFileSync(path.join(import.meta.dirname, file), 'utf8')
      expect(source, file).not.toMatch(/console\.|logActivity|process\.std(out|err)/)
    }
  })
})
