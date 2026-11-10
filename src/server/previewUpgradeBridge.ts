import http from 'node:http'

import { isPreviewPath } from './previewPaths'
import { handlePreviewUpgrade } from './previewProxy'
import { clearUpgradePort, writeUpgradePort } from './previewUpgradePort'

/**
 * The board's end of a preview WebSocket under `vite dev`: the board runs in Nitro's worker, while the HTTP
 * server the browser reaches is Vite's, in another process. This loopback-only bridge is what Vite's process
 * forwards a `/p/...` upgrade to, and the board's own upgrade handler does the rest (`handlePreviewUpgrade`:
 * the entrance guard, the sign-in gate, the loopback check, the handshake). It is started for every mode;
 * a built server reaches its own HTTP server directly and never needs it. Nothing but the port is written to
 * the data dir, and the gate is the same one the HTTP proxy uses, so a local process reaching the bridge
 * still needs the caller's credential for that preview.
 *
 * Kept on `globalThis` for the same reason as the server hook: `vite dev` reloads the server's modules in the
 * same process, and one bridge (one loopback port) is enough.
 */

const KEY = Symbol.for('agent-board.preview-upgrade-bridge')

interface Kept {
  server?: http.Server
  port?: number
}

const kept = ((globalThis as { [KEY]?: Kept })[KEY] ??= {})

export function startPreviewUpgradeBridge(): http.Server | null {
  if (kept.server) {
    if (kept.port) writeUpgradePort(kept.port)
    return kept.server
  }
  // No request handler: an ordinary HTTP request to the bridge is not the WebSocket path.
  const bridge = http.createServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'not a WebSocket upgrade' }))
  })
  bridge.on('upgrade', (req, socket, head) => {
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      socket.destroy()
      return
    }
    if (!isPreviewPath(pathname)) {
      socket.destroy()
      return
    }
    void handlePreviewUpgrade(req, socket, head)
      .then((handled) => {
        if (!handled) socket.destroy()
      })
      .catch(() => socket.destroy())
  })
  bridge.on('error', (err) => console.error('preview upgrade bridge:', err))
  bridge.listen(0, '127.0.0.1', () => {
    const address = bridge.address()
    if (!address || typeof address === 'string') return
    kept.port = address.port
    writeUpgradePort(kept.port)
  })
  kept.server = bridge
  return bridge
}

export function stopPreviewUpgradeBridge() {
  const bridge = kept.server
  if (!bridge) return
  bridge.close()
  kept.server = undefined
  if (kept.port !== undefined) clearUpgradePort(kept.port)
  kept.port = undefined
}
