import type { Attachment } from '#/lib/api'
import { localDate } from '#/lib/format'
import { periodLabel } from '#/lib/reports'
import { pdf } from './files'
import { expect, ok, test } from './fixtures'

test('sets the report prompt and a daily cadence, posts today’s report; an agent posts a PDF that opens', async ({
  page,
  project,
  agent,
}) => {
  const today = localDate()
  const label = periodLabel('daily', today)
  await page.goto(`/projects/${project.id}/daily`)
  const panel = page.getByRole('region', { name: 'Report' })
  await expect(panel).toContainText('off')

  // The prompt and the schedule, saved together.
  await panel.getByRole('button', { name: /^No report prompt yet/ }).click()
  await panel.getByRole('textbox', { name: 'Report prompt' }).fill('Two lines: what shipped, what is next.')
  await panel.locator('#report-cadence').click()
  await page.getByRole('option', { name: 'Daily' }).click()
  await panel.getByRole('button', { name: 'Save' }).click()
  await expect(panel.getByRole('textbox', { name: 'Report prompt' })).toBeHidden()
  await expect(panel).toContainText('daily, text')
  await expect(panel).toContainText('Two lines: what shipped, what is next.')

  // Due by the end of today: today is the only period (none before the cadence was set), not due yet.
  const strip = panel.getByRole('list', { name: 'Report periods' })
  await expect(strip.getByRole('button')).toHaveCount(1)
  await expect(strip.getByRole('button', { name: `${label}: upcoming` })).toBeVisible()
  await expect(panel).toContainText(`No report for ${label} yet.`)

  await panel.getByRole('button', { name: 'post the report' }).click()
  await panel.getByRole('textbox', { name: `Report for ${label}` }).fill('Shipped the parser. Next: tests.')
  await panel.getByRole('button', { name: 'Post', exact: true }).click()
  await expect(strip.getByRole('button', { name: `${label}: done` })).toBeVisible()
  await expect(panel).toContainText('Shipped the parser. Next: tests.')
  await expect(panel).toContainText('1 done · 0 missing')

  // An agent switches the report to a file and posts a PDF it uploaded: it replaces today's report.
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
  await expect(panel).toContainText('daily, a file')
  await expect(strip.getByRole('button', { name: `${label}: done` })).toBeVisible()
  const thumb = panel.getByRole('link', { name: /report\.pdf/ })
  // pdf.js read it: the thumbnail counts its pages.
  await expect(thumb).toContainText('1 page')
  // The text report it replaced is kept as an earlier version.
  await expect(panel.getByText('Shipped the parser. Next: tests.')).toHaveCount(0)
  await panel.getByRole('button', { name: 'show 1 earlier version' }).click()
  await expect(panel.getByText('Shipped the parser. Next: tests.')).toBeVisible()

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
