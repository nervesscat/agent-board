import { describe, expect, it } from 'vitest'

import type { PublicEntrance } from './config'
import {
  boardOrigins,
  cameThroughEntrance,
  type GuardConfig,
  guardConfig,
  guardRequest,
  hostOf,
  isLoopbackPeer,
  loginLocation,
  publicRoute,
} from './entrance'

const PUBLIC = 'devbox.example-tailnet.ts.net'
const entrance: PublicEntrance = {
  origin: `https://${PUBLIC}`,
  host: PUBLIC,
  gateUrl: `https://${PUBLIC}:8443`,
  gateAuthUrl: 'http://127.0.0.1:47111',
}

/** The live board with the entrance, the same without it, and a gate-off board (test mode). */
const on: GuardConfig = { gateOff: false, port: 47100, entrance }
const plain: GuardConfig = { gateOff: false, port: 47100, entrance: null }
const off: GuardConfig = { gateOff: true, port: 47131, entrance: null }

const request = (headers: Record<string, string>, opts: { method?: string; peer?: string | null } = {}) => ({
  method: opts.method ?? 'GET',
  headers: new Headers(headers),
  peer: opts.peer === undefined ? '127.0.0.1' : opts.peer,
})

/** What `tailscale serve` adds to a request from a tailnet user (Tailscale's ipn/ipnlocal/serve.go). */
const SERVE = {
  'x-forwarded-for': '100.101.102.103',
  'x-forwarded-host': PUBLIC,
  'x-forwarded-proto': 'https',
  'tailscale-user-login': 'someone@example.com',
  'tailscale-user-name': 'Someone',
}

describe('the Host', () => {
  it('is answered on loopback, on any port, in every mode', () => {
    for (const cfg of [on, plain, off])
      for (const host of [
        'localhost',
        'localhost:47100',
        'LOCALHOST:5',
        '127.0.0.1:47264',
        '[::1]:47100',
        '[::1]',
      ])
        expect(guardRequest(request({ host }), cfg), `${host}`).toEqual({ allow: true, entrance: null })
  })

  it('is refused anything else, before any handler: other names, LAN and other loopback IPs, two Hosts', () => {
    for (const cfg of [on, plain, off])
      for (const host of [
        'evil.example',
        '192.168.1.20:47264',
        '100.101.102.103',
        '127.0.0.2:47100',
        '0.0.0.0:47100',
        '[::ffff:127.0.0.1]:47100',
        'foo.localhost:47100',
        'localhost.',
        'localhost:',
        'localhost:http',
        'localhost, evil.example',
        `${PUBLIC}:8443`,
        `${PUBLIC}.`,
        `x.${PUBLIC}`,
        '',
      ]) {
        const verdict = guardRequest(request({ host, cookie: 'gate_session=local-ok' }), cfg)
        expect(verdict, `${host}`).toMatchObject({ allow: false, status: 403 })
      }
    expect(guardRequest(request({}), on)).toMatchObject({ allow: false, status: 403 })
  })

  it('takes the public host only when the entrance is configured: no port or 443, any case', () => {
    for (const host of [PUBLIC, `${PUBLIC}:443`, PUBLIC.toUpperCase()]) {
      expect(hostOf(host, entrance), host).toBe('public')
      expect(guardRequest(request({ host }, { peer: '127.0.0.1' }), on)).toEqual({ allow: true, entrance })
      expect(guardRequest(request({ host }), plain)).toMatchObject({ allow: false, status: 403 })
      expect(guardRequest(request({ host }), off)).toMatchObject({ allow: false, status: 403 })
    }
    expect(hostOf(PUBLIC, null)).toBeNull()
  })
})

