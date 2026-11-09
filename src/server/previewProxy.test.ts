import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// The board's modules open the database at import: point DATA_DIR at a throwaway directory first.
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-')))
process.env.DATA_DIR = path.join(tmp, 'data')

const { readAuthMode, readPublicEntrance, config } = await import('./config')
const { guardRequest } = await import('./entrance')
const { hashSecret, sessionCookieName } = await import('./credentials')
const { mintPreviewLink, signPreviewValue, previewCookieName, PREVIEW_LINK_TTL_MS } = await import(
  './previewLink'
)
const proxy = await import('./previewProxy')
type ProxyDeps = import('./previewProxy').ProxyDeps
const { db, schema } = await import('#/db')
import type { RunState } from './runs'

const PUBLIC = 'devbox.example-tailnet.ts.net'
const entrance = readPublicEntrance({ PUBLIC_ORIGIN: `https://${PUBLIC}` })!
const production = readAuthMode({})
const signOff = readAuthMode({ BOARD_ENV: 'development', AUTH: 'off', DEV_HUMAN: 'enrique' })

const FUTURE = '2099-01-01T00:00:00.000Z'
const START = Date.parse('2026-11-09T10:00:00.000Z')
const RUNNING_AT = '2026-11-09T09:59:00.000Z'

// --- the fake preview: a real HTTP server on loopback, on an ephemeral port ---

interface Seen {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: string
}
const seen: Seen[] = []
let release: () => void = () => {}
let gate = new Promise<void>((resolve) => (release = resolve))
let previewPort = 0
let deadPort = 0
let previewServer: http.Server

function route(req: IncomingMessage, res: ServerResponse, body: Buffer) {
  const url = req.url ?? '/'
  const p = url.split('?')[0]
  if (p === '/html') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'set-cookie': ['sid=abc; Path=/; Domain=127.0.0.1; HttpOnly', 'theme=dark; Path=/'],
    })
    return res.end('<!doctype html><html><head><title>t</title></head><body><p>Hello</p></body></html>')
  }
  if (p === '/latin') {
    res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' })
    return res.end(Buffer.from('<!doctype html><html><head></head><body>caf\xe9</body></html>', 'latin1'))
  }
  if (p === '/latin-meta') {
    res.writeHead(200, { 'content-type': 'text/html' })
    return res.end(
      Buffer.from('<html><head><meta charset="windows-1252"></head><body>caf\xe9</body></html>', 'latin1'),
    )
  }
  if (p === '/big') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(Buffer.alloc(proxy.HTML_CAP_BYTES + 1, 'a'))
  }
  if (p === '/bin') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    return res.end(Buffer.from([0, 1, 2, 255, 254, 13, 10]))
  }
  if (p === '/app.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' })
    return res.end('const x = "/api/y";\r\n')
  }
  if (p === '/go') {
    res.writeHead(302, { location: `http://127.0.0.1:${previewPort}/next?x=1` })
    return res.end()
  }
  if (p === '/go-local') {
    res.writeHead(302, { location: `http://localhost:${previewPort}/a` })
    return res.end()
  }
  if (p === '/root') {
    res.writeHead(302, { location: '/login' })
    return res.end()
  }
  if (p === '/rel') {
    res.writeHead(302, { location: 'next' })
    return res.end()
  }
  if (p === '/ext') {
    res.writeHead(302, { location: 'https://example.com/a' })
    return res.end()
  }
  if (p === '/sse') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write('event: one\ndata: 1\n\n')
    void gate.then(() => {
      res.write('event: two\ndata: 2\n\n')
      res.end()
    })
    return
  }
  if (p === '/echo') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    return res.end(body)
  }
  if (p === '/silent') return // never answers
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ path: url, ok: true }))
}

const upstreamCount = () => seen.length

