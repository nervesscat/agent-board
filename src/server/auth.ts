import { config } from './config'

/**
 * passkey-gate is the only identity source. Every request is answered by GATE_URL/auth exactly as
 * Traefik's forwardAuth would ask it: the browser's cookie or an agent's `Bearer gate_…` token goes
 * through unchanged, and the gate's X-Gate-Device header (device or token name) becomes the actor.
 */

const CACHE_MS = 60_000
const cache = new Map<string, { actor: string | null; until: number }>()
const actors = new WeakMap<Request, string>()

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

/** Resolve who is calling, or null when the gate says no (or is unreachable). */
export async function authenticate(request: Request): Promise<string | null> {
  const auth = request.headers.get('authorization')
  if (auth?.toLowerCase().startsWith('bearer ')) return askGate('authorization', auth)
  const cookie = request.headers.get('cookie')
  if (cookie?.includes('gate_session=')) return askGate('cookie', cookie)
  return null
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
