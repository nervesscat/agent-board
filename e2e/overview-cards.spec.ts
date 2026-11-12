import type { Locator, Page } from '@playwright/test'

import { startedAt, yesterdayNoon } from './db'
import { expect, ok, section, test } from './fixtures'
import { create, record, stalledTicket } from './workTimeline'

/**
 * On a desktop the Overview's first row is Needs you alone, and the second row is Next, In progress
 * and Done today in that order; every card is as tall as the others whatever it holds, and what does
 * not fit scrolls under the card's header. On a phone the cards keep the layout's order, stacked,
 * and grow with their content instead: the page scrolls, not the card.
 */

const content = (card: Locator) => card.locator('[data-slot="card-content"]')
const header = (card: Locator) => card.locator('[data-slot="card-header"]')

async function overflows(card: Locator) {
  const area = content(card)
  const m = await area.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    overflowY: getComputedStyle(el).overflowY,
  }))
  expect(m.overflowY).toBe('auto')
  expect(m.scrollHeight).toBeGreaterThan(m.clientHeight)
  expect(m.scrollWidth).toBeLessThanOrEqual(m.clientWidth)
  // Scrolled, the header stays where it is, in view.
  const before = (await header(card).boundingBox())!.y
  await area.evaluate((el) => el.scrollTo(0, el.scrollHeight))
  expect(await area.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  expect((await header(card).boundingBox())!.y).toBe(before)
  await expect(header(card)).toBeVisible()
  await area.evaluate((el) => el.scrollTo(0, 0))
}

const height = async (l: Locator) => (await l.boundingBox())!.height

const shot = (page: Page, name: string, fullPage = false) =>
  page.screenshot({ path: test.info().outputPath(`${name}.png`), animations: 'disabled', fullPage })

