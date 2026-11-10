import http, { type IncomingMessage, STATUS_CODES } from 'node:http'
import { type Duplex, Readable } from 'node:stream'

import { eq } from 'drizzle-orm'

import { db, schema } from '#/db'
import { siteOf } from './auth'
import { type AuthMode, authMode, config, type PublicEntrance, servedEntrance } from './config'
import { agentTokenOf, bearerToken, isBearer, readCookie, sessionCookieName, sessionOf } from './credentials'
import { guardRequest, type HeaderLookup, isForwardingHeader, type SignInSite } from './entrance'
import { HttpError } from './http'
import { type Loopback, listeningAddresses, loopbackOf } from './listeners'
import { previewRunOf } from './managedPreview'
import {
  mintPreviewLink,
  PREVIEW_COOKIE_MAX_AGE_S,
  type Principal,
  signPreviewValue,
  verifyPreviewValue,
} from './previewLink'
import { PREVIEW_PATH, isPreviewPath, previewCookieName, previewPathOf } from './previewPaths'
import { type RunState, runState, runStatus } from './runs'

/**
 * The board's preview proxy: a running preview (a managed run's loopback port) at `/p/<workspaceId>/<runId>/`
 * on the board's own origin, so a cloud agent and other devices can open it, its assets, API calls and event
 * streams included. README: "Cloud agents", "Previews".
 *
 * - Nothing reaches the preview without the board's sign-in: a passkey session of the origin the request came
 *   through, an agent token whose name is a persona of the preview's project only, or a link the board minted
 *   for this run and principal (previewLink.ts). Unauthenticated requests get 401 JSON, never the login page.
 *   The guard (entrance.ts) runs before this, in server.ts and devEntrance.ts, so a Funnel request or a foreign
 *   Host never gets here.
 * - The target is `127.0.0.1:<port>` where the port is the run state's, never anything from the request. The
 *   preview's port must listen on loopback only (checked now, each time, through the listener lookup of
 *   linkPreview.ts): otherwise 502, and the preview is not reached. The request goes on under the run's
 *   prefix, unchanged: a preview built for that path (the board's own Preview, vite.config.ts) serves its
 *   base there, and its own `/p/…` paths are its own, not this proxy's again.
 * - Board credentials never reach the preview: no Authorization, no board session or preview cookie. Its own
 *   cookies are rewritten to the run's path; its Location headers that name the loopback address or a root
 *   path are rewritten to the prefix. Every other body streams byte for byte, except an HTML page, which gets
 *   one small script (`runtimeScript`) that prefixes root-absolute fetch, XMLHttpRequest, EventSource and
 *   WebSocket URLs.
 * - Sign-in off (outside production, see config.ts): every `/p/` path answers 404, and nothing is proxied.
 *
 * A WebSocket upgrade under the same prefix is proxied too (`handlePreviewUpgrade`), through the same
 * sign-in gate and the same loopback check, before the handshake passes: its `Origin` must name the board's
 * own entrance (a browser on another site can never open one against a preview), and the preview sees its
 * own origin instead. A socket is closed when its run stops.
 */

export { isPreviewPath, PREVIEW_PATH } from './previewPaths'

/** The query parameter a link carries; the proxy takes it off the path it forwards. */
const LINK_PARAM = 'pl'
/** How long the preview may take to send its headers before the request is answered 502. */
export const UPSTREAM_TIMEOUT_MS = 10_000
/** How long an answer about which addresses a port listens on is kept. */
const LISTEN_TTL_MS = 2_000

export interface ProxyDeps {
  now: () => number
  auth: () => AuthMode
  entrance: () => PublicEntrance | null
  runOf: (workspaceId: number, runId: number) => RunState | null
  /** The run's state as a proxied socket needs it, without the log tail `runOf` reads for every request. */
  statusOf: (workspaceId: number, runId: number) => Pick<RunState, 'status' | 'port' | 'runningAt'> | null
  /** The addresses the port listens on, loopback or not, for the run that holds the port. */
  listening: (port: number, run: RunRef) => Promise<string[]>
  projectOf: (workspaceId: number) => number | null
  /** The run a workspace's link is for: its repo's preview run. */
  previewRunId: (workspaceId: number) => number | null
  /** How long the preview may take to send its headers before the request is answered 502. */
  upstreamMs: number
}

/** The run a link or a request is for, and the start it is of: a restart is a new start (a new runningAt). */
interface RunRef {
  workspaceId: number
  runId: number
  runningAt: string | null
}

/** The last answer per run, for the port and the start it was given for: never another run's, nor a restart's. */
const listenCache = new Map<
  string,
  { port: number; runningAt: string | null; at: number; addresses: string[] }
>()

export async function listeningNow(port: number, run: RunRef): Promise<string[]> {
  const key = `${run.workspaceId}:${run.runId}`
  const hit = listenCache.get(key)
  if (hit && hit.port === port && hit.runningAt === run.runningAt && Date.now() - hit.at < LISTEN_TTL_MS)
    return hit.addresses
  const addresses = await listeningAddresses(port)
  listenCache.set(key, { port, runningAt: run.runningAt, at: Date.now(), addresses })
  return addresses
}

/** The project a workspace's run belongs to: its ticket's. */
export function projectOfWorkspace(workspaceId: number): number | null {
  const row = db
    .select({ projectId: schema.tickets.projectId })
    .from(schema.workspaces)
    .innerJoin(schema.tickets, eq(schema.workspaces.ticketId, schema.tickets.id))
    .where(eq(schema.workspaces.id, workspaceId))
    .get()
  return row?.projectId ?? null
}

