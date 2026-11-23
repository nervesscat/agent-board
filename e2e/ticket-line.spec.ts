import { expect, expectTooltip, test } from './fixtures'
import { box } from './scrolling'

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 800 } })

  test('the line under the title fits: the three facts and the tags, one after the other, no sideways scroll', async ({
    page,
    api,
  }) => {
    const t = await api.ticket({
      title: 'A calm line',
      status: 'in_progress',
      tags: ['Ticket', 'UI', 'A longer tag', 'Another one'],
    })
    await page.goto(`/projects/${t.projectId}/features/${t.id}`)
    const facts = page.locator('[data-fact] > [aria-hidden]')
    await expect(facts).toHaveCount(3)
    const boxes = [await box(facts.nth(0)), await box(facts.nth(1)), await box(facts.nth(2))]
    for (const b of boxes) expect(b.x + b.width).toBeLessThanOrEqual(390)
    // The facts do not sit on top of each other.
    for (const [a, b] of [
      [boxes[0]!, boxes[1]!],
      [boxes[1]!, boxes[2]!],
    ] as const) {
      const apart = a.x + a.width <= b.x + 0.5 || b.x + b.width <= a.x + 0.5 || a.y + a.height <= b.y + 0.5
      expect(apart, 'two facts overlap').toBe(true)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await expectTooltip(page.locator('[data-fact]').nth(2), /^Updated on /)
  })
})