test('the Overview cards are as tall as each other and scroll what does not fit', async ({
  page,
  project,
  api,
  human,
}) => {
  // Many tickets waiting for a look fill Needs you; one is in progress.
  for (let i = 1; i <= 24; i++) await api.ticket({ title: `Ready for a look ${i}`, status: 'review' })
  await api.ticket({ title: 'Being built', status: 'in_progress' })
  // Enough finished today and lined up next to run past the cap, as Needs you does.
  for (let i = 1; i <= 8; i++) {
    const t = await api.ticket({ title: `Shipped today ${i}`, status: 'todo' })
    await ok(human.patch(`/api/tickets/${t.id}`, { data: { status: 'done' } }))
  }
  for (let i = 1; i <= 5; i++) await api.ticket({ title: `Lined up ${i}`, status: 'todo' })

  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/projects/${project.id}`)
  const needsYou = section(page, 'Needs you')
  const inProgress = section(page, 'In progress')
  const doneToday = section(page, 'Done today')
  const next = section(page, 'Next: To do')
  await expect(needsYou).toContainText('Ready for a look 24')
  await expect(inProgress).toContainText('Being built')
  await expect(doneToday).toContainText('Shipped today 8')
  await expect(next).toContainText('Lined up 5')

  // Every card of the grid is the same fixed height, whatever it holds.
  const desktop = await height(needsYou)
  expect(desktop).toBeGreaterThan(300)
  expect(desktop).toBeLessThan(500)
  for (const card of [inProgress, doneToday, next]) expect(await height(card)).toBe(desktop)
  // Needs you has the first row to itself, across the grid's width.
  const needsBox = (await needsYou.boundingBox())!
  const nextBox = (await next.boundingBox())!
  expect(nextBox.y).toBeGreaterThan(needsBox.y + needsBox.height - 1)
  // The second row, left to right: Next, In progress, Done today.
  const inProgressBox = (await inProgress.boundingBox())!
  const doneBox = (await doneToday.boundingBox())!
  expect(inProgressBox.y).toBe(nextBox.y)
  expect(doneBox.y).toBe(nextBox.y)
  expect(nextBox.x).toBeLessThan(inProgressBox.x)
  expect(inProgressBox.x).toBeLessThan(doneBox.x)
  expect(Math.round(nextBox.x)).toBe(Math.round(needsBox.x))
  expect(Math.round(doneBox.x + doneBox.width)).toBe(Math.round(needsBox.x + needsBox.width))
  await overflows(needsYou)
  await overflows(doneToday)
  // In progress and Next fit, and do not scroll; their areas still scroll once they need to.
  for (const card of [inProgress, next]) {
    expect(await content(card).evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto')
    expect(await content(card).evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true)
  }
  await shot(page, 'desktop', true)

  await page.setViewportSize({ width: 390, height: 844 })
  // Capped first, all four cards in one shot: three entries each, and the way to see the rest.
  await page.evaluate(() => window.scrollTo(0, 0))
  // A phone keeps the layout's order, stacked, with no row of its own.
  const phoneY = async (card: Locator) => (await card.boundingBox())!.y
  expect(await phoneY(needsYou)).toBeLessThan(await phoneY(inProgress))
  expect(await phoneY(inProgress)).toBeLessThan(await phoneY(doneToday))
  expect(await phoneY(doneToday)).toBeLessThan(await phoneY(next))
  await shot(page, 'phone-capped', true)
  // On a phone each card shows its first three entries and a way to see the rest; no nested scroll.
  for (const card of [needsYou, doneToday, next]) {
    const rows = content(card).locator('li')
    await expect(rows.nth(3)).toBeHidden()
    const more = card.getByRole('button', { name: /View all/ })
    await expect(more).toBeVisible()
    await more.click()
    await expect(rows.nth(3)).toBeVisible()
    await expect(card.getByRole('button', { name: 'Show fewer' })).toBeVisible()
  }
  // Every card and its scrolling area stay within the phone's width.
  for (const card of [needsYou, inProgress, doneToday, next]) {
    const b = (await card.boundingBox())!
    expect(b.x + b.width).toBeLessThanOrEqual(390)
    expect(await content(card).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  }
  expect(await content(needsYou).evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true)
  await doneToday.scrollIntoViewIfNeeded()
  await shot(page, 'phone')
})

test('a stalled ticket says why and since when, in the same words on Needs you, In progress, the board and the list', async ({
  page,
  project,
  human,
  agent,
}) => {
  const { t } = await stalledTicket(human, agent, project)
  const title = new RegExp(`#${t.id} Ship the importer`)
  // Nothing is open: the why is the build that ended 40 minutes ago.
  const why = /Stalled \d+ min: nothing open since the build ended at \d{1,2}:\d{2}\s*[AP]M/

  await page.goto(`/projects/${project.id}`)
  const row = section(page, 'Needs you')
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: `Stalled: #${t.id} Ship the importer` }) })
  await expect(row).toContainText(why)
  await expect(row).toContainText(/last\s*claude/)
  await expect(row).not.toContainText('silent')
  // In progress: what the ticket is doing now, a line on when an agent was last heard, and the same stall.
  const progress = section(page, 'In progress')
    .getByRole('listitem')
    .filter({ hasText: `#${t.id} Ship the importer` })
  await expect(progress.getByTestId('now-line')).toContainText('Nothing open')
  await expect(progress.getByTestId('last-heard')).toContainText(/Last heard \d+ min ago/)
  await expect(progress.getByTestId('stall-notice')).toContainText(/Stalled \d+ min/)

  // The board card and the list row: the stall's badge, and on the list the now line too.
  await page.goto(`/projects/${project.id}/features?view=board`)
  const card = page.getByRole('link', { name: title })
  await expect(card.getByTestId('stall-notice')).toContainText(/Stalled \d+ min/)
  // A stalled card's badge is its why: the card's now is left off where another badge is shown.
  await expect(card.getByTestId('card-now')).toHaveCount(0)
  await page.getByRole('tab', { name: 'List' }).click()
  const listRow = page.getByRole('link', { name: title })
  await expect(listRow.getByTestId('stall-notice')).toContainText(/Stalled \d+ min/)
  await expect(listRow.getByTestId('now-line')).toContainText('Nothing open')
})

test('In progress says what a ticket waits on and since when, when a person has to act', async ({
  page,
  project,
  human,
  agent,
}) => {
  const t = await create(human, project, { title: 'Approve the copy', status: 'in_progress' })
  await record(agent, project, t.id, { kind: 'span_start', phase: 'spec' })
  await record(agent, project, t.id, { kind: 'wait_start', reason: 'human', note: 'needs the copy approved' })

  await page.goto(`/projects/${project.id}`)
  const row = section(page, 'In progress')
    .getByRole('listitem')
    .filter({ hasText: `#${t.id} Approve the copy` })
  await expect(row.getByTestId('now-line')).toContainText(
    /Waiting on you for [^·]+ since \d{1,2}:\d{2}\s*[AP]M/,
  )
  await expect(row.getByTestId('stall-notice')).toHaveCount(0)
})

