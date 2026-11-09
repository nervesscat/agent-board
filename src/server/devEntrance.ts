import fs from 'node:fs'
import { type IncomingMessage, type ServerResponse, STATUS_CODES } from 'node:http'
import path from 'node:path'
import type { Duplex } from 'node:stream'

import Database from 'better-sqlite3'
import type { Connect, Plugin, ViteDevServer } from 'vite'

import { type PublicEntrance, StartupError } from './config.ts'
import { signedIn } from './credentials.ts'
import { isPreviewPath } from './previewPaths.ts'
import {
  type GuardConfig,
  guardConfig,
  guardRequest,
  type HeaderLookup,
  hostOf,
  isForwardingHeader,
  isLoopbackPeer,
  isSignInPath,
  loginLocation,
  wantsHtml,
} from './entrance.ts'
import { savedEntrance } from './tailnetStore.ts'

/**
 * `vite dev`, which runs the board, answers some requests itself before Nitro hands one to the board's
 * middleware (src/start.ts): /@vite/*, /@fs/*, /@id/*, modules under /src and /node_modules, the
 * public/ files, any file of the repo asked for as an asset, /__open-in-editor, and the hot-reload
 * WebSocket. This puts the guard of entrance.ts in front of all of it, ahead of Nitro's and Vite's own
 * middlewares: through the tailnet entrance nothing is served without a session of the public origin
 * (or an agent token), but the sign-in pages and their endpoints, which the board answers itself; and no
 * WebSocket opens (the board has none; hot reload is for this machine's browsers). A request straight to
 * the board on this machine is served as before, once its Host (and a cookie write's Origin) passes.
 *
 * The entrance is read for each request, from the environment and from the board's database: an entrance
 * saved in Settings applies at once, here as in the board's own process (which resets its memo on a save).
 * Vite's own Host check is built once from allowedHosts, so it lets through the saved host by the same
 * reading (admitSavedHost).
 *
 * Who is signed in, and the saved entrance, are read from the board's database (credentials.ts,
 * tailnetStore.ts), opened here in Vite's process, never written: the board itself runs in Nitro's.
 */

/**
 * Node's headers as the board's middleware sees them (srvx): Node keeps the first of two Host headers,
 * srvx joins them, and so does this, so two never pass for one good one.
 */
/**
 * The request's path, without its query, normalised as the built server reads it (`new URL(…).pathname`):
 * a raw `/x/../p/…` is the preview path it resolves to, so the guard's rules for `/p/` apply to it too.
 */
const pathOf = (req: IncomingMessage) => new URL(req.url ?? '/', 'http://localhost').pathname

