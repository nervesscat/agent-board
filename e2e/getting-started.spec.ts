import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

import { type APIRequestContext, type Page, request as apiRequest } from '@playwright/test'

import type { HostTool, HostTools } from '#/lib/api'
import { HUMAN, e2eEnv } from './env'
import { expect, ok, test } from './fixtures'

/**
 * Getting started on a fresh board: the run's build in test mode on throwaway data of its own (the
 * shared e2e board always has projects), on a free loopback port. The tools' check is answered by the
 * page's routes, since the board's tools are whatever this machine has.
 */

test.describe.configure({ mode: 'serial' })

let board: ChildProcess
let origin = ''
let human: APIRequestContext
const SHOTS = process.env.E2E_SHOTS

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo
      probe.close(() => resolve(port))
    })
  })
}

test.beforeAll(async () => {
  const { root, repoPath } = e2eEnv()
  const port = await freePort()
  origin = `http://127.0.0.1:${port}`
  const dataDir = fs.mkdtempSync(path.join(root, 'getting-started-'))
  board = spawn(process.execPath, ['.output-e2e/server/index.mjs'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      BOARD_BUILD_DIR: '.output-e2e',
      BOARD_ENV: 'test',
      TEST_HUMAN: HUMAN,
      HOST: '127.0.0.1',
      PORT: String(port),
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: String(port),
      BOARD_URL: origin,
      DATA_DIR: dataDir,
      CLAUDE_HOME: path.join(dataDir, 'home', '.claude'),
      STORAGE: 'local',
      PUBLIC_ORIGIN: '',
    },
  })
  board.stderr!.on('data', (d: Buffer) => process.stderr.write(d))
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${origin}/api/health`)).ok) break
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  human = await apiRequest.newContext({
    baseURL: origin,
    extraHTTPHeaders: { 'X-Test-Actor': `human:${HUMAN}` },
  })
  expect(fs.existsSync(repoPath)).toBe(true)
})

test.afterAll(async () => {
  await human?.dispose()
  board?.kill()
})

const tool = (name: HostTool['name'], ok = true): HostTool => ({
  name,
  found: true,
  path: `/usr/bin/${name}`,
  version: '1.0.0',
  ...(name === 'gh' && { signedIn: ok }),
  ok,
  optional: name === 'claude',
  breaks: 'things',
  problem: ok ? null : 'gh is not signed in',
  fix: ok ? null : 'run gh auth login on this machine, then Check again',
})
let checks = 0
const check = (ghOk: boolean): HostTools => ({
  checkedAt: new Date(Date.UTC(2026, 10, 6, 12, 0, ++checks)).toISOString(),
  tools: (['git', 'gh', 'claude', 'node', 'pnpm'] as const).map((n) => tool(n, n !== 'gh' || ghOk)),
})

/** The page's tools check: gh signed out until `fixed` is set, then every tool found. */
async function tools(page: Page) {
  const state = { fixed: false }
  await page.route('**/api/host-tools', (r) => r.fulfill({ json: check(state.fixed) }))
  await page.route('**/api/host-tools/check', (r) => r.fulfill({ json: check(state.fixed) }))
  return state
}

const checklist = (page: Page) => page.getByRole('list', { name: 'Getting started steps' })
const entry = (page: Page) => page.getByRole('button', { name: /^Getting started, \d of 4 done$/ })
const stepState = (page: Page, title: string, state: 'Done' | 'Not done') =>
  expect(checklist(page).getByRole('listitem', { name: `${title}: ${state}` })).toBeVisible()

/**
 * Reloads and waits until every fact behind the entry has answered (and a moment after), so a missing
 * entry means it is hidden, not that it is still loading.
 */
async function reloadSettled(page: Page) {
  const answered = ['/api/me', '/api/host-tools', '/api/projects', '/api/agent-tokens'].map((p) =>
    page.waitForResponse((r) => new URL(r.url()).pathname === p),
  )
  await page.reload()
  await Promise.all(answered)
  await page.waitForTimeout(500)
}

async function shot(page: Page, name: string) {
  if (SHOTS)
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true, animations: 'disabled' })
}

test('a failed check shows its step not done instead of loading for good', async ({ page }) => {
  await page.route('**/api/host-tools', (r) =>
    r.fulfill({ status: 500, json: { error: 'board restarting' } }),
  )
  await page.goto(`${origin}/`)
  await expect(page.getByText('Getting started · 0 of 4')).toBeVisible()
  await stepState(page, 'Tools on this machine', 'Not done')
  await expect(checklist(page)).toContainText('Could not check this step')
  await stepState(page, 'Connect an agent', 'Not done')
  // The top-bar entry shows too: a failure is an answer.
  await expect(entry(page)).toHaveAccessibleName('Getting started, 0 of 4 done')
  await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
})

test('dismissing the top-bar entry keeps it gone', async ({ page }) => {
  await tools(page)
  await page.goto(`${origin}/`)
  await entry(page).click()
  await page.getByRole('button', { name: 'Dismiss Getting started' }).click()
  await expect(entry(page)).toHaveCount(0)
  await reloadSettled(page)
  await expect(page.getByText('Getting started · 0 of 4')).toBeVisible()
  await expect(entry(page)).toHaveCount(0)
  // Another user of this browser still gets it: the dismissal is per user.
  await page.setExtraHTTPHeaders({ 'X-Test-Actor': 'human:someone-else' })
  await reloadSettled(page)
  await expect(entry(page)).toHaveAccessibleName('Getting started, 0 of 4 done')
})

test('a failed /api/me leaves no step loading', async ({ page }) => {
  await tools(page)
  await page.route('**/api/me', (r) => r.fulfill({ status: 500, json: { error: 'board restarting' } }))
  await page.goto(`${origin}/`)
  await expect(page.getByText('Getting started · 0 of 4')).toBeVisible()
  await stepState(page, 'Connect an agent', 'Not done')
  await expect(checklist(page)).not.toContainText('Checking…')
})

test('a fresh board walks the steps to 4 of 4, and the entry stays gone after', async ({ page }) => {
  const { repoPath } = e2eEnv()
  const state = await tools(page)
  await page.goto(`${origin}/`)
  await expect(page.getByText('Getting started · 0 of 4')).toBeVisible()
  await expect(checklist(page)).toContainText('gh is not signed in')
  await shot(page, '1-home-0of4-desktop')
  await page.setViewportSize({ width: 390, height: 844 })
  await shot(page, '1-home-0of4-phone')
  await page.setViewportSize({ width: 1280, height: 720 })

  // 1. The tools: fixed on the machine, then Check again.
  state.fixed = true
  await page.getByRole('button', { name: 'Check again' }).click()
  await stepState(page, 'Tools on this machine', 'Done')
  await expect(page.getByText('Getting started · 1 of 4')).toBeVisible()

  // 2. The first project, made from the checklist, lands on its Repositories page.
  await page.getByRole('button', { name: 'New project' }).click()
  await page.getByPlaceholder('Name').fill('First')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page).toHaveURL(/\/projects\/\d+\/repositories$/)
  const projectId = Number(/projects\/(\d+)/.exec(page.url())![1])
  await expect(entry(page)).toHaveAccessibleName('Getting started, 1 of 4 done')
  await ok(human.post('/api/repos', { data: { projectId, repoPath, name: 'repo' } }))
  await page.reload()
  await expect(entry(page)).toHaveAccessibleName('Getting started, 2 of 4 done')
  await entry(page).click()
  await stepState(page, 'Create a project and add its first repository', 'Done')
  await shot(page, '2-midway-desktop')

  // 3. Connect an agent: Generate commands makes its token.
  await checklist(page).getByRole('link', { name: 'Connect an agent' }).click()
  await expect(page).toHaveURL(/\/agents$/)
  await page.getByRole('button', { name: 'Generate commands' }).click()
  await expect(entry(page)).toHaveAccessibleName('Getting started, 3 of 4 done')

  // On a phone the entry is an item of the Pages menu, leading to Home's card; the page keeps its width.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(entry(page)).toBeHidden()
  await page.getByRole('button', { name: 'Pages' }).click()
  await page.getByRole('link', { name: 'Getting started · 3/4' }).click()
  await expect(page).toHaveURL(/\/#getting-started$/)
  await expect(page.getByText('Getting started · 3 of 4')).toBeVisible()
  await stepState(page, 'Connect an agent', 'Done')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await shot(page, '2-midway-phone')
  await page.setViewportSize({ width: 1280, height: 720 })
  // Home's card is for phones: on a wide screen the entry stands for it.
  await expect(page.getByText('Getting started · 3 of 4')).toBeHidden()

  // 4. A first ticket, from the project's Features page.
  await entry(page).click()
  await checklist(page).getByRole('link', { name: 'Write a ticket' }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/features`))
  await page.getByRole('button', { name: 'New ticket' }).click()
  await page.getByRole('dialog').getByLabel('Title').fill('Say hello')
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(entry(page)).toHaveCount(0)
  await shot(page, '3-done-4of4-desktop')
  await page.setViewportSize({ width: 390, height: 844 })
  await shot(page, '3-done-4of4-phone')
  await page.setViewportSize({ width: 1280, height: 720 })

  // Done once is done: a fact that stops holding (the token revoked) does not bring the entry back.
  const tokens = await ok<{ id: number }[]>(human.get('/api/agent-tokens'))
  for (const t of tokens) expect((await human.delete(`/api/agent-tokens/${t.id}`)).ok()).toBe(true)
  await reloadSettled(page)
  await expect(page.getByRole('heading', { level: 1, name: 'Ongoing features' })).toBeVisible()
  await expect(entry(page)).toHaveCount(0)
  // The same facts in a browser that never saw 4 of 4: the entry shows, at 3 of 4.
  const fresh = await page.context().browser()!.newPage()
  ;(await tools(fresh)).fixed = true
  await fresh.goto(`${origin}/projects/${projectId}/features`)
  await expect(entry(fresh)).toHaveAccessibleName('Getting started, 3 of 4 done')
  await fresh.close()
})
