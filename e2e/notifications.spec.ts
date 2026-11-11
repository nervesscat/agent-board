import type { APIRequestContext, Page } from '@playwright/test'

import type { JobState, Project } from '#/lib/api'
import { expect, ok, seedProject, test } from './fixtures'

const bellOf = (page: Page) => page.getByRole('button', { name: 'Notifications' })
const panelOf = (page: Page) => page.getByRole('dialog')

/** Starts a test-mode job through the test-only route: what the panel and the toast are watched on. */
const startJob = async (
  human: APIRequestContext,
  project: Pick<Project, 'id'>,
  opts: { steps?: number; ms?: number; fail?: boolean } = {},
) =>
  ok<JobState>(human.post('/api/test/jobs', { data: { projectId: project.id, steps: 4, ms: 500, ...opts } }))

const jobsOf = async (human: APIRequestContext, project: Pick<Project, 'id'>) =>
  ok<JobState[]>(human.get(`/api/projects/${project.id}/jobs`))

test('the bell opens an empty panel, keeps the Pages menu reachable and returns focus on Escape', async ({
  page,
  project,
}) => {
  await page.goto(`/projects/${project.id}`)
  const bell = bellOf(page)
  await expect(bell).toBeVisible()
  await expect(bell).toHaveAttribute('aria-expanded', 'false')

  await bell.click()
  await expect(bell).toHaveAttribute('aria-expanded', 'true')
  const panel = panelOf(page)
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('Nothing running')
  await expect(panel.getByRole('progressbar')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Clear finished' })).toHaveCount(0)

  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(bell).toHaveAttribute('aria-expanded', 'false')
  await expect(bell).toBeFocused()

  // Below md the Pages menu is the way to the board's pages, beside the bell.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(bell).toBeVisible()
  await expect(page.getByRole('button', { name: 'Pages' })).toBeVisible()
})

test('a running job advances in the panel and its card ends succeeded with the summary', async ({
  page,
  project,
  human,
}) => {
  const job = await startJob(human, project, { steps: 8, ms: 800 })
  await page.goto(`/projects/${project.id}`)

  const bell = bellOf(page)
  await expect(bell).toHaveText('1')
  await bell.click()
  const panel = panelOf(page)
  const link = panel.getByRole('link', { name: job.title })
  await expect(link).toBeVisible()
  await expect(link).toHaveAttribute('href', job.href!)

  const bar = panel.getByRole('progressbar')
  await expect(bar).toHaveAttribute('aria-valuemax', '8')
  const first = Number(await bar.getAttribute('aria-valuenow'))
  await expect.poll(async () => Number(await bar.getAttribute('aria-valuenow'))).toBeGreaterThan(first)
  await expect(panel.getByText(new RegExp(`^\\d+ of ${job.total}$`))).toBeVisible()
  // The current item is announced politely while it runs.
  await expect(panel.locator('[aria-live="polite"]')).toContainText(/Step \d of 8/)

  // Tab reaches the card's link and its dismiss button.
  await link.focus()
  await page.keyboard.press('Tab')
  await expect(panel.getByRole('button', { name: `Dismiss ${job.title}` })).toBeFocused()

  // It ends on its own: the completion line is a status, with the summary and how long it took.
  const status = panel.getByRole('status')
  await expect(status).toContainText('Succeeded', { timeout: 15_000 })
  await expect(status).toContainText('Finished 8 steps')
  await expect(status).toContainText(/\d+(?:\.\d+)? s/)
  await expect(bell).toHaveText('')

  // The card links to where the job ran.
  await link.click()
  await page.waitForURL(`**/projects/${project.id}/cleanup`)
})

test('a failed job shows its reason in the destructive style, and X dismisses its card', async ({
  page,
  project,
  human,
}) => {
  const job = await startJob(human, project, { steps: 2, ms: 300, fail: true })
  await page.goto(`/projects/${project.id}`)
  const bell = bellOf(page)
  await bell.click()
  const panel = panelOf(page)
  const card = panel.getByRole('listitem').filter({ hasText: job.title })
  await expect(card.getByRole('status')).toContainText('Failed', { timeout: 15_000 })
  await expect(card.getByRole('status')).toContainText('The test job was asked to fail')
  await expect(card.getByRole('status')).toContainText(/\d+(?:\.\d+)? s/)
  await expect(card.getByRole('status')).toHaveClass(/text-destructive/)

  await card.getByRole('button', { name: `Dismiss ${job.title}` }).click()
  await expect(card).toHaveCount(0)
  await expect.poll(async () => (await jobsOf(human, project)).some((j) => j.id === job.id)).toBe(false)
})

test('Clear finished removes the finished jobs and leaves the running one', async ({
  page,
  project,
  human,
}) => {
  const finished = await startJob(human, project, { steps: 1, ms: 0 })
  await expect
    .poll(async () => (await jobsOf(human, project)).find((j) => j.id === finished.id)?.state)
    .toBe('succeeded')
  const running = await startJob(human, project, { steps: 100, ms: 1000 })

  await page.goto(`/projects/${project.id}`)
  const bell = bellOf(page)
  await bell.click()
  const panel = panelOf(page)
  await expect(panel.getByRole('listitem')).toHaveCount(2)

  // Every card's link and dismiss button are reachable by Tab.
  for (const title of [running.title, finished.title])
    await expect(panel.getByRole('link', { name: title })).toBeVisible()
  const runningLink = panel.getByRole('link', { name: running.title })
  await runningLink.focus()
  await page.keyboard.press('Tab')
  await expect(panel.getByRole('button', { name: `Dismiss ${running.title}` })).toBeFocused()

  const clear = panel.getByRole('button', { name: 'Clear finished' })
  await expect(clear).toBeVisible()
  await clear.click()
  await expect(panel.getByRole('listitem')).toHaveCount(1)
  await expect(panel.getByRole('listitem')).toContainText(running.title)
  await expect(clear).toHaveCount(0)
  await expect.poll(async () => (await jobsOf(human, project)).map((j) => j.id)).toEqual([running.id])
})

test('a job that ends while the panel is closed raises a toast', async ({ page, project, human }) => {
  const job = await startJob(human, project, { steps: 6, ms: 700 })
  await page.goto(`/projects/${project.id}`)
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: job.title })
  await expect(toast).toContainText('finished', { timeout: 15_000 })
})