const DEFAULTS: ProxyDeps = {
  now: () => Date.now(),
  auth: () => authMode(),
  entrance: () => servedEntrance(),
  runOf: (workspaceId, runId) => runState(workspaceId, runId),
  statusOf: (workspaceId, runId) => runStatus(workspaceId, runId),
  listening: listeningNow,
  projectOf: projectOfWorkspace,
  previewRunId: (workspaceId) => previewRunOf(workspaceId)?.id ?? null,
  upstreamMs: UPSTREAM_TIMEOUT_MS,
}

const json = (status: number, error: string) => Response.json({ error }, { status })

const SIGN_IN_NEEDED =
  "sign in to the board, or present an agent token of the preview's project (the board's link for a browser without headers)"

/** The projects that have an agent (persona) of this name. */
function projectsNamed(name: string): number[] {
  const rows = db.$client
    .prepare('select distinct project_id as projectId from agents where lower(name) = lower(?)')
    .all(name) as { projectId: number }[]
  return rows.map((r) => r.projectId)
}

/**
 * The agent rule (SPEC "Project rule for agents"): a token whose name is a persona of exactly one project, and
 * that project is the preview's. Another project's, several projects' (ambiguous) or none (an orchestrator
 * token not named as a persona) are refused.
 */
export function agentMayView(name: string, projectId: number | null): boolean {
  const projects = projectsNamed(name)
  return projectId !== null && projects.length === 1 && projects[0] === projectId
}

type Standing = 'ok' | 'signed-out' | 'other-project'

/**
 * Whether the principal still stands: a session of the human not signed out or expired, an agent token not
 * revoked or expired and allowed on the preview's project. Checked on every request, a link's too.
 */
function standingOf(principal: Principal, workspaceId: number, now: Date, deps: ProxyDeps): Standing {
  const id = Number(principal.slice(1))
  if (principal[0] === 's') {
    const row = db.$client
      .prepare('select id from sessions where id = ? and expires_at > ?')
      .get(id, now.toISOString())
    return row ? 'ok' : 'signed-out'
  }
  const token = db.$client
    .prepare('select name, revoked_at as revokedAt, expires_at as expiresAt from agent_tokens where id = ?')
    .get(id) as { name: string; revokedAt: string | null; expiresAt: string } | undefined
  if (!token || token.revokedAt || token.expiresAt <= now.toISOString()) return 'signed-out'
  return agentMayView(token.name, deps.projectOf(workspaceId)) ? 'ok' : 'other-project'
}

/** The principal a request's board credential is, checked as the board checks it; null when none is good. */
function credentialOf(request: Request, site: SignInSite | null, now: Date): Principal | null {
  const authorization = request.headers.get('authorization')
  if (isBearer(authorization)) {
    const token = bearerToken(authorization)
    const hit = token ? agentTokenOf(db.$client, token, now) : null
    return hit ? `t${hit.id}` : null
  }
  const cookie = readCookie(request.headers.get('cookie'), sessionCookieName(config.port))
  if (!site || !cookie) return null
  const hit = sessionOf(db.$client, cookie, site.rpId, now)
  return hit ? `s${hit.id}` : null
}

/** The principal of a request for minting a link: the caller's own credential, or null. */
export function principalOf(request: Request, now = new Date()): Principal | null {
  return credentialOf(request, siteOf(request), now)
}

interface Who {
  principal: Principal
  /** Redeemed from a link in this request: the cookie is set, and the request redirects. */
  redeem: boolean
}

/**
 * Who the request is for this run: a Bearer token (a bare or unknown one is refused whatever cookie comes
 * with it), else a link being redeemed, else the session of the origin, else the preview cookie a redeemed
 * link set. Null when none of them is good.
 *
 * A link is redeemed only on the run's own path (`rest` is '/', the path a link names) and only when it is
 * good. Any other `pl` is the preview's own query parameter: the request goes on to the usual checks and
 * the preview gets its query as it came.
 */
function whoIs(
  request: Request,
  url: URL,
  site: SignInSite | null,
  run: { workspaceId: number; runId: number; runningAt: string | null; rest: string },
  now: Date,
): Who | null {
  if (isBearer(request.headers.get('authorization'))) {
    const principal = credentialOf(request, site, now)
    return principal ? { principal, redeem: false } : null
  }
  const readsOnly = request.method === 'GET' || request.method === 'HEAD'
  const link = url.searchParams.get(LINK_PARAM)
  if (link !== null && readsOnly && run.rest === '/') {
    const principal = verifyPreviewValue(link, run.workspaceId, run.runId, run.runningAt, now.getTime())
    if (principal) return { principal, redeem: true }
  }
  const principal = credentialOf(request, site, now)
  if (principal) return { principal, redeem: false }
  const cookie = readCookie(request.headers.get('cookie'), previewCookieName(run.workspaceId, run.runId))
  const own = verifyPreviewValue(cookie, run.workspaceId, run.runId, run.runningAt, now.getTime())
  return own ? { principal: own, redeem: false } : null
}

/**
 * What the sign-in gate let through for a preview path: the run the path names, the origin it came through,
 * and who the request is. The HTTP proxy and the WebSocket upgrade both start from it, so both ask the same
 * questions in the same order.
 */
interface PreviewGate {
  workspaceId: number
  runId: number
  /** The path under the run's prefix, with its leading slash ('' for the prefix itself). */
  rest: string
  prefix: string
  state: RunState | null
  secure: boolean
  who: Who
}

