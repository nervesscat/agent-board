import { and, asc, eq, isNull } from 'drizzle-orm'

import { db, schema } from '#/db'
import { AGENT_TOKEN_DAYS } from '#/lib/agents'
import { isHumanName } from './actors'
import { hashSecret, newSecret } from './credentials'
import { HttpError } from './http'
import { getAccount } from './passkeys'

/**
 * The agent tokens the board issues: Connect agents' "Generate commands" makes one, and its commands carry
 * it as `Authorization: Bearer <token>` (README: "Connecting agents"). A token's name is the agent's name
 * on the board. Kept as its hash only, so the token itself is shown once, when it is made; it signs in for
 * a year (AGENT_TOKEN_DAYS), until then unless revoked. Only the signed-in human makes, lists and revokes
 * them (api.ts); the Bearer check is credentials.ts `agentTokenOf`.
 */

const DAY_MS = 24 * 60 * 60 * 1000

export interface NewAgentToken {
  id: number
  name: string
  /** The token itself: in this answer only. */
  token: string
  createdAt: string
  expiresAt: string
}

/** A new token for the agent `name`, valid for AGENT_TOKEN_DAYS from `now`. Never a human's name. */
export function mintAgentToken(name: string, now = new Date()): NewAgentToken {
  if (getAccount()?.name === name || isHumanName(name))
    throw new HttpError(409, `${name} is the human's name on the board: pick the agent's own`)
  const token = newSecret()
  const createdAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + AGENT_TOKEN_DAYS * DAY_MS).toISOString()
  const row = db
    .insert(schema.agentTokens)
    .values({ tokenHash: hashSecret(token), name, createdAt, expiresAt })
    .returning({ id: schema.agentTokens.id })
    .get()
  return { id: row.id, name, token, createdAt, expiresAt }
}

/** The tokens not revoked, expired ones included, oldest first: never the token or its hash. */
export function listAgentTokens() {
  return db
    .select({
      id: schema.agentTokens.id,
      name: schema.agentTokens.name,
      createdAt: schema.agentTokens.createdAt,
      lastUsedAt: schema.agentTokens.lastUsedAt,
      expiresAt: schema.agentTokens.expiresAt,
    })
    .from(schema.agentTokens)
    .where(isNull(schema.agentTokens.revokedAt))
    .orderBy(asc(schema.agentTokens.id))
    .all()
}

export type AgentTokenRow = ReturnType<typeof listAgentTokens>[number]

/** Revokes a token: the next request with it is a 401. */
export function revokeAgentToken(id: number, now = new Date()) {
  const gone = db
    .update(schema.agentTokens)
    .set({ revokedAt: now.toISOString() })
    .where(and(eq(schema.agentTokens.id, id), isNull(schema.agentTokens.revokedAt)))
    .run()
  if (gone.changes !== 1) throw new HttpError(404, 'agent token not found')
}