test('Needs you lists a ticket whose agent is waiting on the human, and links to it', async ({
  page,
  project,
  human,
  agent,
}) => {
  const t = await create(human, project, { title: 'Approve the copy', status: 'in_progress' })
  await record(agent, project, t.id, { kind: 'span_start', phase: 'spec' })
  await record(agent, project, t.id, {
    kind: 'wait_start',
    reason: 'human',
    note: 'needs the copy approved',
  })

  await page.goto(`/projects/${project.id}`)
  const needsYou = section(page, 'Needs you')
  const link = needsYou.getByRole('link', { name: /Waiting on you since/ })
  await expect(link).toContainText(/Waiting on you since \d{1,2}:\d{2}\s*[AP]M/)
  await expect(link).toContainText('claude: needs the copy approved')
  await expect(needsYou).toContainText(`#${t.id} Approve the copy`)
  await expect(link).toHaveAttribute('href', new RegExp(`/projects/${project.id}/features/${t.id}`))
  await link.click()
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/features/${t.id}`))
})

test('a busy card with no other badge shows what it is doing now, as icon and time', async ({
  page,
  project,
  human,
  agent,
}) => {
  const t = await create(human, project, { title: 'Building right now', status: 'in_progress' })
  await record(agent, project, t.id, { kind: 'span_start', phase: 'build' })

  await page.goto(`/projects/${project.id}/features?view=board`)
  const card = page.getByRole('link', { name: new RegExp(`#${t.id} Building right now`) })
  await expect(card.getByTestId('card-now')).toContainText(/^\s*\d+ min|under a minute\s*$/)
  await expect(card.getByTestId('stall-notice')).toHaveCount(0)
})

test('Carrying over is a full row of its own and caps the same way, at desktop and on a phone', async ({
  page,
  project,
  api,
}) => {
  // Twelve tickets started yesterday: enough to run past the phone cap, and the desktop height.
  for (let i = 1; i <= 12; i++) {
    const t = await api.ticket({ title: `Carried over ${i}`, status: 'in_progress' })
    startedAt(t.id, yesterdayNoon())
  }

  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/projects/${project.id}`)
  const carrying = section(page, 'Carrying over')
  const needsYou = section(page, 'Needs you')
  const inProgress = section(page, 'In progress')
  const doneToday = section(page, 'Done today')
  const next = section(page, 'Next: To do')
  await expect(carrying).toContainText('Carried over 12')

  // Its own row, below every other card.
  const box = (await carrying.boundingBox())!
  for (const card of [needsYou, inProgress, doneToday, next]) {
    const b = (await card.boundingBox())!
    expect(box.y).toBeGreaterThan(b.y + b.height - 1)
  }
  // Full row: from the grid's left edge to its right edge.
  const above = await Promise.all(
    [needsYou, inProgress, doneToday, next].map(async (card) => (await card.boundingBox())!),
  )
  expect(Math.round(box.x)).toBe(Math.round(Math.min(...above.map((b) => b.x))))
  expect(Math.round(box.x + box.width)).toBe(Math.round(Math.max(...above.map((b) => b.x + b.width))))
  // The same fixed height as the other scroll cards, its content scrolling under the header.
  expect(await height(carrying)).toBe(await height(needsYou))
  await overflows(carrying)
  await shot(page, 'carrying-desktop', true)

  await page.setViewportSize({ width: 390, height: 844 })
  // The first three rows and a way to see the rest, like Needs you; no nested scroll while capped.
  const rows = content(carrying).locator('li')
  await expect(rows.nth(3)).toBeHidden()
  const more = carrying.getByRole('button', { name: /View all/ })
  await expect(more).toBeVisible()
  expect(await content(carrying).evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true)
  await shot(page, 'carrying-phone', true)
  await more.click()
  await expect(rows.nth(3)).toBeVisible()
  await expect(carrying.getByRole('button', { name: 'Show fewer' })).toBeVisible()
  const phone = (await carrying.boundingBox())!
  expect(phone.x + phone.width).toBeLessThanOrEqual(390)
  expect(await content(carrying).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
})
