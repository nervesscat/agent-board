import { type PublicEntrance, readAuthMode, readPort, readServedEntrance } from './config.ts'

/**
 * The guard in front of every request, before the gate is asked anything: pages, /api/* and /api/mcp
 * (src/start.ts), and under `vite dev` Vite's own files and its hot-reload socket (devEntrance.ts).
 * README: "Using it from other devices".
 *
 * - Tailscale Funnel (the public internet) is refused, in every mode, signed in or not.
 * - The Host must be loopback (localhost, 127.0.0.1 or [::1], any port) or the configured public host.
 * - A request for the public host, or one a proxy on this machine forwarded (`tailscale serve` adds
 *   X-Forwarded-* and, for a tailnet user, Tailscale-User-*), came through the tailnet entrance: refused
 *   while the gate is off or no entrance is configured, else answered by the public gate alone. Those
 *   headers count only from a loopback peer: from any other they are ignored, as if absent.
 * - A write that carries the gate's session cookie must come from one of the board's own origins: a
 *   page on another port of localhost gets that cookie too.
 */

/** What the guard reads of a request's headers: web Headers fit, and so does devEntrance.ts's view of Node's. */
export interface HeaderLookup {
  get(name: string): string | null
  /** Every header name, lower case. */
  keys(): Iterable<string>
}

export interface GuardRequest {
  method: string
  headers: HeaderLookup
  /** The address the connection came from; undefined when the server cannot tell (counted as loopback). */
  peer: string | null | undefined
}

export interface GuardConfig {
  /** The gate is off (test, development with AUTH=off): nothing is answered through a proxy. */
  gateOff: boolean
  /** The board's own port (PORT): its loopback origins are http://localhost:<port> and the like. */
  port: number
  /** The tailnet entrance it serves: null when none is configured, and always while the gate is off. */
  entrance: PublicEntrance | null
}

/** Allowed, with the entrance it came through (null: straight to the board on this machine), or refused. */
export type Verdict =
  | { allow: true; entrance: PublicEntrance | null }
  | { allow: false; status: number; error: string }

/** The guard's settings from the board's environment, as config.ts reads them. Throws StartupError. */
export function guardConfig(e: Record<string, string | undefined>): GuardConfig {
  return { gateOff: readAuthMode(e).off, port: readPort(e), entrance: readServedEntrance(e) }
}

/** A loopback address, or none known: then forwarded headers count, which only ever refuses more. */
export function isLoopbackPeer(peer: string | null | undefined): boolean {
  if (!peer) return true
  const p = peer.toLowerCase()
  return p === '::1' || p.startsWith('127.') || p.startsWith('::ffff:127.')
}

/** A header a proxy adds: X-Forwarded-*, Forwarded, X-Real-IP, and Tailscale's own Tailscale-*. */
export function isForwardingHeader(name: string): boolean {
  const n = name.toLowerCase()
  return n === 'forwarded' || n === 'x-real-ip' || n.startsWith('x-forwarded-') || n.startsWith('tailscale-')
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
// A Host header: a name or an [IPv6] literal, and an optional port. Two Host headers never match.
const HOST = /^(\[[0-9a-f:.]+\]|[^\s:[\]]+)(?::(\d{1,5}))?$/i

/** What a Host header names: loopback (any port), the public host (no port, or 443), or neither. */
export function hostOf(host: string | null, entrance: PublicEntrance | null): 'loopback' | 'public' | null {
  const m = HOST.exec(host ?? '')
  if (!m) return null
  const name = m[1]!.toLowerCase()
  if (LOOPBACK_HOSTS.has(name)) return 'loopback'
  if (entrance && name === entrance.host && (m[2] === undefined || m[2] === '443')) return 'public'
  return null
}

/** For the public host, or forwarded by a proxy on this machine: what `tailscale serve` sends. */
export function cameThroughEntrance(req: GuardRequest, entrance: PublicEntrance | null): boolean {
  if (hostOf(req.headers.get('host'), entrance) === 'public') return true
  if (!isLoopbackPeer(req.peer)) return false
  for (const name of req.headers.keys()) if (isForwardingHeader(name)) return true
  return false
}

export const isBearer = (authorization: string | null) =>
  authorization?.toLowerCase().startsWith('bearer ') ?? false

/** The origins of the board's own pages: loopback on its own port, and the public origin. */
export function boardOrigins(cfg: GuardConfig): string[] {
  const own = ['localhost', '127.0.0.1', '[::1]'].map((host) => `http://${host}:${cfg.port}`)
  return cfg.entrance ? [...own, cfg.entrance.origin] : own
}

const READS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * A write a page of another origin may have sent with the human's session: it carries the gate's
 * cookie and an Origin that is not one of the board's. No Origin (agents, curl) or a token is not one.
 */
function crossSiteWrite(req: GuardRequest, cfg: GuardConfig): string | null {
  if (READS.has(req.method.toUpperCase())) return null
  const origin = req.headers.get('origin')
  if (origin === null || isBearer(req.headers.get('authorization'))) return null
  if (!(req.headers.get('cookie') ?? '').includes('gate_session=')) return null
  return boardOrigins(cfg).includes(origin) ? null : origin
}

const refuse = (status: number, error: string): Verdict => ({ allow: false, status, error })

export function guardRequest(req: GuardRequest, cfg: GuardConfig): Verdict {
  if (req.headers.get('tailscale-funnel-request') !== null)
    return refuse(
      403,
      'Tailscale Funnel is refused: the board answers on its tailnet only, never the internet',
    )
  const host = req.headers.get('host')
  if (!hostOf(host, cfg.entrance))
    return refuse(403, `the board does not answer for the host ${JSON.stringify(host ?? '')}`)
  const through = cameThroughEntrance(req, cfg.entrance)
  if (through && cfg.gateOff)
    return refuse(403, 'the gate is off: this board answers on this machine only, never through a proxy')
  if (through && !cfg.entrance)
    return refuse(
      403,
      'no tailnet entrance is configured (PUBLIC_ORIGIN): the board answers on this machine only',
    )
  const foreign = crossSiteWrite(req, cfg)
  if (foreign !== null)
    return refuse(
      403,
      `a write with the gate's cookie from ${JSON.stringify(foreign)}, not one of the board's origins`,
    )
  return { allow: true, entrance: through ? cfg.entrance : null }
}

/** Where a request signs in, and where the board asks who it is. */
export interface GateRoute {
  /** The gate as the browser reaches it: its /login. */
  loginUrl: string
  /** The gate as the board reaches it: its /auth. */
  authUrl: string
  /** The board's origin as the browser used it: where the login sends it back (`rd`). */
  boardUrl: string
}

/** The public gate: the login and the origin on the tailnet name, /auth on this machine. */
export const publicRoute = (entrance: PublicEntrance): GateRoute => ({
  loginUrl: entrance.gateUrl,
  authUrl: entrance.gateAuthUrl,
  boardUrl: entrance.origin,
})

/** The gate's login, sending the browser back to the same page on the board's origin it used. */
export const loginLocation = (route: GateRoute, pathAndSearch: string) =>
  `${route.loginUrl}/login?rd=${encodeURIComponent(`${route.boardUrl}${pathAndSearch}`)}`

/** A page the browser navigates to, as opposed to an API call: the one a login redirect helps. */
export const wantsHtml = (method: string | undefined, accept: string | null) =>
  method === 'GET' && (accept || '').includes('text/html')