beforeAll(async () => {
  previewServer = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: body.toString() })
      route(req, res, body)
    })
  })
  await new Promise<void>((resolve) => previewServer.listen(0, '127.0.0.1', resolve))
  previewPort = (previewServer.address() as net.AddressInfo).port
  // A port nothing listens on: taken, then freed.
  const dead = net.createServer()
  await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve))
  deadPort = (dead.address() as net.AddressInfo).port
  await new Promise<void>((resolve) => dead.close(() => resolve()))

  // Projects A and B, a ticket and a workspace in each, and the agents' personas.
  const projectA = db.insert(schema.projects).values({ name: 'Project A' }).returning().get().id
  const projectB = db.insert(schema.projects).values({ name: 'Project B' }).returning().get().id
  const projectC = db.insert(schema.projects).values({ name: 'Project C' }).returning().get().id
  db.insert(schema.agents)
    .values([
      { projectId: projectA, name: 'builder', createdBy: 'test' },
      { projectId: projectB, name: 'reviewer', createdBy: 'test' },
      { projectId: projectA, name: 'dual', createdBy: 'test' },
      { projectId: projectB, name: 'dual', createdBy: 'test' },
      { projectId: projectC, name: 'other', createdBy: 'test' },
    ])
    .run()
  const ticketA = db
    .insert(schema.tickets)
    .values({ projectId: projectA, title: 'A', createdBy: 'test' })
    .returning()
    .get().id
  const ticketB = db
    .insert(schema.tickets)
    .values({ projectId: projectB, title: 'B', createdBy: 'test' })
    .returning()
    .get().id
  wsA = db.insert(schema.workspaces).values({ ticketId: ticketA, name: 'a' }).returning().get().id
  wsB = db.insert(schema.workspaces).values({ ticketId: ticketB, name: 'b' }).returning().get().id
  projectOfWs.set(wsA, projectA)
  projectOfWs.set(wsB, projectB)

  // Tokens: the builder (persona of A), the reviewer (B), a dual persona (A and B), a boss (no persona),
  // a revoked and an expired builder.
  const tokens: [string, string, string | undefined, string][] = [
    [TOKEN.builder, 'builder', undefined, FUTURE],
    [TOKEN.reviewer, 'reviewer', undefined, FUTURE],
    [TOKEN.dual, 'dual', undefined, FUTURE],
    [TOKEN.boss, 'boss', undefined, FUTURE],
    [TOKEN.revoked, 'builder', '2026-01-01T00:00:00.000Z', FUTURE],
    [TOKEN.expired, 'builder', undefined, '2026-01-01T00:00:00.000Z'],
  ]
  for (const [secret, name, revokedAt, expiresAt] of tokens)
    db.insert(schema.agentTokens)
      .values({ tokenHash: hashSecret(secret), name, revokedAt, expiresAt })
      .run()

  // The human: a session of localhost and one of the public host (a passkey for each origin).
  for (const [rpId, secret] of [
    ['localhost', SESSION.local],
    [PUBLIC, SESSION.public],
  ] as const) {
    const passkey = db
      .insert(schema.passkeys)
      .values({ credentialId: `cred-${rpId}`, publicKey: 'AAAA', rpId, name: rpId })
      .returning()
      .get()
    db.insert(schema.sessions)
      .values({ tokenHash: hashSecret(secret), passkeyId: passkey.id, expiresAt: FUTURE, lastSeenAt: FUTURE })
      .run()
  }
})

afterAll(async () => {
  await new Promise<void>((resolve) => previewServer.close(() => resolve()))
})

const TOKEN = {
  builder: 'token-of-builder',
  reviewer: 'token-of-reviewer',
  dual: 'token-of-dual',
  boss: 'token-of-boss',
  revoked: 'token-revoked',
  expired: 'token-expired',
}
const SESSION = { local: 'session-on-localhost', public: 'session-on-the-tailnet' }

let wsA = 0
let wsB = 0
const projectOfWs = new Map<number, number>()
const RUN = 7

// --- run state and the clock, injected into the proxy ---

let clock = START
let states = new Map<string, RunState>()
let listening: (port: number) => Promise<string[]>
let previewRuns = new Map<number, number | null>()

const key = (w: number, r: number) => `${w}:${r}`

function runningState(over: Partial<RunState> = {}): RunState {
  return {
    workspaceId: wsA,
    ticketId: 1,
    runId: RUN,
    runName: 'Preview',
    runType: 'preview',
    repoId: 1,
    status: 'running',
    step: null,
    port: previewPort,
    pid: null,
    url: `http://127.0.0.1:${previewPort}`,
    startedAt: RUNNING_AT,
    runningAt: RUNNING_AT,
    stoppedAt: null,
    reason: null,
    tail: [],
    tailLog: null,
    path: '/worktree',
    logs: { build: '/b.log', server: '/s.log' },
    ...over,
  }
}

function deps(over: Partial<ProxyDeps> = {}): Partial<ProxyDeps> {
  return {
    now: () => clock,
    auth: () => production,
    entrance: () => null,
    runOf: (w, r) => states.get(key(w, r)) ?? null,
    listening: (port) => listening(port),
    projectOf: (w) => projectOfWs.get(w) ?? null,
    previewRunId: (w) => previewRuns.get(w) ?? null,
    upstreamMs: 300,
    ...over,
  }
}

const LOCAL = `localhost:${config.port}`
const PUBLIC_HOST = PUBLIC

