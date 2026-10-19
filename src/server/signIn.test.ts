import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { SoftAuthenticator } from './softAuthenticator'

/**
 * Signing in end to end, as src/start.ts serves a request: the guard and `admit`, then the sign-in page
 * or the API router. Passkeys are made and used by a software authenticator, so the board's WebAuthn
 * verification runs for real. A production board on a fresh database, with the tailnet entrance on.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp
const PUBLIC = 'devbox.example-tailnet.ts.net'
const PUBLIC_ORIGIN = `https://${PUBLIC}`
process.env.PUBLIC_ORIGIN = PUBLIC_ORIGIN
const LOCAL_ORIGIN = 'http://localhost:47100'
/** The session cookie of the board on 47100 (credentials.ts sessionCookieName). */
const COOKIE = 'board_session_47100'

/** What `tailscale serve` adds to a request from a tailnet user. */
const SERVE = {
  'x-forwarded-for': '100.101.102.103',
  'x-forwarded-host': PUBLIC,
  'x-forwarded-proto': 'https',
  'tailscale-user-login': 'someone@example.com',
}

type Via = 'host' | 'tailnet' | 'lan'

let serve: (request: Request) => Promise<Response>
let dbm: typeof import('#/db')
let hashSecret: typeof import('./credentials').hashSecret
let safeNext: typeof import('./authPages').safeNext

beforeAll(async () => {
  const { admit, rememberActor } = await import('./auth')
  const { signInPage } = await import('./authPages')
  safeNext = (await import('./authPages')).safeNext
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  dbm = await import('#/db')
  hashSecret = (await import('./credentials')).hashSecret
  const handle = guard(({ request, actor }: { request: Request; actor: string }) =>
    api.handle(request, actor),
  )
  serve = async (request) => {
    const { pathname } = new URL(request.url)
    const admission = await admit(request, pathname)
    if (admission.kind === 'refuse') return admission.response
    if (admission.kind === 'page') return signInPage(request, pathname, admission.site)
    if (admission.kind === 'actor') rememberActor(request, admission.actor)
    return handle({ request, actor: admission.kind === 'actor' ? admission.actor : 'unknown' })
  }
  // The human the board saw before it had sign-in of its own: setup offers that name.
  dbm.db
    .insert(dbm.schema.actors)
    .values({ name: 'enrique', kind: 'human', lastSeenAt: '2026-09-01T00:00:00.000Z' })
    .run()
})
afterEach(() => vi.useRealTimers())

interface Send {
  via?: Via
  headers?: Record<string, string>
  body?: unknown
  cookie?: string
  token?: string
  html?: boolean
}

/** A request as it reaches the board: straight on this machine, through `tailscale serve`, or from the LAN. */
function send(method: string, target: string, o: Send = {}): Promise<Response> {
  const via = o.via ?? 'host'
  const headers: Record<string, string> = {
    host: via === 'tailnet' ? PUBLIC : 'localhost:47100',
    accept: o.html ? 'text/html' : 'application/json',
    ...(via === 'tailnet' ? SERVE : {}),
    ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...(o.cookie ? { cookie: `theme=dark; ${COOKIE}=${o.cookie}` } : {}),
    ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
    ...o.headers,
  }
  const request = new Request(`http://${headers.host}${target}`, {
    method,
    headers,
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  })
  // How srvx's Node request carries the connection the request came on.
  const remoteAddress = via === 'lan' ? '192.168.1.20' : '127.0.0.1'
  return serve(Object.assign(request, { runtime: { node: { req: { socket: { remoteAddress } } } } }))
}

const json = async <T = any>(res: Response | Promise<Response>): Promise<T> => (await res).json() as T

/** The session cookie a response sets, its value and attributes. */
function setCookie(res: Response) {
  const header = res.headers.get('set-cookie') ?? ''
  const value = new RegExp(`^${COOKIE}=([^;]*)`).exec(header)?.[1] ?? null
  return { header, value }
}

