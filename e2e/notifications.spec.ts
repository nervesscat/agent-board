import type { APIRequestContext, Page } from '@playwright/test'

import type { AgentCard, JobState, Project, TrackedCard } from '#/lib/api'
import { inDatabase } from './db'
import { AGENT } from './env'
import { expect, ok, seedProject, test } from './fixtures'

const bellOf = (page: Page) => page.getByRole('button', { name: 'Notifications' })
const panelOf = (page: Page) => page.getByRole('dialog')

/** One MCP tool call as the agent: the card or list it answered, with a failure's text as the message. */
const mcp = async (agent: APIRequestContext, name: string, args: Record<string, unknown>): Promise<any> => {
  const answer = await ok<{ result: { isError?: boolean; content: { text: string }[] } }>(
    agent.post('/api/mcp', {
      headers: { accept: 'application/json, text/event-stream' },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    }),
  )
  const result = answer.result
  expect(result.isError, result.content[0]!.text).toBeFalsy()
  return JSON.parse(result.content[0]!.text)
}

const startCard = (
  agent: APIRequestContext,
  project: Pick<Project, 'id'>,
  args: Record<string, unknown> = {},
) =>
  mcp(agent, 'start_tracked_request', {
    projectId: project.id,
    title: 'The e2e run',
    request: 'show me the progress of the e2e run',
    ...args,
  }) as Promise<TrackedCard>

const postNotice = (
  agent: APIRequestContext,
  project: Pick<Project, 'id'>,
  args: Record<string, unknown> = {},
) =>
  mcp(agent, 'post_notice', {
    projectId: project.id,
    title: 'The disk is almost full',
    body: 'The build host has 2% left; builds will fail soon.',
    reason: 'the disk will fill and nothing can build',
    ...args,
  }) as Promise<AgentCard>

const finishCard = (agent: APIRequestContext, project: Pick<Project, 'id'>, cardId: number, result: string) =>
  mcp(agent, 'finish_tracked_request', {
    projectId: project.id,
    cardId,
    state: 'succeeded',
    result,
  }) as Promise<TrackedCard>

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

test('an agent opens a tracked card that moves and ends in the panel, then a notice of its own kind', async ({
  page,
  project,
  agent,
}) => {
  const card = await startCard(agent, project, { total: 3, href: `/projects/${project.id}` })
  await mcp(agent, 'tracked_request_progress', {
    projectId: project.id,
    cardId: card.id,
    done: 2,
    step: 'spec 2 of 3',
  })

  await page.goto(`/projects/${project.id}`)
  const bell = bellOf(page)
  await expect(bell).toHaveText('1')
  await bell.click()
  const panel = panelOf(page)
  const item = panel.getByRole('listitem').filter({ hasText: card.title })
  await expect(item).toContainText(`You asked: ${card.request}`)
  await expect(item).toContainText(AGENT)
  const bar = item.getByRole('progressbar')
  await expect(bar).toHaveAttribute('aria-valuemax', '3')
  await expect(item).toContainText('2 of 3')
  await expect(item).toContainText('spec 2 of 3')

  // It ends while the panel is open: the card says so, and no toast is raised here.
  await finishCard(agent, project, card.id, 'All 3 specs passed')
  await expect(item.getByRole('status')).toContainText('Succeeded', { timeout: 15_000 })
  await expect(item.getByRole('status')).toContainText('All 3 specs passed')
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: card.title })).toHaveCount(0)

  // A notice is visibly its own kind: a label and the reason, with no bar and no done or failed line.
  const notice = await postNotice(agent, project)
  await expect(panel.getByRole('listitem')).toHaveCount(2, { timeout: 15_000 })
  const noticeItem = panel.getByRole('listitem').filter({ hasText: notice.title })
  await expect(noticeItem).toContainText('Notice')
  await expect(noticeItem).toContainText('Cannot wait: the disk will fill and nothing can build')
  await expect(noticeItem).toContainText('2% left')
  await expect(noticeItem.getByRole('progressbar')).toHaveCount(0)
  await expect(noticeItem.getByRole('status')).toHaveCount(0)
  await expect(bell).toHaveText('1')

  // Dismissing the notice drops it and its badge; Clear finished takes the ended card.
  await noticeItem.getByRole('button', { name: `Dismiss ${notice.title}` }).click()
  await expect(noticeItem).toHaveCount(0)
  await expect(bell).toHaveText('')
  await panel.getByRole('button', { name: 'Clear finished' }).click()
  await expect(panel.getByText('Nothing running')).toBeVisible()
})

