import { expect, test } from './fixtures'

// A hydration mismatch: error #418 in production, "Hydration failed" or "did not match" in development.
const MISMATCH = /#418|Hydration failed|did not match the client/

// One load per test: two throttled loads in one test can use up its 30 s budget on a loaded machine.
for (let load = 1; load <= 3; load++) {
  test(`the repositories page hydrates without a mismatch, and its button works, when projects arrive during hydration, load ${load}`, async ({
    page,
  }) => {
    // DIAGNOSTIC, not for merge: per-phase timings on the CI runner.
    const started = Date.now()
    const mark = (step: string) => console.log(`[timing] load ${load}: ${step} at ${Date.now() - started} ms`)
    page.on('domcontentloaded', () => mark('DOMContentLoaded'))
    page.on('load', () => mark('load event'))
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/projects') mark('projects requested')
    })
    page.on('response', (response) => {
      if (new URL(response.url()).pathname === '/api/projects')
        mark(`projects answered (${response.status()})`)
    })
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 20 })
    const mismatches: string[] = []
    page.on('pageerror', (error) => {
      if (MISMATCH.test(error.message)) mismatches.push(error.message)
    })
    page.on('console', (message) => {
      if (message.type() === 'error' && MISMATCH.test(message.text())) mismatches.push(message.text())
    })
    mark('goto start')
    await page.goto('/repositories')
    mark('goto returned')
    await page.waitForFunction(() => {
      const heading = Array.from(document.querySelectorAll('h1')).find(
        (h) => h.textContent?.trim() === 'Repositories',
      )
      return heading !== undefined && Object.keys(heading).some((key) => key.startsWith('__reactProps$'))
    })
    mark('heading hydrated')
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
    mark('skeleton gone')
    await page.getByRole('button', { name: 'New repository' }).click()
    const dialog = page.getByRole('dialog', { name: 'New repository' })
    await expect(dialog).toBeVisible()
    mark('dialog open')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    expect(mismatches).toEqual([])
  })
}
