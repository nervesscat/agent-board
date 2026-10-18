import { eq } from 'drizzle-orm'

import { db, schema } from '#/db'
import { type ActorKind, lastHuman, noteActor } from './actors'
import { type AuthMode, authMode, config, type PublicEntrance, servedEntrance } from './config'
import { agentTokenOf, bearerToken, readCookie, SESSION_COOKIE } from './credentials'
import {
  cameThroughEntrance,
  guardRequest,
  isBearer,
  isLoopbackPeer,
  isSignInPath,
  localSite,
  loginLocation,
  publicSite,
  type SignInSite,
  SIGN_IN_PAGES,
  wantsHtml,
} from './entrance'
import { getAccount, hasAccount, liveSession } from './passkeys'

/**
 * Who a request is. The board signs people in itself (passkeys.ts, README: "Signing in"): the browser's
 * session cookie, made by a passkey on the origin it came through, is the human; an agent's
 * `Authorization: Bearer <token>`, checked against the agent tokens, is that agent. A session of one
 * origin (localhost, or the tailnet name through the entrance) is never one on the other.
 *
 * Outside production sign-in can be off (config.ts, README: "Test mode"): in development with AUTH=off
 * every request is the human; in test the X-Test-Actor header says who calls, and a request without it
 * is the human. In production and development that header is never read.
 */

const actors = new WeakMap<Request, string>()

export const TEST_ACTOR_HEADER = 'x-test-actor'

export interface Caller {
  name: string
  kind: ActorKind
}

/** The address the request's connection came from, where the server can tell (srvx's Node request). */
export function peerOf(request: Request): string | undefined {
  type NodeRequest = { runtime?: { node?: { req?: { socket?: { remoteAddress?: string } } } } }
  return (request as NodeRequest).runtime?.node?.req?.socket?.remoteAddress
}

/**
 * Where a request signs in: the public origin when it came through the tailnet entrance, else this
 * machine's localhost. Null when it came through a proxy and no entrance is configured: nobody is signed
 * in then (the guard has refused it already).
 */
export function siteOf(
  request: Request,
  entrance: PublicEntrance | null = servedEntrance(),
  peer: string | undefined = peerOf(request),
): SignInSite | null {
  if (!cameThroughEntrance({ method: request.method, headers: request.headers, peer }, entrance))
    return localSite(config.port)
  return entrance ? publicSite(entrance) : null
}

/**
 * Straight to the board from this machine: no proxy in between and a loopback peer. Only such a request
 * may create the account (first boot).
 */
export function onThisMachine(request: Request, entrance: PublicEntrance | null = servedEntrance()): boolean {
  const peer = peerOf(request)
  return (
    isLoopbackPeer(peer) &&
    !cameThroughEntrance({ method: request.method, headers: request.headers, peer }, entrance)
  )
}

/** An X-Test-Actor value, `human:<name>` or `agent:<name>`; null when it is neither. */
export function parseTestActor(value: string): Caller | null {
  const m = /^(human|agent):(.*)$/.exec(value.trim())
  const name = m?.[2]!.trim()
  if (!m || !name || name.length > 80) return null
  return { name, kind: m[1] as ActorKind }
}

let lastSeenHuman: string | undefined
/** Who the human is while sign-in is off: the configured name, else the human the board last saw. */
export function offHuman(auth: AuthMode): string {
  return auth.human ?? (lastSeenHuman ??= lastHuman() ?? 'human')
}

/** The agent of this Bearer token, its last use kept to the minute; null when unknown, revoked or expired. */
function agentCaller(token: string): Caller | null {
  const hit = agentTokenOf(db.$client, token)
  if (!hit) return null
  if (!hit.lastUsedAt || Date.now() - Date.parse(hit.lastUsedAt) > 60_000)
    db.update(schema.agentTokens)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(schema.agentTokens.id, hit.id))
      .run()
  return { name: hit.name, kind: 'agent' }
}

/**
 * Who is calling and what they are, or null when nobody is signed in (or in test a malformed
 * X-Test-Actor). With sign-in on, how they got in says what they are: an agent token is an agent, the
 * browser's passkey session is the human. The session must be one of `site`'s origin, by default the one
 * the request came through (siteOf).
 */
export async function callerOf(
  request: Request,
  auth: AuthMode = authMode(),
  site?: SignInSite | null,
): Promise<Caller | null> {
  if (auth.boardEnv === 'test') {
    const header = request.headers.get(TEST_ACTOR_HEADER)
    return header === null ? { name: offHuman(auth), kind: 'human' } : parseTestActor(header)
  }
  if (auth.off) return { name: offHuman(auth), kind: 'human' }
  const where = site === undefined ? siteOf(request) : site
  if (!where) return null
  const authorization = request.headers.get('authorization')
  if (isBearer(authorization)) {
    const token = bearerToken(authorization)
    return token ? agentCaller(token) : null
  }
  const cookie = readCookie(request.headers.get('cookie'), SESSION_COOKIE)
  if (!cookie || !liveSession(cookie, where)) return null
  const account = getAccount()
  return account ? { name: account.name, kind: 'human' } : null
}

