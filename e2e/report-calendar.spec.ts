import type { APIRequestContext, Page } from '@playwright/test'

import type { ReportList } from '#/lib/api'
import { localDate, shiftDate } from '#/lib/format'
import { isoWeekday, periodLabel } from '#/lib/reports'
import { inDatabase } from './db'
import { expect, ok, seedProject, test } from './fixtures'

// A daily report left missing shows its reminder on every later test's pages once its shift has ended,
// so each test here turns its project's reports off when it is done (as `quiet()` does in dailyPage.ts).
test.afterEach(async ({ human, project }) => {
  await ok(human.patch(`/api/projects/${project.id}/report-settings`, { data: { cadence: 'off' } }))
})

// Every day here is local, like the board's. Last month is wholly past whatever today is, so its
// days are done, missing or off for sure; this month holds today and maybe days to come.
const today = localDate()
const first = `${today.slice(0, 7)}-01`
const lastMonthEnd = shiftDate(first, -1)
const lastMonth = `${lastMonthEnd.slice(0, 7)}-01`
const monthEnd = (day: string) => {
  const d = new Date(`${day}T00:00:00`)
  return localDate(new Date(d.getFullYear(), d.getMonth() + 1, 0))
}
/** The first Monday of last month: its whole week is in that month. */
const monday = (() => {
  let d = lastMonth
  while (isoWeekday(d) !== 1) d = shiftDate(d, 1)
  return d
})()
/** "October 6", as the calendar names a day. */
const named = (day: string) =>
  new Date(`${day}T00:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })

/** Tracking began on `since` (the API starts it the day the cadence is set). */
const trackSince = (projectId: number, since: string) =>
  inDatabase((db) =>
    db.prepare('update report_settings set since = ? where project_id = ?').run(since, projectId),
  )

const calendarOf = (page: Page) => page.getByRole('region', { name: 'Report calendar' })
const dayButton = (page: Page, day: string, status: string) =>
  calendarOf(page).getByRole('button', { name: `${named(day)}: ${status}`, exact: true })

async function report(human: APIRequestContext, projectId: number, period: string, body: string) {
  await ok(human.post(`/api/projects/${projectId}/reports`, { data: { period, body } }))
}

test('a month of daily reports: done, missing and off days, a day opens, the jump to a missing one', async ({
  page,
  project,
  human,
}) => {
  // 09:00 to 17:00, Monday to Friday, tracked since the first of last month.
  await ok(human.patch(`/api/projects/${project.id}/report-settings`, { data: { cadence: 'daily' } }))
  trackSince(project.id, lastMonth)
  const tuesday = shiftDate(monday, 1)
  const saturday = shiftDate(monday, 5)
  await report(human, project.id, monday, 'Monday shipped the parser.')
  // The day's activity: the post, moved to that Monday.
  inDatabase((db) =>
    db
      .prepare('update activity set "createdAt" = ? where project_id = ? and text like ?')
      .run(new Date(`${monday}T12:00:00`).toISOString(), project.id, 'posted the daily report%'),
  )

  // The calendar asks for the whole month on show.
  const thisMonth = page.waitForResponse((r) =>
    r.url().includes(`/api/projects/${project.id}/reports?from=${first}&to=${monthEnd(first)}`),
  )
  await page.goto(`/projects/${project.id}/daily`)
  await thisMonth
  const calendar = calendarOf(page)
  await expect(calendar.getByRole('grid')).toBeVisible()
  // Today has no report yet: upcoming or missing on a workday, off on a weekend.
  await expect(
    calendar.getByRole('button', { name: new RegExp(`^${named(today)}: (upcoming|missing|off)$`) }),
  ).toHaveCount(1)

  const previous = page.waitForResponse((r) =>
    r.url().includes(`/api/projects/${project.id}/reports?from=${lastMonth}&to=${lastMonthEnd}`),
  )
  await calendar.getByRole('button', { name: 'Go to the Previous Month' }).click()
  await previous
  await expect(dayButton(page, monday, 'done')).toBeVisible()
  await expect(dayButton(page, tuesday, 'missing')).toBeVisible()
  await expect(dayButton(page, saturday, 'off')).toBeVisible()
  await expect(dayButton(page, shiftDate(saturday, 1), 'off')).toBeVisible()
  // Every weekday of last month but that Monday is missing.
  let weekdays = 0
  for (let d = lastMonth; d <= lastMonthEnd; d = shiftDate(d, 1)) if (isoWeekday(d) <= 5) weekdays++
  await expect(calendar).toContainText(`1 done · ${weekdays - 1} missing`)

  // A day opens on the page: its report, and its activity.
  const card = page.getByRole('region', { name: 'Report', exact: true })
  const day = page.waitForResponse((r) => r.url().includes(`/api/daily?date=${monday}`))
  await dayButton(page, monday, 'done').click()
  await day
  await expect(card).toContainText('Monday shipped the parser.')
  await expect(page.getByRole('region', { name: 'Activity' })).toContainText('1 action')

  // The nearest missing period after the one on show is the Tuesday after it.
  await calendar.getByRole('button', { name: 'Next missing' }).click()
  await expect(card).toContainText(`No report for ${periodLabel('daily', tuesday)} yet.`)
})

test('the jump to a missing report is off while nothing is missing', async ({ page, human }) => {
  const p = await seedProject(human, `nothing missing ${Date.now()}`)
  await ok(
    human.patch(`/api/projects/${p.id}/report-settings`, {
      data: { cadence: 'daily', shiftStart: '00:00', shiftEnd: '23:59', workdays: [1, 2, 3, 4, 5, 6, 7] },
    }),
  )
  await page.goto(`/projects/${p.id}/daily`)
  const calendar = calendarOf(page)
  await expect(dayButton(page, today, 'upcoming')).toBeVisible()
  await expect(calendar).toContainText('0 done · 0 missing')
  await expect(calendar.getByRole('button', { name: 'Next missing' })).toBeDisabled()
})

test('a whole month is listed, the days to come upcoming or off', async ({ project, human }) => {
  await ok(human.patch(`/api/projects/${project.id}/report-settings`, { data: { cadence: 'daily' } }))
  trackSince(project.id, lastMonth)
  const last = monthEnd(first)
  const list = await ok<ReportList>(human.get(`/api/projects/${project.id}/reports?from=${first}&to=${last}`))
  const days: string[] = []
  for (let d = last; d >= first; d = shiftDate(d, -1)) days.push(d)
  expect(list.periods.map((p) => p.period)).toEqual(days)
  for (const p of list.periods.filter((x) => x.period > today))
    expect(p.status, p.period).toBe(isoWeekday(p.period) <= 5 ? 'upcoming' : 'off')
  for (const p of list.periods.filter((x) => x.period < today))
    expect(p.status, p.period).toBe(isoWeekday(p.period) <= 5 ? 'missing' : 'off')
})

test('a weekly report marks its whole week', async ({ page, project, human }) => {
  await ok(
    human.patch(`/api/projects/${project.id}/report-settings`, {
      data: { cadence: 'weekly', weekday: 5 },
    }),
  )
  trackSince(project.id, shiftDate(monday, -7))
  await report(human, project.id, shiftDate(monday, 2), 'The week of the parser.')

  await page.goto(`/projects/${project.id}/daily`)
  await calendarOf(page).getByRole('button', { name: 'Go to the Previous Month' }).click()
  for (let i = 0; i < 7; i++) await expect(dayButton(page, shiftDate(monday, i), 'done')).toBeVisible()
  // The week after had its Friday pass without a report.
  for (let i = 7; i < 14; i++) await expect(dayButton(page, shiftDate(monday, i), 'missing')).toBeVisible()
  // Clicking any day of the week opens the week's report.
  await dayButton(page, shiftDate(monday, 4), 'done').click()
  await expect(page.getByRole('region', { name: 'Report', exact: true })).toContainText(
    'The week of the parser.',
  )
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('the calendar fits, a tap opens a day, and its marks show in light and dark', async ({
    page,
    project,
    human,
  }) => {
    await ok(human.patch(`/api/projects/${project.id}/report-settings`, { data: { cadence: 'daily' } }))
    trackSince(project.id, lastMonth)
    await report(human, project.id, monday, 'Monday shipped the parser.')
    await page.goto(`/projects/${project.id}/daily`)
    const calendar = calendarOf(page)
    await calendar.getByRole('button', { name: 'Go to the Previous Month' }).tap()
    await dayButton(page, monday, 'done').tap()
    await expect(page.getByRole('region', { name: 'Report', exact: true })).toContainText(
      'Monday shipped the parser.',
    )
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
    ).toBe(false)

    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      if (colorScheme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/)
      else await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
      const colors = await calendar.evaluate((el) => {
        const bg = (sel: string) => getComputedStyle(el.querySelector(sel)!).backgroundColor
        return {
          done: bg('i[data-status="done"]'),
          missing: bg('i[data-status="missing"]'),
          page: getComputedStyle(document.body).backgroundColor,
        }
      })
      expect(colors.done, colorScheme).not.toBe(colors.page)
      expect(colors.missing, colorScheme).not.toBe(colors.page)
      expect(colors.done, colorScheme).not.toBe(colors.missing)
      await calendar.screenshot({ path: test.info().outputPath(`report-calendar-${colorScheme}.png`) })
    }
  })
})
