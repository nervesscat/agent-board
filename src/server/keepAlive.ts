import http from 'node:http'
import https from 'node:https'

/**
 * How long the board holds an idle connection before it closes it. Node's default is 5 s, and a client
 * that keeps connections for reuse with no idle timeout of its own (Playwright's API client, a Node
 * http.Agent with keepAlive) then sends on one the board has just closed for idleness: that request is
 * lost, and the client gets `read ECONNRESET` or `socket hang up`. It happens on idle gaps past the
 * default now and then, which is why it showed in some runs and not others.
 *
 * 65 s is above the 60 s idle timeout of the load balancers and proxies that commonly sit in front of
 * a server like this one, so the board never closes a connection they still hold open.
 */
export const KEEP_ALIVE_TIMEOUT_MS = 65_000

/** Sets the keep-alive timeout of one server (an HTTP or an HTTP/2 one, which both keep idle connections). */
export function keepAliveLonger(server: { keepAliveTimeout: number }): void {
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS
}

const KEY = Symbol.for('agent-board.keep-alive-hook')

const kept = ((globalThis as { [KEY]?: { installed?: boolean } })[KEY] ??= {})

/**
 * Wraps `http.createServer` (and https's) so every server the board creates gets `keepAliveLonger`. Nitro
 * creates the built server itself, so this runs as a Nitro plugin, before the server is made
 * (src/server/plugins/keepAlive.ts). Kept on `globalThis`, so the wrapper is not stacked once per reload.
 */
export function installKeepAlive(): void {
  if (kept.installed) return
  kept.installed = true
  for (const mod of [http, https] as const) {
    const create = mod.createServer as unknown as (...args: never[]) => http.Server
    const patched = function (this: unknown, ...args: never[]) {
      const server = create.apply(this, args)
      keepAliveLonger(server)
      return server
    }
    ;(mod as { createServer: unknown }).createServer = patched
  }
}
