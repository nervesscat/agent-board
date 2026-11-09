import type { Locator, Page } from '@playwright/test'

import { expect, section, test } from './fixtures'
import { create, record, workedTicket } from './workTimeline'

/**
 * Needs you and In progress, side by side on the Overview, are as tall as each other whatever they
 * hold; what does not fit scrolls under the card's header. On a phone each is capped at that height.
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

const shot = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`${name}.png`), animations: 'disabled' })

test('Needs you and In progress are as tall as each other and scroll what does not fit', async ({
  page,
  project,
  api,
}) => {
  // Many tickets waiting for a look fill Needs you; one is in progress.
  for (let i = 1; i <= 24; i++) await api.ticket({ title: `Ready for a look ${i}`, status: 'review' })
  await api.ticket({ title: 'Being built', status: 'in_progress' })

  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/projects/${project.id}`)
  const needsYou = section(page, 'Needs you')
  const inProgress = section(page, 'In progress')
  await expect(needsYou).toContainText('Ready for a look 24')
  await expect(inProgress).toContainText('Being built')

  const desktop = await height(needsYou)
  expect(await height(inProgress)).toBe(desktop)
  expect(desktop).toBeGreaterThan(300)
  expect(desktop).toBeLessThan(500)
  // The pair sit side by side.
  expect((await needsYou.boundingBox())!.y).toBe((await inProgress.boundingBox())!.y)
  await overflows(needsYou)
  // In progress fits, and does not scroll; the other sections keep growing with what they hold.
  expect(await content(inProgress).evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true)
  expect(await content(section(page, 'Done today')).evaluate((el) => getComputedStyle(el).overflowY)).toBe(
    'visible',
  )
  await content(needsYou).evaluate((el) => el.scrollTo(0, 200))
  await shot(page, 'desktop')

  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => height(needsYou)).toBeLessThanOrEqual(desktop + 0.5)
  expect(await height(needsYou)).toBeGreaterThanOrEqual(desktop - 0.5)
  expect(await height(inProgress)).toBeLessThan(desktop)
  // Both cards and their scrolling areas stay within the phone's width.
  for (const card of [needsYou, inProgress]) {
    const b = (await card.boundingBox())!
    expect(b.x + b.width).toBeLessThanOrEqual(390)
    expect(await content(card).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  }
  await overflows(needsYou)
  await content(needsYou).evaluate((el) => el.scrollTo(0, 200))
  await needsYou.scrollIntoViewIfNeeded()
  await shot(page, 'phone')
})

test('a stalled ticket says why and since when, in the same words on Needs you, In progress, the board and the list', async ({
  page,
  project,
  human,
  agent,
}) => {
  const { t } = await workedTicket(human, agent, project)
  const title = new RegExp(`#${t.id} Ship the importer`)
  // The ticket's open build and the agent that has it, as the why names them everywhere.
  const why = /Stalled \d+ min: claude has a build open, nobody heard from since \d{1,2}:\d{2}\s*[AP]M/

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
  await expect(progress.getByTestId('now-line')).toContainText(/Building · claude · \d+ min/)
  await expect(progress.getByTestId('last-heard')).toContainText(/Last heard \d+ min ago/)
  await expect(progress.getByTestId('stall-notice')).toContainText(/Stalled \d+ min/)

  // The board card and the list row: the stall's badge, and on the list the now line too.
  await page.goto(`/projects/${project.id}/features?view=board`)
  const card = page.getByRole('link', { name: title })
  await expect(card.getByTestId('stall-notice')).toContainText(/Stalled \d+ min/)
  await expect(card.getByTestId('card-now')).toContainText(/\d+ min/)
  await page.getByRole('tab', { name: 'List' }).click()
  const listRow = page.getByRole('link', { name: title })
  await expect(listRow.getByTestId('stall-notice')).toContainText(/Stalled \d+ min/)
  await expect(listRow.getByTestId('now-line')).toContainText(/Building · claude · \d+ min/)
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
  await expect(row.getByTestId('now-line')).toContainText(/Waiting on you since \d{1,2}:\d{2}\s*[AP]M/)
  await expect(row.getByTestId('stall-notice')).toHaveCount(0)
})
