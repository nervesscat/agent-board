import { lte } from 'drizzle-orm'

import { db, schema } from '#/db'
import { hashSecret, newSecret } from './credentials'

/**
 * The credentials an install line carries: the board skill's `curl` and the review bundle's `tar`. They are
 * made by the signed-in human's session (api.ts) and kept as their hash only, like every secret; they live
 * SKILL_TOKEN_MINUTES, reach the two skill downloads and nothing else (credentials.ts `agentTokenOf` says
 * the scope, auth.ts `admit` enforces it), and never appear in the agent tokens or in a log. A new one
 * deletes every expired row, so nothing needs to revoke them.
 */

/** How long an install line's credential lives. */
export const SKILL_TOKEN_MINUTES = 10

export interface SkillToken {
  /** The credential itself: in this answer only, never stored in plain text nor logged. */
  token: string
  expiresAt: string
}

/** A new credential for the install lines, valid SKILL_TOKEN_MINUTES from `now`. Expired rows go first. */
export function mintSkillToken(now = new Date()): SkillToken {
  purgeExpiredSkillTokens(now)
  const token = newSecret()
  const expiresAt = new Date(now.getTime() + SKILL_TOKEN_MINUTES * 60_000).toISOString()
  db.insert(schema.skillTokens)
    .values({ tokenHash: hashSecret(token), createdAt: now.toISOString(), expiresAt })
    .run()
  return { token, expiresAt }
}

/** Deletes every expired row and answers how many went: the next mint leaves none behind. */
export function purgeExpiredSkillTokens(now = new Date()): number {
  return db.delete(schema.skillTokens).where(lte(schema.skillTokens.expiresAt, now.toISOString())).run()
    .changes
}
