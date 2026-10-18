import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

import { type Browser, type BrowserContext, type Page, request as apiRequest } from '@playwright/test'

import { e2eEnv } from './env'
import { expect, test } from './fixtures'

/**
 * Signing in with passkeys in a real browser, on a board of its own: the run's build started with
 * sign-in on (BOARD_ENV=development, not test mode), on a free loopback port, on throwaway data with no
 * account. Chrome's virtual authenticator (CDP WebAuthn) stands in for the platform's passkeys. The
 * pages are on localhost, the RP ID passkeys on this machine use.
 */

test.describe.configure({ mode: 'serial' })

let board: ChildProcess
let origin = ''
let port = 0

/** A free loopback port: E2E_AUTH_PORT when set, else one the system picks. */
function freePort(): Promise<number> {
  if (process.env.E2E_AUTH_PORT) return Promise.resolve(Number(process.env.E2E_AUTH_PORT))
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo
      probe.close(() => resolve(port))
    })
  })
}

test.beforeAll(async () => {
  const { root } = e2eEnv()
  port = await freePort()
  origin = `http://localhost:${port}`
  const dataDir = fs.mkdtempSync(path.join(root, 'sign-in-'))
  board = spawn(process.execPath, ['.output-e2e/server/index.mjs'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      BOARD_ENV: 'development',
      AUTH: 'on',
      HOST: '127.0.0.1',
      PORT: String(port),
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: String(port),
      BOARD_URL: origin,
      DATA_DIR: dataDir,
      CLAUDE_HOME: path.join(root, 'home', '.claude'),
      STORAGE: 'local',
      PUBLIC_ORIGIN: '',
    },
  })
  board.stderr!.on('data', (d: Buffer) => process.stderr.write(d))
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`the board with sign-in on did not answer on ${port}`)
})

test.afterAll(() => {
  board?.kill()
})

/** A browser context of its own, with a virtual platform authenticator that says yes at once. */
async function withPasskeys(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: origin })
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  return { context, page }
}

const me = async (page: Page) => {
  const res = await page.request.get('/api/me', { headers: { accept: 'application/json' } })
  return { status: res.status(), body: res.ok() ? await res.json() : null }
}

let host: { context: BrowserContext; page: Page }

test('first boot: the board lands on /setup and gives no data before the account exists', async ({
  browser,
}) => {
  const api = await apiRequest.newContext({ baseURL: origin })
  const projects = await api.get('/api/projects', { headers: { accept: 'application/json' } })
  expect(projects.status()).toBe(409)
  expect(await projects.json()).toEqual({ error: expect.stringMatching(/^setup required/), code: 'setup' })
  await api.dispose()

  host = await withPasskeys(browser)
  await host.page.goto('/')
  await expect(host.page).toHaveURL(`${origin}/setup`)
  await expect(host.page.getByRole('heading', { name: 'Set up CrossBoard' })).toBeVisible()
})

test('setup creates the account and its passkey, signs the browser in, and is refused after', async () => {
  const { page } = host
  await page.getByLabel('Your name on the board').fill('Enrique')
  await page.getByLabel('This device').fill('E2E desktop')
  await page.getByRole('button', { name: 'Create passkey' }).click()
  await expect(page).toHaveURL(`${origin}/`)
  await expect(page.getByRole('link', { name: 'Settings' }).first()).toBeAttached()
  expect(await me(page)).toEqual({
    status: 200,
    body: expect.objectContaining({ actor: 'Enrique', agent: false, authOff: false }),
  })
  const cookie = (await host.context.cookies()).find((c) => c.name === `board_session_${port}`)!
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', secure: false })
  expect(cookie.expires * 1000 - Date.now()).toBeGreaterThan(89 * 86_400_000)

  // Setup again, from a browser without a session: the page moves on to the login, the call is refused.
  const api = await apiRequest.newContext({ baseURL: origin })
  const again = await api.post('/api/auth/setup/options', { data: { name: 'Mallory' } })
  expect(again.status()).toBe(409)
  const page2 = await api.get('/setup', { maxRedirects: 0 })
  expect(page2.status()).toBe(302)
  expect(page2.headers().location).toBe('/login')
  await api.dispose()
})

