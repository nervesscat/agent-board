import {
  type AuthMode,
  authMode,
  config,
  expandPath,
  type PublicEntrance,
  readAuthMode,
  readPort,
  readServedEntrance,
  servedEntrance,
} from './config.ts'
import { isBearer, sessionCookieName } from './credentials.ts'

/**
 * The guard in front of every request, before anyone's sign-in is checked: pages, /api/* and /api/mcp
 * (src/start.ts), and under `vite dev` Vite's own files and its hot-reload socket (devEntrance.ts).
 * README: "Using it from other devices".
 *
 * - Tailscale Funnel (the public internet) is refused, in every mode, signed in or not.
 * - The Host must be loopback (localhost, 127.0.0.1 or [::1], any port) or the configured public host.
 * - A request for the public host, or one a proxy on this machine forwarded (`tailscale serve` adds
 *   X-Forwarded-* and, for a tailnet user, Tailscale-User-*), came through the tailnet entrance: refused
 *   while sign-in is off or no entrance is configured, else signed in on the public origin alone (its
 *   own passkeys and sessions). Those headers count only from a loopback peer: from any other they are
 *   ignored, as if absent.
 * - A write that carries the board's session cookie must come from one of the board's own origins: a
 *   page on another port of localhost gets that cookie too.
 *
 * On the board's own server it runs twice, with one verdict: in src/server.ts, before the framework
 * answers anything (it turns a target starting with `//` into a 308 to the URL it makes of it, Host and
 * all, ahead of its request middleware), and again in the sign-in middleware (auth.ts `admit`).
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
  /** Sign-in is off (test, development with AUTH=off): nothing is answered through a proxy. */
  authOff: boolean
  /** The board's own port (PORT): its loopback origins are http://localhost:<port> and the like. */
  port: number
  /** The tailnet entrance it serves: null when none is configured, and always while sign-in is off. */
  entrance: PublicEntrance | null
  /** DATA_DIR: where the board's database is, which `vite dev` reads sessions and tokens from. */
  dataDir: string
}

/** Allowed, with the entrance it came through (null: straight to the board on this machine), or refused. */
export type Verdict =
  | { allow: true; entrance: PublicEntrance | null }
  | { allow: false; status: number; error: string }

/**
 * The guard's settings from the board's environment, as config.ts reads them, and the entrance the board's
 * database saved (`stored`, null when none). Throws StartupError.
 */
