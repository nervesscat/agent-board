import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// auth.ts reaches the database through actors.ts, and config.ts reads DATA_DIR as it loads: point it
// at a throwaway directory before either is imported.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp
const { config, readAuthMode, readPublicEntrance } = await import('./config')
const { publicRoute } = await import('./entrance')

let auth: typeof import('./auth')
beforeAll(async () => {
  auth = await import('./auth')
  const { db, schema } = await import('#/db')
  db.insert(schema.actors)
    .values([
      { name: 'old-laptop', kind: 'human', lastSeenAt: '2026-01-01T00:00:00.000Z' },
      { name: 'enrique-desktop', kind: 'human', lastSeenAt: '2026-09-01T00:00:00.000Z' },
      { name: 'some-agent', kind: 'agent', lastSeenAt: '2026-10-01T00:00:00.000Z' },
    ])
    .run()
})
afterEach(() => vi.unstubAllGlobals())

const production = readAuthMode({})
const devGate = readAuthMode({ BOARD_ENV: 'development' })
const devOff = readAuthMode({ BOARD_ENV: 'development', AUTH: 'off', DEV_HUMAN: 'enrique' })
const test = readAuthMode({ BOARD_ENV: 'test' })

const req = (headers: Record<string, string> = {}) => new Request('http://localhost/api/me', { headers })

/** A gate that lets every cookie and token in, naming the caller after what it was shown. */
function fakeGate() {
  const gate = vi.fn(async (_url: string, init: RequestInit) => {
    const h = new Headers(init.headers)
    const name = h.get('authorization') ? 'token-agent' : 'passkey-human'
    return new Response(null, { status: 200, headers: { 'x-gate-device': name } })
  })
  vi.stubGlobal('fetch', gate)
  return gate
}

describe('with the gate (production, and development without AUTH=off)', () => {
  for (const [label, mode] of [
    ['production', production],
    ['development', devGate],
  ] as const) {
    it(`${label}: ignores X-Test-Actor and asks the gate`, async () => {
      const gate = fakeGate()
      expect(await auth.callerOf(req({ 'x-test-actor': 'human:someone' }), mode)).toBeNull()
      expect(await auth.callerOf(req({ 'x-test-actor': 'agent:bot' }), mode)).toBeNull()
      expect(gate).not.toHaveBeenCalled()
      expect(auth.isAgent(req({ 'x-test-actor': 'agent:bot' }), mode)).toBe(false)

      const cookie = { cookie: `gate_session=${label}`, 'x-test-actor': 'agent:bot' }
      expect(await auth.callerOf(req(cookie), mode)).toEqual({ name: 'passkey-human', kind: 'human' })
      expect(auth.isAgent(req(cookie), mode)).toBe(false)
      const token = { authorization: `Bearer gate_${label}`, 'x-test-actor': 'human:me' }
      expect(await auth.callerOf(req(token), mode)).toEqual({ name: 'token-agent', kind: 'agent' })
      expect(auth.isAgent(req(token), mode)).toBe(true)
      expect(gate).toHaveBeenCalledTimes(2)
    })
  }

  it('turns away a caller the gate refuses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 401 })),
    )
    expect(await auth.callerOf(req({ cookie: 'gate_session=refused' }), production)).toBeNull()
  })
})

describe('development with AUTH=off', () => {
  it('makes every request the human, whatever it carries, without asking the gate', async () => {
    const gate = fakeGate()
    for (const headers of [
      {} as Record<string, string>,
      { 'x-test-actor': 'agent:bot' },
      { authorization: 'Bearer gate_x' },
      { cookie: 'gate_session=x' },
    ]) {
      expect(await auth.callerOf(req(headers), devOff)).toEqual({ name: 'enrique', kind: 'human' })
      expect(auth.isAgent(req(headers), devOff)).toBe(false)
    }
    expect(gate).not.toHaveBeenCalled()
  })

  it('without DEV_HUMAN, is the human the board saw sign in last', async () => {
    const mode = readAuthMode({ BOARD_ENV: 'development', AUTH: 'off' })
    expect(await auth.callerOf(req(), mode)).toEqual({ name: 'enrique-desktop', kind: 'human' })
  })
})

