import type { APIRequestContext, Page } from '@playwright/test'

import type { ReportView } from '#/lib/api'
import { localDate } from '#/lib/format'
import { expect, ok, test } from './fixtures'

const scrollsSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)

/** A daily project whose report is never due during the test. */
async function daily(human: APIRequestContext, projectId: number) {
  await ok(
    human.patch(`/api/projects/${projectId}/report-settings`, {
      data: { cadence: 'daily', shiftStart: '00:00', shiftEnd: '23:59', workdays: [1, 2, 3, 4, 5, 6, 7] },
    }),
  )
}

const post = (as: APIRequestContext, projectId: number, body: string) =>
  ok<ReportView>(as.post(`/api/projects/${projectId}/reports`, { data: { period: localDate(), body } }))

/** A moment as the page writes it, in the browser's locale and zone. */
const stamped = (page: Page, iso: string) =>
  page.evaluate((at) => new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }), iso)

test('the card shows the period’s report as markdown, with its author, time and version count', async ({
  page,
  project,
  human,
}) => {
  await daily(human, project.id)
  const report = await post(
    human,
    project.id,
    '## Done\n- shipped the parser\n\n## Next\nTests, then *docs*.',
  )
  await page.goto(`/projects/${project.id}/daily`)
  const card = page.getByRole('region', { name: 'Report', exact: true })

  await expect(card.getByRole('heading', { level: 2, name: 'Done' })).toBeVisible()
  await expect(card.getByRole('heading', { level: 2, name: 'Next' })).toBeVisible()
  await expect(card.getByRole('listitem').filter({ hasText: 'shipped the parser' })).toBeVisible()
  await expect(card.locator('em', { hasText: 'docs' })).toBeVisible()
  // No markdown shows through as text.
  await expect(card).not.toContainText('## Done')
  await expect(card).toContainText('enrique')
  await expect(card).toContainText(await stamped(page, report.createdAt))
  await expect(card).toContainText('1 version')
  await expect(card.getByRole('button', { name: /earlier version/ })).toHaveCount(0)
})

test('earlier versions open from the card, each with its own body and author', async ({
  page,
  project,
  human,
  agent,
}) => {
  await daily(human, project.id)
  const first = await post(agent, project.id, '## Done\n- the first take')
  await post(human, project.id, '## Done\n- the second take')
  await page.goto(`/projects/${project.id}/daily`)
  const card = page.getByRole('region', { name: 'Report', exact: true })

  await expect(card.getByRole('listitem').filter({ hasText: 'the second take' })).toBeVisible()
  await expect(card).toContainText('2 versions')
  await expect(card.getByText('the first take')).toHaveCount(0)

  const toggle = card.getByRole('button', { name: 'show 1 earlier version' })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  const earlier = card.getByRole('list', { name: 'Earlier versions' }).getByRole('listitem').first()
  await expect(earlier.getByRole('heading', { level: 2, name: 'Done' })).toBeVisible()
  await expect(earlier.getByText('the first take')).toBeVisible()
  await expect(earlier).toContainText('claude')
  await expect(earlier).toContainText('version 1')
  await expect(earlier).toContainText(await stamped(page, first.createdAt))

  await card.getByRole('button', { name: 'hide 1 earlier version' }).click()
  await expect(card.getByText('the first take')).toHaveCount(0)
})

test.describe('at 390px with touch, light and dark', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('the card and its earlier versions fit the screen and read in both themes', async ({
    page,
    project,
    human,
    agent,
  }) => {
    await daily(human, project.id)
    await post(
      agent,
      project.id,
      `## Done\n- an early take with a link https://example.com/${'long/'.repeat(20)}`,
    )
    await post(human, project.id, `## Done\n- ${'shipped '.repeat(20)}\n\n## Next\n- tests`)
    await page.goto(`/projects/${project.id}/daily`)
    const card = page.getByRole('region', { name: 'Report', exact: true })
    await card.getByRole('button', { name: 'show 1 earlier version' }).tap()
    await expect(card.getByText(/an early take/)).toBeVisible()

    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      if (colorScheme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/)
      expect(await scrollsSideways(page), colorScheme).toBe(false)
      for (const el of [
        card.getByRole('heading', { level: 2, name: 'Next' }),
        card.getByRole('listitem').filter({ hasText: 'tests' }).first(),
        card.getByText(/an early take/),
      ]) {
        const [color, back] = await el.evaluate((e) => {
          let bg = 'rgba(0, 0, 0, 0)'
          for (let n: Element | null = e; n && /rgba\(0, 0, 0, 0\)|transparent/.test(bg); n = n.parentElement)
            bg = getComputedStyle(n).backgroundColor
          return [getComputedStyle(e).color, bg]
        })
        expect(color, colorScheme).not.toBe(back)
      }
      await card.screenshot({ path: test.info().outputPath(`report-card-${colorScheme}.png`) })
    }
  })
})
