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
  // The release card is open over the board: dismiss it before using the section under it.
  await expect(page.getByTestId('update-card')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('update-card')).toHaveCount(0)
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

// The update card: the release's artwork and notes over the board at start, once per release this
// browser has not seen. It only exists under the app, so every desktop state here is faked.

/** The card on the page. */
const card = (page: Page) => page.getByTestId('update-card')

/** What this browser remembers, as the page stored it. */
const memory = (page: Page): Promise<unknown> =>
  page.evaluate(() => JSON.parse(localStorage.getItem('update-card') ?? 'null'))

/** A picture the artwork route can answer, one per theme. */
const SVG = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="${fill}"/></svg>`

/**
 * Answers the card's artwork requests by file name: a name in `files` gets that SVG, any other (a
 * release without that variant, or without artwork at all) a 404, as a build without the file would.
 */
async function artwork(page: Page, files: Record<string, string> = {}) {
  await page.route('**/release-art/**', (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop() ?? ''
    const body = files[name]
    return body
      ? route.fulfill({ contentType: 'image/svg+xml', body })
      : route.fulfill({ status: 404, body: '' })
  })
}

test('a desktop release shows the card at start, over a page that stays usable', async ({ page }) => {
  await answer(page, () => desktop({ status: 'available', newest: offer }))
  await artwork(page, { '0.3.0-dark.svg': SVG('#172033'), '0.3.0-light.svg': SVG('#f5f5f5') })
  await page.goto('/')
  const update = card(page)
  await expect(update).toBeVisible()
  await expect(update).toHaveAttribute('role', 'dialog')
  await expect(update).toHaveAttribute('aria-modal', 'false')
  await expect(update).toHaveAccessibleName(/0\.3\.0/)
  // Seen the moment it showed, and it stays open until it is dismissed (the write does not unmount it).
  await expect.poll(() => memory(page)).toEqual({ seenVersion: '0.3.0', skippedVersion: null })
  await page.waitForTimeout(1000)
  await expect(update).toBeVisible()
  // Showing it moves no focus, locks no scroll, and the page behind still takes a click.
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BODY')
  expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe('hidden')
  expect(await page.evaluate(() => getComputedStyle(document.body).position)).not.toBe('fixed')
  await page.getByRole('link', { name: 'Update available' }).click()
  await expect(page).toHaveURL(/\/settings#updates$/)
  await expect(update).toBeVisible()
  // No focus trap: Tab from the card's last control leaves it.
  await update.getByRole('button', { name: 'Install now' }).focus()
  await page.keyboard.press('Tab')
  expect(
    await page.evaluate(() =>
      document.querySelector('[data-testid="update-card"]')?.contains(document.activeElement),
    ),
  ).toBe(false)
})

test('the card is once per release: it writes the version seen and a reload is quiet', async ({ page }) => {
  await answer(page, () => desktop({ status: 'available', newest: offer }))
  await artwork(page)
  await page.goto('/')
  await expect(card(page)).toBeVisible()
  await expect.poll(() => memory(page)).toEqual({ seenVersion: '0.3.0', skippedVersion: null })
  await page.reload()
  await expect(card(page)).toHaveCount(0)
})

test('Skip is remembered, and a later release is shown again', async ({ page }) => {
  let state = desktop({ status: 'available', newest: offer })
  const asked = await answer(page, () => state)
  await artwork(page)
  await page.goto('/')
  await expect(card(page)).toBeVisible()
  await card(page).getByRole('button', { name: 'Skip this version' }).click()
  await expect(card(page)).toHaveCount(0)
  expect(asked).toEqual([])
  expect(await memory(page)).toEqual({ seenVersion: '0.3.0', skippedVersion: '0.3.0' })
  await page.reload()
  await expect(card(page)).toHaveCount(0)
  // A later release is offered again.
  state = desktop({ status: 'available', newest: { ...offer, version: '0.4.0' } })
  await page.reload()
  await expect(card(page)).toHaveAccessibleName(/0\.4\.0/)
})

test('Esc and Close dismiss the card and record it seen, not skipped', async ({ page }) => {
  await answer(page, () => desktop({ status: 'available', newest: offer }))
  await artwork(page)
  await page.goto('/')
  await expect(card(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(card(page)).toHaveCount(0)
  await expect.poll(() => memory(page)).toEqual({ seenVersion: '0.3.0', skippedVersion: null })
  await page.evaluate(() => localStorage.removeItem('update-card'))
  await page.reload()
  await expect(card(page)).toBeVisible()
  await card(page).getByRole('button', { name: 'Close' }).click()
  await expect(card(page)).toHaveCount(0)
  await expect.poll(() => memory(page)).toEqual({ seenVersion: '0.3.0', skippedVersion: null })
})

test('Settings lists the skipped release, and Undo offers it again', async ({ page }) => {
  await answer(page, () => desktop({ status: 'available', newest: offer }))
  await artwork(page)
  await page.goto('/')
  await card(page).getByRole('button', { name: 'Skip this version' }).click()
  await expect(card(page)).toHaveCount(0)
  await page.goto('/settings')
  const skipped = page.getByTestId('updates-skipped')
  await expect(skipped).toBeVisible()
  await expect(skipped).toContainText('0.3.0')
  await skipped.getByRole('button', { name: 'Undo' }).click()
  // The card may show that release again: the memory no longer records it.
  await expect(skipped).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('update-card'))).toBeNull()
  await page.goto('/')
  await expect(card(page)).toBeVisible()
})

test('no card for an agent, nor on a checkout board, nor when the updates route fails', async ({
  page,
  human,
}) => {
  // The server's HTML never carries the card (it renders in the browser, for the human only).
  expect(await (await human.get('/')).text()).not.toContain('data-testid="update-card"')

  // A checkout board has no updater to offer anything.
  await page.goto('/')
  await expect(card(page)).toHaveCount(0)

  // An agent is never asked about updates: the page renders no card, and the route stays untouched.
  const asked: string[] = []
  await page.route(/\/api\/updates(\/\w+)?$/, (route) => {
    asked.push(new URL(route.request().url()).pathname)
    return route.fulfill({ json: desktop({ status: 'available', newest: offer }) })
  })
  await page.setExtraHTTPHeaders({ 'X-Test-Actor': 'agent:claude' })
  await page.goto('/')
  await expect(card(page)).toHaveCount(0)
  expect(asked).toEqual([])
})

test('a board that cannot answer its updates route shows no card and takes no focus', async ({ page }) => {
  await page.route(/\/api\/updates(\/\w+)?$/, (route) =>
    route.fulfill({ status: 500, json: { error: 'no' } }),
  )
  await page.goto('/')
  await expect(card(page)).toHaveCount(0)
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BODY')
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible()
})

test('the artwork slot follows the theme, and the light file is the dark page’s fallback', async ({
  page,
}, testInfo) => {
  await answer(page, () => desktop({ status: 'available', newest: offer }))
  await artwork(page, { '0.3.0-dark.svg': SVG('#172033'), '0.3.0-light.svg': SVG('#f5f5f5') })
  await page.goto('/')
  await expect(card(page)).toBeVisible()
  const image = card(page).getByTestId('update-card-art')
  await expect(image).toHaveAttribute('alt', '')
  // A light page shows the light file, inside a 16:9 region with a colour of its own (no transparent gap).
  await expect(image).toHaveAttribute('src', '/release-art/0.3.0-light.svg')
  const box = (await image.boundingBox())!
  expect(box.width / box.height).toBeGreaterThan(1.6)
  expect(box.width / box.height).toBeLessThan(1.9)
  expect(await image.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
  await page.screenshot({ path: testInfo.outputPath('update-card-art-light.png'), animations: 'disabled' })
  // The page's theme (the `dark` class), not the system alone, picks the variant while the card is open.
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(image).toHaveAttribute('src', '/release-art/0.3.0-dark.svg')
  await page.screenshot({ path: testInfo.outputPath('update-card-art-dark.png'), animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(image).toHaveAttribute('src', '/release-art/0.3.0-light.svg')
  // The art sits above the text, never behind it.
  const artBox = (await image.boundingBox())!
  const headingBox = (await card(page)
    .getByRole('heading', { level: 2, name: /0\.3\.0/ })
    .boundingBox())!
  const notesBox = (await card(page).getByTestId('update-card-notes').boundingBox())!
  expect(artBox.y + artBox.height).toBeLessThanOrEqual(headingBox.y + 0.5)
  expect(artBox.y + artBox.height).toBeLessThanOrEqual(notesBox.y + 0.5)
})

test('a dark page without dark artwork shows the light file', async ({ page }) => {
  await answer(page, () => desktop({ status: 'available', newest: offer }))
  await artwork(page, { '0.3.0-light.svg': SVG('#f5f5f5') })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  await expect(card(page).getByTestId('update-card-art')).toHaveAttribute(
    'src',
    '/release-art/0.3.0-light.svg',
  )
  await expect(page.getByTestId('update-card-art-placeholder')).toHaveCount(0)
})

test('a release with no artwork shows a deliberate placeholder, never a broken image', async ({
  page,
}, testInfo) => {
  await answer(page, () => desktop({ status: 'available', newest: offer }))
  await artwork(page)
  await page.goto('/')
  const placeholder = card(page).getByTestId('update-card-art-placeholder')
  await expect(placeholder).toBeVisible()
  await expect(placeholder).toContainText('0.3.0')
  await expect(card(page).getByTestId('update-card-art')).toHaveCount(0)
  await expect(card(page).locator('img')).toHaveCount(0)
  await page.screenshot({
    path: testInfo.outputPath('update-card-placeholder-light.png'),
    animations: 'disabled',
  })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(placeholder).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath('update-card-placeholder-dark.png'),
    animations: 'disabled',
  })
})

test('the notes are the release’s markdown: a heading, bullets and a link that leaves the app', async ({
  page,
}) => {
  const notesMarkdown = "## What's new\n\n- One\n- Two\n\n[Details](https://example.com/release)"
  await answer(page, () => desktop({ status: 'available', newest: { ...offer, notesMarkdown } }))
  await artwork(page)
  await page.goto('/')
  const notes = card(page).getByTestId('update-card-notes')
  await expect(notes.getByRole('heading', { level: 2, name: "What's new" })).toBeVisible()
  await expect(notes.getByRole('listitem')).toHaveCount(2)
  const link = notes.getByRole('link', { name: 'Details' })
  await expect(link).toHaveAttribute('href', 'https://example.com/release')
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('rel', /noreferrer/)
})

test('the notes cannot run or draw their own HTML', async ({ page }) => {
  const notesMarkdown =
    "<script>document.title='pwned'</script>\n\n" +
    '<img src="x" onerror="document.title=\'pwned\'">\n\n' +
    "[click](javascript:document.title='pwned')"
  await answer(page, () => desktop({ status: 'available', newest: { ...offer, notesMarkdown } }))
  await artwork(page)
  await page.goto('/')
  const update = card(page)
  await expect(update).toBeVisible()
  await expect(page).toHaveTitle('CrossBoard')
  await expect(update.locator('script')).toHaveCount(0)
  await expect(update.locator('img[src="x"]')).toHaveCount(0)
  const hrefs = await update
    .locator('a')
    .evaluateAll((links) => links.map((a) => a.getAttribute('href') ?? ''))
  expect(hrefs.join(' ')).not.toMatch(/javascript:/)
})

test('without markdown the card shows the plain notes; empty notes leave the region empty', async ({
  page,
}) => {
  let state = desktop({
    status: 'available',
    newest: { ...offer, notes: 'Fixes & more', notesMarkdown: '' },
  })
  await answer(page, () => state)
  await artwork(page)
  await page.goto('/')
  const notes = card(page).getByTestId('update-card-notes')
  await expect(notes).toHaveText('Fixes & more')
  // Both empty: the region is still there (empty), and the actions still work.
  await page.evaluate(() => localStorage.removeItem('update-card'))
  state = desktop({ status: 'available', newest: { ...offer, notes: '', notesMarkdown: '' } })
  await page.reload()
  await expect(card(page)).toBeVisible()
  await expect(notes).toBeVisible()
  await expect(notes).toHaveText('')
  await expect(card(page).getByRole('button', { name: 'Install now' })).toBeVisible()
})

test('Install now starts the existing install once and closes the card at once', async ({ page }) => {
  // The state reads answer as usual; the install itself is held until the test lets it answer, so a card
  // waiting for it would still be on the page.
  const asked = await answer(page, () => desktop({ status: 'available', newest: offer }))
  await artwork(page)
  let posts = 0
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  await page.route(/\/api\/updates\/install$/, async (route) => {
    posts += 1
    await held
    return route.fulfill({ json: desktop({ status: 'downloading', newest: offer }) })
  })
  await page.goto('/')
  await expect(card(page)).toBeVisible()
  await card(page).getByRole('button', { name: 'Install now' }).click()
  await expect(card(page)).toHaveCount(0)
  await expect.poll(() => posts).toBe(1)
  release()
  await page.waitForTimeout(250)
  // One install, nothing else: no check, no settings, no second press.
  expect(posts).toBe(1)
  expect(asked).toEqual([])
  await expect(card(page)).toHaveCount(0)
})

for (const [width, height] of [
  [720, 800],
  [1280, 800],
] as const) {
  test(`the card fits the viewport and scrolls its own notes at ${width}×${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    const items = Array.from({ length: 60 }, (_, i) => `- Item ${i + 1} of a long release`).join('\n')
    await answer(page, () =>
      desktop({ status: 'available', newest: { ...offer, notesMarkdown: `## What's new\n\n${items}` } }),
    )
    await artwork(page)
    await page.goto('/')
    const update = card(page)
    await expect(update).toBeVisible()
    const box = (await update.boundingBox())!
    expect(box.y).toBeGreaterThanOrEqual(48) // below the sticky top bar
    expect(box.x + box.width).toBeLessThanOrEqual(width)
    expect(box.y + box.height).toBeLessThanOrEqual(height)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    const notes = update.getByTestId('update-card-notes')
    expect(await notes.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
    await notes.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
  })
}
