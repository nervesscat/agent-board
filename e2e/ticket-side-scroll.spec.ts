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
    // scrollbar is not drawn (the window's is the only one): the edge with more behind it is blurred and
    // has a tiny arrow instead.
    const before = await sideScroll(page)
    expect(before.room).toBeGreaterThan(0)
    expect(before.top).toBe(0)
    expect(await side(page).evaluate((el) => getComputedStyle(el).scrollbarWidth)).toBe('none')
    const down = page.getByRole('button', { name: 'Scroll the side column down' })
    const up = page.getByRole('button', { name: 'Scroll the side column up' })
    // At the top: the bottom edge only.
    await expect(side(page)).toHaveAttribute('data-more-above', 'false')
    await expect(side(page)).toHaveAttribute('data-more-below', 'true')
    await expect(down).toBeVisible()
    await expect(up).toBeHidden()
    const blur = page.locator('[data-side-edge="bottom"] > div')
    expect(await blur.evaluate((el) => getComputedStyle(el).backdropFilter)).toContain('blur')
    // The arrow is tiny and sits centred on the edge, over the column's own width.
    const arrow = await box(down)
    const column = await box(side(page))
    expect(arrow.width).toBeLessThanOrEqual(24)
    expect(arrow.height).toBeLessThanOrEqual(24)
    expect(Math.abs(arrow.x + arrow.width / 2 - (column.x + column.width / 2))).toBeLessThan(4)
    expect(arrow.y + arrow.height).toBeLessThanOrEqual(column.y + column.height + 4)
    // The edge lets the pointer through, apart from the arrow.
    expect(
      await page.locator('[data-side-edge="bottom"]').evaluate((el) => getComputedStyle(el).pointerEvents),
    ).toBe('none')

    // The wheel over it moves it, not the page.
    await side(page).hover()
    await page.mouse.wheel(0, 120)
    await expect.poll(async () => (await sideScroll(page)).top).toBeGreaterThan(0)
    expect(await page.evaluate(() => window.scrollY)).toBe(end)
    await expect(side(page)).toHaveAttribute('data-more-above', 'true')
    await expect(up).toBeVisible()
    await expect(down).toBeVisible()

    // The arrow scrolls it about a screenful, and the page stays where it was.
    await side(page).evaluate((el) => el.scrollTo(0, 0))
    await expect(up).toBeHidden()
    const room = before.room
    await down.click()
    await expect
      .poll(async () => (await sideScroll(page)).top)
      .toBeGreaterThan(Math.min(room, (await side(page).evaluate((el) => el.clientHeight)) * 0.5))
    expect(await page.evaluate(() => window.scrollY)).toBe(end)

    // At its end only the top edge shows, and its arrow scrolls back up.
    await side(page).evaluate((el) => el.scrollTo(0, el.scrollHeight))
    await expect(side(page)).toHaveAttribute('data-more-below', 'false')
    await expect(side(page)).toHaveAttribute('data-more-above', 'true')
    await expect(down).toBeHidden()
    await expect(up).toBeVisible()
    const high = (await sideScroll(page)).top
    await up.click()
    await expect.poll(async () => (await sideScroll(page)).top).toBeLessThan(high)

    // From the keyboard: Tab reaches the arrow and Enter scrolls.
    await side(page).evaluate((el) => el.scrollTo(0, 0))
    await down.focus()
    await expect(down).toBeFocused()
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await sideScroll(page)).top).toBeGreaterThan(0)

    // And the main column keeps scrolling by the page, apart from it.
    // (A scroll the arrow started may still be running: put it where it is for good first.)
    await side(page).evaluate((el) => el.scrollTo({ top: 40, behavior: 'instant' }))
    await expect.poll(async () => (await sideScroll(page)).top).toBe(40)
    const kept = 40
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
    await expect(page.getByRole('button', { name: /Scroll the side column/ })).toBeHidden()
    // Scrolled to the bottom of the page, the side column's cards went by with the page.
    await scrollTo(page, 'bottom')
    expect((await box(side(page))).y).toBeLessThan(0)
  })
})
