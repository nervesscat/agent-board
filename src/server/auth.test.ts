import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

// auth.ts reaches the database through actors.ts, and config.ts reads DATA_DIR as it loads: point it
// at a throwaway directory before either is imported.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp
const { config, readAuthMode, readPublicEntrance } = await import('./config')
const { sessionCookieName } = await import('./credentials')
const { localSite, publicSite } = await import('./entrance')

const PUBLIC = 'devbox.example-tailnet.ts.net'
const entrance = readPublicEntrance({ PUBLIC_ORIGIN: `https://${PUBLIC}` })!

// A signed-in board: the account, a passkey on each origin with a session each, and an agent token.
const SESSION = { local: 'session-on-localhost', public: 'session-on-the-tailnet' }
const TOKEN = 'token-of-claude'

let auth: typeof import('./auth')
beforeAll(async () => {
  auth = await import('./auth')
  const { db, schema } = await import('#/db')
  const { hashSecret } = await import('./credentials')
  db.insert(schema.actors)
    .values([
      { name: 'old-laptop', kind: 'human', lastSeenAt: '2026-01-01T00:00:00.000Z' },
      { name: 'enrique-desktop', kind: 'human', lastSeenAt: '2026-09-01T00:00:00.000Z' },
      { name: 'some-agent', kind: 'agent', lastSeenAt: '2026-10-01T00:00:00.000Z' },
    ])
    .run()
  db.insert(schema.account).values({ id: 1, name: 'Enrique', userHandle: 'AAAA' }).run()
  const future = '2099-01-01T00:00:00.000Z'
  for (const [rpId, token] of [
    ['localhost', SESSION.local],
    [PUBLIC, SESSION.public],
  ] as const) {
    const { id } = db
      .insert(schema.passkeys)
      .values({ credentialId: `cred-${rpId}`, publicKey: 'AAAA', rpId, name: rpId })
      .returning()
      .get()
    db.insert(schema.sessions)
      .values({ tokenHash: hashSecret(token), passkeyId: id, expiresAt: future, lastSeenAt: future })
      .run()
  }
  db.insert(schema.agentTokens)
    .values({ tokenHash: hashSecret(TOKEN), name: 'claude', expiresAt: future })
    .run()
})

const production = readAuthMode({})
const devOn = readAuthMode({ BOARD_ENV: 'development' })
const devOff = readAuthMode({ BOARD_ENV: 'development', AUTH: 'off', DEV_HUMAN: 'enrique' })
const test = readAuthMode({ BOARD_ENV: 'test' })

const req = (headers: Record<string, string> = {}) => new Request('http://localhost/api/me', { headers })
const cookie = (value: string) => ({ cookie: `theme=dark; ${sessionCookieName(config.port)}=${value}` })
const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

describe('with sign-in on (production, and development without AUTH=off)', () => {
  for (const [label, mode] of [
    ['production', production],
    ['development', devOn],
  ] as const) {
    it(`${label}: ignores X-Test-Actor, and signs in by session cookie or agent token`, async () => {
      expect(await auth.callerOf(req({ 'x-test-actor': 'human:someone' }), mode)).toBeNull()
      expect(await auth.callerOf(req({ 'x-test-actor': 'agent:bot' }), mode)).toBeNull()
      expect(auth.isAgent(req({ 'x-test-actor': 'agent:bot' }), mode)).toBe(false)

      const human = { ...cookie(SESSION.local), 'x-test-actor': 'agent:bot' }
      expect(await auth.callerOf(req(human), mode)).toEqual({ name: 'Enrique', kind: 'human' })
      expect(auth.isAgent(req(human), mode)).toBe(false)
      const agent = { ...bearer(TOKEN), 'x-test-actor': 'human:me' }
      expect(await auth.callerOf(req(agent), mode)).toEqual({ name: 'claude', kind: 'agent' })
      expect(auth.isAgent(req(agent), mode)).toBe(true)
    })
  }

  it('turns away a cookie or token the board never gave, and a bad token whatever cookie comes with it', async () => {
    for (const headers of [
      cookie('made-up'),
      bearer('made-up'),
      { ...bearer('made-up'), ...cookie(SESSION.local) },
      { authorization: 'Bearer' },
      // The cookie of the sign-in the board had before its own: nobody's session here.
      { cookie: `gate_session=${SESSION.local}` },
    ])
      expect(await auth.callerOf(req(headers), production), JSON.stringify(headers)).toBeNull()
  })
})

