import { expect, test } from './fixtures'

test('the shell picked for the install lines is kept in the URL, remembered, and shared by the page', async ({
  page,
  project,
}) => {
  const hydration: string[] = []
  page.on('console', (m) => /hydrat/i.test(m.text()) && hydration.push(m.text()))
  const tabs = (name: string) => page.getByRole('tab', { name })
  const bash = 'bash / zsh'

  await page.goto('/agents')
  await expect(page.getByRole('heading', { name: 'Connect agents' })).toBeVisible()
  // The skill's install line and the review skills' each have a picker; bash until one is picked.
  await expect(tabs(bash)).toHaveCount(2)
  for (const tab of await tabs(bash).all()) await expect(tab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText(/^\$t = Join-Path/)).toHaveCount(0)

  await tabs('PowerShell').first().click()
  await expect(page).toHaveURL(/[?&]shell=powershell(&|$)/)
  // One choice for the page: the review skills' line follows.
  for (const tab of await tabs('PowerShell').all()) await expect(tab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText(/^New-Item -ItemType Directory/)).toBeVisible()
  await expect(page.getByText(/^\$t = Join-Path/)).toBeVisible()

  await page.reload()
  for (const tab of await tabs('PowerShell').all()) await expect(tab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText(/^\$t = Join-Path/)).toBeVisible()

  // Without one in the URL, the shell this browser remembers comes back, and the URL says so: here and
  // on a project's Agents page.
  await page.goto('/agents')
  await expect(page).toHaveURL(/[?&]shell=powershell(&|$)/)
  await expect(page.getByText(/^New-Item -ItemType Directory/)).toBeVisible()
  await page.goto(`/projects/${project.id}/agents`)
  await expect(page).toHaveURL(/[?&]shell=powershell(&|$)/)
  await expect(tabs('PowerShell')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText(/^\$t = Join-Path/)).toBeVisible()
  await tabs(bash).click()
  await expect(page).toHaveURL(/[?&]shell=bash(&|$)/)
  await expect(page.getByText(/^\$t = Join-Path/)).toHaveCount(0)

  // A link that names one wins over what is remembered.
  await page.goto('/agents?shell=powershell')
  for (const tab of await tabs('PowerShell').all()) await expect(tab).toHaveAttribute('aria-selected', 'true')
  await page.goto('/agents')
  await expect(page).toHaveURL(/[?&]shell=bash(&|$)/)

  expect(hydration).toEqual([])
})
