import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

// config.ts reads DATA_DIR as it loads: point it at a throwaway directory before the database opens.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp

let passkeys: typeof import('./passkeys')
let dbm: typeof import('#/db')

beforeAll(async () => {
  passkeys = await import('./passkeys')
  dbm = await import('#/db')
  const { db, schema } = dbm
  db.insert(schema.account).values({ id: 1, name: 'Enrique', userHandle: 'AAAA' }).run()
  db.insert(schema.passkeys)
    .values([
      { id: 1, credentialId: 'cred-1', publicKey: 'AAAA', rpId: 'localhost', name: 'desktop' },
      { id: 2, credentialId: 'cred-2', publicKey: 'AAAA', rpId: 'localhost', name: 'phone' },
    ])
    .run()
  const live = '2099-01-01T00:00:00.000Z'
  const gone = '2000-01-01T00:00:00.000Z'
  // Session ids differ from their passkeys' ids, so a count keyed on the wrong id shows.
  db.insert(schema.sessions)
    .values([
      { id: 1, tokenHash: 'h1', passkeyId: 2, expiresAt: live, lastSeenAt: live },
      { id: 2, tokenHash: 'h2', passkeyId: 1, expiresAt: live, lastSeenAt: live },
      { id: 3, tokenHash: 'h3', passkeyId: 1, expiresAt: live, lastSeenAt: live },
      { id: 4, tokenHash: 'h4', passkeyId: 2, expiresAt: gone, lastSeenAt: gone },
    ])
    .run()
})

describe('listPasskeys', () => {
  it('counts each passkey its own live sessions', () => {
    expect(passkeys.listPasskeys().map(({ id, sessions }) => ({ id, sessions }))).toEqual([
      { id: 1, sessions: 2 },
      { id: 2, sessions: 1 },
    ])
  })
})

describe('signOutOfOrigin', () => {
  it('ends the sessions made with a passkey of that origin, and keeps every passkey listed', () => {
    const { db, schema } = { db: dbm.db, schema: dbm.schema }
    const live = '2099-01-01T00:00:00.000Z'
    db.insert(schema.passkeys)
      .values({
        id: 9,
        credentialId: 'cred-9',
        publicKey: 'AAAA',
        rpId: 'old-box.example.ts.net',
        name: 'old',
      })
      .run()
    db.insert(schema.sessions)
      .values([
        { id: 90, tokenHash: 'h90', passkeyId: 9, expiresAt: live, lastSeenAt: live },
        { id: 91, tokenHash: 'h91', passkeyId: 1, expiresAt: live, lastSeenAt: live },
      ])
      .run()
    expect(passkeys.signOutOfOrigin('old-box.example.ts.net')).toBe(1)
    expect(
      db
        .select({ id: schema.sessions.id })
        .from(schema.sessions)
        .all()
        .map((s) => s.id),
    ).not.toContain(90)
    expect(
      db
        .select({ id: schema.sessions.id })
        .from(schema.sessions)
        .all()
        .map((s) => s.id),
    ).toContain(91)
    expect(passkeys.listPasskeys().map((p) => p.rpId)).toContain('old-box.example.ts.net')
    expect(passkeys.signOutOfOrigin('localhost')).toBe(5)
  })
})