describe('test', () => {
  it('takes the caller from X-Test-Actor, and the human without it', async () => {
    const gate = fakeGate()
    expect(await auth.callerOf(req({ 'x-test-actor': 'agent:builder' }), test)).toEqual({
      name: 'builder',
      kind: 'agent',
    })
    expect(await auth.callerOf(req({ 'x-test-actor': 'human: qa ' }), test)).toEqual({
      name: 'qa',
      kind: 'human',
    })
    expect(await auth.callerOf(req(), test)).toEqual({ name: 'human', kind: 'human' })
    // A gate cookie or token does not change who you are: only the header does.
    expect(await auth.callerOf(req({ authorization: 'Bearer gate_x' }), test)).toEqual({
      name: 'human',
      kind: 'human',
    })
    expect(await auth.callerOf(req(), readAuthMode({ BOARD_ENV: 'test', TEST_HUMAN: 'tester' }))).toEqual({
      name: 'tester',
      kind: 'human',
    })
    expect(gate).not.toHaveBeenCalled()
  })

  it('turns away a malformed X-Test-Actor', async () => {
    for (const value of ['', 'bot', 'robot:bot', 'agent:', 'human:  ', `agent:${'x'.repeat(81)}`])
      expect(await auth.callerOf(req({ 'x-test-actor': value }), test)).toBeNull()
  })

  it('isAgent is true for agent: and only for agent:', () => {
    expect(auth.isAgent(req({ 'x-test-actor': 'agent:builder' }), test)).toBe(true)
    expect(auth.isAgent(req({ 'x-test-actor': 'human:qa' }), test)).toBe(false)
    expect(auth.isAgent(req(), test)).toBe(false)
    expect(auth.isAgent(req({ authorization: 'Bearer gate_x' }), test)).toBe(false)
    expect(auth.isAgent(req({ 'x-test-actor': 'bot' }), test)).toBe(false)
  })
})