const count = (table: 'account' | 'passkeys' | 'sessions') =>
  (dbm.db.$client.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n

let host = new SoftAuthenticator()
const phone = new SoftAuthenticator()

/** Creation options of the board's shape for a passkey it never asked for. */
const strayOptions = (rpId = 'localhost') => ({
  challenge: 'c3RyYXk',
  rp: { id: rpId, name: 'x' },
  user: { id: 'AAAA', name: 'x', displayName: 'x' },
  pubKeyCredParams: [],
})
let hostSession = ''

/** Setup on this machine with `authenticator`: the options, the new passkey, the verify. */
async function setup(authenticator: SoftAuthenticator, name = 'Enrique', o: Send = {}) {
  const options = await send('POST', '/api/auth/setup/options', { ...o, body: { name } })
  if (!options.ok) return options
  const response = authenticator.register(await options.json(), LOCAL_ORIGIN)
  return send('POST', '/api/auth/setup/verify', { ...o, body: { device: 'Desktop', response } })
}

/** Signs in with `authenticator` on the origin `via` reaches, the browser being on `origin`. */
async function login(authenticator: SoftAuthenticator, via: Via, origin: string, credentialId?: string) {
  const options = await json(send('POST', '/api/auth/login/options', { via, body: {} }))
  const response = authenticator.assert(options, origin, credentialId)
  return send('POST', '/api/auth/login/verify', { via, body: { response } })
}

describe('first boot: no account yet', () => {
  it('sends a page to /setup and refuses every other page and call, but /api/health and setup', async () => {
    for (const target of ['/', '/projects/1', '/settings']) {
      const res = await send('GET', target, { html: true })
      expect(res.status, target).toBe(302)
      expect(res.headers.get('location')).toBe('/setup')
    }
    for (const target of ['/api/projects', '/api/me', '/api/actors']) {
      const res = await send('GET', target)
      expect(res.status, target).toBe(409)
      expect(await res.json()).toEqual({ error: expect.stringMatching(/^setup required/), code: 'setup' })
    }
    // A seeded agent token does not get in before the account exists either.
    dbm.db
      .insert(dbm.schema.agentTokens)
      .values({ tokenHash: hashSecret('early-token'), name: 'early', expiresAt: '2099-01-01T00:00:00.000Z' })
      .run()
    expect((await send('GET', '/api/projects', { token: 'early-token' })).status).toBe(409)
    // Signing out too: there is nothing to sign out of yet.
    const out = await send('POST', '/api/auth/logout', { cookie: 'made-up', body: {} })
    expect(out.status).toBe(409)
    expect(await out.json()).toEqual({ error: expect.stringMatching(/^setup required/), code: 'setup' })
    expect(out.headers.get('set-cookie')).toBeNull()
    expect(await json(send('GET', '/api/health'))).toEqual({ ok: true })
    // Through the tailnet the same, and /api/health is not open there.
    expect((await send('GET', '/', { via: 'tailnet', html: true })).headers.get('location')).toBe('/setup')
    expect((await send('GET', '/api/health', { via: 'tailnet' })).status).toBe(409)
    // The login page has nothing to sign in to yet.
    expect((await send('GET', '/login', { html: true })).headers.get('location')).toBe('/setup')
  })

  it('offers setup on the host, with the name the board knew the human by', async () => {
    const res = await send('GET', '/setup', { html: true })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('data-flow="setup"')
    expect(html).toMatch(/id="name"[^>]*value="enrique"/)
    // On 127.0.0.1 the page moves to localhost, where WebAuthn works.
    const ip = await send('GET', '/setup', { html: true, headers: { host: '127.0.0.1:47100' } })
    expect(ip.status).toBe(302)
    expect(ip.headers.get('location')).toBe(`${LOCAL_ORIGIN}/setup`)
  })

  it('says to finish setup on the host through the tailnet, and its endpoints refuse with 403', async () => {
    const page = await send('GET', '/setup', { via: 'tailnet', html: true })
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('Finish setup on the host')
    expect(html).not.toContain('data-flow="setup"')
    const asked: Send[] = [
      { via: 'tailnet' },
      // Forwarded headers on a loopback Host are the entrance too.
      { headers: { 'x-forwarded-for': '100.101.102.103' } },
      // From another machine on the LAN, with a localhost Host: not this machine.
      { via: 'lan' },
    ]
    for (const o of asked) {
      for (const step of ['options', 'verify']) {
        const res = await send('POST', `/api/auth/setup/${step}`, { ...o, body: { name: 'x', device: 'x' } })
        expect(res.status, `${JSON.stringify(o)} ${step}`).toBe(403)
        expect((await res.json()).error).toMatch(/setup is done on the host/)
      }
      // A full ceremony from there: refused, nothing stored.
      expect((await setup(new SoftAuthenticator(), 'Mallory', o)).status).toBe(403)
    }
    expect(count('account')).toBe(0)
    expect(count('passkeys')).toBe(0)
  })
})

describe('setup on the host', () => {
  it('creates the account and its first passkey on localhost, once, and signs this browser in', async () => {
    // Two setups at once, both past their options: one creates the account, the other stores nothing.
    const rival = new SoftAuthenticator()
    const verify = async (auth: SoftAuthenticator, name: string) => {
      const options = await json(send('POST', '/api/auth/setup/options', { body: { name } }))
      return () =>
        send('POST', '/api/auth/setup/verify', {
          body: { device: 'Desktop', response: auth.register(options, LOCAL_ORIGIN) },
        })
    }
    const both = [await verify(host, 'Enrique'), await verify(rival, 'Enrique')]
    const [a, b] = await Promise.all(both.map((go) => go()))
    expect([a!.status, b!.status].sort()).toEqual([200, 409])
    const res = a!.status === 200 ? a! : b!
    if (res === b) host = rival
    expect(count('account')).toBe(1)
    expect(count('passkeys')).toBe(1)
    expect(count('sessions')).toBe(1)
    const cookie = setCookie(res)
    expect(cookie.value).toMatch(/^[\w-]{43}$/)
    expect(cookie.header).toMatch(/; Path=\//)
    expect(cookie.header).toMatch(/; HttpOnly/)
    expect(cookie.header).toMatch(/; SameSite=Lax/)
    // Plain http on localhost: not Secure. About 90 days.
    expect(cookie.header).not.toMatch(/Secure/)
    expect(Number(/Max-Age=(\d+)/.exec(cookie.header)![1])).toBeGreaterThan(89 * 86_400)
    hostSession = cookie.value!
    expect(await json(send('GET', '/api/me', { cookie: hostSession }))).toMatchObject({
      actor: 'Enrique',
      agent: false,
    })
    const passkey = dbm.db.select().from(dbm.schema.passkeys).get()!
    expect(passkey).toMatchObject({
      rpId: 'localhost',
      name: 'Desktop',
      credentialId: [...host.passkeys.keys()][0],
    })
    // The cookie is kept as its hash only.
    expect(dbm.db.select().from(dbm.schema.sessions).get()!.tokenHash).toBe(hashSecret(hostSession))
  })

  it('is refused for good once the account exists, storing nothing', async () => {
    const options = await send('POST', '/api/auth/setup/options', { body: { name: 'Again' } })
    expect(options.status).toBe(409)
    const late = await send('POST', '/api/auth/setup/verify', {
      body: { device: 'Other', response: new SoftAuthenticator().register(strayOptions(), LOCAL_ORIGIN) },
    })
    expect(late.status).toBe(409)
    expect(setCookie(late).value).toBeNull()
    expect(count('account')).toBe(1)
    expect(count('passkeys')).toBe(1)
    expect(count('sessions')).toBe(1)
    expect((await send('GET', '/setup', { html: true })).headers.get('location')).toBe('/login')
  })
})

describe('signing in on this machine', () => {
  it('sends a page without a session to its own /login, with the page to come back to', async () => {
    const res = await send('GET', '/projects/1?x=1', { html: true })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login?next=%2Fprojects%2F1%3Fx%3D1')
    expect((await send('GET', '/', { html: true })).headers.get('location')).toBe('/login?next=%2F')
    // An API call gets 401 JSON, and so does a cookie the board never gave.
    for (const cookie of [undefined, 'made-up'])
      expect(await (await send('GET', '/api/projects', { cookie })).json()).toEqual({ error: 'sign in' })
  })

  it('serves the login page, coming back only to a path of this origin', async () => {
    const page = await (await send('GET', '/login?next=%2Fprojects%2F1', { html: true })).text()
    expect(page).toContain('data-flow="login"')
    expect(page).toContain('data-next="/projects/1"')
    for (const next of ['//evil.example/x', 'https://evil.example', '/\\evil.example'])
      expect(
        await (await send('GET', `/login?next=${encodeURIComponent(next)}`, { html: true })).text(),
      ).toContain('data-next="/"')
    // Signed in already: straight on.
    const on = await send('GET', '/login?next=%2Fsettings', { html: true, cookie: hostSession })
    expect(on.headers.get('location')).toBe('/settings')
  })

  it('never sends the browser to another site with a tab, a line break or a dot segment in next', async () => {
    // The URL parser drops tabs and line breaks: `/<tab>/evil.example/x` is `//evil.example/x`.
    for (const next of [
      '/%09/evil.example/x',
      '/%0A/evil.example',
      '/%0D/evil.example',
      '/%2E//evil.example',
    ]) {
      const on = await send('GET', `/login?next=${next}`, { html: true, cookie: hostSession })
      expect(on.status, next).toBe(302)
      expect(on.headers.get('location'), next).toBe('/')
      const page = await (await send('GET', `/login?next=${next}`, { html: true })).text()
      expect(page, next).toContain('data-next="/"')
    }
  })

  it('keeps a path of this origin for next, and nothing else', () => {
    expect(safeNext('/settings?x=1#y')).toBe('/settings?x=1#y')
    expect(safeNext('/projects/1')).toBe('/projects/1')
    // Percent-encoded where a Location header needs it, still the same path.
    expect(safeNext('/projects/ü')).toBe('/projects/%C3%BC')
    // Still encoded as it came: a path segment called `%09`, on this origin.
    expect(safeNext('/%09/evil.example')).toBe('/%09/evil.example')
    for (const next of [
      null,
      '',
      'settings',
      'https://evil.example',
      'javascript:alert(1)',
      '//evil.example/x',
      '/\\evil.example',
      '/\\/evil.example',
      '\\\\evil.example',
      '/\t/evil.example/x',
      '/\n/evil.example',
      '/\r/evil.example',
      '\t//evil.example',
      '/./\\evil.example',
      '/.//evil.example',
      '/..//evil.example',
      '/\u0000/evil.example',
      '/\u00a0/evil.example',
      '/settings?q=a b',
    ])
      expect(safeNext(next), JSON.stringify(next)).toBe('/')
  })

  it('signs in with the passkey, and signing out ends the session on the server', async () => {
    const res = await login(host, 'host', LOCAL_ORIGIN)
    expect(res.status).toBe(200)
    const session = setCookie(res).value!
    expect(session).not.toBe(hostSession)
    expect(await json(send('GET', '/api/me', { cookie: session }))).toMatchObject({
      actor: 'Enrique',
      agent: false,
    })
    const out = await send('POST', '/api/auth/logout', { cookie: session, body: {} })
    expect(out.status).toBe(200)
    expect(out.headers.get('set-cookie')).toMatch(new RegExp(`^${COOKIE}=; Path=/; Max-Age=0`))
    expect((await send('GET', '/api/me', { cookie: session })).status).toBe(401)
    expect(
      dbm.db.$client.prepare('select 1 from sessions where token_hash = ?').get(hashSecret(session)),
    ).toBeUndefined()
    // The counter moved: the same assertion again would be a replay.
    expect(dbm.db.select().from(dbm.schema.passkeys).get()!.counter).toBe(1)
  })

  it('refuses an assertion for another origin, a replayed challenge, and a passkey it does not know', async () => {
    // The browser on another origin (a page on another port) signing for localhost.
    expect((await login(host, 'host', 'http://localhost:47101')).status).toBe(401)
    expect((await login(host, 'host', 'https://evil.example')).status).toBe(401)
    // A challenge is used once.
    const options = await json(send('POST', '/api/auth/login/options', { body: {} }))
    const response = host.assert(options, LOCAL_ORIGIN)
    expect((await send('POST', '/api/auth/login/verify', { body: { response } })).status).toBe(200)
    const again = await send('POST', '/api/auth/login/verify', {
      body: { response: host.assert(options, LOCAL_ORIGIN) },
    })
    expect(again.status).toBe(401)
    expect(setCookie(again).value).toBeNull()
    // A passkey the board never enrolled.
    const stranger = new SoftAuthenticator()
    stranger.register(strayOptions(), LOCAL_ORIGIN)
    const unknown = await login(stranger, 'host', LOCAL_ORIGIN)
    expect(unknown.status).toBe(401)
    expect((await unknown.json()).error).toMatch(/not known/)
  })

  it('ends a session after its 90 days', async () => {
    const session = setCookie(await login(host, 'host', LOCAL_ORIGIN)).value!
    expect((await send('GET', '/api/me', { cookie: session })).status).toBe(200)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 91 * 86_400_000)
    expect((await send('GET', '/api/me', { cookie: session })).status).toBe(401)
  })
})

describe('another device, through the tailnet entrance', () => {
  let agentToken = ''
  beforeAll(() => {
    agentToken = 'agent-token-claude'
    dbm.db
      .insert(dbm.schema.agentTokens)
      .values({ tokenHash: hashSecret(agentToken), name: 'claude', expiresAt: '2099-01-01T00:00:00.000Z' })
      .run()
  })

  const makeLink = (o: Send) => send('POST', '/api/auth/enrol-links', { ...o, body: {} })

  it('gets its one-time link from the signed-in human only', async () => {
    expect((await makeLink({})).status).toBe(401)
    const agent = await makeLink({ token: agentToken })
    expect(agent.status).toBe(403)
    expect(count('passkeys')).toBe(1)
    const res = await makeLink({ cookie: hostSession })
    expect(res.status).toBe(201)
    const { links, expiresAt } = await res.json()
    expect(links).toEqual([
      {
        where: 'tailnet',
        url: expect.stringMatching(new RegExp(`^${PUBLIC_ORIGIN}/enroll\\?code=[\\w-]{43}$`)),
      },
      {
        where: 'this machine',
        url: expect.stringMatching(new RegExp(`^${LOCAL_ORIGIN}/enroll\\?code=[\\w-]{43}$`)),
      },
    ])
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(14 * 60_000)
    expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(15 * 60_000)
  })

  /** Enrols `authenticator` with the code of a new link, the browser on `origin`, through `via`. */
  async function enrol(
    authenticator: SoftAuthenticator,
    code: string,
    via: Via = 'tailnet',
    origin = PUBLIC_ORIGIN,
  ) {
    const options = await send('POST', '/api/auth/enrol/options', { via, body: { code } })
    if (!options.ok) return options
    const response = authenticator.register(await options.json(), origin)
    return send('POST', '/api/auth/enrol/verify', { via, body: { code, device: 'Phone', response } })
  }
  const newCode = async () =>
    new URL((await json(makeLink({ cookie: hostSession }))).links[0].url).searchParams.get('code')!

  it('enrols a passkey on the public RP ID with the link, once, and signs it in with a Secure cookie', async () => {
    const code = await newCode()
    const page = await (await send('GET', `/enroll?code=${code}`, { via: 'tailnet', html: true })).text()
    expect(page).toContain('data-flow="enrol"')
    const res = await enrol(phone, code)
    expect(res.status).toBe(200)
    const cookie = setCookie(res)
    expect(cookie.header).toMatch(/; HttpOnly/)
    expect(cookie.header).toMatch(/; SameSite=Lax/)
    expect(cookie.header).toMatch(/; Secure/)
    expect(await json(send('GET', '/api/me', { via: 'tailnet', cookie: cookie.value! }))).toMatchObject({
      actor: 'Enrique',
      agent: false,
    })
    expect(
      dbm.db
        .select()
        .from(dbm.schema.passkeys)
        .all()
        .map((p) => [p.rpId, p.name]),
    ).toEqual([
      ['localhost', 'Desktop'],
      [PUBLIC, 'Phone'],
    ])
    // The same link again: refused, at the options and at the verify.
    const second = await enrol(new SoftAuthenticator(), code)
    expect(second.status).toBe(403)
    expect((await second.json()).error).toMatch(/used or expired/)
    expect(count('passkeys')).toBe(2)
  })

  it('refuses a link used between its options and its verify', async () => {
    const code = await newCode()
    const a = new SoftAuthenticator()
    const b = new SoftAuthenticator()
    const optionsA = await json(send('POST', '/api/auth/enrol/options', { via: 'tailnet', body: { code } }))
    const optionsB = await json(send('POST', '/api/auth/enrol/options', { via: 'tailnet', body: { code } }))
    const verify = (auth: SoftAuthenticator, options: any) =>
      send('POST', '/api/auth/enrol/verify', {
        via: 'tailnet',
        body: { code, device: 'Tablet', response: auth.register(options, PUBLIC_ORIGIN) },
      })
    expect((await verify(a, optionsA)).status).toBe(200)
    expect((await verify(b, optionsB)).status).toBe(403)
    expect(count('passkeys')).toBe(3)
  })

  it('refuses an expired link', async () => {
    const code = await newCode()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 16 * 60_000)
    const res = await enrol(new SoftAuthenticator(), code)
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/used or expired/)
  })

  it('never takes a passkey or a session of one origin on the other', async () => {
    // The phone's passkey (public RP ID) on localhost, and the host's (localhost) through the tailnet.
    expect((await login(phone, 'host', LOCAL_ORIGIN, [...phone.passkeys.keys()][0])).status).toBe(401)
    expect((await login(host, 'tailnet', PUBLIC_ORIGIN, [...host.passkeys.keys()][0])).status).toBe(401)
    // The right passkey, with the browser on the wrong origin.
    expect((await login(phone, 'tailnet', LOCAL_ORIGIN)).status).toBe(401)
    expect((await login(phone, 'tailnet', 'https://evil.example')).status).toBe(401)
    // A passkey made for the RP ID of the other origin, offered at enrolment.
    const code = await newCode()
    const options = await json(send('POST', '/api/auth/enrol/options', { via: 'tailnet', body: { code } }))
    const wrongRp = new SoftAuthenticator().register(
      { ...options, rp: { ...options.rp, id: 'localhost' } },
      PUBLIC_ORIGIN,
    )
    expect(
      (
        await send('POST', '/api/auth/enrol/verify', {
          via: 'tailnet',
          body: { code, device: 'x', response: wrongRp },
        })
      ).status,
    ).toBe(400)
    // Sessions: the phone's works through the tailnet only, the host's on localhost only.
    const phoneSession = setCookie(await login(phone, 'tailnet', PUBLIC_ORIGIN)).value!
    expect((await send('GET', '/api/me', { via: 'tailnet', cookie: phoneSession })).status).toBe(200)
    expect((await send('GET', '/api/me', { cookie: phoneSession })).status).toBe(401)
    expect((await send('GET', '/api/me', { via: 'tailnet', cookie: hostSession })).status).toBe(401)
    expect((await send('GET', '/api/me', { cookie: hostSession })).status).toBe(200)
    // Through the tailnet a page without a session goes to the board's own login there.
    const page = await send('GET', '/projects/1', { via: 'tailnet', html: true })
    expect(page.headers.get('location')).toBe('/login?next=%2Fprojects%2F1')
  })
})

