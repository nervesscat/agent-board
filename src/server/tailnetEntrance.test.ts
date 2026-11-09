import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { hashSecret } from './credentials'

// The tailnet entrance Settings saves (tailnetEntrance.ts), on a production board with a fresh database and
// a Tailscale CLI stood in by a fake (TAILSCALE_BIN): the save and clear rules, the precedence over the
// environment, the sign-in off refusals, the sessions and passkeys of an origin that changes, the routes an
// agent is refused on, and the Tailscale states the Settings section shows.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-tailnet-entrance-'))
// Every variable this file sets is put back as it was when the file ends: the worker runs other files after it.
const ENV_KEYS = ['DATA_DIR', 'PUBLIC_ORIGIN', 'AUTH', 'BOARD_ENV', 'TAILSCALE_BIN', 'FAKE_TAILSCALE_STATE']
const envBefore = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
process.env.DATA_DIR = tmp
delete process.env.PUBLIC_ORIGIN
delete process.env.AUTH
const NAME = 'devbox.example-tailnet.ts.net'
const ORIGIN = `https://${NAME}`
const OLD = 'https://old-box.example-tailnet.ts.net'

// --- the fake Tailscale CLI: each read answered from the state file the case writes ---
const fake = path.join(tmp, 'fake-tailscale.mjs')
const stateFile = path.join(tmp, 'tailscale-state.json')
fs.writeFileSync(
  fake,
  `import fs from 'node:fs'
const args = process.argv.slice(2)
const all = JSON.parse(fs.readFileSync(process.env.FAKE_TAILSCALE_STATE, 'utf8'))
const answer = all[args.join(' ')]
if (answer === undefined) {
  process.stderr.write('fake tailscale: nothing for ' + args.join(' ') + '\\n')
  process.exit(1)
}
process.stdout.write(typeof answer === 'string' ? answer : JSON.stringify(answer))
`,
)
process.env.FAKE_TAILSCALE_STATE = stateFile
process.env.TAILSCALE_BIN = fake