test('one list of a job, a tracked card and a notice, newest first, with the badge over all three', async ({
  page,
  project,
  human,
  agent,
}) => {
  const job = await startJob(human, project, { steps: 100, ms: 1000 })
  await page.waitForTimeout(25)
  const card = await startCard(agent, project)
  await page.waitForTimeout(25)
  const notice = await postNotice(agent, project)

  await page.goto(`/projects/${project.id}`)
  const bell = bellOf(page)
  await expect(bell).toHaveText('3', { timeout: 15_000 })
  await bell.click()
  const panel = panelOf(page)
  const items = panel.getByRole('listitem')
  await expect(items).toHaveCount(3)
  const texts = await items.allInnerTexts()
  expect(texts[0]).toContain(notice.title)
  expect(texts[1]).toContain(card.title)
  expect(texts[2]).toContain(job.title)
  // The notice is the newest, the job the oldest: startedAt desc, one list.

  await panel
    .getByRole('listitem')
    .filter({ hasText: notice.title })
    .getByRole('button', { name: `Dismiss ${notice.title}` })
    .click()
  await expect(bell).toHaveText('2')
  await finishCard(agent, project, card.id, 'done')
  await expect(bell).toHaveText('1', { timeout: 15_000 })
})

test('a tracked card that ends while the panel is closed raises a toast, and a notice raises exactly one', async ({
  page,
  project,
  agent,
}) => {
  const card = await startCard(agent, project, { title: 'The release build' })
  await page.goto(`/projects/${project.id}`)
  const bell = bellOf(page)
  // It reached the open page without a reload.
  await expect(bell).toHaveText('1', { timeout: 15_000 })

  await finishCard(agent, project, card.id, 'v1.2.0 is up')
  const finished = page.locator('[data-sonner-toast]').filter({ hasText: card.title })
  await expect(finished).toContainText('finished', { timeout: 15_000 })
  await expect(finished).toContainText('v1.2.0 is up')

  const notice = await postNotice(agent, project, {
    title: 'A secret was printed',
    body: 'A log line carries the deploy token; rotate it now.',
    reason: 'the token is exposed and must be rotated at once',
  })
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: notice.title })
  await expect(toast).toContainText('the token is exposed', { timeout: 15_000 })
  await expect(toast).toHaveCount(1)
})

test('a stale tracked card says how long it has been silent, is never failed, and still dismisses', async ({
  page,
  project,
  agent,
}) => {
  const card = await startCard(agent, project, { title: 'The overnight migration' })
  // Backdated through the run's own database, as if its agent had gone away seven hours ago.
  inDatabase((db) =>
    db
      .prepare('UPDATE agent_cards SET updatedAt = ? WHERE id = ?')
      .run(new Date(Date.now() - 7 * 60 * 60_000).toISOString(), card.id),
  )
  await page.goto(`/projects/${project.id}`)
  const bell = bellOf(page)
  await expect(bell).toHaveText('1', { timeout: 15_000 })
  await bell.click()
  const panel = panelOf(page)
  const item = panel.getByRole('listitem').filter({ hasText: card.title })
  await expect(item).toContainText(/No update for \d/)
  await expect(item.getByRole('status')).toHaveCount(0)
  await expect(item).not.toContainText('Failed')
  await expect(item).not.toContainText('Succeeded')

  await item.getByRole('button', { name: `Dismiss ${card.title}` }).click()
  await expect(item).toHaveCount(0)
})

test('a board path routes inside the board and an absolute URL is an external link', async ({
  page,
  project,
  agent,
}) => {
  const path = await startCard(agent, project, {
    title: 'Where the run lives',
    href: `/projects/${project.id}/cleanup`,
  })
  const external = await startCard(agent, project, {
    title: 'The external status',
    href: 'https://status.example.com/run/7',
  })
  await page.goto(`/projects/${project.id}`)
  const bell = bellOf(page)
  await expect(bell).toHaveText('2')
  await bell.click()
  const panel = panelOf(page)
  await panel.getByRole('link', { name: path.title }).click()
  await page.waitForURL(`**/projects/${project.id}/cleanup`)

  await page.goto(`/projects/${project.id}`)
  await bellOf(page).click()
  await expect(panelOf(page).getByRole('link', { name: external.title })).toHaveAttribute(
    'href',
    'https://status.example.com/run/7',
  )
})

test('Clear finished clears ended cards and jobs only, leaving a running card and a notice', async ({
  page,
  project,
  human,
  agent,
}) => {
  const ended = await startCard(agent, project, { title: 'The build that ended' })
  await finishCard(agent, project, ended.id, 'built')
  const running = await startCard(agent, project, { title: 'The build still running' })
  const notice = await postNotice(agent, project, { title: 'A deadline was missed' })
  const job = await startJob(human, project, { steps: 1, ms: 0 })
  await expect
    .poll(async () => (await jobsOf(human, project)).find((entry) => entry.id === job.id)?.state)
    .toBe('succeeded')

  await page.goto(`/projects/${project.id}`)
  const bell = bellOf(page)
  await expect(bell).toHaveText('2')
  await bell.click()
  const panel = panelOf(page)
  await expect(panel.getByRole('listitem')).toHaveCount(4)
  // A card without a total has no bar and no numeric line.
  const runningItem = panel.getByRole('listitem').filter({ hasText: running.title })
  await expect(runningItem.getByRole('progressbar')).toHaveCount(0)

  await panel.getByRole('button', { name: 'Clear finished' }).click()
  await expect(panel.getByRole('listitem')).toHaveCount(2)
  await expect(panel).toContainText(running.title)
  await expect(panel).toContainText(notice.title)
  await expect(panel).not.toContainText(ended.title)
  await expect(panel).not.toContainText(job.title)
})
