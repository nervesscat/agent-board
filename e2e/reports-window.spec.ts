import type { Locator, Page } from '@playwright/test'

import { expect, expectTooltip, test } from './fixtures'
import { writeReport } from './runReports'
import { errorsOn, scrollsSideways } from './workTimeline'

/**
 * The reports window on the ticket page's Timeline card: the icon button at its top right, and the window
 * it opens with every run report of the ticket, filters, a sort, and a report in full with Back.
 */

const MIN = 60_000
const DAY = 24 * 60 * MIN
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

const card = (page: Page) => page.getByRole('region', { name: 'Timeline' })
const dialog = (page: Page) => page.getByRole('dialog')
const rows = (page: Page) => dialog(page).getByRole('listitem')
const count = (page: Page) => dialog(page).locator('[aria-live="polite"]')

/** Chooses `option` in the filter labelled `label`. */
async function pick(page: Page, label: string, option: string) {
  await dialog(page).getByLabel(label, { exact: true }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

/** Four reports on one ticket: they differ in agent, round, ratings, duration and when they ran. */
async function seed(agent: Parameters<typeof writeReport>[0], projectId: number, ticketId: number) {
  const sections = { brief: 'The brief.' }
  // hunt round 1: ran ten minutes ago, 40 min, difficulty 4, confidence 3.
  await writeReport(agent, projectId, ticketId, {
    agent: 'hunt',
    round: 1,
    endedAt: ago(10 * MIN),
    startedAt: ago(50 * MIN),
    difficulty: 4,
    confidence: 3,
    sections,
  })
  // hunt round 2: three days ago, 5 min, difficulty 2, confidence 5.
  await writeReport(agent, projectId, ticketId, {
    agent: 'hunt',
    round: 2,
    endedAt: ago(3 * DAY),
    startedAt: ago(3 * DAY + 5 * MIN),
    difficulty: 2,
    confidence: 5,
    sections,
  })
  // verify round 2: two days ago, 20 min, no difficulty, confidence 3.
  await writeReport(agent, projectId, ticketId, {
    agent: 'verify',
    round: 2,
    endedAt: ago(2 * DAY),
    startedAt: ago(2 * DAY + 20 * MIN),
    confidence: 3,
    sections,
  })
  // builder, outside a review: thirty days ago, no duration, difficulty 5, no confidence.
  await writeReport(agent, projectId, ticketId, {
    agent: 'builder',
    endedAt: ago(30 * DAY),
    difficulty: 5,
    sections,
  })
}

const order = async (page: Page, expected: RegExp[]) => await expect(rows(page)).toHaveText(expected)

test('the Reports button sits at the top right of the Timeline card, with a tooltip and the count', async ({
  page,
  api,
  project,
  agent,
}) => {
  const errors = errorsOn(page)
  const t = await api.ticket({ title: 'Import the ledger' })
  await seed(agent, project.id, t.id)
  await page.goto(`/projects/${project.id}/features/${t.id}`)

  const button = card(page).getByRole('button', { name: 'Reports (4)' })
  await expect(button).toBeVisible()
  await expect(button.getByTestId('reports-count')).toHaveText('4')
  await expectTooltip(button, 'Reports')

  // Top right of the card, level with its heading.
  const box = (await card(page).boundingBox())!
  const b = (await button.boundingBox())!
  const heading = (await card(page).getByRole('heading', { name: 'Timeline' }).boundingBox())!
  expect(b.x + b.width).toBeGreaterThan(box.x + box.width - 24)
  expect(b.y).toBeLessThan(box.y + 24)
  expect(b.x).toBeGreaterThan(heading.x + heading.width)

  await card(page).screenshot({ path: test.info().outputPath('timeline-reports-button.png') })
  expect(errors).toEqual([])
})

test('a ticket without reports still has the button, and its window says there are none', async ({
  page,
  api,
  project,
}) => {
  const t = await api.ticket({ title: 'Nothing reported yet' })
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const button = card(page).getByRole('button', { name: 'Reports', exact: true })
  await expect(button).toBeVisible()
  await expect(button.getByTestId('reports-count')).toHaveCount(0)
  await button.click()
  await expect(dialog(page).getByRole('heading', { name: 'Run reports' })).toBeVisible()
  await expect(dialog(page)).toContainText('No run reports yet.')
  await expect(dialog(page).getByRole('button', { name: 'Clear filters' })).toHaveCount(0)
})

test('the window lists every report, newest first, and each filter narrows the list with its count', async ({
  page,
  api,
  project,
  agent,
}) => {
  const t = await api.ticket({ title: 'Import the ledger' })
  await seed(agent, project.id, t.id)
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  await card(page).getByRole('button', { name: 'Reports (4)' }).click()

  await expect(dialog(page).getByRole('heading', { name: 'Run reports' })).toBeVisible()
  await expect(count(page)).toHaveText('4 of 4 reports')
  await order(page, [/hunt.*round 1/, /verify.*round 2/, /hunt.*round 2/, /builder/])
  await expect(dialog(page).getByRole('button', { name: 'Clear filters' })).toHaveCount(0)

  await pick(page, 'Agent', 'hunt')
  await expect(count(page)).toHaveText('2 of 4 reports')
  await order(page, [/hunt.*round 1/, /hunt.*round 2/])
  await expect(dialog(page).getByRole('button', { name: 'Clear filters' })).toBeVisible()

  // Combined with a round: only the hunt of round 2 is left.
  await pick(page, 'Round', 'Round 2')
  await expect(count(page)).toHaveText('1 of 4 reports')
  await order(page, [/hunt.*round 2/])

  // A combination nothing matches says so.
  await pick(page, 'Difficulty', '5')
  await expect(count(page)).toHaveText('0 of 4 reports')
  await expect(dialog(page)).toContainText('No report matches these filters.')
  await expect(rows(page)).toHaveCount(0)

  // Cleared in one click: everything is back, the filters read Any, and the button is gone.
  await dialog(page).getByRole('button', { name: 'Clear filters' }).click()
  await expect(count(page)).toHaveText('4 of 4 reports')
  await expect(rows(page)).toHaveCount(4)
  await expect(dialog(page).getByRole('button', { name: 'Clear filters' })).toHaveCount(0)
  await expect(dialog(page).getByLabel('Agent', { exact: true })).toContainText('All agents')

  await pick(page, 'Round', 'No round')
  await order(page, [/builder/])
  await pick(page, 'Round', 'All rounds')

  await pick(page, 'Difficulty', 'Unrated')
  await order(page, [/verify/])
  await pick(page, 'Difficulty', 'Any')

  await pick(page, 'Confidence', '3')
  await order(page, [/hunt.*round 1/, /verify/])
  await pick(page, 'Difficulty', '4')
  await order(page, [/hunt.*round 1/])
  await dialog(page).getByRole('button', { name: 'Clear filters' }).click()

  await pick(page, 'Confidence', 'Unrated')
  await order(page, [/builder/])
  await dialog(page).getByRole('button', { name: 'Clear filters' }).click()

  await pick(page, 'Duration', 'Not reported')
  await order(page, [/builder/])
  await pick(page, 'Duration', 'Reported')
  await expect(rows(page)).toHaveCount(3)
  await dialog(page).getByRole('button', { name: 'Clear filters' }).click()

  await pick(page, 'Time', 'Last hour')
  await order(page, [/hunt.*round 1/])
  await pick(page, 'Time', 'Last 7 days')
  await order(page, [/hunt.*round 1/, /verify.*round 2/, /hunt.*round 2/])
  await expect(count(page)).toHaveText('3 of 4 reports')
})

test('the sort reorders the list and keeps ties newest first', async ({ page, api, project, agent }) => {
  const t = await api.ticket({ title: 'Import the ledger' })
  await seed(agent, project.id, t.id)
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  await card(page).getByRole('button', { name: 'Reports (4)' }).click()

  await pick(page, 'Sort by', 'Oldest')
  await order(page, [/builder/, /hunt.*round 2/, /verify/, /hunt.*round 1/])
  await pick(page, 'Sort by', 'Longest')
  await order(page, [/hunt.*round 1/, /verify/, /hunt.*round 2/, /builder/])
  await pick(page, 'Sort by', 'Highest difficulty')
  await order(page, [/builder/, /hunt.*round 1/, /hunt.*round 2/, /verify/])
  await pick(page, 'Sort by', 'Highest confidence')
  await order(page, [/hunt.*round 2/, /hunt.*round 1/, /verify/, /builder/])
  await pick(page, 'Sort by', 'Newest')
  await order(page, [/hunt.*round 1/, /verify/, /hunt.*round 2/, /builder/])
})

test('a report opens in the window, and Back keeps the filters and the sort', async ({
  page,
  api,
  project,
  agent,
}) => {
  const t = await api.ticket({ title: 'Import the ledger' })
  await seed(agent, project.id, t.id)
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  await card(page).getByRole('button', { name: 'Reports (4)' }).click()

  await pick(page, 'Agent', 'hunt')
  await pick(page, 'Sort by', 'Oldest')
  await order(page, [/hunt.*round 2/, /hunt.*round 1/])

  await rows(page).first().getByRole('button').click()
  await expect(dialog(page).getByRole('heading', { name: 'Run report: hunt round 2' })).toBeVisible()
  await expect(dialog(page)).toContainText('The brief.')
  await expect(dialog(page).getByLabel('Agent', { exact: true })).toHaveCount(0)

  await dialog(page).getByRole('button', { name: 'Back to reports' }).click()
  await expect(dialog(page).getByRole('heading', { name: 'Run reports' })).toBeVisible()
  await expect(count(page)).toHaveText('2 of 4 reports')
  await expect(dialog(page).getByLabel('Agent', { exact: true })).toContainText('hunt')
  await expect(dialog(page).getByLabel('Sort by', { exact: true })).toContainText('Oldest')
  await order(page, [/hunt.*round 2/, /hunt.*round 1/])
})

test('from the keyboard: Enter opens it, focus stays inside, Escape closes it from a report and returns to the button', async ({
  page,
  api,
  project,
  agent,
}) => {
  const t = await api.ticket({ title: 'Import the ledger' })
  await seed(agent, project.id, t.id)
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const button = card(page).getByRole('button', { name: 'Reports (4)' })
  await button.focus()
  await page.keyboard.press('Enter')
  await expect(dialog(page).getByRole('heading', { name: 'Run reports' })).toBeVisible()

  // Tab goes round inside the window and never leaves it.
  for (let i = 0; i < 24; i++) {
    await page.keyboard.press('Tab')
    // A focus guard may hold it for a moment before sending it round.
    await expect.poll(() => insideDialog(page)).toBe(true)
  }
  await dialog(page)
    .getByRole('button', { name: /^builder/ })
    .focus()
  await page.keyboard.press('Enter')
  await expect(dialog(page).getByRole('heading', { name: 'Run report: builder' })).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)
  await expect(button).toBeFocused()

  // And from the list, by a click on the button.
  await button.click()
  await expect(dialog(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)
  await expect(button).toBeFocused()
})

const insideDialog = (page: Page) =>
  page.evaluate(() => !!document.activeElement?.closest('[role="dialog"], [role="listbox"]'))

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('the window fills the screen and nothing scrolls sideways', async ({ page, api, project, agent }) => {
    const t = await api.ticket({ title: 'Import the ledger' })
    await seed(agent, project.id, t.id)
    await page.goto(`/projects/${project.id}/features/${t.id}`)
    await card(page).getByRole('button', { name: 'Reports (4)' }).click()
    const d = dialog(page)
    await expect(d.getByRole('heading', { name: 'Run reports' })).toBeVisible()

    await expect(async () => {
      const box = (await d.boundingBox())!
      expect(box).toMatchObject({ x: 0, y: 0, width: 390, height: 844 })
    }).toPass()
    await expect(d).toHaveCSS('border-top-left-radius', '0px')
    expect(await scrollsSideways(page)).toBe(false)
    expect(await sideways(d)).toBe(false)
    // The filters wrap into the width instead of leaving it.
    const select = (await d.getByLabel('Sort by', { exact: true }).boundingBox())!
    expect(select.x + select.width).toBeLessThanOrEqual(390)
    await page.screenshot({ path: test.info().outputPath('reports-window-phone.png') })

    await d.getByRole('button', { name: /^hunt/ }).first().click()
    await expect(d.getByRole('button', { name: 'Back to reports' })).toBeVisible()
    expect(await scrollsSideways(page)).toBe(false)
    expect(await sideways(d)).toBe(false)
  })
})

const sideways = (el: Locator) => el.evaluate((e) => e.scrollWidth > e.clientWidth)

test('the Time presets count from the server clock when the browser clock is hours ahead', async ({
  page,
  api,
  project,
  agent,
}) => {
  const t = await api.ticket({ title: 'Import the ledger' })
  await seed(agent, project.id, t.id)
  // The browser's clock runs three hours ahead of the server's.
  await page.addInitScript(() => {
    const skew = 3 * 60 * 60 * 1000
    const RealDate = Date
    class SkewedDate extends RealDate {
      constructor(...args: unknown[]) {
        super(...((args.length ? args : [RealDate.now() + skew]) as [number]))
      }
      static now() {
        return RealDate.now() + skew
      }
    }
    window.Date = SkewedDate as DateConstructor
  })
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  await card(page).getByRole('button', { name: 'Reports (4)' }).click()
  await expect(count(page)).toHaveText('4 of 4 reports')
  await pick(page, 'Time', 'Last hour')
  await order(page, [/hunt.*round 1/])
})
