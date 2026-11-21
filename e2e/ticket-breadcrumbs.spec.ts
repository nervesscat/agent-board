import type { APIRequestContext, Page } from '@playwright/test'

import { expect, test } from './fixtures'
import { addPosts, box, longTicket, openLong, scrollTo, ticketHeader } from './scrolling'

/** The breadcrumbs the page draws at its top, and the ones the floating header draws while those are away. */
const pageCrumbs = (page: Page) =>
  page.getByRole('main').locator('section > div > nav[aria-label="Breadcrumb"]')
const barCrumbs = (page: Page) => ticketHeader(page).locator('nav[aria-label="Breadcrumb"]')

/** The path's links that are drawn on screen right now, wherever they are. */
const crumbsOnScreen = (page: Page) =>
  page
    .getByRole('main')
    .locator('nav[aria-label="Breadcrumb"]')
    .evaluateAll((navs) =>
      navs
        .filter((n) => {
          const r = n.getBoundingClientRect()
          return r.height > 0 && r.bottom > 0 && r.top < window.innerHeight
        })
        .map((n) => n.closest('header') !== null),
    )

test("the floating header shows the breadcrumbs only while the page's own are scrolled out of view", async ({
  page,
  api,
  human,
}) => {
  const t = await longTicket(api, human, 'Breadcrumbs follow the page')
  await openLong(page, `/projects/${t.projectId}/features/${t.id}`)

  const height = () => page.evaluate(() => document.documentElement.scrollHeight)
  const rest = { page: await height(), header: (await box(ticketHeader(page))).height }

  // At rest the page shows them and the header does not: they are never on screen twice.
  await expect(pageCrumbs(page)).toBeInViewport()
  await expect(barCrumbs(page)).toHaveCount(0)
  expect(await crumbsOnScreen(page)).toEqual([false])

  // Scrolled past them, they are in the header, and only there.
  await scrollTo(page, 'bottom')
  await expect(barCrumbs(page)).toBeVisible()
  await expect(barCrumbs(page).getByRole('link', { name: 'Ongoing features' })).toBeVisible()
  await expect(barCrumbs(page)).toContainText(`#${t.id}`)
  await expect(pageCrumbs(page)).not.toBeInViewport()
  expect(await crumbsOnScreen(page)).toEqual([true])
  // The bar sits in the stuck header, under the top bar.
  const banner = await box(page.getByRole('banner'))
  expect((await box(barCrumbs(page))).y).toBeGreaterThanOrEqual(banner.y + banner.height)

  // They took the place of the header's meta line: the page and the header are as tall as at rest, so
  // nothing moves when they come and go.
  expect(await height()).toBe(rest.page)
  expect((await box(ticketHeader(page))).height).toBe(rest.header)

  // Back at the top they leave the header.
  await scrollTo(page, 0)
  await expect(barCrumbs(page)).toHaveCount(0)
  await expect(pageCrumbs(page)).toBeInViewport()
  expect(await crumbsOnScreen(page)).toEqual([false])
})

test("the rule follows the page's breadcrumbs by the pixel: partly in view is still in view", async ({
  page,
  api,
  human,
}) => {
  const t = await longTicket(api, human, 'Breadcrumbs at the edge')
  await openLong(page, `/projects/${t.projectId}/features/${t.id}`)
  const banner = await box(page.getByRole('banner'))
  const at = await box(pageCrumbs(page))
  const barBottom = banner.y + banner.height

  // The page's breadcrumbs still have a pixel under the top bar's edge: still the page's.
  await scrollTo(page, Math.round(at.y + at.height - barBottom - 2))
  await expect(barCrumbs(page)).toHaveCount(0)
  // All of them under the top bar: the header's.
  await scrollTo(page, Math.round(at.y + at.height - barBottom + 2))
  await expect(barCrumbs(page)).toBeVisible()
})

test("the links in the floating header go where the page's do", async ({ page, api, human }) => {
  const t = await longTicket(api, human, 'Breadcrumb links in the bar')
  await openLong(page, `/projects/${t.projectId}/features/${t.id}`)
  await scrollTo(page, 'bottom')
  await expect(barCrumbs(page)).toBeVisible()
  await barCrumbs(page).getByRole('link', { name: 'Ongoing features' }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${t.projectId}/features$`))
})

async function longLane(
  api: { ticket: (i: { title: string }) => Promise<{ id: number; projectId: number }> },
  human: APIRequestContext,
) {
  const parent = await api.ticket({
    title: 'A parent ticket with a title long enough that the path cannot fit on one line of a phone',
  })
  const res = await human.post(`/api/projects/${parent.projectId}/tickets`, {
    data: { title: 'The lane', parentId: parent.id, status: 'in_progress' },
  })
  const lane = (await res.json()) as { id: number; projectId: number }
  await addPosts(human, lane.id)
  return { parent, lane }
}

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('a long path stays on one line in the header and the page does not scroll sideways', async ({
    page,
    api,
    human,
  }) => {
    const { parent, lane } = await longLane(api, human)
    await openLong(page, `/projects/${lane.projectId}/features/${lane.id}`)
    await scrollTo(page, 'bottom')
    await expect(barCrumbs(page)).toBeVisible()
    const links = barCrumbs(page).getByRole('link')
    await expect(links).toHaveCount(2)
    // One line: every link of the path is on the same row, and inside the window.
    const rows = await links.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)))
    expect(new Set(rows).size).toBe(1)
    const nav = await box(barCrumbs(page))
    expect(nav.x + nav.width).toBeLessThanOrEqual(390)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
    ).toBe(false)
    // The header still leaves most of the screen for the page.
    expect((await box(ticketHeader(page))).height).toBeLessThan(page.viewportSize()!.height / 3)
    // And the parent's link works from the bar.
    await links.nth(1).click()
    await expect(page).toHaveURL(new RegExp(`/features/${parent.id}`))
  })
})
