import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { checkPreview, isLocalUrl, previewState, previewUrl } from './preview'

describe('previewUrl', () => {
  it('keeps http and https links as given, trimmed', () => {
    expect(previewUrl(' http://localhost:47101 ')).toBe('http://localhost:47101')
    expect(previewUrl('https://127.0.0.1:5173/tickets?x=1')).toBe('https://127.0.0.1:5173/tickets?x=1')
  })

  it("clears with '' or null", () => {
    expect(previewUrl('')).toBe('')
    expect(previewUrl('  ')).toBe('')
    expect(previewUrl(null)).toBe('')
    expect(previewUrl(undefined)).toBe('')
  })

  it('refuses anything else', () => {
    expect(() => previewUrl('localhost:47101')).toThrow(/http/)
    expect(() => previewUrl('javascript:alert(1)')).toThrow(/http/)
    expect(() => previewUrl('file:///C:/secrets.txt')).toThrow(/http/)
    expect(() => previewUrl('not a url')).toThrow(/full URL/)
  })
})

describe('isLocalUrl', () => {
  it('is this machine only', () => {
    for (const url of [
      'http://localhost:47101',
      'http://127.0.0.1:3000/x',
      'http://[::1]:8080',
      'https://LOCALHOST',
    ])
      expect(isLocalUrl(url), url).toBe(true)
    for (const url of [
      'http://example.com',
      'http://192.168.1.10:3000',
      'http://10.0.0.1',
      'http://localhost.example.com',
      'http://127.0.0.1.nip.io',
      'http://user@example.com',
      'nonsense',
    ])
      expect(isLocalUrl(url), url).toBe(false)
  })

  it('is enforced before anything is fetched', async () => {
    await expect(checkPreview('http://example.com')).rejects.toThrow(/localhost/)
    expect(() => previewState('http://169.254.169.254/latest')).toThrow(/localhost/)
  })
})

describe('checkPreview', () => {
  let server: http.Server
  let port: number
  let closedPort: number
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(req.url === '/missing' ? 404 : 200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
    // A port that was free a moment ago and nothing listens on now.
    const probe = http.createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    closedPort = (probe.address() as AddressInfo).port
    await new Promise((resolve) => probe.close(resolve))
  })
  afterAll(() => new Promise((resolve) => server.close(resolve)))

  it('is running when anything answers, an error page too', async () => {
    expect(await checkPreview(`http://127.0.0.1:${port}/`)).toMatchObject({ running: true, status: 200 })
    expect(await checkPreview(`http://localhost:${port}/missing`)).toMatchObject({
      running: true,
      status: 404,
    })
  })

  it('is not running when the connection is refused', async () => {
    const state = await checkPreview(`http://127.0.0.1:${closedPort}/`)
    expect(state.running).toBe(false)
    expect(state.status).toBeUndefined()
    expect(Date.parse(state.checkedAt)).not.toBeNaN()
  })

  it('is not running when nothing answers in time', async () => {
    const silent = http.createServer(() => {})
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    try {
      const at = Date.now()
      const state = await checkPreview(`http://127.0.0.1:${(silent.address() as AddressInfo).port}/`, 200)
      expect(state.running).toBe(false)
      expect(Date.now() - at).toBeLessThan(1500)
    } finally {
      silent.closeAllConnections()
      await new Promise((resolve) => silent.close(resolve))
    }
  })

  it('is cached for a few seconds per URL', async () => {
    const url = `http://127.0.0.1:${port}/cached`
    const first = await previewState(url)
    expect(await previewState(url)).toBe(first)
  })
})