describe('development with AUTH=off', () => {
  it('makes every request the human, whatever it carries', async () => {
    for (const headers of [
      {} as Record<string, string>,
      { 'x-test-actor': 'agent:bot' },
      bearer(TOKEN),
      cookie(SESSION.local),
      bearer('made-up'),
    ]) {
      expect(await auth.callerOf(req(headers), devOff)).toEqual({ name: 'enrique', kind: 'human' })
      expect(auth.isAgent(req(headers), devOff)).toBe(false)
    }
  })

  it('without DEV_HUMAN, is the human the board saw sign in last', async () => {
    const mode = readAuthMode({ BOARD_ENV: 'development', AUTH: 'off' })
    expect(await auth.callerOf(req(), mode)).toEqual({ name: 'enrique-desktop', kind: 'human' })
  })
})

describe('test', () => {
  it('takes the caller from X-Test-Actor, and the human without it', async () => {
    expect(await auth.callerOf(req({ 'x-test-actor': 'agent:builder' }), test)).toEqual({
      name: 'builder',
      kind: 'agent',
    })
    expect(await auth.callerOf(req({ 'x-test-actor': 'human: qa ' }), test)).toEqual({
      name: 'qa',
      kind: 'human',
    })
    expect(await auth.callerOf(req(), test)).toEqual({ name: 'human', kind: 'human' })
    // A real token or session does not change who you are: only the header does.
    expect(await auth.callerOf(req(bearer(TOKEN)), test)).toEqual({ name: 'human', kind: 'human' })
    expect(await auth.callerOf(req(cookie(SESSION.local)), test)).toEqual({ name: 'human', kind: 'human' })
    expect(await auth.callerOf(req(), readAuthMode({ BOARD_ENV: 'test', TEST_HUMAN: 'tester' }))).toEqual({
      name: 'tester',
      kind: 'human',
    })
  })

  it('turns away a malformed X-Test-Actor', async () => {
    for (const value of ['', 'bot', 'robot:bot', 'agent:', 'human:  ', `agent:${'x'.repeat(81)}`])
      expect(await auth.callerOf(req({ 'x-test-actor': value }), test)).toBeNull()
  })

  it('isAgent is true for agent: and only for agent:', () => {
    expect(auth.isAgent(req({ 'x-test-actor': 'agent:builder' }), test)).toBe(true)
    expect(auth.isAgent(req({ 'x-test-actor': 'human:qa' }), test)).toBe(false)
    expect(auth.isAgent(req(), test)).toBe(false)
    expect(auth.isAgent(req(bearer(TOKEN)), test)).toBe(false)
    expect(auth.isAgent(req({ 'x-test-actor': 'bot' }), test)).toBe(false)
  })
})