describe('agent tokens', () => {
  const seed = (
    name: string,
    token: string,
    extra: Partial<typeof import('#/db/schema').agentTokens.$inferInsert> = {},
  ) =>
    dbm.db
      .insert(dbm.schema.agentTokens)
      .values({ tokenHash: hashSecret(token), name, expiresAt: '2099-01-01T00:00:00.000Z', ...extra })
      .run()

  it('signs an agent in by its token, named after it, on REST and /api/mcp, on both origins', async () => {
    seed('codex', 'token-of-codex')
    for (const via of ['host', 'tailnet'] as const)
      expect(await json(send('GET', '/api/me', { via, token: 'token-of-codex' }))).toMatchObject({
        actor: 'codex',
        agent: true,
      })
    const mcp = await send('POST', '/api/mcp', {
      token: 'token-of-codex',
      headers: { accept: 'application/json, text/event-stream' },
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } },
    })
    expect(mcp.status).toBe(200)
    expect(JSON.parse((await mcp.json()).result.content[0].text)).toEqual({ actor: 'codex' })
    expect(
      (await send('POST', '/api/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status,
    ).toBe(401)
    // Its last use is kept.
    expect(
      dbm.db
        .select()
        .from(dbm.schema.agentTokens)
        .all()
        .find((t) => t.name === 'codex')!.lastUsedAt,
    ).not.toBeNull()
  })

  it('refuses an unknown, revoked or expired token with 401, whatever cookie comes with it', async () => {
    seed('revoked', 'token-revoked', { revokedAt: '2026-10-01T00:00:00.000Z' })
    seed('expired', 'token-expired', { expiresAt: '2026-01-01T00:00:00.000Z' })
    for (const token of ['garbage', 'token-revoked', 'token-expired']) {
      const res = await send('GET', '/api/me', { token, cookie: hostSession })
      expect(res.status, token).toBe(401)
      expect(await res.json()).toEqual({ error: 'sign in' })
    }
    expect((await send('GET', '/api/me', { headers: { authorization: 'Bearer' } })).status).toBe(401)
  })

  it('refuses a bare Bearer with 401 even with a valid session cookie, on REST and /api/mcp', async () => {
    expect((await send('GET', '/api/me', { cookie: hostSession })).status).toBe(200)
    for (const authorization of ['Bearer', 'bearer', 'BEARER ', 'Bearer\t']) {
      const me = await send('GET', '/api/me', { cookie: hostSession, headers: { authorization } })
      expect(me.status, authorization).toBe(401)
      const mcp = await send('POST', '/api/mcp', {
        cookie: hostSession,
        headers: { authorization, accept: 'application/json, text/event-stream' },
        body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } },
      })
      expect(mcp.status, authorization).toBe(401)
    }
  })

  it('keeps no token in plain text', () => {
    const columns = (
      dbm.db.$client.prepare('pragma table_info(agent_tokens)').all() as { name: string }[]
    ).map((c) => c.name)
    expect(columns).toEqual([
      'id',
      'token_hash',
      'name',
      'createdAt',
      'last_used_at',
      'expires_at',
      'revoked_at',
    ])
    const rows = dbm.db.$client.prepare('select * from agent_tokens').all() as Record<string, unknown>[]
    for (const row of rows) expect(JSON.stringify(row)).not.toMatch(/token-of-codex|agent-token-claude/)
  })
})