describe('Tailscale Funnel', () => {
  it('is refused in every mode, with or without a session, whatever the peer', () => {
    const extras: Record<string, string>[] = [
      {},
      { cookie: 'gate_session=public-ok' },
      { authorization: 'Bearer gate_public_token' },
      { host: PUBLIC },
    ]
    for (const cfg of [on, plain, off])
      for (const extra of extras)
        for (const peer of ['127.0.0.1', '192.168.1.20', null]) {
          const headers = { host: 'localhost:47100', ...extra, 'tailscale-funnel-request': '?1' }
          expect(guardRequest(request(headers, { peer }), cfg)).toMatchObject({
            allow: false,
            status: 403,
            error: expect.stringMatching(/Funnel/),
          })
        }
  })
})

describe('a request through the tailnet entrance', () => {
  const each: Record<string, string>[] = [
    { 'x-forwarded-for': '100.101.102.103' },
    { 'x-forwarded-host': PUBLIC },
    { 'x-forwarded-proto': 'https' },
    { forwarded: 'for=100.101.102.103;proto=https' },
    { 'tailscale-user-login': 'someone@example.com' },
    { 'tailscale-user-profile-pic': 'https://example.com/me.png' },
    { 'x-real-ip': '100.101.102.103' },
  ]

  it('is any request a proxy on this machine forwarded, whatever Host it claims', () => {
    for (const extra of [...each, SERVE])
      for (const host of ['localhost:47100', '127.0.0.1:47100', PUBLIC]) {
        const req = request({ host, ...extra })
        expect(cameThroughEntrance(req, entrance), `${host} ${JSON.stringify(extra)}`).toBe(true)
        expect(guardRequest(req, on)).toEqual({ allow: true, entrance })
      }
  })

  it('is refused while the gate is off, whatever its Host, on every path', () => {
    for (const extra of [...each, SERVE])
      for (const host of ['localhost:47131', '127.0.0.1:47131', '[::1]:47131']) {
        const verdict = guardRequest(request({ host, ...extra }), off)
        expect(verdict, `${host} ${JSON.stringify(extra)}`).toMatchObject({ allow: false, status: 403 })
      }
    // A direct request to the same board is answered as before.
    expect(guardRequest(request({ host: 'localhost:47131' }), off)).toEqual({ allow: true, entrance: null })
  })

  it('is refused while no entrance is configured: nothing goes through a proxy by default', () => {
    expect(guardRequest(request({ host: 'localhost:47100', ...SERVE }), plain)).toMatchObject({
      allow: false,
      status: 403,
      error: expect.stringMatching(/PUBLIC_ORIGIN/),
    })
  })

  it('counts forwarded headers only from a loopback peer; from any other they are ignored', () => {
    for (const peer of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', undefined, null])
      expect(isLoopbackPeer(peer), `${peer}`).toBe(true)
    for (const peer of ['192.168.1.20', '100.101.102.103', '::ffff:192.168.1.20', 'fd7a:115c:a1e0::1'])
      expect(isLoopbackPeer(peer), peer).toBe(false)

    const req = request({ host: 'localhost:47100', ...SERVE }, { peer: '192.168.1.20' })
    expect(cameThroughEntrance(req, entrance)).toBe(false)
    expect(guardRequest(req, on)).toEqual({ allow: true, entrance: null })
    expect(guardRequest(req, off)).toEqual({ allow: true, entrance: null })
    // An unknown peer counts as loopback: the headers then count.
    expect(guardRequest(request({ host: 'localhost:47100', ...SERVE }, { peer: null }), off)).toMatchObject({
      allow: false,
    })
    // The public host itself is the entrance from any peer.
    expect(cameThroughEntrance(request({ host: PUBLIC }, { peer: '192.168.1.20' }), entrance)).toBe(true)
  })

  it('is not a direct request just because the proxy kept a loopback Host, or because of X-Test-Actor', () => {
    expect(
      cameThroughEntrance(request({ host: 'localhost:47100', 'x-test-actor': 'human:qa' }), entrance),
    ).toBe(false)
    expect(cameThroughEntrance(request({ host: 'localhost:47100', ...SERVE }), null)).toBe(true)
  })
})

describe('a write with the gate cookie', () => {
  const write = (method: string, origin: string | null, extra: Record<string, string> = {}, cfg = on) =>
    guardRequest(
      request(
        {
          host: 'localhost:47100',
          cookie: 'theme=dark; gate_session=local-ok',
          ...(origin === null ? {} : { origin }),
          ...extra,
        },
        { method },
      ),
      cfg,
    )

  it("is refused from an origin that is not one of the board's", () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post'])
      for (const origin of [
        'https://evil.example',
        'http://localhost:47101',
        'http://localhost',
        'http://127.0.0.1:3000',
        'https://localhost:47100',
        'null',
        `https://${PUBLIC}:8443`,
        `http://${PUBLIC}`,
      ])
        expect(write(method, origin), `${method} ${origin}`).toMatchObject({ allow: false, status: 403 })
    // The public origin only counts when the entrance is configured.
    expect(write('POST', `https://${PUBLIC}`, {}, plain)).toMatchObject({ allow: false, status: 403 })
  })

  it("passes from the board's own origins: loopback on its own port, and the public origin", () => {
    expect(boardOrigins(on)).toEqual([
      'http://localhost:47100',
      'http://127.0.0.1:47100',
      'http://[::1]:47100',
      `https://${PUBLIC}`,
    ])
    for (const origin of boardOrigins(on))
      expect(write('POST', origin), origin).toEqual({ allow: true, entrance: null })
  })

  it('passes without an Origin (agents, curl), with a token, without the cookie, and for reads', () => {
    expect(write('POST', null)).toEqual({ allow: true, entrance: null })
    expect(write('POST', 'https://evil.example', { authorization: 'Bearer gate_local_token' })).toEqual({
      allow: true,
      entrance: null,
    })
    const noCookie = request({ host: 'localhost:47100', origin: 'https://evil.example' }, { method: 'POST' })
    expect(guardRequest(noCookie, on)).toEqual({ allow: true, entrance: null })
    for (const method of ['GET', 'HEAD', 'OPTIONS'])
      expect(write(method, 'https://evil.example'), method).toEqual({ allow: true, entrance: null })
  })

  it('is checked with the gate off too, against its own port', () => {
    const test = (origin: string) =>
      guardRequest(
        request({ host: '127.0.0.1:47131', cookie: 'gate_session=x', origin }, { method: 'POST' }),
        off,
      )
    expect(test('https://evil.example')).toMatchObject({ allow: false, status: 403 })
    expect(test('http://127.0.0.1:47100')).toMatchObject({ allow: false, status: 403 })
    expect(test('http://127.0.0.1:47131')).toEqual({ allow: true, entrance: null })
  })
})

