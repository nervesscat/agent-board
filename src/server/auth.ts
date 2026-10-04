import { type ActorKind, lastHuman, noteActor } from './actors'
import { type AuthMode, authMode, config } from './config'

/**
 * passkey-gate is the only identity source. Every request is answered by GATE_URL/auth exactly as
 * Traefik's forwardAuth would ask it: the browser's cookie or an agent's `Bearer gate_…` token goes
 * through unchanged, and the gate's X-Gate-Device header (device or token name) becomes the actor.
 *
 * Outside production the gate can be off (config.ts, README "Test mode"): in development with
 * AUTH=off every request is the human; in test the X-Test-Actor header says who calls, and a request
 * without it is the human. In production and development that header is never read.
 */

const CACHE_MS = 60_000
const cache = new Map<string, { actor: string | null; until: number }>()
const actors = new WeakMap<Request, string>()

export const TEST_ACTOR_HEADER = 'x-test-actor'

export interface Caller {
  name: string
  kind: ActorKind
}

async function askGate(header: string, value: string): Promise<string | null> {
  const key = `${header}:${value}`
  const hit = cache.get(key)
  if (hit && hit.until > Date.now()) return hit.actor
  let actor: string | null = null
  try {
    const res = await fetch(`${config.gateUrl}/auth`, {
      headers: { [header]: value, accept: 'application/json' },
    })
    if (res.ok) actor = res.headers.get('x-gate-device') || 'unknown'
  } catch (err) {
    console.error(`gate unreachable at ${config.gateUrl}:`, err instanceof Error ? err.message : err)
    return null
  }
  cache.set(key, { actor, until: Date.now() + CACHE_MS })
  return actor
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

const isBearer = (request: Request) =>
  request.headers.get('authorization')?.toLowerCase().startsWith('bearer ') ?? false

/**
 * Who is calling and what they are, or null when nobody is signed in (or the gate is unreachable, or
 * in test a malformed X-Test-Actor). With the gate on, how they got in says what they are: a gate
 * token is an agent, the browser's passkey session is a human.
 */
export async function callerOf(request: Request, auth: AuthMode = authMode()): Promise<Caller | null> {
  if (auth.boardEnv === 'test') {
    const header = request.headers.get(TEST_ACTOR_HEADER)
    return header === null ? { name: offHuman(auth), kind: 'human' } : parseTestActor(header)
  }
  if (auth.off) return { name: offHuman(auth), kind: 'human' }
  const authorization = request.headers.get('authorization')
  const cookie = request.headers.get('cookie')
  const [name, kind] =
    authorization && isBearer(request)
      ? [await askGate('authorization', authorization), 'agent' as const]
      : cookie?.includes('gate_session=')
        ? [await askGate('cookie', cookie), 'human' as const]
        : [null, null]
  return name && kind ? { name, kind } : null
}

/** Resolve who is calling, or null when they are not signed in, and remember how they signed in. */
export async function authenticate(request: Request): Promise<string | null> {
  const caller = await callerOf(request)
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
  return !auth.off && isBearer(request)
}

export function rememberActor(request: Request, actor: string) {
  actors.set(request, actor)
}

/** The actor the middleware attached to this request. Handlers only run after it, so it is always there. */
export function actorOf(request: Request): string {
  return actors.get(request) ?? 'unknown'
}

export function loginRedirect(request: Request): Response {
  const url = new URL(request.url)
  const rd = `${config.boardUrl}${url.pathname}${url.search}`
  return Response.redirect(`${config.gateUrl}/login?rd=${encodeURIComponent(rd)}`, 302)
}

export function isBrowserNavigation(request: Request): boolean {
  return request.method === 'GET' && (request.headers.get('accept') || '').includes('text/html')
}
