import type { IncomingMessage } from 'node:http'
import net from 'node:net'
import { STATUS_CODES } from 'node:http'
import type { Duplex } from 'node:stream'

import { readUpgradePort } from './previewUpgradePort'

/**
 * A `/p/...` WebSocket under `vite dev`, forwarded to the board's loopback bridge (previewUpgradeBridge.ts).
 * Vite's process owns the socket; the board, in Nitro's worker, owns the sign-in gate, the run state and the
 * preview ports, so this only passes the upgrade on as it came: the bridge answers 401/403/404 itself and
 * pipes the frames. Nothing is read from the request here, and no target is chosen here.
 */

function refuse(socket: Duplex, status: number, error: string) {
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

export function forwardPreviewUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  if (socket.destroyed) return
  const port = readUpgradePort()
  if (port === null) {
    refuse(socket, 502, 'the board is not ready to proxy the preview: try again in a moment')
    return
  }
  const upstream = net.connect(port, '127.0.0.1')
  upstream.once('connect', () => {
    const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/${req.httpVersion}`]
    for (let i = 0; i < req.rawHeaders.length; i += 2)
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head.length) upstream.write(head)
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
  upstream.on('error', () => refuse(socket, 502, 'the board does not answer for the preview'))
  socket.on('error', () => upstream.destroy())
  socket.on('close', () => upstream.destroy())
}
