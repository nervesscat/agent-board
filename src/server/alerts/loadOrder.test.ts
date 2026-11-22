import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

// The server loads the registry first, and the registry imports the type files: a number a type file
// reads from the registry at load time is still undefined there. This file loads the registry first, as
// the server does, and checks what the types made of their constants.
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-alerts-order-')))
process.env.DATA_DIR = path.join(tmp, 'data')
process.env.BOARD_ENV = 'test'
process.env.HOME = process.env.USERPROFILE = tmp
process.env.CLAUDE_HOME = path.join(tmp, 'claude-home')

let registry: typeof import('./registry')

beforeAll(async () => {
  registry = await import('./registry')
}, 60_000)

describe('the registry loaded first', () => {
  it('gives every type finite, positive snooze options', () => {
    for (const type of registry.allAlertTypes())
      for (const ms of registry.snoozeOptionsOf(type))
        expect(Number.isFinite(ms) && ms > 0, `${type.type}: ${ms}`).toBe(true)
  })

  it('keeps a token with a year left quiet and warns about one with days left', async () => {
    const { mintAgentToken } = await import('../tokens')
    const { db, schema } = await import('#/db')
    const { eq } = await import('drizzle-orm')
    const type = registry.findAlertType('agent-token-expiring')!
    const day = 24 * 60 * 60_000
    const ctx = (now: number) => ({
      projectId: null,
      now: () => now,
      projects: { list: () => [], get: () => undefined },
    })
    const token = mintAgentToken('order-agent', 'worker', new Date(Date.UTC(2026, 0, 1)))
    const early = Date.UTC(2026, 1, 1)
    expect(await type.check(ctx(early))).toEqual([])
    db.update(schema.agentTokens)
      .set({ expiresAt: new Date(early + 3 * day).toISOString() })
      .where(eq(schema.agentTokens.id, token.id))
      .run()
    const found = await type.check(ctx(early))
    expect(found).toHaveLength(1)
    expect(found[0]!.title).toBe('The token for order-agent expires in 3 days')
  })
})
