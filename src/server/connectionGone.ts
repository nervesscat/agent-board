import type { IncomingMessage, ServerResponse } from 'node:http'

// The other end of a connection went away: nothing in the board's code is wrong. Node's `aborted`
// (an inbound request cut off mid-body) carries ECONNRESET too.
const GONE = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED'])

/** Whether `err` says a connection went away. Never throws, whatever it is given. */
export function isConnectionGone(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' && GONE.has(code)
}

/**
 * A connect error handler for `vite dev` (vite.config.ts). `vite dev` proxies each request to Nitro's
 * worker over a keep-alive connection, and when that connection is reset Nitro hands the bare
 * `read ECONNRESET` to Vite's error middleware, which opens the error overlay in every open tab,
 * over whatever the human was doing. This ends such a request itself: a 502, or the connection
 * dropped once the headers are out, so it never hangs; one line goes to `warn`. Every other error
 * goes on unchanged.
 */
export function endConnectionGone(warn: (line: string) => void) {
  return function connectionGoneHandler(
    err: unknown,
    req: IncomingMessage,
    res: ServerResponse,
    next: (err?: unknown) => void,
  ) {
    if (!isConnectionGone(err)) return next(err)
    const { code } = err as { code: string }
    warn(`${req.method} ${req.url}: connection gone (${code}), request ended without the error overlay`)
    if (res.writableEnded) return
    if (res.headersSent || res.destroyed || res.socket?.destroyed) {
      res.destroy()
      return
    }
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`The dev server lost the connection (${code}). Try again.\n`)
  }
}
