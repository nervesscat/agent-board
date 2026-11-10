import type { APIRequestContext, Page } from '@playwright/test'

import type { Project, ReportDueList } from '#/lib/api'
import { expect, ok, test } from './fixtures'

/*
 * The board works out whether a report is due with its own clock, so these tests set the project's
 * shift around the real time now: ending in a few minutes (due), or a few minutes ago (missing). The
 * browser's Notification is a stand-in that counts in sessionStorage (it lasts across reloads).
 */

const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

/**
 * Both shifts must sit inside today, the end a few minutes either side of now: a few minutes before
 * and after midnight that cannot be, so the test waits those out (and is given the time to).
 */
async function awayFromMidnight() {
  const now = new Date()
  const minutes = now.getHours() * 60 + now.getMinutes()
  if (minutes >= 3 && minutes < 23 * 60 + 50) return
  const until = new Date(now)
  if (minutes >= 3) until.setDate(until.getDate() + 1)
  until.setHours(0, 4, 0, 0)
  const wait = until.getTime() - now.getTime()
  test.setTimeout(test.info().timeout + wait)
  await new Promise((r) => setTimeout(r, wait))
}

/** A daily report every day from midnight, its shift ending 10 minutes from now or 2 minutes ago. */
async function remind(human: APIRequestContext, project: Project, state: 'due' | 'missing') {
  await awayFromMidnight()
  const end = new Date(Date.now() + (state === 'due' ? 10 : -2) * 60_000)
  await ok(
    human.patch(`/api/projects/${project.id}/report-settings`, {
      data: {
        cadence: 'daily',
        shiftStart: '00:00',
        shiftEnd: hhmm(end),
        workdays: [1, 2, 3, 4, 5, 6, 7],
        alertMinutes: 720,
      },
    }),
  )
  const due = await ok<ReportDueList>(human.get('/api/report-due'))
  expect(due.items.find((d) => d.projectId === project.id)).toMatchObject({ state })
}

/** Reports off again, so no other test's page carries this project's reminder. */
const quiet = (human: APIRequestContext, project: Project) =>
  ok(human.patch(`/api/projects/${project.id}/report-settings`, { data: { cadence: 'off' } }))

const banner = (page: Page) => page.getByRole('region', { name: 'Reports due' })
const reminder = (page: Page, project: Project) => banner(page).getByRole('link', { name: project.name })

