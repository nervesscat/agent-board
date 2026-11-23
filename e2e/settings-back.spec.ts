import type { Page } from '@playwright/test'

import { expect, seedProject, test } from './fixtures'

const bar = (page: Page) => page.getByRole('banner')
const selector = (page: Page) => bar(page).getByRole('button', { name: 'Project' })
const back = (page: Page, label: string) => page.getByRole('link', { name: `Back to ${label}` })
const openSettings = (page: Page) => bar(page).getByRole('link', { name: 'Settings', exact: true }).click()
const openConnect = (page: Page) => bar(page).getByRole('link', { name: 'Connect an agent' }).click()
/** The project and the last page the browser keeps are written after the page mounts. */
const kept = (page: Page, key: string, pattern: RegExp) =>
  expect.poll(() => page.evaluate((k) => localStorage.getItem(k), key)).toMatch(pattern)

test('Settings and Connect go back to the last page of the project, with its state', async ({
  page,
  project,
  api,
}) => {
  const t = await api.ticket({ title: 'A ticket to come back to' })
  const pages = [
    { url: `/projects/${project.id}/features?view=list&q=login`, label: 'Ongoing features' },
    { url: `/projects/${project.id}/features/${t.id}#tasks`, label: 'Ongoing features' },
    { url: `/projects/${project.id}/prs?filter=me`, label: 'PR queue' },
    { url: `/projects/${project.id}/roadmap`, label: 'Roadmap' },
  ]
  for (const { url, label } of pages) {
    for (const open of [openSettings, openConnect]) {
      await page.goto(url)
      await kept(page, 'last-module', /projects/)
      await open(page)
      await expect(back(page, label)).toBeVisible()
      await back(page, label).click()
      const want = new URL(url, 'http://x')
      await expect.poll(() => new URL(page.url()).pathname).toBe(want.pathname)
      expect(new URL(page.url()).search).toBe(want.search)
      expect(new URL(page.url()).hash).toBe(want.hash)
    }
  }
})

test('the back button is a link with a name, reachable by keyboard, on both pages', async ({
  page,
  project,
}) => {
  await page.goto(`/projects/${project.id}/roadmap`)
  await kept(page, 'last-module', /roadmap/)
  await openConnect(page)
  const link = back(page, 'Roadmap')
  await expect(link).toHaveAttribute('href', /\/projects\/\d+\/roadmap$/)
  await link.focus()
  await expect(link).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/roadmap$`))
  // Below the top bar, before the page's title.
  await openSettings(page)
  const box = (await back(page, 'Roadmap').boundingBox())!
  const title = (await page.getByRole('heading', { level: 1, name: 'Settings' }).boundingBox())!
  expect(box.y).toBeLessThan(title.y)
})

test('Connect keeps the project in the selector, and so does Settings', async ({ page, project }) => {
  await page.goto(`/projects/${project.id}/prs`)
  await expect(selector(page)).toContainText(project.name)
  await kept(page, 'current-project', new RegExp(`^${project.id}$`))
  await openConnect(page)
  await expect(page.getByRole('heading', { level: 1, name: 'Connect an agent' })).toBeVisible()
  await expect(selector(page)).toContainText(project.name)
  await page.reload()
  await expect(selector(page)).toContainText(project.name)
  await openSettings(page)
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
  await expect(selector(page)).toContainText(project.name)
})

test('a project chosen on Settings or Connect sends the back button to its Overview, and the page stays', async ({
  page,
  project,
  human,
}) => {
  const other = await seedProject(human, `Other for back (${project.id})`)

  for (const open of [openConnect, openSettings]) {
    await page.goto(`/projects/${project.id}/prs?filter=me`)
    await kept(page, 'last-module', /prs/)
    await open(page)
    await expect(back(page, 'PR queue')).toBeVisible()
    await selector(page).click()
    await page.getByRole('button', { name: other.name, exact: false }).click()
    await expect(selector(page)).toContainText(other.name)
    // The page stays where it is: only the project changed.
    await expect(page).toHaveURL(/\/(agents|settings)$/)
    await expect(back(page, 'Overview')).toBeVisible()
    await back(page, 'Overview').click()
    await expect(page).toHaveURL(new RegExp(`/projects/${other.id}$`))
    await expect(selector(page)).toContainText(other.name)
  }
})

test('on the Settings project tab, choosing a project opens its tab and the back button follows', async ({
  page,
  project,
  human,
}) => {
  const other = await seedProject(human, `Other tab (${project.id})`)
  await page.goto(`/projects/${project.id}/features`)
  await kept(page, 'last-module', /features/)
  await openSettings(page)
  await page.getByRole('tab', { name: new RegExp(`^This project: ${project.name.slice(0, 20)}`) }).click()
  await expect(back(page, 'Ongoing features')).toBeVisible()
  await selector(page).click()
  await page.getByRole('button', { name: other.name, exact: false }).click()
  await expect(page).toHaveURL(new RegExp(`/settings\\?tab=project&project=${other.id}$`))
  await expect(back(page, 'Overview')).toBeVisible()
})

test('with no project selected the back button goes to Home', async ({ page }) => {
  await page.goto('/agents')
  await expect(selector(page)).toContainText('Select a project')
  await expect(back(page, 'Home')).toBeVisible()
  await back(page, 'Home').click()
  await expect(page).toHaveURL(/\/$/)
  await page.goto('/settings')
  await expect(back(page, 'Home')).toBeVisible()
})
