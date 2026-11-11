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

/** A caller as callerOf answers it: the human, or an agent with its credential's role. */
const asHuman = (name: string) => ({ name, kind: 'human', role: 'human', parent: '', token: null })
const asWorker = (name: string) => ({ name, kind: 'agent', role: 'worker', parent: '', token: name })

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
      expect(await auth.callerOf(req(human), mode)).toEqual(asHuman('Enrique'))
      expect(auth.isAgent(req(human), mode)).toBe(false)
      const agent = { ...bearer(TOKEN), 'x-test-actor': 'human:me' }
      expect(await auth.callerOf(req(agent), mode)).toEqual(asWorker('claude'))
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
      expect(await auth.callerOf(req(headers), devOff)).toEqual(asHuman('enrique'))
      expect(auth.isAgent(req(headers), devOff)).toBe(false)
    }
  })

  it('without DEV_HUMAN, is the human the board saw sign in last', async () => {
    const mode = readAuthMode({ BOARD_ENV: 'development', AUTH: 'off' })
    expect(await auth.callerOf(req(), mode)).toEqual(asHuman('enrique-desktop'))
  })
})

describe('test', () => {
  it('takes the caller from X-Test-Actor, and the human without it', async () => {
    expect(await auth.callerOf(req({ 'x-test-actor': 'agent:builder' }), test)).toEqual(asWorker('builder'))
    expect(await auth.callerOf(req({ 'x-test-actor': 'human: qa ' }), test)).toEqual(asHuman('qa'))
    expect(await auth.callerOf(req(), test)).toEqual(asHuman('human'))
    // A real token or session does not change who you are: only the header does.
    expect(await auth.callerOf(req(bearer(TOKEN)), test)).toEqual(asHuman('human'))
    expect(await auth.callerOf(req(cookie(SESSION.local)), test)).toEqual(asHuman('human'))
    expect(await auth.callerOf(req(), readAuthMode({ BOARD_ENV: 'test', TEST_HUMAN: 'tester' }))).toEqual(
      asHuman('tester'),
    )
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
    expect(await caller(through(cookie(SESSION.public)))).toEqual(asHuman('Enrique'))
    expect(await caller(direct(cookie(SESSION.local)))).toEqual(asHuman('Enrique'))
    expect(await caller(direct(cookie(SESSION.public)))).toBeNull()
    expect(await caller(through(cookie(SESSION.local)))).toBeNull()
  })

  it('signs an agent token in on both origins', async () => {
    expect(await caller(through(bearer(TOKEN)))).toEqual(asWorker('claude'))
    expect(await caller(direct(bearer(TOKEN)))).toEqual(asWorker('claude'))
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

describe('roles and sub-identities', () => {
  const ORCH_TOKEN = 'token-of-orch'
  const OLD_TOKEN = 'token-of-an-older-board'
  beforeAll(async () => {
    const { db, schema } = await import('#/db')
    const { hashSecret } = await import('./credentials')
    const future = '2099-01-01T00:00:00.000Z'
    db.insert(schema.agentTokens)
      .values({ tokenHash: hashSecret(ORCH_TOKEN), name: 'orch', expiresAt: future, role: 'orchestrator' })
      .run()
    // A token made before roles existed: the column's default.
    db.$client
      .prepare('insert into agent_tokens (token_hash, name, expires_at) values (?, ?, ?)')
      .run(hashSecret(OLD_TOKEN), 'older', future)
  })
  const named = (token: string, name: string) => req({ ...bearer(token), 'x-agent-name': name })
  const actorRow = async (name: string) => {
    const { db, schema } = await import('#/db')
    const { eq } = await import('drizzle-orm')
    return db.select().from(schema.actors).where(eq(schema.actors.name, name)).get()
  }

  it("signs a token in with its role: an orchestrator's, else a worker (a token from before roles too)", async () => {
    for (const mode of [production, devOn]) {
      expect(await auth.callerOf(req(bearer(ORCH_TOKEN)), mode)).toEqual({
        name: 'orch',
        kind: 'agent',
        role: 'orchestrator',
        parent: '',
        token: 'orch',
      })
      expect(await auth.callerOf(req(bearer(TOKEN)), mode)).toEqual(asWorker('claude'))
      expect(await auth.callerOf(req(bearer(OLD_TOKEN)), mode)).toEqual(asWorker('older'))
    }
  })

  it('makes the call X-Agent-Name names, <token>/<name>: always a worker, its parent before the last /', async () => {
    expect(await auth.callerOf(named(ORCH_TOKEN, 'orch/worker-1'), production)).toEqual({
      name: 'orch/worker-1',
      kind: 'agent',
      role: 'worker',
      parent: 'orch',
      token: 'orch',
    })
    expect(await auth.callerOf(named(ORCH_TOKEN, ' orch/a/b.c/d_e '), production)).toMatchObject({
      name: 'orch/a/b.c/d_e',
      role: 'worker',
      parent: 'orch/a/b.c',
    })
    expect(await auth.callerOf(named(TOKEN, 'claude/sub'), production)).toMatchObject({
      role: 'worker',
      parent: 'claude',
    })
    // The token's own name is the token itself.
    expect(await auth.callerOf(named(ORCH_TOKEN, 'orch'), production)).toMatchObject({
      name: 'orch',
      role: 'orchestrator',
      parent: '',
    })
    // What the request keeps for the handlers.
    const request = named(ORCH_TOKEN, 'orch/worker-1')
    await auth.callerOf(request, production)
    expect(auth.callerInfo(request)).toMatchObject({ name: 'orch/worker-1', role: 'worker' })
    expect(auth.roleOf(request)).toBe('worker')
    expect(auth.isAgent(request, production)).toBe(true)
  })

  it('callerInfo with no caller remembered: a worker for an agent request, the human only otherwise', () => {
    // Never through callerOf: nothing is remembered for these requests, and the board runs as production.
    for (const headers of [
      bearer(ORCH_TOKEN),
      bearer(TOKEN),
      { ...bearer(ORCH_TOKEN), 'x-agent-name': 'orch' },
    ]) {
      const request = req(headers)
      expect(auth.isAgent(request)).toBe(true)
      expect(auth.callerInfo(request, 'orch')).toEqual({ ...asWorker('orch'), token: null })
      expect(auth.roleOf(request)).toBe('worker')
      expect(auth.callerInfo(request).name).toBe('unknown')
    }
    for (const headers of [
      {} as Record<string, string>,
      cookie(SESSION.local),
      { 'x-test-actor': 'agent:bot' },
    ]) {
      const request = req(headers)
      expect(auth.isAgent(request)).toBe(false)
      expect(auth.callerInfo(request, 'Enrique')).toEqual(asHuman('Enrique'))
      expect(auth.roleOf(request)).toBe('human')
    }
  })

  it('refuses any other X-Agent-Name with a 400 naming the form, and remembers nobody', async () => {
    const bad = [
      '',
      'claude',
      'claude/x',
      'someone-else',
      'orchestra/x',
      'orch/',
      'orch//x',
      'orch/..',
      'orch/x/../y',
      'orch/.hidden',
      'orch/two words',
      `orch/${'x'.repeat(41)}`,
      'orch/a/b/c/d',
      `orch/${'a'.repeat(40)}/${'b'.repeat(40)}`,
    ]
    for (const value of bad) {
      const request = named(ORCH_TOKEN, value)
      await expect(auth.authenticate(request, localSite(47100)), value).rejects.toMatchObject({
        status: 400,
        message: expect.stringMatching(/^X-Agent-Name must be <token-name>\/<name>, here orch\/<name>/),
      })
      if (value) expect(await actorRow(value.trim())).toBeUndefined()
    }
    // A worker cannot take an orchestrator's name, nor a sub-identity of it.
    for (const value of ['orch', 'orch/worker-1'])
      await expect(auth.callerOf(named(TOKEN, value), production)).rejects.toMatchObject({ status: 400 })
  })

  it("never takes a human's name for a sub-identity", async () => {
    const { db, schema } = await import('#/db')
    db.insert(schema.actors)
      .values({ name: 'orch/me', kind: 'human', lastSeenAt: '2026-01-01T00:00:00.000Z' })
      .run()
    await expect(auth.callerOf(named(ORCH_TOKEN, 'orch/me'), production)).rejects.toMatchObject({
      status: 400,
      message: "X-Agent-Name: orch/me is the human's name on the board",
    })
    expect(await actorRow('orch/me')).toMatchObject({ kind: 'human' })
  })

  it('remembers a sub-identity with its role and parent', async () => {
    expect(await auth.authenticate(named(ORCH_TOKEN, 'orch/remembered'), localSite(47100))).toBe(
      'orch/remembered',
    )
    expect(await actorRow('orch/remembered')).toMatchObject({ kind: 'agent', role: 'worker', parent: 'orch' })
    const { listActors } = await import('./actors')
    expect(listActors().find((a) => a.name === 'orch/remembered')).toEqual({
      name: 'orch/remembered',
      kind: 'agent',
      role: 'worker',
      parent: 'orch',
      lastSeenAt: expect.any(String),
    })
    expect(listActors().find((a) => a.name === 'enrique-desktop')).toMatchObject({
      role: 'human',
      parent: '',
    })
  })

  it('ignores X-Agent-Name for the human, in every mode', async () => {
    const sub = { 'x-agent-name': 'orch/worker-1' }
    expect(await auth.callerOf(req({ ...cookie(SESSION.local), ...sub }), production)).toEqual(
      asHuman('Enrique'),
    )
    expect(await auth.callerOf(req({ ...bearer(TOKEN), ...sub }), devOff)).toEqual(asHuman('enrique'))
    expect(await auth.callerOf(req(sub), test)).toEqual(asHuman('human'))
    expect(await auth.callerOf(req({ 'x-test-actor': 'human:qa', ...sub }), test)).toEqual(asHuman('qa'))
    expect(await auth.callerOf(req({ 'x-agent-name': 'nonsense//' }), devOff)).toEqual(asHuman('enrique'))
  })

  it('test: orchestrator:<name> is an orchestrator, agent:<name> a worker; X-Agent-Name works the same', async () => {
    expect(await auth.callerOf(req({ 'x-test-actor': 'orchestrator: orch ' }), test)).toEqual({
      name: 'orch',
      kind: 'agent',
      role: 'orchestrator',
      parent: '',
      token: 'orch',
    })
    expect(auth.isAgent(req({ 'x-test-actor': 'orchestrator:orch' }), test)).toBe(true)
    expect(
      await auth.callerOf(req({ 'x-test-actor': 'orchestrator:orch', 'x-agent-name': 'orch/w' }), test),
    ).toMatchObject({ name: 'orch/w', role: 'worker', parent: 'orch' })
    expect(await auth.callerOf(req({ 'x-test-actor': 'orchestrator:' }), test)).toBeNull()
    // Never read outside test.
    for (const mode of [production, devOn])
      expect(await auth.callerOf(req({ 'x-test-actor': 'orchestrator:orch' }), mode)).toBeNull()
    expect(await auth.callerOf(req({ 'x-test-actor': 'orchestrator:orch' }), devOff)).toEqual(
      asHuman('enrique'),
    )
  })

  it('admit: a malformed X-Test-Actor is a 401 naming the three forms, a bad X-Agent-Name a 400', async () => {
    // Straight to the board on this machine, as the guard wants it.
    const at = (headers: Record<string, string>) => req({ host: 'localhost:47100', ...headers })
    const refusal = async (admission: Awaited<ReturnType<typeof auth.admit>>) => {
      expect(admission.kind).toBe('refuse')
      return (admission as { response: Response }).response
    }
    const malformed = await refusal(
      await auth.admit(at({ 'x-test-actor': 'robot:x' }), '/api/me', test, null),
    )
    expect(malformed.status).toBe(401)
    expect(await malformed.json()).toEqual({
      error: 'X-Test-Actor must be human:<name>, agent:<name> or orchestrator:<name>',
    })
    const badName = await refusal(
      await auth.admit(at({ 'x-test-actor': 'agent:w', 'x-agent-name': 'other/x' }), '/api/me', test, null),
    )
    expect(badName.status).toBe(400)
    expect((await badName.json()).error).toMatch(/^X-Agent-Name must be <token-name>\/<name>, here w\/<name>/)
    expect(await actorRow('other/x')).toBeUndefined()
    const ok = await auth.admit(
      at({ 'x-test-actor': 'orchestrator:orch', 'x-agent-name': 'orch/w' }),
      '/api/me',
      test,
      null,
    )
    expect(ok).toMatchObject({ kind: 'actor', actor: 'orch/w', caller: { role: 'worker', parent: 'orch' } })
  })
})

describe('the entrance Settings saved, as auth loads it', () => {
  it('is what the board serves once auth.ts is loaded, with no PUBLIC_ORIGIN in the environment', async () => {
    const { db, schema } = await import('#/db')
    const entranceConfig = await import('./config')
    const saved = process.env.PUBLIC_ORIGIN
    delete process.env.PUBLIC_ORIGIN
    try {
      // auth.ts registers the reader of the saved entrance (tailnetEntrance.ts) as it loads: nothing else is.
      await import('./auth')
      db.insert(schema.settings)
        .values({ key: 'tailnetEntrance', value: { origin: 'https://auth-box.example-tailnet.ts.net' } })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value: { origin: 'https://auth-box.example-tailnet.ts.net' } },
        })
        .run()
      entranceConfig.resetServedEntrance()
      expect(entranceConfig.servedEntrance()).toEqual({
        origin: 'https://auth-box.example-tailnet.ts.net',
        host: 'auth-box.example-tailnet.ts.net',
      })
    } finally {
      db.delete(schema.settings).run()
      entranceConfig.resetServedEntrance()
      if (saved !== undefined) process.env.PUBLIC_ORIGIN = saved
    }
  })
})
