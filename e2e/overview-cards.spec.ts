import type { Locator, Page } from '@playwright/test'

import { expect, section, test } from './fixtures'

/**
 * Needs you and In progress, side by side on the Overview, are as tall as each other whatever they
 * hold; what does not fit scrolls under the card's header. On a phone each is capped at that height.
 */

const content = (card: Locator) => card.locator('[data-slot="card-content"]')
const header = (card: Locator) => card.locator('[data-slot="card-header"]')

async function overflows(card: Locator) {
  const area = content(card)
  const m = await area.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    overflowY: getComputedStyle(el).overflowY,
  }))
  expect(m.overflowY).toBe('auto')
  expect(m.scrollHeight).toBeGreaterThan(m.clientHeight)
  expect(m.scrollWidth).toBeLessThanOrEqual(m.clientWidth)
  // Scrolled, the header stays where it is, in view.
  const before = (await header(card).boundingBox())!.y
  await area.evaluate((el) => el.scrollTo(0, el.scrollHeight))
  expect(await area.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  expect((await header(card).boundingBox())!.y).toBe(before)
  await expect(header(card)).toBeVisible()
  await area.evaluate((el) => el.scrollTo(0, 0))
}

const height = async (l: Locator) => (await l.boundingBox())!.height

const shot = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`${name}.png`), animations: 'disabled' })

test('Needs you and In progress are as tall as each other and scroll what does not fit', async ({
  page,
  project,
  api,
}) => {
  // Many tickets waiting for a look fill Needs you; one is in progress.
  for (let i = 1; i <= 24; i++) await api.ticket({ title: `Ready for a look ${i}`, status: 'review' })
  await api.ticket({ title: 'Being built', status: 'in_progress' })

  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/projects/${project.id}`)
  const needsYou = section(page, 'Needs you')
  const inProgress = section(page, 'In progress')
  await expect(needsYou).toContainText('Ready for a look 24')
  await expect(inProgress).toContainText('Being built')

  const desktop = await height(needsYou)
  expect(await height(inProgress)).toBe(desktop)
  expect(desktop).toBeGreaterThan(300)
  expect(desktop).toBeLessThan(500)
  // The pair sit side by side.
  expect((await needsYou.boundingBox())!.y).toBe((await inProgress.boundingBox())!.y)
  await overflows(needsYou)
  // In progress fits, and does not scroll; the other sections keep growing with what they hold.
  expect(await content(inProgress).evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true)
  expect(await content(section(page, 'Done today')).evaluate((el) => getComputedStyle(el).overflowY)).toBe(
    'visible',
  )
  await content(needsYou).evaluate((el) => el.scrollTo(0, 200))
  await shot(page, 'desktop')

  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => height(needsYou)).toBeLessThanOrEqual(desktop + 0.5)
  expect(await height(needsYou)).toBeGreaterThanOrEqual(desktop - 0.5)
  expect(await height(inProgress)).toBeLessThan(desktop)
  expect((await needsYou.boundingBox())!.width).toBeLessThanOrEqual(390)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await overflows(needsYou)
  await content(needsYou).evaluate((el) => el.scrollTo(0, 200))
  await needsYou.scrollIntoViewIfNeeded()
  await shot(page, 'phone')
})
