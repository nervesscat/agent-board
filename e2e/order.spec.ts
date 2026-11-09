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
async function column(api: Api, status: string, titles: string[], tags: string[][] = []) {
  const ids: number[] = []
  for (const [i, title] of titles.entries())
    ids.push((await api.ticket({ title, status, tags: tags[i] ?? [] })).id)
  return ids
}

const card = (page: Page, id: number) => page.locator(`[data-card="${id}"]`)

/**
 * Drags card `id` within its column over the top (`above`) or bottom (`below`) edge of card `target`,
 * waits for the drop line, and drops it there.
 */
async function drag(page: Page, id: number, side: 'above' | 'below', target: number) {
  await card(page, id).getByRole('link').hover()
  const to = (await card(page, target).boundingBox())!
  await page.mouse.down()
  const x = to.x + to.width / 2
  const y = side === 'above' ? to.y + 8 : to.y + to.height - 8
  await page.mouse.move(x, y, { steps: 8 })
  // The board takes a drag over only once it has drawn the drag it began (its dragover reads that state), and
  // the moves above can end before it has: so wait for the card to show as dragged, then move over the place
  // once more, where the board's next dragover sees it.
  await expect(card(page, id).getByRole('link')).toHaveClass(/opacity-40/)
  await page.mouse.move(x, y, { steps: 2 })
  await expect(page.locator('[data-drop-indicator]')).toBeVisible()
  await page.mouse.up()
}

/** The href of a link to that ticket's page. */
const pageOf = (id: number) => new RegExp(`/features/${id}$`)

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
  await expect.poll(() => listed(human, project.id, 'review')).toEqual([a, c, b])

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
    'href',
    pageOf(c!),
  )
})

test('a card dragged to another column changes stage and arrives there unplaced, below the placed ones', async ({
  page,
  api,
  human,
  project,
}) => {
  const [x, y] = await column(api, 'in_progress', ['Placed first', 'Placed second'])
  await ok(human.patch(`/api/tickets/${x}`, { data: { position: 1 } }))
  await ok(human.patch(`/api/tickets/${y}`, { data: { position: 2 } }))
  const [t] = await column(api, 'todo', ['Moving on'])
  await ok(human.patch(`/api/tickets/${t}`, { data: { position: 1 } }))
  await page.goto(`/projects/${project.id}/features?view=board`)
  await expect.poll(() => shown(page, 'in_progress')).toEqual([x, y])

  await card(page, t!).getByRole('link').dragTo(page.locator('[data-column="in_progress"]'))
  // Last updated, yet below the placed ones: its place in todo did not come with it.
  await expect.poll(() => shown(page, 'in_progress')).toEqual([x, y, t])
  await expect.poll(async () => (await api.getTicket(t!)).status).toBe('in_progress')
  expect((await api.getTicket(t!)).rank).toBeNull()
  await expect.poll(() => listed(human, project.id, 'in_progress')).toEqual([x, y, t])
  await page.reload()
  await expect.poll(() => shown(page, 'in_progress')).toEqual([x, y, t])
})

test('on a filtered board, a drag places the card next to the one shown, counted in the whole column', async ({
  page,
  api,
  human,
  project,
}) => {
  const [a, b, c] = await column(api, 'todo', ['Tagged old', 'Hidden', 'Tagged new'], [['UI'], [], ['UI']])
  await page.goto(`/projects/${project.id}/features?view=board&tag=UI`)
  await expect.poll(() => shown(page, 'todo')).toEqual([c, a])

  // Right below the one shown under it; the hidden card keeps its place above that one.
  await drag(page, c!, 'below', a!)
  await expect.poll(() => shown(page, 'todo')).toEqual([a, c])
  await expect.poll(() => listed(human, project.id, 'todo')).toEqual([b, a, c])
})

