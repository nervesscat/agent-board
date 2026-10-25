import type { Page } from '@playwright/test'

import type { HostTool, HostTools } from '#/lib/api'
import { expect, ok, test } from './fixtures'

// The check of the tools the board runs (git, gh, claude, node, pnpm). The REST tests read the e2e
// board's own check (its claude is the stand-in CLAUDE_BIN, node); the warning's tests answer the page
// with a check of their own, since the board's tools are whatever this machine has.

test('agents and the human read the check; health stays { ok: true }', async ({ agent, human, request }) => {
  const first = await ok<HostTools>(agent.get('/api/host-tools'))
  expect(first.tools.map((t) => t.name)).toEqual(['git', 'gh', 'claude', 'node', 'pnpm'])
  expect(first.tools.find((t) => t.name === 'claude')).toMatchObject({ found: true, ok: true })
  expect(first.tools.find((t) => t.name === 'git')).toMatchObject({ found: true })
  const again = await ok<HostTools>(human.post('/api/host-tools/check'))
  expect(again.checkedAt > first.checkedAt).toBe(true)
  expect((await ok<HostTools>(human.get('/api/host-tools'))).checkedAt).toBe(again.checkedAt)
  expect(await ok(request.get('/api/health'))).toEqual({ ok: true })
})

const MISSING_BIN = 'C:\\nope\\a-folder-name-long-enough-to-wrap-at-phone-width\\claude.exe'

function tool(name: HostTool['name'], over: Partial<HostTool> = {}): HostTool {
  return {
    name,
    found: true,
    path: `/usr/bin/${name}`,
    version: '1.0.0',
    ...(name === 'gh' && { signedIn: true }),
    ok: true,
    breaks: name === 'claude' ? 'generated reports and agents' : 'the PR queue, CI status and PR tickets',
    problem: null,
    fix: null,
    ...over,
  }
}
const claudeMissing = tool('claude', {
  found: false,
  path: null,
  version: null,
  ok: false,
  problem: `claude was not found: CLAUDE_BIN is ${MISSING_BIN}`,
  fix: 'install Claude Code (https://docs.claude.com/en/docs/claude-code/setup), or set CLAUDE_BIN in .env (config.env for the desktop app) to its full path, then restart the board',
})
const ghSignedOut = tool('gh', {
  signedIn: false,
  ok: false,
  problem: 'gh is not signed in',
  fix: 'run gh auth login on this machine, then Check again',
})
let checks = 0
const check = (...tools: HostTool[]): HostTools => {
  const byName = new Map(tools.map((t) => [t.name, t]))
  return {
    checkedAt: new Date(Date.UTC(2026, 9, 20, 12, 0, ++checks)).toISOString(),
    tools: (['git', 'gh', 'claude', 'node', 'pnpm'] as const).map((n) => byName.get(n) ?? tool(n)),
  }
}

/** The page reads `current` for GET; Check again moves it to the next of `then` and answers that. */
async function answer(page: Page, first: HostTools, ...then: HostTools[]) {
  let current = first
  await page.route('**/api/host-tools', (route) => route.fulfill({ json: current }))
  await page.route('**/api/host-tools/check', (route) => {
    current = then.shift() ?? current
    return route.fulfill({ json: current })
  })
}

const warning = (page: Page) => page.getByRole('region', { name: 'Missing tools' })

test('names each missing tool, what it breaks and the fix; dismissed alone, back while still missing, gone once found', async ({
  page,
}) => {
  await answer(page, check(claudeMissing, ghSignedOut), check(claudeMissing, ghSignedOut), check())
  await page.goto('/')
  const banner = warning(page)
  const claude = banner.getByRole('listitem').filter({ hasText: 'claude was not found' })
  const gh = banner.getByRole('listitem').filter({ hasText: 'gh is not signed in' })
  await expect(claude).toContainText(`CLAUDE_BIN is ${MISSING_BIN}`)
  await expect(claude).toContainText('generated reports and agents will not work')
  await expect(claude).toContainText('Fix: install Claude Code')
  await expect(gh).toContainText(
    'the PR queue, CI status and PR tickets will not work. Fix: run gh auth login',
  )

  // Dismissed on its own: the other stays, and a reload or another page keeps it hidden.
  await claude.getByRole('button', { name: 'Dismiss the claude warning' }).click()
  await expect(claude).toHaveCount(0)
  await expect(gh).toBeVisible()
  await page.goto('/daily')
  await expect(gh).toBeVisible()
  await expect(claude).toHaveCount(0)

  // A new check that still finds it missing shows it again.
  await banner.getByRole('button', { name: 'Check the tools again' }).click()
  await expect(claude).toBeVisible()
  // Every tool found: no warning.
  await banner.getByRole('button', { name: 'Check the tools again' }).click()
  await expect(banner).toHaveCount(0)
})

test('no warning while every tool is found', async ({ page }) => {
  await answer(page, check())
  const read = page.waitForResponse('**/api/host-tools')
  await page.goto('/')
  await read
  await expect(warning(page)).toHaveCount(0)
})

test('works without browser storage: dismissing holds for the page', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new Error('storage is off')
      },
    })
  })
  await answer(page, check(claudeMissing))
  await page.goto('/')
  const banner = warning(page)
  await expect(banner).toContainText('claude was not found')
  await banner.getByRole('button', { name: 'Dismiss the claude warning' }).click()
  await expect(banner).toHaveCount(0)
})

test.describe('at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('the warning fits 390px without sideways scroll', async ({ page }) => {
    await answer(page, check(claudeMissing, ghSignedOut))
    await page.goto('/')
    await expect(warning(page)).toContainText('gh is not signed in')
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
    ).toBe(false)
    const box = (await warning(page).boundingBox())!
    expect(box.x + box.width).toBeLessThanOrEqual(390)
  })
})
