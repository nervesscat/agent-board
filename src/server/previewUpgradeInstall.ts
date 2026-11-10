import http from 'node:http'
import https from 'node:https'

import { isPreviewPath } from './previewPaths'
import { handlePreviewUpgrade } from './previewProxy'

/**
 * The board's own HTTP server, its `upgrade` event: a `/p/<workspaceId>/<runId>/...` WebSocket is the
 * preview proxy's (`handlePreviewUpgrade`), and any other upgrade is left to whatever else listens. Nitro
 * creates the server itself, so the contract is kept by wrapping `createServer` before it runs: the wrapper
 * adds one listener and changes nothing else. With this listener present and nothing else answering an
 * upgrade, Node would leave the socket open (it used to close it); the listener closes it itself then.
 *
 * Kept on `globalThis`: `vite dev` re-evaluates the server's modules on reload in the same process, and the
 * wrapper must not be stacked once per reload. The handler itself is refreshed each reload, so a change to
 * the proxy applies without a restart.
 */

const KEY = Symbol.for('agent-board.preview-upgrade-hook')

interface Kept {
  installed?: boolean
  handle?: (req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => void
}

const kept = ((globalThis as { [KEY]?: Kept })[KEY] ??= {})

function attach(server: http.Server) {
  server.on('upgrade', (req, socket, head) => {
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      pathname = '/'
    }
    if (isPreviewPath(pathname)) {
      kept.handle?.(req, socket, head)
      return
    }
    // The only listener: this upgrade has no handler on the board, as before this one existed.
    if (server.listenerCount('upgrade') === 1) socket.destroy()
  })
}

/** Wraps `http.createServer` (and https's) so every server the board creates gets the preview's listener. */
export function installPreviewUpgradeHook(): void {
  kept.handle = (req, socket, head) => {
    void handlePreviewUpgrade(req, socket, head).catch(() => socket.destroy())
  }
  if (kept.installed) return
  kept.installed = true
  for (const mod of [http, https] as const) {
    const create = mod.createServer as unknown as (...args: never[]) => http.Server
    const patched = function (this: unknown, ...args: never[]) {
      const server = create.apply(this, args)
      attach(server)
      return server
    }
    ;(mod as { createServer: unknown }).createServer = patched
  }
}
