import type { Locator, Page } from '@playwright/test'

import { expect, ok, test } from './fixtures'

/** As many suggestions as a project can have (50): more than two pages of the tag filter's list. */
const MANY = Array.from({ length: 50 }, (_, i) => `Module ${i + 1}`)

/** Whether the page itself scrolls sideways (a board's own column scroller does not count). */
const scrollsSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)

/** The tag filter's `?tag=`, decoded (the router writes a space as `+`). */
const tagParam = (page: Page) => new URL(page.url()).searchParams.get('tag')

const filter = (page: Page) => page.getByRole('combobox', { name: 'Filter by tag' })
const options = (page: Page) => page.getByRole('option')
const search = (page: Page) => page.getByRole('combobox', { name: 'Search tags' })
/** The part of the open popup that scrolls: the list and what follows it. */
const scroller = (page: Page) => page.locator('[data-slot="combobox-scroller"]')

/** The scroller's box: its heights and where it is scrolled to. */
const box = (el: Locator) =>
  el.evaluate((node) => ({
    client: node.clientHeight,
    scroll: node.scrollHeight,
    top: node.scrollTop,
    height: node.getBoundingClientRect().height,
    viewport: window.innerHeight,
    rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
  }))

/** Scrolls the list to its end. */
const scrollToEnd = (el: Locator) => el.evaluate((node) => (node.scrollTop = node.scrollHeight))

/** The list scrolls inside a popup lower than the viewport and no more than 20rem. */
async function expectBoundedAndScrolling(page: Page) {
  const b = await box(scroller(page))
  expect(b.scroll).toBeGreaterThan(b.client)
  expect(b.height).toBeLessThan(b.viewport)
  const popup = await page.locator('[data-slot="combobox-content"]').boundingBox()
  expect(popup!.height).toBeLessThanOrEqual(20 * b.rem + 1)
  expect(popup!.height).toBeLessThan(b.viewport)
}

/** The tag filter's pages from the server; `offset` 0 is the first. */
const TAGS = '**/api/projects/*/tags?*'
const offsetOf = (url: string) => Number(new URL(url).searchParams.get('offset') ?? 0)
const searchOf = (url: string) => new URL(url).searchParams.get('q') ?? ''
const loading = (page: Page) => page.getByRole('status').filter({ hasText: 'Loading tags…' })

test('many tags scroll inside the tag filter, a page at a time from the server, with a loading indicator', async ({
  page,
  project,
  human,
}) => {
  await ok(human.patch(`/api/projects/${project.id}`, { data: { tagSuggestions: MANY } }))
  // The pages after the first are held a moment, long enough to see them loading.
  const asked: number[] = []
  await page.route(TAGS, async (route) => {
    const offset = offsetOf(route.request().url())
    asked.push(offset)
    if (offset > 0) await new Promise((r) => setTimeout(r, 600))
    await route.continue()
  })
  await page.goto(`/projects/${project.id}/features?view=board`)
  await filter(page).click()
  // "All tags" and the first page of 20, not the 50.
  await expect(options(page)).toHaveCount(21)
  await expect(options(page).first()).toHaveText('All tags')
  await expect(options(page).last()).toHaveText('Module 20')
  expect(asked).toEqual([0])
  await expectBoundedAndScrolling(page)
  // The tags come in with an animation.
  await expect(page.getByRole('option', { name: 'Module 1', exact: true })).not.toHaveCSS(
    'animation-name',
    'none',
  )

  await scrollToEnd(scroller(page))
  await expect(loading(page)).toBeVisible()
  await expect(options(page)).toHaveCount(41)
  await expect(loading(page)).toHaveCount(0)
  expect((await box(scroller(page))).top).toBeGreaterThan(0)
  await scrollToEnd(scroller(page))
  await expect(loading(page)).toBeVisible()
  await expect(options(page)).toHaveCount(51)
  // All there: nothing more to load, and no page asked twice.
  await expect(page.locator('[data-slot="more-tags"]')).toHaveCount(0)
  expect(asked).toEqual([0, 20, 40])
  const last = page.getByRole('option', { name: 'Module 50' })
  await last.scrollIntoViewIfNeeded()
  await expect(last).toBeInViewport()
  await last.click()
  await expect.poll(() => tagParam(page)).toBe('Module 50')
  await expect(filter(page).locator('[data-slot="combobox-value"]')).toHaveText('Module 50')

  // Opened again, it starts over from the first page.
  await filter(page).click()
  await expect(options(page)).toHaveCount(21)
})

