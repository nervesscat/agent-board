import type { Locator, Page } from '@playwright/test'

import {
  named,
  pushedPill,
  reminder,
  scrollsSideways,
  seedDailyPage,
  standsOut,
  today,
  yesterday,
} from './dailyPage'
import { expect, test } from './fixtures'

/*
 * The Daily pages in the dark theme, every part of them at once: each is screenshotted into the
 * test's output, and its text and status marks are checked against what they sit on, by contrast
 * (WCAG: 4.5 for text, 3 for a mark that says something; the marks of upcoming and off days are
 * meant to be quiet, and only have to show).
 */

test.use({ colorScheme: 'dark' })

const TEXT = 4.5
const MARK = 3
const QUIET = 1.5

const dark = (page: Page) => expect(page.locator('html')).toHaveClass(/\bdark\b/)
/** The top bar stays at the top in a screenshot, not over the part of the page shot. */
const UNSTICK = 'body header { position: static !important }'

/** A screenshot of the page, or of a part of it, into the test's output. */
const shot = (el: Locator | Page, name: string, fullPage = false) =>
  el.screenshot({
    path: test.info().outputPath(`${name}.png`),
    animations: 'disabled',
    style: UNSTICK,
    ...(fullPage && { fullPage }),
  })

test("a project's Daily page in the dark: banner, header, notice, report, calendar, settings and activity", async ({
  page,
  human,
  agent,
}, info) => {
  test.setTimeout(90_000)
  // The agent's prompt makes the stand-in claude take a few seconds, so the page shows it writing.
  const { project, due, ticket, quiet } = await seedDailyPage(
    human,
    agent,
    `Dark daily ${info.workerIndex}.${info.repeatEachIndex}`,
    { agentPrompt: 'What shipped, two lines a section. [fake-claude: slow 4000]' },
  )
  try {
    await page.goto(`/projects/${project.id}/daily`)
    await dark(page)

    // The banner: the project whose report is due, its words and its clock.
    const banner = page.getByRole('region', { name: 'Reports due' })
    await expect(reminder(page, due)).toContainText(/report due in \d+ min/)
    await standsOut(reminder(page, due), TEXT)
    await standsOut(banner.locator('li').filter({ hasText: due.name }).locator('svg'), MARK)
    // Notify me, or how the browser answered (a headless one says blocked).
    await standsOut(banner.getByText(/Notify me|Notifications (on|blocked) in this browser/), TEXT)
    await shot(banner, 'banner-dark')

    // The header: the green pill (its dot and its words) and today's shift.
    const pill = pushedPill(page)
    await expect(pill).toHaveAttribute('data-pushed', 'yes')
    await expect(pill).toContainText('1 commit')
    await standsOut(pill, TEXT)
    await standsOut(pill.locator('[data-part="dot"]'), MARK, 'backgroundColor')
    const shift = page.getByRole('img', { name: /^Shift / })
    await expect(shift).toHaveAccessibleName(/: on shift$/)
    await standsOut(shift.locator('[data-part="shift"]'), MARK, 'stroke')
    await standsOut(shift.locator('[data-part="now"]'), MARK, 'stroke')
    await standsOut(shift.locator('span'), TEXT)
    await shot(page.getByRole('heading', { name: 'Daily', level: 1 }).locator('xpath=../..'), 'header-dark')
    await pill.click()
    const byRepo = page.getByRole('list', { name: 'Pushed today by repo' })
    await expect(byRepo).toContainText(ticket.title)
    await standsOut(byRepo.getByRole('link', { name: ticket.title }), TEXT)
    await standsOut(byRepo.getByText('+1', { exact: true }).first(), TEXT)
    await shot(page.locator('[data-slot="popover-content"]'), 'pushed-today-popover-dark')
    await page.keyboard.press('Escape')
    await expect(byRepo).toBeHidden()

    // The agent's change of the prompt, and what it changed.
    const notice = page.getByRole('region', { name: 'Changes by agents to review' })
    await expect(notice).toContainText('changed by claude')
    await standsOut(notice.getByText(/^The report prompt was changed by/), TEXT)
    await standsOut(notice.locator('svg').first(), MARK)
    await notice.getByRole('button', { name: 'Show the change' }).click()
    const diff = notice.getByRole('group', { name: 'What changed in the report prompt' })
    await expect(diff).toContainText('[fake-claude: slow 4000]')
    for (const line of [diff.getByText('What shipped today, for the team.'), diff.getByText(/slow 4000/)])
      await standsOut(line.first(), TEXT)
    await shot(notice, 'settings-change-notice-dark')

    // The report: rendered, its versions, the earlier one, and claude writing a new one.
    const card = page.getByRole('region', { name: 'Report', exact: true })
    await expect(card).toContainText('2 versions')
    await standsOut(card.getByRole('heading', { name: 'Done' }), TEXT)
    await standsOut(card.getByRole('listitem').filter({ hasText: 'Ship it' }), TEXT)
    await standsOut(card.getByText('done', { exact: true }), TEXT)
    await card.getByRole('button', { name: 'show 1 earlier version' }).click()
    await expect(card.getByRole('list', { name: 'Earlier versions' })).toContainText('first pass')
    await shot(card, 'report-card-dark')
    await card.getByRole('button', { name: 'Generate with claude' }).click()
    const writing = card.getByRole('button', { name: 'claude is writing…' })
    await expect(writing).toBeDisabled()
    await standsOut(writing, MARK)
    await shot(card, 'report-card-generating-dark')
    await expect(card).toContainText('3 versions', { timeout: 30_000 })
    await expect(card).toContainText('written from a prompt of')

    // The calendar: today and yesterday done, the days before missing, each mark and number visible.
    const calendar = page.getByRole('region', { name: 'Report calendar' })
    const day = (d: string, status: string) =>
      calendar.getByRole('button', { name: `${named(d)}: ${status}`, exact: true })
    await expect(day(today, 'done')).toBeVisible()
    await standsOut(day(today, 'done'), TEXT)
    await standsOut(day(today, 'done').locator('[data-status]'), MARK, 'backgroundColor')
    if (yesterday.slice(0, 7) === today.slice(0, 7)) {
      await standsOut(day(yesterday, 'done'), TEXT)
      await standsOut(day(yesterday, 'done').locator('[data-status]'), MARK, 'backgroundColor')
    }
    // On the 1st and the 2nd this month has no missing day yet: last month's are.
    if (!(await calendar.locator('[data-status="missing"]').count()))
      await calendar.getByRole('button', { name: 'Go to the Previous Month' }).click()
    const missing = calendar.getByRole('button', { name: /: missing$/ }).first()
    await expect(missing).toBeVisible()
    await standsOut(missing, TEXT)
    await standsOut(missing.locator('[data-status]'), MARK, 'backgroundColor')
    for (const s of ['upcoming', 'off']) {
      const mark = calendar.locator(`[data-status="${s}"]`).first()
      if (await mark.count()) await standsOut(mark, QUIET, s === 'off' ? 'borderTopColor' : 'backgroundColor')
    }
    await standsOut(calendar.getByText(/\d+ done · \d+ missing/), TEXT)
    await shot(calendar, 'report-calendar-dark')

    // The settings: the prompt, the template and the shift's two clocks.
    const settings = page.getByRole('region', { name: 'Report settings' })
    await settings.getByRole('button', { name: /^Report settings/ }).click()
    await expect(settings.getByRole('group', { name: 'Template' })).toBeVisible()
    for (const name of ['Shift start', 'Shift end']) {
      const clock = settings.getByRole('slider', { name })
      await expect(clock).toBeVisible()
      // The hand and the numbers on the face (a muted surface, like a card on the page).
      const face = '[data-part="face"]'
      await standsOut(clock.locator('[data-part="hand"]'), MARK, 'stroke', face)
      await standsOut(clock.locator('[data-part="mark"].fill-foreground').first(), TEXT, 'fill', face)
    }
    await standsOut(settings.getByText('Workdays', { exact: true }), TEXT)
    await shot(settings, 'report-settings-dark')

    // The day's activity, hour by hour, opened.
    const activity = page.getByRole('region', { name: 'Activity' })
    await activity.getByRole('button', { name: 'Open all' }).click()
    const line = activity.getByText('posted the daily report').first()
    await expect(line).toBeVisible()
    await standsOut(line, TEXT)
    await standsOut(
      activity
        .getByRole('button', { name: /^\d\d:00/ })
        .first()
        .locator('span')
        .first(),
      TEXT,
    )
    await shot(activity, 'activity-dark')

    expect(await scrollsSideways(page)).toBe(false)
    await shot(page, 'daily-project-dark')
    await shot(page, 'daily-project-dark-full', true)
  } finally {
    await quiet()
  }
})

