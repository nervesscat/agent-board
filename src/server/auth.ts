import { type ActorKind, lastHuman, noteActor } from './actors'
import { type AuthMode, authMode, config, type PublicEntrance, servedEntrance } from './config'
import {
  cameThroughEntrance,
  type GateRoute,
  isBearer,
  loginLocation,
  publicRoute,
  wantsHtml,
} from './entrance'
import { gateCaller } from './gate'

/**
 * passkey-gate is the only identity source. Every request is answered by a gate's /auth exactly as
 * Traefik's forwardAuth would ask it: the browser's cookie or an agent's `Bearer gate_…` token goes
 * through unchanged, and the gate's X-Gate-Device header (device or token name) becomes the actor
 * (gate.ts). That gate is GATE_URL, or the public gate for a request that came through the tailnet
 * entrance (PUBLIC_GATE_AUTH_URL; entrance.ts, README "Using it from other devices"): never both.
 *
 * Outside production the gate can be off (config.ts, README "Test mode"): in development with
 * AUTH=off every request is the human; in test the X-Test-Actor header says who calls, and a request
 * without it is the human. In production and development that header is never read.
 */

const actors = new WeakMap<Request, string>()

export const TEST_ACTOR_HEADER = 'x-test-actor'

export interface Caller {
  name: string
  kind: ActorKind
}

/** The localhost gate: GATE_URL for the login and /auth alike, back to BOARD_URL after it. */
export const localRoute = (): GateRoute => ({
  loginUrl: config.gateUrl,
  authUrl: config.gateUrl,
  boardUrl: config.boardUrl,
})

/** The address the request's connection came from, where the server can tell (srvx's Node request). */
export function peerOf(request: Request): string | undefined {
  type NodeRequest = { runtime?: { node?: { req?: { socket?: { remoteAddress?: string } } } } }
  return (request as NodeRequest).runtime?.node?.req?.socket?.remoteAddress
}

/**
 * The gate a request answers to: the public gate when it came through the tailnet entrance, else the
 * localhost gate. Null when it came through a proxy and no entrance is configured: no gate is asked
 * then (the guard in src/start.ts has refused it already).
 */
export function routeOf(
  request: Request,
  entrance: PublicEntrance | null = servedEntrance(),
  peer: string | undefined = peerOf(request),
): GateRoute | null {
  if (!cameThroughEntrance({ method: request.method, headers: request.headers, peer }, entrance))
    return localRoute()
  return entrance ? publicRoute(entrance) : null
}

/** An X-Test-Actor value, `human:<name>` or `agent:<name>`; null when it is neither. */
export function parseTestActor(value: string): Caller | null {
  const m = /^(human|agent):(.*)$/.exec(value.trim())
  const name = m?.[2]!.trim()
  if (!m || !name || name.length > 80) return null
  return { name, kind: m[1] as ActorKind }
}

let lastSeenHuman: string | undefined
/** Who the human is while the gate is off: the configured name, else the human the board last saw. */
export function offHuman(auth: AuthMode): string {
  return auth.human ?? (lastSeenHuman ??= lastHuman() ?? 'human')
}

/**
 * Who is calling and what they are, or null when nobody is signed in (or the gate is unreachable, or
 * in test a malformed X-Test-Actor). With the gate on, how they got in says what they are: a gate
 * token is an agent, the browser's passkey session is a human. The gate asked is `route`'s, by default
 * the one the request answers to (routeOf).
 */
export async function callerOf(
  request: Request,
  auth: AuthMode = authMode(),
  route?: GateRoute | null,
): Promise<Caller | null> {
  if (auth.boardEnv === 'test') {
    const header = request.headers.get(TEST_ACTOR_HEADER)
    return header === null ? { name: offHuman(auth), kind: 'human' } : parseTestActor(header)
  }
  if (auth.off) return { name: offHuman(auth), kind: 'human' }
  const gate = route === undefined ? routeOf(request) : route
  return gate ? gateCaller(gate.authUrl, request.headers) : null
}

/** Resolve who is calling, or null when they are not signed in, and remember how they signed in. */
export async function authenticate(request: Request, route?: GateRoute | null): Promise<string | null> {
  const caller = await callerOf(request, authMode(), route)
  if (caller) noteActor(caller.name, caller.kind)
  return caller?.name ?? null
}

/**
 * An agent, as opposed to the human: a gate token rather than the browser's passkey session, or in
 * test an `agent:` X-Test-Actor. In development with the gate off nobody is.
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

/**
 * To the login of the gate the request answers to, and back to the same page on the origin the browser
 * used: GATE_URL and BOARD_URL on this machine, PUBLIC_GATE_URL and PUBLIC_ORIGIN through the entrance.
 */
export function loginRedirect(request: Request, route: GateRoute = localRoute()): Response {
  const url = new URL(request.url)
  return Response.redirect(loginLocation(route, `${url.pathname}${url.search}`), 302)
}

export function isBrowserNavigation(request: Request): boolean {
  return wantsHtml(request.method, request.headers.get('accept'))
}
