import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'

// React reports a mismatch between the server's HTML and the first client render as error #418 in
// production builds, and with "Hydration failed" or "did not match" in development builds.
const MISMATCH = /#418|Hydration failed|did not match the client/

/** Whether React has hydrated the page heading: only hydrated elements carry React's props. */
const headingHydrated = (page: Page) =>
  page
    .getByRole('heading', { name: 'Repositories' })
    .evaluate((el) => Object.keys(el).some((key) => key.startsWith('__reactProps$')))

test('the repositories page hydrates without a mismatch, and its button works, when projects arrive during hydration', async ({
  page,
}) => {
  // A slow CPU stretches hydration across the header's projects request: the order that used to make the
  // first client render disagree with the server's skeleton. Each load is a new app, so a new cache.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 20 })
  const mismatches: string[] = []
  page.on('pageerror', (error) => {
    if (MISMATCH.test(error.message)) mismatches.push(error.message)
  })
  page.on('console', (message) => {
    if (message.type() === 'error' && MISMATCH.test(message.text())) mismatches.push(message.text())
  })
  const dialog = page.getByRole('dialog', { name: 'New repository' })
  for (let load = 0; load < 2; load++) {
    await page.goto('/repositories')
    await expect.poll(() => headingHydrated(page)).toBe(true)
    // The skeleton goes once the content is drawn: a click before that is lost, as the content is replaced.
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
    await page.getByRole('button', { name: 'New repository' }).click()
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  }
  expect(mismatches).toEqual([])
})
