import type { Project } from '#/lib/api'
import { e2eEnv } from './env'
import { expect, ok, test } from './fixtures'

// The guard in front of every request (src/server/entrance.ts), on the built board in test mode: the
// gate is off, so it answers on loopback only and never through a proxy such as `tailscale serve`, and
// a write that carries the gate's cookie only from the board's own origins.

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

test("a write with the gate's cookie from another origin gets 403 and changes nothing", async ({
  request,
  human,
}) => {
  for (const origin of ['https://evil.example', `http://localhost:${port + 1}`, 'null']) {
    const name = `cross-site ${origin}`
    const res = await request.post('/api/projects', {
      headers: { Cookie: 'gate_session=stolen', Origin: origin },
      data: { name },
    })
    expect(res.status(), origin).toBe(403)
    expect((await ok<Project[]>(human.get('/api/projects'))).map((p) => p.name)).not.toContain(name)
  }
  // From the board's own origin, from an agent (no Origin), or without the cookie, it goes through.
  const own = await request.post('/api/projects', {
    headers: { Cookie: 'gate_session=mine', Origin: baseURL },
    data: { name: 'same origin write' },
  })
  expect(own.status()).toBe(201)
  const agent = await request.post('/api/projects', {
    headers: { Cookie: 'gate_session=mine' },
    data: { name: 'write without an Origin' },
  })
  expect(agent.status()).toBe(201)
})