test('a few tags show at once, with no loading', async ({ page, project }) => {
  await page.goto(`/projects/${project.id}/features?view=board`)
  await filter(page).click()
  await expect(options(page)).toHaveText(['All tags', 'Bug', 'UI', 'Implementation', 'Report'])
  await expect(page.locator('[data-slot="more-tags"]')).toHaveCount(0)
  const b = await box(scroller(page))
  expect(b.scroll).toBe(b.client)
})

test('with reduced motion the tags loaded do not animate', async ({ page, project, human }) => {
  await ok(human.patch(`/api/projects/${project.id}`, { data: { tagSuggestions: MANY } }))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(`/projects/${project.id}/features?view=board`)
  await filter(page).click()
  await expect(page.getByRole('option', { name: 'Module 1', exact: true })).toHaveCSS(
    'animation-name',
    'none',
  )
  await scrollToEnd(scroller(page))
  await expect(options(page)).toHaveCount(41)
  await expect(page.getByRole('option', { name: 'Module 40' })).toHaveCSS('animation-name', 'none')
})

test('the search narrows the tags in any casing, over every tag, and says when none match', async ({
  page,
  project,
  api,
  human,
}) => {
  await ok(human.patch(`/api/projects/${project.id}`, { data: { tagSuggestions: MANY } }))
  // Bug and UI are carried by tickets: offered after the 50 suggestions, past the first page.
  await api.ticket({ title: 'Tagged', status: 'todo', tags: ['Bug', 'UI'] })
  await page.goto(`/projects/${project.id}/features?view=board`)
  await filter(page).click()
  await expect(search(page)).toBeFocused()
  await expect(page.getByRole('option', { name: 'Bug' })).toHaveCount(0)

  // A tag past the first page is found.
  await search(page).fill('bug')
  await expect(options(page)).toHaveText(['All tags', 'Bug'])

  for (const text of ['mod', 'MOD']) {
    await search(page).fill(text)
    await expect(page.getByRole('option', { name: 'All tags' })).toBeVisible()
    await expect(page.getByRole('option', { name: 'Module 1', exact: true })).toBeVisible()
    await expect(page.getByRole('option', { name: 'Bug' })).toHaveCount(0)
    await expect(page.getByRole('option', { name: 'UI' })).toHaveCount(0)
    await expect(page.getByText('No tags match')).toHaveCount(0)
  }

  await search(page).fill('zzzz')
  await expect(options(page)).toHaveText(['All tags'])
  await expect(page.getByText('No tags match')).toBeVisible()
  await expect(page.locator('[data-slot="more-tags"]')).toHaveCount(0)

  // The last of the 50, never scrolled to, is found and filtered on.
  await search(page).fill('Module 50')
  await expect(options(page)).toHaveText(['All tags', 'Module 50'])
  await page.getByRole('option', { name: 'Module 50' }).click()
  await expect.poll(() => tagParam(page)).toBe('Module 50')
  await expect(page.getByText('Tagged')).toHaveCount(0)

  // The search is gone when it opens again.
  await filter(page).click()
  await expect(search(page)).toHaveValue('')
  await expect(options(page)).toHaveCount(21)
})

test("a search's late answer never replaces a newer search's list", async ({ page, project, api, human }) => {
  await ok(human.patch(`/api/projects/${project.id}`, { data: { tagSuggestions: MANY } }))
  await api.ticket({ title: 'Tagged', status: 'todo', tags: ['Bug'] })
  // The answer for "mod" comes back late, after the one for "bug".
  await page.route(TAGS, async (route) => {
    if (searchOf(route.request().url()) === 'mod') await new Promise((r) => setTimeout(r, 1500))
    await route.continue()
  })
  await page.goto(`/projects/${project.id}/features?view=board`)
  await filter(page).click()
  await expect(options(page)).toHaveCount(21)
  const modAsked = page.waitForRequest((r) => r.url().includes('/tags?') && searchOf(r.url()) === 'mod')
  await search(page).fill('mod')
  await modAsked
  // Asked, not answered: no list for it yet, only that it is loading.
  await expect(options(page)).toHaveText(['All tags'])
  await expect(loading(page)).toBeVisible()
  const modAnswered = page.waitForResponse((r) => r.url().includes('/tags?') && searchOf(r.url()) === 'mod')
  await search(page).fill('bug')
  await expect(options(page)).toHaveText(['All tags', 'Bug'])
  await modAnswered
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  await expect(options(page)).toHaveText(['All tags', 'Bug'])
  await expect(search(page)).toHaveValue('bug')
})

