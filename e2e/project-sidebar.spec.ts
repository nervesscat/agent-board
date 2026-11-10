import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'

const sidebar = (page: Page) => page.locator('aside').filter({ has: page.getByRole('navigation') })

/** That the whole of the sidebar's nav is inside the window. */
async function expectNavInView(page: Page) {
  const box = (await sidebar(page).getByRole('navigation').boundingBox())!
  const vh = page.viewportSize()!.height
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(vh)
}

const longText = Array.from({ length: 120 }, (_, i) => `Line ${i + 1} of a long description.`).join('\n\n')

test('the project sidebar stays in view while a long ticket page scrolls', async ({ page, project, api }) => {
  await page.setViewportSize({ width: 1280, height: 700 })
  const t = await api.ticket({ title: 'Long ticket', body: longText })
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  await expect(page.getByText('Line 120 of a long description.')).toBeAttached()
  expect(await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight * 2)).toBe(true)
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(500)
  await expectNavInView(page)
  // Below the sticky header, not under it.
  const header = (await page.locator('header').first().boundingBox())!
  expect((await sidebar(page).boundingBox())!.y).toBeGreaterThanOrEqual(header.y + header.height - 1)
})

test('the sidebar scrolls on its own when taller than the window', async ({ page, project }) => {
  await page.setViewportSize({ width: 1280, height: 260 })
  await page.goto(`/projects/${project.id}`)
  const aside = sidebar(page)
  await expect(aside.getByRole('navigation')).toBeVisible()
  const sizes = await aside.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }))
  expect(sizes.scroll).toBeGreaterThan(sizes.client)
  expect((await aside.boundingBox())!.height).toBeLessThanOrEqual(260)
  const last = aside.getByRole('navigation').getByRole('link').last()
  await last.scrollIntoViewIfNeeded()
  await expect(last).toBeInViewport()
  expect(await aside.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
})

test('the focus ring of a sidebar item is drawn inside it, clear of the scroll container', async ({
  page,
  project,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${project.id}/prs`)
  const link = sidebar(page).getByRole('navigation').getByRole('link', { name: 'PR queue' })
  await link.focus()
  await expect(link).toBeFocused()
  const ring = await link.evaluate((el) => {
    const style = getComputedStyle(el)
    const aside = el.closest('aside')!
    return {
      focusVisible: el.matches(':focus-visible'),
      outline: style.outlineStyle,
      shadow: style.boxShadow,
      itemRight: el.getBoundingClientRect().right,
      asideRight: aside.getBoundingClientRect().right,
    }
  })
  expect(ring.focusVisible).toBe(true)
  // The aside scrolls (overflow-y, so overflow-x is auto too): an outline outside the link would be
  // cut at its right edge. The ring is a box shadow inset in the link instead, so all of it shows.
  expect(ring.outline).toBe('none')
  expect(ring.shadow).toContain('inset')
  expect(ring.itemRight).toBeLessThanOrEqual(ring.asideRight)
})

test('at a narrow width the sidebar sits above the content and nothing scrolls sideways', async ({
  page,
  project,
  api,
}) => {
  await page.setViewportSize({ width: 390, height: 700 })
  const t = await api.ticket({ title: 'Long ticket', body: longText })
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  await expect(page.getByText('Line 120 of a long description.')).toBeAttached()
  // On a phone the project's pages are a picker instead of the desktop sidebar nav.
  const picker = page.getByRole('combobox', { name: 'Project page' })
  await expect(picker).toBeVisible()
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
  ).toBe(true)
  expect(
    await page
      .locator('aside')
      .first()
      .evaluate((el) => getComputedStyle(el).position),
  ).toBe('static')
  await picker.click()
  await page.getByRole('option', { name: 'Roadmap' }).click()
  await expect(page).not.toHaveURL(new RegExp(`/features/${t.id}$`))
})