test('a job started and ended between two polls raises a toast', async ({ page, project, human }) => {
  // A long job keeps the panel polling, so the quick one below is first read when it is already over.
  await startJob(human, project, { steps: 100, ms: 1000 })
  await page.goto(`/projects/${project.id}`)

  // Start the quick one right after a poll's answer arrived: the next poll is a second away, well
  // after it ended, so no poll ever sees it running.
  await page.waitForResponse((res) => res.url().endsWith(`/api/projects/${project.id}/jobs`) && res.ok())
  const quick = await startJob(human, project, { steps: 1, ms: 0 })
  await expect
    .poll(async () => (await jobsOf(human, project)).find((job) => job.id === quick.id)?.state)
    .toBe('succeeded')

  const toast = page.locator('[data-sonner-toast]').filter({ hasText: quick.title })
  await expect(toast).toContainText('finished', { timeout: 15_000 })
})

test('a job that ends while the panel is open raises no toast', async ({ page, project, human }) => {
  const job = await startJob(human, project, { steps: 4, ms: 700 })
  await page.goto(`/projects/${project.id}`)
  const bell = bellOf(page)
  await bell.click()
  const panel = panelOf(page)
  await expect(panel.getByRole('status')).toContainText('Succeeded', { timeout: 15_000 })
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: job.title })).toHaveCount(0)
})

test('at 390 px the bell fits without sideways scroll and the panel stays inside the viewport', async ({
  page,
  project,
  human,
}) => {
  for (let i = 0; i < 8; i++) await startJob(human, project, { steps: 1, ms: 0 })
  await expect
    .poll(async () => (await jobsOf(human, project)).filter((j) => j.state === 'running').length)
    .toBe(0)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/projects/${project.id}`)
  const bell = bellOf(page)
  await expect(bell).toBeVisible()
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
  ).toBe(false)
  const bellBox = (await bell.boundingBox())!
  expect(bellBox.x).toBeGreaterThanOrEqual(0)
  expect(bellBox.x + bellBox.width).toBeLessThanOrEqual(390)

  await bell.click()
  const panel = panelOf(page)
  const box = (await panel.boundingBox())!
  expect(box.width).toBeLessThanOrEqual(390 - 32)
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  expect(box.y + box.height).toBeLessThanOrEqual(844 + 1)
  const list = panel.locator('ul')
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  expect(await list.evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto')
})

test('shows the jobs of the project the page is in, and no other project’s', async ({
  page,
  project,
  human,
}) => {
  const other = await seedProject(human, 'Elsewhere')
  const otherJob = await startJob(human, other, { steps: 100, ms: 1000 })
  const hereJob = await startJob(human, project, { steps: 100, ms: 1000 })

  await page.goto(`/projects/${project.id}`)
  const bell = bellOf(page)
  await expect(bell).toHaveText('1')
  await bell.click()
  const panel = panelOf(page)
  await expect(panel.getByRole('listitem')).toHaveCount(1)
  await expect(panel).toContainText(hereJob.title)
  await expect(panel).not.toContainText(otherJob.title)

  await page.goto(`/projects/${other.id}`)
  await expect(bellOf(page)).toHaveText('1')
})