/** Tailscale on this machine, up, with MagicDNS and HTTPS on, serving the board on 443 (the default port). */
const tailnet = (over: Record<string, unknown> = {}) => ({
  version: '1.80.2\n  commit\n',
  'status --json': {
    BackendState: 'Running',
    Self: { DNSName: `${NAME}.`, HostName: 'devbox' },
    CertDomains: [NAME],
  },
  'serve status --json': {
    Web: { [`${NAME}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:47100' } } } },
  },
  'funnel status --json': {},
  ...over,
})
const writeState = (answers: Record<string, unknown>) => fs.writeFileSync(stateFile, JSON.stringify(answers))
writeState(tailnet())

type Loaded = Awaited<ReturnType<typeof load>>
/** The modules as a board with these environment variables loads them: each load is a fresh copy. */
async function load(env: Record<string, string> = {}) {
  vi.resetModules()
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  return {
    config: await import('./config'),
    db: await import('#/db'),
    entrance: await import('./tailnetEntrance'),
    passkeys: await import('./passkeys'),
    http: await import('./http'),
    auth: await import('./auth'),
    api: (await import('./api')).api,
  }
}

let B: Loaded
beforeAll(async () => {
  B = await load({ BOARD_ENV: 'production' })
  const { db, schema } = B.db
  db.insert(schema.account).values({ id: 1, name: 'Enrique', userHandle: 'AAAA' }).run()
  db.insert(schema.passkeys)
    .values([
      { id: 1, credentialId: 'cred-desktop', publicKey: 'AAAA', rpId: 'localhost', name: 'Desktop' },
      {
        id: 2,
        credentialId: 'cred-old',
        publicKey: 'AAAA',
        rpId: 'old-box.example-tailnet.ts.net',
        name: 'Old phone',
      },
      { id: 3, credentialId: 'cred-new', publicKey: 'AAAA', rpId: NAME, name: 'New tablet' },
    ])
    .run()
})
afterAll(() => {
  vi.unstubAllEnvs()
  for (const key of ENV_KEYS) {
    if (envBefore[key] === undefined) delete process.env[key]
    else process.env[key] = envBefore[key]
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

const future = '2099-01-01T00:00:00.000Z'
/** A live session of each passkey, as the board signs one in: the token's hash is what the database keeps. */
function sessionFor(passkeyId: number, token: string) {
  B.db.db
    .insert(B.db.schema.sessions)
    .values({ tokenHash: hashSecret(token), passkeyId, expiresAt: future, lastSeenAt: future })
    .run()
}
const sessionTokens = () =>
  B.db.db
    .select({ tokenHash: B.db.schema.sessions.tokenHash })
    .from(B.db.schema.sessions)
    .all()
    .map((s) => s.tokenHash)

const BAD = [
  'http://devbox.example-tailnet.ts.net',
  'https://devbox.example-tailnet.ts.net:443',
  'https://devbox.example-tailnet.ts.net:8080',
  'https://devbox.example-tailnet.ts.net/board',
  'https://devbox.example-tailnet.ts.net/?x=1',
  'https://devbox.example-tailnet.ts.net#top',
  'https://me@devbox.example-tailnet.ts.net',
  'https://*.example-tailnet.ts.net',
  'https://*.ts.net',
  'https://*',
  'https://ts.net.',
  'https://100.101.102.103',
  'https://[fd7a:115c:a1e0::1]',
  'https://localhost',
  'https://<machine>.<tailnet>.ts.net',
  'devbox.example-tailnet.ts.net',
  'https://devbox.example-tailnet.ts.net junk',
]

/** Saves or clears, and what the board answers after it, from its database. */
const savedRow = () =>
  B.db.db
    .select()
    .from(B.db.schema.settings)
    .all()
    .find((r) => r.key === 'tailnetEntrance')?.value ?? null

beforeEach(() => {
  writeState(tailnet())
  B.db.db.delete(B.db.schema.settings).run()
  B.config.resetServedEntrance()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('the origin: the rule the environment and Settings share', () => {
  it('refuses each bad value with the message PUBLIC_ORIGIN gives, and the same answer as the environment', async () => {
    for (const bad of BAD) {
      const problem = await B.entrance.setEntrance(bad, 'Enrique').then(
        () => null,
        (err) => err,
      )
      expect(problem, bad).toMatchObject({ status: 400 })
      expect(problem.message, bad).toMatch(/^PUBLIC_ORIGIN must be https:\/\/<machine>\.<tailnet>\.ts\.net/)
      expect(() => B.config.readPublicEntrance({ PUBLIC_ORIGIN: bad }), bad).toThrow(problem.message)
    }
    expect(savedRow()).toBeNull()
  })

  it('saves the origin lower case, without a trailing slash, and serves it at once', async () => {
    const state = await B.entrance.setEntrance(' https://DevBox.Example-Tailnet.ts.net/ ', 'Enrique')
    expect(state.saved).toBe(ORIGIN)
    expect(savedRow()).toEqual({ origin: ORIGIN })
    expect(B.config.servedEntrance()).toEqual({ origin: ORIGIN, host: NAME })
    expect(state.served).toEqual({ origin: ORIGIN, from: 'settings' })
  })

  it('clears it: the row goes, and the board serves no entrance on the next request', async () => {
    await B.entrance.setEntrance(ORIGIN, 'Enrique')
    expect(B.config.servedEntrance()).not.toBeNull()
    const state = await B.entrance.setEntrance(null, 'Enrique')
    expect(savedRow()).toBeNull()
    expect(state.saved).toBeNull()
    expect(B.config.servedEntrance()).toBeNull()
  })
})

describe('precedence: PUBLIC_ORIGIN in the environment wins, and is shown read-only', () => {
  afterEach(() => {
    delete process.env.PUBLIC_ORIGIN
    B.config.resetServedEntrance()
  })

  it('serves the environment value while a Settings entrance is saved, and refuses to save over it', async () => {
    await B.entrance.setEntrance(ORIGIN, 'Enrique')
    process.env.PUBLIC_ORIGIN = 'https://env-box.example-tailnet.ts.net'
    B.config.resetServedEntrance()
    expect(B.config.servedEntrance()).toMatchObject({ host: 'env-box.example-tailnet.ts.net' })
    const state = await B.entrance.entranceState()
    expect(state.fromEnv).toBe('https://env-box.example-tailnet.ts.net')
    expect(state.saved).toBe(ORIGIN)
    expect(state.served).toEqual({ origin: 'https://env-box.example-tailnet.ts.net', from: 'config' })
    for (const origin of [ORIGIN, null]) {
      const err = await B.entrance.setEntrance(origin, 'Enrique').then(
        () => null,
        (e) => e,
      )
      expect(err, String(origin)).toMatchObject({ status: 409, code: 'env-set' })
      expect(err.message).toMatch(/config\.env/)
    }
    expect(savedRow()).toEqual({ origin: ORIGIN })
  })
})

describe('the Funnel and sign-in off refusals', () => {
  it('refuses to save while Tailscale Funnel is on, and writes nothing', async () => {
    writeState(
      tailnet({
        'serve status --json': {
          Web: { [`${NAME}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:47100' } } } },
          AllowFunnel: { [`${NAME}:443`]: true },
        },
      }),
    )
    const err = await B.entrance.setEntrance(ORIGIN, 'Enrique').then(
      () => null,
      (e) => e,
    )
    expect(err).toMatchObject({ status: 409, code: 'funnel' })
    expect(err.message).toMatch(/Funnel is on/)
    expect(savedRow()).toBeNull()
  })

  it('refuses the save and reports Funnel on, even when the status read itself fails', async () => {
    // No answer for `status --json`: the status read fails, and the Funnel config still says it is on.
    const { 'status --json': _status, ...rest } = tailnet({
      'funnel status --json': { AllowFunnel: { [`${NAME}:443`]: true } },
    })
    writeState(rest)
    const view = await B.entrance.readTailnet(47100)
    expect(view).toMatchObject({ funnel: true, error: expect.any(String) })
    const err = await B.entrance.setEntrance(ORIGIN, 'Enrique').then(
      () => null,
      (e) => e,
    )
    expect(err).toMatchObject({ status: 409, code: 'funnel' })
    expect(err.message).toMatch(/Funnel is on/)
    expect(savedRow()).toBeNull()
    writeState(tailnet())
  })

  it('refuses the save when only the Funnel read fails, and says Funnel could not be read', async () => {
    const { 'funnel status --json': _funnel, ...rest } = tailnet()
    writeState(rest)
    const view = await B.entrance.readTailnet(47100)
    expect(view).toMatchObject({ funnelKnown: false, serve: { state: 'board' } })
    const err = await B.entrance.setEntrance(ORIGIN, 'Enrique').then(
      () => null,
      (e) => e,
    )
    expect(err).toMatchObject({ status: 409, code: 'funnel-unknown' })
    expect(err.message).toMatch(/could not read Funnel/)
    expect(savedRow()).toBeNull()
    writeState(tailnet())
  })

  it('refuses the save when the serve and Funnel reads both fail', async () => {
    const { 'funnel status --json': _funnel, 'serve status --json': _serve, ...rest } = tailnet()
    writeState(rest)
    const view = await B.entrance.readTailnet(47100)
    expect(view).toMatchObject({ funnelKnown: false, serve: { state: 'none' } })
    const err = await B.entrance.setEntrance(ORIGIN, 'Enrique').then(
      () => null,
      (e) => e,
    )
    expect(err).toMatchObject({ status: 409, code: 'funnel-unknown' })
    expect(savedRow()).toBeNull()
    writeState(tailnet())
  })

  it('refuses to save with sign-in off, and the entrance is never served there', async () => {
    const test = await load({ BOARD_ENV: 'test' })
    const err = await test.entrance.setEntrance(ORIGIN, 'Enrique').then(
      () => null,
      (e) => e,
    )
    expect(err).toMatchObject({ status: 409, code: 'auth-off' })
    expect(err.message).toMatch(/^sign-in is off/)
    expect(test.config.servedEntrance()).toBeNull()
    // A row saved before, or copied in, is shown as not served: sign-in off ignores it.
    test.db.db
      .insert(test.db.schema.settings)
      .values({ key: 'tailnetEntrance', value: { origin: ORIGIN } })
      .onConflictDoUpdate({ target: test.db.schema.settings.key, set: { value: { origin: ORIGIN } } })
      .run()
    test.config.resetServedEntrance()
    expect(await test.entrance.entranceState()).toMatchObject({
      signInOff: true,
      saved: ORIGIN,
      served: null,
      unserved: expect.stringMatching(/^sign-in is off \(BOARD_ENV=test\)/),
    })
    vi.unstubAllEnvs()
  })

  it('refuses to save on a development copy of the board, which serves no saved entrance either', async () => {
    const dev = await load({ BOARD_ENV: 'development' })
    const err = await dev.entrance.setEntrance(ORIGIN, 'Enrique').then(
      () => null,
      (e) => e,
    )
    expect(err).toMatchObject({ status: 409, code: 'not-live' })
    vi.unstubAllEnvs()
  })
})