/** Resolve who is calling, or null when they are not signed in, and remember how they signed in. */
export async function authenticate(request: Request, site?: SignInSite | null): Promise<string | null> {
  const caller = await callerOf(request, authMode(), site)
  if (caller) noteActor(caller.name, caller.kind)
  return caller?.name ?? null
}

/**
 * An agent, as opposed to the human: an agent token rather than the browser's passkey session, or in
 * test an `agent:` X-Test-Actor. In development with sign-in off nobody is.
 */
export function isAgent(request: Request, auth: AuthMode = authMode()): boolean {
  if (auth.boardEnv === 'test') {
    const header = request.headers.get(TEST_ACTOR_HEADER)
    return header !== null && parseTestActor(header)?.kind === 'agent'
  }
  return !auth.off && isBearer(request.headers.get('authorization'))
}

export function rememberActor(request: Request, actor: string) {
  actors.set(request, actor)
}

/** The actor the middleware attached to this request. Handlers only run after it, so it is always there. */
export function actorOf(request: Request): string {
  return actors.get(request) ?? 'unknown'
}

/** A relative redirect: it stays on the origin the browser used, whatever a forwarded header says. */
export const redirectTo = (location: string) => new Response(null, { status: 302, headers: { location } })

export function isBrowserNavigation(request: Request): boolean {
  return wantsHtml(request.method, request.headers.get('accept'))
}

// Answered without a session on this machine only: through the tailnet entrance it needs one too.
const PUBLIC = new Set(['/api/health'])

/**
 * What the board's request middleware does with a request, before any handler (src/start.ts):
 * - `refuse`: answered here (the guard's 403, a 401, a redirect to /setup or /login);
 * - `page`: one of the sign-in pages, which authPages.ts renders;
 * - `open`: on without a caller (the sign-in endpoints, /api/health on this machine);
 * - `actor`: on as that caller.
 *
 * Until the account exists (first boot) every other page goes to /setup and every other call gets 409
 * `setup required`, on both origins.
 */
export type Admission =
  | { kind: 'refuse'; response: Response }
  | { kind: 'page'; site: SignInSite }
  | { kind: 'open' }
  | { kind: 'actor'; actor: string }

export async function admit(
  request: Request,
  pathname: string,
  auth: AuthMode = authMode(),
  entrance: PublicEntrance | null = servedEntrance(),
): Promise<Admission> {
  const refuse = (response: Response): Admission => ({ kind: 'refuse', response })
  const verdict = guardRequest(
    { method: request.method, headers: request.headers, peer: peerOf(request) },
    { authOff: auth.off, port: config.port, entrance, dataDir: config.dataDir },
  )
  if (!verdict.allow) return refuse(Response.json({ error: verdict.error }, { status: verdict.status }))
  if (auth.off) {
    // Nobody signs in: the sign-in pages have nothing to do, and the endpoints say so themselves.
    if (SIGN_IN_PAGES.has(pathname)) return refuse(redirectTo('/'))
    if (isSignInPath(pathname) || PUBLIC.has(pathname)) return { kind: 'open' }
    const actor = await authenticate(request)
    if (!actor)
      return refuse(
        Response.json({ error: 'X-Test-Actor must be human:<name> or agent:<name>' }, { status: 401 }),
      )
    return { kind: 'actor', actor }
  }
  const site = verdict.entrance ? publicSite(verdict.entrance) : localSite(config.port)
  if (PUBLIC.has(pathname) && !verdict.entrance) return { kind: 'open' }
  if (SIGN_IN_PAGES.has(pathname)) return { kind: 'page', site }
  if (isSignInPath(pathname)) return { kind: 'open' }
  if (!hasAccount()) {
    if (isBrowserNavigation(request)) return refuse(redirectTo('/setup'))
    return refuse(
      Response.json(
        { error: 'setup required: create the account at /setup on the host', code: 'setup' },
        { status: 409 },
      ),
    )
  }
  const actor = await authenticate(request, site)
  if (!actor) {
    if (isBrowserNavigation(request)) {
      const url = new URL(request.url)
      return refuse(redirectTo(loginLocation(`${url.pathname}${url.search}`)))
    }
    return refuse(Response.json({ error: 'sign in' }, { status: 401 }))
  }
  return { kind: 'actor', actor }
}