describe('the origin the request used (README: "Using it from other devices")', () => {
  /** What `tailscale serve` adds to a request from a tailnet user. */
  const SERVE = {
    'x-forwarded-for': '100.101.102.103',
    'x-forwarded-host': PUBLIC,
    'x-forwarded-proto': 'https',
    'tailscale-user-login': 'someone@example.com',
    'tailscale-user-name': 'Someone',
  }
  const through = (headers: Record<string, string> = {}, target = '/api/me') =>
    new Request(`http://${PUBLIC}${target}`, { headers: { host: PUBLIC, ...SERVE, ...headers } })
  const direct = (headers: Record<string, string> = {}, target = '/api/me') =>
    new Request(`http://localhost:47100${target}`, { headers: { host: 'localhost:47100', ...headers } })
  const fromLan = (headers: Record<string, string>) =>
    Object.assign(direct({ 'x-forwarded-host': PUBLIC, ...headers }), {
      // How srvx's Node request carries the connection the request came on.
      runtime: { node: { req: { socket: { remoteAddress: '192.168.1.20' } } } },
    })
  /** As src/start.ts asks: on the site of the origin the request came through, with this entrance. */
  const caller = (request: Request) => auth.callerOf(request, production, auth.siteOf(request, entrance))

  it('signs a session in only on the origin its passkey belongs to', async () => {
    expect(auth.siteOf(through(), entrance)).toEqual(publicSite(entrance))
    expect(auth.siteOf(direct(), entrance)).toEqual(localSite(47100))
    expect(await caller(through(cookie(SESSION.public)))).toEqual({ name: 'Enrique', kind: 'human' })
    expect(await caller(direct(cookie(SESSION.local)))).toEqual({ name: 'Enrique', kind: 'human' })
    expect(await caller(direct(cookie(SESSION.public)))).toBeNull()
    expect(await caller(through(cookie(SESSION.local)))).toBeNull()
  })

  it('signs an agent token in on both origins', async () => {
    expect(await caller(through(bearer(TOKEN)))).toEqual({ name: 'claude', kind: 'agent' })
    expect(await caller(direct(bearer(TOKEN)))).toEqual({ name: 'claude', kind: 'agent' })
    expect(auth.isAgent(through(bearer(TOKEN)), production)).toBe(true)
  })

  it('signs nobody in for a proxied request while no entrance is configured (as here, by default)', async () => {
    const request = through(cookie(SESSION.public))
    expect(auth.siteOf(request)).toBeNull()
    expect(await auth.callerOf(request, production)).toBeNull()
    expect(await auth.authenticate(request)).toBeNull()
    expect(await auth.callerOf(through(bearer(TOKEN)), production)).toBeNull()
    // Straight to the board, the default is this machine's localhost, as before.
    expect(await auth.callerOf(direct(cookie(SESSION.local)), production)).toMatchObject({ name: 'Enrique' })
  })

  it('remembers who signed in through the entrance, as on localhost', async () => {
    const request = through(cookie(SESSION.public))
    expect(await auth.authenticate(request, auth.siteOf(request, entrance))).toBe('Enrique')
  })

  it('ignores forwarded headers from a peer that is not loopback: localhost, and not this machine', async () => {
    const request = fromLan(cookie(SESSION.local))
    expect(auth.peerOf(request)).toBe('192.168.1.20')
    expect(auth.siteOf(request, entrance)).toEqual(localSite(47100))
    expect(await caller(request)).toMatchObject({ name: 'Enrique' })
    expect(await caller(fromLan(cookie(SESSION.public)))).toBeNull()
    // The same headers from loopback (the proxy on this machine) are the entrance.
    expect(auth.siteOf(direct({ 'x-forwarded-host': PUBLIC }), entrance)).toEqual(publicSite(entrance))
    // Neither is on this machine, as setup needs.
    expect(auth.onThisMachine(request, entrance)).toBe(false)
    expect(auth.onThisMachine(direct({ 'x-forwarded-host': PUBLIC }), entrance)).toBe(false)
    expect(auth.onThisMachine(direct(), entrance)).toBe(true)
  })

  it('never takes a forwarded host for an origin', () => {
    const request = direct({ 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' })
    expect(auth.siteOf(request, entrance)).toEqual(publicSite(entrance))
    expect(auth.siteOf(request, null)).toBeNull()
  })

  it('takes no Tailscale-User-* header for a sign-in, as the human or as an agent', async () => {
    for (const headers of [
      { 'tailscale-user-login': 'someone@example.com', 'tailscale-user-name': 'Someone' },
      SERVE,
      { ...SERVE, 'x-test-actor': 'human:someone' },
      { ...SERVE, 'x-test-actor': 'agent:bot' },
    ])
      for (const request of [through(headers), direct(headers)]) {
        for (const mode of [production, devOn])
          expect(await auth.callerOf(request, mode, auth.siteOf(request, entrance))).toBeNull()
        expect(auth.isAgent(request, production)).toBe(false)
      }
  })
})
