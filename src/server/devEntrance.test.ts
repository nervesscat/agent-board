import fs from 'node:fs'
import http, { type IncomingMessage } from 'node:http'
import net from 'node:net'
import path from 'node:path'

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { hashSecret } from './credentials'
import { dropForwarding, entranceGuard, nodeHeaders } from './devEntrance'

/**
 * The guard in front of `vite dev`'s own surface, on a real Vite dev server with the plugin vite.config.ts
 * uses: /@vite/client, /@fs, modules under /src, public/ files, files asked for as assets,
 * /__open-in-editor and the hot-reload WebSocket. Who is signed in comes from a board database of its
 * own, migrated as the board migrates it, with sessions and tokens written into it.
 */

const PUBLIC = 'devbox.example-tailnet.ts.net'
// On the drive the tests run from, as the board's own files are: on Windows Vite serves /@fs/ from the
// root of the current drive.
const cache = path.join(process.cwd(), 'node_modules', '.cache')
fs.mkdirSync(cache, { recursive: true })
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(cache, 'agent-board-entrance-')))
const files = {
  'package.json': '{ "name": "entrance-fixture", "mark": "MARK-PACKAGE" }\n',
  'notes.md': 'MARK-NOTES\n',
  'src/secret.ts': "export const secret = 'MARK-SOURCE'\n",
  'public/favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"><!-- MARK-PUBLIC --></svg>\n',
}
for (const [file, text] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  fs.writeFileSync(path.join(root, file), text)
}
const fsPath = `/@fs/${root.replace(/\\/g, '/')}/package.json`

/** Each of Vite's own paths, the headers that ask for it, and what its answer holds once served. */
const surface: { target: string; headers?: Record<string, string>; mark: string }[] = [
  { target: '/@vite/client', mark: 'createHotContext' },
  { target: fsPath, mark: 'MARK-PACKAGE' },
  { target: '/src/secret.ts', mark: 'MARK-SOURCE' },
  { target: '/favicon.svg', mark: 'MARK-PUBLIC' },
  { target: '/package.json', headers: { 'sec-fetch-dest': 'image' }, mark: 'MARK-PACKAGE' },
  { target: '/notes.md', headers: { 'sec-fetch-dest': 'image' }, mark: 'MARK-NOTES' },
]

/** What `tailscale serve` adds to a request from a tailnet user. */
const SERVE = {
  'x-forwarded-for': '100.101.102.103',
  'x-forwarded-host': PUBLIC,
  'x-forwarded-proto': 'https',
  'tailscale-user-login': 'someone@example.com',
}

// --- the board's database: a session on each origin, an expired one, and agent tokens ---

const dataDir = path.join(root, 'data')
fs.mkdirSync(dataDir)
{
  const sqlite = new Database(path.join(dataDir, 'board.db'))
  migrate(drizzle(sqlite), { migrationsFolder: path.resolve('drizzle') })
  const future = '2099-01-01T00:00:00.000Z'
  sqlite.prepare(`insert into account (id, name, user_handle) values (1, 'Enrique', 'AAAA')`).run()
  const passkey = sqlite.prepare(
    `insert into passkeys (credential_id, public_key, rp_id, name) values (?, 'AAAA', ?, ?)`,
  )
  const session = sqlite.prepare(
    'insert into sessions (token_hash, passkey_id, expires_at, last_seen_at) values (?, ?, ?, ?)',
  )
  const phone = Number(passkey.run('phone', PUBLIC, 'Phone').lastInsertRowid)
  const desktop = Number(passkey.run('desktop', 'localhost', 'Desktop').lastInsertRowid)
  session.run(hashSecret('public-ok'), phone, future, future)
  session.run(hashSecret('public-expired'), phone, '2026-01-01T00:00:00.000Z', future)
  session.run(hashSecret('local-ok'), desktop, future, future)
  const token = sqlite.prepare(
    'insert into agent_tokens (token_hash, name, expires_at, revoked_at) values (?, ?, ?, ?)',
  )
  token.run(hashSecret('agent-ok'), 'claude', future, null)
  token.run(hashSecret('agent-revoked'), 'old', future, '2026-01-01T00:00:00.000Z')
  sqlite.close()
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo
      probe.close(() => resolve(port))
    })
  })

