import fs from 'node:fs'

import type { APIRequestContext, Locator, Page } from '@playwright/test'

import type { ReportList, ReportView } from '#/lib/api'
import { localDate } from '#/lib/format'
import { periodLabel } from '#/lib/reports'
import { expect, ok, test } from './fixtures'

// claude is e2e/fake-claude.mjs here (playwright.config.ts): a marker in the project's prompt tells it
// how to answer, and where to log what it was run with.

/** A daily project whose report is never due during the test, with `prompt` as its prompt. */
async function daily(human: APIRequestContext, projectId: number, prompt: string, extra = {}) {
  await ok(
    human.patch(`/api/projects/${projectId}/report-settings`, {
      data: {
        cadence: 'daily',
        prompt,
        shiftStart: '00:00',
        shiftEnd: '23:59',
        workdays: [1, 2, 3, 4, 5, 6, 7],
        ...extra,
      },
    }),
  )
}

/** What the stand-in logged: one line per run. */
const runs = (log: string) =>
  fs.existsSync(log)
    ? fs
        .readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { argv: string[]; stdin: string })
    : []

const scrollsSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)

const generateButton = (card: Locator) =>
  card.getByRole('button', { name: /Generate with claude|claude is writing/ })

test('claude writes today’s report from the prompt on its stdin; the page shows it busy across a navigation', async ({
  page,
  project,
  human,
}) => {
  // claude takes a while here, long enough to leave the page and come back while it writes.
  test.setTimeout(60_000)
  const log = test.info().outputPath('claude.jsonl')
  const prompt = `Two short lines for the owner. [fake-claude: slow 12000] [fake-claude-log: ${log}]`
  await daily(human, project.id, prompt)
  const today = localDate()

  await page.goto(`/projects/${project.id}/daily`)
  const card = page.getByRole('region', { name: 'Report', exact: true })
  await expect(card).toContainText(`No report for ${periodLabel('daily', today)} yet.`)
  await card.getByRole('button', { name: 'Generate with claude' }).click()
  await expect(card.getByRole('button', { name: 'claude is writing…' })).toBeDisabled()

  // Away and back while claude writes: the run is the server's, so the page still says so.
  await page.getByRole('link', { name: 'CrossBoard' }).click()
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  await page.goBack()
  await expect(card.getByRole('button', { name: 'claude is writing…' })).toBeDisabled()
  const list = await ok<ReportList>(
    human.get(`/api/projects/${project.id}/reports?from=${today}&to=${today}`),
  )
  expect(list.generating).toBe(today)

  // It lands: the default template's sections, by claude, one version.
  await expect(card.getByRole('heading', { name: 'Blocked / needs you' })).toBeVisible({ timeout: 30_000 })
  await expect(card.getByRole('button', { name: 'Generate with claude' })).toBeEnabled()
  await expect(card).toContainText('1 version')
  const [report] = await ok<ReportView[]>(human.get(`/api/projects/${project.id}/reports/${today}`))
  expect(report).toMatchObject({ author: 'claude', period: today })
  expect((await ok<ReportList>(human.get(`/api/projects/${project.id}/reports`))).generating).toBeNull()

  // The prompt went in on stdin, with the template and the day's activity; the arguments are flags.
  const [run] = runs(log)
  expect(run!.argv).toEqual(['-p', '--output-format', 'text'])
  expect(run!.stdin).toContain(prompt)
  expect(run!.stdin).toContain('## Pushed today')
  expect(run!.stdin).toMatch(/enrique: changed the report prompt/)
})

test('a report that misses the template twice is not stored and the card says why; the next good one clears it', async ({
  page,
  project,
  human,
}) => {
  const log = test.info().outputPath('claude.jsonl')
  await daily(human, project.id, '[fake-claude: bad]')
  await page.goto(`/projects/${project.id}/daily`)
  const card = page.getByRole('region', { name: 'Report', exact: true })

  await card.getByRole('button', { name: 'Generate with claude' }).click()
  const error = card.getByRole('alert')
  await expect(error).toContainText('missing: Next')
  await expect(error).toContainText('did not fill the template twice')
  await expect(card).toContainText('yet.')
  const list = await ok<ReportList>(human.get(`/api/projects/${project.id}/reports`))
  expect(list.generateError).toMatchObject({
    period: localDate(),
    message: expect.stringMatching(/missing: Next/),
  })
  // Still there after a reload: the server keeps it.
  await page.reload()
  await expect(card.getByRole('alert')).toContainText('missing: Next')

  // Bad the first time, good the second: one version, the error gone.
  await daily(human, project.id, `[fake-claude: bad-then-good] [fake-claude-log: ${log}]`)
  await card.getByRole('button', { name: 'Generate with claude' }).click()
  await expect(card.getByRole('heading', { name: 'Next' })).toBeVisible()
  await expect(card.getByRole('alert')).toHaveCount(0)
  await expect(card).toContainText('1 version')
  expect(runs(log)).toHaveLength(2)
})

test('the button says why it is off: no cadence, or a project whose reports are files', async ({
  page,
  project,
  human,
}) => {
  await page.goto(`/projects/${project.id}/daily`)
  const card = page.getByRole('region', { name: 'Report', exact: true })
  await expect(card.getByRole('button', { name: 'Generate with claude' })).toBeDisabled()
  await expect(card.locator('span[title^="Reports are off"]')).toHaveCount(1)

  await daily(human, project.id, 'A PDF.', { format: 'file' })
  await page.reload()
  await expect(card.getByRole('button', { name: 'Generate with claude' })).toBeDisabled()
  await expect(card.locator(`span[title^="This project's reports are files"]`)).toHaveCount(1)
  const refused = await human.post(`/api/projects/${project.id}/reports/generate`, { data: {} })
  expect(refused.status()).toBe(400)
})

test.describe('at 390px, light and dark', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('the busy button and the failure fit the card and read in both themes', async ({
    page,
    project,
    human,
  }) => {
    await daily(human, project.id, '[fake-claude: bad]')
    await page.goto(`/projects/${project.id}/daily`)
    const card = page.getByRole('region', { name: 'Report', exact: true })
    await card.getByRole('button', { name: 'Generate with claude' }).tap()
    await expect(card.getByRole('alert')).toContainText('missing: Next')

    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      if (colorScheme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/)
      expect(await scrollsSideways(page), colorScheme).toBe(false)
      const alert = card.getByRole('alert')
      const [text, back] = await alert.evaluate((el) => {
        let bg = 'rgba(0, 0, 0, 0)'
        for (let e: Element | null = el; e && /rgba\(0, 0, 0, 0\)|transparent/.test(bg); e = e.parentElement)
          bg = getComputedStyle(e).backgroundColor
        if (/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) bg = getComputedStyle(document.body).backgroundColor
        return [getComputedStyle(el).color, bg]
      })
      expect(text, colorScheme).not.toBe(back)
      const box = (await alert.boundingBox())!
      expect(box.x, colorScheme).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width, colorScheme).toBeLessThanOrEqual(390)
      await card.screenshot({ path: test.info().outputPath(`generate-failed-${colorScheme}.png`) })
    }

    // Busy, at phone width: the label fits too.
    await daily(human, project.id, '[fake-claude: slow 4000]')
    await generateButton(card).tap()
    await expect(card.getByRole('button', { name: 'claude is writing…' })).toBeVisible()
    expect(await scrollsSideways(page)).toBe(false)
    await card.screenshot({ path: test.info().outputPath('generate-busy-dark.png') })
    await expect(card.getByRole('heading', { name: 'Next' })).toBeVisible({ timeout: 20_000 })
  })
})