/** A request to the board's origin, as a browser or an agent sends it. */
function request(
  p: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string; host?: string } = {},
): Request {
  const host = opts.host ?? LOCAL
  return new Request(`http://${host}${p}`, {
    method: opts.method ?? 'GET',
    headers: { host, ...opts.headers },
    body: opts.body,
  })
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` })
const cookies = (...pairs: string[]) => ({ cookie: pairs.join('; ') })
const sessionHeader = (secret: string) => cookies(`${sessionCookieName(config.port)}=${secret}`)

function previewPath(w = wsA, r = RUN, rest = '') {
  return `/p/${w}/${r}/${rest}`
}

beforeEach(() => {
  clock = START
  seen.length = 0
  gate = new Promise<void>((resolve) => (release = resolve))
  states = new Map([[key(wsA, RUN), runningState()]])
  previewRuns = new Map([[wsA, RUN]])
  listening = async (port) => [`127.0.0.1:${port}`]
})

async function serve(r: Request, over: Partial<ProxyDeps> = {}) {
  const res = await proxy.servePreview(r, {}, deps(over))
  if (!res) throw new Error(`not a preview path: ${r.url}`)
  return res
}

const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error

describe("which paths are the proxy's", () => {
  it('answers no other path', async () => {
    expect(await proxy.servePreview(request('/api/health'), {}, deps())).toBeNull()
    expect(await proxy.servePreview(request('/pages/1/2/'), {}, deps())).toBeNull()
  })

  it('answers 404 on every preview path with sign-in off, and reaches no upstream', async () => {
    for (const p of [previewPath(), previewPath(wsA, RUN, 'api/hello'), `/p/${wsA}/${RUN}`]) {
      const res = await serve(request(p, { headers: bearer(TOKEN.builder) }), { auth: () => signOff })
      expect(res.status).toBe(404)
    }
    expect(upstreamCount()).toBe(0)
  })
})

describe('who may reach the preview', () => {
  it('answers 401 JSON to a request with no credential, and reaches no upstream', async () => {
    const res = await serve(request(previewPath(wsA, RUN, 'api/hello')))
    expect(res.status).toBe(401)
    expect(await errorOf(res)).toContain('sign in')
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(upstreamCount()).toBe(0)
  })

  it('answers 401 to a bare Bearer, an unknown, a revoked and an expired agent token, whatever cookie comes with it', async () => {
    const attempts: Record<string, string>[] = [
      { authorization: 'Bearer' },
      { authorization: 'Bearer nobody-knows-this' },
      { authorization: `Bearer ${TOKEN.revoked}` },
      { authorization: `Bearer ${TOKEN.expired}` },
      { authorization: 'Bearer nobody', ...sessionHeader(SESSION.local) },
    ]
    for (const headers of attempts) {
      const res = await serve(request(previewPath(wsA, RUN, 'api/hello'), { headers }))
      expect(res.status, JSON.stringify(headers)).toBe(401)
    }
    expect(upstreamCount()).toBe(0)
  })

  it("lets the agent token of a persona of the preview's project through", async () => {
    const res = await serve(request(previewPath(wsA, RUN, 'api/hello'), { headers: bearer(TOKEN.builder) }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
    expect(upstreamCount()).toBe(1)
  })

  it("answers 403 to another project's agent, and reaches no upstream", async () => {
    const res = await serve(request(previewPath(wsA, RUN, 'api/hello'), { headers: bearer(TOKEN.reviewer) }))
    expect(res.status).toBe(403)
    expect(upstreamCount()).toBe(0)
  })

  it('answers 403 to a token named as a persona of two projects, and to one named as none', async () => {
    expect((await serve(request(previewPath(wsA, RUN), { headers: bearer(TOKEN.dual) }))).status).toBe(403)
    expect((await serve(request(previewPath(wsA, RUN), { headers: bearer(TOKEN.boss) }))).status).toBe(403)
    expect(upstreamCount()).toBe(0)
  })

  it('lets the human in on the origin they signed in on, and refuses a session of the other origin', async () => {
    expect((await serve(request(previewPath(), { headers: sessionHeader(SESSION.local) }))).status).toBe(200)
    expect((await serve(request(previewPath(), { headers: sessionHeader(SESSION.public) }))).status).toBe(401)
    const onTheTailnet = await serve(
      request(previewPath(), { headers: sessionHeader(SESSION.public), host: PUBLIC_HOST }),
      { entrance: () => entrance },
    )
    expect(onTheTailnet.status).toBe(200)
    const sessionOfOther = await serve(
      request(previewPath(), { headers: sessionHeader(SESSION.local), host: PUBLIC_HOST }),
      { entrance: () => entrance },
    )
    expect(sessionOfOther.status).toBe(401)
  })

  it('refuses a write with the session cookie from a foreign origin before the proxy (the guard)', () => {
    const verdict = guardRequest(
      {
        method: 'POST',
        headers: new Headers({
          host: LOCAL,
          origin: 'http://evil.example',
          cookie: `${sessionCookieName(config.port)}=${SESSION.local}`,
        }),
        peer: '127.0.0.1',
      },
      { authOff: false, port: config.port, entrance: null, dataDir: tmp },
    )
    expect(verdict.allow).toBe(false)
    expect(upstreamCount()).toBe(0)
  })

  it('refuses Tailscale Funnel on a preview path (the guard)', () => {
    const verdict = guardRequest(
      {
        method: 'GET',
        headers: new Headers({ host: LOCAL, 'tailscale-funnel-request': '1' }),
        peer: '127.0.0.1',
      },
      { authOff: false, port: config.port, entrance: entrance, dataDir: tmp },
    )
    expect(verdict.allow).toBe(false)
  })

  it('redirects a path without its trailing slash, after the credentials check', async () => {
    const res = await serve(request(`/p/${wsA}/${RUN}?x=1`, { headers: bearer(TOKEN.builder) }))
    expect(res.status).toBe(308)
    expect(res.headers.get('location')).toBe(`/p/${wsA}/${RUN}/?x=1`)
    const anon = await serve(request(`/p/${wsA}/${RUN}`))
    expect(anon.status).toBe(401)
  })
})

describe('the run behind the path', () => {
  it('answers 404 with the start hint for a run never started, and for a stopped one', async () => {
    states = new Map()
    const never = await serve(request(previewPath(), { headers: bearer(TOKEN.builder) }))
    expect(never.status).toBe(404)
    expect(await errorOf(never)).toContain('runs no preview')
    states.set(key(wsA, RUN), runningState({ status: 'stopped', port: null, runningAt: null }))
    const stopped = await serve(request(previewPath(), { headers: bearer(TOKEN.builder) }))
    expect(stopped.status).toBe(404)
    expect(await errorOf(stopped)).toBe(
      "the preview is not running: start it on the ticket's Preview card or with start_run",
    )
    expect(upstreamCount()).toBe(0)
  })

  it('answers 404 for a job, which has no port to proxy', async () => {
    states.set(key(wsA, RUN), runningState({ runType: 'job', port: null }))
    expect((await serve(request(previewPath(), { headers: bearer(TOKEN.builder) }))).status).toBe(404)
  })

  it('answers 502 with a message when the preview does not answer in time', async () => {
    states.set(key(wsA, RUN), runningState({ port: previewPort }))
    const res = await serve(request(previewPath(wsA, RUN, 'silent'), { headers: bearer(TOKEN.builder) }), {
      upstreamMs: 150,
    })
    expect(res.status).toBe(502)
    expect(await errorOf(res)).toBe('the preview is running but does not answer')
  })

  it('answers 502 when nothing listens on the port (a dead target)', async () => {
    states.set(key(wsA, RUN), runningState({ port: deadPort }))
    const res = await serve(request(previewPath(), { headers: bearer(TOKEN.builder) }))
    expect(res.status).toBe(502)
    expect(await errorOf(res)).toBe('the preview is running but does not answer')
  })

  it('answers 502 and reaches nothing when the port listens beyond loopback', async () => {
    for (const addresses of [['0.0.0.0:PORT'], ['192.168.1.20:PORT'], ['[::]:PORT'], ['*:PORT']]) {
      listening = async (port) => addresses.map((a) => a.replace('PORT', String(port)))
      const res = await serve(request(previewPath(), { headers: bearer(TOKEN.builder) }))
      expect(res.status, addresses.join()).toBe(502)
      expect(await errorOf(res)).toContain('listens beyond this machine')
    }
    expect(upstreamCount()).toBe(0)
  })

  it('answers 502 when the addresses of the port cannot be told (fails closed)', async () => {
    listening = async () => []
    const res = await serve(request(previewPath(), { headers: bearer(TOKEN.builder) }))
    expect(res.status).toBe(502)
    listening = async () => {
      throw new Error('ss is not installed')
    }
    expect((await serve(request(previewPath(), { headers: bearer(TOKEN.builder) }))).status).toBe(502)
    expect(upstreamCount()).toBe(0)
  })

  it('proxies when the port listens on loopback only, IPv4 and IPv6 alike', async () => {
    listening = async (port) => [`127.0.0.1:${port}`, `[::1]:${port}`]
    expect((await serve(request(previewPath(), { headers: bearer(TOKEN.builder) }))).status).toBe(200)
  })
})

describe('the target, whatever the request says', () => {
  it('sends the request to 127.0.0.1 on the run port, whatever Host, forwarded headers and paths it has', async () => {
    const res = await serve(
      request(previewPath(wsA, RUN, '/x'), {
        headers: {
          ...bearer(TOKEN.builder),
          'x-forwarded-host': 'evil.example',
          'x-board-target': `127.0.0.1:${deadPort}`,
          forwarded: 'for=evil',
        },
        host: 'evil.example:9999',
      }),
    )
    expect(res.status).toBe(200)
    const sent = seen.at(-1)!
    expect(sent.headers.host).toBe(`127.0.0.1:${previewPort}`)
    expect(sent.headers['x-forwarded-host']).toBe('evil.example:9999')
    // The header is an ordinary one to the proxy: forwarded, and it names no target.
    expect(sent.headers['x-board-target']).toBe(`127.0.0.1:${deadPort}`)
    expect(seen.length).toBe(1)
    expect(sent.headers.forwarded).toBeUndefined()
  })

  it('never takes a //host path as the target: it stays a path on the run port', async () => {
    const res = await serve(
      request(previewPath(wsA, RUN, '/evil.example/x'), { headers: bearer(TOKEN.builder) }),
    )
    expect(res.status).toBe(200)
    expect(seen.at(-1)!.headers.host).toBe(`127.0.0.1:${previewPort}`)
    const dbl = await serve(request(`/p/${wsA}/${RUN}//evil.example/y`, { headers: bearer(TOKEN.builder) }))
    expect(dbl.status).toBe(200)
    expect(seen.at(-1)!.headers.host).toBe(`127.0.0.1:${previewPort}`)
    expect(seen.at(-1)!.url).toBe('//evil.example/y')
  })

  it('forwards the path under the prefix, the query as it came, and the method and body', async () => {
    const res = await serve(
      request(previewPath(wsA, RUN, 'echo?a=1'), {
        method: 'POST',
        body: 'hello',
        headers: bearer(TOKEN.builder),
      }),
    )
    expect(await res.text()).toBe('hello')
    expect(seen.at(-1)).toMatchObject({ method: 'POST', url: '/echo?a=1', body: 'hello' })
  })
})

