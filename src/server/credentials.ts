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

/** The browser's session cookie. HttpOnly, SameSite=Lax, Secure over HTTPS (sessionCookie). */
export const SESSION_COOKIE = 'board_session'

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

export interface TokenHit {
  id: number
  name: string
  lastUsedAt: string | null
}

/** The agent token `token` is: not revoked, not expired. Null otherwise. */
export function agentTokenOf(sqlite: Database, token: string, now = new Date()): TokenHit | null {
  const row = sqlite
    .prepare(
      `select id, name, last_used_at as lastUsedAt from agent_tokens
       where token_hash = ? and revoked_at is null and expires_at > ?`,
    )
    .get(hashSecret(token), now.toISOString()) as TokenHit | undefined
  return row ?? null
}

/**
 * Whether these headers sign someone in on the origin of `rpId`: a valid agent token, else a session of
 * a passkey of that RP ID. A Bearer header that is not a valid token is a no, whatever cookie comes with it.
 */
export function signedIn(
  sqlite: Database,
  headers: { get(name: string): string | null },
  rpId: string,
  now = new Date(),
): boolean {
  const authorization = headers.get('authorization')
  if (authorization !== null && /^bearer\s/i.test(authorization)) {
    const token = bearerToken(authorization)
    return token !== null && agentTokenOf(sqlite, token, now) !== null
  }
  const cookie = readCookie(headers.get('cookie'), SESSION_COOKIE)
  return cookie !== null && sessionOf(sqlite, cookie, rpId, now) !== null
}