function send(port: number, target: string, headers: Record<string, string>) {
  return new Promise<{ status: number; location?: string; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: target, headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode!, location: res.headers.location, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** A hot-reload WebSocket upgrade, as Vite's client asks for one: the first line of the answer. */
function upgrade(port: number, headers: Record<string, string>) {
  return new Promise<string>((resolve) => {
    const lines = [
      'GET / HTTP/1.1',
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Protocol: vite-hmr',
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    ]
    const socket = net.connect(port, '127.0.0.1', () => socket.write(`${lines.join('\r\n')}\r\n\r\n`))
    let got = ''
    const done = () => resolve(got.split('\r\n')[0] ?? '')
    socket.on('data', (d) => {
      got += d.toString('latin1')
      if (got.includes('\r\n')) socket.destroy()
    })
    socket.on('error', () => {})
    socket.on('close', done)
    setTimeout(() => socket.destroy(), 3000)
  })
}

const servers: ViteDevServer[] = []
async function vite(env: Record<string, string>, allowedHosts: string[]) {
  const port = await freePort()
  const server = await createServer({
    configFile: false,
    envDir: false,
    root,
    cacheDir: path.join(root, '.vite'),
    logLevel: 'silent',
    clearScreen: false,
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: '127.0.0.1', port, strictPort: true, allowedHosts, watch: null },
    plugins: [entranceGuard({ env: () => ({ ...env, PORT: String(port) }) })],
  })
  servers.push(server)
  await server.listen()
  return port
}

let on: number
let off: number
beforeAll(async () => {
  const keys = { PUBLIC_ORIGIN: `https://${PUBLIC}`, DATA_DIR: dataDir }
  // The live board: production, the entrance configured, its host allowed as vite.config.ts allows it.
  on = await vite({ ...keys, BOARD_ENV: 'production' }, [PUBLIC])
  // A board without sign-in with the same keys (ignored), as test mode or a preview would have them.
  off = await vite({ ...keys, BOARD_ENV: 'test' }, [])
}, 60_000)

afterAll(async () => {
  for (const server of servers) await server.close()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('vite dev with sign-in on, through the tailnet entrance', () => {
  const ways = (port: number) => ({
    'the public host': { host: PUBLIC },
    'a forged localhost Host': { host: `localhost:${port}`, ...SERVE },
    'a forged 127.0.0.1 Host': { host: `127.0.0.1:${port}`, ...SERVE },
  })

  it("serves none of Vite's own files without a session of the public origin, whatever Host it claims", async () => {
    for (const [way, headers] of Object.entries(ways(on)))
      for (const { target, headers: extra, mark } of [
        ...surface,
        { target: '/__open-in-editor?file=missing-file.txt', mark: 'unused' },
      ]) {
        const res = await send(on, target, { ...headers, ...extra })
        expect(res.status, `${way} ${target}`).toBe(401)
        expect(res.body, `${way} ${target}`).toBe('{"error":"sign in"}')
        expect(res.body).not.toContain(mark)
      }
  })

  it("sends a browser to the board's own login on the public origin, back to the same path", async () => {
    const res = await send(on, '/src/secret.ts?x=1', { host: PUBLIC, ...SERVE, accept: 'text/html' })
    expect(res.status).toBe(302)
    expect(res.location).toBe('/login?next=%2Fsrc%2Fsecret.ts%3Fx%3D1')
    expect(res.body).not.toContain('MARK-SOURCE')
  })

  it('lets the sign-in pages and their endpoints through to the board, and nothing else', async () => {
    // No board behind this Vite: what the guard passes on, Vite answers with a 404 itself.
    for (const target of ['/login?next=%2F', '/setup', '/enroll?code=x', '/api/auth/login/options'])
      expect((await send(on, target, { host: PUBLIC, ...SERVE })).status, target).toBe(404)
    for (const target of ['/login/../src/secret.ts', '/api/auth/passkeys', '/login.ts', '/@fs/login']) {
      const res = await send(on, target, { host: PUBLIC, ...SERVE })
      expect(res.status, target).toBe(401)
      expect(res.body).not.toContain('MARK-SOURCE')
    }
  })

  it('serves them with a session of the public origin or an agent token: the app loads through the entrance', async () => {
    const credentials: Record<string, string>[] = [
      { cookie: `theme=dark; board_session_${on}=public-ok` },
      { authorization: 'Bearer agent-ok' },
    ]
    for (const credential of credentials)
      for (const { target, headers: extra, mark } of surface) {
        const res = await send(on, target, { host: PUBLIC, ...SERVE, ...credential, ...extra })
        expect(res.status, target).toBe(200)
        expect(res.body, target).toContain(mark)
      }
  })

  it('refuses a session of localhost there, an expired one, and a revoked or unknown token', async () => {
    for (const credential of [
      { cookie: `board_session_${on}=local-ok` },
      { cookie: `board_session_${on}=public-expired` },
      { cookie: `board_session_${on}=made-up` },
      { cookie: 'gate_session=public-ok' },
      { authorization: 'Bearer agent-revoked' },
      { authorization: 'Bearer made-up' },
      { authorization: 'Bearer made-up', cookie: `board_session_${on}=public-ok` },
      { authorization: 'Bearer', cookie: `board_session_${on}=public-ok` },
      // The cookie of a board on another port of localhost: never this board's.
      { cookie: `board_session_${on + 1}=public-ok` },
      { cookie: 'board_session=public-ok' },
    ] as Record<string, string>[]) {
      const res = await send(on, '/@vite/client', { host: PUBLIC, ...SERVE, ...credential })
      expect(res.status, JSON.stringify(credential)).toBe(401)
    }
  })

  it('opens no WebSocket through it, signed in or not', async () => {
    for (const headers of [
      { host: PUBLIC },
      { host: `localhost:${on}`, ...SERVE },
      { host: PUBLIC, ...SERVE, cookie: `board_session_${on}=public-ok` },
    ])
      expect(await upgrade(on, headers), JSON.stringify(headers)).toBe('HTTP/1.1 403 Forbidden')
    // The hot reload of a browser on this machine still connects.
    expect(await upgrade(on, { host: `localhost:${on}` })).toBe('HTTP/1.1 101 Switching Protocols')
  })

  it('refuses Tailscale Funnel, signed in or not', async () => {
    const res = await send(on, '/@vite/client', {
      host: PUBLIC,
      ...SERVE,
      cookie: `board_session_${on}=public-ok`,
      'tailscale-funnel-request': '?1',
    })
    expect(res.status).toBe(403)
    expect(res.body).toMatch(/Funnel/)
    expect(await upgrade(on, { host: `localhost:${on}`, 'tailscale-funnel-request': '?1' })).toBe(
      'HTTP/1.1 403 Forbidden',
    )
  })
})

describe('vite dev with sign-in on, straight to the board on this machine', () => {
  it('serves as before, without a session', async () => {
    for (const { target, headers: extra, mark } of surface) {
      const res = await send(on, target, { host: `127.0.0.1:${on}`, ...extra })
      expect(res.status, target).toBe(200)
      expect(res.body, target).toContain(mark)
    }
  })

  it('refuses any Host but loopback and the public name, before Vite answers', async () => {
    const lan = await send(on, '/src/secret.ts', { host: `192.168.1.20:${on}` })
    expect(lan.status).toBe(403)
    expect(lan.body).toMatch(/does not answer for the host/)
    // Vite's own check turns a name away first.
    const name = await send(on, '/src/secret.ts', { host: 'evil.example' })
    expect(name.status).toBe(403)
    expect(name.body).not.toContain('MARK-SOURCE')
    expect(await upgrade(on, { host: `192.168.1.20:${on}` })).toBe('HTTP/1.1 403 Forbidden')
  })
})

describe('vite dev with sign-in off', () => {
  it('refuses every request a proxy forwarded, whatever its Host, on every path; direct ones are served', async () => {
    const forwarded: Record<string, string>[] = [
      { host: `localhost:${off}`, ...SERVE },
      { host: `127.0.0.1:${off}`, 'x-forwarded-for': '100.101.102.103' },
      { host: `localhost:${off}`, 'tailscale-user-login': 'someone@example.com' },
      { host: `localhost:${off}`, ...SERVE, cookie: `board_session_${off}=public-ok` },
    ]
    for (const headers of forwarded)
      for (const { target, headers: extra, mark } of surface) {
        const res = await send(off, target, { ...headers, ...extra })
        expect(res.status, `${JSON.stringify(headers)} ${target}`).toBe(403)
        expect(res.body).not.toContain(mark)
      }
    // Its keys are ignored: the public host is not one of its hosts.
    const named = await send(off, '/src/secret.ts', { host: PUBLIC })
    expect(named.status).toBe(403)
    expect(named.body).not.toContain('MARK-SOURCE')
    expect(await upgrade(off, { host: `localhost:${off}`, ...SERVE })).toBe('HTTP/1.1 403 Forbidden')
    const direct = await send(off, '/src/secret.ts', { host: `localhost:${off}` })
    expect(direct.status).toBe(200)
  })
})

describe('the plugin', () => {
  it('stops vite dev on a PUBLIC_ORIGIN it cannot trust', async () => {
    await expect(
      createServer({
        configFile: false,
        envDir: false,
        root,
        logLevel: 'silent',
        appType: 'custom',
        server: { middlewareMode: true, watch: null },
        plugins: [entranceGuard({ env: () => ({ PUBLIC_ORIGIN: `http://${PUBLIC}` }) })],
      }),
    ).rejects.toThrow(/^agent-board refuses to start: PUBLIC_ORIGIN must be/)
  })

  it('drops forwarded headers a peer that is not loopback sent, raw headers included', () => {
    const req = {
      headers: {
        host: 'localhost:47100',
        'x-forwarded-for': '1.2.3.4',
        'tailscale-user-login': 'x',
        accept: '*/*',
      },
      rawHeaders: [
        'Host',
        'localhost:47100',
        'X-Forwarded-For',
        '1.2.3.4',
        'Tailscale-User-Login',
        'x',
        'Accept',
        '*/*',
      ],
    } as unknown as IncomingMessage
    dropForwarding(req)
    expect(req.headers).toEqual({ host: 'localhost:47100', accept: '*/*' })
    expect(req.rawHeaders).toEqual(['Host', 'localhost:47100', 'Accept', '*/*'])
  })

  it('reads two Host headers as one that no check takes', () => {
    const req = {
      headers: { host: 'localhost:47100' },
      rawHeaders: ['Host', 'localhost:47100', 'host', 'evil.example'],
    } as unknown as IncomingMessage
    expect(nodeHeaders(req).get('host')).toBe('localhost:47100, evil.example')
  })
})