describe('the headers on each side', () => {
  it("sends no Authorization and no board cookie upstream, and keeps the preview's own cookies", async () => {
    await serve(
      request(previewPath(wsA, RUN, 'api/hello'), {
        headers: {
          ...bearer(TOKEN.builder),
          cookie: `${sessionCookieName(config.port)}=${SESSION.local}; ${previewCookieName(wsA, RUN)}=v1.1.s1.x; theme=dark`,
          'x-test-actor': 'human:someone',
        },
      }),
    )
    const sent = seen.at(-1)!
    expect(sent.headers.authorization).toBeUndefined()
    expect(sent.headers.cookie).toBe('theme=dark')
    expect(sent.headers['x-test-actor']).toBeUndefined()
  })

  it("rewrites the preview's Set-Cookie to the run's path with no Domain, and its Location to the prefix", async () => {
    const res = await serve(request(previewPath(wsA, RUN, 'html'), { headers: bearer(TOKEN.builder) }))
    const cookies = res.headers.getSetCookie()
    expect(cookies).toContain(`sid=abc; HttpOnly; Path=/p/${wsA}/${RUN}/`)
    expect(cookies).toContain(`theme=dark; Path=/p/${wsA}/${RUN}/`)
    expect(cookies.join()).not.toMatch(/domain=/i)
    expect(res.headers.get('referrer-policy')).toBe('same-origin')
  })

  it('rewrites Location of the loopback address or a root path to the prefix, and leaves others', async () => {
    const prefix = `/p/${wsA}/${RUN}/`
    const go = await serve(request(previewPath(wsA, RUN, 'go'), { headers: bearer(TOKEN.builder) }))
    expect(go.headers.get('location')).toBe(`${prefix}next?x=1`)
    const local = await serve(request(previewPath(wsA, RUN, 'go-local'), { headers: bearer(TOKEN.builder) }))
    expect(local.headers.get('location')).toBe(`${prefix}a`)
    const root = await serve(request(previewPath(wsA, RUN, 'root'), { headers: bearer(TOKEN.builder) }))
    expect(root.headers.get('location')).toBe(`${prefix}login`)
    const rel = await serve(request(previewPath(wsA, RUN, 'rel'), { headers: bearer(TOKEN.builder) }))
    expect(rel.headers.get('location')).toBe('next')
    const ext = await serve(request(previewPath(wsA, RUN, 'ext'), { headers: bearer(TOKEN.builder) }))
    expect(ext.headers.get('location')).toBe('https://example.com/a')
  })

  it("rewrites a Location to a loopback port that is not the run's not at all", () => {
    expect(proxy.rewriteLocation('http://127.0.0.1:9/x', '/p/1/2/', 8)).toBe('http://127.0.0.1:9/x')
    expect(proxy.rewriteLocation('/x', '/p/1/2/', 8)).toBe('/p/1/2/x')
    expect(proxy.rewriteLocation('/p/1/2/x', '/p/1/2/', 8)).toBe('/p/1/2/x')
    expect(proxy.rewriteLocation('//evil.example/x', '/p/1/2/', 8)).toBe('//evil.example/x')
  })

  it('rewrites a Set-Cookie: no Domain, Path set, the rest kept', () => {
    expect(proxy.rewriteSetCookie('a=1; Domain=127.0.0.1; Path=/; Secure', '/p/1/2/')).toBe(
      'a=1; Secure; Path=/p/1/2/',
    )
    expect(proxy.rewriteSetCookie('path=5; Max-Age=3', '/p/1/2/')).toBe('path=5; Max-Age=3; Path=/p/1/2/')
  })
})

