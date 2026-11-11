import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { eq } from 'drizzle-orm'

import { db, schema } from '#/db'
import { authMode, config, servedEntrance } from './config'
import { previewCookieName, previewPathOf } from './previewPaths'

export { previewCookieName, previewPathOf }

/**
 * The links to a running preview through the board's own origin (previewProxy.ts): `/p/<workspaceId>/<runId>/`.
 * A browser that cannot send a header gets a link, `/p/<w>/<r>/?pl=<value>`, which the board redeems once
 * (a GET of that URL sets a cookie and redirects to the path without the link). Both the link and the
 * cookie carry the same signed value:
 *
 *   v1.<expires, in seconds>.<principal>.<mac>
 *
 * where the principal is `s<id>` (a passkey session of the human) or `t<id>` (an agent token), and the mac
 * is HMAC-SHA256 over the workspace id, the run id, the run's `runningAt` (a restart changes it, so an old
 * link fails) and the principal and expiry, with a random secret kept in the settings table. Nothing
 * secret is in the value, and nothing about it is stored: the link is valid until its expiry, however
 * often it is opened (the proxy checks the principal is still signed in, or its token still valid, on
 * every request).
 */

/** How long a minted link may be redeemed. */
export const PREVIEW_LINK_TTL_MS = 5 * 60_000
/** How long a redeemed link's cookie lasts (no sliding). */
export const PREVIEW_COOKIE_MAX_AGE_S = 15 * 60

/** The settings-table key the link secret is kept under. */
export const PREVIEW_LINK_KEY = 'preview_link_key'

export type Principal = `s${number}` | `t${number}`

let key: Buffer | null = null

/** The link secret: made once, on the first need, and kept in the settings table. */
export function linkSecret(): Buffer {
  if (key) return key
  const read = (): string | null => {
    const value: unknown = db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, PREVIEW_LINK_KEY))
      .get()?.value
    return typeof value === 'string' && value ? value : null
  }
  let secret = read()
  if (!secret) {
    db.insert(schema.settings)
      .values({ key: PREVIEW_LINK_KEY, value: randomBytes(32).toString('base64url') })
      .onConflictDoNothing()
      .run()
    secret = read()
    if (!secret) throw new Error('the preview link secret cannot be stored')
  }
  key = Buffer.from(secret, 'base64url')
  return key
}

const macOf = (
  workspaceId: number,
  runId: number,
  runningAt: string,
  principal: Principal,
  expires: number,
) =>
  createHmac('sha256', linkSecret())
    .update(['v1', workspaceId, runId, runningAt, principal, expires].join('|'))
    .digest('base64url')

/** The signed value for a run's start (`runningAt`), a principal, valid until `expiresMs`. */
export function signPreviewValue(
  workspaceId: number,
  runId: number,
  runningAt: string,
  principal: Principal,
  expiresMs: number,
): string {
  const expires = Math.floor(expiresMs / 1000)
  return `v1.${expires}.${principal}.${macOf(workspaceId, runId, runningAt, principal, expires)}`
}

/**
 * The principal a value was signed for, when the value is genuine for this run and this start and not yet
 * expired; null otherwise. Says nothing about whether the principal is still signed in (previewProxy.ts).
 */
export function verifyPreviewValue(
  value: string | null | undefined,
  workspaceId: number,
  runId: number,
  runningAt: string | null,
  nowMs: number,
): Principal | null {
  if (!value || !runningAt) return null
  const parts = value.split('.')
  if (parts.length !== 4 || parts[0] !== 'v1') return null
  const [, expires, principal, mac] = parts as [string, string, string, string]
  if (!/^\d+$/.test(expires) || !/^[st]\d+$/.test(principal)) return null
  if (Number(expires) * 1000 <= nowMs) return null
  const expected = Buffer.from(macOf(workspaceId, runId, runningAt, principal as Principal, Number(expires)))
  const given = Buffer.from(mac)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  return principal as Principal
}

/** The path a link opens, `/p/<w>/<r>/?pl=<value>`, for a principal, valid for PREVIEW_LINK_TTL_MS. */
export function mintPreviewLink(
  workspaceId: number,
  runId: number,
  runningAt: string,
  principal: Principal,
  nowMs = Date.now(),
): { url: string; expiresAt: string } {
  const expiresMs = nowMs + PREVIEW_LINK_TTL_MS
  const value = signPreviewValue(workspaceId, runId, runningAt, principal, expiresMs)
  return {
    url: `${previewPathOf(workspaceId, runId)}?pl=${value}`,
    expiresAt: new Date(expiresMs).toISOString(),
  }
}

/**
 * The links a running preview is listed with: `proxyUrl` (this machine's board origin, the proxied path),
 * and `remoteUrl` when a tailnet entrance is served. Null for anything that is not a running preview, and
 * with sign-in off (the proxy answers 404 then, so no link is offered).
 */
export function previewLinksOf(state: {
  workspaceId: number
  runId: number
  runType: string
  status: string
  port: number | null
}): { proxyUrl: string; remoteUrl?: string } | null {
  if (state.runType !== 'preview' || state.status !== 'running' || state.port === null) return null
  if (authMode().off) return null
  const path = previewPathOf(state.workspaceId, state.runId)
  const entrance = servedEntrance()
  return {
    proxyUrl: `http://localhost:${config.port}${path}`,
    ...(entrance ? { remoteUrl: `${entrance.origin}${path}` } : {}),
  }
}