describe('the login of the public gate', () => {
  it('is on the public gate, back to the same page on the public origin', () => {
    expect(loginLocation(publicRoute(entrance), '/projects/1?x=1')).toBe(
      `https://${PUBLIC}:8443/login?rd=https%3A%2F%2Fdevbox.example-tailnet.ts.net%2Fprojects%2F1%3Fx%3D1`,
    )
    expect(publicRoute(entrance)).toEqual({
      loginUrl: `https://${PUBLIC}:8443`,
      authUrl: 'http://127.0.0.1:47111',
      boardUrl: `https://${PUBLIC}`,
    })
  })
})

describe('guardConfig', () => {
  const keys = {
    PUBLIC_ORIGIN: `https://${PUBLIC}`,
    PUBLIC_GATE_URL: `https://${PUBLIC}:8443`,
    PUBLIC_GATE_AUTH_URL: 'http://127.0.0.1:47111',
  }

  it("is the board's: its port, its mode, and the entrance only with the gate on", () => {
    expect(guardConfig({ ...keys, PORT: '47264' })).toEqual({ gateOff: false, port: 47264, entrance })
    expect(guardConfig({ ...keys, BOARD_ENV: 'test', PORT: '47131' })).toEqual({
      gateOff: true,
      port: 47131,
      entrance: null,
    })
    expect(guardConfig({})).toEqual({ gateOff: false, port: 47100, entrance: null })
    expect(() => guardConfig({ PUBLIC_ORIGIN: keys.PUBLIC_ORIGIN })).toThrow(/together, or none/)
  })
})
