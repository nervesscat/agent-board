import type { Page } from '@playwright/test'

import type { DesktopUpdates, UpdatesState } from '#/lib/updates'
import { expect, ok, test } from './fixtures'

// The Updates section of Settings and the top bar's badge. The e2e board runs from a checkout, so its
// own answers are a checkout's; the desktop app's are answered to the page by the tests below (its
// main process holds the updater: desktop/updates.test.mjs).

test('a checkout board says how it updates, and the update routes are the human’s alone', async ({
  page,
  human,
  agent,
}) => {
  expect(await ok<UpdatesState>(human.get('/api/updates'))).toEqual({ mode: 'checkout' })
  for (const [method, route] of [
    ['get', '/api/updates'],
    ['post', '/api/updates/check'],
    ['post', '/api/updates/install'],
    ['patch', '/api/updates/settings'],
  ] as const) {
    const res = await agent[method](route, method === 'patch' ? { data: { autoCheck: false } } : {})
    expect(res.status(), route).toBe(403)
    expect((await res.json()).error, route).toMatch(/^only the human /)
  }
  const install = await human.post('/api/updates/install')
  expect(install.status()).toBe(409)

  await page.goto('/settings')
  const section = page.locator('section#updates')
  await expect(section.getByRole('heading', { name: 'Updates' })).toBeVisible()
  await expect(section).toContainText('runs from a checkout, which has no updater')
  await expect(section.locator('code', { hasText: 'git pull' })).toBeVisible()
  await expect(section.locator('code', { hasText: 'pnpm start' })).toBeVisible()
  await expect(section.getByRole('button')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Update available' })).toHaveCount(0)
})

const desktop = (over: Partial<DesktopUpdates> = {}): DesktopUpdates => ({
  mode: 'desktop',
  installed: '0.2.0',
  packageType: 'pacman',
  status: 'none',
  newest: null,
  progress: null,
  error: null,
  manual: null,
  checkedAt: new Date().toISOString(),
  settings: { autoCheck: true, prereleases: false },
  ...over,
})
const offer = {
  version: '0.3.0',
  notes: "What's new\n\n- Updates from the app",
  notesMarkdown: "## What's new\n\n- Updates from the app",
  date: null,
}

/** Answers the page's update routes as the desktop app would: GET with `current`, each action with its own. */
async function answer(
  page: Page,
  current: () => DesktopUpdates,
  actions: Partial<Record<'check' | 'install' | 'settings', (body: unknown) => DesktopUpdates>> = {},
) {
  const asked: string[] = []
  await page.route(/\/api\/updates(\/\w+)?$/, async (route) => {
    const op = new URL(route.request().url()).pathname.split('/')[3] as 'check' | 'install' | 'settings'
    if (!op) return route.fulfill({ json: current() })
    asked.push(op)
    const act = actions[op]
    return act ? route.fulfill({ json: act(route.request().postDataJSON()) }) : route.fulfill({ status: 500 })
  })
  return asked
}

test('with nothing newer: no badge, no Download and install; Check now asks the app', async ({ page }) => {
  let state = desktop({ checkedAt: null, status: 'idle' })
  const asked = await answer(page, () => state, {
    check: () => (state = desktop({ status: 'none' })),
  })
  await page.goto('/settings')
  const section = page.locator('section#updates')
  await expect(section.getByTestId('updates-installed')).toHaveText('CrossBoard 0.2.0')
  await expect(section.getByTestId('updates-newest')).toHaveText('Not checked yet')
  await section.getByRole('button', { name: 'Check now' }).click()
  await expect(section.getByTestId('updates-newest')).toHaveText(/^None newer/)
  expect(asked).toEqual(['check'])
  await expect(section.getByRole('button', { name: 'Download and install' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Update available' })).toHaveCount(0)
})

test('a newer release: the badge, its notes and Download and install, which shows the download', async ({
  page,
}) => {
  let state = desktop({ status: 'available', newest: offer })
  const asked = await answer(page, () => state, {
    install: () =>
      (state = desktop({
        status: 'downloading',
        newest: offer,
        progress: { percent: 40, transferred: 40, total: 100 },
      })),
  })
  await page.goto('/')
  const badge = page.getByRole('link', { name: 'Update available' })
  await expect(badge).toBeVisible()
  await badge.click()
  await expect(page).toHaveURL(/\/settings#updates$/)
  const section = page.locator('section#updates')
  await expect(section.getByTestId('updates-newest')).toHaveText('CrossBoard 0.3.0')
  await expect(section.getByTestId('updates-notes')).toHaveText("What's new\n\n- Updates from the app")
  // Nothing has been asked of the app but its state until the button.
  expect(asked).toEqual([])
  await section.getByRole('button', { name: 'Download and install' }).click()
  await expect(section).toContainText('Downloading 0.3.0… 40%')
  await expect(section.getByRole('button', { name: 'Download and install' })).toHaveCount(0)
  await expect(section.getByRole('button', { name: 'Check now' })).toBeDisabled()
  expect(asked).toEqual(['install'])
})

test('polkit declined: the exact command with the downloaded file, and the button again', async ({
  page,
}) => {
  const file = '/home/me/.cache/agent-board-updater/pending/agent-board-0.3.0.pacman'
  await answer(page, () =>
    desktop({
      status: 'manual',
      newest: offer,
      error: 'polkit did not authorize the install (pkexec exit 126).',
      manual: { command: `sudo pacman -U ${file}`, file },
    }),
  )
  await page.goto('/settings')
  const section = page.locator('section#updates')
  await expect(section.getByRole('alert')).toHaveText(
    'polkit did not authorize the install (pkexec exit 126).',
  )
  await expect(section.getByTestId('updates-command')).toHaveText(`sudo pacman -U ${file}`)
  await expect(section.getByRole('button', { name: 'Download and install' })).toBeVisible()
  // Never a password: the section has no field to type one in.
  await expect(section.locator('input[type="password"], input[type="text"]')).toHaveCount(0)
})

test('the automatic check and pre-releases are switches the app saves', async ({ page }) => {
  let state = desktop()
  const bodies: unknown[] = []
  await answer(page, () => state, {
    settings: (body) => {
      bodies.push(body)
      return (state = desktop({ settings: { ...state.settings, ...(body as object) } }))
    },
  })
  await page.goto('/settings')
  const auto = page.getByRole('switch', { name: 'Check for updates at start and every six hours' })
  const pre = page.getByRole('switch', { name: /Include pre-releases/ })
  await expect(auto).toBeChecked()
  await expect(pre).not.toBeChecked()
  await auto.click()
  await expect(auto).not.toBeChecked()
  await pre.click()
  await expect(pre).toBeChecked()
  expect(bodies).toEqual([{ autoCheck: false }, { prereleases: true }])
  // Read again from the app (as after a reload), they stay as saved.
  await page.reload()
  await expect(auto).not.toBeChecked()
  await expect(pre).toBeChecked()
})

test('a copy that cannot update itself says so and offers no buttons', async ({ page }) => {
  await answer(page, () => desktop({ status: 'unsupported', packageType: null, checkedAt: null }))
  await page.goto('/settings')
  const section = page.locator('section#updates')
  await expect(section).toContainText('This copy of the app cannot update itself')
  await expect(section.getByRole('button')).toHaveCount(0)
})