type GateVerdict = { refusal: { status: number; error: string } } | { gate: PreviewGate }

/**
 * The gate every proxied request passes before the board reaches a preview: sign-in on (404 when off), a
 * credential of this run's principal (401 otherwise), and that principal still standing for the preview's
 * project (403 for another project's agent). It reads the run state but does not decide that the run is
 * running, so a link is still redeemed for a run that is gone (the request then gets the run's own 404).
 */
function gateOf(
  request: Request,
  url: URL,
  m: RegExpExecArray,
  deps: ProxyDeps,
  peer: string | undefined,
  now: Date,
): GateVerdict {
  if (deps.auth().off)
    return { refusal: { status: 404, error: 'the preview proxy is off: sign-in is off on this board' } }
  const workspaceId = Number(m[1])
  const runId = Number(m[2])
  const rest = m[3] ?? ''
  const prefix = previewPathOf(workspaceId, runId)
  const state = deps.runOf(workspaceId, runId)
  const site = siteOf(request, deps.entrance(), peer)
  const who = whoIs(
    request,
    url,
    site,
    { workspaceId, runId, runningAt: state?.runningAt ?? null, rest },
    now,
  )
  if (!who) return { refusal: { status: 401, error: SIGN_IN_NEEDED } }
  const standing = standingOf(who.principal, workspaceId, now, deps)
  if (standing === 'signed-out') return { refusal: { status: 401, error: SIGN_IN_NEEDED } }
  if (standing === 'other-project')
    return {
      refusal: {
        status: 403,
        error: "this preview is for the agents of its project: the token's name is not one of its agents",
      },
    }
  return {
    gate: {
      workspaceId,
      runId,
      rest,
      prefix,
      state,
      secure: site?.origin.startsWith('https:') ?? false,
      who,
    },
  }
}

/** A query component decoded as a URL decodes it (`+` is a space); what cannot be decoded stays as it is. */
function decoded(part: string): string {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' '))
  } catch {
    return part
  }
}

/**
 * The raw query (with or without its `?`) minus the first `pl` pair whose value is the link, every other byte
 * as it came: a re-serialized query would turn `%20` into `+` and `%7E` into `~`.
 */
export function withoutLink(search: string, link: string): string {
  const parts = search.replace(/^\?/, '').split('&')
  const at = parts.findIndex((part) => {
    const eq = part.indexOf('=')
    return eq >= 0 && decoded(part.slice(0, eq)) === LINK_PARAM && decoded(part.slice(eq + 1)) === link
  })
  if (at >= 0) parts.splice(at, 1)
  return parts.join('&')
}

/** Headers a request carries on one connection only, never forwarded. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
])

/** The board's own request headers, which the preview never sees. */
const BOARD_HEADERS = new Set(['host', 'authorization', 'accept-encoding', 'x-test-actor', 'x-agent-name'])

/** The board's own cookies: its session's (`board_session_<port>`) and the previews' links' (`board_preview_…`). */
const BOARD_COOKIE = /^board_(session|preview)_/i

/** The Cookie header without the board's own cookies: its session's and the previews' links'. */
export function withoutBoardCookies(cookie: string): string {
  return cookie
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !BOARD_COOKIE.test(part))
    .join('; ')
}

/** The headers the preview gets: the caller's, minus the board's and forwarding, with its own host. */
export function upstreamHeaders(from: Headers, port: number): Record<string, string> {
  const out: Record<string, string> = {}
  from.forEach((value, name) => {
    if (HOP_BY_HOP.has(name) || BOARD_HEADERS.has(name) || isForwardingHeader(name)) return
    if (name === 'cookie') {
      const kept = withoutBoardCookies(value)
      if (kept) out.cookie = kept
      return
    }
    out[name] = value
  })
  // Identity encoding, so an HTML page can be read and given its script.
  out.host = `127.0.0.1:${port}`
  // No X-Forwarded-* to the preview: its own guard (sign-in off) refuses any request that carries them from
  // loopback as one that came through a proxy, so every proxied request would be refused there.
  return out
}

/**
 * A Set-Cookie of the preview, for the path it is served at: no Domain (it would name the loopback host),
 * the Path set to the run's prefix.
 */
export function rewriteSetCookie(value: string, prefix: string): string {
  const [pair, ...attrs] = value.split(';').map((part) => part.trim())
  const kept = attrs.filter((a) => !/^(domain|path)=/i.test(a))
  return [pair, ...kept, `Path=${prefix}`].join('; ')
}

/**
 * A URL as a browser reads it: the leading and trailing characters of 0x20 and below (spaces, control
 * characters) dropped, and the tabs and line breaks inside it.
 */
function browserURL(location: string): string {
  let from = 0
  let to = location.length
  while (from < to && location.charCodeAt(from) <= 0x20) from++
  while (to > from && location.charCodeAt(to - 1) <= 0x20) to--
  return location.slice(from, to).replace(/[\t\r\n]/g, '')
}

/** Whether a path (normalized as a browser reads it) is the run's prefix, with or without its trailing slash, or under it. */
function underPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix.slice(0, -1) || pathname.startsWith(prefix)
}

/** Whether a root-relative reference resolves to a path under the prefix (`/p/1/2/../../x` does not). */
function inPrefix(path: string, prefix: string): boolean {
  try {
    return underPrefix(new URL(path, `http://board.invalid${prefix}`).pathname, prefix)
  } catch {
    return false
  }
}

