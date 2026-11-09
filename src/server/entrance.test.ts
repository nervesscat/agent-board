import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { type PublicEntrance, readAuthMode } from './config'
import {
  boardOrigins,
  cameThroughEntrance,
  type GuardConfig,
  guardBoardRequest,
  guardConfig,
  guardRequest,
  hostOf,
  isLoopbackPeer,
  isSignInPath,
  localSite,
  loginLocation,
  publicSite,
  refusalResponse,
} from './entrance'

const PUBLIC = 'devbox.example-tailnet.ts.net'
const entrance: PublicEntrance = { origin: `https://${PUBLIC}`, host: PUBLIC }
const dataDir = '/srv/board/data'

/** The live board with the entrance, the same without it, and a board without sign-in (test mode). */
const on: GuardConfig = { authOff: false, port: 47100, entrance, dataDir }
const plain: GuardConfig = { authOff: false, port: 47100, entrance: null, dataDir }
const off: GuardConfig = { authOff: true, port: 47131, entrance: null, dataDir }

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
        const verdict = guardRequest(request({ host, cookie: 'board_session_47100=local-ok' }), cfg)
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
      { cookie: 'board_session_47100=public-ok' },
      { authorization: 'Bearer some-agent-token' },
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

  it('is refused while sign-in is off, whatever its Host, on every path', () => {
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

describe('a write with the session cookie', () => {
  const write = (method: string, origin: string | null, extra: Record<string, string> = {}, cfg = on) =>
    guardRequest(
      request(
        {
          host: 'localhost:47100',
          cookie: 'theme=dark; board_session_47100=local-ok',
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
    expect(write('POST', 'https://evil.example', { authorization: 'Bearer some-agent-token' })).toEqual({
      allow: true,
      entrance: null,
    })
    const noCookie = request({ host: 'localhost:47100', origin: 'https://evil.example' }, { method: 'POST' })
    expect(guardRequest(noCookie, on)).toEqual({ allow: true, entrance: null })
    for (const method of ['GET', 'HEAD', 'OPTIONS'])
      expect(write(method, 'https://evil.example'), method).toEqual({ allow: true, entrance: null })
  })

  it("is checked under a preview's path whatever cookie comes with it: the preview's own, or none", () => {
    const preview = (headers: Record<string, string>, method = 'POST') => ({
      ...request({ host: 'localhost:47100', origin: 'https://evil.example', ...headers }, { method }),
      path: '/p/1/2/api/save',
    })
    expect(guardRequest(preview({ cookie: 'board_preview_1_2=abc' }), on)).toMatchObject({
      allow: false,
      status: 403,
    })
    // No credential at all: the guard lets it on, and the proxy answers 401 (previewProxy.test.ts).
    expect(guardRequest(preview({}), on)).toEqual({ allow: true, entrance: null })
    expect(guardRequest(preview({ cookie: 'board_preview_1_2=abc' }, 'GET'), on)).toEqual({
      allow: true,
      entrance: null,
    })
    expect(guardRequest(preview({ cookie: 'board_preview_1_2=abc', authorization: 'Bearer t' }), on)).toEqual(
      { allow: true, entrance: null },
    )
    expect(
      guardRequest(
        {
          ...preview({ cookie: 'board_preview_1_2=abc', origin: 'http://localhost:47100' }),
          path: '/p/1/2/x',
        },
        on,
      ),
    ).toEqual({ allow: true, entrance: null })
  })

  it("is only this board's cookie: a board on another port of localhost has its own", () => {
    const write = (cookie: string) =>
      guardRequest(
        request({ host: 'localhost:47100', cookie, origin: 'https://evil.example' }, { method: 'POST' }),
        on,
      )
    expect(write('board_session_47100=local-ok')).toMatchObject({ allow: false, status: 403 })
    expect(write('board_session_47101=x; board_session_47100=local-ok')).toMatchObject({ allow: false })
    expect(write('board_session_47101=x')).toEqual({ allow: true, entrance: null })
  })

  it('is checked with sign-in off too, against its own port', () => {
    const test = (origin: string) =>
      guardRequest(
        request({ host: '127.0.0.1:47131', cookie: 'board_session_47131=x', origin }, { method: 'POST' }),
        off,
      )
    expect(test('https://evil.example')).toMatchObject({ allow: false, status: 403 })
    expect(test('http://127.0.0.1:47100')).toMatchObject({ allow: false, status: 403 })
    expect(test('http://127.0.0.1:47131')).toEqual({ allow: true, entrance: null })
  })
})

describe('where a request signs in', () => {
  it('is localhost on this machine, the public host and origin through the entrance', () => {
    expect(localSite(47264)).toEqual({ rpId: 'localhost', origin: 'http://localhost:47264' })
    expect(publicSite(entrance)).toEqual({ rpId: PUBLIC, origin: `https://${PUBLIC}` })
  })

  it("is the board's own /login, relative, back to the same page after", () => {
    expect(loginLocation('/projects/1?x=1')).toBe('/login?next=%2Fprojects%2F1%3Fx%3D1')
  })

  it('opens only the sign-in pages and their endpoints without a session', () => {
    for (const path of ['/setup', '/login', '/enroll', '/api/auth/login/options', '/api/auth/logout'])
      expect(isSignInPath(path), path).toBe(true)
    for (const path of [
      '/',
      '/login/',
      '/setup.ts',
      '/api/auth/passkeys',
      '/api/auth/sessions',
      '/api/auth/enrol-links',
      '/api/me',
      '/@vite/client',
      '/src/server/auth.ts',
    ])
      expect(isSignInPath(path), path).toBe(false)
  })
})

describe('guardConfig', () => {
  const keys = { PUBLIC_ORIGIN: `https://${PUBLIC}`, DATA_DIR: dataDir }

  it("is the board's: its port, its mode, its data, and the entrance only with sign-in on", () => {
    expect(guardConfig({ ...keys, PORT: '47264' })).toEqual({
      authOff: false,
      port: 47264,
      entrance,
      dataDir: path.resolve(dataDir),
    })
    expect(guardConfig({ ...keys, BOARD_ENV: 'test', PORT: '47131' })).toEqual({
      authOff: true,
      port: 47131,
      entrance: null,
      dataDir: path.resolve(dataDir),
    })
    expect(guardConfig({})).toEqual({
      authOff: false,
      port: 47100,
      entrance: null,
      dataDir: path.resolve('data'),
    })
    expect(() => guardConfig({ PUBLIC_ORIGIN: 'http://devbox' })).toThrow(/PUBLIC_ORIGIN must be/)
  })
})

describe('the guard on a request to the board itself', () => {
  const production = readAuthMode({})
  const test = readAuthMode({ BOARD_ENV: 'test' })
  /** A web request as srvx's Node server hands it on, with the connection it came on. */
  const web = (target: string, headers: Record<string, string>, peer = '127.0.0.1') =>
    Object.assign(new Request(target, { headers }), {
      runtime: { node: { req: { socket: { remoteAddress: peer } } } },
    })

  it('gives the verdict guardRequest gives for its method, headers and peer', () => {
    const cases: [Request, PublicEntrance | null][] = [
      [web('http://evil.example//evil.example/api/me', { host: 'evil.example' }), entrance],
      [web(`http://${PUBLIC}/`, { host: PUBLIC, ...SERVE }), entrance],
      [web(`http://${PUBLIC}/`, { host: PUBLIC, ...SERVE }), null],
      [web('http://127.0.0.1:47100//api/me', { host: '127.0.0.1:47100' }), null],
      [
        web(
          'http://127.0.0.1:47100/',
          { host: '127.0.0.1:47100', 'x-forwarded-for': '1.2.3.4' },
          '192.168.1.20',
        ),
        null,
      ],
    ]
    for (const [req, served] of cases)
      for (const auth of [production, test]) {
        const cfg = { authOff: auth.off, port: 47100, entrance: auth.off ? null : served, dataDir }
        const peer = (req as unknown as { runtime: { node: { req: { socket: { remoteAddress: string } } } } })
          .runtime.node.req.socket.remoteAddress
        expect(guardBoardRequest(req, auth, cfg.entrance), req.url).toEqual(
          guardRequest({ method: req.method, headers: req.headers, peer }, cfg),
        )
      }
  })

  it('answers a refusal with its status and reason', async () => {
    const verdict = guardBoardRequest(
      web('http://evil.example//api/me', { host: 'evil.example' }),
      production,
      null,
    )
    expect(verdict).toMatchObject({ allow: false, status: 403 })
    if (verdict.allow) return
    const res = refusalResponse(verdict)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'the board does not answer for the host "evil.example"' })
  })
})