describe('what each save and clear writes', () => {
  beforeEach(() => {
    B.db.db.delete(B.db.schema.activity).run()
  })

  it('writes one board-level activity row per save and per clear, with the actor and both origins', async () => {
    await B.entrance.setEntrance(ORIGIN, 'Enrique')
    await B.entrance.setEntrance(null, 'Enrique')
    const rows = B.db.db.select().from(B.db.schema.activity).all()
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => [r.projectId, r.actor, r.kind, r.text])).toEqual([
      [null, 'Enrique', 'tailnet.entrance', `tailnet entrance none -> ${ORIGIN}`],
      [null, 'Enrique', 'tailnet.entrance', `tailnet entrance ${ORIGIN} -> none`],
    ])
  })

  it('writes no row for a refused save', async () => {
    await B.entrance.setEntrance('http://nope.example.ts.net', 'Enrique').catch(() => null)
    expect(B.db.db.select().from(B.db.schema.activity).all()).toHaveLength(0)
  })
})

describe('the sessions of the origin a save changes from', () => {
  beforeEach(() => {
    B.db.db.delete(B.db.schema.sessions).run()
  })

  it('signs out the sessions of the old origin, keeps the localhost ones, and lists every passkey still', async () => {
    await B.entrance.setEntrance(OLD, 'Enrique')
    sessionFor(2, 'old-phone-session')
    sessionFor(1, 'desktop-session')
    await B.entrance.setEntrance(ORIGIN, 'Enrique')
    expect(sessionTokens()).toEqual([hashSecret('desktop-session')])
    expect(B.passkeys.listPasskeys().map((p) => p.name)).toEqual(['Desktop', 'Old phone', 'New tablet'])
  })

  it('signs out the sessions of the origin it is cleared from', async () => {
    await B.entrance.setEntrance(ORIGIN, 'Enrique')
    sessionFor(3, 'new-tablet-session')
    sessionFor(1, 'desktop-session')
    await B.entrance.setEntrance(null, 'Enrique')
    expect(sessionTokens()).toEqual([hashSecret('desktop-session')])
  })

  it('a passkey made on the old name signs in nowhere on the new one, and the new name asks for its own', async () => {
    await B.entrance.setEntrance(ORIGIN, 'Enrique')
    const site = B.auth.siteOf(new Request('http://localhost/', { headers: { 'x-forwarded-host': NAME } }))
    expect(site).toEqual({ rpId: NAME, origin: ORIGIN })
    const options = await B.passkeys.loginOptions(site!)
    expect(options.rpId).toBe(NAME)
    expect(options.allowCredentials?.map((c) => c.id)).toEqual(['cred-new'])
    await expect(
      B.passkeys.loginVerify(site!, { id: 'cred-old' } as unknown as Parameters<
        typeof B.passkeys.loginVerify
      >[1]),
    ).rejects.toMatchObject({ status: 401, message: 'this passkey is not known on this origin' })
  })
})