describe('the body', () => {
  it('gives an HTML page one runtime script, once, and passes every other body byte for byte', async () => {
    const html = await serve(request(previewPath(wsA, RUN, 'html'), { headers: bearer(TOKEN.builder) }))
    const text = await html.text()
    expect(text.match(/<script>\(function \(p\)/g)).toHaveLength(1)
    expect(text.indexOf('<script>')).toBeLessThan(text.indexOf('</head>'))
    expect(text).toContain(`})("/p/${wsA}/${RUN}/");`)

    const bin = await serve(request(previewPath(wsA, RUN, 'bin'), { headers: bearer(TOKEN.builder) }))
    expect(Buffer.from(await bin.arrayBuffer())).toEqual(Buffer.from([0, 1, 2, 255, 254, 13, 10]))
    const js = await serve(request(previewPath(wsA, RUN, 'app.js'), { headers: bearer(TOKEN.builder) }))
    expect(await js.text()).toBe('const x = "/api/y";\r\n')
  })

  it('decodes an HTML page by its charset, sends it as UTF-8, and refuses one bigger than the cap', async () => {
    for (const rest of ['latin', 'latin-meta']) {
      const res = await serve(request(previewPath(wsA, RUN, rest), { headers: bearer(TOKEN.builder) }))
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
      const text = await res.text()
      expect(text).toContain('<body>café</body>')
      expect(text).toContain('<script>')
    }
    const big = await serve(request(previewPath(wsA, RUN, 'big'), { headers: bearer(TOKEN.builder) }))
    expect(big.status).toBe(502)
    expect(await errorOf(big)).toBe('the preview response is too large: refused')
  })

  it('reads the charset of a page from its header or its meta, and only for the first kilobyte of the head', () => {
    expect(proxy.charsetOf('text/html; charset="ISO-8859-1"', '')).toBe('iso-8859-1')
    expect(proxy.charsetOf('text/html', '<meta http-equiv="x" content="y"><meta charset=utf-8>')).toBe(
      'utf-8',
    )
    expect(proxy.charsetOf('text/html', '<p>nothing</p>')).toBeNull()
    expect(proxy.withCharset('text/html; charset=iso-8859-1', 'utf-8')).toBe('text/html; charset=utf-8')
    expect(proxy.withCharset('text/html', 'utf-8')).toBe('text/html; charset=utf-8')
  })

  it('passes an event stream as it is sent: event one arrives before the preview sends event two', async () => {
    const res = await serve(request(previewPath(wsA, RUN, 'sse'), { headers: bearer(TOKEN.builder) }))
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let got = ''
    while (!got.includes('event: one')) {
      const { value, done } = await reader.read()
      if (done) break
      got += decoder.decode(value)
    }
    expect(got).toContain('event: one')
    expect(got).not.toContain('event: two')
    release()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      got += decoder.decode(value)
    }
    expect(got).toContain('event: two')
  })
})

