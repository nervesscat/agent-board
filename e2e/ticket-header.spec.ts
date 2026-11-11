import type { Locator, Page } from '@playwright/test'

import { expect, test } from './fixtures'
import { box, coveredAt, longTicket, openLong, scrollTo, ticketHeader } from './scrolling'

const title = (page: Page) => page.getByRole('heading', { level: 1 })

/** Whether the page's own content (the feed, the side cards) is right under the header's middle. */
const contentUnder = (header: Locator) =>
  header.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const body = el.nextElementSibling!
    return document
      .elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      .some((hit) => hit !== body && body.contains(hit))
  })

/** The header's background and the page's own (opaque): the header must match it, not show through. */
const backgrounds = (header: Locator) =>
  header.evaluate((el) => ({
    header: getComputedStyle(el).backgroundColor,
    page: getComputedStyle(document.body).backgroundColor,
  }))

/** Asserts the ticket's title is in view, under the top bar, and drawn over whatever scrolls under it. */
async function expectStuck(page: Page) {
  const banner = await box(page.getByRole('banner'))
  const header = await box(ticketHeader(page))
  await expect(title(page)).toBeInViewport()
  expect(Math.abs(header.y - (banner.y + banner.height))).toBeLessThanOrEqual(1)
  expect((await box(title(page))).y).toBeGreaterThanOrEqual(banner.y + banner.height)
  expect(await contentUnder(ticketHeader(page))).toBe(true)
  expect(await coveredAt(ticketHeader(page))).toEqual([])
  // Below the header the page is the page's again: the header takes no clicks it does not show.
  const below = await ticketHeader(page).evaluate((el) => {
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.bottom + 4)
    return !!hit && !el.contains(hit)
  })
  expect(below).toBe(true)
}

test('the ticket header sticks under the top bar once scrolled to it, over the feed', async ({
  page,
  api,
  human,
}) => {
  const t = await longTicket(api, human, 'Keep the title in view')
  await openLong(page, `/projects/${t.projectId}/features/${t.id}`)

  // At rest it is where it always was: under the breadcrumb, and the page's only heading.
  await expect(title(page)).toHaveCount(1)
  await expect(title(page)).toContainText(`#${t.id} Keep the title in view`)
  const breadcrumb = await box(page.getByRole('main').locator('section nav').first())
  const rest = await box(title(page))
  expect(rest.y).toBeGreaterThanOrEqual(breadcrumb.y + breadcrumb.height)

  // It goes up with the page until it reaches the top bar.
  const banner = await box(page.getByRole('banner'))
  expect(rest.y - 10).toBeGreaterThan(banner.y + banner.height)
  expect(await scrollTo(page, 10)).toBe(10)
  expect(Math.abs((await box(title(page))).y - (rest.y - 10))).toBeLessThanOrEqual(1)

  // From there on it stays, halfway down the feed and at the very end.
  const end = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)
  expect(await scrollTo(page, Math.round(end / 2))).toBeGreaterThan(rest.y)
  await expectStuck(page)
  expect(await scrollTo(page, 'bottom')).toBe(end)
  await expectStuck(page)
})

test('the previous and next ticket controls stay in the stuck header while the page scrolls', async ({
  page,
  api,
  human,
}) => {
  // One on either side: the ticket opened below the step controls has both.
  await api.ticket({ title: 'An earlier ticket in the same stage', status: 'in_progress' })
  const t = await longTicket(api, human, 'Keep the steps in reach')
  await api.ticket({ title: 'A later ticket in the same stage', status: 'in_progress' })
  await openLong(page, `/projects/${t.projectId}/features/${t.id}`)

  const prev = page.getByRole('link', { name: /^Previous ticket in / })
  const next = page.getByRole('link', { name: /^Next ticket in / })
  await expect(prev).toHaveCount(1)
  await expect(next).toHaveCount(1)

  await scrollTo(page, 'bottom')
  await expect(prev).toBeInViewport()
  await expect(next).toBeInViewport()
  expect(await coveredAt(prev, 6)).toEqual([])
  expect(await coveredAt(next, 6)).toEqual([])
  // They sit in the stuck header, under the top bar, instead of scrolling away with the breadcrumb.
  const header = await box(ticketHeader(page))
  expect((await box(prev)).y).toBeGreaterThanOrEqual(header.y)
  expect((await box(next)).y + (await box(next)).height).toBeLessThanOrEqual(header.y + header.height + 1)

  // And they still take the reader to the next ticket from there.
  const here = page.url()
  await next.click()
  await expect(page).not.toHaveURL(here)
  await expect(title(page)).toBeVisible()
})

