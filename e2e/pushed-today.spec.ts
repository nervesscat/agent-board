import type { APIRequestContext, Locator, Page } from '@playwright/test'

import type { Project, PushedToday, TicketFull } from '#/lib/api'
import { expect, ok, test } from './fixtures'
import { look, ownRepo } from './repos'

const ticket = (human: APIRequestContext, project: Project, title: string, branch: string) =>
  ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, { data: { title, status: 'in_progress', branch } }),
  )

/** The indicator in the Daily page's header. */
const header = (page: Page) => page.locator('aside + section').getByRole('button', { name: /^Pushed today/ })

/** The Daily page's subtitle, which the indicator sits under at every width. */
const subtitle = (page: Page) => page.getByText(/^The period's report, and what got done hour by hour\.$/)

/** It reads below the subtitle and its left edge lines up with it, not beside it. */
async function sitsUnderTheSubtitle(page: Page) {
  const pill = await header(page).boundingBox()
  const text = await subtitle(page).boundingBox()
  expect(pill, 'the pill has a box').not.toBeNull()
  expect(text, 'the subtitle has a box').not.toBeNull()
  expect(pill!.y, 'below the subtitle').toBeGreaterThanOrEqual(text!.y + text!.height)
  expect(Math.abs(pill!.x - text!.x), 'left-aligned with it').toBeLessThanOrEqual(1)
}

const scrollsSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)

/** Its dot's colour, its text's and the page's background, as the browser paints them. */
const colours = (badge: Locator) =>
  badge.evaluate((el) => {
    const dot = el.querySelector('[data-part="dot"]')!
    return {
      dot: getComputedStyle(dot).backgroundColor,
      text: getComputedStyle(el).color,
      page: getComputedStyle(document.body).backgroundColor,
    }
  })

test('grey until a commit reaches origin, then green with the commits and lines, by repo, branch and ticket', async ({
  page,
  human,
}, info) => {
  const repo = await ownRepo(human, `Pushed today ${info.workerIndex}.${info.repeatEachIndex}`)
  const { project } = repo
  const work = await ticket(human, project, 'Checkout totals', 'feat/totals')

  await page.goto(`/projects/${project.id}/daily`)
  await expect(header(page)).toHaveAttribute('data-pushed', 'no')
  await expect(header(page)).toHaveText('Nothing pushed today')
  await sitsUnderTheSubtitle(page)
  await header(page).click()
  await expect(page.getByText("Nothing reached origin today on this project's repos.")).toBeVisible()
  await page.keyboard.press('Escape')

  repo.push('feat/totals')
  await look(human, project)
  const today = await ok<PushedToday>(human.get(`/api/projects/${project.id}/pushed-today`))
  expect(today).toMatchObject({
    commits: 1,
    added: 1,
    removed: 0,
    checkedAt: expect.any(String),
    repos: [
      {
        name: 'shop-api',
        commits: 1,
        added: 1,
        removed: 0,
        branches: [
          {
            branch: 'feat/totals',
            commits: 1,
            added: 1,
            removed: 0,
            ticket: { id: work.id, title: 'Checkout totals' },
          },
        ],
      },
    ],
  })

  await page.reload()
  await expect(header(page)).toHaveAttribute('data-pushed', 'yes')
  await expect(header(page)).toContainText('1 commit')
  await expect(header(page)).toContainText('+1 −0')
  await expect(header(page).locator('[data-part="dot"]')).toHaveClass(/bg-emerald-500/)

  await header(page).click()
  const byRepo = page.getByRole('list', { name: 'Pushed today by repo' })
  await expect(byRepo).toBeVisible()
  await expect(byRepo).toContainText('shop-api')
  await expect(byRepo.getByText('feat/totals')).toBeVisible()
  await expect(byRepo).toContainText('1 commit +1 −0')
  await byRepo.getByRole('link', { name: 'Checkout totals' }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/features/${work.id}$`))
  // Only the Daily page has it: the project's sidebar does not.
  await expect(page.locator('aside').getByRole('button', { name: /^Pushed today/ })).toHaveCount(0)
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('fits the Daily page, answers a tap, and reads in light and dark', async ({ page, human }, info) => {
    const quiet = await ownRepo(human, `Nothing pushed ${info.workerIndex}.${info.repeatEachIndex}`)
    const busy = await ownRepo(
      human,
      `A project with a long name that has pushed a lot today ${info.workerIndex}.${info.repeatEachIndex}`,
    )
    await ticket(
      human,
      busy.project,
      'A ticket whose title is long enough to have to wrap on a phone',
      'feat/a-rather-long-branch-name-for-a-phone',
    )
    busy.push('feat/a-rather-long-branch-name-for-a-phone')
    await look(human, busy.project)

    await page.goto(`/projects/${busy.project.id}/daily`)
    await expect(header(page)).toHaveAttribute('data-pushed', 'yes')
    await sitsUnderTheSubtitle(page)
    expect(await scrollsSideways(page)).toBe(false)
    await header(page).tap()
    const byRepo = page.getByRole('list', { name: 'Pushed today by repo' })
    await expect(byRepo).toBeVisible()
    await expect(byRepo).toContainText('A ticket whose title is long enough')
    expect(await scrollsSideways(page)).toBe(false)
    await page.screenshot({ path: info.outputPath('pushed-today-phone-daily.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')

    // Green and grey, each told apart from the page, in both themes.
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      for (const [which, project] of [
        ['green', busy.project],
        ['grey', quiet.project],
      ] as const) {
        await page.goto(`/projects/${project.id}/daily`)
        if (colorScheme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/)
        else await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
        await expect(header(page)).toHaveAttribute('data-pushed', which === 'green' ? 'yes' : 'no')
        const c = await colours(header(page))
        expect(c.dot, `${which} dot, ${colorScheme}`).not.toBe(c.page)
        expect(c.text, `${which} text, ${colorScheme}`).not.toBe(c.page)
        expect(await scrollsSideways(page)).toBe(false)
        await header(page).screenshot({ path: info.outputPath(`pushed-today-${which}-${colorScheme}.png`) })
      }
    }
    // The green dot and the grey one are not the same colour either.
    await page.goto(`/projects/${busy.project.id}/daily`)
    const green = (await colours(header(page))).dot
    await page.goto(`/projects/${quiet.project.id}/daily`)
    expect((await colours(header(page))).dot).not.toBe(green)
  })
})