/**
 * A Location of the preview, for the path it is served at. Its loopback address on the run's port, or a
 * root path, goes into the prefix; a path already under the prefix stays as it is. An absolute target whose
 * origin is the request's own (`own`, from its Host and scheme) and whose path is under the prefix becomes
 * that path. Any other absolute or protocol-relative target (another host, another scheme, `//host`,
 * `/\\host`, which browsers read as `//host`) is refused: null, and the answer is 502, so the preview cannot
 * send a visitor elsewhere through the board. A relative one stays as it is.
 */
export function rewriteLocation(
  location: string,
  prefix: string,
  port: number,
  own: string | null = null,
): string | null {
  const url = browserURL(location)
  // Browsers read a backslash as a slash, so `/\\host` is protocol-relative too.
  if (/^[/\\]{2}/.test(url)) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    let target: URL
    try {
      target = new URL(url)
    } catch {
      return null
    }
    if (own !== null && target.origin === own && underPrefix(target.pathname, prefix))
      return target.pathname + target.search + target.hash
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
    const at = Number(target.port || (target.protocol === 'https:' ? 443 : 80))
    if (!/^https?:$/.test(target.protocol) || !local || at !== port) return null
    // A path already under the prefix (an app built with its base) is not prefixed twice.
    const path = underPrefix(target.pathname, prefix) ? target.pathname : prefix + target.pathname.slice(1)
    return path + target.search + target.hash
  }
  if (url.startsWith('/')) return inPrefix(url, prefix) ? location : prefix + url.slice(1)
  return location
}

/**
 * A Refresh header of the preview (`5; url=…`) with its target rewritten the same way; null when refused. A
 * header with a delay and no URL part is kept; any URL part, with or without `;`, `,` or `url=`, goes through
 * the Location rules, and a header with no delay is dropped.
 */
export function rewriteRefresh(
  value: string,
  prefix: string,
  port: number,
  own: string | null = null,
): string | null {
  const m = /^\s*(\d+(?:\.\d+)?)?([\s\S]*)$/.exec(value)
  if (!m) return null
  const delay = m[1] ?? ''
  const rest = m[2]!.replace(/^[\s;,]+/, '')
  if (rest === '') return value
  if (delay === '') return null
  // A quote is taken off each end on its own, matched or not: an unmatched one must not hide the target.
  const target = rest
    .replace(/^url\s*=\s*/i, '')
    .trim()
    .replace(/^['"]/, '')
    .replace(/['"]$/, '')
  if (target === '') return value
  const rewritten = rewriteLocation(target, prefix, port, own)
  return rewritten === null ? null : `${delay}; url=${rewritten}`
}

/**
 * The script an HTML page of the preview gets: root-absolute URLs its scripts open with fetch, XMLHttpRequest,
 * EventSource and WebSocket gain the prefix, so `/api/x` reaches `/p/<w>/<r>/api/x`. Changes nothing else.
 */
export function runtimeScript(prefix: string): string {
  return `(function (p) {
  function at(u) {
    return typeof u === 'string' && u.charAt(0) === '/' && u.charAt(1) !== '/' && u.indexOf(p) !== 0 ? p + u.slice(1) : u;
  }
  function abs(u) {
    try { var x = new URL(u, location.href); return x.origin === location.origin ? at(x.pathname + x.search + x.hash) : null; } catch (e) { return null; }
  }
  var f = window.fetch;
  if (f) window.fetch = function (input, init) {
    if (typeof input === 'string') input = at(input);
    else if (input instanceof URL) { var a = abs(input.href); if (a !== null && a !== input.pathname + input.search + input.hash) input = new URL(a, location.origin); }
    else if (typeof Request !== 'undefined' && input instanceof Request) {
      var b = abs(input.url);
      if (b !== null) {
        var o = { method: input.method, headers: input.headers, signal: input.signal, credentials: input.credentials, cache: input.cache, redirect: input.redirect, integrity: input.integrity, keepalive: input.keepalive, duplex: 'half' };
        if (input.mode !== 'navigate') o.mode = input.mode;
        if (input.method !== 'GET' && input.method !== 'HEAD') o.body = input.body;
        input = new Request(location.origin + b, o);
      }
    }
    return f.call(this, input, init);
  };
  var open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    if (typeof url === 'string') args[1] = at(url);
    return open.apply(this, args);
  };
  if (window.EventSource) {
    var ES = window.EventSource;
    var Wrapped = function (url, opts) { return new ES(at(url), opts); };
    Wrapped.prototype = ES.prototype;
    Wrapped.CONNECTING = ES.CONNECTING; Wrapped.OPEN = ES.OPEN; Wrapped.CLOSED = ES.CLOSED;
    window.EventSource = Wrapped;
  }
  function wsu(u) {
    if (typeof u !== 'string') return u;
    if (u.charAt(0) === '/' && u.charAt(1) !== '/') return at(u);
    try {
      var x = new URL(u, location.href);
      if ((x.protocol === 'ws:' || x.protocol === 'wss:') && x.host === location.host) return at(x.pathname + x.search + x.hash);
    } catch (e) {}
    return u;
  }
  if (window.WebSocket) {
    var WS = window.WebSocket;
    var WrappedWS = function (url, protocols) {
      return protocols === undefined ? new WS(wsu(url)) : new WS(wsu(url), protocols);
    };
    WrappedWS.prototype = WS.prototype;
    WrappedWS.CONNECTING = WS.CONNECTING; WrappedWS.OPEN = WS.OPEN; WrappedWS.CLOSING = WS.CLOSING; WrappedWS.CLOSED = WS.CLOSED;
    window.WebSocket = WrappedWS;
  }
})(${JSON.stringify(prefix)});`
}

/** The HTML with the runtime script in its head (or at the start of it, when it has none). */
export function injectRuntime(html: string, prefix: string): string {
  const script = `<script>${runtimeScript(prefix)}</script>`
  const head = html.search(/<\/head\s*>/i)
  if (head >= 0) return html.slice(0, head) + script + html.slice(head)
  return script + html
}

/** The upstream request, to the loopback address of the preview: its headers at once, then its body. */
function upstream(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers })
    // The no-answer clock starts once the request is sent whole: a slow upload is not a silent preview.
    let timer: NodeJS.Timeout | undefined
    const abort = () => req.destroy()
    signal.addEventListener('abort', abort, { once: true })
    req.once('finish', () => {
      timer = setTimeout(() => req.destroy(new Error('no answer')), timeoutMs)
    })
    req.on('response', (res) => {
      clearTimeout(timer)
      resolve(res)
    })
    req.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    req.on('close', () => signal.removeEventListener('abort', abort))
    if (body && method !== 'GET' && method !== 'HEAD') Readable.fromWeb(body as never).pipe(req)
    else req.end()
  })
}

