import type { Project } from '#/lib/api'
import { DEFAULT_AGENT_NAMES } from '#/lib/constants'
import { expect, ok, test } from './fixtures'

test('the PR queue renders with its filter (no GitHub: empty)', async ({ page, project }) => {
  await page.goto(`/projects/${project.id}/prs`)
  await expect(page.getByRole('heading', { name: 'PR queue' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible()
  for (const status of ['Pending', 'Reviewed', 'On hold'])
    await expect(page.getByRole('tab', { name: new RegExp(`^${status}`) })).toBeVisible()

  const filter = (name: string) => page.getByRole('tab', { name: new RegExp(`^${name}`) })
  await expect(filter('All')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('Nothing pending.')).toBeVisible()

  await filter('To review').click()
  await expect(filter('To review')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('Nothing pending to review.')).toBeVisible()

  await filter('Waiting on others').click()
  await expect(page.getByText('Nothing pending waiting on others.')).toBeVisible()
  await page.getByRole('tab', { name: /^On hold/ }).click()
  await expect(page.getByText('Nothing on hold waiting on others.')).toBeVisible()
})

test('edits the project instructions with the rich editor', async ({ page, project, human }) => {
  await page.goto(`/projects/${project.id}/settings`)
  const section = page.getByRole('region', { name: 'Project instructions' })
  await section.getByRole('button', { name: 'No instructions yet. Click to write them.' }).click()
  const editor = section.getByRole('textbox', { name: 'Project instructions' })
  await expect(editor).toBeFocused()
  await expect(section.getByText('No changes.')).toBeVisible()
  await section.getByRole('button', { name: 'Heading' }).click()
  await page.keyboard.type('Running it')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Use pnpm, never npm.')
  await expect(section.getByText('Unsaved changes. Ctrl/⌘+Enter saves.')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  await expect(editor).toBeHidden()
  await expect(section.getByRole('heading', { name: 'Running it' })).toBeVisible()
  const saved = '## Running it\n\nUse pnpm, never npm.'
  expect((await ok<Project>(human.get(`/api/projects/${project.id}`))).instructions).toBe(saved)

  // Unsaved changes are not dropped by accident: Cancel asks first; Keep editing keeps them, Discard
  // goes back to the saved text.
  await section.getByRole('button', { name: 'edit' }).click()
  await expect(editor).toBeFocused()
  await page.keyboard.type(' Always.')
  await section.getByRole('button', { name: 'Cancel' }).click()
  const ask = page.getByRole('alertdialog')
  await expect(ask).toContainText('Discard your changes?')
  await ask.getByRole('button', { name: 'Keep editing' }).click()
  await expect(ask).toBeHidden()
  await expect(editor).toContainText('Use pnpm, never npm. Always.')
  await section.getByRole('button', { name: 'Cancel' }).click()
  await ask.getByRole('button', { name: 'Discard' }).click()
  await expect(editor).toBeHidden()
  await expect(section).not.toContainText('Always.')
  expect((await ok<Project>(human.get(`/api/projects/${project.id}`))).instructions).toBe(saved)
})

test('the human adds the default agents; an agent gets 403 doing it', async ({ page, project, agent }) => {
  const refused = await agent.post(`/api/projects/${project.id}/agents/defaults`, { data: {} })
  expect(refused.status()).toBe(403)

  await page.goto(`/projects/${project.id}/agents`)
  await expect(page.getByText('No agents yet.')).toBeVisible()
  const defaults = page.getByRole('region', { name: 'Default agents' })
  await defaults.getByRole('button', { name: 'Add the default agents' }).click()
  await expect(page.getByText(`Added ${DEFAULT_AGENT_NAMES.join(', ')}`)).toBeVisible()
  await expect(defaults.getByText('All added')).toBeVisible()
  for (const name of DEFAULT_AGENT_NAMES)
    await expect(page.getByRole('listitem').filter({ hasText: name }).first()).toBeVisible()

  const after = await ok<Project>(agent.get(`/api/projects/${project.id}`))
  expect(after.agents.map((a) => a.name).sort()).toEqual([...DEFAULT_AGENT_NAMES].sort())
})
