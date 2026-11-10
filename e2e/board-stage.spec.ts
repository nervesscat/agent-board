import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'

/**
 * The board opens where the reader left it: a phone keeps the one stage it picked, and a desktop
 * keeps its sideways position and each column's own top. Both are per tab, and both come back after
 * a ticket and after a reload.
 */

const pickStage = async (page: Page, name: string) => {
  await page.getByRole('combobox', { name: 'Stage' }).tap()
  await page.getByRole('option', { name: new RegExp(`^${name}`) }).tap()
}

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('the stage picked comes back after a ticket and after a reload', async ({ page, api, project }) => {
    await api.ticket({ title: 'Waiting in todo', status: 'todo' })
    const review = await api.ticket({ title: 'Looking at it', status: 'review' })
    await page.goto(`/projects/${project.id}/features`)
    // The board starts on the first stage with tickets (To do).
    await expect(page.locator('[data-column="todo"]')).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'Stage' })).toContainText('To do')

    await pickStage(page, 'In review')
    await expect(page.getByRole('combobox', { name: 'Stage' })).toContainText('In review')
    await expect(page.locator('[data-column="review"]')).toBeVisible()
    await expect(page.locator(`[data-card="${review.id}"]`)).toBeVisible()

    // Open the ticket from the picked stage, then come back.
    await page.locator(`[data-card="${review.id}"] a`).tap()
    await expect(page).toHaveURL(new RegExp(`/features/${review.id}$`))
    await page.goBack()
    await expect(page.getByRole('combobox', { name: 'Stage' })).toContainText('In review')
    await expect(page.locator('[data-column="review"]')).toBeVisible()
    await expect(page.locator('[data-column="todo"]')).toBeHidden()

    // And it is still there after a reload.
    await page.reload()
    await expect(page.getByRole('combobox', { name: 'Stage' })).toContainText('In review')
    await expect(page.locator('[data-column="review"]')).toBeVisible()
    await expect(page.locator('[data-column="todo"]')).toBeHidden()
  })
})

test.describe('desktop', () => {
  test.use({ viewport: { width: 1400, height: 900 } })

  test('its sideways position and a column top come back after a ticket', async ({ page, api, project }) => {
    await api.ticket({ title: 'Waiting in todo', status: 'todo' })
    const review = await api.ticket({ title: 'Looking at it', status: 'review' })
    for (let i = 0; i < 25; i++) await api.ticket({ title: `Done ${i}`, status: 'done' })

    await page.goto(`/projects/${project.id}/features`)
    const scroller = page.locator('[data-column="backlog"]').locator('xpath=../..')
    const done = page.locator('[data-column="done"]')
    // Sideways to the review stage, and down the done column: where the reader was.
    await scroller.evaluate((el) => {
      el.scrollLeft = 900
    })
    await done.evaluate((el) => {
      el.scrollTop = 240
    })
    await page.waitForFunction((id) => {
      const raw = sessionStorage.getItem(`features.board.${id}`)
      if (!raw) return false
      const saved = JSON.parse(raw) as { left?: number; columns?: Record<string, number> }
      return saved.left === 900 && saved.columns?.done === 240
    }, project.id)
    const card = page.locator(`[data-card="${review.id}"] a`)
    await expect(card).toBeInViewport()
    await card.click()
    await expect(page).toHaveURL(new RegExp(`/features/${review.id}$`))

    await page.goBack()
    await expect(page.locator('[data-column="review"]')).toBeVisible()
    expect(await scroller.evaluate((el) => el.scrollLeft)).toBe(900)
    expect(await done.evaluate((el) => el.scrollTop)).toBe(240)
  })
})