/** The most of an HTML page the board reads to give it its script; more is refused with 502. */
export const HTML_CAP_BYTES = 5 * 1024 * 1024

/** The charset an HTML page declares: its Content-Type's, else a `<meta charset>` in its head; null when none. */
export function charsetOf(contentType: string, head: string): string | null {
  const fromHeader = /charset\s*=\s*["']?([^"';\s]+)/i.exec(contentType)?.[1]
  if (fromHeader) return fromHeader.toLowerCase()
  const meta = /<meta[^>]+charset\s*=\s*["']?\s*([^"'\s;>/]+)/i.exec(head)?.[1]
  return meta ? meta.toLowerCase() : null
}

/** A Content-Type with its charset set to `charset` (added when it names none). */
export function withCharset(contentType: string, charset: string): string {
  if (/charset\s*=/i.test(contentType))
    return contentType.replace(/charset\s*=\s*[^;]*/i, `charset=${charset}`)
  return `${contentType.replace(/;\s*$/, '')}; charset=${charset}`
}

/** The whole body, or null once it is more than `cap` bytes (the preview's answer is then dropped). */
async function readCapped(res: IncomingMessage, cap: number): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of res as AsyncIterable<Buffer>) {
    total += chunk.length
    if (total > cap) {
      res.destroy()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** The preview's answer as the board sends it: headers rewritten, the body as it is (HTML gets its script). */
async function answerOf(
  res: IncomingMessage,
  opts: { prefix: string; port: number; method: string; own: string | null },
): Promise<Response> {
  const status = res.statusCode ?? 502
  const headers = new Headers()
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue
    if (name === 'set-cookie') {
      // A cookie named as the board's own is dropped: a preview must not shadow the human's session cookie.
      for (const cookie of [value].flat()) {
        if (BOARD_COOKIE.test(cookie.trim())) continue
        headers.append('set-cookie', rewriteSetCookie(cookie, opts.prefix))
      }
    } else if (name === 'location') {
      const location = rewriteLocation(String(value), opts.prefix, opts.port, opts.own)
      if (location === null) {
        res.resume()
        return json(502, 'the preview redirects beyond itself: refused')
      }
      headers.set(name, location)
    } else if (name === 'refresh') {
      const refresh = rewriteRefresh(String(value), opts.prefix, opts.port, opts.own)
      if (refresh !== null) headers.set(name, refresh)
    } else {
      headers.set(name, [value].flat().join(', '))
    }
  }
  headers.set('referrer-policy', 'same-origin')
  if (opts.method === 'HEAD' || status === 204 || status === 304) {
    res.resume()
    return new Response(null, { status, headers })
  }
  const type = headers.get('content-type') ?? ''
  // Only an HTML page is read whole, so it can be given its script, and it is capped. Any other body streams
  // as the preview sends it, with no cap: an event stream stays open for as long as the preview keeps it.
  if (/^text\/html\b/i.test(type) && !headers.get('content-encoding')) {
    let bytes: Buffer | null
    try {
      bytes = await readCapped(res, HTML_CAP_BYTES)
    } catch {
      // The preview reset its connection mid-body, before any header went out: a clean 502.
      res.destroy()
      return json(502, 'the preview ended its answer early: refused')
    }
    if (!bytes) return json(502, 'the preview response is too large: refused')
    headers.delete('content-length')
    const charset = charsetOf(type, bytes.subarray(0, 1024).toString('latin1'))
    let decoder: TextDecoder
    try {
      decoder = new TextDecoder(charset ?? 'utf-8')
    } catch {
      // A charset the board cannot decode: the page goes through untouched, with no script.
      return new Response(new Uint8Array(bytes), { status, headers })
    }
    // The page is sent as UTF-8, and its header says so.
    headers.set('content-type', withCharset(type, 'utf-8'))
    return new Response(injectRuntime(decoder.decode(bytes), opts.prefix), { status, headers })
  }
  return new Response(Readable.toWeb(res) as unknown as ReadableStream, { status, headers })
}

/** The origin the browser sees the board at: the request's Host, with the scheme the browser used (`secure`). */
export function ownOriginOf(request: Request, url: URL, secure: boolean): string | null {
  const host = request.headers.get('host') ?? url.host
  try {
    return new URL(`${secure ? 'https' : 'http'}://${host}`).origin
  } catch {
    return null
  }
}

/**
 * The board's answer for `/p/<w>/<r>/...`, or null when the path is none of the proxy's. `peer` is the
 * connection's address when the caller knows it (the guard counts forwarded headers only from loopback).
 */
export async function servePreview(
  request: Request,
  opts: { peer?: string | undefined } = {},
  over: Partial<ProxyDeps> = {},
): Promise<Response | null> {
  const deps = { ...DEFAULTS, ...over }
  const url = new URL(request.url)
  // Under this build's own base (a preview of the board) every path is its own, whatever it looks like.
  if (!isPreviewPath(url.pathname)) return null
  const m = PREVIEW_PATH.exec(url.pathname) as RegExpExecArray
  const now = new Date(deps.now())
  const verdict = gateOf(request, url, m, deps, opts.peer, now)
  if ('refusal' in verdict) return json(verdict.refusal.status, verdict.refusal.error)
  const { workspaceId, runId, rest, prefix, state, secure, who } = verdict.gate

  if (who.redeem && state) {
    // The link's own value, re-signed for the cookie's lifetime, sets the cookie; the path goes on without it.
    const value = signPreviewValue(
      workspaceId,
      runId,
      state.runningAt ?? '',
      who.principal,
      now.getTime() + PREVIEW_COOKIE_MAX_AGE_S * 1000,
    )
    const query = withoutLink(url.search, url.searchParams.get(LINK_PARAM) ?? '')
    const headers = new Headers({
      location: `${prefix}${query ? `?${query}` : ''}`,
    })
    headers.append(
      'set-cookie',
      `${previewCookieName(workspaceId, runId)}=${value}; Path=${prefix}; HttpOnly; SameSite=Lax; Max-Age=${PREVIEW_COOKIE_MAX_AGE_S}${secure ? '; Secure' : ''}`,
    )
    return new Response(null, { status: 302, headers })
  }
  if (rest === '') {
    return new Response(null, { status: 308, headers: { location: `${prefix}${url.search}` } })
  }
  if (!state || state.runType !== 'preview')
    return json(404, `the board runs no preview ${runId} of workspace ${workspaceId}`)
  if (state.status !== 'running' || state.port === null)
    return json(404, "the preview is not running: start it on the ticket's Preview card or with start_run")

  let loopback: Loopback
  try {
    loopback = loopbackOf(
      await deps.listening(state.port, { workspaceId, runId, runningAt: state.runningAt }),
    )
  } catch {
    loopback = 'unknown'
  }
  if (loopback !== 'loopback') {
    listenCache.delete(`${workspaceId}:${runId}`)
    // Refused only: a request never stops a run (stop rights are the stop endpoint's). The run's own watch
    // (runs.ts) stops a port that listens beyond loopback.
    const why =
      loopback === 'beyond'
        ? 'the preview listens beyond this machine'
        : "the preview's address cannot be checked"
    return json(502, `${why}: refused`)
  }

  // The query goes on as it came: a `pl` here is the preview's own (a link is redeemed on the root path only).
  // A preview built for this path (a checkout of the board) gets the whole path, base included, because it
  // serves it; a plain preview is served at `/` and gets the path under the prefix as it always did.
  const path = `${state.previewBase ? prefix + rest.slice(1) : rest}${url.search}`
  const headers = upstreamHeaders(request.headers, state.port)
  let res: IncomingMessage
  try {
    res = await upstream(
      state.port,
      request.method,
      path,
      headers,
      request.body,
      request.signal,
      deps.upstreamMs,
    )
  } catch {
    return json(502, 'the preview is running but does not answer')
  }
  return answerOf(res, {
    prefix,
    port: state.port,
    method: request.method,
    own: ownOriginOf(request, url, secure),
  })
}

// --- WebSocket upgrades -------------------------------------------------------------------------

/** How often a proxied WebSocket is checked against its run: one whose run stopped is closed. */
export const SOCKET_SWEEP_MS = 500

interface ProxiedSocket {
  workspaceId: number
  runId: number
  port: number
  runningAt: string | null
  client: Duplex
  upstream: Duplex
  statusOf: ProxyDeps['statusOf']
}

const proxied = new Set<ProxiedSocket>()
let sweepTimer: NodeJS.Timeout | null = null

/** Stops the sweep once nothing is tracked: a board with no proxied socket has nothing to look at. */
function stopSweepIfEmpty() {
  if (proxied.size === 0 && sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}

/** Forgets a socket that closed on either side (the browser or the preview): it is no longer ours to watch. */
function forgetProxied(s: ProxiedSocket) {
  proxied.delete(s)
  stopSweepIfEmpty()
}

function dropProxied(s: ProxiedSocket) {
  proxied.delete(s)
  s.client.destroy()
  s.upstream.destroy()
  stopSweepIfEmpty()
}

/**
 * Closes the proxied WebSockets whose run is no longer the one they were opened for: stopped, failed,
 * restarted (a new start has a new `runningAt`) or replaced by another run on another port. Every stop path
 * (stop, restart, a failed run, a forgotten workspace) settles on the run state, so one look is enough.
 */
export function sweepPreviewSockets() {
  for (const s of proxied) {
    const run = s.statusOf(s.workspaceId, s.runId)
    if (run && run.status === 'running' && run.port === s.port && run.runningAt === s.runningAt) continue
    dropProxied(s)
  }
}

/** How many proxied sockets are tracked and whether the sweep runs: for tests and diagnostics. */
export function previewSocketState(): { sockets: number; sweeping: boolean } {
  return { sockets: proxied.size, sweeping: sweepTimer !== null }
}

function trackProxied(s: ProxiedSocket) {
  proxied.add(s)
  if (!sweepTimer) {
    sweepTimer = setInterval(sweepPreviewSockets, SOCKET_SWEEP_MS)
    sweepTimer.unref()
  }
}

/** The answer to an upgrade the board refuses: the same JSON body an HTTP refusal carries, then the socket closes. */
function refuseUpgrade(socket: Duplex, status: number, error: string) {
  if (socket.destroyed) return
  const body = JSON.stringify({ error })
  socket.on('error', () => {})
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Error'}\r\n` +
      'Content-Type: application/json; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Connection: close\r\n\r\n' +
      body,
    () => socket.destroy(),
  )
}

/** A request's headers as the guard reads them, duplicates joined (two Hosts never pass for one good one). */
function headerLookupOf(req: IncomingMessage): HeaderLookup {
  return {
    get(name) {
      const lower = name.toLowerCase()
      if (lower === 'host') {
        const hosts: string[] = []
        for (let i = 0; i < req.rawHeaders.length; i += 2)
          if (req.rawHeaders[i]!.toLowerCase() === 'host') hosts.push(req.rawHeaders[i + 1]!)
        return hosts.length ? hosts.join(', ') : null
      }
      const value = req.headers[lower]
      return value === undefined ? null : Array.isArray(value) ? value.join(', ') : value
    },
    keys: () => Object.keys(req.headers),
  }
}

/**
 * The upgrade as a web Request, on the board's origin as the caller sent it, and its URL. The target is
 * parsed as the listeners parse it: origin-form (`/p/1/2/`), absolute-form (`http://host/p/1/2/`, which a
 * proxy may send) or `//host/x`. Only its path and query are kept, on the board's own origin.
 */
function requestOfUpgrade(req: IncomingMessage): { request: Request; url: URL } | null {
  const host = req.headers.host ?? `localhost:${config.port}`
  let base: URL
  try {
    base = new URL(`http://${host}`)
  } catch {
    return null
  }
  const raw = req.url ?? '/'
  let parsed: URL
  try {
    parsed = new URL(raw, base)
  } catch {
    return null
  }
  try {
    const url = new URL(`${base.origin}${parsed.pathname}${parsed.search}`)
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      if (Array.isArray(value)) for (const v of value) headers.append(name, v)
      else headers.set(name, value)
    }
    return { request: new Request(url, { method: req.method ?? 'GET', headers }), url }
  } catch {
    return null
  }
}

/**
 * Whether the upgrade's Origin names the board's own entrance: the origin the caller reached the board at
 * (`ownOriginOf`, from its Host and the scheme it came through). A browser sends Origin on every WebSocket
 * handshake, so a missing one (a script that is not a browser) is refused too: a page on another site can
 * never open a socket against a preview with the visitor's session.
 */
export function originAllowed(request: Request, url: URL, secure: boolean): boolean {
  const origin = request.headers.get('origin')
  const own = ownOriginOf(request, url, secure)
  if (!origin || own === null) return false
  try {
    return new URL(origin).origin === own
  } catch {
    return false
  }
}

/** The preview's 101, as the browser gets it: its headers, its board cookies dropped and its own kept on the run's path. */
function upgradeAnswer(res: IncomingMessage, prefix: string): string {
  const lines = ['HTTP/1.1 101 Switching Protocols']
  for (let i = 0; i < res.rawHeaders.length; i += 2) {
    const name = res.rawHeaders[i]!
    const value = res.rawHeaders[i + 1]!
    const lower = name.toLowerCase()
    if (lower === 'content-length' || lower === 'transfer-encoding') continue
    if (lower === 'set-cookie') {
      if (BOARD_COOKIE.test(value.trim())) continue
      lines.push(`${name}: ${rewriteSetCookie(value, prefix)}`)
      continue
    }
    lines.push(`${name}: ${value}`)
  }
  return `${lines.join('\r\n')}\r\n\r\n`
}

/** The preview's side of the handshake: its 101, or a rejection once the preview answered something else. */
function connectUpgrade(
  port: number,
  path: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ res: IncomingMessage; socket: Duplex; head: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers })
    const timer = setTimeout(() => req.destroy(new Error('no answer')), timeoutMs)
    req.once('upgrade', (res, socket, head) => {
      clearTimeout(timer)
      resolve({ res, socket: socket as Duplex, head })
    })
    req.once('response', (res) => {
      clearTimeout(timer)
      res.resume()
      reject(new Error('the preview did not upgrade'))
    })
    req.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    req.end()
  })
}

