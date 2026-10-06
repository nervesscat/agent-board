import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { endConnectionGone, isConnectionGone } from './connectionGone'

/** The error a client gets when the far end resets the connection: the one the overlay showed. */
async function genuineReset(): Promise<NodeJS.ErrnoException> {
  const server = net.createServer((s) => s.resetAndDestroy())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await new Promise((resolve) => {
      const client = net.connect((server.address() as AddressInfo).port, '127.0.0.1')
      client.on('error', resolve)
    })
  } finally {
    server.close()
  }
}

describe('isConnectionGone', () => {
  it('is true for a genuine connection reset', async () => {
    const err = await genuineReset()
    expect(err).toMatchObject({ code: 'ECONNRESET', syscall: 'read', message: 'read ECONNRESET' })
    expect(isConnectionGone(err)).toBe(true)
  })

  it('is true for the codes of a connection gone, with or without an Error around them', () => {
    expect(isConnectionGone({ code: 'ECONNRESET' })).toBe(true)
    expect(isConnectionGone(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).toBe(true)
    expect(isConnectionGone(Object.assign(new Error('aborted'), { code: 'ECONNABORTED' }))).toBe(true)
  })

  it('is false for real errors, a worker that is down included', () => {
    expect(isConnectionGone(new Error('boom'))).toBe(false)
    expect(isConnectionGone(new Error('read ECONNRESET'))).toBe(false)
    expect(isConnectionGone(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toBe(
      false,
    )
    expect(isConnectionGone({ code: 42 })).toBe(false)
  })

  it('does not throw on what is not an error', () => {
    for (const v of [undefined, null, 'ECONNRESET', 0, Symbol('x')]) expect(isConnectionGone(v)).toBe(false)
  })
})

describe('endConnectionGone', () => {
  let server: http.Server | undefined
  afterEach(() => server?.close())

  /** A real server whose every request fails with `err`, after `before` has written what it will. */
  async function failWith(
    err: unknown,
    before: (res: http.ServerResponse) => Promise<void> | void = () => {},
  ) {
    const lines: string[] = []
    const passed: unknown[] = []
    const handle = endConnectionGone((line) => lines.push(line))
    server = http.createServer(async (req, res) => {
      await before(res)
      handle(err, req, res, (e) => {
        passed.push(e)
        res.statusCode = 500
        res.end('from the next error handler')
      })
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tickets?x=1`
    return { url, lines, passed }
  }

  it('ends a request whose connection was reset with a 502, logs one line and passes nothing on', async () => {
    const { url, lines, passed } = await failWith(await genuineReset())
    const res = await fetch(url)
    expect(res.status).toBe(502)
    expect(await res.text()).toMatch(/lost the connection \(ECONNRESET\)/)
    expect(passed).toEqual([])
    expect(lines).toEqual([
      'GET /api/tickets?x=1: connection gone (ECONNRESET), request ended without the error overlay',
    ])
  })

  it('drops the connection when the headers are already out, rather than leave the request hanging', async () => {
    const { url, passed } = await failWith({ code: 'ECONNRESET' }, async (res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      await new Promise((resolve) => res.write('half', resolve))
    })
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    expect(res.status).toBe(200)
    // A cut-off body is an error, not a response that looks complete.
    await expect(res.text()).rejects.toThrow()
    expect(passed).toEqual([])
  })

  it('passes every other error on unchanged', async () => {
    const boom = new Error('boom')
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    for (const err of [boom, refused, 'a string']) {
      const { url, lines, passed } = await failWith(err)
      const res = await fetch(url)
      expect(res.status).toBe(500)
      expect(passed).toHaveLength(1)
      expect(passed[0]).toBe(err)
      expect(lines).toEqual([])
      server!.close()
    }
  })
})
