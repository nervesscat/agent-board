import { eq } from 'drizzle-orm'

import { db, schema } from '#/db'
import { AGENT_TOKEN_NAME } from '#/lib/agents'
import { type ActorKind, type ActorRole, isHumanName, lastHuman, noteActor } from './actors'
import { type AuthMode, authMode, config, type PublicEntrance, servedEntrance } from './config'
import { agentTokenOf, bearerToken, isBearer, readCookie, sessionCookieName } from './credentials'
import {
  cameThroughEntrance,
  guardRequest,
  isLoopbackPeer,
  isSignInPath,
  localSite,
  loginLocation,
  publicSite,
  type SignInSite,
  SIGN_IN_PAGES,
  wantsHtml,
} from './entrance'
import { HttpError } from './http'
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
 *
 * An agent's role comes with its credential: the token's (worker unless the human made it an
 * orchestrator), in test the X-Test-Actor's. Nothing else an agent sends raises it. An agent may say
 * which of its own workers calls, `X-Agent-Name: <its name>/<worker>` (MCP: the `agentName` argument):
 * that sub-identity is a worker, whatever the token is (asSubIdentity).
 */

const callers = new WeakMap<Request, Caller>()

export const TEST_ACTOR_HEADER = 'x-test-actor'
/** Names the sub-identity of the caller's credential that makes the call: `<token name>/<name>`. */
export const AGENT_NAME_HEADER = 'x-agent-name'
/** The X-Test-Actor forms, as the 401 and the AUTH OFF banner name them. */
export const TEST_ACTOR_FORMS = 'human:<name>, agent:<name> or orchestrator:<name>'

export interface Caller {
  name: string
  kind: ActorKind
  role: ActorRole
  /** The name a sub-identity works under (its name up to the last `/`); '' when it is none. */
  parent: string
  /** The credential's own name: the agent token's (in test the X-Test-Actor's); null for the human. */
  token: string | null
}

const human = (name: string): Caller => ({ name, kind: 'human', role: 'human', parent: '', token: null })
const agent = (name: string, role: 'orchestrator' | 'worker'): Caller => ({
  name,
  kind: 'agent',
  role,
  parent: '',
  token: name,
})

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

/**
 * An X-Test-Actor value: `human:<name>` the human, `agent:<name>` a worker agent, `orchestrator:<name>`
 * an orchestrator agent; null when it is none of them.
 */
export function parseTestActor(value: string): Caller | null {
  const m = /^(human|agent|orchestrator):(.*)$/.exec(value.trim())
  const name = m?.[2]!.trim()
  if (!m || !name || name.length > 80) return null
  if (m[1] === 'human') return human(name)
  return agent(name, m[1] === 'orchestrator' ? 'orchestrator' : 'worker')
}

/** The longest a sub-identity's whole name may be, and how many names it may chain. */
const MAX_AGENT_NAME = 80
const MAX_AGENT_SEGMENTS = 4

/**
 * The caller as its sub-identity `value` (X-Agent-Name, or MCP's `agentName`, which `label` names): an
 * agent's own worker, `<its credential's name>/<name>` (up to 4 names, 80 characters; each name a
 * letter or digit, then letters, digits, `.`, `_` or `-`, 40 at most). It is always a worker, its
 * parent the name before the last `/`; it can only lower the role. The credential's own name is the
 * caller itself; anything else is a 400. A human's call is the human's whatever it says.
 */
export function asSubIdentity(
  caller: Caller,
  value: string | null | undefined,
  label = 'X-Agent-Name',
): Caller {
  if (caller.kind === 'human' || value === null || value === undefined) return caller
  const own = caller.token ?? caller.name
  const name = value.trim()
  if (name === own) return caller
  const sub = name.startsWith(`${own}/`) ? name.slice(own.length + 1).split('/') : null
  if (
    !sub ||
    name.length > MAX_AGENT_NAME ||
    sub.length > MAX_AGENT_SEGMENTS - 1 ||
    !sub.every((segment) => AGENT_TOKEN_NAME.test(segment))
  )
    throw new HttpError(
      400,
      `${label} must be <token-name>/<name>, here ${own}/<name>: each name a letter or digit, then letters, digits, ".", "_" or "-" (40 at most), up to ${MAX_AGENT_SEGMENTS} names and ${MAX_AGENT_NAME} characters in all`,
    )
  if (isHumanName(name) || getAccount()?.name === name)
    throw new HttpError(400, `${label}: ${name} is the human's name on the board`)
  return {
    name,
    kind: 'agent',
    role: 'worker',
    parent: name.slice(0, name.lastIndexOf('/')),
    token: caller.token,
  }
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
  return agent(hit.name, hit.role === 'orchestrator' ? 'orchestrator' : 'worker')
}

