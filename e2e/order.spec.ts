import type { APIRequestContext, Page } from '@playwright/test'

import type { TicketRow } from '#/lib/api'
import { type Api, expect, ok, test } from './fixtures'

/** A board column's cards, top to bottom. */
const cards = (page: Page, status: string) => page.locator(`[data-column="${status}"] [data-card]`)

/** The ticket ids of a column as the board shows it. */
const shown = async (page: Page, status: string) =>
  (await cards(page, status).evaluateAll((els) => els.map((el) => el.getAttribute('data-card')))).map(Number)

/** The ids of one stage's top-level tickets, as the list API gives them. */
async function listed(human: APIRequestContext, projectId: number, status: string) {
  const rows = await ok<TicketRow[]>(
    human.get(`/api/projects/${projectId}/tickets?parent=root&status=${status}`),
  )
  return rows.map((t) => t.id)
}

/** Tickets in one stage, created in this order: the column shows them newest first. */
async function column(api: Api, status: string, titles: string[]) {
  const ids: number[] = []
  for (const title of titles) ids.push((await api.ticket({ title, status })).id)
  return ids
}

const card = (page: Page, id: number) => page.locator(`[data-card="${id}"]`)

test('dragging a card up its own column puts it there, shows where it lands, and keeps it after a reload', async ({
  page,
  api,
  human,
  project,
}) => {
  const [a, b, c] = await column(api, 'review', ['First made', 'Second made', 'Third made'])
  await page.goto(`/projects/${project.id}/features?view=board`)
  await expect.poll(() => shown(page, 'review')).toEqual([c, b, a])

  // Drag the bottom card over the top half of the top one: a line shows where it lands.
  // Measured once hovering has scrolled the column into view.
  await card(page, a!).getByRole('link').hover()
  const to = (await card(page, c!).boundingBox())!
  await page.mouse.down()
  await page.mouse.move(to.x + to.width / 2, to.y + 8, { steps: 8 })
  await expect(page.locator('[data-drop-indicator]')).toBeVisible()
  await page.mouse.up()

  await expect.poll(() => shown(page, 'review')).toEqual([a, c, b])
  await expect(page.locator('[data-drop-indicator]')).toHaveCount(0)
  await expect.poll(() => listed(human, project.id, 'review')).toEqual([a, c, b])
  expect((await api.getTicket(a!)).status).toBe('review')
  await page.reload()
  await expect.poll(() => shown(page, 'review')).toEqual([a, c, b])

  // Dropped back on its own place, nothing changes.
  await card(page, a!).getByRole('link').hover()
  const self = (await card(page, a!).boundingBox())!
  await page.mouse.down()
  await page.mouse.move(self.x + self.width / 2, self.y + self.height - 4, { steps: 8 })
  await expect(page.locator('[data-drop-indicator]')).toHaveCount(0)
  await page.mouse.up()
  await expect.poll(() => shown(page, 'review')).toEqual([a, c, b])

  // The list view and the ticket page's "k of M" follow the same order.
  await page.goto(`/projects/${project.id}/features?view=list`)
  const rows = page.getByRole('listitem').filter({ hasText: 'In review' })
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toContainText('First made')
  await expect(rows.nth(1)).toContainText('Third made')
  await expect(rows.nth(2)).toContainText('Second made')
  await page.goto(`/projects/${project.id}/features/${a}`)
  await expect(page.getByText('1 of 3 in In review')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Previous ticket in In review' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Next ticket in In review' })).toHaveAttribute(
    'title',
    `#${c} Third made`,
  )
})

test('Move up and Move down work from the keyboard, and keep the focus on the moved card', async ({
  page,
  api,
  human,
  project,
}) => {
  const [a, b, c] = await column(api, 'todo', ['Oldest', 'Middle', 'Newest'])
  await page.goto(`/projects/${project.id}/features?view=board`)
  await expect.poll(() => shown(page, 'todo')).toEqual([c, b, a])

  // From the second card's link, Tab reaches its Move up.
  await card(page, b!).getByRole('link').focus()
  await page.keyboard.press('Tab')
  const up = card(page, b!).getByRole('button', { name: 'Move up' })
  await expect(up).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(() => shown(page, 'todo')).toEqual([b, c, a])
  // At the top Move up is off; the focus stays with the card, on Move down.
  await expect(up).toBeDisabled()
  const down = card(page, b!).getByRole('button', { name: 'Move down' })
  await expect(down).toBeFocused()
  await page.keyboard.press('Space')
  await expect.poll(() => shown(page, 'todo')).toEqual([c, b, a])
  await page.keyboard.press('Enter')
  await expect.poll(() => shown(page, 'todo')).toEqual([c, a, b])
  await expect(down).toBeDisabled()
  // Nothing opened the ticket on the way.
  await expect(page).toHaveURL(/\/features\?view=board$/)
  await expect.poll(() => listed(human, project.id, 'todo')).toEqual([c, a, b])
  await page.reload()
  await expect.poll(() => shown(page, 'todo')).toEqual([c, a, b])
})

test('a review card placed above a ticket it needs says to merge it after that one', async ({
  page,
  api,
  human,
  project,
}) => {
  const base = await api.ticket({ title: 'Foundation', status: 'review' })
  const top = await api.ticket({ title: 'Built on it', status: 'review' })
  await ok(human.patch(`/api/tickets/${top.id}`, { data: { needs: [base.id] } }))
  await page.goto(`/projects/${project.id}/features?view=board`)
  // Newest first puts it above what it needs.
  await expect.poll(() => shown(page, 'review')).toEqual([top.id, base.id])
  const hint = card(page, top.id).getByText(`merge after #${base.id}`)
  await expect(hint).toBeVisible()
  await expect(card(page, base.id).getByText(/merge after/)).toHaveCount(0)

  // Placed below it, the hint goes; the need itself still shows.
  await card(page, top.id).getByRole('button', { name: 'Move down' }).click()
  await expect.poll(() => shown(page, 'review')).toEqual([base.id, top.id])
  await expect(hint).toHaveCount(0)
  await expect(card(page, top.id)).toContainText(`needs #${base.id}`)

  // Back above it over the API (an agent setting the merge order), the hint is back after a reload.
  await ok(human.patch(`/api/tickets/${top.id}`, { data: { position: 1 } }))
  await page.reload()
  await expect(card(page, top.id).getByText(`merge after #${base.id}`)).toBeVisible()
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('tapping Move up puts the card above the one before it, and it stays there', async ({
    page,
    api,
    human,
    project,
  }) => {
    const [a, b] = await column(api, 'in_progress', ['Older', 'Newer'])
    await page.goto(`/projects/${project.id}/features`)
    await expect.poll(() => shown(page, 'in_progress')).toEqual([b, a])
    const up = card(page, a!).getByRole('button', { name: 'Move up' })
    await expect(up).toBeVisible()
    await up.tap()
    await expect.poll(() => shown(page, 'in_progress')).toEqual([a, b])
    await expect.poll(() => listed(human, project.id, 'in_progress')).toEqual([a, b])
    await page.reload()
    await expect.poll(() => shown(page, 'in_progress')).toEqual([a, b])
  })
})