test('without a session a page goes to /login with the page to come back to, an API call gets 401', async () => {
  const api = await apiRequest.newContext({ baseURL: origin })
  const page = await api.get('/projects/1?x=1', { headers: { accept: 'text/html' }, maxRedirects: 0 })
  expect(page.status()).toBe(302)
  expect(page.headers().location).toBe('/login?next=%2Fprojects%2F1%3Fx%3D1')
  const call = await api.get('/api/projects', { headers: { accept: 'application/json' } })
  expect(call.status()).toBe(401)
  await api.dispose()
})

test('signing out on Settings ends the session; the passkey signs back in on /login', async () => {
  const { page } = host
  await page.goto('/settings')
  const devices = page.getByRole('region', { name: 'Devices' })
  await expect(devices.getByRole('list', { name: 'Passkeys' })).toContainText('E2E desktop')
  await expect(devices.getByRole('list', { name: 'Sessions' })).toContainText('this browser')
  const before = (await host.context.cookies()).find((c) => c.name === `board_session_${port}`)!.value
  // Browsers keep one cookie jar for every port of localhost: what a board on another port set stays.
  const neighbour = { name: `board_session_${port + 1}`, value: 'of-the-board-next-door', url: origin }
  await host.context.addCookies([neighbour])
  await devices.getByRole('button', { name: 'Sign out', exact: true }).first().click()
  await expect(page).toHaveURL(`${origin}/login`)
  expect((await me(page)).status).toBe(401)
  const jar = await host.context.cookies()
  expect(jar.find((c) => c.name === `board_session_${port}`)).toBeUndefined()
  expect(jar.find((c) => c.name === neighbour.name)?.value).toBe(neighbour.value)
  // The old cookie is dead on the server, not just dropped by the browser.
  const api = await apiRequest.newContext({ baseURL: origin })
  const replay = await api.get('/api/me', {
    headers: { accept: 'application/json', cookie: `board_session_${port}=${before}` },
  })
  expect(replay.status()).toBe(401)
  await api.dispose()

  await page.goto('/login?next=%2Fsettings')
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click()
  await expect(page).toHaveURL(`${origin}/settings`)
  expect(await me(page)).toMatchObject({ status: 200, body: { actor: 'Enrique', agent: false } })
})

test('another device enrols with a one-time link; revoking its passkey signs it out', async ({ browser }) => {
  const { page } = host
  await page.goto('/settings')
  const devices = page.getByRole('region', { name: 'Devices' })
  await devices.getByRole('button', { name: 'Add a device' }).click()
  const url = await devices.locator('code').filter({ hasText: '/enroll?code=' }).first().innerText()
  expect(url.startsWith(`${origin}/enroll?code=`)).toBe(true)

  const other = await withPasskeys(browser)
  await other.page.goto(url)
  await other.page.getByLabel('This device').fill('Second browser')
  await other.page.getByRole('button', { name: 'Create passkey' }).click()
  await expect(other.page).toHaveURL(`${origin}/`)
  expect(await me(other.page)).toMatchObject({ status: 200, body: { actor: 'Enrique' } })

  // The link was used up.
  const used = await withPasskeys(browser)
  await used.page.goto(url)
  await used.page.getByLabel('This device').fill('Third browser')
  await used.page.getByRole('button', { name: 'Create passkey' }).click()
  await expect(used.page.getByRole('alert')).toHaveText(/used or expired/)
  await used.context.close()

  await page.reload()
  const keys = devices.getByRole('list', { name: 'Passkeys' })
  await expect(keys).toContainText('Second browser')
  await keys.getByRole('button', { name: 'Revoke Second browser' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke' }).click()
  await expect(keys).not.toContainText('Second browser')
  expect((await me(other.page)).status).toBe(401)
  await other.page.goto('/')
  await expect(other.page).toHaveURL(`${origin}/login?next=%2F`)
  // The host's own passkey is the last of this machine: it cannot be revoked.
  await expect(keys.getByRole('button', { name: 'Revoke E2E desktop' })).toHaveCount(0)
  await expect(keys).toContainText('last on this machine')
  await other.context.close()
  await host.context.close()
})
