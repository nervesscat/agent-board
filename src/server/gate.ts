import { isBearer } from './entrance.ts'

/**
 * Asking a passkey-gate who a request is, exactly as Traefik's forwardAuth would: the browser's cookie or
 * an agent's `Bearer gate_…` token goes to <gate>/auth unchanged, and its X-Gate-Device header (device or
 * token name) is the caller. There are two gates once the tailnet entrance is on (README: "Using it from
 * other devices"), each with its own passkeys, sessions and tokens: an answer is cached for a minute
 * under the gate that gave it, and never taken for a request the other gate answers.
 *
 * Nothing here reaches the database: `vite dev` asks the public gate too, in its own process, before it
 * serves its files through the entrance (devEntrance.ts).
 */

const CACHE_MS = 60_000
/** Answers kept at most: expired ones go first, then the oldest, so made-up cookies cannot grow it. */
export const CACHE_MAX = 1000
const cache = new Map<string, { actor: string | null; until: number }>()

function remember(key: string, actor: string | null) {
  const now = Date.now()
  if (!cache.has(key) && cache.size >= CACHE_MAX) {
    for (const [k, hit] of cache) if (hit.until <= now) cache.delete(k)
    // A Map keeps insertion order: the first key is the oldest answer.
    while (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!)
  }
  cache.set(key, { actor, until: now + CACHE_MS })
}

/** The name the gate at `gateUrl` gives the caller, or null when it says no or cannot be reached. */
export async function askGate(
  gateUrl: string,
  header: 'authorization' | 'cookie',
  value: string,
): Promise<string | null> {
  const key = `${gateUrl} ${header}:${value}`
  const hit = cache.get(key)
  if (hit && hit.until > Date.now()) return hit.actor
  let actor: string | null = null
  try {
    const res = await fetch(`${gateUrl}/auth`, { headers: { [header]: value, accept: 'application/json' } })
    if (res.ok) actor = res.headers.get('x-gate-device') || 'unknown'
  } catch (err) {
    console.error(`gate unreachable at ${gateUrl}:`, err instanceof Error ? err.message : err)
    return null
  }
  remember(key, actor)
  return actor
}

/**
 * Who the gate at `gateUrl` says is calling: a token is an agent, the browser's passkey session the
 * human. Null without either, or when the gate refuses them. Nothing else of the request is shown to it.
 */
export async function gateCaller(
  gateUrl: string,
  headers: { get(name: string): string | null },
): Promise<{ name: string; kind: 'agent' | 'human' } | null> {
  const authorization = headers.get('authorization')
  const cookie = headers.get('cookie')
  const [name, kind] =
    authorization && isBearer(authorization)
      ? [await askGate(gateUrl, 'authorization', authorization), 'agent' as const]
      : cookie?.includes('gate_session=')
        ? [await askGate(gateUrl, 'cookie', cookie), 'human' as const]
        : [null, null]
  return name && kind ? { name, kind } : null
}