/**
 * The WebSocket upgrade of a preview at `/p/<w>/<r>/...`, or false when the path is not the proxy's. It
 * asks the same questions as the HTTP proxy first (the entrance guard, the sign-in gate, the run's state,
 * the loopback check), then the upgrade's own (its Origin is the board's, it is a WebSocket). Only then does
 * it connect to `127.0.0.1:<the run's port>`, rewriting Origin to the preview's own, and pipes the frames
 * both ways until the client or the run goes. `over` is for tests, as on servePreview.
 */
export async function handlePreviewUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  over: Partial<ProxyDeps> = {},
): Promise<boolean> {
  const deps = { ...DEFAULTS, ...over }
  const built = requestOfUpgrade(req)
  if (!built) {
    refuseUpgrade(socket, 400, 'the request is malformed: refused')
    return true
  }
  const { request, url } = built
  if (!isPreviewPath(url.pathname)) return false
  const m = PREVIEW_PATH.exec(url.pathname) as RegExpExecArray
  const peer = req.socket.remoteAddress
  const guard = guardRequest(
    { method: request.method, headers: headerLookupOf(req), peer, path: url.pathname },
    { authOff: deps.auth().off, port: config.port, entrance: deps.entrance(), dataDir: config.dataDir },
  )
  if (!guard.allow) {
    refuseUpgrade(socket, guard.status, guard.error)
    return true
  }
  if ((req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
    refuseUpgrade(socket, 400, 'only WebSocket upgrades are proxied: refused')
    return true
  }
  const now = new Date(deps.now())
  const verdict = gateOf(request, url, m, deps, peer, now)
  if ('refusal' in verdict) {
    refuseUpgrade(socket, verdict.refusal.status, verdict.refusal.error)
    return true
  }
  const { workspaceId, runId, rest, prefix, state, secure, who } = verdict.gate
  if (!originAllowed(request, url, secure)) {
    refuseUpgrade(socket, 403, "the WebSocket's Origin is not this board: refused")
    return true
  }
  if (!state || state.runType !== 'preview') {
    refuseUpgrade(socket, 404, `the board runs no preview ${runId} of workspace ${workspaceId}`)
    return true
  }
  if (state.status !== 'running' || state.port === null) {
    refuseUpgrade(
      socket,
      404,
      "the preview is not running: start it on the ticket's Preview card or with start_run",
    )
    return true
  }
  let loopback: Loopback
  try {
    loopback = loopbackOf(
      await deps.listening(state.port, { workspaceId, runId, runningAt: state.runningAt }),
    )
  } catch {
    loopback = 'unknown'
  }
  if (loopback !== 'loopback') {
    listenCache.delete(`${workspaceId}:${runId}`)
    const why =
      loopback === 'beyond'
        ? 'the preview listens beyond this machine'
        : "the preview's address cannot be checked"
    refuseUpgrade(socket, 502, `${why}: refused`)
    return true
  }

  const query = who.redeem
    ? withoutLink(url.search, url.searchParams.get(LINK_PARAM) ?? '')
    : url.search.replace(/^\?/, '')
  // A base-built preview sees the prefix the browser asked under (its own base); a plain one sees the path
  // under the prefix, as HTTP above.
  const path = `${state.previewBase ? prefix + rest.slice(1) : rest}${query ? `?${query}` : ''}`
  const headers = upstreamHeaders(request.headers, state.port)
  headers.connection = 'Upgrade'
  headers.upgrade = 'websocket'
  // The preview sees itself at its own origin, never the board's entrance.
  headers.origin = `http://127.0.0.1:${state.port}`
  let handshake: { res: IncomingMessage; socket: Duplex; head: Buffer }
  try {
    handshake = await connectUpgrade(state.port, path, headers, deps.upstreamMs)
  } catch {
    refuseUpgrade(socket, 502, 'the preview is running but does not answer')
    return true
  }
  if (socket.destroyed) {
    handshake.socket.destroy()
    return true
  }
  socket.write(upgradeAnswer(handshake.res, prefix))
  if (handshake.head.length) socket.write(handshake.head)
  if (head.length) handshake.socket.write(head)
  const upstreamSocket = handshake.socket
  const live: ProxiedSocket = {
    workspaceId,
    runId,
    port: state.port,
    runningAt: state.runningAt,
    client: socket,
    upstream: upstreamSocket,
    statusOf: deps.statusOf,
  }
  socket.on('error', () => upstreamSocket.destroy())
  upstreamSocket.on('error', () => socket.destroy())
  // Either side closing ends the proxy's interest in it: forget it first so the set only holds live sockets.
  socket.on('close', () => {
    forgetProxied(live)
    upstreamSocket.destroy()
  })
  upstreamSocket.on('close', () => {
    forgetProxied(live)
    socket.destroy()
  })
  socket.pipe(upstreamSocket)
  upstreamSocket.pipe(socket)
  trackProxied(live)
  return true
}

/**
 * A link to a running preview of the workspace, for the caller's own credential (the REST route and MCP's
 * preview_link): the human's session, or an agent token of the preview's project. Throws an HttpError otherwise.
 */
export function linkFor(request: Request, workspaceId: number, deps: Partial<ProxyDeps> = {}) {
  const d = { ...DEFAULTS, ...deps }
  if (d.auth().off) throw new HttpError(404, 'the preview proxy is off: sign-in is off on this board')
  const runId = d.previewRunId(workspaceId)
  const state = runId === null ? null : d.runOf(workspaceId, runId)
  if (runId === null || !state || state.runType !== 'preview')
    throw new HttpError(404, "the workspace's repo has no preview run")
  if (state.status !== 'running' || !state.runningAt)
    throw new HttpError(
      409,
      "the preview is not running: start it on the ticket's Preview card or with start_run",
    )
  const principal = principalOf(request, new Date(d.now()))
  if (!principal) throw new HttpError(401, SIGN_IN_NEEDED)
  const standing = standingOf(principal, workspaceId, new Date(d.now()), d)
  if (standing === 'signed-out') throw new HttpError(401, SIGN_IN_NEEDED)
  if (standing === 'other-project')
    throw new HttpError(
      403,
      "this preview is for the agents of its project: the token's name is not one of its agents",
    )
  return { runId, ...mintPreviewLink(workspaceId, runId, state.runningAt, principal, d.now()) }
}
