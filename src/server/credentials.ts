import { createHash, randomBytes } from 'node:crypto'

import type { Database } from 'better-sqlite3'

/**
 * What a request signs in with, checked against the board's database: the browser's session cookie
 * (made by a passkey sign-in, passkeys.ts) or an agent's `Authorization: Bearer <token>`. Only hashes are
 * stored, so a copy of the database signs nobody in.
 *
 * Plain SQL on a better-sqlite3 handle, no other board module: `vite dev` asks the same questions in its
 * own process, before it serves its files through the tailnet entrance (devEntrance.ts).
 */

/**
 * The browser's session cookie of the board on `port` (PORT). HttpOnly, SameSite=Lax, Secure over HTTPS
 * (sessionCookie). Browsers do not tell cookies apart by port, so the name does: a copy of the board on
 * localhost:47101 never overwrites or clears the session of the board on localhost:47100.
 */
export const sessionCookieName = (port: number) => `board_session_${port}`

/** A new secret for a cookie, a token or a one-time code: 32 random bytes, base64url. */
export const newSecret = () => randomBytes(32).toString('base64url')

/** What the database keeps of a secret. */
export const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex')

/** The value of the first cookie called `name` in a Cookie header, or null. */
export function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null
  }
  return null
}

/**
 * An Authorization header of the Bearer scheme, a bare `Bearer` included: a claim to be an agent, which
 * is let in on a valid token only, never on a cookie that comes with it.
 */
export const isBearer = (authorization: string | null) => /^bearer(\s|$)/i.test(authorization ?? '')

/** The token of an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(authorization: string | null): string | null {
  const m = /^bearer\s+(\S+)\s*$/i.exec(authorization ?? '')
  return m ? m[1]! : null
}

export interface SessionHit {
  id: number
  passkeyId: number
  lastSeenAt: string
}

/**
 * The live session the cookie value `token` is, for a passkey of `rpId`: a session made on the other
 * origin (localhost, or the tailnet name) is not one here. Null when unknown or expired.
 */
export function sessionOf(
  sqlite: Database,
  token: string,
  rpId: string,
  now = new Date(),
): SessionHit | null {
  const row = sqlite
    .prepare(
      `select s.id as id, s.passkey_id as passkeyId, s.last_seen_at as lastSeenAt
       from sessions s join passkeys p on p.id = s.passkey_id
       where s.token_hash = ? and s.expires_at > ? and p.rp_id = ?`,
    )
    .get(hashSecret(token), now.toISOString(), rpId) as SessionHit | undefined
  return row ?? null
}

/** What a credential reaches: the whole board, or the two skill downloads only (auth.ts `admit`). */
export type TokenScope = 'full' | 'skill'

/** The name a skill download credential signs in as: fixed, not an agent's, and it never posts. */
export const SKILL_TOKEN_ACTOR = 'skill-download'

export interface TokenHit {
  id: number
  name: string
  lastUsedAt: string | null
  /** The role the human gave the token: orchestrator, or worker (every token's at first). */
  role: 'orchestrator' | 'worker'
  scope: TokenScope
}

/**
 * The credential `token` is: a live agent token (the whole board), else a live skill download
 * credential (the two skill downloads only). Not revoked, not expired. Null otherwise.
 */
export function agentTokenOf(sqlite: Database, token: string, now = new Date()): TokenHit | null {
  const tokenHash = hashSecret(token)
  const row = sqlite
    .prepare(
      `select id, name, last_used_at as lastUsedAt, role from agent_tokens
       where token_hash = ? and revoked_at is null and expires_at > ?`,
    )
    .get(tokenHash, now.toISOString()) as Omit<TokenHit, 'scope'> | undefined
  if (row) return { ...row, scope: 'full' }
  // A skill credential is a row of its own: it is never listed with the agent tokens and has no role.
  const skill = sqlite
    .prepare(`select id from skill_tokens where token_hash = ? and expires_at > ?`)
    .get(tokenHash, now.toISOString()) as { id: number } | undefined
  return skill
    ? { id: skill.id, name: SKILL_TOKEN_ACTOR, lastUsedAt: null, role: 'worker', scope: 'skill' }
    : null
}

/**
 * Whether these headers sign someone in on the origin of `rpId`, on the board on `port`: a valid agent
 * token, else a session of a passkey of that RP ID. A Bearer header that is not a valid token (a bare
 * `Bearer` too) is a no, whatever cookie comes with it. A skill download credential is no sign-in here:
 * it reaches the two skill downloads and nothing else (auth.ts `admit`).
 */
export function signedIn(
  sqlite: Database,
  headers: { get(name: string): string | null },
  rpId: string,
  port: number,
  now = new Date(),
): boolean {
  const authorization = headers.get('authorization')
  if (isBearer(authorization)) {
    const token = bearerToken(authorization)
    const hit = token === null ? null : agentTokenOf(sqlite, token, now)
    return hit?.scope === 'full'
  }
  const cookie = readCookie(headers.get('cookie'), sessionCookieName(port))
  return cookie !== null && sessionOf(sqlite, cookie, rpId, now) !== null
}
