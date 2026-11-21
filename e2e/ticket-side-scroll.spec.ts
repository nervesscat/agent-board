import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'
import { box, longTicket, openLong, scrollTo, ticketHeader } from './scrolling'

const side = (page: Page) => page.locator('[data-ticket-column="side"]')

/** The side column's own scroll and how much it has to scroll. */
const sideScroll = (page: Page) =>
  side(page).evaluate((el) => ({ top: el.scrollTop, room: el.scrollHeight - el.clientHeight }))

test.describe('side by side', () => {
  // Short enough that the side column is taller than what is left of the window under the header.
  test.use({ viewport: { width: 1280, height: 380 } })

  test('the side column stays in view while the main column scrolls, and scrolls by itself', async ({
    page,
    api,
    human,
  }) => {
    const t = await longTicket(api, human, 'Keep the side column in view')
    await openLong(page, `/projects/${t.projectId}/features/${t.id}`)
    await expect(side(page)).toHaveCount(1)

    // At the end of the feed the side column is still right under the stuck header, not scrolled away.
    const end = await scrollTo(page, 'bottom')
    expect(end).toBeGreaterThan(0)
    const header = await box(ticketHeader(page))
    const at = await box(side(page))
    expect(at.y).toBeGreaterThanOrEqual(header.y + header.height)
    expect(at.y + at.height).toBeLessThanOrEqual(380)
    await expect(side(page)).toBeInViewport()

    // It is taller than its area, so it scrolls inside itself and leaves the page where it is. Its own
    // scrollbar is not drawn (the window's is the only one), so it fades where there is more behind it.
    const before = await sideScroll(page)
    expect(before.room).toBeGreaterThan(0)
    expect(before.top).toBe(0)
    expect(await side(page).evaluate((el) => getComputedStyle(el).scrollbarWidth)).toBe('none')
    await expect(side(page)).toHaveAttribute('data-more-above', 'false')
    await expect(side(page)).toHaveAttribute('data-more-below', 'true')
    expect(await side(page).evaluate((el) => getComputedStyle(el).maskImage)).toContain('linear-gradient')
    await side(page).hover()
    await page.mouse.wheel(0, 120)
    await expect.poll(async () => (await sideScroll(page)).top).toBeGreaterThan(0)
    expect(await page.evaluate(() => window.scrollY)).toBe(end)
    await expect(side(page)).toHaveAttribute('data-more-above', 'true')

    // At its end only the top fades.
    await side(page).evaluate((el) => el.scrollTo(0, el.scrollHeight))
    await expect(side(page)).toHaveAttribute('data-more-below', 'false')
    await expect(side(page)).toHaveAttribute('data-more-above', 'true')

    // And the main column keeps scrolling by the page, apart from it.
    const kept = (await sideScroll(page)).top
    await scrollTo(page, 0)
    expect((await sideScroll(page)).top).toBe(kept)
  })
})

test.describe('stacked', () => {
  test.use({ viewport: { width: 700, height: 380 } })

  test('below the large breakpoint the side column is part of the page scroll', async ({
    page,
    api,
    human,
  }) => {
    const t = await longTicket(api, human, 'Stacked columns scroll as one')
    await openLong(page, `/projects/${t.projectId}/features/${t.id}`)
    const style = await side(page).evaluate((el) => {
      const s = getComputedStyle(el)
      return { position: s.position, overflowY: s.overflowY }
    })
    expect(style).toEqual({ position: 'static', overflowY: 'visible' })
    expect((await sideScroll(page)).top).toBe(0)
    await expect(side(page)).toHaveAttribute('data-more-below', 'false')
    expect(await side(page).evaluate((el) => getComputedStyle(el).maskImage)).toBe('none')
    // Scrolled to the bottom of the page, the side column's cards went by with the page.
    await scrollTo(page, 'bottom')
    expect((await box(side(page))).y).toBeLessThan(0)
  })
})