test('the stuck header has the page background, light and dark', async ({ page, api, human }) => {
  const t = await longTicket(api, human, 'Readable in both themes')
  const seen: string[] = []
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await openLong(page, `/projects/${t.projectId}/features/${t.id}`)
    if (colorScheme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/)
    else await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
    await scrollTo(page, 'bottom')
    await expectStuck(page)
    const bg = await backgrounds(ticketHeader(page))
    expect(bg.header, colorScheme).toBe(bg.page)
    seen.push(bg.header)
  }
  expect(seen[0]).not.toBe(seen[1])
})

test('renames the ticket from the stuck title, and the status changes from the stuck header', async ({
  page,
  api,
  human,
  project,
}) => {
  const t = await longTicket(api, human, 'Name it later')
  await openLong(page, `/projects/${t.projectId}/features/${t.id}`)
  const end = await scrollTo(page, 'bottom')

  await page.getByRole('button', { name: 'Name it later' }).click()
  const field = page.getByRole('textbox', { name: 'Title' })
  await expect(field).toBeFocused()
  await expect(field).toBeInViewport()
  await field.fill('Named while stuck')
  await field.press('Enter')
  await expect(title(page)).toContainText('Named while stuck')
  await expect.poll(async () => (await api.getTicket(t.id)).title).toBe('Named while stuck')

  // Esc leaves it as it was.
  await page.getByRole('button', { name: 'Named while stuck' }).click()
  await field.fill('Not this one')
  await field.press('Escape')
  await expect(field).toBeHidden()
  await expect(title(page)).toContainText('Named while stuck')
  expect(await page.evaluate(() => window.scrollY)).toBe(end)
  await expectStuck(page)

  const blocked = project.stages.find((s) => s.kind === 'blocked')!
  // The header has the ticket's Complexity select too: the status is the one showing its stage's name.
  await ticketHeader(page).getByRole('combobox').filter({ hasText: 'In progress' }).click()
  const option = page.getByRole('option', { name: blocked.name })
  await expect(option).toBeInViewport()
  await option.click()
  await expect.poll(async () => (await api.getTicket(t.id)).status).toBe(blocked.key)
  expect(await page.evaluate(() => window.scrollY)).toBe(end)
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('a long title wraps and stays in view, and the page does not scroll sideways', async ({
    page,
    api,
    human,
  }) => {
    const t = await longTicket(
      api,
      human,
      'A ticket with a long title that has to wrap on a phone instead of widening the page',
    )
    await openLong(page, `/projects/${t.projectId}/features/${t.id}`)
    await scrollTo(page, 'bottom')
    await expectStuck(page)
    // It keeps most of the screen for the page.
    expect((await box(ticketHeader(page))).height).toBeLessThan(page.viewportSize()!.height / 3)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
    ).toBe(false)
  })

  test('the step controls stay in the stuck header on a phone', async ({ page, api, human }) => {
    await api.ticket({ title: 'An earlier ticket in the same stage', status: 'in_progress' })
    const t = await longTicket(api, human, 'Keep the steps in reach on a phone')
    await api.ticket({ title: 'A later ticket in the same stage', status: 'in_progress' })
    await openLong(page, `/projects/${t.projectId}/features/${t.id}`)

    const prev = page.getByRole('link', { name: /^Previous ticket in / })
    const next = page.getByRole('link', { name: /^Next ticket in / })
    await scrollTo(page, 'bottom')
    await expect(prev).toBeInViewport()
    await expect(next).toBeInViewport()
    expect(await coveredAt(prev, 6)).toEqual([])
    expect(await coveredAt(next, 6)).toEqual([])
    // The extra row still leaves most of the screen for the page.
    expect((await box(ticketHeader(page))).height).toBeLessThan(page.viewportSize()!.height / 3)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
    ).toBe(false)
  })
})
