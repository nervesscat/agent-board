import type { APIRequestContext, Page } from '@playwright/test'

import type { FeedItem, Project } from '#/lib/api'
import { expect, ok, seedProject, test } from './fixtures'

const bellOf = (page: Page) => page.getByRole('button', { name: 'Notifications' })
const panelOf = (page: Page) => page.getByRole('dialog')

interface SeedArgs {
  severity?: 'info' | 'warning' | 'problem'
  title: string
  body?: string
  seen?: boolean
  subject?: string
}

/** Writes an alert row through the test-only route, in a project or (null) board-wide. */
const seed = (human: APIRequestContext, project: Pick<Project, 'id'> | null, args: SeedArgs) =>
  ok<{ id: number }>(
    human.post('/api/test/alerts', {
      data: { projectId: project?.id ?? null, subject: args.title, ...args },
    }),
  )

const feedOf = (human: APIRequestContext, project: Pick<Project, 'id'>) =>
  ok<FeedItem[]>(human.get(`/api/projects/${project.id}/notifications`))

const itemOf = (page: Page, title: string) => panelOf(page).getByRole('listitem').filter({ hasText: title })

test('an alert shows with its severity, a New dot, its buttons and a badge, and opening marks it seen', async ({
  page,
  project,
  human,
}) => {
  const alert = await seed(human, project, { title: 'Skills are out of date', body: 'Two skills changed.' })
  await page.goto(`/projects/${project.id}`)
  const bell = bellOf(page)
  await expect(bell).toHaveText('1', { timeout: 15_000 })
  await bell.click()

  const item = itemOf(page, 'Skills are out of date')
  await expect(item).toContainText('Two skills changed.')
  await expect(item.getByRole('img', { name: 'Warning' })).toBeVisible()
  await expect(item.getByTestId('new-dot')).toBeVisible()
  await expect(item.getByRole('link', { name: 'Open' })).toHaveAttribute('href', `/projects/${project.id}`)
  await expect(item.getByRole('button', { name: 'Copy command' })).toBeVisible()
  await expect(item.getByRole('button', { name: 'Acknowledge' })).toBeVisible()

  // Open for a moment: seen, so the dot and the badge go and the server agrees.
  await expect(item.getByTestId('new-dot')).toHaveCount(0, { timeout: 10_000 })
  await expect(bell).toHaveText('')
  const seen = (await feedOf(human, project)).find((i) => i.id === alert.id)!
  expect(seen.isNew).toBe(false)
})

test('the badge is coloured by the worst severity', async ({ page, project, human }) => {
  await seed(human, project, { title: 'Just so you know', severity: 'info' })
  await page.goto(`/projects/${project.id}`)
  const bell = bellOf(page)
  await expect(bell).toHaveText('1', { timeout: 15_000 })
  await expect(bell.locator('[data-severity]')).toHaveAttribute('data-severity', 'info')

  await seed(human, project, { title: 'Something is wrong', severity: 'problem' })
  await expect(bell).toHaveText('2', { timeout: 15_000 })
  await expect(bell.locator('[data-severity]')).toHaveAttribute('data-severity', 'problem')
  await bell.click()
  await expect(itemOf(page, 'Something is wrong').getByRole('img', { name: 'Problem' })).toBeVisible()
  await expect(itemOf(page, 'Just so you know').getByRole('img', { name: 'Info' })).toBeVisible()
})

test('a new alert raises one toast on an open page', async ({ page, project, human }) => {
  await page.goto(`/projects/${project.id}`)
  await page.waitForResponse(
    (res) => res.url().endsWith(`/api/projects/${project.id}/notifications`) && res.ok(),
  )
  await seed(human, project, { title: 'A fresh alert' })
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'A fresh alert' })
  await expect(toast).toHaveCount(1, { timeout: 15_000 })
  await page.waitForTimeout(2500)
  await expect(toast).toHaveCount(1)
})

test('an action button runs on the server and the alert goes', async ({ page, project, human }) => {
  await seed(human, project, { title: 'Needs acknowledging' })
  await page.goto(`/projects/${project.id}`)
  await bellOf(page).click()
  const item = itemOf(page, 'Needs acknowledging')
  await item.getByRole('button', { name: 'Acknowledge' }).click()
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Acknowledged' })).toBeVisible()
  await expect(item).toHaveCount(0)
  expect((await feedOf(human, project)).some((i) => i.title === 'Needs acknowledging')).toBe(false)
})