export function nodeHeaders(req: IncomingMessage): HeaderLookup {
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
 * Forwarded headers from a peer that is not loopback are not the tailnet entrance's: they go, so that
 * nothing after this (Nitro's worker sees every request come from loopback) takes them for it.
 */
export function dropForwarding(req: IncomingMessage) {
  for (const name of Object.keys(req.headers)) if (isForwardingHeader(name)) delete req.headers[name]
  const raw: string[] = []
  for (let i = 0; i < req.rawHeaders.length; i += 2)
    if (!isForwardingHeader(req.rawHeaders[i]!)) raw.push(req.rawHeaders[i]!, req.rawHeaders[i + 1]!)
  req.rawHeaders = raw
}

function answer(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** The path and query of a request line, whatever form it came in (`/x?y`, `http://host/x?y`). */
const pathAndSearch = (url: string | undefined) => {
  const u = new URL(url ?? '/', 'http://localhost')
  return `${u.pathname}${u.search}`
}

export interface SignInCheck {
  /** Whether these headers sign someone in on the public origin `rpId`. */
  signedIn(headers: HeaderLookup, rpId: string): boolean
  /** The entrance Settings saved, as the database holds it now (null: none, or not one the board takes). */
  saved(): PublicEntrance | null
  close(): void
}

/**
 * Sign-ins and the saved entrance read from the database in `dataDir` of the board on `port` (its session
 * cookie's name): opened on the first question, and again after a failure. Before the board's first start
 * there is no database yet: then nobody is signed in and nothing is saved.
 */
export function databaseSignIn(dataDir: string, port: number): SignInCheck {
  const file = path.join(dataDir, 'board.db')
  let sqlite: Database.Database | null = null
  const close = () => {
    sqlite?.close()
    sqlite = null
  }
  const open = () => (sqlite ??= new Database(file, { fileMustExist: true }))
  const failed = (err: unknown) => {
    console.error('agent-board: cannot read the database:', err instanceof Error ? err.message : err)
    close()
  }
  return {
    signedIn(headers, rpId) {
      try {
        return signedIn(open(), headers, rpId, port)
      } catch (err) {
        failed(err)
        return false
      }
    },
    saved() {
      if (!sqlite && !fs.existsSync(file)) return null
      try {
        return savedEntrance(open())
      } catch (err) {
        failed(err)
        return null
      }
    },
    close,
  }
}

/**
 * The connect middleware: the guard, then for the tailnet entrance a session of the public origin. `live`
 * reads the guard's settings as they are now, once for each request.
 */
export function entranceMiddleware(live: () => GuardConfig, check: SignInCheck) {
  return function entranceGuardMiddleware(
    req: IncomingMessage,
    res: ServerResponse,
    next: (err?: unknown) => void,
  ) {
    try {
      const peer = req.socket.remoteAddress
      const headers = nodeHeaders(req)
      const cfg = live()
      const verdict = guardRequest({ method: req.method ?? 'GET', headers, peer, path: pathOf(req) }, cfg)
      if (!verdict.allow) return answer(res, verdict.status, { error: verdict.error })
      if (!isLoopbackPeer(peer)) dropForwarding(req)
      if (!verdict.entrance) return next()
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      // The board's own sign-in pages and endpoints: it answers them, and they hold none of Vite's files.
      if (isSignInPath(pathname)) return next()
      // A running preview's path is the board's to answer (previewProxy.ts): it signs the caller in itself
      // and answers 401 JSON, never this login redirect, so the request goes on to the board.
      if (isPreviewPath(pathname)) return next()
      if (check.signedIn(headers, verdict.entrance.host)) return next()
      if (wantsHtml(req.method, headers.get('accept'))) {
        res.writeHead(302, { location: loginLocation(pathAndSearch(req.url)) })
        return res.end()
      }
      return answer(res, 401, { error: 'sign in' })
    } catch (err) {
      next(err)
    }
  }
}

/** For the server's `upgrade` event, ahead of Vite's own listener: a refused upgrade never gets a 101. */
export function entranceUpgradeGuard(live: () => GuardConfig) {
  return function refuseEntranceUpgrade(req: IncomingMessage, socket: Duplex) {
    const peer = req.socket.remoteAddress
    const verdict = guardRequest(
      { method: req.method ?? 'GET', headers: nodeHeaders(req), peer, path: pathOf(req) },
      live(),
    )
    const refusal = !verdict.allow
      ? verdict
      : verdict.entrance
        ? { status: 403, error: 'no WebSocket through the tailnet entrance: hot reload is for this machine' }
        : null
    if (!refusal) {
      if (!isLoopbackPeer(peer)) dropForwarding(req)
      return
    }
    const body = JSON.stringify({ error: refusal.error })
    // Vite's listener runs after this one and sees the socket closed: it writes nothing then.
    socket.on('error', () => {})
    socket.end(
      `HTTP/1.1 ${refusal.status} ${STATUS_CODES[refusal.status]}\r\n` +
        'Content-Type: application/json; charset=utf-8\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      () => socket.destroy(),
    )
  }
}

/**
 * Vite's Host check (hostValidationMiddleware, built once from allowedHosts, ahead of this plugin) lets
 * through the entrance's host the environment names only. This lets through the host Settings saved as
 * well, as it is now: the guard then decides the rest, as it does for every request. Any other Host goes to
 * Vite's own check as before.
 */
function admitSavedHost(server: ViteDevServer, live: () => GuardConfig) {
  const layer = server.middlewares.stack.find(
    (item) => (item.handle as { name?: string }).name === 'hostValidationMiddleware',
  )
  if (!layer) {
    server.config.logger.warn(
      'agent-board: vite dev has no host check to extend: a tailnet entrance saved in Settings is refused until it restarts',
    )
    return
  }
  const viteCheck = layer.handle as Connect.NextHandleFunction
  layer.handle = (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
    if (hostOf(req.headers.host ?? null, live().entrance) === 'public') return next()
    return viteCheck(req, res, next)
  }
}

/**
 * The plugin vite.config.ts puts first. Its settings are read from process.env as the server is
 * configured, once .env is loaded: BOARD_ENV, AUTH and PUBLIC_ORIGIN as Vite's loadEnv reads them
 * (devEnv.ts), the rest by Nitro (`env` stands in for that in tests). The entrance Settings saved is read
 * on each request.
 */
export function entranceGuard(options: { env?: () => Record<string, string | undefined> } = {}): Plugin {
  return {
    name: 'agent-board:entrance-guard',
    apply: 'serve',
    configureServer: {
      // Ahead of every other plugin's middleware, Nitro's included, and of Vite's files, modules and
      // /__open-in-editor, which Vite adds after these hooks; only its own Host check runs earlier.
      order: 'pre',
      handler(server) {
        const env = () => options.env?.() ?? process.env
        let startup: GuardConfig
        try {
          startup = guardConfig(env())
        } catch (err) {
          if (err instanceof StartupError) throw new Error(`agent-board refuses to start: ${err.message}`)
          throw err
        }
        const check = databaseSignIn(startup.dataDir, startup.port)
        const live = () => guardConfig(env(), check.saved())
        admitSavedHost(server, live)
        server.middlewares.use(entranceMiddleware(live, check))
        server.httpServer?.prependListener('upgrade', entranceUpgradeGuard(live))
        server.httpServer?.once('close', check.close)
      },
    },
  }
}
