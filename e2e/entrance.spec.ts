import http from 'node:http'

import type { Project } from '#/lib/api'
import { e2eEnv } from './env'
import { expect, ok, test } from './fixtures'

// The guard in front of every request (src/server/entrance.ts), on the built board in test mode: sign-in
// is off, so it answers on loopback only and never through a proxy such as `tailscale serve`, and a
// write that carries the board's session cookie only from the board's own origins.

const { port, baseURL } = e2eEnv()

test('a Host other than loopback gets a 4xx and no board data', async ({ request }) => {
  for (const host of [
    'evil.example',
    `192.168.1.20:${port}`,
    'devbox.example-tailnet.ts.net',
    `localhost.:${port}`,
  ]) {
    const res = await request.get('/api/me', { headers: { Host: host } })
    expect(res.status(), host).toBe(403)
    expect(await res.text(), host).not.toContain('"actor"')
  }
})

test('a request a proxy forwarded gets a 4xx, whatever Host it claims', async ({ request }) => {
  const forwarded: Record<string, string>[] = [
    { 'X-Forwarded-For': '100.101.102.103' },
    { 'X-Forwarded-Host': 'devbox.example-tailnet.ts.net', 'X-Forwarded-Proto': 'https' },
    { Forwarded: 'for=100.101.102.103;proto=https' },
    { 'Tailscale-User-Login': 'someone@example.com' },
  ]
  for (const headers of forwarded)
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`])
      for (const path of ['/', '/api/me', '/api/projects', '/api/health']) {
        const res = await request.get(path, { headers: { ...headers, Host: host } })
        expect(res.status(), `${JSON.stringify(headers)} ${host} ${path}`).toBe(403)
        expect(await res.text()).not.toContain('"actor"')
      }
})

test('Tailscale Funnel is refused', async ({ request }) => {
  const res = await request.get('/api/me', { headers: { 'Tailscale-Funnel-Request': '?1' } })
  expect(res.status()).toBe(403)
  expect(await res.json()).toEqual({ error: expect.stringMatching(/Funnel/) })
})

test('requests on this machine work: by name and by address', async ({ request }) => {
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
    const res = await request.get('/api/me', { headers: { Host: host } })
    expect(res.status(), host).toBe(200)
    expect(await res.json()).toMatchObject({ boardEnv: 'test', authOff: true })
  }
  expect(await (await request.get('/api/health')).json()).toEqual({ ok: true })
})

test('a write with the session cookie from another origin gets 403 and changes nothing', async ({
  request,
  human,
}) => {
  for (const origin of ['https://evil.example', `http://localhost:${port + 1}`, 'null']) {
    const name = `cross-site ${origin}`
    const res = await request.post('/api/projects', {
      headers: { Cookie: `board_session_${port}=stolen`, Origin: origin },
      data: { name },
    })
    expect(res.status(), origin).toBe(403)
    expect((await ok<Project[]>(human.get('/api/projects'))).map((p) => p.name)).not.toContain(name)
  }
  // From the board's own origin, from an agent (no Origin), or without the cookie, it goes through.
  const own = await request.post('/api/projects', {
    headers: { Cookie: `board_session_${port}=mine`, Origin: baseURL },
    data: { name: 'same origin write' },
  })
  expect(own.status()).toBe(201)
  const agent = await request.post('/api/projects', {
    headers: { Cookie: `board_session_${port}=mine` },
    data: { name: 'write without an Origin' },
  })
  expect(agent.status()).toBe(201)
})

/**
 * A request sent as written, its target included: Playwright's request.get('//x') would take `//x` for a
 * protocol-relative URL and send `/` to the host x, so a target starting with `//` goes through node:http.
 */
function raw(target: string, headers: Record<string, string>) {
  return new Promise<{ status: number; location: string | undefined; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: target, headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

const SLASHED = ['//evil.example/api/me', '//api/me', '//devbox.example-tailnet.ts.net/', '///api/me']

test('a target starting with // meets the guard first: a foreign Host gets its 403, never a redirect', async () => {
  for (const host of ['evil.example', 'devbox.example-tailnet.ts.net', `192.168.1.20:${port}`])
    for (const target of SLASHED) {
      const res = await raw(target, { Host: host })
      const label = `${host} ${target}`
      expect(res.status, label).toBe(403)
      expect(res.location, label).toBeUndefined()
      // Test mode has no entrance: a foreign host is refused with the reason that names none.
      expect(JSON.parse(res.body), label).toEqual({
        error: `no tailnet entrance is configured (PUBLIC_ORIGIN): the board answers on this machine only, not the host ${JSON.stringify(host)}`,
      })
    }
})

test('a target starting with // through a proxy, or Funnel, gets the guard’s 403 on a loopback Host too', async () => {
  const refused: [Record<string, string>, RegExp][] = [
    [{ 'Tailscale-Funnel-Request': '?1' }, /Funnel/],
    [{ 'X-Forwarded-For': '100.101.102.103' }, /never through a proxy/],
    [{ Forwarded: 'for=100.101.102.103;proto=https' }, /never through a proxy/],
    [{ 'Tailscale-User-Login': 'someone@example.com' }, /never through a proxy/],
  ]
  for (const [headers, error] of refused)
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`])
      for (const target of SLASHED) {
        const res = await raw(target, { ...headers, Host: host })
        const label = `${JSON.stringify(headers)} ${host} ${target}`
        expect(res.status, label).toBe(403)
        expect(res.location, label).toBeUndefined()
        expect(res.body, label).not.toContain('"actor"')
        expect(JSON.parse(res.body).error, label).toMatch(error)
      }
})

test('a target starting with // on this machine stays on the board’s own origin', async () => {
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`])
    for (const target of SLASHED) {
      const res = await raw(target, { Host: host })
      const label = `${host} ${target}`
      expect(res.status, label).toBeLessThan(500)
      if (res.location !== undefined)
        expect(new URL(res.location, `http://${host}`).origin, label).toBe(`http://${host}`)
    }
})
