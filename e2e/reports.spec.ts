import type { APIRequestContext } from '@playwright/test'

import type { Attachment, ReportsOverview } from '#/lib/api'
import { localDate } from '#/lib/format'
import { periodLabel } from '#/lib/reports'
import { pdf } from './files'
import { expect, ok, seedProject, test } from './fixtures'

test('sets the report prompt and a daily cadence, posts today’s report; an agent posts a PDF that opens', async ({
  page,
  project,
  human,
  agent,
}) => {
  const today = localDate()
  const label = periodLabel('daily', today)
  const monthDay = new Date(`${today}T00:00:00`).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
  })
  // A shift that covers the whole day, every day: today's report is not due before the test is over.
  await ok(
    human.patch(`/api/projects/${project.id}/report-settings`, {
      data: { shiftStart: '00:00', shiftEnd: '23:59', workdays: [1, 2, 3, 4, 5, 6, 7] },
    }),
  )
  await page.goto(`/projects/${project.id}/daily`)
  const card = page.getByRole('region', { name: 'Report', exact: true })
  const settings = page.getByRole('region', { name: 'Report settings' })
  const calendar = page.getByRole('region', { name: 'Report calendar' })
  await expect(card).toContainText('Reports are off for this project')
  await expect(calendar).toHaveCount(0)

  // The prompt, then the schedule, each saved on its own.
  await settings.getByRole('button', { name: /^Report settings/ }).click()
  const prompt = settings.getByRole('group', { name: 'Prompt' })
  await prompt.getByRole('button', { name: /^No report prompt yet/ }).click()
  await prompt.getByRole('textbox', { name: 'Report prompt' }).fill('Two lines: what shipped, what is next.')
  await prompt.getByRole('button', { name: 'Save' }).click()
  await expect(prompt.getByRole('textbox', { name: 'Report prompt' })).toBeHidden()
  await expect(prompt).toContainText('Two lines: what shipped, what is next.')
  const schedule = settings.getByRole('group', { name: 'Schedule' })
  await schedule.locator('#report-cadence').click()
  await page.getByRole('option', { name: 'Daily' }).click()
  await schedule.getByRole('button', { name: 'Save' }).click()
  await expect(card).toContainText('daily by 23:59, text')
  await expect(settings).toContainText('daily by 23:59, text')

  // Today is the only period (none before the cadence was set), not due yet.
  const day = (status: string) =>
    calendar.getByRole('button', { name: `${monthDay}: ${status}`, exact: true })
  await expect(calendar.getByRole('button', { name: /: (done|missing)$/ })).toHaveCount(0)
  await expect(day('upcoming')).toBeVisible()
  await expect(card).toContainText(`No report for ${label} yet.`)

  await card.getByRole('button', { name: 'post the report' }).click()
  await card.getByRole('textbox', { name: `Report for ${label}` }).fill('Shipped the parser. Next: tests.')
  await card.getByRole('button', { name: 'Post', exact: true }).click()
  await expect(day('done')).toBeVisible()
  await expect(card).toContainText('Shipped the parser. Next: tests.')
  await expect(calendar).toContainText('1 done · 0 missing')

  // An agent switches the report to a file and posts a PDF it uploaded: a newer version of today's.
  await ok(agent.patch(`/api/projects/${project.id}/report-settings`, { data: { format: 'file' } }))
  const file = await ok<Attachment & { url: string }>(
    agent.post('/api/uploads', {
      multipart: { file: { name: 'report.pdf', mimeType: 'application/pdf', buffer: pdf('Daily report') } },
    }),
  )
  await ok(
    agent.post(`/api/projects/${project.id}/reports`, { data: { period: today, attachmentIds: [file.id] } }),
  )

  await page.reload()
  await expect(card).toContainText('daily by 23:59, a file')
  await expect(day('done')).toBeVisible()
  const thumb = card.getByRole('link', { name: /report\.pdf/ })
  // pdf.js read it: the thumbnail counts its pages.
  await expect(thumb).toContainText('1 page')
  // The text report before it is kept as an earlier version.
  await expect(card.getByText('Shipped the parser. Next: tests.')).toHaveCount(0)
  await card.getByRole('button', { name: 'show 1 earlier version' }).click()
  await expect(card.getByText('Shipped the parser. Next: tests.')).toBeVisible()

  // A click opens it in the gallery; the file itself is served as a PDF.
  await thumb.click()
  const viewer = page.locator('iframe[title="report.pdf"]')
  await expect(viewer).toBeVisible()
  await expect(viewer).toHaveAttribute('src', file.url)
  const served = await page.request.get(file.url)
  expect(served.ok()).toBe(true)
  expect(served.headers()['content-type']).toContain('application/pdf')
  expect((await served.body()).subarray(0, 5).toString()).toBe('%PDF-')
})

/** A daily project whose report is never due during the test. */
const trackDaily = (human: APIRequestContext, projectId: number) =>
  ok(
    human.patch(`/api/projects/${projectId}/report-settings`, {
      data: { cadence: 'daily', shiftStart: '00:00', shiftEnd: '23:59', workdays: [1, 2, 3, 4, 5, 6, 7] },
    }),
  )

test('the reports overview has each tracked project’s report for the day', async ({ project, human }) => {
  const today = localDate()
  const other = await seedProject(human, `${project.name} other`)
  const untracked = await seedProject(human, `${project.name} untracked`)
  const waiting = await seedProject(human, `${project.name} waiting`)
  for (const p of [project, other, waiting]) await trackDaily(human, p.id)
  await ok(
    human.post(`/api/projects/${project.id}/reports`, {
      data: { body: '## Done\n- shipped the **parser**' },
    }),
  )
  await ok(human.post(`/api/projects/${other.id}/reports`, { data: { body: 'A first take.' } }))
  await ok(human.post(`/api/projects/${other.id}/reports`, { data: { body: '## Done\n- the docs' } }))

  // One entry per tracked project, none for the one that does not track reports.
  const overview = await ok<ReportsOverview>(human.get(`/api/reports/overview?date=${today}`))
  expect(overview.date).toBe(today)
  const byId = new Map(overview.projects.map((p) => [p.id, p]))
  expect(byId.has(untracked.id)).toBe(false)
  expect(byId.get(project.id)).toMatchObject({ period: today, status: 'done', versions: 1 })
  expect(byId.get(other.id)).toMatchObject({
    status: 'done',
    versions: 2,
    report: { body: '## Done\n- the docs' },
  })
  expect(byId.get(waiting.id)).toMatchObject({ status: 'upcoming', versions: 0, report: null })
})