test("every project's Daily page in the dark: the reports and the activity", async ({
  page,
  human,
  agent,
}, info) => {
  const { project, due, quiet } = await seedDailyPage(
    human,
    agent,
    `Dark all daily ${info.workerIndex}.${info.repeatEachIndex}`,
  )
  try {
    await page.goto('/daily')
    await dark(page)
    await expect(reminder(page, due)).toBeVisible()
    const reports = page.getByRole('region', { name: 'Reports', exact: true })
    const card = reports.getByRole('article', { name: project.name, exact: true })
    await expect(card).toContainText('Ship it')
    await standsOut(card.getByRole('link', { name: project.name }), TEXT)
    await standsOut(card.getByText('done', { exact: true }), TEXT)
    await standsOut(card.getByRole('heading', { name: 'Done' }), TEXT)
    await shot(card, 'all-projects-report-dark')
    // A project still without its report says so, in its status' colour.
    const other = reports.getByRole('article', { name: due.name, exact: true })
    await expect(other).toContainText(`No report for`)
    await standsOut(other.getByText(/^(upcoming|missing)$/), TEXT)

    const activity = page.getByRole('region', { name: 'Activity' })
    await activity.getByRole('button', { name: 'Open all' }).click()
    const tag = activity.getByText(`[${project.name}]`).first()
    await expect(tag).toBeVisible()
    await standsOut(tag, TEXT)
    expect(await scrollsSideways(page)).toBe(false)
    await shot(page, 'daily-all-dark-full', true)
  } finally {
    await quiet()
  }
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test("a project's whole Daily page fits 390px in the dark", async ({ page, human, agent }, info) => {
    const { project, due, quiet } = await seedDailyPage(
      human,
      agent,
      `Dark phone daily ${info.workerIndex}.${info.repeatEachIndex}`,
    )
    try {
      await page.goto(`/projects/${project.id}/daily`)
      await dark(page)
      await expect(reminder(page, due)).toBeVisible()
      await expect(pushedPill(page)).toHaveAttribute('data-pushed', 'yes')
      await page.getByRole('region', { name: 'Activity' }).getByRole('button', { name: 'Open all' }).tap()
      const settings = page.getByRole('region', { name: 'Report settings' })
      await settings.getByRole('button', { name: /^Report settings/ }).tap()
      await expect(settings.getByRole('slider', { name: 'Shift end' })).toBeVisible()
      expect(await scrollsSideways(page)).toBe(false)
      await shot(page, 'daily-project-phone-dark-full', true)
    } finally {
      await quiet()
    }
  })
})
