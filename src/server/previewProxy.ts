import http, { type IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'

import { eq } from 'drizzle-orm'

import { db, schema } from '#/db'
import { siteOf } from './auth'
import { type AuthMode, authMode, config, type PublicEntrance, servedEntrance } from './config'
import { agentTokenOf, bearerToken, isBearer, readCookie, sessionCookieName, sessionOf } from './credentials'
import { isForwardingHeader, type SignInSite } from './entrance'
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
import { PREVIEW_PATH, previewCookieName, previewPathOf } from './previewPaths'
import { type RunState, runState, stopRun } from './runs'

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
 *   linkPreview.ts): otherwise 502, and the preview is not reached.
 * - Board credentials never reach the preview: no Authorization, no board session or preview cookie. Its own
 *   cookies are rewritten to the run's path; its Location headers that name the loopback address or a root
 *   path are rewritten to the prefix. Every other body streams byte for byte, except an HTML page, which gets
 *   one small script (`runtimeScript`) that prefixes root-absolute fetch, XMLHttpRequest and EventSource URLs.
 * - Sign-in off (outside production, see config.ts): every `/p/` path answers 404, and nothing is proxied.
 *
 * WebSocket upgrades are not proxied (see the PR description): a preview's live updates use event streams.
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
  /** The addresses the port listens on, loopback or not. */
  listening: (port: number) => Promise<string[]>
  projectOf: (workspaceId: number) => number | null
  /** The run a workspace's link is for: its repo's preview run. */
  previewRunId: (workspaceId: number) => number | null
  /** How long the preview may take to send its headers before the request is answered 502. */
  upstreamMs: number
}

const listenCache = new Map<number, { at: number; addresses: string[] }>()

async function listeningNow(port: number): Promise<string[]> {
  const hit = listenCache.get(port)
  if (hit && Date.now() - hit.at < LISTEN_TTL_MS) return hit.addresses
  const addresses = await listeningAddresses(port)
  listenCache.set(port, { at: Date.now(), addresses })
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

/** The Cookie header without the board's own cookies: its session's and the previews' links'. */
export function withoutBoardCookies(cookie: string): string {
  return cookie
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !/^board_(session|preview)_/.test(part))
    .join('; ')
}

/** The headers the preview gets: the caller's, minus the board's and forwarding, with its own host. */
export function upstreamHeaders(
  from: Headers,
  port: number,
  host: string | null,
  secure: boolean,
): Record<string, string> {
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
  if (host) out['x-forwarded-host'] = host
  out['x-forwarded-proto'] = secure ? 'https' : 'http'
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
 * A Location of the preview: its loopback address (on the port it is) or a root path, into the prefix. Any
 * other target (a relative one, another host) stays as it is.
 */
export function rewriteLocation(location: string, prefix: string, port: number): string {
  const absolute = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):(\d+)(\/.*)?$/i.exec(location)
  if (absolute) {
    if (Number(absolute[2]) !== port) return location
    return prefix + (absolute[3] ?? '/').slice(1)
  }
  if (location.startsWith('/') && !location.startsWith('//') && !location.startsWith(prefix))
    return prefix + location.slice(1)
  return location
}

/**
 * The script an HTML page of the preview gets: root-absolute URLs its scripts open with fetch, XMLHttpRequest
 * and EventSource gain the prefix, so `/api/x` reaches `/p/<w>/<r>/api/x`. Changes nothing else.
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
    else if (typeof Request !== 'undefined' && input instanceof Request) { var b = abs(input.url); if (b !== null) input = new Request(location.origin + b, input); }
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
    const timer = setTimeout(() => req.destroy(new Error('no answer')), timeoutMs)
    const abort = () => req.destroy()
    signal.addEventListener('abort', abort, { once: true })
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
  opts: { prefix: string; port: number; method: string },
): Promise<Response> {
  const status = res.statusCode ?? 502
  const headers = new Headers()
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue
    if (name === 'set-cookie') {
      for (const cookie of [value].flat()) headers.append('set-cookie', rewriteSetCookie(cookie, opts.prefix))
    } else if (name === 'location') {
      headers.set(name, rewriteLocation(String(value), opts.prefix, opts.port))
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
    const bytes = await readCapped(res, HTML_CAP_BYTES)
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
  const m = PREVIEW_PATH.exec(url.pathname)
  if (!m) return null
  if (deps.auth().off) return json(404, 'the preview proxy is off: sign-in is off on this board')
  const workspaceId = Number(m[1])
  const runId = Number(m[2])
  const rest = m[3] ?? ''
  const prefix = previewPathOf(workspaceId, runId)
  const now = new Date(deps.now())
  const state = deps.runOf(workspaceId, runId)
  const site = siteOf(request, deps.entrance(), opts.peer)

  const who = whoIs(
    request,
    url,
    site,
    { workspaceId, runId, runningAt: state?.runningAt ?? null, rest },
    now,
  )
  if (!who) return json(401, SIGN_IN_NEEDED)
  const standing = standingOf(who.principal, workspaceId, now, deps)
  if (standing === 'signed-out') return json(401, SIGN_IN_NEEDED)
  if (standing === 'other-project')
    return json(
      403,
      "this preview is for the agents of its project: the token's name is not one of its agents",
    )

  const secure = site?.origin.startsWith('https:') ?? false
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
    loopback = loopbackOf(await deps.listening(state.port))
  } catch {
    loopback = 'unknown'
  }
  if (loopback !== 'loopback') {
    // Stopped, as the board's own watch stops it (runs.ts): a run that listens beyond the machine is not left up.
    const why =
      loopback === 'beyond'
        ? 'the preview listens beyond this machine'
        : "the preview's address cannot be checked"
    await stopRun(workspaceId, runId, why, 'the board').catch(() => null)
    return json(502, `${why}: stopped`)
  }

  // The query goes on as it came: a `pl` here is the preview's own (a link is redeemed on the root path only).
  const path = `${rest}${url.search}`
  const headers = upstreamHeaders(request.headers, state.port, request.headers.get('host'), secure)
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
  return answerOf(res, { prefix, port: state.port, method: request.method })
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