test('dismiss and snooze hide an alert, and a snooze offers hours and days', async ({
  page,
  project,
  human,
}) => {
  await seed(human, project, { title: 'Dismiss me' })
  await seed(human, project, { title: 'Snooze me' })
  await page.goto(`/projects/${project.id}`)
  await bellOf(page).click()

  await itemOf(page, 'Dismiss me').getByRole('button', { name: 'Dismiss Dismiss me' }).click()
  await expect(itemOf(page, 'Dismiss me')).toHaveCount(0)

  const snooze = itemOf(page, 'Snooze me')
  await snooze.getByRole('button', { name: 'Snooze', exact: true }).click()
  const menu = snooze.getByRole('group', { name: 'Snooze for' })
  await expect(menu.getByRole('button')).toHaveText(['1 hour', '1 day', '7 days'])
  await menu.getByRole('button', { name: '1 day' }).click()
  await expect(itemOf(page, 'Snooze me')).toHaveCount(0)
  await expect(panelOf(page)).toContainText('Nothing running')
  const titles = (await feedOf(human, project)).map((i) => i.title)
  expect(titles).not.toContain('Dismiss me')
  expect(titles).not.toContain('Snooze me')
})

// A board-wide alert would show in every test's project at once, so that scope is tested on the server.
test('a project alert shows in its own project only', async ({ page, project, human }) => {
  const other = await seedProject(human, 'Elsewhere')
  await seed(human, project, { title: 'Only here' })

  await page.goto(`/projects/${project.id}`)
  await bellOf(page).click()
  await expect(itemOf(page, 'Only here')).toBeVisible({ timeout: 15_000 })

  await page.goto(`/projects/${other.id}`)
  await expect(bellOf(page)).toBeVisible()
  await bellOf(page).click()
  await expect(panelOf(page)).toContainText('Nothing running')
})

test('muting a kind from the panel hides it here, and the project settings switch brings it back', async ({
  page,
  project,
  human,
}) => {
  await seed(human, project, { title: 'Noisy alert' })
  await page.goto(`/projects/${project.id}`)
  await bellOf(page).click()
  await itemOf(page, 'Noisy alert').getByRole('button', { name: 'Mute this kind in this project' }).click()
  await expect(itemOf(page, 'Noisy alert')).toHaveCount(0)
  await page.keyboard.press('Escape')

  await page.goto(`/settings?tab=project&project=${project.id}`)
  const section = page.locator('#notifications')
  await expect(section.getByRole('heading', { name: 'Notifications' })).toBeVisible()
  const types = section.getByRole('group', { name: 'Work' })
  const toggle = types.getByRole('switch', { name: 'Show Test alert' })
  await expect(toggle).not.toBeChecked()
  // The groups nothing fills yet say so.
  await expect(section.getByRole('group', { name: 'Setup and versions' })).toContainText('No alerts yet')
  await expect(section.getByRole('group', { name: 'Housekeeping' })).toContainText('No alerts yet')

  await toggle.click()
  await expect(toggle).toBeChecked()
  await expect
    .poll(async () => (await feedOf(human, project)).some((i) => i.title === 'Noisy alert'))
    .toBe(true)
})

test('the project settings switch mutes a kind', async ({ page, project, human }) => {
  await seed(human, project, { title: 'Muted from settings' })
  await page.goto(`/settings?tab=project&project=${project.id}`)
  const toggle = page.locator('#notifications').getByRole('switch', { name: 'Show Test alert' })
  await expect(toggle).toBeChecked()
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await expect
    .poll(async () => (await feedOf(human, project)).some((i) => i.title === 'Muted from settings'))
    .toBe(false)
})

test('at 390 px the panel with several alerts stays inside the viewport and scrolls', async ({
  page,
  project,
  human,
}) => {
  for (let i = 0; i < 8; i++)
    await seed(human, project, { title: `Alert number ${i}`, body: 'x '.repeat(60) })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/projects/${project.id}`)
  await bellOf(page).click()
  const panel = panelOf(page)
  await expect(itemOf(page, 'Alert number 0')).toBeVisible({ timeout: 15_000 })
  const box = (await panel.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  expect(box.y + box.height).toBeLessThanOrEqual(844 + 1)
  // More than a handful: grouped under a heading.
  await expect(panel).toContainText('Work')
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
  ).toBe(false)
  const list = panel.locator('ul')
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
})
