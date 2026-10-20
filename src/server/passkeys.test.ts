import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

// config.ts reads DATA_DIR as it loads: point it at a throwaway directory before the database opens.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp

let passkeys: typeof import('./passkeys')

beforeAll(async () => {
  passkeys = await import('./passkeys')
  const { db, schema } = await import('#/db')
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