describe('the agent tokens the board issues', () => {
  const DAY = 86_400_000
  const mint = (o: Send, name: unknown = 'claude') =>
    send('POST', '/api/agent-tokens', { ...o, body: { name } })

  it('are made by the signed-in human only, the token itself in that answer alone', async () => {
    expect((await mint({})).status).toBe(401)
    const agent = await mint({ token: 'agent-token-claude' })
    expect(agent.status).toBe(403)
    expect(await agent.json()).toEqual({ error: 'only the human makes agent tokens' })
    const before = dbm.db.select().from(dbm.schema.agentTokens).all().length

    const res = await mint({ cookie: hostSession }, ' opencode ')
    expect(res.status).toBe(201)
    const made = await res.json()
    expect(made).toEqual({
      id: expect.any(Number),
      name: 'opencode',
      token: expect.stringMatching(/^[\w-]{43}$/),
      createdAt: expect.any(String),
      expiresAt: expect.any(String),
    })
    expect(dbm.db.select().from(dbm.schema.agentTokens).all().length).toBe(before + 1)
    // The board keeps its hash only, and the token signs that agent in.
    expect(JSON.stringify(dbm.db.$client.prepare('select * from agent_tokens').all())).not.toContain(
      made.token,
    )
    expect(await json(send('GET', '/api/me', { token: made.token }))).toMatchObject({
      actor: 'opencode',
      agent: true,
    })
    // What the install lines download, with it.
    for (const target of ['/api/agent-setup/skill?client=opencode', '/api/agent-setup/review-skills'])
      expect((await send('GET', target, { token: made.token })).status, target).toBe(200)
    // Each press makes another one.
    const again = await json(mint({ cookie: hostSession }, 'opencode'))
    expect(again.token).not.toBe(made.token)
  })

  it("takes a name that can be an agent's on the board, never the human's", async () => {
    for (const name of ['', '   ', 'two words', '-dash', 'a/b', 'x'.repeat(41), 7, null]) {
      const res = await mint({ cookie: hostSession }, name)
      expect(res.status, JSON.stringify(name)).toBe(400)
    }
    for (const name of ['Enrique', 'enrique']) {
      const res = await mint({ cookie: hostSession }, name)
      expect(res.status, name).toBe(409)
      expect((await res.json()).error).toMatch(/human's name/)
    }
    expect((await mint({ cookie: hostSession }, 'review-bot_2.x')).status).toBe(201)
  })

  it("expires a year after it is made, outliving the human's session", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const made = await json(mint({ cookie: hostSession }, 'codex'))
    expect(Date.parse(made.expiresAt) - Date.parse(made.createdAt)).toBe(365 * DAY)
    vi.setSystemTime(Date.now() + 91 * DAY)
    // The session the token was made with is over; the token is not.
    expect((await send('GET', '/api/me', { cookie: hostSession })).status).toBe(401)
    expect((await send('GET', '/api/me', { token: made.token })).status).toBe(200)
    vi.setSystemTime(Date.parse(made.expiresAt) - 60_000)
    expect((await send('GET', '/api/me', { token: made.token })).status).toBe(200)
    vi.setSystemTime(Date.parse(made.expiresAt) + 1)
    expect((await send('GET', '/api/me', { token: made.token })).status).toBe(401)
  })

  it('lists name, made, last used and expiry, never a token, and Revoke ends one at its next request', async () => {
    for (const o of [{}, { token: 'agent-token-claude' }]) {
      expect((await send('GET', '/api/agent-tokens', o)).status).toBe(o.token ? 403 : 401)
      expect((await send('DELETE', '/api/agent-tokens/1', o)).status).toBe(o.token ? 403 : 401)
    }
    const made = await json(mint({ cookie: hostSession }, 'revokee'))
    await send('GET', '/api/me', { token: made.token })
    const list = await json<any[]>(send('GET', '/api/agent-tokens', { cookie: hostSession }))
    const row = list.find((t) => t.id === made.id)
    expect(row).toEqual({
      id: made.id,
      name: 'revokee',
      createdAt: made.createdAt,
      lastUsedAt: expect.any(String),
      expiresAt: made.expiresAt,
    })
    for (const t of list) expect(Object.keys(t).sort()).toEqual(Object.keys(row).sort())
    expect(JSON.stringify(list)).not.toContain(made.token)
    expect(JSON.stringify(list)).not.toMatch(/hash/i)

    expect((await send('DELETE', `/api/agent-tokens/${made.id}`, { cookie: hostSession })).status).toBe(204)
    const res = await send('GET', '/api/me', { token: made.token })
    expect(res.status).toBe(401)
    expect(
      (await json<any[]>(send('GET', '/api/agent-tokens', { cookie: hostSession }))).map((t) => t.id),
    ).not.toContain(made.id)
    expect((await send('DELETE', `/api/agent-tokens/${made.id}`, { cookie: hostSession })).status).toBe(404)
  })
})

