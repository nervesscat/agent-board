import type { Page } from '@playwright/test'

import { localDate } from '#/lib/format'
import { inDatabase } from './db'
import { expect, test } from './fixtures'

const scrollsSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)

/**
 * The project's day, made known: only these three lines, two in the 10 o'clock hour and one in the
 * 11 o'clock hour (local time, as the Daily page groups them), by the human and an agent.
 */
function seedDay(projectId: number) {
  const today = localDate()
  const at = (time: string) => new Date(`${today}T${time}:00`).toISOString()
  inDatabase((db) => {
    db.prepare('delete from activity where project_id = ?').run(projectId)
    const add = db.prepare(
      'insert into activity (project_id, actor, kind, text, "createdAt") values (?, ?, ?, ?, ?)',
    )
    add.run(projectId, 'enrique', 'ticket', 'created ticket #1 Parser', at('10:05'))
    add.run(projectId, 'enrique', 'ticket', 'moved ticket #1 Parser to In progress', at('10:40'))
    add.run(projectId, 'claude', 'comment', 'commented on ticket #1 Parser', at('11:15'))
  })
}

const activityOf = (page: Page) => page.getByRole('region', { name: 'Activity' })
const hour = (page: Page, h: string) => activityOf(page).getByRole('button', { name: new RegExp(`^${h}`) })

test('every hour starts closed under the day’s counts; each opens on its own, by click and by key', async ({
  page,
  project,
}) => {
  seedDay(project.id)
  await page.goto(`/projects/${project.id}/daily`)
  const activity = activityOf(page)

  // The counts stay on top: how many, of each kind, by whom.
  await expect(activity).toContainText('3 actions')
  await expect(activity.getByText('2 tickets', { exact: true })).toBeVisible()
  await expect(activity.getByText('1 comments', { exact: true })).toBeVisible()
  await expect(activity.getByText(/^by (enrique, claude|claude, enrique)$/)).toBeVisible()

  // Closed on the first visit: the hours show, their lines do not.
  await expect(hour(page, '10:00')).toHaveAttribute('aria-expanded', 'false')
  await expect(hour(page, '11:00')).toHaveAttribute('aria-expanded', 'false')
  await expect(hour(page, '10:00')).toContainText('2 actions')
  await expect(hour(page, '11:00')).toContainText('1 action')
  await expect(activity.getByText('created ticket #1 Parser')).toBeHidden()
  await expect(activity.getByText('commented on ticket #1 Parser')).toBeHidden()

  // A click opens one hour and leaves the other closed.
  await hour(page, '10:00').click()
  await expect(hour(page, '10:00')).toHaveAttribute('aria-expanded', 'true')
  await expect(activity.getByText('created ticket #1 Parser')).toBeVisible()
  await expect(activity.getByText('moved ticket #1 Parser to In progress')).toBeVisible()
  await expect(hour(page, '11:00')).toHaveAttribute('aria-expanded', 'false')
  await expect(activity.getByText('commented on ticket #1 Parser')).toBeHidden()

  // The keyboard: Enter closes the focused hour, Space opens another.
  await hour(page, '10:00').focus()
  await page.keyboard.press('Enter')
  await expect(hour(page, '10:00')).toHaveAttribute('aria-expanded', 'false')
  await expect(activity.getByText('created ticket #1 Parser')).toBeHidden()
  await hour(page, '11:00').focus()
  await page.keyboard.press('Space')
  await expect(hour(page, '11:00')).toHaveAttribute('aria-expanded', 'true')
  await expect(activity.getByText('commented on ticket #1 Parser')).toBeVisible()
  await expect(hour(page, '10:00')).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('Enter')
  await expect(hour(page, '11:00')).toHaveAttribute('aria-expanded', 'false')

  // Open all, then close all.
  const triggers = activity.getByRole('button', { name: /^\d\d:00/ })
  await expect(triggers).toHaveCount(2)
  await activity.getByRole('button', { name: 'Open all' }).click()
  for (const t of await triggers.all()) await expect(t).toHaveAttribute('aria-expanded', 'true')
  await expect(activity.getByText('commented on ticket #1 Parser')).toBeVisible()
  await expect(activity.getByRole('button', { name: 'Open all' })).toBeDisabled()
  await activity.getByRole('button', { name: 'Close all' }).click()
  for (const t of await triggers.all()) await expect(t).toHaveAttribute('aria-expanded', 'false')
  await expect(activity.getByText('created ticket #1 Parser')).toBeHidden()
  await expect(activity.getByRole('button', { name: 'Close all' })).toBeDisabled()
})