describe('a saved row that is not an entrance', () => {
  it('is treated as off, with a log line, and never a crash', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    B.db.db
      .insert(B.db.schema.settings)
      .values({ key: 'tailnetEntrance', value: { origin: 'http://devbox.example-tailnet.ts.net' } })
      .onConflictDoUpdate({
        target: B.db.schema.settings.key,
        set: { value: { origin: 'http://devbox.example-tailnet.ts.net' } },
      })
      .run()
    B.config.resetServedEntrance()
    expect(B.config.servedEntrance()).toBeNull()
    const state = await B.entrance.entranceState()
    expect(state.saved).toBeNull()
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/saved in the database is ignored/))
    B.db.db.delete(B.db.schema.settings).run()
  })

  it('is treated as off when it is not JSON either', async () => {
    B.db.db.$client
      .prepare("insert or replace into settings (key, value) values ('tailnetEntrance', 'not json')")
      .run()
    B.config.resetServedEntrance()
    expect(B.config.servedEntrance()).toBeNull()
    B.db.db.delete(B.db.schema.settings).run()
  })
})

describe('the Tailscale state, from the fake CLI', () => {
  const PORT = 47100
  const read = () => B.entrance.readTailnet(PORT)
  const missing = () => path.join(tmp, 'not-installed', 'tailscale')

  it('is not installed when the CLI is not there (ENOENT)', async () => {
    const before = process.env.TAILSCALE_BIN
    process.env.TAILSCALE_BIN = missing()
    try {
      expect(await read()).toMatchObject({ installed: false, signedIn: false, name: null })
    } finally {
      process.env.TAILSCALE_BIN = before
    }
  })

  it('is signed out when it needs a login, or is stopped', async () => {
    for (const backend of ['NeedsLogin', 'Stopped']) {
      writeState(tailnet({ 'status --json': { BackendState: backend } }))
      expect(await read(), backend).toMatchObject({ installed: true, backend, signedIn: false })
    }
  })

  it('is running without a tailnet name when MagicDNS is off, and without HTTPS when its certificates are', async () => {
    writeState(tailnet({ 'status --json': { BackendState: 'Running', Self: { HostName: 'devbox' } } }))
    expect(await read()).toMatchObject({ signedIn: true, name: null, https: false })
    writeState(
      tailnet({
        'status --json': { BackendState: 'Running', Self: { DNSName: `${NAME}.` }, CertDomains: [] },
      }),
    )
    expect(await read()).toMatchObject({ name: NAME, https: false })
  })

  it('has no serve when nothing sends 443 to the board', async () => {
    writeState(tailnet({ 'serve status --json': {} }))
    expect(await read()).toMatchObject({ serve: { state: 'none', target: null }, funnel: false })
  })

  it('has another serve on 443 when it sends it somewhere but the board', async () => {
    writeState(
      tailnet({
        'serve status --json': {
          Web: { [`${NAME}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8080' } } } },
        },
      }),
    )
    expect(await read()).toMatchObject({ serve: { state: 'other', target: 'http://127.0.0.1:8080' } })
  })

  it('has the board on 443 when serve sends it to the board', async () => {
    expect(await read()).toMatchObject({ serve: { state: 'board', target: 'http://127.0.0.1:47100' } })
  })

  it('has Funnel on when a serve config allows it, and says so', async () => {
    writeState(
      tailnet({
        'funnel status --json': { AllowFunnel: { [`${NAME}:443`]: true } },
      }),
    )
    expect(await read()).toMatchObject({ funnel: true })
  })

  it('names what keeps the Test button from working, before it asks the board anything', async () => {
    writeState(tailnet({ 'status --json': { BackendState: 'NeedsLogin' } }))
    expect(await B.entrance.checkEntrance(PORT)).toEqual({
      ok: false,
      message: 'Tailscale is NeedsLogin on this machine: sign in first',
    })
    writeState(tailnet({ 'status --json': { BackendState: 'Running', Self: {} } }))
    expect((await B.entrance.checkEntrance(PORT)).message).toMatch(/no tailnet name: turn on MagicDNS/)
    writeState(
      tailnet({
        'status --json': { BackendState: 'Running', Self: { DNSName: `${NAME}.` }, CertDomains: [] },
      }),
    )
    expect((await B.entrance.checkEntrance(PORT)).message).toMatch(/no HTTPS certificate/)
    writeState(tailnet({ 'serve status --json': {} }))
    expect((await B.entrance.checkEntrance(PORT)).message).toBe(
      `tailscale serve does not send https://${NAME} to the board yet: run tailscale serve --bg --https=443 ` +
        `http://127.0.0.1:${PORT} on this machine, then check again`,
    )
    writeState(
      tailnet({
        'serve status --json': {
          Web: { [`${NAME}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8080' } } } },
        },
      }),
    )
    expect((await B.entrance.checkEntrance(PORT)).message).toMatch(/not to the board: run tailscale serve/)
    writeState(tailnet({ 'funnel status --json': { AllowFunnel: { [`${NAME}:443`]: true } } }))
    expect((await B.entrance.checkEntrance(PORT)).message).toMatch(/Funnel is on/)
    writeState(tailnet())
  })

  it("asks the board to save the entrance first, and then for this machine's own name", async () => {
    expect((await B.entrance.checkEntrance(PORT)).message).toMatch(/^Save the entrance first/)
    await B.entrance.setEntrance('https://other-box.example-tailnet.ts.net', 'Enrique')
    expect((await B.entrance.checkEntrance(PORT)).message).toBe(
      `The entrance is https://other-box.example-tailnet.ts.net, but this machine is ${NAME}: save https://${NAME}`,
    )
    await B.entrance.setEntrance(null, 'Enrique')
  })
})

describe('the Test button: what the board answers over its name', () => {
  const origin = ORIGIN
  const answers = (status: number) => async () => new Response(null, { status })

  it('is ok when the name reaches the board and it asks for sign-in (401)', async () => {
    const seen: string[] = []
    const result = await B.entrance.probeHealth(origin, async (url) => {
      seen.push(String(url))
      return new Response(null, { status: 401 })
    })
    expect(seen).toEqual([`${origin}/api/health`])
    expect(result).toEqual({
      ok: true,
      message: `${origin}/api/health answers 401: the board is on your tailnet and asks for sign-in`,
    })
  })

  it('names a host mismatch on 403', async () => {
    const result = await B.entrance.probeHealth(origin, answers(403))
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/answers 403: the board refuses the name/)
    expect(result.message).toMatch(/tailscale serve sends https:\/\/devbox\.example-tailnet\.ts\.net:443/)
  })

  it('refuses a board that answers without signing in (200), and any other status', async () => {
    expect((await B.entrance.probeHealth(origin, answers(200))).message).toMatch(
      /answers 200 without signing in/,
    )
    expect(await B.entrance.probeHealth(origin, answers(502))).toEqual({
      ok: false,
      message: `${origin}/api/health answers 502`,
    })
  })

  it('says why it could not reach the name at all', async () => {
    const unreachable = async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })
    }
    expect(await B.entrance.probeHealth(origin, unreachable)).toEqual({
      ok: false,
      message: `could not reach ${origin}/api/health from this board (ENOTFOUND)`,
    })
  })
})

describe('the routes: the human only', () => {
  let handle: (ctx: { request: Request; actor: string }) => Promise<Response>
  beforeAll(() => {
    handle = B.http.api(({ request, actor }: { request: Request; actor: string }) =>
      B.api.handle(request, actor),
    )
  })

  const token = (name: string, role: 'worker' | 'orchestrator') => {
    B.db.db.$client
      .prepare('insert or replace into agent_tokens (token_hash, name, expires_at, role) values (?, ?, ?, ?)')
      .run(hashSecret(`token-${name}`), name, future, role)
    return `Bearer token-${name}`
  }

  const call = (method: string, authorization?: string, body?: unknown) =>
    handle({
      request: new Request(`http://localhost/api/tailnet${method === 'POST' ? '/test' : ''}`, {
        method,
        headers: {
          ...(authorization ? { authorization } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      actor: 'Enrique',
    })

  it('refuses a worker and an orchestrator token on GET, PATCH and POST, and saves nothing', async () => {
    for (const authorization of [
      token('worker-agent', 'worker'),
      token('orchestrator-agent', 'orchestrator'),
    ]) {
      for (const [method, body] of [
        ['GET', undefined],
        ['PATCH', { origin: ORIGIN }],
        ['POST', undefined],
      ] as const) {
        const res = await call(method, authorization, body)
        expect(res.status, `${authorization} ${method}`).toBe(403)
        expect(await res.json()).toEqual({ error: expect.stringMatching(/^only the human /) })
      }
    }
    expect(savedRow()).toBeNull()
  })

  it('answers the human: the state on GET, the save on PATCH, and a bad origin as a 400', async () => {
    const res = await call('GET')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ signInOff: false, boardEnv: 'production', port: 47100 })
    const bad = await call('PATCH', undefined, { origin: 'http://devbox.example-tailnet.ts.net' })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({
      error: expect.stringMatching(/^PUBLIC_ORIGIN must be https:\/\/<machine>\.<tailnet>\.ts\.net/),
    })
    const ok = await call('PATCH', undefined, { origin: ORIGIN })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ saved: ORIGIN })
    expect((await call('PATCH', undefined, { origin: null })).status).toBe(200)
    expect(savedRow()).toBeNull()
  })
})