test('a report due soon shows on every page, links to the Daily page, and goes once it is posted', async ({
  page,
  project,
  human,
  api,
}) => {
  const t = await api.ticket({ title: 'A ticket to look at the banner from' })
  await remind(human, project, 'due')
  try {
    for (const url of [
      '/',
      `/projects/${project.id}`,
      `/projects/${project.id}/features/${t.id}`,
      '/settings',
    ]) {
      await page.goto(url)
      await expect(reminder(page, project), url).toBeVisible()
      await expect(reminder(page, project), url).toContainText(/report due in \d+ min/)
    }
    await reminder(page, project).click()
    await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/daily$`))

    // Today's shift, beside the day: read-only, with now on it.
    const shift = page.getByRole('img', { name: /^Shift / })
    await expect(shift).toHaveAccessibleName(
      /^Shift 12:00 AM–\d{1,2}:\d{2} [AP]M, now \d{1,2}:\d{2} [AP]M: on shift$/,
    )
    await expect(shift.locator('[data-part="now"]')).toHaveCount(1)
    await expect(shift.getByRole('slider')).toHaveCount(0)
    await expect(shift.locator('input')).toHaveCount(0)

    await ok(human.post(`/api/projects/${project.id}/reports`, { data: { body: 'Done for today.' } }))
    await page.reload()
    await expect(page.getByRole('region', { name: 'Report', exact: true })).toContainText('Done for today.')
    await expect(reminder(page, project)).toHaveCount(0)
    expect(
      (await ok<ReportDueList>(human.get('/api/report-due'))).items.map((d) => d.projectId),
    ).not.toContain(project.id)
  } finally {
    await quiet(human, project)
  }
})

test('after the shift ended without a report the banner says it is missing', async ({
  page,
  project,
  human,
}) => {
  await remind(human, project, 'missing')
  try {
    await page.goto('/')
    await expect(reminder(page, project)).toContainText('report missing, the shift ended at')
    await expect(reminder(page, project)).not.toContainText('due in')
  } finally {
    await quiet(human, project)
  }
})

test('notifications are asked for only from Notify me, and come once per project and period', async ({
  page,
  project,
  human,
}) => {
  await page.addInitScript(() => {
    const s = sessionStorage
    const count = (key: string) => s.setItem(key, String(Number(s.getItem(key) ?? 0) + 1))
    class FakeNotification {
      onclick: (() => void) | null = null
      static get permission() {
        return s.getItem('e2e-permission') ?? 'default'
      }
      static requestPermission() {
        count('e2e-asked')
        s.setItem('e2e-permission', 'granted')
        return Promise.resolve('granted')
      }
      constructor(title: string) {
        s.setItem('e2e-shown', JSON.stringify([...JSON.parse(s.getItem('e2e-shown') ?? '[]'), title]))
      }
    }
    Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true })
  })
  const asked = () => page.evaluate(() => Number(sessionStorage.getItem('e2e-asked') ?? 0))
  const shown = () =>
    page.evaluate(
      (name) =>
        (JSON.parse(sessionStorage.getItem('e2e-shown') ?? '[]') as string[]).filter((t) =>
          t.startsWith(`${name}:`),
        ),
      project.name,
    )

  await remind(human, project, 'due')
  try {
    // Pages load, the reminder shows: nobody is asked anything.
    for (const url of ['/', `/projects/${project.id}/daily`]) {
      await page.goto(url)
      await expect(reminder(page, project)).toBeVisible()
    }
    expect(await asked()).toBe(0)
    expect(await shown()).toEqual([])

    await banner(page).getByRole('button', { name: 'Notify me' }).click()
    await expect(banner(page)).toContainText('Notifications on in this browser')
    expect(await asked()).toBe(1)
    await expect.poll(shown).toEqual([`${project.name}: report due`])

    // Not again for the same period: after a reload, on another page.
    await page.reload()
    await expect(reminder(page, project)).toBeVisible()
    await page.goto(`/projects/${project.id}`)
    await expect(reminder(page, project)).toBeVisible()
    await page.waitForTimeout(500)
    expect(await shown()).toEqual([`${project.name}: report due`])
    expect(await asked()).toBe(1)
  } finally {
    await quiet(human, project)
  }
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('the banner fits a ticket page, answers a tap, and reads in light and dark', async ({
    page,
    project,
    human,
    api,
  }) => {
    const t = await api.ticket({ title: 'A ticket to look at the banner from' })
    await remind(human, project, 'missing')
    try {
      await page.goto(`/projects/${project.id}/features/${t.id}`)
      await expect(reminder(page, project)).toBeVisible()
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        ),
      ).toBe(false)

      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        if (colorScheme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/)
        else await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
        const colors = await banner(page).evaluate((el) => ({
          text: getComputedStyle(el).color,
          background: getComputedStyle(el).backgroundColor,
          page: getComputedStyle(document.body).backgroundColor,
        }))
        expect(colors.text, colorScheme).not.toBe(colors.background)
        await banner(page).screenshot({ path: test.info().outputPath(`report-alert-${colorScheme}.png`) })
      }

      await reminder(page, project).tap()
      await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/daily$`))
      // The shift clock sits in the Daily page's header without widening it.
      await expect(page.getByRole('img', { name: /^Shift / })).toBeVisible()
      await page
        .getByRole('img', { name: /^Shift / })
        .screenshot({ path: test.info().outputPath('shift-clock-dark.png') })
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        ),
      ).toBe(false)
    } finally {
      await quiet(human, project)
    }
  })
})