describe('the devices section', () => {
  it('lists passkeys and sessions to the human only', async () => {
    for (const target of ['/api/auth/passkeys', '/api/auth/sessions']) {
      expect((await send('GET', target)).status).toBe(401)
      expect((await send('GET', target, { token: 'agent-token-claude' })).status).toBe(403)
    }
    const keys = await json<any[]>(send('GET', '/api/auth/passkeys', { cookie: hostSession }))
    expect(keys.map((k) => [k.name, k.rpId])).toEqual([
      ['Desktop', 'localhost'],
      ['Phone', PUBLIC],
      ['Tablet', PUBLIC],
    ])
    const sessions = await json<any[]>(send('GET', '/api/auth/sessions', { cookie: hostSession }))
    expect(sessions.filter((s) => s.current)).toEqual([
      expect.objectContaining({ passkey: 'Desktop', rpId: 'localhost', current: true }),
    ])
    expect(JSON.stringify(sessions)).not.toMatch(/token|hash/i)
  })

  it('revokes a passkey, ending its sessions at their next request', async () => {
    const phoneSession = setCookie(await login(phone, 'tailnet', PUBLIC_ORIGIN)).value!
    expect((await send('GET', '/api/me', { via: 'tailnet', cookie: phoneSession })).status).toBe(200)
    const phoneKey = (await json<any[]>(send('GET', '/api/auth/passkeys', { cookie: hostSession }))).find(
      (k) => k.name === 'Phone',
    )
    // Not by an agent, nor without a session.
    expect(
      (await send('DELETE', `/api/auth/passkeys/${phoneKey.id}`, { token: 'agent-token-claude' })).status,
    ).toBe(403)
    expect((await send('DELETE', `/api/auth/passkeys/${phoneKey.id}`)).status).toBe(401)
    const res = await send('DELETE', `/api/auth/passkeys/${phoneKey.id}`, {
      cookie: hostSession,
      headers: { origin: LOCAL_ORIGIN },
    })
    expect(res.status).toBe(204)
    expect((await send('GET', '/api/me', { via: 'tailnet', cookie: phoneSession })).status).toBe(401)
    // And the passkey signs in no more.
    expect((await login(phone, 'tailnet', PUBLIC_ORIGIN)).status).toBe(401)
  })

  it('never revokes the last passkey of this machine', async () => {
    const desktop = (await json<any[]>(send('GET', '/api/auth/passkeys', { cookie: hostSession }))).find(
      (k) => k.rpId === 'localhost',
    )
    const res = await send('DELETE', `/api/auth/passkeys/${desktop.id}`, { cookie: hostSession })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'last-passkey' })
    expect((await send('GET', '/api/me', { cookie: hostSession })).status).toBe(200)
  })

  it('ends one session', async () => {
    const other = setCookie(await login(host, 'host', LOCAL_ORIGIN)).value!
    const sessions = await json<any[]>(send('GET', '/api/auth/sessions', { cookie: other }))
    const mine = sessions.find((s) => s.current)
    expect((await send('DELETE', `/api/auth/sessions/${mine.id}`, { cookie: hostSession })).status).toBe(204)
    expect((await send('GET', '/api/me', { cookie: other })).status).toBe(401)
    expect((await send('GET', '/api/me', { cookie: hostSession })).status).toBe(200)
  })

  it('keeps its session cookie apart from a board on another port of localhost', async () => {
    // Browsers keep one cookie jar for every port of localhost: a copy of the board on 47101 names its
    // cookie for its port, so this board neither reads nor overwrites nor clears it.
    const res = await login(host, 'host', LOCAL_ORIGIN)
    expect(res.headers.get('set-cookie')).toMatch(new RegExp(`^${COOKIE}=[^;]+;`))
    const session = setCookie(res).value!
    const other = { cookie: `board_session_47101=${session}` }
    expect((await send('GET', '/api/me', { headers: other })).status).toBe(401)
    expect((await send('GET', '/api/me', { headers: { cookie: `board_session=${session}` } })).status).toBe(
      401,
    )
    const out = await send('POST', '/api/auth/logout', {
      headers: { cookie: `board_session_47101=x; ${COOKIE}=${session}` },
      body: {},
    })
    expect(out.headers.get('set-cookie')).toMatch(new RegExp(`^${COOKIE}=; Path=/; Max-Age=0`))
    expect(out.headers.get('set-cookie')).not.toMatch(/board_session_47101/)
  })

  it('refuses a write with the session cookie from a page of another origin', async () => {
    const res = await send('POST', '/api/auth/enrol-links', {
      cookie: hostSession,
      headers: { origin: 'http://localhost:47101' },
      body: {},
    })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/session cookie/)
  })
})
