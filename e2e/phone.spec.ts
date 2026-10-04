import type { Page } from '@playwright/test'

import { expect, ok, seededProject, test } from './fixtures'

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

/** Whether the page itself scrolls sideways (a board's own column scroller does not count). */
const scrollsSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)

test('no sideways scroll at 390px on Home, the PR queue, the board and a ticket', async ({
  page,
  api,
  human,
  project,
}) => {
  const t = await api.ticket({
    title: 'A ticket with a long title that has to wrap on a phone instead of widening the page',
    body: 'Instructions with a `long_inline_code_identifier_that_does_not_break_easily` and a link to https://example.com/a/very/long/path/that/goes/on/and/on',
    tags: ['High', 'Forms', 'Cosmetic'],
    status: 'in_progress',
  })
  await ok(human.post(`/api/tickets/${t.id}/updates`, { data: { body: 'A post with some progress.' } }))

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Repositories' })).toBeVisible()
  expect(await scrollsSideways(page)).toBe(false)

  await page.goto(`/projects/${project.id}/prs`)
  await expect(page.getByText('Nothing pending.')).toBeVisible()
  expect(await scrollsSideways(page)).toBe(false)

  await page.goto(`/projects/${project.id}/features`)
  await expect(page.locator('[data-column="in_progress"]').getByRole('link')).toHaveCount(1)
  expect(await scrollsSideways(page)).toBe(false)

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  await expect(page.getByText('A post with some progress.')).toBeVisible()
  expect(await scrollsSideways(page)).toBe(false)
})

test('the top bar folds its pages into a menu that opens', async ({ page }) => {
  await page.goto(`/projects/${seededProject().id}/prs`)
  await expect(page.getByRole('heading', { name: 'PR queue' })).toBeVisible()
  // The inline links are hidden at this width; the menu holds them.
  await expect(page.getByRole('banner').getByRole('link', { name: 'Daily' })).toBeHidden()
  await page.getByRole('button', { name: 'Pages' }).click()
  const menu = page.getByRole('dialog')
  for (const name of ['Repositories', 'Daily', 'Agents', 'Settings'])
    await expect(menu.getByRole('link', { name })).toBeVisible()
  await menu.getByRole('link', { name: 'Agents' }).click()
  await expect(page).toHaveURL(/\/agents$/)
  await expect(menu).toBeHidden()
})