export function guardConfig(
  e: Record<string, string | undefined>,
  stored: PublicEntrance | null = null,
): GuardConfig {
  return {
    authOff: readAuthMode(e).off,
    port: readPort(e),
    entrance: readServedEntrance(e, stored),
    dataDir: expandPath(e.DATA_DIR || './data'),
  }
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

/** The origins of the board's own pages: loopback on its own port, and the public origin. */
export function boardOrigins(cfg: GuardConfig): string[] {
  const own = ['localhost', '127.0.0.1', '[::1]'].map((host) => `http://${host}:${cfg.port}`)
  return cfg.entrance ? [...own, cfg.entrance.origin] : own
}

const READS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * A write a page of another origin may have sent with the human's session: it carries the board's
 * session cookie and an Origin that is not one of the board's. No Origin (agents, curl) or a token is
 * not one.
 */
function crossSiteWrite(req: GuardRequest, cfg: GuardConfig): string | null {
  if (READS.has(req.method.toUpperCase())) return null
  const origin = req.headers.get('origin')
  if (origin === null || isBearer(req.headers.get('authorization'))) return null
  if (!(req.headers.get('cookie') ?? '').includes(`${sessionCookieName(cfg.port)}=`)) return null
  return boardOrigins(cfg).includes(origin) ? null : origin
}

const refuse = (status: number, error: string): Verdict => ({ allow: false, status, error })

/** The address the request's connection came from, where the server can tell (srvx's Node request). */
export function peerOf(request: Request): string | undefined {
  type NodeRequest = { runtime?: { node?: { req?: { socket?: { remoteAddress?: string } } } } }
  return (request as NodeRequest).runtime?.node?.req?.socket?.remoteAddress
}

/** The guard on a request to the board's own server, with the settings this process runs with. */
export function guardBoardRequest(
  request: Request,
  auth: AuthMode = authMode(),
  entrance: PublicEntrance | null = servedEntrance(),
): Verdict {
  return guardRequest(
    { method: request.method, headers: request.headers, peer: peerOf(request) },
    { authOff: auth.off, port: config.port, entrance, dataDir: config.dataDir },
  )
}

/** A refusal's answer: its status, and the reason as JSON. */
export const refusalResponse = (verdict: { status: number; error: string }) =>
  Response.json({ error: verdict.error }, { status: verdict.status })

export function guardRequest(req: GuardRequest, cfg: GuardConfig): Verdict {
  if (req.headers.get('tailscale-funnel-request') !== null)
    return refuse(
      403,
      'Tailscale Funnel is refused: the board answers on its tailnet only, never the internet',
    )
  const host = req.headers.get('host')
  if (!hostOf(host, cfg.entrance)) {
    // With no entrance set (none saved, cleared, or sign-in off), a foreign host is the case the message names.
    const named = JSON.stringify(host ?? '')
    return refuse(
      403,
      cfg.entrance
        ? `the board does not answer for the host ${named}`
        : `no tailnet entrance is configured (PUBLIC_ORIGIN): the board answers on this machine only, not the host ${named}`,
    )
  }
  const through = cameThroughEntrance(req, cfg.entrance)
  if (through && cfg.authOff)
    return refuse(403, 'sign-in is off: this board answers on this machine only, never through a proxy')
  if (through && !cfg.entrance)
    return refuse(
      403,
      'no tailnet entrance is configured (PUBLIC_ORIGIN): the board answers on this machine only',
    )
  const foreign = crossSiteWrite(req, cfg)
  if (foreign !== null)
    return refuse(
      403,
      `a write with the board's session cookie from ${JSON.stringify(foreign)}, not one of the board's origins`,
    )
  return { allow: true, entrance: through ? cfg.entrance : null }
}

/**
 * Where a request signs in: the WebAuthn RP ID its passkeys are bound to, and the origin its browser
 * uses. On this machine that is localhost (WebAuthn takes no IP address, so 127.0.0.1 and [::1] are sent
 * there); through the tailnet entrance it is the public host and PUBLIC_ORIGIN.
 */
export interface SignInSite {
  rpId: string
  origin: string
}

/** The RP ID of the passkeys made on this machine. */
export const LOCAL_RP_ID = 'localhost'

export const localSite = (port: number): SignInSite => ({
  rpId: LOCAL_RP_ID,
  origin: `http://${LOCAL_RP_ID}:${port}`,
})

export const publicSite = (entrance: PublicEntrance): SignInSite => ({
  rpId: entrance.host,
  origin: entrance.origin,
})

/** The pages that sign a browser in, served without a session (authPages.ts). */
export const SIGN_IN_PAGES = new Set(['/setup', '/login', '/enroll'])

/** The endpoints those pages call before anyone is signed in (authApi.ts). */
export const SIGN_IN_API = new Set([
  '/api/auth/setup/options',
  '/api/auth/setup/verify',
  '/api/auth/login/options',
  '/api/auth/login/verify',
  '/api/auth/enrol/options',
  '/api/auth/enrol/verify',
  '/api/auth/logout',
])

/** A path answered without a session, on either origin: the sign-in pages and their endpoints. */
export const isSignInPath = (pathname: string) => SIGN_IN_PAGES.has(pathname) || SIGN_IN_API.has(pathname)

/**
 * The board's own login, on the origin the browser used (a relative Location: no forwarded host ever
 * names it), coming back to the same page after.
 */
export const loginLocation = (pathAndSearch: string) => `/login?next=${encodeURIComponent(pathAndSearch)}`

/** A page the browser navigates to, as opposed to an API call: the one a login redirect helps. */
export const wantsHtml = (method: string | undefined, accept: string | null) =>
  method === 'GET' && (accept || '').includes('text/html')
