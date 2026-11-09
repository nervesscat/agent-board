import fs from 'node:fs'
import path from 'node:path'

import { e2eEnv } from './env'
import { expect, test } from './fixtures'

// The Settings section for the tailnet entrance (README: "Using it from other devices"), on the built board
// in test mode, where sign-in is off: the section shows this machine's Tailscale in each state, and saving is
// refused with the reason. Tailscale is the fake CLI (e2e/fake-tailscale.mjs), linked in as the board's
// TAILSCALE_BIN, answering from a state file the test writes. A second board has PUBLIC_ORIGIN in its
// environment, which Settings shows read-only. Screenshots go to the test's output folder.

const env = e2eEnv()
const NAME = 'devbox.example-tailnet.ts.net'
const SIZES = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'phone', width: 390, height: 844 },
]
const SERVE_COMMAND = `tailscale serve --bg --https=443 http://127.0.0.1:${env.port}`

/** Tailscale on this machine, running with MagicDNS and HTTPS, and the board served on 443. */
const running = (over: Record<string, unknown> = {}) => ({
  version: '1.80.2\n  commit\n',
  'status --json': {
    BackendState: 'Running',
    Self: { DNSName: `${NAME}.`, HostName: 'devbox' },
    CertDomains: [NAME],
  },
  'serve status --json': {
    Web: { [`${NAME}:443`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${env.port}` } } } },
  },
  'funnel status --json': {},
  ...over,
})

/** Makes the board's Tailscale this state: the fake CLI's answers, or no CLI at all (not installed). */
function tailscale(state: Record<string, unknown> | 'not installed') {
  fs.rmSync(env.tailscaleBin, { force: true })
  if (state === 'not installed') return
  fs.symlinkSync(path.resolve('e2e/fake-tailscale.mjs'), env.tailscaleBin)
  fs.writeFileSync(env.tailscaleState, JSON.stringify(state))
}

const section = (page: import('@playwright/test').Page) =>
  page.locator('section[aria-labelledby="tailnet-title"]')

/** Opens Settings at the viewport, shows the section, and checks it does not scroll sideways. */
async function open(page: import('@playwright/test').Page, width: number, url = '/settings') {
  const size = SIZES.find((s) => s.width === width)!
  await page.setViewportSize({ width: size.width, height: size.height })
  await page.goto(url)
  await expect(page.getByRole('heading', { name: 'Other devices (tailnet)' })).toBeVisible()
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow, `sideways scroll at ${width}px`).toBeLessThanOrEqual(0)
}

/** The section's screenshot, at both sizes, for the state it shows now. */
async function shoot(
  page: import('@playwright/test').Page,
  testInfo: import('@playwright/test').TestInfo,
  state: string,
  url?: string,
) {
  for (const size of SIZES) {
    await open(page, size.width, url)
    await section(page).screenshot({ path: testInfo.outputPath(`${state}-${size.name}.png`) })
  }
}

test.describe.configure({ mode: 'serial' })
test.afterAll(() => tailscale(running()))

test('a Tailscale that is not installed says so, and offers no command', async ({ page }, testInfo) => {
  tailscale('not installed')
  await open(page, 1280)
  await expect(page.getByText('Tailscale is not installed on this machine')).toBeVisible()
  await expect(page.getByText('not installed', { exact: true })).toBeVisible()
  await expect(page.getByText(/^tailscale serve --bg/)).toHaveCount(0)
  await shoot(page, testInfo, 'not-installed')
})

test('signed out: Tailscale needs a login, and the section says what to run', async ({ page }, testInfo) => {
  tailscale(running({ 'status --json': { BackendState: 'NeedsLogin' }, 'serve status --json': {} }))
  await open(page, 1280)
  await expect(page.getByText('Tailscale is NeedsLogin on this machine', { exact: false })).toBeVisible()
  await expect(page.getByText('no (NeedsLogin)')).toBeVisible()
  await shoot(page, testInfo, 'signed-out')
})

test('ready: the name is offered, the sign-in-off board says it cannot save, and Test says why', async ({
  page,
  request,
}, testInfo) => {
  tailscale(running())
  await open(page, 1280)
  await expect(page.getByText(`Ready: this machine is ${NAME} on your tailnet`)).toBeVisible()
  await expect(section(page).getByRole('button', { name: `Use https://${NAME}` })).toBeVisible()
  await expect(page.getByText('Sign-in is off on this board (BOARD_ENV=test)')).toBeVisible()
  // The name, typed in, is refused: sign-in is off here, whatever the origin.
  await section(page)
    .getByRole('button', { name: `Use https://${NAME}` })
    .click()
  await expect(page.locator('#tailnet-origin')).toHaveValue(`https://${NAME}`)
  await section(page).getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText(/sign-in is off \(BOARD_ENV=test\)/)).toBeVisible()
  // Test asks the board over its name: with sign-in off there is nothing to check.
  await section(page).getByRole('button', { name: 'Test the entrance' }).click()
  await expect(page.getByText(/^Not yet\. sign-in is off/)).toBeVisible()
  // The API says the same, and nothing is saved.
  const res = await request.patch('/api/tailnet', { data: { origin: `https://${NAME}` } })
  expect(res.status()).toBe(409)
  expect(await res.json()).toMatchObject({
    error: expect.stringMatching(/^sign-in is off/),
    code: 'auth-off',
  })
  expect(await (await request.get('/api/tailnet')).json()).toMatchObject({ saved: null, signInOff: true })
  await shoot(page, testInfo, 'ready')
})

test('serve missing: the command is shown, copies, and the status is checked again', async ({
  page,
  context,
}, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: env.baseURL })
  tailscale(running({ 'serve status --json': {} }))
  await open(page, 1280)
  await expect(page.getByText('Serve is not set up yet')).toBeVisible()
  await expect(page.locator('code', { hasText: SERVE_COMMAND })).toBeVisible()
  await shoot(page, testInfo, 'serve-missing')
  await section(page).getByRole('button', { name: 'Copy the serve command' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(SERVE_COMMAND)
  // The human runs it; the board only reads again.
  tailscale(running())
  await section(page).getByRole('button', { name: 'Check again' }).click()
  await expect(page.getByText('Serve is not set up yet')).toHaveCount(0)
  await expect(page.getByText(`Ready: this machine is ${NAME} on your tailnet`)).toBeVisible()
})

test('serve sends 443 somewhere else: the section names it, and the command replaces it', async ({
  page,
}) => {
  tailscale(
    running({
      'serve status --json': {
        Web: { [`${NAME}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8080' } } } },
      },
    }),
  )
  await open(page, 390)
  await expect(page.getByText('Port 443 of this machine serves http://127.0.0.1:8080 now')).toBeVisible()
  await expect(page.locator('code', { hasText: SERVE_COMMAND })).toBeVisible()
  tailscale(running())
})

test('Funnel on: the section warns, and the board refuses to save', async ({ page, request }, testInfo) => {
  tailscale(running({ 'funnel status --json': { AllowFunnel: { [`${NAME}:443`]: true } } }))
  await open(page, 1280)
  await expect(section(page).getByRole('alert')).toContainText('Tailscale Funnel is on')
  const res = await request.patch('/api/tailnet', { data: { origin: `https://${NAME}` } })
  expect(res.status()).toBe(409)
  await shoot(page, testInfo, 'funnel-on')
  tailscale(running())
})

test('set by env: PUBLIC_ORIGIN wins and the field is read-only', async ({ page, request }, testInfo) => {
  // The environment's board is the one this machine serves on 443.
  tailscale(
    running({
      'serve status --json': {
        Web: { [`${NAME}:443`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${env.envPort}` } } } },
      },
    }),
  )
  await open(page, 1280, `${env.envBaseURL}/settings`)
  await expect(
    page.getByText(/Set in config\.env \(or \.env\): PUBLIC_ORIGIN=https:\/\/envbox/),
  ).toBeVisible()
  await expect(page.locator('#tailnet-origin')).toBeDisabled()
  const res = await request.patch(`${env.envBaseURL}/api/tailnet`, {
    data: { origin: `https://${NAME}` },
  })
  expect(res.status()).toBe(409)
  await shoot(page, testInfo, 'set-by-env', `${env.envBaseURL}/settings`)
})

test('an agent is refused every route of the entrance, orchestrators and test-mode agents alike', async ({
  request,
}) => {
  for (const actor of ['agent:claude', 'orchestrator:claude']) {
    const headers = { 'X-Test-Actor': actor }
    const read = await request.get('/api/tailnet', { headers })
    expect(read.status(), `GET as ${actor}`).toBe(403)
    expect(await read.json()).toEqual({ error: 'only the human sees the tailnet entrance' })
    const save = await request.patch('/api/tailnet', { headers, data: { origin: `https://${NAME}` } })
    expect(save.status(), `PATCH as ${actor}`).toBe(403)
    const check = await request.post('/api/tailnet/test', { headers })
    expect(check.status(), `POST test as ${actor}`).toBe(403)
  }
  // Agents read the board's settings, and the entrance is not among them.
  const settings = await (await request.get('/api/settings')).json()
  expect(Object.keys(settings)).not.toContain('tailnetEntrance')
  expect(JSON.stringify(settings)).not.toContain(NAME)
})

test('a write from another origin with the session cookie is refused on the entrance too', async ({
  request,
}) => {
  const res = await request.patch('/api/tailnet', {
    headers: { Cookie: `board_session_${env.port}=stolen`, Origin: 'https://evil.example' },
    data: { origin: `https://${NAME}` },
  })
  expect(res.status()).toBe(403)
})
