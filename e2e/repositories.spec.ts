import { expect, test } from './fixtures'

// A hydration mismatch: error #418 in production, "Hydration failed" or "did not match" in development.
const MISMATCH = /#418|Hydration failed|did not match the client/

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
    // Registered before the navigation: the header's request can start, and be answered, before goto returns.
    const projectsAnswered = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/projects',
    )
    await page.goto('/repositories')
    // Only hydrated elements carry React's props. The test's own budget bounds this wait, not a fixed 10 s.
    await page.waitForFunction(() => {
      const heading = Array.from(document.querySelectorAll('h1')).find(
        (h) => h.textContent?.trim() === 'Repositories',
      )
      return heading !== undefined && Object.keys(heading).some((key) => key.startsWith('__reactProps$'))
    })
    // The mismatch, if any, happened while hydrating under the throttle. From here the page runs at full speed.
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    await projectsAnswered
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
