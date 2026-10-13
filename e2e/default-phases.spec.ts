import type { Project, TicketFull } from '#/lib/api'
import { expect, ok, test } from './fixtures'

const BUILT_IN = ['Implementation', 'Pushed', 'PR', 'CI', 'Preview', 'Hand-off post']

test('the human sets the default phases on the Settings page, and new tickets start with them', async ({
  page,
  project,
  human,
}) => {
  const phases = async () => (await ok<Project>(human.get(`/api/projects/${project.id}`))).defaultPhases
  /** A new top-level ticket's tasks, in order. */
  const seeded = async (title: string) => {
    const t = await ok<TicketFull>(human.post(`/api/projects/${project.id}/tickets`, { data: { title } }))
    return (await ok<TicketFull>(human.get(`/api/tickets/${t.id}`))).tasks.map((x) => x.text)
  }

  await page.goto(`/projects/${project.id}/settings`)
  const section = page.getByRole('region', { name: 'Default phases' })
  await expect(section.getByRole('heading', { name: 'Default phases' })).toBeVisible()
  const field = section.getByRole('textbox', { name: 'Default phases, one per line' })
  const save = section.getByRole('button', { name: 'Save' })
  // The list in effect: the built-in one, until it is changed.
  await expect(field).toHaveValue(BUILT_IN.join('\n'))
  await expect(save).toBeDisabled()
  await section.screenshot({ path: test.info().outputPath('default-phases.png') })

  // One per line, trimmed, blank lines left out.
  await field.fill('Design\n\n  Build  \nShip')
  await save.click()
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Saved' })).toBeVisible()
  await expect(save).toBeDisabled()
  expect(await phases()).toEqual(['Design', 'Build', 'Ship'])
  await page.reload()
  await expect(field).toHaveValue('Design\nBuild\nShip')
  expect(await seeded('custom')).toEqual(['Design', 'Build', 'Ship'])

  // Emptied, it seeds nothing.
  await field.fill('')
  await save.click()
  await expect(save).toBeDisabled()
  expect(await phases()).toEqual([])
  await page.reload()
  await expect(field).toHaveValue('')
  await expect(field).toHaveAttribute('placeholder', 'No phases: new tickets start with no tasks.')
  expect(await seeded('none')).toEqual([])

  // Back to the built-in list.
  await section.getByRole('button', { name: 'Use the built-in list' }).click()
  await expect(field).toHaveValue(BUILT_IN.join('\n'))
  expect(await phases()).toEqual(BUILT_IN)
  await page.reload()
  await expect(field).toHaveValue(BUILT_IN.join('\n'))
  expect(await seeded('built-in')).toEqual(BUILT_IN)
})

test('the Settings page shows the refusal of a list the server will not take, and keeps it to fix', async ({
  page,
  project,
  human,
}) => {
  await page.goto(`/projects/${project.id}/settings`)
  const section = page.getByRole('region', { name: 'Default phases' })
  const field = section.getByRole('textbox', { name: 'Default phases, one per line' })
  const tooMany = Array.from({ length: 21 }, (_, i) => `Phase ${i + 1}`).join('\n')
  await field.fill(tooMany)
  await section.getByRole('button', { name: 'Save' }).click()
  await expect(page.locator('[data-sonner-toast]').first()).toBeVisible()
  await expect(field).toHaveValue(tooMany)
  expect((await ok<Project>(human.get(`/api/projects/${project.id}`))).defaultPhases).toEqual(BUILT_IN)
})