test('this browser remembers the open hours of the day across a reload', async ({ page, project }) => {
  seedDay(project.id)
  await page.goto(`/projects/${project.id}/daily`)
  await hour(page, '10:00').click()
  await expect(activityOf(page).getByText('created ticket #1 Parser')).toBeVisible()

  await page.reload()
  await expect(hour(page, '10:00')).toHaveAttribute('aria-expanded', 'true')
  await expect(activityOf(page).getByText('created ticket #1 Parser')).toBeVisible()
  await expect(hour(page, '11:00')).toHaveAttribute('aria-expanded', 'false')
})

test('the page and the hours work when the browser refuses storage', async ({ page, project }) => {
  seedDay(project.id)
  // Every use of localStorage throws, as in a browser that blocks the site's data.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      },
    })
  })
  const errors: Error[] = []
  page.on('pageerror', (e) => errors.push(e))
  await page.goto(`/projects/${project.id}/daily`)
  expect(
    await page.evaluate(() => {
      try {
        return Boolean(window.localStorage)
      } catch {
        return 'throws'
      }
    }),
  ).toBe('throws')

  await expect(hour(page, '10:00')).toHaveAttribute('aria-expanded', 'false')
  await hour(page, '10:00').click()
  await expect(activityOf(page).getByText('created ticket #1 Parser')).toBeVisible()
  await activityOf(page).getByRole('button', { name: 'Open all' }).click()
  await expect(activityOf(page).getByText('commented on ticket #1 Parser')).toBeVisible()
  await activityOf(page).getByRole('button', { name: 'Close all' }).click()
  await expect(activityOf(page).getByText('created ticket #1 Parser')).toBeHidden()

  // Nothing kept, nothing broken: after a reload the hours are closed again.
  await page.reload()
  await expect(hour(page, '10:00')).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('region', { name: 'Report', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('the all-projects Daily page has the same closed hours, each line tagged with its project', async ({
  page,
  project,
}) => {
  seedDay(project.id)
  await page.goto('/daily')
  const activity = activityOf(page)
  await expect(activity).toBeVisible()
  const triggers = activity.getByRole('button', { name: /^\d\d:00/ })
  await expect(triggers.first()).toBeVisible()
  for (const t of await triggers.all()) await expect(t).toHaveAttribute('aria-expanded', 'false')
  const line = activity.locator('li', { hasText: 'created ticket #1 Parser' }).filter({
    hasText: `[${project.name}]`,
  })
  await expect(line).toBeHidden()

  await hour(page, '10:00').click()
  await expect(line).toBeVisible()
  await expect(line.getByText(`[${project.name}]`, { exact: true })).toBeVisible()
})

test.describe('at 390px with touch, light and dark', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('the hours open by a tap, fit the screen and read in both themes', async ({ page, project }) => {
    seedDay(project.id)
    for (const url of [`/projects/${project.id}/daily`, '/daily']) {
      await page.goto(url)
      const activity = activityOf(page)
      await hour(page, '10:00').tap()
      await expect(activity.getByText('created ticket #1 Parser').first()).toBeVisible()
      await hour(page, '11:00').tap()
      await expect(activity.getByText('commented on ticket #1 Parser').first()).toBeVisible()

      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        if (colorScheme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/)
        expect(await scrollsSideways(page), `${url} ${colorScheme}`).toBe(false)
        // The hour, its count and a line stand out from what they sit on.
        for (const el of [
          hour(page, '10:00').locator('span').first(),
          hour(page, '10:00').locator('span').nth(1),
          activity.getByText('created ticket #1 Parser').first(),
        ]) {
          const [color, back] = await el.evaluate((e) => {
            let bg = 'rgba(0, 0, 0, 0)'
            for (
              let n: Element | null = e;
              n && /rgba\(0, 0, 0, 0\)|transparent/.test(bg);
              n = n.parentElement
            )
              bg = getComputedStyle(n).backgroundColor
            return [getComputedStyle(e).color, bg]
          })
          expect(color, `${url} ${colorScheme}`).not.toBe(back)
        }
        await activity.screenshot({
          path: test.info().outputPath(`activity-${url === '/daily' ? 'all' : 'project'}-${colorScheme}.png`),
        })
      }
      await page.emulateMedia({ colorScheme: 'light' })
    }
  })
})
