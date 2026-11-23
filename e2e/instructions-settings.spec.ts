import type { Page } from '@playwright/test'

import type { Project } from '#/lib/api'
import { expect, ok, test } from './fixtures'

const menu = (page: Page) => page.locator('aside nav').getByRole('link')
const navLink = (page: Page, name: string) =>
  page.locator('aside nav').getByRole('link', { name, exact: true })
const region = (page: Page, name: string) => page.getByRole('region', { name })

/** The sections only the Settings page has. */
const SETTINGS = [
  'Default phases',
  'Tag suggestions',
  'Stalled tickets',
  'Stages',
  'Runs',
  'Resume',
  'Layout',
]

test('the sidebar opens Instructions and the top bar opens Settings, each with only its own sections', async ({
  page,
  project,
}) => {
  await page.goto(`/projects/${project.id}/instructions`)
  await expect(page.getByRole('heading', { level: 1, name: 'Instructions' })).toBeVisible()
  // The editor and its history, and nothing from the settings.
  await expect(region(page, 'Project instructions')).toBeVisible()
  await expect(region(page, 'Instructions history')).toBeVisible()
  for (const name of SETTINGS) await expect(region(page, name)).toHaveCount(0)
  await expect(menu(page).last()).toHaveText('Instructions')
  // Settings is not in the project's sidebar: the top bar has it.
  await expect(navLink(page, 'Settings')).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath('instructions.png'), fullPage: true })

  // Settings: every settings section, and no instructions editor or history.
  await page.getByRole('banner').getByRole('link', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: /^This project/ }).click()
  await expect(page).toHaveURL(new RegExp(`/settings\\?tab=project&project=${project.id}$`))
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
  for (const name of SETTINGS) await expect(region(page, name)).toBeVisible()
  await expect(region(page, 'Project instructions')).toHaveCount(0)
  await expect(region(page, 'Instructions history')).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath('settings.png'), fullPage: true })

  // Settings is its own page, without the project's sidebar: the Instructions page has its sidebar again.
  await page.goto(`/projects/${project.id}/instructions`)
  await expect(page.getByRole('heading', { level: 1, name: 'Instructions' })).toBeVisible()
  await expect(menu(page).last()).toHaveText('Instructions')
})

test('an old settings link and a menu saved before the split still land right', async ({
  page,
  project,
  human,
}) => {
  // As a board saved the menu before the Instructions module existed: no Instructions.
  const base = (await ok<Project>(human.get(`/api/projects/${project.id}`))).layout
  await ok(
    human.patch(`/api/projects/${project.id}`, {
      data: { layout: base.filter((it) => it.id !== 'nav.instructions') },
    }),
  )

  // An old link into the instructions history lands on the page that has it.
  await page.goto(`/projects/${project.id}/settings#instructions-history`)
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/instructions#instructions-history$`))
  await expect(region(page, 'Instructions history')).toBeInViewport()
  // An old link into a settings section lands on the This project tab, section anchor kept.
  await page.goto(`/projects/${project.id}/settings#stages`)
  await expect(page).toHaveURL(new RegExp(`/settings\\?tab=project&project=${project.id}#stages$`))
  await expect(region(page, 'Stages')).toBeInViewport()
  await page.goto(`/projects/${project.id}/instructions`)
  // The menu saved without Instructions now shows it, last, after Repositories.
  await expect(menu(page).last()).toHaveText('Instructions')
  await expect(menu(page).nth(-2)).toHaveText('Repositories')
})
