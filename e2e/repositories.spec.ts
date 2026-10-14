import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'

// A hydration mismatch: error #418 in production, "Hydration failed" or "did not match" in development.
const MISMATCH = /#418|Hydration failed|did not match the client/

/** Whether React has hydrated the page heading: only hydrated elements carry React's props. */
const headingHydrated = (page: Page) =>
  page
    .getByRole('heading', { name: 'Repositories' })
    .evaluate((el) => Object.keys(el).some((key) => key.startsWith('__reactProps$')))

// One load per test: two throttled loads in one test can use up its 30 s budget on a loaded machine.
for (let load = 1; load <= 3; load++) {
  test(`the repositories page hydrates without a mismatch, and its button works, when projects arrive during hydration, load ${load}`, async ({
    page,
  }) => {
    // A slow CPU stretches hydration across the header's projects request: the order that mismatched.
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 20 })
    const mismatches: string[] = []
    page.on('pageerror', (error) => {
      if (MISMATCH.test(error.message)) mismatches.push(error.message)
    })
    page.on('console', (message) => {
      if (message.type() === 'error' && MISMATCH.test(message.text())) mismatches.push(message.text())
    })
    await page.goto('/repositories')
    await expect.poll(() => headingHydrated(page)).toBe(true)
    // The skeleton goes once the content is drawn: a click before that is lost, as the content is replaced.
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
    await page.getByRole('button', { name: 'New repository' }).click()
    const dialog = page.getByRole('dialog', { name: 'New repository' })
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    expect(mismatches).toEqual([])
  })
}
