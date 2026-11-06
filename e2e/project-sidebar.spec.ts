import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'

const sidebar = (page: Page) => page.locator('aside').filter({ has: page.getByRole('navigation') })

/** That the whole of the sidebar's nav is inside the window. */
async function expectNavInView(page: Page) {
  const box = (await sidebar(page).getByRole('navigation').boundingBox())!
  const vh = page.viewportSize()!.height
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(vh)
}

const longText = Array.from({ length: 120 }, (_, i) => `Line ${i + 1} of a long description.`).join('\n\n')

test('the project sidebar stays in view while a long ticket page scrolls', async ({ page, project, api }) => {
  await page.setViewportSize({ width: 1280, height: 700 })
  const t = await api.ticket({ title: 'Long ticket', body: longText })
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  await expect(page.getByText('Line 120 of a long description.')).toBeAttached()
  expect(await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight * 2)).toBe(true)
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(500)
  await expectNavInView(page)
  // Below the sticky header, not under it.
  const header = (await page.locator('header').first().boundingBox())!
  expect((await sidebar(page).boundingBox())!.y).toBeGreaterThanOrEqual(header.y + header.height - 1)
})

test('the sidebar scrolls on its own when taller than the window', async ({ page, project }) => {
  await page.setViewportSize({ width: 1280, height: 260 })
  await page.goto(`/projects/${project.id}`)
  const aside = sidebar(page)
  await expect(aside.getByRole('navigation')).toBeVisible()
  const sizes = await aside.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }))
  expect(sizes.scroll).toBeGreaterThan(sizes.client)
  expect((await aside.boundingBox())!.height).toBeLessThanOrEqual(260)
  const last = aside.getByRole('navigation').getByRole('link').last()
  await last.scrollIntoViewIfNeeded()
  await expect(last).toBeInViewport()
  expect(await aside.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
})

test('at a narrow width the sidebar sits above the content and nothing scrolls sideways', async ({
  page,
  project,
  api,
}) => {
  await page.setViewportSize({ width: 390, height: 700 })
  const t = await api.ticket({ title: 'Long ticket', body: longText })
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  await expect(page.getByText('Line 120 of a long description.')).toBeAttached()
  const nav = sidebar(page).getByRole('navigation')
  await expect(nav).toBeVisible()
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
  ).toBe(true)
  expect(await sidebar(page).evaluate((el) => getComputedStyle(el).position)).toBe('static')
  await nav.getByRole('link').last().click()
  await expect(page).not.toHaveURL(new RegExp(`/features/${t.id}$`))
})