describe('links to a preview', () => {
  const mint = (principal: `s${number}` | `t${number}`, w = wsA, r = RUN, runningAt = RUNNING_AT) =>
    mintPreviewLink(w, r, runningAt, principal, clock)

  const tokenId = (secret: string) =>
    db
      .select()
      .from(schema.agentTokens)
      .where(eq(schema.agentTokens.tokenHash, hashSecret(secret)))
      .get()!.id

  it('redeems a link once or many times within five minutes, sets the cookie, and then the cookie reaches the preview', async () => {
    const link = mint(`t${tokenId(TOKEN.builder)}`)
    for (let i = 0; i < 2; i++) {
      const res = await serve(request(link.url))
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe(previewPath())
    }
    const first = await serve(request(link.url))
    const setCookie = first.headers.get('set-cookie')!
    const value = setCookie.split(';')[0]!.split('=').slice(1).join('=')
    const cookieOnly = await serve(
      request(previewPath(wsA, RUN, 'api/hello'), {
        headers: cookies(`${previewCookieName(wsA, RUN)}=${value}`),
      }),
    )
    expect(cookieOnly.status).toBe(200)
  })

  it('redirects with the rest of the query as it came, only the link taken off', () => {
    expect(proxy.withoutLink('?pl=abc&q=%20a%7Eb+c&r=%2B', 'abc')).toBe('q=%20a%7Eb+c&r=%2B')
    expect(proxy.withoutLink('?q=1&pl=abc', 'abc')).toBe('q=1')
    expect(proxy.withoutLink('?p%6c=abc&x=1', 'abc')).toBe('x=1')
    expect(proxy.withoutLink('?pl=other&pl=abc', 'abc')).toBe('pl=other')
    expect(proxy.withoutLink('?pl=abc', 'abc')).toBe('')
  })

  it('keeps the query of a redeemed link as it came in the redirect', async () => {
    const link = mint(`t${tokenId(TOKEN.builder)}`)
    const res = await serve(request(`${link.url}&q=%20a%7Eb`))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`${previewPath()}?q=%20a%7Eb`)
  })

  it('sets the cookie with HttpOnly, SameSite=Lax, the run path and Max-Age 900, Secure only over https', async () => {
    const link = mint(`t${tokenId(TOKEN.builder)}`)
    const res = await serve(request(link.url))
    const setCookie = res.headers.get('set-cookie')!
    expect(setCookie.startsWith(`${previewCookieName(wsA, RUN)}=`)).toBe(true)
    for (const attr of ['Path=/p/' + wsA + '/' + RUN + '/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=900'])
      expect(setCookie).toContain(attr)
    expect(setCookie).not.toContain('Secure')
    const secure = await serve(request(link.url, { host: PUBLIC_HOST }), { entrance: () => entrance })
    expect(secure.headers.get('set-cookie')).toContain('Secure')
  })

  it('answers 401 after five minutes, for another run, after a restart, and for a link that was tampered with', async () => {
    const link = mint(`t${tokenId(TOKEN.builder)}`)
    clock += PREVIEW_LINK_TTL_MS + 1000
    expect((await serve(request(link.url))).status).toBe(401)

    clock = START
    const other = mint(`t${tokenId(TOKEN.builder)}`, wsA, RUN + 1)
    expect((await serve(request(other.url))).status).toBe(401)

    const before = mint(`t${tokenId(TOKEN.builder)}`, wsA, RUN, '2026-11-09T09:00:00.000Z')
    expect((await serve(request(before.url))).status).toBe(401)

    const forged = link.url.replace(/\.[^.]+$/, '.AAAA')
    expect((await serve(request(forged))).status).toBe(401)
    const swapped = link.url.replace(/\.t\d+\./, '.t999999.')
    expect((await serve(request(swapped))).status).toBe(401)
  })

  it('answers 401 for a link once its token is revoked, and for a cookie of a token revoked later', async () => {
    const secret = 'token-to-revoke'
    db.insert(schema.agentTokens)
      .values({ tokenHash: hashSecret(secret), name: 'builder', expiresAt: FUTURE })
      .run()
    const id = tokenId(secret)
    const link = mint(`t${id}`)
    const res = await serve(request(link.url))
    const value = res.headers.get('set-cookie')!.split(';')[0]!.split('=').slice(1).join('=')
    db.update(schema.agentTokens)
      .set({ revokedAt: new Date(clock).toISOString() })
      .where(eq(schema.agentTokens.id, id))
      .run()
    expect((await serve(request(link.url))).status).toBe(401)
    const cookie = await serve(
      request(previewPath(), { headers: cookies(`${previewCookieName(wsA, RUN)}=${value}`) }),
    )
    expect(cookie.status).toBe(401)
  })

  it("a pl that is not a good link is the preview's own query: the usual checks go on, the preview gets it", async () => {
    const res = await serve(
      request(previewPath(wsA, RUN, 'echo?pl=nope&a=%20b~'), { headers: sessionHeader(SESSION.local) }),
    )
    expect(res.status).toBe(200)
    expect(seen.at(-1)!.url).toBe('/echo?pl=nope&a=%20b~')
    expect((await serve(request(previewPath(wsA, RUN, 'echo?pl=nope')))).status).toBe(401)
  })

  it("a good link on a path other than the run's root is not redeemed: it is the preview's query", async () => {
    const link = mint(`t${tokenId(TOKEN.builder)}`)
    const pl = new URL(link.url, 'http://board.test').searchParams.get('pl')!
    expect((await serve(request(previewPath(wsA, RUN, `echo?pl=${pl}`)))).status).toBe(401)
    const res = await serve(
      request(previewPath(wsA, RUN, `echo?pl=${pl}`), { headers: bearer(TOKEN.builder) }),
    )
    expect(res.status).toBe(200)
    expect(seen.at(-1)!.url).toBe(`/echo?pl=${pl}`)
  })

  it('answers 401 for a cookie past its fifteen minutes', async () => {
    const value = signPreviewValue(wsA, RUN, RUNNING_AT, `t${tokenId(TOKEN.builder)}`, clock + 15 * 60_000)
    const cookie = cookies(`${previewCookieName(wsA, RUN)}=${value}`)
    expect((await serve(request(previewPath(), { headers: cookie }))).status).toBe(200)
    clock += 15 * 60_000
    expect((await serve(request(previewPath(), { headers: cookie }))).status).toBe(401)
  })

  it('a link for a human session works without any header, and fails once the session is gone', async () => {
    const secret = 'session-for-a-link'
    const passkey = db
      .insert(schema.passkeys)
      .values({ credentialId: 'cred-link', publicKey: 'AAAA', rpId: 'localhost', name: 'link' })
      .returning()
      .get()
    db.insert(schema.sessions)
      .values({ tokenHash: hashSecret(secret), passkeyId: passkey.id, expiresAt: FUTURE, lastSeenAt: FUTURE })
      .run()
    const sessionId = db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.tokenHash, hashSecret(secret)))
      .get()!.id
    const link = mint(`s${sessionId}`)
    const res = await serve(request(link.url))
    expect(res.status).toBe(302)
    const value = res.headers.get('set-cookie')!.split(';')[0]!.split('=').slice(1).join('=')
    expect(
      (await serve(request(previewPath(), { headers: cookies(`${previewCookieName(wsA, RUN)}=${value}`) })))
        .status,
    ).toBe(200)
    db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId)).run()
    expect(
      (await serve(request(previewPath(), { headers: cookies(`${previewCookieName(wsA, RUN)}=${value}`) })))
        .status,
    ).toBe(401)
  })

  it('never puts the token, nor its hash, in the link, the redirect or the cookie', async () => {
    const id = tokenId(TOKEN.builder)
    const link = mint(`t${id}`)
    const res = await serve(request(link.url))
    const everything = [link.url, res.headers.get('location'), res.headers.get('set-cookie')].join('\n')
    const sha = createHash('sha256').update(TOKEN.builder).digest('hex')
    expect(everything).not.toContain(TOKEN.builder)
    expect(everything).not.toContain(sha)
  })

  it('mints a link only for a caller who may view the preview, and only for a running one', () => {
    const builder = new Request(`http://${LOCAL}/api/workspaces/${wsA}/preview/link`, {
      method: 'POST',
      headers: { host: LOCAL, ...bearer(TOKEN.builder) },
    })
    const link = proxy.linkFor(builder, wsA, deps())
    expect(link.url).toMatch(new RegExp(`^/p/${wsA}/${RUN}/\\?pl=v1\\.`))
    expect(link.expiresAt).toBeDefined()
    const reviewer = new Request(`http://${LOCAL}/x`, { headers: { host: LOCAL, ...bearer(TOKEN.reviewer) } })
    expect(() => proxy.linkFor(reviewer, wsA, deps())).toThrow(/project/)
    const anon = new Request(`http://${LOCAL}/x`, { headers: { host: LOCAL } })
    expect(() => proxy.linkFor(anon, wsA, deps())).toThrow()
    states.set(key(wsA, RUN), runningState({ status: 'stopped', port: null }))
    expect(() => proxy.linkFor(builder, wsA, deps())).toThrow(/not running/)
  })

  it('mints nothing with sign-in off', () => {
    const builder = new Request(`http://${LOCAL}/x`, { headers: { host: LOCAL, ...bearer(TOKEN.builder) } })
    expect(() => proxy.linkFor(builder, wsA, deps({ auth: () => signOff }))).toThrow(/sign-in is off/)
  })
})
