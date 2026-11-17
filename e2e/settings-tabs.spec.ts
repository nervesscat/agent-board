import type { Page } from '@playwright/test'

import { AGENT } from './env'
import { expect, seedProject, test } from './fixtures'

const tabs = (page: Page) => page.getByRole('tablist', { name: 'Settings' })
const tab = (page: Page, name: string | RegExp) =>
  tabs(page).getByRole('tab', { name, exact: typeof name === 'string' })
const region = (page: Page, name: string) => page.getByRole('region', { name })
const projectTab = (page: Page, name: string) => tab(page, `This project: ${name}`)
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const BOARD_IDS = ['default-agent', 'theme', 'previews']
const PROJECT_IDS = [
  'kinds',
  'default-phases',
  'tag-suggestions',
  'stalled-tickets',
  'stages',
  'runs',
  'layout',
]

test('the Board tab is the default; there is no project tab until a project is current', async ({
  page,
  project,
}) => {
  // A fresh browser remembers no project.
  await page.goto('/settings')
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toHaveCount(1)
  await expect(tab(page, 'Board')).toHaveAttribute('aria-selected', 'true')
  await expect(tab(page, /This project/)).toHaveCount(0)
  for (const id of BOARD_IDS) await expect(page.locator(`#${id}`)).toHaveCount(1)
  for (const id of PROJECT_IDS) await expect(page.locator(`#${id}`)).toHaveCount(0)

  // Once the browser has been in a project, its tab is there.
  await page.goto(`/projects/${project.id}`)
  await page.getByRole('banner').getByRole('link', { name: 'Settings', exact: true }).click()
  await expect(page).toHaveURL(/\/settings$/)
  await expect(tab(page, 'Board')).toHaveAttribute('aria-selected', 'true')
  await expect(projectTab(page, project.name)).toHaveAttribute('aria-selected', 'false')
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toHaveCount(1)
})

test('a tab click writes the tab to the address without a reload, and a reload keeps it', async ({
  page,
  project,
}) => {
  await page.goto(`/projects/${project.id}`)
  await page.getByRole('banner').getByRole('link', { name: 'Settings', exact: true }).click()
  await page.evaluate(() => Object.assign(window, { stillHere: true }))

  await projectTab(page, project.name).click()
  await expect(page).toHaveURL(new RegExp(`/settings\\?tab=project&project=${project.id}$`))
  await expect(projectTab(page, project.name)).toHaveAttribute('aria-selected', 'true')
  for (const id of PROJECT_IDS) await expect(page.locator(`#${id}`)).toHaveCount(1)
  for (const id of BOARD_IDS) await expect(page.locator(`#${id}`)).toHaveCount(0)
  expect(await page.evaluate(() => 'stillHere' in window)).toBe(true)

  await page.reload()
  await expect(projectTab(page, project.name)).toHaveAttribute('aria-selected', 'true')
  await expect(region(page, 'Stages')).toBeVisible()

  await tab(page, 'Board').click()
  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.locator('#theme')).toBeVisible()
  await page.reload()
  await expect(tab(page, 'Board')).toHaveAttribute('aria-selected', 'true')

  // Back and forward move between the tabs visited.
  await page.goBack()
  await expect(projectTab(page, project.name)).toHaveAttribute('aria-selected', 'true')
  await page.goForward()
  await expect(tab(page, 'Board')).toHaveAttribute('aria-selected', 'true')
})

test('the arrow keys switch tabs', async ({ page, project }) => {
  await page.goto(`/settings?tab=project&project=${project.id}`)
  await tab(page, 'Board').focus()
  await page.keyboard.press('ArrowRight')
  await expect(projectTab(page, project.name)).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tabpanel')).toBeVisible()
  await page.keyboard.press('ArrowLeft')
  await expect(tab(page, 'Board')).toHaveAttribute('aria-selected', 'true')
})

test('the project tab without a usable project falls back to the Board tab', async ({ page, project }) => {
  await page.goto('/settings?tab=project')
  await expect(tab(page, 'Board')).toHaveAttribute('aria-selected', 'true')
  await expect(page).not.toHaveURL(/tab=project/)
  await expect(page.locator('#theme')).toBeVisible()

  await page.goto(`/projects/${project.id}`)
  await page.goto('/settings?tab=project&project=999999')
  await expect(tab(page, 'Board')).toHaveAttribute('aria-selected', 'true')
  await expect(page).not.toHaveURL(/project=/)
  await expect(page.locator('#theme')).toBeVisible()

  await page.goto('/settings?tab=nonsense')
  await expect(tab(page, 'Board')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#theme')).toBeVisible()
})

test('an old project settings address opens the project tab, keeping its section', async ({
  page,
  project,
}) => {
  await page.goto(`/projects/${project.id}/settings#stages`)
  await expect(page).toHaveURL(new RegExp(`/settings\\?tab=project&project=${project.id}#stages$`))
  await expect(projectTab(page, project.name)).toHaveAttribute('aria-selected', 'true')
  await expect(region(page, 'Stages')).toBeInViewport()
})

test('a section of the other tab in the address opens the tab that has it', async ({ page, project }) => {
  await page.goto(`/projects/${project.id}`)
  await page.goto('/settings#stages')
  await expect(projectTab(page, project.name)).toHaveAttribute('aria-selected', 'true')
  await expect(region(page, 'Stages')).toBeInViewport()

  await page.goto(`/settings?tab=project&project=${project.id}#theme`)
  await expect(tab(page, 'Board')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#theme')).toBeInViewport()

  // With no project, a project section's address stays on the Board tab.
  const fresh = await page.context().browser()!.newContext()
  const bare = await fresh.newPage()
  await bare.goto(`${new URL(page.url()).origin}/settings#stages`)
  await expect(tab(bare, 'Board')).toHaveAttribute('aria-selected', 'true')
  await fresh.close()
})

test("the project's sidebar opens the project tab, and each project shows its own", async ({
  page,
  project,
  human,
}) => {
  const other = await seedProject(human, `Other ${project.name}`)
  for (const p of [project, other]) {
    await page.goto(`/projects/${p.id}`)
    await page.locator('aside nav').getByRole('link', { name: 'Settings', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/settings\\?tab=project&project=${p.id}$`))
    await expect(projectTab(page, p.name)).toHaveAttribute('aria-selected', 'true')
    await expect(region(page, 'Stages')).toBeVisible()
  }

  // The project switcher on the project tab goes to the other project's.
  await page.getByRole('button', { name: 'Project', exact: true }).click()
  await page.getByRole('button', { name: new RegExp(`^${escaped(project.name)}`) }).click()
  await expect(page).toHaveURL(new RegExp(`/settings\\?tab=project&project=${project.id}$`))
  await expect(projectTab(page, project.name)).toHaveAttribute('aria-selected', 'true')
})

test('an agent sees no human-only section on the Board tab', async ({ browser, baseURL, project }) => {
  const context = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { 'X-Test-Actor': `agent:${AGENT}` },
  })
  const page = await context.newPage()
  await page.goto(`/settings?tab=project&project=${project.id}`)
  await expect(region(page, 'Stages')).toBeVisible()
  await tab(page, 'Board').click()
  for (const id of BOARD_IDS) await expect(page.locator(`#${id}`)).toBeVisible()
  for (const id of ['updates', 'agent-roles', 'tailnet', 'devices'])
    await expect(page.locator(`#${id}`)).toHaveCount(0)
  await context.close()
})
