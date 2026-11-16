import { and, asc, eq, isNull } from 'drizzle-orm'

import { db, schema } from '#/db'
import { AGENT_TOKEN_DAYS } from '#/lib/agents'
import { type AgentRole, listActors, setActorRole } from './actors'
import { logActivity } from './activity'
import { hashSecret, newSecret } from './credentials'
import { HttpError } from './http'
import { getAccount } from './passkeys'

/**
 * The agent tokens the board issues: Connect an agent's "Generate commands" makes one, and its commands carry
 * it as `Authorization: Bearer <token>` (README: "Signing in"). A token's name is the agent's name
 * on the board. Kept as its hash only, so the token itself is shown once, when it is made; it signs in for
 * a year (AGENT_TOKEN_DAYS), until then unless revoked. Only the signed-in human makes, lists and revokes
 * them (api.ts); the Bearer check is credentials.ts `agentTokenOf`. A token is an **orchestrator** unless
 * the human made it a worker when making it, or afterwards (setAgentTokenRole): the token Connect an
 * agent's commands carry runs the work and delegates it, so that is the role it gets. Nothing an agent
 * sends changes its role, and a `<token>/<name>` sub-identity is always a worker (auth.ts).
 */

const DAY_MS = 24 * 60 * 60 * 1000

export interface NewAgentToken {
  id: number
  name: string
  /** The token itself: in this answer only. */
  token: string
  /** What it signs in as: an orchestrator unless a worker was asked for. */
  role: AgentRole
  createdAt: string
  expiresAt: string
}

/**
 * A new token for the agent `name`, an orchestrator unless `role` says a worker, valid for AGENT_TOKEN_DAYS
 * from `now`. Never a human's name, in any case.
 */
export function mintAgentToken(
  name: string,
  role: AgentRole = 'orchestrator',
  now = new Date(),
): NewAgentToken {
  // Told apart without case, as project agents' names are (projectAgents.ts).
  const n = name.toLowerCase()
  const humans = [
    getAccount()?.name,
    ...listActors()
      .filter((a) => a.kind === 'human')
      .map((a) => a.name),
  ]
  if (humans.some((h) => h?.toLowerCase() === n))
    throw new HttpError(409, `${name} is the human's name on the board: pick the agent's own`)
  const token = newSecret()
  const createdAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + AGENT_TOKEN_DAYS * DAY_MS).toISOString()
  const row = db
    .insert(schema.agentTokens)
    .values({ tokenHash: hashSecret(token), name, role, createdAt, expiresAt })
    .returning({ id: schema.agentTokens.id })
    .get()
  // A name the board already knows shows its new role before this token's first request (its
  // sub-identities stay workers: setActorRole reaches the parent row only).
  setActorRole(name, role)
  return { id: row.id, name, token, role, createdAt, expiresAt }
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
      role: schema.agentTokens.role,
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

/**
 * The human's call: the token `id` is an orchestrator (it also changes the projects' instructions) or a
 * worker. Its next request signs in with the new role, and its name's actor row shows it at once.
 */
export function setAgentTokenRole(id: number, role: AgentRole, actor: string): AgentTokenRow {
  const row = db
    .update(schema.agentTokens)
    .set({ role })
    .where(and(eq(schema.agentTokens.id, id), isNull(schema.agentTokens.revokedAt)))
    .returning({ name: schema.agentTokens.name })
    .get()
  if (!row) throw new HttpError(404, 'agent token not found')
  setActorRole(row.name, role)
  logActivity({
    projectId: null,
    actor,
    kind: 'agent-token',
    text: `made the agent token ${row.name} ${role === 'orchestrator' ? 'an orchestrator' : 'a worker'}`,
  })
  return listAgentTokens().find((t) => t.id === id)!
}
