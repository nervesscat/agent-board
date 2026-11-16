import http from 'node:http'
import https from 'node:https'

import { afterEach, describe, expect, it } from 'vitest'

import { KEEP_ALIVE_TIMEOUT_MS, installKeepAlive } from './keepAlive'

/**
 * The board's servers keep an idle connection past Node's 5 s default, so a client that reuses its
 * connections after a longer gap (Playwright's API client does, with no idle timeout of its own) is not
 * sent on a connection the board has just closed. Without `installKeepAlive`, `createServer` gives the
 * 5 s default and these fail.
 */
describe('keep-alive of the board servers', () => {
  let server: http.Server | https.Server | undefined
  afterEach(() => server?.close())

  it('holds an idle connection well past the 5 s default, longer than common load balancers', () => {
    expect(KEEP_ALIVE_TIMEOUT_MS).toBeGreaterThan(60_000)
  })

  it('is set on every HTTP server the board creates once installed', () => {
    installKeepAlive()
    server = http.createServer(() => {})
    expect(server.keepAliveTimeout).toBe(KEEP_ALIVE_TIMEOUT_MS)
  })

  it('is set on HTTPS servers too', () => {
    installKeepAlive()
    server = https.createServer(() => {})
    expect(server.keepAliveTimeout).toBe(KEEP_ALIVE_TIMEOUT_MS)
  })
})
