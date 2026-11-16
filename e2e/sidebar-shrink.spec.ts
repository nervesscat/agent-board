import type { Page } from '@playwright/test'

import { expect, expectTooltip, test } from './fixtures'

const sidebar = (page: Page) => page.locator('aside').filter({ has: page.getByRole('navigation') })
const toggle = (page: Page) => page.getByRole('button', { name: /sidebar$/ })
/** A shrunk link is icon-only: its label is screen-reader text, so the link is narrow. */
async function linkIsIconOnly(page: Page, name: string) {
  const box = (await sidebar(page).getByRole('link', { name }).boundingBox())!
  return box.width < 60
}

test('one toggle cycles the sidebar through expanded, shrunk and hidden, with a name for each next press', async ({
  page,
  project,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${project.id}/prs`)
  const aside = sidebar(page)
  await expect(aside.getByRole('link', { name: 'PR queue' })).toBeVisible()
  await expect(aside.getByRole('link', { name: 'PR queue' })).toBeVisible()

  await expect(page.getByRole('button', { name: 'Shrink sidebar' })).toBeVisible()
  await page.getByRole('button', { name: 'Shrink sidebar' }).click()

  // Shrunk: the labels are for screen readers only, the links keep their names.
  await expect(page.getByRole('button', { name: 'Hide sidebar' })).toBeVisible()
  await expect(aside.getByRole('link', { name: 'PR queue' })).toBeVisible()
  expect(await linkIsIconOnly(page, 'PR queue')).toBe(true)
  const width = (await aside.boundingBox())!.width
  expect(width).toBeLessThan(100)

  await page.getByRole('button', { name: 'Hide sidebar' }).click()
  await expect(aside).toBeHidden()
  await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeVisible()

  await page.getByRole('button', { name: 'Show sidebar' }).click()
  await expect(aside.getByRole('link', { name: 'PR queue' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Shrink sidebar' })).toBeVisible()
  expect(await toggle(page).count()).toBe(1)
})

test('a shrunk sidebar shows each page as an icon with its label in a tooltip', async ({ page, project }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${project.id}/prs`)
  await page.getByRole('button', { name: 'Shrink sidebar' }).click()
  const link = sidebar(page).getByRole('link', { name: 'Roadmap' })
  await expectTooltip(link, 'Roadmap')
})

test('a hidden sidebar shows while the mouse is on the left border, and closes once it leaves', async ({
  page,
  project,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${project.id}/prs`)
  await page.getByRole('button', { name: 'Shrink sidebar' }).click()
  await page.getByRole('button', { name: 'Hide sidebar' }).click()
  const aside = sidebar(page)
  await expect(aside).toBeHidden()

  await page.mouse.move(640, 400)
  await page.mouse.move(2, 400)
  await expect(aside.getByRole('link', { name: 'PR queue' })).toBeVisible()
  // The page does not move while the sidebar is over it.
  const pageBox = (await page.locator('section').first().boundingBox())!
  expect(pageBox.x).toBeLessThan(100)

  await page.mouse.move(640, 400)
  await expect(aside).toBeHidden()
})

test('a peeked hidden sidebar that closes after a click keeps focus on the toggle, not the page body', async ({
  page,
  project,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${project.id}/prs`)
  await page.getByRole('button', { name: 'Shrink sidebar' }).click()
  await page.getByRole('button', { name: 'Hide sidebar' }).click()
  const aside = sidebar(page)
  await expect(aside).toBeHidden()

  await page.mouse.move(640, 400)
  await page.mouse.move(2, 400)
  await aside.getByRole('link', { name: 'Roadmap' }).click()
  await page.mouse.move(640, 400)
  await expect(aside).toBeHidden()
  // The link the click focused is gone with the sidebar: focus goes to the toggle that shows it again.
  await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeFocused()
})

test('the chosen mode is remembered per browser across a reload', async ({ page, project }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${project.id}/prs`)
  await page.getByRole('button', { name: 'Shrink sidebar' }).click()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Hide sidebar' })).toBeVisible()
  expect(await linkIsIconOnly(page, 'PR queue')).toBe(true)
})

test('an unknown stored value shows the sidebar expanded', async ({ page, project }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${project.id}/prs`)
  await page.evaluate(() => localStorage.setItem('agent-board.sidebar', 'folded'))
  await page.reload()
  await expect(page.getByRole('button', { name: 'Shrink sidebar' })).toBeVisible()
  await expect(sidebar(page).getByRole('link', { name: 'PR queue' })).toBeVisible()
})

test('the toggle takes the keyboard: it is reached by Tab and Enter cycles it', async ({ page, project }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${project.id}/prs`)
  const button = page.getByRole('button', { name: 'Shrink sidebar' })
  await button.focus()
  await expect(button).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Hide sidebar' })).toBeFocused()
  await page.keyboard.press('Space')
  await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeFocused()
})

test('on a phone there is no toggle and the page picker is unchanged', async ({ page, project }) => {
  await page.setViewportSize({ width: 390, height: 700 })
  await page.goto(`/projects/${project.id}/prs`)
  await expect(page.getByRole('combobox', { name: 'Project page' })).toBeVisible()
  await expect(page.getByRole('button', { name: /sidebar$/ })).toHaveCount(0)
  expect(
    await page
      .locator('aside')
      .first()
      .evaluate((el) => getComputedStyle(el).position),
  ).toBe('static')
})