describe('the gate of the origin the request used (README: "Using it from other devices")', () => {
  const PUBLIC = 'devbox.example-tailnet.ts.net'
  const entrance = readPublicEntrance({
    PUBLIC_ORIGIN: `https://${PUBLIC}`,
    PUBLIC_GATE_URL: `https://${PUBLIC}:8443`,
    PUBLIC_GATE_AUTH_URL: 'http://127.0.0.1:47111',
  })!
  const LOCAL_AUTH = `${config.gateUrl}/auth`
  const PUBLIC_AUTH = 'http://127.0.0.1:47111/auth'
  /** What `tailscale serve` adds to a request from a tailnet user. */
  const SERVE = {
    'x-forwarded-for': '100.101.102.103',
    'x-forwarded-host': PUBLIC,
    'x-forwarded-proto': 'https',
    'tailscale-user-login': 'someone@example.com',
    'tailscale-user-name': 'Someone',
  }

  /**
   * Two gates, each knowing only its own sessions and tokens (by prefix, so each case can use values of
   * its own past the answers cached by the one before), and every /auth either was asked.
   */
  function twoGates() {
    const asked: { url: string; credential: string | null }[] = []
    const known = new Map([
      [
        LOCAL_AUTH,
        [
          ['gate_session=local-ok', 'local-desktop'],
          ['Bearer gate_local_token', 'local-agent'],
        ],
      ],
      [
        PUBLIC_AUTH,
        [
          ['gate_session=public-ok', 'public-phone'],
          ['Bearer gate_public_token', 'public-agent'],
        ],
      ],
    ])
    const gate = vi.fn(async (url: string, init: RequestInit) => {
      const h = new Headers(init.headers)
      const credential = h.get('authorization') ?? h.get('cookie')
      asked.push({ url, credential })
      const name = known.get(url)?.find(([prefix]) => credential?.startsWith(prefix!))?.[1]
      return name
        ? new Response(null, { status: 200, headers: { 'x-gate-device': name } })
        : Response.json({ error: 'sign in' }, { status: 401 })
    })
    vi.stubGlobal('fetch', gate)
    return asked
  }

  const through = (headers: Record<string, string> = {}, target = '/api/me') =>
    new Request(`http://${PUBLIC}${target}`, { headers: { host: PUBLIC, ...SERVE, ...headers } })
  const direct = (headers: Record<string, string> = {}, target = '/api/me') =>
    new Request(`http://localhost:47100${target}`, { headers: { host: 'localhost:47100', ...headers } })
  /** As src/start.ts asks: the gate of the route the request takes, with this entrance configured. */
  const caller = (request: Request) => auth.callerOf(request, production, auth.routeOf(request, entrance))

  it("asks only the gate of the origin used, and keeps each gate's answers apart", async () => {
    const asked = twoGates()
    expect(await caller(through({ cookie: 'gate_session=public-ok-1' }))).toEqual({
      name: 'public-phone',
      kind: 'human',
    })
    expect(await caller(through({ authorization: 'Bearer gate_public_token-1' }))).toEqual({
      name: 'public-agent',
      kind: 'agent',
    })
    expect(await caller(through({ authorization: 'Bearer gate_local_token-1' }))).toBeNull()
    expect(await caller(direct({ authorization: 'Bearer gate_local_token-1' }))).toEqual({
      name: 'local-agent',
      kind: 'agent',
    })
    expect(await caller(direct({ authorization: 'Bearer gate_public_token-1' }))).toBeNull()
    expect(await caller(direct({ cookie: 'gate_session=local-ok-1' }))).toEqual({
      name: 'local-desktop',
      kind: 'human',
    })
    // Right after the public gate said yes to it, the same cookie straight to the board: the
    // localhost gate is asked, and says no. And the other way round.
    expect(await caller(direct({ cookie: 'gate_session=public-ok-1' }))).toBeNull()
    expect(await caller(through({ cookie: 'gate_session=local-ok-1' }))).toBeNull()
    expect(asked).toEqual([
      { url: PUBLIC_AUTH, credential: 'gate_session=public-ok-1' },
      { url: PUBLIC_AUTH, credential: 'Bearer gate_public_token-1' },
      { url: PUBLIC_AUTH, credential: 'Bearer gate_local_token-1' },
      { url: LOCAL_AUTH, credential: 'Bearer gate_local_token-1' },
      { url: LOCAL_AUTH, credential: 'Bearer gate_public_token-1' },
      { url: LOCAL_AUTH, credential: 'gate_session=local-ok-1' },
      { url: LOCAL_AUTH, credential: 'gate_session=public-ok-1' },
      { url: PUBLIC_AUTH, credential: 'gate_session=local-ok-1' },
    ])
    // Each answer is cached under its gate: asked again, nobody is asked, and nothing crosses over.
    expect(await caller(through({ cookie: 'gate_session=public-ok-1' }))).toMatchObject({
      name: 'public-phone',
    })
    expect(await caller(direct({ cookie: 'gate_session=public-ok-1' }))).toBeNull()
    expect(await caller(direct({ cookie: 'gate_session=local-ok-1' }))).toMatchObject({
      name: 'local-desktop',
    })
    expect(asked).toHaveLength(8)
    // A token through the entrance is an agent, as on localhost.
    expect(auth.isAgent(through({ authorization: 'Bearer gate_public_token-1' }), production)).toBe(true)
  })

  it('asks no gate for a proxied request while no entrance is configured (as here, by default)', async () => {
    const asked = twoGates()
    const request = through({
      cookie: 'gate_session=public-ok-2',
      authorization: 'Bearer gate_public_token-2',
    })
    expect(auth.routeOf(request)).toBeNull()
    expect(await auth.callerOf(request, production)).toBeNull()
    expect(await auth.authenticate(request)).toBeNull()
    // Straight to the board, the default is the localhost gate, as before.
    expect(await auth.callerOf(direct({ cookie: 'gate_session=local-ok-2' }), production)).toMatchObject({
      name: 'local-desktop',
    })
    expect(asked).toEqual([{ url: LOCAL_AUTH, credential: 'gate_session=local-ok-2' }])
  })

  it('remembers who signed in through the entrance, as on localhost', async () => {
    twoGates()
    const request = through({ cookie: 'gate_session=public-ok-3' })
    expect(await auth.authenticate(request, auth.routeOf(request, entrance))).toBe('public-phone')
  })

  it("sends a browser to the login of its origin's gate; on localhost exactly as before", () => {
    const page = { accept: 'text/html' }
    const local = auth.loginRedirect(direct(page, '/projects/1?x=1'))
    expect(local.status).toBe(302)
    expect(local.headers.get('location')).toBe(
      'http://localhost:47110/login?rd=http%3A%2F%2Flocalhost%3A47100%2Fprojects%2F1%3Fx%3D1',
    )
    // Byte for byte the redirect it always was: GATE_URL/login?rd= and BOARD_URL with the path and query.
    expect(local.headers.get('location')).toBe(
      `${config.gateUrl}/login?rd=${encodeURIComponent(`${config.boardUrl}/projects/1?x=1`)}`,
    )
    const routed = direct(page, '/projects/1?x=1')
    expect(auth.loginRedirect(routed, auth.routeOf(routed, entrance)!).headers.get('location')).toBe(
      local.headers.get('location'),
    )
    const tailnet = through(page, '/projects/1?x=1')
    const remote = auth.loginRedirect(tailnet, auth.routeOf(tailnet, entrance)!)
    expect(remote.status).toBe(302)
    expect(remote.headers.get('location')).toBe(
      'https://devbox.example-tailnet.ts.net:8443/login?rd=https%3A%2F%2Fdevbox.example-tailnet.ts.net%2Fprojects%2F1%3Fx%3D1',
    )
    expect(auth.isBrowserNavigation(tailnet)).toBe(true)
    expect(auth.isBrowserNavigation(through())).toBe(false)
  })

  it('ignores forwarded headers from a peer that is not loopback: the localhost gate and its login', async () => {
    const asked = twoGates()
    const fromLan = (headers: Record<string, string>) =>
      Object.assign(direct({ 'x-forwarded-host': PUBLIC, accept: 'text/html', ...headers }, '/projects/1'), {
        // How srvx's Node request carries the connection the request came on.
        runtime: { node: { req: { socket: { remoteAddress: '192.168.1.20' } } } },
      })
    const request = fromLan({ cookie: 'gate_session=local-ok-4' })
    expect(auth.peerOf(request)).toBe('192.168.1.20')
    expect(auth.routeOf(request, entrance)).toEqual(auth.localRoute())
    expect(await caller(request)).toMatchObject({ name: 'local-desktop' })
    expect(await caller(fromLan({ cookie: 'gate_session=public-ok-4' }))).toBeNull()
    expect(auth.loginRedirect(request, auth.routeOf(request, entrance)!).headers.get('location')).toBe(
      'http://localhost:47110/login?rd=http%3A%2F%2Flocalhost%3A47100%2Fprojects%2F1',
    )
    expect(asked.map((a) => a.url)).toEqual([LOCAL_AUTH, LOCAL_AUTH])
    // The same headers from loopback (the proxy on this machine) are the entrance.
    expect(auth.routeOf(direct({ 'x-forwarded-host': PUBLIC }), entrance)).toEqual(publicRoute(entrance))
  })

  it('never takes a forwarded host for an origin: neither the gate asked nor rd names it', async () => {
    const asked = twoGates()
    const request = direct(
      { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https', cookie: 'gate_session=x-5' },
      '/projects/1?x=1',
    )
    const route = auth.routeOf(request, entrance)!
    expect(route).toEqual(publicRoute(entrance))
    expect(await auth.callerOf(request, production, route)).toBeNull()
    expect(asked).toEqual([{ url: PUBLIC_AUTH, credential: 'gate_session=x-5' }])
    const location = auth.loginRedirect(request, route).headers.get('location')!
    expect(location).not.toMatch(/evil/)
    expect(location).toBe(
      'https://devbox.example-tailnet.ts.net:8443/login?rd=https%3A%2F%2Fdevbox.example-tailnet.ts.net%2Fprojects%2F1%3Fx%3D1',
    )
    // With no entrance configured there is no gate to ask at all.
    expect(auth.routeOf(request, null)).toBeNull()
    expect(await auth.callerOf(request, production, auth.routeOf(request, null))).toBeNull()
    expect(asked).toHaveLength(1)
  })

  it('takes no Tailscale-User-* header for a sign-in, as the human or as an agent', async () => {
    const asked = twoGates()
    for (const headers of [
      { 'tailscale-user-login': 'someone@example.com', 'tailscale-user-name': 'Someone' },
      SERVE,
      { ...SERVE, 'x-test-actor': 'human:someone' },
      { ...SERVE, 'x-test-actor': 'agent:bot' },
    ])
      for (const request of [through(headers), direct(headers)]) {
        for (const mode of [production, devGate])
          expect(await auth.callerOf(request, mode, auth.routeOf(request, entrance))).toBeNull()
        expect(auth.isAgent(request, production)).toBe(false)
      }
    expect(asked).toEqual([])
  })
})