test('a page the server does not give is said quietly, and asked for again on Retry', async ({
  page,
  project,
}) => {
  let failing = true
  await page.route(TAGS, (route) =>
    failing ? route.fulfill({ status: 500, json: { error: 'down' } }) : route.continue(),
  )
  await page.goto(`/projects/${project.id}/features?view=board`)
  await filter(page).click()
  const failed = page.getByRole('status').filter({ hasText: "Couldn't load tags." })
  await expect(failed).toBeVisible()
  await expect(options(page)).toHaveText(['All tags'])
  failing = false
  await failed.getByRole('button', { name: 'Retry' }).click()
  await expect(options(page)).toHaveText(['All tags', 'Bug', 'UI', 'Implementation', 'Report'])
  await expect(failed).toHaveCount(0)
  // The filter still works.
  await page.getByRole('option', { name: 'UI' }).click()
  await expect(page).toHaveURL(/[?&]tag=UI/)
})

test("each tag is written in its chip's colour, light and dark; All tags in the plain one", async ({
  page,
  project,
  api,
}) => {
  await api.ticket({ title: 'Coloured', status: 'todo', tags: ['UI', 'high'] })
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await page.goto(`/projects/${project.id}/features?view=board`)
    if (colorScheme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/)
    const chip = async (tag: string) => {
      const el = page.getByText(tag, { exact: true })
      await expect(el).toHaveCount(1)
      return el.evaluate((node) => getComputedStyle(node).color)
    }
    const chips = { UI: await chip('UI'), high: await chip('high') }
    expect(chips.UI, colorScheme).not.toBe(chips.high)

    await filter(page).click()
    const label = (name: string) =>
      page
        .getByRole('option', { name, exact: true })
        .getByText(name, { exact: true })
        .evaluate((node) => getComputedStyle(node).color)
    expect(await label('UI'), colorScheme).toBe(chips.UI)
    expect(await label('high'), colorScheme).toBe(chips.high)
    const plain = await label('All tags')
    expect(plain, colorScheme).not.toBe(chips.UI)
    expect(plain, colorScheme).not.toBe(chips.high)
    const popover = await page
      .locator('[data-slot="combobox-content"]')
      .evaluate((node) => getComputedStyle(node).color)
    expect(plain, colorScheme).toBe(popover)
    await page.keyboard.press('Escape')
  }
})

test('a tag from a link that no ticket carries is offered first, and is the one picked', async ({
  page,
  project,
}) => {
  await page.goto(`/projects/${project.id}/features?view=board&tag=Zeta`)
  await expect(filter(page).locator('[data-slot="combobox-value"]')).toHaveText('Zeta')
  await filter(page).click()
  await expect(options(page)).toHaveText(['All tags', 'Zeta', 'Bug', 'UI', 'Implementation', 'Report'])
  await expect(page.getByRole('option', { name: 'Zeta' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('option', { name: 'All tags' })).not.toHaveAttribute('aria-selected', 'true')
})

test('the tag filter works from the keyboard', async ({ page, project, api }) => {
  await api.ticket({ title: 'Styled', status: 'todo', tags: ['UI'] })
  await api.ticket({ title: 'Broken', status: 'todo', tags: ['Bug'] })
  await page.goto(`/projects/${project.id}/features?view=list`)
  await page.getByRole('searchbox', { name: 'Search tickets' }).focus()
  await page.keyboard.press('Tab')
  await expect(filter(page)).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(search(page)).toBeFocused()
  await page.keyboard.type('ui')
  await expect(options(page)).toHaveText(['All tags', 'UI'])
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('option', { name: 'UI' })).toHaveAttribute('data-highlighted', '')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/[?&]tag=UI/)
  await expect(page.getByText('Broken')).toHaveCount(0)
  await expect(page.getByText('Styled')).toBeVisible()

  // Space opens it too, and "All tags" is picked from the keyboard.
  await filter(page).focus()
  await page.keyboard.press('Space')
  await expect(search(page)).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page).not.toHaveURL(/[?&]tag=/)
  await expect(page.getByText('Broken')).toBeVisible()
})

test.describe('at 390px', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('the open tag filter scrolls within the screen, without a sideways scroll', async ({
    page,
    project,
    human,
  }) => {
    await ok(human.patch(`/api/projects/${project.id}`, { data: { tagSuggestions: MANY } }))
    await page.goto(`/projects/${project.id}/features?view=board`)
    await filter(page).tap()
    await expect(options(page)).toHaveCount(21)
    await expectBoundedAndScrolling(page)
    expect(await scrollsSideways(page)).toBe(false)
    await scrollToEnd(scroller(page))
    await expect(options(page)).toHaveCount(41)
    expect(await scrollsSideways(page)).toBe(false)
  })
})