/**
 * Who is calling and what they are, or null when nobody is signed in (or in test a malformed
 * X-Test-Actor). With sign-in on, how they got in says what they are: an agent token is an agent with
 * the token's role, the browser's passkey session is the human. The session must be one of `site`'s
 * origin, by default the one the request came through (siteOf). An agent's X-Agent-Name makes the call
 * that sub-identity (asSubIdentity; a malformed one throws a 400). The answer stays with the request
 * for callerInfo.
 */
export async function callerOf(
  request: Request,
  auth: AuthMode = authMode(),
  site?: SignInSite | null,
): Promise<Caller | null> {
  const caller = credentialOf(request, auth, site)
  if (!caller) return null
  const who = asSubIdentity(caller, request.headers.get(AGENT_NAME_HEADER))
  callers.set(request, who)
  return who
}

/** Who the request's credential is, before any sub-identity it names. */
function credentialOf(request: Request, auth: AuthMode, site?: SignInSite | null): Caller | null {
  if (auth.boardEnv === 'test') {
    const header = request.headers.get(TEST_ACTOR_HEADER)
    return header === null ? human(offHuman(auth)) : parseTestActor(header)
  }
  if (auth.off) return human(offHuman(auth))
  const where = site === undefined ? siteOf(request) : site
  if (!where) return null
  const authorization = request.headers.get('authorization')
  if (isBearer(authorization)) {
    const token = bearerToken(authorization)
    return token ? agentCaller(token) : null
  }
  const cookie = readCookie(request.headers.get('cookie'), sessionCookieName(config.port))
  if (!cookie || !liveSession(cookie, where)) return null
  const account = getAccount()
  return account ? human(account.name) : null
}

/** Resolve who is calling, or null when they are not signed in, and remember how they signed in. */
export async function authenticate(
  request: Request,
  site?: SignInSite | null,
  auth: AuthMode = authMode(),
): Promise<string | null> {
  const caller = await callerOf(request, auth, site)
  if (caller) noteActor(caller.name, caller.kind, caller.role, caller.parent)
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

export function rememberActor(request: Request, caller: Caller) {
  callers.set(request, caller)
}

/** The actor the middleware attached to this request. Handlers only run after it, so it is always there. */
export function actorOf(request: Request): string {
  return callers.get(request)?.name ?? 'unknown'
}

/**
 * The whole caller the middleware attached to this request: name, kind, role, parent and credential.
 * Should none be there, the least it can be, named `actor`: a worker for an agent's request.
 */
export function callerInfo(request: Request, actor?: string): Caller {
  const known = callers.get(request)
  if (known) return known
  const name = actor ?? actorOf(request)
  return isAgent(request) ? { ...agent(name, 'worker'), token: null } : human(name)
}

/** What the caller of this request may do: human, orchestrator or worker. The one place to ask. */
export const roleOf = (request: Request): ActorRole => callerInfo(request).role

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
  | { kind: 'actor'; actor: string; caller: Caller }

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
    const actor = await signIn(request, undefined, auth)
    if (actor instanceof Response) return refuse(actor)
    if (!actor)
      return refuse(Response.json({ error: `X-Test-Actor must be ${TEST_ACTOR_FORMS}` }, { status: 401 }))
    return { kind: 'actor', actor, caller: callerInfo(request) }
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
  const actor = await signIn(request, site, auth)
  if (actor instanceof Response) return refuse(actor)
  if (!actor) {
    if (isBrowserNavigation(request)) {
      const url = new URL(request.url)
      return refuse(redirectTo(loginLocation(`${url.pathname}${url.search}`)))
    }
    return refuse(Response.json({ error: 'sign in' }, { status: 401 }))
  }
  return { kind: 'actor', actor, caller: callerInfo(request) }
}

/** authenticate, with a malformed X-Agent-Name answered as its 400. */
async function signIn(
  request: Request,
  site: SignInSite | null | undefined,
  auth: AuthMode,
): Promise<string | null | Response> {
  try {
    return await authenticate(request, site, auth)
  } catch (err) {
    if (err instanceof HttpError) return Response.json({ error: err.message }, { status: err.status })
    throw err
  }
}