test('a placement that fails to save puts the column back as it was', async ({
  page,
  api,
  human,
  project,
}) => {
  const [a, b] = await column(api, 'todo', ['Older', 'Newer'])
  await page.goto(`/projects/${project.id}/features?view=board`)
  await expect.poll(() => shown(page, 'todo')).toEqual([b, a])

  await page.route(`**/api/tickets/${a}`, (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"no luck"}' })
      : route.fallback(),
  )
  await drag(page, a!, 'above', b!)
  await expect(page.getByText('no luck')).toBeVisible()
  await expect.poll(() => shown(page, 'todo')).toEqual([b, a])
  expect(await listed(human, project.id, 'todo')).toEqual([b, a])
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
  await drag(page, top.id, 'below', base.id)
  await expect.poll(() => shown(page, 'review')).toEqual([base.id, top.id])
  await expect(hint).toHaveCount(0)
  await expect(card(page, top.id)).toContainText(`needs #${base.id}`)

  // Back above it over the API (an agent setting the merge order), the hint is back after a reload.
  await ok(human.patch(`/api/tickets/${top.id}`, { data: { position: 1 } }))
  await page.reload()
  await expect(card(page, top.id).getByText(`merge after #${base.id}`)).toBeVisible()
})

test("a ticket's page agrees at once with a placement made on the board above it", async ({
  page,
  api,
  human,
  project,
}) => {
  const [d, c, b, a] = await column(api, 'blocked', [
    'Fourth made',
    'Third made',
    'Second made',
    'First made',
  ])
  await page.goto(`/projects/${project.id}/features/${a}`)
  const where = page.getByText(/\d+ of 4 in Blocked/)
  await expect(where).toHaveText('1 of 4 in Blocked')

  // To the board by the page's own link, so the ticket's page stays cached as it was read.
  await page.getByRole('link', { name: 'Ongoing features' }).first().click()
  await expect.poll(() => shown(page, 'blocked')).toEqual([a, b, c, d])
  await drag(page, d!, 'above', c!)
  await expect.poll(() => shown(page, 'blocked')).toEqual([a, b, d, c])
  await expect.poll(() => listed(human, project.id, 'blocked')).toEqual([a, b, d, c])

  // Back on its page, the placement ranked it first: so it reads as first drawn, from the page as it
  // was cached, before the page is read again (held back here, so what is drawn first is what is seen).
  let release = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  await page.route(`**/api/tickets/${a}`, async (route) => {
    if (route.request().method() === 'GET') await held
    await route.fallback()
  })
  await page.goBack()
  await expect(where).toBeVisible()
  expect(await where.textContent()).toBe('1 of 4 in Blocked')
  expect(await page.getByRole('link', { name: 'Previous ticket in Blocked' }).count()).toBe(0)
  expect(await page.getByRole('link', { name: 'Next ticket in Blocked' }).getAttribute('href')).toMatch(
    pageOf(b!),
  )
  release()
  // Read again, it says the same.
  await expect.poll(() => api.getTicket(a!).then((t) => t.rank)).toBe(1)
  await expect(where).toHaveText('1 of 4 in Blocked')
  // And the moved card's page has it third, between the two it went between.
  await page.goto(`/projects/${project.id}/features/${d}`)
  await expect(page.getByText('3 of 4 in Blocked')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Previous ticket in Blocked' })).toHaveAttribute(
    'href',
    pageOf(b!),
  )
  await expect(page.getByRole('link', { name: 'Next ticket in Blocked' })).toHaveAttribute('href', pageOf(c!))
})

test('cards have no Move buttons: the agents set the order, the board only shows it', async ({
  page,
  api,
  project,
}) => {
  const [a, b] = await column(api, 'review', ['Older', 'Newer'])
  await page.goto(`/projects/${project.id}/features?view=board`)
  await expect.poll(() => shown(page, 'review')).toEqual([b, a])
  await card(page, a!).getByRole('link').hover()
  await expect(page.locator('[data-column] [data-card]').getByRole('button', { name: /move/i })).toHaveCount(
    0,
  )
  await expect(page.locator('[data-move], [data-move-buttons]')).toHaveCount(0)
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('cards show no Move buttons on a touch screen either', async ({ page, api, project }) => {
    const [a, b] = await column(api, 'in_progress', ['Older', 'Newer'])
    await page.goto(`/projects/${project.id}/features?view=board`)
    await expect.poll(() => shown(page, 'in_progress')).toEqual([b, a])
    await expect(
      page.locator('[data-column] [data-card]').getByRole('button', { name: /move/i }),
    ).toHaveCount(0)
    await expect(page.locator('[data-move], [data-move-buttons]')).toHaveCount(0)
  })
})
